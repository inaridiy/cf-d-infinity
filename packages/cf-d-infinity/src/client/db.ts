import type {
  Change, CommitRes, ExecReq, ExecRes, GlobalIndexDef, LockOwner, Row, ShardApi, Span, TableDef, Ts, Value,
} from "../types";
import { ConflictError, MAX_WRITE_SET_BYTES, ReadTooOld, SqlError, isTableLocked, isWideSpan, utf8Length } from "../types";
import { CAPTURE_TABLES, capturedChanges, captureDdl, decode, encode, encodeKey, q, selectList } from "../shard/rows";
import type { Catalog } from "../meta";
import { hashKey, ownerOf, rangesOf, shardsOf, type Routing } from "../routing";
import { type Runtime, sleep, systemRuntime } from "../runtime";
import { ident, normalize, parseStatements, text, type Node, type Params } from "../sql/cst";
import { SCHEMA_STATEMENTS, findTable, fullScan, planStatement, type Plan, type PlanContext, type Reference, type Route, type Scan, type WriteTarget } from "../sql/plan";
import { parseDdl } from "../sql/ddl";
import { openScratch, ScratchDb, type Compiled } from "../sql/scratch";
import { groupSpan, rowSpan, scanSpans, statementSpans, tableSpan } from "./spans";

export interface Cluster {
  shard(id: string): ShardApi;
  catalog(): Promise<Catalog>;
  /** basedOn は呼び出し側が全シャードへ適用し終えた版。現在の版と違えば `schema moved` で断られる。 */
  applyDdl(sql: string, basedOn?: number): Promise<Catalog>;
  /** 作り終えた index を公開する。version は index を作り始めた版、at は公開の時刻 (meta.ts の DdlEntry.at)。 */
  publishIndex(table: string, name: string, version: number, at: Ts): Promise<Catalog>;
  /** 表への書き込みを止めている作業 (index の作成、DROP の前の禁止) の期限を延ばす。version は作業を始めた版。期限の長さを返す。 */
  renewLock(version: number): Promise<{ leaseMs: number }>;
  /** 取引が読んだ表を DROP する前に、その表を書き込み禁止にする版を記録する (meta.ts の lockTables)。 */
  lockTables(tables: string[], basedOn?: number): Promise<Catalog>;
  /** 書き込み禁止の版を、その DROP で終える。 */
  finishLock(version: number, sql: string): Promise<Catalog>;
  /** 版を取り消す。取り消す版を返す。取り消せなければ null。 */
  revokeDdl(version: number, reason: string): Promise<number | null>;
  allocate(table: string, n: number, min?: number): Promise<number>;
  switchRange(move: { start: number; end: number; to: string; from?: string }): Promise<Routing>;
  /** 実時間、待ち、乱数、識別子の出どころ。なければ実物を使う。シミュレータのクラスタは、seed から決まる実装を持つ。 */
  runtime?: Runtime;
  /** このクラスタへつなぐ Db の、基準経路だけで実行する指定の既定。試験が使う。 */
  reference?: Reference;
}

/** Worker の側の欠陥を再導入するスイッチ (シャードの側は types.ts の Faults)。検査が欠陥を見つけることを確かめる試験だけが使う。 */
export interface ClientFaults {
  /** 書き出した取引を組み立て直すとき、表定義が変わっていても、新しい版を名乗らせる (モデル m13_red_repin)。 */
  repinOnRestore?: boolean;
  /** DDL を実行した batch も、競合したら頭からやり直す (モデル m13_red_retry_whole)。 */
  replayAcrossSchemaChange?: boolean;
  /** 取引が読んだ表を、書き込みを止めず、確かめずに DROP する (2026-11 までの挙動。モデル m14_red_no_lock と m14_red_no_check)。 */
  dropWithoutGuard?: boolean;
}

/**
 * 取引が、あるシャードで読んだ範囲と、その時刻。表を消す前の確認に使う (Db.guardedDrop)。
 * from は、そのシャードがこの範囲の変更を確かめてよい最初の時刻である。読んだ時刻、ただし同じ取引がそこへ書いたなら確定の時刻。
 * どちらも、そのシャードが見た時刻である (読みの要求が運ぶ時刻、確定の phase 2 が運ぶ時刻)。
 */
export interface ReadRecord {
  shard: string;
  spans: Span[];
  from: Ts;
}

/** SHARD KEY はこの DB の拡張で、パーサは読めない。そういう CREATE TABLE は、DDL の解釈に直接渡す。 */
const SHARD_KEY_TABLE = /^\s*CREATE\s+TABLE\b[\s\S]*\bSHARD\s+KEY\s*\(/i;

/** 表定義を変える文を含むか。読めない文は、含まないものとして扱う (実行すれば、その誤りが返る)。 */
export function changesSchema(sql: string): boolean {
  if (SHARD_KEY_TABLE.test(sql)) return true;
  try {
    return parseStatements(sql).some((s) => SCHEMA_STATEMENTS.has(s.type));
  } catch {
    return false;
  }
}

/** 接続をまたいで渡された token を時刻にする。時刻として読めない値は「何も見ていない」として扱う。 */
export function cleanToken(token: unknown): Ts {
  return typeof token === "number" && Number.isSafeInteger(token) && token > 0 ? token : 0;
}

export class QueryResult {
  constructor(
    readonly columns: string[],
    readonly values: Value[][],
    readonly changes = 0,
    readonly lastInsertRowid: number | null = null,
    /** 読み取りの T、または autocommit の commit 時刻。 */
    readonly ts?: Ts,
  ) {}
  /** 列名で引ける行。同名の列は後の列が勝つ。 */
  get rows(): Row[] {
    return this.values.map((v) => Object.fromEntries(this.columns.map((c, i) => [c, v[i] ?? null])));
  }
}

/**
 * やり直してよい失敗か。シャードが「何も書かずに断った」と分かるものだけを数える。
 * 基盤が返す一時的な失敗 (`retryable` の付いた例外) は数えない。要求がシャードに届いて実行された後で応答だけが
 * 失われた場合もあり、autocommit の書き込みや 1 シャードの commit をやり直すと、同じ変更が 2 回入る。
 */
const isRetryable = (e: unknown) =>
  e instanceof ConflictError || e instanceof ReadTooOld ||
  /^(conflict|read too old|not owner|migrating|upgrading):/.test((e as Error)?.message ?? "");

/** 1 文の実行の記録。遅い文の一覧に使う。 */
export interface StatementStat {
  sql: string;
  /** 文を受けてから結果を返すまでの時間 (ms)。リトライと待ちを含む。 */
  ms: number;
  /** 文の実行場所。shard は 1 シャードで完結、gather と partial は複数シャードから Worker へ集めた読み取りである。 */
  plan: string;
  /** 文の実行中に呼んだシャードの数。 */
  shards: number;
  rows: number;
  changes: number;
  /** 競合や経路の変化でやり直した回数を含む、試行の数。 */
  attempts: number;
  error?: string;
}

/** index を作るときに、1 回に読む行数、1 つの取引で書く項目の数、移動や競合でやり直す回数の上限。 */
const BUILD_PAGE = 500;
const BUILD_BATCH = 200;
const BUILD_RETRIES = 200;
/**
 * 表定義の変更が終わるのを待つ時間。index を作っている間は、その表への書き込みと、ほかの表定義の変更が待つ。
 * 作る側が止まれば、期限 (meta.ts の INDEX_LEASE_MS、既定 5 秒) のうちに取り消されて書ける。作る側が動き続けている間は、
 * これだけ待って、やり直してよい誤り (`conflict: locked: ...`) を返す。
 */
const SCHEMA_WAIT_MS = 30_000;

/** 表定義が古いと出る誤り。取り直すと解けることがある。 */
const UNKNOWN_SCHEMA = /^(no such (table|column|index)|table \S+ has no column)/;

/**
 * 文が、制約の衝突を自分で解決する形か (OR IGNORE、OR REPLACE、REPLACE、ON CONFLICT)。
 * 1 シャードへ送った文は、そのシャードの中の衝突しか解決できない。別のシャードの行との衝突が見つかったら、基準経路で実行し直す。
 */
const resolvesConflicts = (sql: string): boolean => /^\s*(INSERT|UPDATE)\s+OR\s+(IGNORE|REPLACE)\b|^\s*REPLACE\b|\bON\s+CONFLICT\b/i.test(sql);

/**
 * 最適化の経路が、実行の途中で「この文は 1 シャードでは答えられない」と分かったときに投げる。
 * 受けるのは runPlanned だけで、同じ文を基準経路で計画し直して実行する。利用者には届かない。
 * 行がどのシャードにあるかで、文が断られたり通ったりしないようにするための切り替えである。
 */
export class NeedsReference extends Error {}

/** 書き込みの文が表定義を読むときの拒否。文の形だけで決まる。 */
const METADATA_IN_WRITE =
  "unsupported: a statement that writes cannot read sqlite_master or a PRAGMA function inside it; read the schema in a statement of its own and pass the value as a parameter";

/**
 * 文を計画して実行する。最適化の経路から基準経路への切り替えは、ここにしかない。
 * stmt は計画の途中で書き換わるので、計画し直すときは source から読み直す。
 */
async function runPlanned(
  stmt: Node, source: string, params: Params, cat: Catalog, ctx: PlanContext, run: (p: Plan) => Promise<QueryResult>, seen?: (p: Plan) => void,
): Promise<QueryResult> {
  try {
    const p = await planStatement(stmt, params, cat, ctx);
    seen?.(p);
    return await run(p);
  } catch (e) {
    if (!(e instanceof NeedsReference)) throw e;
    const p = await planStatement(parseStatements(source)[0], params, cat, { ...ctx, reference: "scans" });
    seen?.(p);
    return run(p);
  }
}

/** 集めた行の、`表名\0主キー` の形のキー。行の順に返す。主キーの列が走査の結果になければ、空を返す。 */
function keysOf(l: Loaded): string[] {
  const at = l.table.pk.map((c) => l.columns.indexOf(c));
  if (at.some((i) => i < 0)) return [];
  return l.rows.map((row) => `${l.table.name}\0${encode(at.map((i) => row[i] ?? null))}`);
}

/** 基準経路で集めた行。Worker の SQLite を作り直すときに読み直さずに済むように、表ごとに持っておく。 */
interface Loaded {
  table: TableDef;
  columns: string[];
  rows: Value[][];
}

/**
 * 文が読む表を SQLite に尋ねた結果。キーは DDL の履歴と文の文面。
 *
 * 実行環境ごとに持つ。本番の実行環境は 1 つなので、isolate に 1 つの覚え書きになる。
 * シミュレータのクラスタは、それぞれ自分の実行環境を持つ。覚えているかどうかで await の回数が変わり、並行する処理の
 * 前後が変わるので、覚え書きをクラスタの間で共有すると、同じ seed の実行が、同じプロセスで前に流したものに依ってしまう。
 */
const tablesSeenBy = new WeakMap<Runtime, Map<string, Compiled>>();
/** DDL の履歴を表す短いキー。版番号だけだと、同じ isolate の別のクラスタと混ざる。 */
const historyKeys = new WeakMap<Catalog, string>();
function historyKey(cat: Catalog): string {
  let key = historyKeys.get(cat);
  if (key === undefined) {
    const all = cat.ddl.join("\0");
    key = `${cat.ddl.length}:${all.length}:${hashKey(all)}:${hashKey(`#${all}`)}`;
    historyKeys.set(cat, key);
  }
  return key;
}

/** DDL が、進行中のシャードの増設が終わるのを待つ時間。 */
const SPLIT_WAIT_MS = 60_000;

const backoff = (rt: Runtime, attempt: number) => sleep(rt, rt.random() * Math.min(50, 2 ** attempt));

/** 文を送る先のシャード。sks が null なら全行が対象である。 */
interface Target {
  shard: string;
  sks: string[] | null;
}

function groupByShard(routing: Routing, sks: string[]): Target[] {
  const out = new Map<string, string[]>();
  for (const sk of sks) {
    const shard = ownerOf(routing, sk);
    out.set(shard, [...(out.get(shard) ?? []), sk]);
  }
  return [...out].map(([shard, list]) => ({ shard, sks: list }));
}

/**
 * shard key を絞らない span に、この範囲表で宛先のシャードが持つスロットの範囲を付ける。
 * 全表の読みは範囲表の全シャードへ送るが、範囲表が古いと、分割で生まれたシャードには送らない。
 * 親は自分に残った行だけを答えるので、範囲を付けないと、子へ移った行が黙って欠ける。
 */
function withSlots(routing: Routing, shard: string, spans: Span[]): Span[] {
  if (!spans.some(isWideSpan)) return spans;
  const slots = rangesOf(routing, shard);
  return spans.map((s) => (isWideSpan(s) ? { ...s, slots } : s));
}

/** 1 回の読み取りで Worker へ集める行の上限。メモリからの推定で、本番で調整する。 */
export const ROW_BUDGET = 200_000;
/** 1 文で Worker へ集めてよいバイト数。isolate のメモリは 128 MB で、集めた行は wasm の SQLite にも入る。 */
export const BYTE_BUDGET = 32_000_000;

/** 読み取りのコンテキスト。autocommit と Txn で実行経路を共有する。 */
class ReadScope {
  T: Ts | undefined;
  /** 取引だけが T を進められる。autocommit の読み取りは最初から全シャードの最大を取る。 */
  protected wantsFresh = false;
  /** 取引でない読み取りは、開始前に確定した書き込みを必ず見る。取引は自分のスナップショットを読み続ける。 */
  protected realtime = true;
  constructor(protected db: Db, protected cat: Catalog) {}

  protected overlay(_shard: string): Change[] {
    return [];
  }
  protected record(_shard: string, _spans: Span[]): void {}

  async call(shard: string, req: Omit<ExecReq, "T" | "minTs" | "schema" | "overlay">): Promise<ExecRes> {
    const spans = withSlots(this.cat.routing, shard, req.spans);
    const full: ExecReq = {
      ...req, spans, T: this.T, minTs: this.db.token, schema: this.cat.version, overlay: this.overlay(shard), fresh: this.wantsFresh, realtime: this.realtime,
    };
    const res = await this.db.shardOf(shard).exec(full);
    this.T ??= res.T;
    this.db.observe(res.hlc);
    this.record(shard, spans);
    // 失敗した文も、読んだ範囲は記録してから失敗させる。
    if (res.error !== undefined) throw new SqlError(res.error);
    return res;
  }

  /**
   * route を実シャードに解決する。
   * 同じシャードに載る shard key は 1 つにまとめる。文を 2 回送ると結果が二重になるからである。
   */
  async resolve(route: Route): Promise<Target[]> {
    switch (route.by) {
      case "all": return shardsOf(this.cat.routing).map((shard) => ({ shard, sks: null }));
      case "sk": return groupByShard(this.cat.routing, route.sks);
    }
  }

  protected async shardRead(p: Extract<Plan, { kind: "shard" }>, t: Target): Promise<ExecRes> {
    const tables = await this.db.tablesOf(p.sql, this.cat, p.tables, false);
    return this.call(t.shard, { sql: p.sql, params: p.params, spans: statementSpans({ tables, sks: t.sks, pk: p.pk, write: false }) });
  }

  /**
   * 複数シャードの読み取りの T を決める。対象シャードの時計の最大値を取る。
   * commit の時刻はそのシャードの時計以下なので、読み取りの開始前に確定した書き込みは必ず見える。
   * 接続ごとに切れるクライアントでも、別セッションの書き込みが見えないことが起きない。
   */
  protected async pickT(shards: string[]): Promise<void> {
    if (this.T !== undefined || shards.length < 2) return;
    const clocks = await Promise.all(shards.map((id) => this.db.shardOf(id).now({})));
    this.T = Math.max(this.db.token, ...clocks);
  }

  /** 走査を実行して行を返す。 */
  protected async scan(s: Scan): Promise<{ columns: string[]; rows: Value[][] }> {
    const targets = await this.resolve(s.sks ? { by: "sk", sks: s.sks } : { by: "all" });
    if (targets.length === 0) return { columns: [], rows: [] };
    await this.pickT(targets.map((t) => t.shard));
    // 上限はシャードの側で打ち切らせる。全行が届いてから数えると、数える前に Worker のメモリが尽きる。
    // バイト数は対象のシャードで等分する。偏りがあると早めに拒否するが、合計が予算を超えることはない。
    const maxBytes = Math.max(1_000_000, Math.floor(this.db.byteBudget / targets.length));
    const parts = await Promise.all(targets.map((t) =>
      this.call(t.shard, { sql: s.sql, params: s.params, spans: scanSpans(s, t.sks), maxRows: this.db.rowBudget, maxBytes }),
    ));
    return { columns: parts[0]!.columns, rows: parts.flatMap((r) => r.values) };
  }

  /** 走査を実行して、行を集める。sql が実際に開く表は本物のプランナに尋ね、走査にない表は全行を読み足す。 */
  protected async collect(planned: Scan[], sql: string): Promise<Loaded[]> {
    const used = (await this.db.compiled(sql, this.cat)).read;
    const have = new Set(planned.map((s) => s.table.name));
    const missing = used.filter((t) => !have.has(t)).flatMap((t) => {
      const def = findTable(this.cat, t);
      return def ? [fullScan(def)] : [];
    });
    const scans = [...planned, ...missing];
    const all = await Promise.all(scans.map((s) => this.resolve(s.sks ? { by: "sk", sks: s.sks } : { by: "all" })));
    await this.pickT([...new Set(all.flat().map((t) => t.shard))]);
    const out: Loaded[] = [];
    let total = 0;
    for (const s of scans) {
      const { columns, rows } = await this.scan(s);
      total += rows.length;
      this.withinRowBudget(total);
      out.push({ table: s.table, columns, rows });
    }
    return out;
  }

  protected withinRowBudget(rows: number): void {
    if (rows > this.db.rowBudget) throw new SqlError(`query reads more than ${this.db.rowBudget} rows; narrow it or use the analytics tier`);
  }

  /** 集めた行を入れた Worker の SQLite を開く。 */
  protected async scratch(loaded: Loaded[]): Promise<ScratchDb> {
    const w = await openScratch(this.cat);
    try {
      for (const l of loaded) w.load(l.table.name, l.columns, l.rows);
      return w;
    } catch (e) {
      w.close();
      throw e;
    }
  }

  /** 行を集めた Worker の SQLite を開く。 */
  protected async gather(planned: Scan[], sql: string): Promise<ScratchDb> {
    return this.scratch(await this.collect(planned, sql));
  }

  async read(p: Plan): Promise<QueryResult> {
    switch (p.kind) {
      case "meta": {
        const w = await this.gather([], p.sql);
        try {
          const r = w.raw(p.sql, ...p.params);
          return new QueryResult(r.columns, r.values, 0, null, this.T);
        } finally {
          w.close();
        }
      }
      case "shard": {
        const targets = await this.resolve(p.route);
        await this.pickT(targets.map((t) => t.shard));
        try {
          const parts = await Promise.all(targets.map((t) => this.shardRead(p, t)));
          return new QueryResult(parts[0]!.columns, parts.flatMap((r) => r.values), 0, null, this.T);
        } catch (e) {
          // DO の SQLite は UNION などの複合 SELECT を 5 項までしか受け付けない (公式の制限表にない実測値)。
          // 上限 500 の Worker の SQLite で実行するために、基準経路へ切り替える。
          if (/too many terms in compound SELECT/.test((e as Error)?.message ?? "")) throw new NeedsReference("compound SELECT with more terms than a shard accepts");
          throw e;
        }
      }
      case "gather": {
        const w = await this.gather(p.scans, p.sql);
        try {
          const r = w.raw(p.sql, ...p.params);
          return new QueryResult(r.columns, r.values, 0, null, this.T);
        } finally {
          w.close();
        }
      }
      case "partial": {
        const { rows } = await this.scan(p.scan);
        const w = await openScratch({ ddl: [] });
        try {
          w.exec(`CREATE TABLE "__p" (${p.columns.map(q).join(", ")})`);
          w.load("__p", p.columns, rows);
          const r = w.raw(p.mergeSql, ...p.mergeParams);
          return new QueryResult(r.columns, r.values, 0, null, this.T);
        } finally {
          w.close();
        }
      }
      default:
        throw new SqlError(`not a read plan: ${p.kind}`);
    }
  }
}

export interface TxnDump {
  id: string;
  /** 同じ取引の、前の区切り (DDL の前に確定した分) で読んだ範囲。 */
  earlier?: ReadRecord[];
  /** 取引が文を計画した表定義の版 (Txn.catalog)。 */
  schema: number;
  T: Ts | undefined;
  pessimistic: boolean;
  lockReads: boolean;
  lockOwner: LockOwner | null;
  writes: (readonly [string, readonly [string, Change][]])[];
  spans: [string, Span[]][];
  saves: (readonly [string, { writes: TxnDump["writes"]; spans: [string, Span[]][] }])[];
}

/** OCC の取引。commit まで書き込みは Worker のメモリにだけある。 */
export class Txn extends ReadScope {
  commitTs: Ts | undefined;
  protected override wantsFresh = true;
  protected override realtime = false;
  private writes = new Map<string, Map<string, Change>>();
  private spans = new Map<string, Span[]>();
  private saves = new Map<string, { writes: Map<string, Map<string, Change>>; spans: Map<string, Span[]> }>();
  /** 悲観的な取引は DML の時点で行ロックを取る。 */
  pessimistic = false;
  /** BEGIN IMMEDIATE。主キーの読みでもロックを取る。 */
  lockReads = false;
  private lockOwner: LockOwner | null = null;
  /** この取引で実行した文。遅い取引の記録に使う。 */
  readonly sqls: string[] = [];
  /**
   * 取引の文を計画した表定義の版。書き出すときはこの値を運び、組み立て直しても変えない。
   * いまの表定義の版と違えば、取引は古い版で計画した読み書きを持っているので、失敗させる (Txn.load)。
   */
  private planned: number;
  constructor(db: Db, cat: Catalog, private id: string) {
    super(db, cat);
    this.planned = cat.version;
  }

  private get txnId(): string {
    return this.id;
  }

  protected override overlay(shard: string): Change[] {
    return [...(this.writes.get(shard)?.values() ?? [])];
  }
  protected override record(shard: string, spans: Span[]): void {
    this.spans.set(shard, [...(this.spans.get(shard) ?? []), ...spans]);
  }

  /**
   * 読む行に T より新しい commit があれば、それまでの読みが変わっていないことを確かめて T を進める。
   * 別のシャードの時計が進んでいるだけで、確定済みの行が見えなくなるのを防ぐ。
   * 確かめた範囲に変更があれば、古い読みに依存しているので取引は競合になる。
   */
  override async call(shard: string, req: Omit<ExecReq, "T" | "minTs" | "schema" | "overlay">): Promise<ExecRes> {
    for (let attempt = 0; ; attempt++) {
      // この要求が運ぶ T。応答を待っている間に、別の読みが T を進めることがある。
      const sent = this.T;
      let res: ExecRes | undefined;
      let failure: unknown;
      try {
        res = await super.call(shard, req);
      } catch (e) {
        failure = e;
      }
      // T を進める確認の最中に届いた応答は、その確認に入っていない。終わるのを待ってから、古い時点の読みかどうかを見る。
      while (this.advancing) await this.advancing;
      // 送った後で T が進んでいた。この応答は古い時点の状態で、進んだ T までの間に変わっていないことを誰も確かめていない。
      // そのまま使うと、1 つの文の中で別々の時点の行が混ざる。いまの T で読み直す。失敗した文の「読み」も同じである。
      const stale = sent !== undefined && this.T !== undefined && sent < this.T;
      if (failure === undefined) {
        if (!stale) return res!;
        if (attempt >= 20) throw new ConflictError("the read timestamp kept moving while this statement was reading");
        continue;
      }
      const moved = /moved at (\d+)/.exec((failure as Error)?.message ?? "");
      if (moved && attempt < 4 && this.T !== undefined && this.wantsFresh) {
        await this.advance(Number(moved[1]));
        continue;
      }
      if (stale && attempt < 20 && !isRetryable(failure)) continue;
      throw failure;
    }
  }

  /** T を進める確認の最中なら、その完了。同時に 1 つだけ進める。 */
  private advancing: Promise<void> | null = null;

  /**
   * T を to まで進める。進められなければ、スナップショットのまま読み続ける。書き込みがあれば commit の検証で競合になる。
   * 確かめるのは、この時点までに記録した読みである。確認の最中に届く応答は、call が古い時点の読みとして読み直す。
   */
  private async advance(to: Ts): Promise<void> {
    if (this.advancing) return this.advancing;
    let done!: () => void;
    this.advancing = new Promise<void>((r) => (done = r));
    try {
      if (this.T !== undefined && this.T < to && !(await this.refreshTo(to))) this.wantsFresh = false;
    } finally {
      this.advancing = null;
      done();
    }
  }

  private async refreshTo(to: Ts): Promise<boolean> {
    const from = this.T!;
    const res = await Promise.all([...this.spans].map(([shard, spans]) =>
      this.db.shardOf(shard).refresh({ txn: this.id, spans, from, to }),
    ));
    if (res.some((r) => !r.ok)) return false;
    this.T = Math.max(from, to);
    return true;
  }

  /**
   * 取引が文を計画し、実行する表定義。取引は、最初に読むか書くかしてから確定まで、同じ表定義を使う (specs/m13_txn_schema_boundary.qnt)。
   * シャードは、要求が名乗る版を、その計画に使った版として信じる (自分より古い版の計画を断る)。溜めた書き込みを計画し直さずに
   * 新しい版を名乗ると、新しい index を保守しない書き込みが通る。表定義が変わるのは、確定の境目だけである。
   */
  get catalog(): Catalog {
    return this.cat;
  }

  /** まだ何も読み書きしていない取引を、新しい表定義へ移す。 */
  rebase(cat: Catalog): void {
    if (!this.untouched) throw new Error("a transaction that has read or written keeps its schema version until it commits");
    this.cat = cat;
    this.planned = cat.version;
  }

  /**
   * 同じ取引 (BEGIN から) の、前の区切りで読んだ範囲。DDL が区切りを作るたびに、次の取引へ引き継ぐ。
   * 取引が読んだ表を DROP するときに、読んだ後に別の接続が書いていないかを確かめる (Db.guardedDrop)。
   */
  earlier: ReadRecord[] = [];

  /** この取引が読んだ範囲。確定した後に呼ぶ。 */
  readRecord(): ReadRecord[] {
    const T = this.T ?? 0;
    return [...this.spans].map(([shard, spans]) => ({
      shard, spans,
      from: this.commitTs !== undefined && (this.writes.get(shard)?.size ?? 0) > 0 ? Math.max(T, this.commitTs) : T,
    }));
  }

  /** 以後、この取引の文と COMMIT を、この誤りで失敗させる。ROLLBACK は通る。 */
  doom(e: Error): void {
    this.doomed = e;
  }
  private doomed: Error | null = null;

  /** まだ何も読み書きしていない。 */
  get untouched(): boolean {
    return this.spans.size === 0 && this.writes.size === 0;
  }

  /** 接続を跨ぐ取引のために状態を書き出す。Worker は状態を持たないので Hrana の baton に載せる。 */
  dump(): TxnDump {
    const m = (x: Map<string, Map<string, Change>>) => [...x].map(([k, v]) => [k, [...v]] as const);
    return {
      id: this.id, schema: this.planned, earlier: this.earlier, T: this.T, writes: m(this.writes), spans: [...this.spans],
      pessimistic: this.pessimistic, lockReads: this.lockReads, lockOwner: this.lockOwner,
      saves: [...this.saves].map(([k, v]) => [k, { writes: m(v.writes), spans: [...v.spans] }] as const),
    };
  }

  /**
   * 書き出した取引を組み立て直す。cat は、いまの表定義である。
   * 書き出した後で表定義が変わっていたら、溜めた読みと書き込みは古い版のものである。新しい版を名乗らせるわけにはいかないので、
   * 取引を失敗させる (Txn.catalog)。何もしていない取引は、新しい版で続ける。
   */
  static load(db: Db, cat: Catalog, d: TxnDump): Txn {
    const tx = Txn.restore(db, cat, d);
    // 何もしていない取引は、いまの版で続けてよい。
    if (tx.untouched || db.faults.repinOnRestore) tx.planned = cat.version;
    // 版は書き出し直しても変わらないので、次の要求でも、その次でも失敗する。
    if (tx.planned !== cat.version) {
      tx.doom(new ConflictError(`the schema changed while the transaction was open (version ${tx.planned} to ${cat.version}); roll back and run the transaction again`));
    }
    return tx;
  }

  private static restore(db: Db, cat: Catalog, d: TxnDump): Txn {
    const tx = new Txn(db, cat, d.id);
    const m = (x: TxnDump["writes"]) => new Map(x.map(([k, v]) => [k, new Map(v)] as const));
    tx.planned = d.schema;
    tx.earlier = d.earlier ?? [];
    tx.T = d.T;
    tx.pessimistic = d.pessimistic;
    tx.lockReads = d.lockReads;
    tx.lockOwner = d.lockOwner;
    tx.writes = m(d.writes);
    tx.spans = new Map(d.spans);
    tx.saves = new Map(d.saves.map(([k, v]) => [k, { writes: m(v.writes), spans: new Map(v.spans) }]));
    return tx;
  }

  savepoint(name: string): void {
    this.saves.set(name.toLowerCase(), {
      writes: new Map([...this.writes].map(([k, v]) => [k, new Map(v)])),
      spans: new Map(this.spans),
    });
  }
  rollbackTo(name: string): void {
    const s = this.saves.get(name.toLowerCase());
    if (!s) throw new SqlError(`no such savepoint: ${name}`);
    this.writes = new Map([...s.writes].map(([k, v]) => [k, new Map(v)]));
  }
  release(name: string): void {
    if (!this.saves.delete(name.toLowerCase())) throw new SqlError(`no such savepoint: ${name}`);
  }

  async query(sql: string, params: Params = []): Promise<QueryResult> {
    this.sqls.push(sql);
    let last = new QueryResult([], []);
    for (const stmt of parseStatements(sql)) last = await this.statement(stmt, params);
    return last;
  }

  async statement(stmt: Node, params: Params): Promise<QueryResult> {
    if (this.doomed) throw this.doomed;
    return runPlanned(stmt, text(stmt), params, this.cat, this.planContext(), (p) => this.execute(p));
  }

  /** 計画の途中で表を読む式は、この取引の読みとして実行する。読んだ範囲が commit で検証される。 */
  planContext(): PlanContext {
    return {
      ...this.db.planContext(this.cat),
      read: async (sql, params) => (await this.statement(parseStatements(sql)[0], params)).values[0]?.[0] ?? null,
    };
  }

  /**
   * BEGIN IMMEDIATE の主キー読みはロックを取って最新を読む。本物の SQLite も先に書き込みロックを取る。
   * 楽観の読みのまま後で同じ行を書くと、検証で競合になるのが正しい動きなので、ホットな行が崩壊する。
   */
  protected override async shardRead(p: Extract<Plan, { kind: "shard" }>, t: Target): Promise<ExecRes> {
    if (!this.lockReads || !p.pk || p.tables.length !== 1) return super.shardRead(p, t);
    const tables = await this.db.tablesOf(p.sql, this.cat, p.tables, false);
    return this.dml(t.shard, {
      sql: p.sql, params: p.params, spans: statementSpans({ tables, sks: t.sks, pk: p.pk, write: false }),
      lockRows: [{ table: p.tables[0]!.name, pk: p.pk }],
    });
  }

  /** 悲観的な取引では最新の状態で実行してロックを取る。読んだ範囲は F から検証する。 */
  private async dml(shard: string, req: Omit<ExecReq, "T" | "minTs" | "schema" | "overlay">): Promise<ExecRes> {
    if (!this.pessimistic) return this.call(shard, req);
    this.lockOwner ??= { txn: this.txnId, start: this.db.startStamp() };
    const spans = withSlots(this.cat.routing, shard, req.spans);
    const res = await this.db.shardOf(shard).exec({
      ...req, spans, T: this.T, minTs: this.db.token, schema: this.cat.version, overlay: this.overlay(shard), lock: this.lockOwner,
    });
    this.T ??= res.T;
    this.db.observe(res.hlc);
    this.record(shard, spans.map((s) => ({ ...s, since: res.F })));
    if (res.error !== undefined) throw new SqlError(res.error);
    return res;
  }

  /** rollback でロックを手放す。届かなくても TTL で消える。 */
  async unlockAll(): Promise<void> {
    if (!this.lockOwner) return;
    await Promise.allSettled([...this.spans.keys()].map((id) => this.db.shardOf(id).unlock({ txn: this.txnId })));
  }

  /** 文の途中で失敗したら、その文の変更だけを取り消す。SQLite の文の原子性と同じである。 */
  private async atomically(fn: () => Promise<QueryResult>): Promise<QueryResult> {
    const saved = new Map([...this.writes].map(([k, v]) => [k, new Map(v)]));
    try {
      return await fn();
    } catch (e) {
      this.writes = saved;
      throw e;
    }
  }

  async execute(p: Plan): Promise<QueryResult> {
    if (this.doomed) throw this.doomed;
    switch (p.kind) {
      case "write": return this.atomically(() => this.write(p));
      case "wasmWrite": return this.atomically(() => this.wasmWrite(p));
      case "insertSelect": return this.atomically(() => this.insertSelect(p));
      case "noop":
        return new QueryResult([], []);
      case "ddl":
      case "tcl":
        throw new SqlError(p.kind === "tcl"
          ? "unsupported: BEGIN, COMMIT, ROLLBACK and SAVEPOINT inside a transaction object; use the object's own methods"
          : "unsupported: a schema change inside a transaction");
      default: return this.read(p);
    }
  }

  private async write(p: Extract<Plan, { kind: "write" }>): Promise<QueryResult> {
    const out: { columns: string[]; values: Value[][] } = { columns: [], values: [] };
    let changes = 0;
    const one = async (t: WriteTarget, target: Target) => {
      // index 経由の UPDATE と DELETE は、文を shard key に絞らずに送る。読みと同じく、span も絞らない。
      // 絞ると、ほかの行の確定済みで適用待ちの更新が決着されず、文がその行を古い値から書き換えてしまう。
      const tables = await this.db.tablesOf(t.sql, this.cat, p.tables ?? [p.def], true);
      const spans = statementSpans({ tables, sks: target.sks, pk: t.pk, write: true, uniqueReads: t.uniqueReads });
      const res = await this.dml(target.shard, { sql: t.sql, params: t.params, spans, write: t.write });
      if (res.columns.length) out.columns = res.columns;
      out.values.push(...res.values);
      changes += res.count ?? res.changes.length;
      for (const c of res.changes) this.buffer(target.shard, c);
      // 1 シャードへ送った文は、別のシャードの行との衝突を解決できない。衝突を自分で解決する文なら、基準経路で実行し直す。
      await this.indexChanges(res.changes, resolvesConflicts(t.sql) ? "resolve" : "fail");
    };
    const jobs: { t: WriteTarget; target: Target }[] = [];
    for (const t of p.targets) for (const target of await this.resolve(t.route)) jobs.push({ t, target });
    // 最初の要求で T を決めてから、シャードごとに並列に流す。同じシャードの中は順序を保つ。
    const byShard = new Map<string, typeof jobs>();
    for (const j of jobs) byShard.set(j.target.shard, [...(byShard.get(j.target.shard) ?? []), j]);
    if (jobs[0]) {
      const head = jobs[0];
      await one(head.t, head.target);
      byShard.get(head.target.shard)!.shift();
    }
    await Promise.all([...byShard.values()].map(async (list) => {
      for (const j of list) await one(j.t, j.target);
    }));
    return new QueryResult(out.columns, out.values, changes, p.lastRowid);
  }

  /**
   * 書き込みの基準経路。行を集めて Worker の SQLite で文を実行し、捕捉した行の変更を、行を持つシャードへ振り分ける。
   *
   * 文の意味は SQLite が決める。そのためには、Worker の SQLite に、文が読む行と、文の結果が衝突し得る行が入っていなければならない。
   * 衝突し得る行は、実行してみるまで分からない (書き込まれる値は、式や DEFAULT で決まる)。そこで、次を繰り返す。
   *
   *   1. 集めた行で文を実行し、変更を捕捉する。
   *   2. 変更後の行と、主キーか UNIQUE の値が同じで、まだ集めていない行を探す (conflicting)。
   *   3. なければ、変更を確定する。あれば、その行を集め足して、1 からやり直す。
   *
   * 集め足した行があれば、無視するか、置き換えるか、UNIQUE 違反にするかは、SQLite が本物の表と同じに決める。
   * 探すための読みは、取引の読みとして範囲に記録されるので、後から同じ値の行が入れば、commit の検証が競合にする。
   * 1 回ごとに集めた行が 1 つ以上増えるので、いつか止まる。止めるのは、集める行数の上限だけである。
   */
  private async wasmWrite(p: Extract<Plan, { kind: "wasmWrite" }>): Promise<QueryResult> {
    const catalog = (t: string) => {
      const d = findTable(this.cat, t);
      if (!d) throw new SqlError(`no such table: ${t}`);
      return d;
    };
    const loaded = await this.collect(p.scans, p.sql);
    // 集めた行の主キー。同じ行を 2 度入れないために持つ。
    const have = new Set<string>();
    for (const l of loaded) for (const key of keysOf(l)) have.add(key);
    // 済ませた探し方。取引は同じ時点を読み続けるので、同じ問いの答えは変わらない。
    const asked = new Set<string>();
    for (;;) {
      const w = await this.scratch(loaded);
      try {
        // 変更を捕捉するための表を作る前に確かめる。作った後では、文が見る表定義に、その表が混ざる。
        if (w.reads(p.sql).metadata) throw new SqlError(METADATA_IN_WRITE);
        for (const ddl of CAPTURE_TABLES) w.exec(ddl);
        for (const d of p.tables) for (const ddl of captureDdl(d)) w.exec(ddl);
        w.exec(`PRAGMA recursive_triggers = ON`);
        w.exec(`INSERT INTO __cap_on VALUES (1)`);
        const r = w.raw(p.sql, ...p.params);
        // 変更した行の数は、SQLite の数え方そのままである。REPLACE が消した行は数えない。
        const counted = w.raw(`SELECT changes()`).values[0]?.[0] as number;
        const last = w.raw(`SELECT last_insert_rowid()`).values[0]?.[0] as number;
        const changes = capturedChanges(w, catalog);
        const more = await this.conflicting(changes, catalog, have, asked);
        if (more.length > 0) {
          loaded.push(...more);
          this.withinRowBudget(have.size);
          continue;
        }
        for (const c of changes) {
          this.buffer(ownerOf(this.cat.routing, c.sk), c);
          const def = catalog(c.table);
          const id = def.rowidAlias ? c.after?.[def.rowidAlias] : def.implicitRowid ? c.after?.rowid : undefined;
          if (typeof id === "number") this.db.planContext(this.cat).sawId(def.name, id);
        }
        // 同じ値の行は全部ここにあり、SQLite が一意性を確かめ終えている。index の項目は、確かめ直さずに書く。
        await this.indexChanges(changes, "trusted");
        return new QueryResult(r.columns, r.values, counted, p.lastRowid ?? (last || null));
      } finally {
        w.close();
      }
    }
  }

  /**
   * 変更後の行と衝突し得る行のうち、まだ集めていないものを読む。
   * 衝突し得るのは、同じ主キーの行、同じシャード内 UNIQUE の値の行、同じシャードをまたぐ UNIQUE の値の行である。
   * シャードをまたぐ UNIQUE は、index の表を引いて、行の場所を知る。NULL のある値は、どの行とも衝突しない。
   */
  private async conflicting(changes: Change[], catalog: (t: string) => TableDef, have: Set<string>, asked: Set<string>): Promise<Loaded[]> {
    // 行の持ち主のシャードへの問いを、表と shard key の値ごとにまとめる。1 つの行が 2 つの条件に当たっても、1 回だけ返る。
    const wanted = new Map<string, { def: TableDef; sk: string; conds: { sql: string; params: Value[] }[] }>();
    const want = (def: TableDef, sk: string, cols: string[], vals: Value[], op: "=" | "IS") => {
      const id = `${def.name}\0${sk}\0${cols.join("\0")}\0${encode(vals)}`;
      if (asked.has(id)) return;
      asked.add(id);
      const key = `${def.name}\0${sk}`;
      const g = wanted.get(key) ?? { def, sk, conds: [] };
      wanted.set(key, g);
      g.conds.push({ sql: `(${cols.map((c) => `${q(def.name)}.${q(c)} ${op} ?`).join(" AND ")})`, params: vals });
    };
    for (const c of changes) {
      if (!c.after) continue;
      const def = catalog(c.table);
      // 主キー。新しく現れた主キーに、行が既にあるか。
      if (c.before === null && !have.has(`${def.name}\0${c.pk}`)) want(def, c.sk, def.pk, decode<Value[]>(c.pk), "IS");
      // シャード内の UNIQUE。shard key を含むので、同じ値の行は同じ shard key の値の中にある。`=` は列の照合順序で比べる。
      for (const cols of def.uniques) {
        const vals = cols.map((col) => c.after![col] ?? null);
        if (vals.some((v) => v === null)) continue;
        if (c.before && cols.every((col) => encode(c.before![col] ?? null) === encode(c.after![col] ?? null))) continue;
        want(def, c.sk, cols, vals, "=");
      }
      // シャードをまたぐ UNIQUE。index の表を引き、同じ値を持つ行の主キーと場所を知ってから、その行を読む。
      for (const ix of def.globalIndexes) {
        const keyOf = (r: Row | null): string | null => {
          if (!r) return null;
          const vals = ix.columns.map((col) => r[col] ?? null);
          return vals.some((v) => v === null) ? null : encode(vals);
        };
        const k = keyOf(c.after);
        if (k === null || k === keyOf(c.before) || asked.has(`${ix.table}\0${k}`)) continue;
        asked.add(`${ix.table}\0${k}`);
        const sk = encode([k]);
        // 並べて出さない。取引の最初の読みが 2 つ並ぶと、読む時点が 2 つでき、片方は検証の窓から漏れる。
        const hit = await this.call(ownerOf(this.cat.routing, sk), {
          sql: `SELECT "pk", "sk" FROM ${q(ix.table)} WHERE "k" = ?`, params: [k],
          spans: [rowSpan(ix.table, encode([k]), sk)],
        });
        for (const [pk, at] of hit.values) {
          if (!have.has(`${def.name}\0${pk as string}`)) want(def, at as string, def.pk, decode<Value[]>(pk as string), "IS");
        }
      }
    }
    const out: Loaded[] = [];
    for (const g of wanted.values()) {
      const name = q(g.def.name);
      const where = g.conds.map((x) => x.sql).join(" OR ");
      const params = g.conds.flatMap((x) => x.params);
      const scan: Scan = { table: g.def, sql: `SELECT ${selectList(g.def)} FROM ${name} WHERE ${where}`, params, sks: [g.sk], where: { alias: g.def.name, sql: where, params } };
      const { columns, rows } = await this.scan(scan);
      const found: Loaded = { table: g.def, columns, rows: [] };
      keysOf({ table: g.def, columns, rows }).forEach((key, i) => {
        if (have.has(key)) return;
        have.add(key);
        found.rows.push(rows[i]!);
      });
      if (found.rows.length > 0) out.push(found);
    }
    return out;
  }

  private async insertSelect(p: Extract<Plan, { kind: "insertSelect" }>): Promise<QueryResult> {
    const src = await this.read(p.select);
    if (src.values.length === 0) return new QueryResult([], []);
    const cols = p.columns ? `(${p.columns.map(q).join(", ")}) ` : "";
    let changes = 0;
    let last: number | null = null;
    // DO の bound parameter の上限 (100) に収まる行数ずつ流す。
    const width = Math.max(1, src.columns.length);
    const per = Math.max(1, Math.floor((100 - p.tailParams.length) / width));
    for (let at = 0; at < src.values.length; at += per) {
      const chunk = src.values.slice(at, at + per);
      const rows = chunk.map((row) => `(${row.map(() => "?").join(", ")})`).join(", ");
      const r = await this.query(`${p.head} ${cols}VALUES ${rows}${p.tail ? ` ${p.tail}` : ""}`, [...chunk.flat(), ...p.tailParams]);
      changes += r.changes;
      last = r.lastInsertRowid ?? last;
    }
    return new QueryResult([], [], changes, last);
  }

  private buffer(shard: string, c: Change): void {
    const m = this.writes.get(shard) ?? new Map<string, Change>();
    this.writes.set(shard, m);
    const key = `${c.table}\0${c.pk}`;
    const prior = m.get(key);
    // 検証の窓は最初の F から取る。2 回目の DML は自分の overlay を読むだけで、他者の変更を見ていない。
    const since = prior?.since !== undefined && c.since !== undefined ? Math.min(prior.since, c.since) : (prior?.since ?? c.since);
    m.set(key, prior ? { ...c, before: prior.before, since } : c);
  }

  /**
   * グローバル index を同じ取引の参加者として更新する。
   * check は、新しい値を持つ行がほかにないかを、どう確かめるかである。
   *   "fail"    index の表を引き、ほかの行があれば UNIQUE 違反にする。1 シャードへ送った文は、別のシャードの行を見ていない。
   *   "resolve" 同じく引くが、ほかの行があれば基準経路で実行し直す。文が衝突を自分で解決する形のときである。
   *   "trusted" 引かない。基準経路が、同じ値の行を全部集めたうえで SQLite に確かめさせた後である。
   */
  private async indexChanges(changes: Change[], check: "fail" | "resolve" | "trusted"): Promise<void> {
    const adds: { def: TableDef; ix: GlobalIndexDef; k: string; c: Change }[] = [];
    for (const c of changes) {
      const def = this.cat.tables[c.table];
      for (const ix of def?.globalIndexes ?? []) {
        const keyOf = (r: Row | null): string | null => {
          if (!r) return null;
          const vals = ix.columns.map((col) => r[col] ?? null);
          return vals.some((v) => v === null) ? null : encode(vals);
        };
        const oldK = keyOf(c.before);
        const newK = keyOf(c.after);
        if (oldK === newK) continue;
        if (oldK !== null) this.indexWrite(ix, { k: oldK, pk: c.pk, sk: c.sk }, true);
        if (newK !== null) adds.push({ def: def!, ix, k: newK, c });
      }
    }
    // 項目を消すほうを全部済ませてから、足す。1 つの文が、ある行を消して同じ値の行を入れる (REPLACE) とき、
    // 先に足そうとすると、消える行の項目と衝突する。
    for (const a of adds) {
      if (check !== "trusted") await this.assertUnique(a.def, a.ix, a.k, a.c.pk, check === "resolve");
      this.indexWrite(a.ix, { k: a.k, pk: a.c.pk, sk: a.c.sk }, false);
    }
  }

  /** SQLite と同じく文の時点で検査する。commit の検証だけだと、文が成功した後で COMMIT が失敗する。 */
  async assertUnique(def: TableDef, ix: GlobalIndexDef, k: string, pk: string, resolve = false): Promise<void> {
    const sk = encode([k]);
    const res = await this.call(ownerOf(this.cat.routing, sk), {
      sql: `SELECT "pk" FROM ${q(ix.table)} WHERE "k" = ?`, params: [k],
      spans: [rowSpan(ix.table, encode([k]), sk)],
    });
    if (res.values.some((r) => r[0] !== pk)) {
      if (resolve) throw new NeedsReference(`a row on another shard holds the same ${ix.columns.join(", ")}`);
      throw new SqlError(`UNIQUE constraint failed: ${def.name}.${ix.columns.join(", ")}`);
    }
  }

  indexWrite(ix: GlobalIndexDef, row: Row, remove: boolean): void {
    const def = this.cat.tables[ix.table]!;
    const key = encodeKey(def, row);
    this.buffer(ownerOf(this.cat.routing, key.sk), {
      table: ix.table, ...key, before: remove ? row : null, after: remove ? null : row,
    });
  }

  async commit(): Promise<void> {
    if (this.doomed) throw this.doomed;
    // 大きすぎる取引は、シャードへ送る前にここで断る。シャードも同じ検査をするが、そちらの拒否は競合と同じ扱いで再試行される。
    for (const changes of this.writes.values()) {
      let bytes = 0;
      for (const c of changes.values()) bytes += utf8Length(encode(c));
      if (bytes > this.db.writeSetBudget) {
        await this.unlockAll().catch(() => undefined);
        throw new SqlError(`transaction too large: it changes more than ${this.db.writeSetBudget} bytes of rows on one shard; split it into smaller transactions`);
      }
    }
    const shards = new Set([...this.writes.keys()].filter((s) => this.writes.get(s)!.size > 0));
    // 読み取りだけなら T の snapshot で完結する。ただしロックを取って最新を読んだ取引は、
    // 読みの時刻が揃っていないので検証が要る。検証でロックも手放す。
    const latest = [...this.spans.values()].some((list) => list.some((s) => s.since !== undefined));
    if (shards.size === 0 && !latest) return;
    for (const s of this.spans.keys()) shards.add(s);

    const parts = [...shards].map((shard) => ({
      shard,
      writes: this.overlay(shard),
      spans: this.spans.get(shard) ?? [],
    }));
    const T = this.T ?? 0;
    const schema = this.cat.version;
    let res: CommitRes;
    if (parts.length === 1) {
      const p = parts[0]!;
      res = await this.db.shardOf(p.shard).commitLocal({ txn: this.id, T, writes: p.writes, spans: p.spans, schema });
    } else {
      // anchor は最後に prepare するので refresh が要らない。未保護の span が多い参加者を選ぶ。
      const score = (p: (typeof parts)[number]) =>
        p.spans.filter((s) => !(s.kind === "pk" && p.writes.some((w) => w.table === s.table && w.pk === s.pk))).length;
      const sorted = [...parts].sort((a, b) => score(b) - score(a) || hashKey(this.id + a.shard) - hashKey(this.id + b.shard));
      const anchor = this.db.shardOf(sorted[0]!.shard);
      try {
        res = await anchor.commit({ txn: this.id, T, participants: parts, schema });
      } catch (e) {
        const st = await anchor.status({ txn: this.id }); // 応答不明は status で決着を知る。
        if (st.status === "committed") res = { ok: true, c: st.c };
        else if (st.status === "aborted") throw new ConflictError(`commit outcome: ${e instanceof Error ? e.message : e}`);
        else throw e;
      }
    }
    if (!res.ok) {
      if (res.reason.startsWith("unique")) throw new SqlError(`UNIQUE constraint failed (${res.reason})`);
      throw new ConflictError(res.reason);
    }
    this.commitTs = res.c;
    this.db.observe(res.c);
  }
}

/** Worker の中で動く SQL の入口。1 つの Db が 1 つの接続に対応する。 */
export class Db {
  token: Ts = 0;
  private seq = 0;
  private cached: Catalog | null;
  private current: Txn | null = null;
  private ids: Map<string, { next: number; end: number }>;
  private touched = new Set<string>();
  /** 文の中から呼んだ transaction は、文の記録に含める。 */
  private inStatement = false;
  readonly rt: Runtime;
  readonly reference: Reference | undefined;
  readonly faults: ClientFaults;
  /**
   * この接続が、開いている取引の途中で確定したか、表定義を変えた回数。batch をやり直してよいかを決めるのに使う。
   * 増えていれば、batch の前のほうの文は、もう効いている。頭からやり直すと、2 度実行することになる。
   */
  boundaries = 0;
  constructor(
    readonly cluster: Cluster,
    private opts: {
      retries?: number; idPrefix?: string; token?: Ts; catalog?: Catalog; idBlock?: number;
      /** DDL が、進行中のシャードの増設が終わるのを待つ時間 (ms)。既定は 60 秒。 */
      splitWaitMs?: number;
      /** 書き込みが、表を書き込み禁止にしている表定義の変更が終わるのを待つ時間 (ms)。既定は 35 秒。 */
      schemaWaitMs?: number;
      /** 取り直した表定義を呼び出し側のキャッシュへ戻す。 */
      onCatalog?: (c: Catalog) => void;
      /** 採番のブロック。要求ごとに Db を作る環境では共有しないと番号が大きく飛ぶ。 */
      ids?: Map<string, { next: number; end: number }>;
      /** 上限の上書き。試験と、上限を下げたい利用者のためにある。既定は ROW_BUDGET、BYTE_BUDGET、MAX_WRITE_SET_BYTES。 */
      limits?: { rows?: number; bytes?: number; writeSetBytes?: number };
      /** 文が終わるたびに呼ぶ。失敗した文でも呼ぶ。 */
      onStatement?: (s: StatementStat) => void;
      /** 実時間、待ち、乱数、識別子の出どころ。指定しなければ、クラスタのもの、なければ実物を使う。 */
      runtime?: Runtime;
      /** 最適化の経路を使わず、基準経路だけで実行する (sql/plan.ts の Reference)。指定しなければ、クラスタのものを使う。試験が使う。 */
      reference?: Reference;
      /** 検証済みの欠陥を再導入するスイッチ。試験だけが使う。 */
      faults?: ClientFaults;
    } = {},
  ) {
    this.rt = opts.runtime ?? cluster.runtime ?? systemRuntime;
    this.reference = opts.reference ?? cluster.reference;
    this.faults = opts.faults ?? {};
    this.token = cleanToken(opts.token);
    this.cached = opts.catalog ?? null;
    this.ids = opts.ids ?? new Map();
  }

  observe(ts: Ts): void {
    this.token = Math.max(this.token, ts);
  }

  /** ロックの優先順位に使う開始時刻。古い取引が勝つ。 */
  startStamp(): Ts {
    return this.rt.now();
  }

  async catalog(): Promise<Catalog> {
    if (!this.cached) {
      this.cached = await this.cluster.catalog();
      this.opts.onCatalog?.(this.cached);
    }
    return this.cached;
  }

  /** リトライの前に呼ぶ。経路が古ければ捨て、移動の時刻を因果トークンへ取り込む。 */
  private onRetry(e: unknown): void {
    const m = (e as Error)?.message ?? "";
    if (/not owner:|^migrating/.test(m)) this.cached = null;
    const moved = /moved at (\d+)/.exec(m);
    if (moved) this.observe(Number(moved[1]));
  }

  /**
   * 文を Worker の SQLite でコンパイルして、開く表を知る。ここには利用者の表と view しかないので、コンパイルできない文は、
   * 内部の表を名指ししているか、SQLite が受け付けない文である。
   * 結果は、文の文面と表定義の履歴ごとに覚えておく。同じ文の 2 回目からは、Worker の SQLite を開かない。
   */
  async compiled(sql: string, cat: Catalog): Promise<Compiled> {
    const key = `${historyKey(cat)}\0${sql}`;
    let tablesSeen = tablesSeenBy.get(this.rt);
    if (!tablesSeen) tablesSeenBy.set(this.rt, (tablesSeen = new Map()));
    let seen = tablesSeen.get(key);
    if (seen === undefined) {
      const w = await openScratch(cat);
      try {
        seen = w.reads(sql);
      } finally {
        w.close();
      }
      if (tablesSeen.size >= 2000) tablesSeen.delete(tablesSeen.keys().next().value!);
      tablesSeen.set(key, seen);
    }
    return seen;
  }

  /**
   * 文が読む表を、SQLite のコンパイル結果で確かめる。構文から拾った表のほかに SQLite が開く表があれば、文を断る。
   * 手書きの解析は、サブクエリや `x IN 表` などの参照を見落とし得る。見落とした表は、経路の判断にも範囲にも入っていない。
   * コンパイルできない文は断る。Worker の SQLite には利用者の表しかないので、内部の表を名指す文もここで落ちる。
   * 結果は文の文面と表定義の版ごとに覚えておく。同じ文の 2 回目からは、Worker の SQLite を開かない。
   */
  async tablesOf(sql: string, cat: Catalog, known: TableDef[], write: boolean): Promise<TableDef[]> {
    const seen = await this.compiled(sql, cat);
    // 表定義を読む文は、シャードへ送らない。シャードで実行すると、内部の表 (`__txn` など) について答えてしまう。
    // 読みは、基準経路で実行すれば、利用者の表しかない Worker の SQLite が答える。
    // 書き込みは断る。書き込みの基準経路は、変更を捕捉するための表を Worker の SQLite に作るので、そこでも利用者の表定義だけにはならない。
    if (seen.metadata) {
      if (write) throw new SqlError(METADATA_IN_WRITE);
      throw new NeedsReference("the statement reads the schema");
    }
    // プランナが知らない表を、SQLite が開くと答えた (`x IN 表名` など)。プランナは、知っている表についてだけ「この文が読む行は、
    // 送り先のシャードにある」と確かめている。知らない表の行は別のシャードにもあり得るので、そのまま送ると黙って行が欠ける。
    // 基準経路は、SQLite が開くと答えた表を全部集める。
    const have = new Set(known.map((d) => d.name));
    const unknown = seen.tables.filter((n) => !have.has(n));
    if (unknown.length > 0) throw new NeedsReference(`the statement reads ${unknown.join(", ")} outside its FROM clause`);
    return known;
  }

  planContext(cat: Catalog): PlanContext {
    return {
      reference: this.reference,
      nextId: (table, n) => this.nextId(table, n),
      sawId: (table, id) => {
        const b = this.ids.get(table);
        if (!b || id >= b.next) this.pendingSeen.set(table, Math.max(this.pendingSeen.get(table) ?? 0, id));
      },
      evaluate: async (sql, params) => {
        const w = await openScratch(cat);
        try {
          return w.raw(sql, ...params).values[0]?.[0] ?? null;
        } finally {
          w.close();
        }
      },
    };
  }

  private pendingSeen = new Map<string, number>();

  /** rowid をブロック単位で採番する。Meta への問い合わせはブロックごとの 1 回で済む。 */
  private async nextId(table: string, n: number): Promise<number> {
    const seen = this.pendingSeen.get(table);
    this.pendingSeen.delete(table);
    let b = this.ids.get(table);
    if (b && seen !== undefined && seen >= b.next && seen + n < b.end) b.next = seen + 1;
    if (!b || b.next + n > b.end || (seen !== undefined && seen >= b.next)) {
      const size = Math.max(n, this.opts.idBlock ?? 100);
      const start = await this.cluster.allocate(table, size, seen ?? 0);
      b = { next: start, end: start + size };
      this.ids.set(table, b);
    }
    const first = b.next;
    b.next += n;
    return first;
  }

  /**
   * DDL の履歴は、Worker の SQLite でも再生する (行を集めて実行する文のため)。記録する前に、ここで再生できることを確かめる。
   * Meta が確かめるのはシャードで実行する文だけで、利用者が書いた形の文は確かめない。再生できない文が履歴に入ると、
   * 履歴は書き換えられないので、以後、行を集める文がすべて失敗する。
   */
  private async assertReplays(sql: string, cat: Catalog): Promise<void> {
    const parsed = parseDdl(sql, cat);
    // 既存の行から作る index の文は、公開のときに再生する。ここで確かめておく。
    const user = parsed.user ?? parsed.build?.user;
    if (parsed.noop || !user) return;
    const w = await openScratch(cat);
    try {
      w.exec(user);
    } catch (e) {
      throw new SqlError((e as Error)?.message ?? String(e));
    } finally {
      w.close();
    }
  }

  /** 全シャードに、この版までの DDL を適用させる。最初の失敗と、範囲の移動の途中のシャードがあるかを返す。 */
  private async syncAll(cat: Catalog): Promise<{ failed: unknown; moving: boolean }> {
    const done = await Promise.allSettled(shardsOf(cat.routing).map((id) => this.shardOf(id).syncSchema({ version: cat.version })));
    const failed = done.find((r): r is PromiseRejectedResult => r.status === "rejected")?.reason ?? null;
    const waiting = /waiting for a shard split/.test((failed as Error)?.message ?? "");
    return { failed, moving: waiting || done.some((r) => r.status === "fulfilled" && r.value?.moving === true) };
  }

  private publish(cat: Catalog): void {
    this.cached = cat;
    // 呼び出し側のキャッシュにも渡す。渡さないと、同じ isolate の次の要求が DDL の前の表定義で計画する。
    this.opts.onCatalog?.(cat);
  }

  /**
   * 新しい版を記録する。先に、現在の版を全シャードへ適用させる。Meta は、その版から進んでいれば記録を断る。
   * 前の版を適用していないシャードが残ったまま次の版を積むと、前の版がそのシャードで失敗したときに取り消せなくなる。
   */
  private async record(write: (basedOn: number, before: Catalog) => Promise<Catalog>): Promise<{ before: Catalog; cat: Catalog }> {
    const deadline = this.rt.now() + (this.opts.splitWaitMs ?? SPLIT_WAIT_MS);
    const busyUntil = this.rt.now() + SCHEMA_WAIT_MS;
    for (let attempt = 0; ; attempt++) {
      const before = await this.cluster.catalog();
      const { failed, moving } = await this.syncAll(before);
      // シャードの増設の途中は、新しい版を記録しない。増設の間、親と子は DDL を適用しないので、記録すると、
      // 新しい版で計画した要求がそのシャードで通らなくなる。終わるのを待つ。
      if (moving) {
        if (this.rt.now() > deadline) throw new SqlError("a shard split is in progress; retry the schema change when it finishes");
        attempt = Math.min(attempt, 3);
        await sleep(this.rt, 20);
        continue;
      }
      if (failed) {
        // 失敗したシャードが、その版の取り消しを Meta に求めたのかもしれない。版が進んでいれば、取り直してやり直す。
        if (attempt < 5 && (await this.cluster.catalog()).version !== before.version) continue;
        throw failed;
      }
      try {
        return { before, cat: await write(before.version, before) };
      } catch (e) {
        const m = (e as Error)?.message ?? "";
        if (attempt < 5 && /schema moved to version/.test(m)) continue;
        // 別の接続が index を作っている最中である。終わるか、期限で取り消されるまで待つ。
        if (/schema busy:/.test(m) && this.rt.now() <= busyUntil) {
          attempt = Math.min(attempt, 3);
          await sleep(this.rt, 50);
          continue;
        }
        throw e;
      }
    }
  }

  /**
   * 表定義を変える。取引の中なら、先に取引を確定し、DDL の後は新しい取引を開いておく (MySQL と同じ。specs/m13_txn_schema_boundary.qnt)。
   *
   * DDL は、取引の中でも、その場で全シャードに効き、取り消せない。書き込みは COMMIT まで手元に溜まる。先に確定しないと、
   * 効く順序が書いた順序と入れ替わる (行を写してから古い表を消す移行で、行が全部消える)。
   * 確定できなければ、DDL は実行せず、取引は終わる (SQLite が誤りで取引を巻き戻したときと同じ)。
   * 新しい取引を開いておくのは、利用者が最後に送る COMMIT のためである。libSQL のクライアントは、COMMIT を
   * 「autocommit でない」ことを条件に送る。ROLLBACK と SAVEPOINT が戻せるのは、最後の DDL より後だけになる。
   */
  async ddl(sql: string, reads: ReadRecord[] = []): Promise<void> {
    const open = this.current;
    if (!open) return this.changeSchema(sql, reads);
    this.current = null;
    try {
      await open.commit();
    } catch (e) {
      await open.unlockAll().catch(() => undefined);
      throw e;
    }
    this.boundaries++;
    const next = new Txn(this, await this.catalog(), this.nextTxnId());
    next.pessimistic = open.pessimistic;
    next.lockReads = open.lockReads;
    next.earlier = [...open.earlier, ...open.readRecord()];
    this.current = next;
    try {
      await this.changeSchema(sql, next.earlier);
      this.boundaries++;
    } finally {
      // 新しい取引は、まだ何もしていない。DDL の後の表定義で計画する。
      next.rebase(await this.catalog());
    }
  }

  /** reads は、この DDL を含む取引が、それまでに読んだ範囲である。読んだ表を DROP するなら、guardedDrop を通す。 */
  private async changeSchema(sql: string, reads: ReadRecord[] = []): Promise<void> {
    const guarded = this.faults.dropWithoutGuard ? [] : await this.droppedAfterRead(sql, reads);
    if (guarded.length > 0) return this.guardedDrop(sql, guarded, reads);
    await this.checkUnique(sql);
    const { before, cat } = await this.record(async (basedOn, at) => {
      await this.assertReplays(sql, at);
      return this.cluster.applyDdl(sql, basedOn);
    });
    this.publish(cat);
    this.ids.clear();
    if (cat.version === before.version) return; // 何も記録されなかった
    // 既存の行から index を作り始めた。記録した版は、表を書き込み禁止にしている。
    const table = Object.values(cat.tables).find((def) => def.building && !before.tables[def.name]?.building);
    if (table) return this.buildIndex(table, table.building!, cat);
    // 全シャードへ適用してから完了を返す。適用が遅れると、古い表定義の Worker がそのシャードへ書き、
    // 後から DROP が適用されて行が消える。適用後は古い要求を全シャードが拒否する。
    const failed = await this.syncRecorded(cat);
    if (failed) {
      // シャードの行によっては適用できない文がある (重複のある列への UNIQUE index など)。
      // そのシャードが取り消しを求めているので、取り消しを全シャードへ行き渡らせてから、理由を返す。
      const now = await this.cluster.catalog();
      if (now.revoked?.version !== cat.version) throw failed;
      this.publish(now);
      await this.syncAll(now);
      throw new SqlError(now.revoked.reason);
    }
  }

  /** DROP TABLE が消す表のうち、reads が読んだもの。 */
  private async droppedAfterRead(sql: string, reads: ReadRecord[]): Promise<string[]> {
    if (reads.length === 0) return [];
    let stmt: Node | undefined;
    try {
      [stmt] = parseStatements(sql);
    } catch {
      return [];
    }
    if (stmt?.type !== "drop_table_stmt") return [];
    const cat = await this.catalog();
    const read = new Set(reads.flatMap((r) => r.spans.map((s) => s.table)));
    return (stmt.tables.items as Node[])
      .map((t) => findTable(cat, ident(t.type === "member_expr" ? t.property : t))?.name)
      .filter((n): n is string => n !== undefined && read.has(n));
  }

  /**
   * 取引が読んだ表を DROP する (specs/m14_rebuild_guard.qnt)。表を作り直す移行は、行を写した区切りを確定してから、古い表を消す。
   * その間に別の接続が古い表へ書いた行は、写されないまま消える。そこで、
   *   1. 古い表を書き込み禁止にする版を記録し、全シャードへ適用させる (intent を決着させ、以後の書き込みを断る)。
   *   2. 取引が読んだ範囲を持つシャードごとに、読んだ後に変更がないかを確かめる (ShardApi.unchanged)。
   *   3. 変更がなければ、DROP を、禁止の唯一の終わり方として記録する。変更があれば、禁止を取り消し、競合として失敗する。
   * 行は失われない。代わりに、移行が失敗する。禁止は、index の作成と同じく期限つきで、延ばし続ける。
   */
  private async guardedDrop(sql: string, tables: string[], reads: ReadRecord[]): Promise<void> {
    const { cat: locked } = await this.record((basedOn) => this.cluster.lockTables(tables, basedOn));
    this.publish(locked);
    const version = locked.version;
    const names = new Set(tables);
    const lease = this.keepLease(version);
    let dropped: Catalog;
    try {
      const failed = await this.syncRecorded(locked);
      if (failed) throw failed;
      for (const r of reads) {
        const spans = r.spans.filter((s) => names.has(s.table));
        if (spans.length === 0) continue;
        const res = await this.shardOf(r.shard).unchanged({ spans, from: r.from, schema: version });
        if (!res.ok) {
          throw new ConflictError(`another connection wrote to ${tables.join(", ")} after this transaction read it (${res.reason}); nothing was dropped, run the change again`);
        }
      }
      dropped = await this.cluster.finishLock(version, sql);
    } catch (e) {
      const reason = (e as Error)?.message ?? String(e);
      await this.cluster.revokeDdl(version, reason).catch(() => null);
      const now = await this.cluster.catalog().catch(() => null);
      if (now) {
        this.publish(now);
        await this.syncAll(now).catch(() => undefined);
      }
      // 期限で先に取り消されていれば、その理由を返す。
      if (now?.revoked?.version === version && now.revoked.reason !== reason) throw new SqlError(now.revoked.reason);
      throw e;
    } finally {
      lease.stop();
    }
    this.publish(dropped);
    this.ids.clear();
    const failed = await this.syncRecorded(dropped);
    if (failed) throw failed;
  }

  /** 記録した版を全シャードへ適用させる。増設の途中のシャードは、増設が終われば適用するので、待つ。失敗を返す。 */
  private async syncRecorded(cat: Catalog): Promise<unknown> {
    let { failed, moving } = await this.syncAll(cat);
    // 記録した直後に増設が始まると、そのシャードは増設が終わるまで適用しない。
    for (const deadline = this.rt.now() + (this.opts.splitWaitMs ?? SPLIT_WAIT_MS); failed && moving; ) {
      if (this.rt.now() > deadline) {
        throw new SqlError("the schema change is recorded, but a shard split is in progress; shards being split apply it when the split finishes");
      }
      await sleep(this.rt, 20);
      ({ failed, moving } = await this.syncAll(cat));
    }
    return failed;
  }

  /**
   * 重複のある列への UNIQUE を、記録する前に断る。記録した後でも、適用に失敗したシャードが取り消すので止まりはしないが、
   * 版が 2 つ進み、ほかのシャードは index を作ってから捨てることになる。部分 index (WHERE 付き) はここでは調べない。
   */
  private async checkUnique(sql: string): Promise<void> {
    const m = /^\s*CREATE\s+UNIQUE\s+INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?\S+\s+ON\s+"?(\w+)"?\s*\(([^)]*)\)\s*;?\s*$/i.exec(sql);
    if (!m) return;
    const cat = await this.cluster.catalog();
    const def = findTable(cat, m[1]!);
    if (!def) return;
    const cols = m[2]!.split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
    if (!def.shardKey.every((c) => cols.includes(c))) return;
    const list = cols.map(q).join(", ");
    for (const shard of shardsOf(cat.routing)) {
      const res = await this.shardOf(shard).exec({
        sql: `SELECT 1 x FROM ${q(def.name)} GROUP BY ${list} HAVING count(*) > 1 LIMIT 1`,
        params: [], spans: withSlots(cat.routing, shard, [tableSpan(def.name)]), schema: cat.version,
      });
      if (res.error !== undefined) throw new SqlError(res.error);
      if (res.values.length) throw new SqlError(`UNIQUE constraint failed: ${def.name} has duplicate values`);
    }
  }

  /**
   * 既存の行から、シャードをまたぐ UNIQUE の index を作る。started は index を作り始めた版の表定義で、その版が表を書き込み禁止に
   * している (specs/m12_unique_index_build.qnt)。
   *
   *   1. 全シャードの行を読み、値ごとに、その値を持つ行を 1 つ覚える。同じ値の行が 2 つあれば、UNIQUE 違反である。
   *   2. index の項目を書く。
   *   3. index を公開する。公開の版が、書き込み禁止を解く。
   *
   * 行は止まっているので、読んだ後で変わる行はなく、並行する書き込みと項目を取り合うこともない。index は公開まで
   * 計画からも Worker の SQLite からも見えないので、作りかけの index をもとに結果を変える文はない。
   * 途中で失敗したら、作り始めた版ごと取り消す。この呼び出しが途中で止まっても、期限が来れば Meta が取り消す。
   * どちらの場合も、表は元のままである。
   */
  private async buildIndex(def: TableDef, ix: GlobalIndexDef, started: Catalog): Promise<void> {
    const version = started.version;
    let published: Catalog;
    const lease = this.keepLease(version);
    try {
      // 行を読む要求は、作り始めた版を名乗る。シャードはその版を適用してから答えるので、読んだ時点で、そのシャードの行は止まっている。
      const failed = await this.syncRecorded(started);
      if (failed) throw failed;
      const { entries, at } = await this.scanForIndex(def, ix, version);
      const written = await this.writeIndex(ix, entries, version);
      published = await this.cluster.publishIndex(def.name, ix.name, version, Math.max(at, written));
    } catch (e) {
      // 取り消す。期限切れで先に取り消されていれば、その理由を返す。Worker の 1 回の呼び出しで使える要求の数を使い切ったときは、
      // 取り消しの要求も通らない。その場合は、期限が来れば Meta が取り消す。
      const exhausted = /too many subrequests|subrequest/i.test((e as Error)?.message ?? "");
      const reason = exhausted
        ? `CREATE INDEX ${ix.name} did not finish: the table has too many rows to index within one request. The index was not created and the table is unchanged. A UNIQUE constraint declared in CREATE TABLE needs no build.`
        : ((e as Error)?.message ?? String(e));
      await this.cluster.revokeDdl(version, reason).catch(() => null);
      const now = await this.cluster.catalog().catch(() => null);
      if (now) {
        this.publish(now);
        await this.syncAll(now).catch(() => undefined);
      }
      if (exhausted) throw new SqlError(reason);
      if (now?.revoked?.version === version && now.revoked.reason !== reason) throw new SqlError(now.revoked.reason);
      throw e;
    } finally {
      lease.stop();
    }
    this.publish(published);
    // 公開の版を全シャードへ適用させて、書き込み禁止を早く解く。届かなくても、次の要求が適用させる。
    await this.syncAll(published);
  }

  /**
   * 作っている最中の index の期限を、期限の半分ごとに延ばし続ける (meta.ts の INDEX_LEASE_MS)。期限の長さは Meta が返す。
   * 最初の延長は、すぐに行う。それまでは期限の長さを知らないからである。
   * 作業の段ごとではなく時計で延ばすのは、1 つの要求が長くかかる間 (シャードが取引の決着を待つ、など) も、延ばし続けるためである。
   * この呼び出しが止まれば、延長も止まり、Meta が取り消す。延長が断られたら (もう取り消された)、そこでやめる。
   */
  private keepLease(version: number): { stop(): void } {
    let stopped = false;
    let handle: unknown;
    const tick = () => {
      if (stopped) return;
      this.cluster.renewLock(version).then(
        ({ leaseMs }) => {
          if (!stopped) handle = this.rt.after(leaseMs / 2, tick);
        },
        () => undefined,
      );
    };
    tick();
    return {
      stop: () => {
        stopped = true;
        this.rt.cancel(handle);
      },
    };
  }

  /** index を作り始めた版が、まだ最新か。取り消されていれば、その理由で失敗させる。 */
  private async stillBuilding(version: number): Promise<Catalog> {
    const cat = await this.cluster.catalog();
    if (cat.version === version) return cat;
    throw new SqlError(cat.revoked?.version === version ? cat.revoked.reason : `CREATE INDEX: the schema moved to version ${cat.version} while the index was being built`);
  }

  /**
   * 全シャードの行を読んで、index の項目を集める。値ごとに 1 行。同じ値を持つ行が 2 つあれば失敗する。
   * 返す at は、読んだシャードの時計の最大である。index を使わずに確定した書き込みは、どれもこの時刻以下である。
   * 行のないシャードも読む。そのシャードで行を消した書き込みの時刻も、at に入れなければならないからである。
   * 増設が挟まると、行が別のシャードへ移る。行そのものは変わらないので、範囲表が変わらなくなるまで、全体を読み直せば足りる。
   */
  private async scanForIndex(def: TableDef, ix: GlobalIndexDef, version: number): Promise<{ entries: Map<string, { pk: string; sk: string }>; at: Ts }> {
    let at: Ts = 0;
    for (let round = 0; ; round++) {
      const cat = await this.stillBuilding(version);
      const entries = new Map<string, { pk: string; sk: string }>();
      let moved = false;
      for (const shard of shardsOf(cat.routing)) {
        const seen = await this.scanShard(def, ix, shard, cat, entries);
        if (seen === null) {
          moved = true;
          break;
        }
        at = Math.max(at, seen);
      }
      if (!moved && (await this.stillBuilding(version)).routing.version === cat.routing.version) return { entries, at };
      if (round >= 20) throw new SqlError(`CREATE INDEX ${ix.name}: shards kept splitting while the index was being built`);
    }
  }

  /** 1 シャードの行を主キーの順に少しずつ読む。読んだ時点のシャードの時計を返す。途中で範囲が移ったら null を返す。 */
  private async scanShard(
    def: TableDef, ix: GlobalIndexDef, shard: string, cat: Catalog, entries: Map<string, { pk: string; sk: string }>,
  ): Promise<Ts | null> {
    // 要るのは、行の同一性 (主キーと shard key) と、index の列だけである。
    const cols = [...new Set([...def.pk, ...def.shardKey, ...ix.columns])].map(q).join(", ");
    const pkCols = def.pk.map(q).join(", ");
    let after: Value[] | null = null;
    let at: Ts = 0;
    for (let attempt = 0; ; ) {
      let res: ExecRes;
      try {
        res = await this.shardOf(shard).exec({
          sql: `SELECT ${cols} FROM ${q(def.name)} ${after ? `WHERE (${pkCols}) > (${def.pk.map(() => "?").join(", ")})` : ""} ORDER BY ${pkCols} LIMIT ${BUILD_PAGE}`,
          params: after ?? [], spans: withSlots(cat.routing, shard, [tableSpan(def.name)]), schema: cat.version,
        });
      } catch (e) {
        const m = (e as Error)?.message ?? "";
        // 範囲の持ち主が変わったか、表定義の版が進んだ。呼び出し側が取り直して、全体をやり直す (取り消されていれば、そこで失敗する)。
        if (/^not owner|stale schema/.test(m)) return null;
        // 移動の途中は表全体を読めない。終わるのを待つ。
        if (/^migrating|group not arrived|read too old/.test(m) && attempt++ < BUILD_RETRIES) {
          await backoff(this.rt, attempt);
          continue;
        }
        throw e;
      }
      if (res.error !== undefined) throw new SqlError(res.error);
      attempt = 0;
      at = Math.max(at, res.T, res.hlc);
      const rows = new QueryResult(res.columns, res.values).rows;
      for (const row of rows) {
        const vals = ix.columns.map((col) => row[col] ?? null);
        if (vals.some((v) => v === null)) continue; // NULL のある値は、どの行とも衝突しない
        const k = encode(vals);
        const key = encodeKey(def, row);
        const prior = entries.get(k);
        if (prior !== undefined && prior.pk !== key.pk) throw new SqlError(`UNIQUE constraint failed: ${def.name}.${ix.columns.join(", ")}`);
        entries.set(k, key);
      }
      if (rows.length < BUILD_PAGE) return at;
      const last = rows[rows.length - 1]!;
      after = def.pk.map((col) => last[col] ?? null);
    }
  }

  /**
   * 集めた項目を index の表へ書く。確定の時刻の最大を返す。
   * 項目は、持ち主のシャードごとに、少しずつ取引で書く。先に、同じ値の項目がもうあるかを読む。あれば書かない。
   * こうすると、範囲が移ってやり直しても、書き終えた分を 2 度書くことがない。
   */
  private async writeIndex(ix: GlobalIndexDef, entries: Map<string, { pk: string; sk: string }>, version: number): Promise<Ts> {
    let at: Ts = 0;
    let left = [...entries].map(([k, row]) => ({ k, ...row }));
    let cat = await this.stillBuilding(version);
    for (let attempt = 0; left.length > 0; ) {
      const owner = ownerOf(cat.routing, encode([left[0]!.k]));
      const batch = left.filter((e) => ownerOf(cat.routing, encode([e.k])) === owner).slice(0, BUILD_BATCH);
      const tx = new Txn(this, cat, this.nextTxnId());
      try {
        const ks = batch.map((e) => e.k);
        // 値の一覧は 1 つの引数で渡す。1 つずつ渡すと、文に付けられる引数の数の上限 (100) に当たる。
        const found = await tx.call(owner, {
          sql: `SELECT "k", "pk" FROM ${q(ix.table)} WHERE "k" IN (SELECT value FROM json_each(?))`,
          params: [JSON.stringify(ks)],
          spans: ks.map((k) => rowSpan(ix.table, encode([k]), encode([k]))),
        });
        const existing = new Map(found.values as [string, string][]);
        for (const e of batch) {
          const have = existing.get(e.k);
          if (have !== undefined && have !== e.pk) throw new SqlError(`UNIQUE constraint failed: index ${ix.name} already has an entry for another row`);
          if (have === undefined) tx.indexWrite(ix, e, false);
        }
        await tx.commit();
        at = Math.max(at, tx.commitTs ?? tx.T ?? 0);
      } catch (e) {
        await tx.unlockAll().catch(() => undefined);
        // 範囲が移った、などの一時的な失敗。範囲表を取り直して、同じ項目からやり直す。取り消されていれば、ここで失敗する。
        if (!isRetryable(e) || attempt++ >= BUILD_RETRIES) throw e;
        this.onRetry(e);
        await backoff(this.rt, attempt);
        cat = await this.stillBuilding(version);
        continue;
      }
      attempt = 0;
      const done = new Set(batch.map((e) => e.k));
      left = left.filter((e) => !done.has(e.k));
    }
    return at;
  }

  private nextTxnId(): string {
    // UUID を丸ごと使う。anchor は同じ ID の記録があればその決着を返すので、ID が衝突すると、
    // 後の取引は何も書かずに「確定」と応答される。先頭 8 桁 (32 bit) では、負荷があれば 1 時間に何度か衝突する。
    return `${this.opts.idPrefix ?? "t"}-${this.rt.uuid()}-${this.seq++}`;
  }

  get rowBudget(): number {
    return this.opts.limits?.rows ?? ROW_BUDGET;
  }
  get byteBudget(): number {
    return this.opts.limits?.bytes ?? BYTE_BUDGET;
  }
  get writeSetBudget(): number {
    return this.opts.limits?.writeSetBytes ?? MAX_WRITE_SET_BYTES;
  }

  /** シャードを呼ぶ。呼んだ先は文の記録のために覚える。 */
  shardOf(id: string): ReturnType<Cluster["shard"]> {
    this.touched.add(id);
    return this.cluster.shard(id);
  }

  private report(sql: string, t0: number, info: { plan: string; attempts: number }, r: QueryResult | null, e?: unknown): void {
    this.opts.onStatement?.({
      sql, ms: this.rt.now() - t0, plan: info.plan, shards: this.touched.size,
      rows: r?.values.length ?? 0, changes: r?.changes ?? 0, attempts: info.attempts,
      ...(e === undefined ? {} : { error: (e as Error)?.message ?? String(e) }),
    });
  }

  /** リトライしない取引を開始する。commit の失敗は呼び出し側に見える。 */
  async begin(): Promise<Txn> {
    return new Txn(this, await this.catalog(), this.nextTxnId());
  }

  /**
   * fn を 1 取引として実行する。競合は jitter 付きでリトライするので fn は再実行に耐える必要がある。
   * 表が書き込み禁止なら (index を作っている最中)、表定義が変わるのを待ってやり直す。
   */
  async transaction<T>(fn: (tx: Txn) => Promise<T>): Promise<T> {
    const retries = this.opts.retries ?? 12;
    let refreshed = false;
    const observed = this.opts.onStatement && !this.inStatement;
    const t0 = this.rt.now();
    if (observed) this.touched.clear();
    for (let attempt = 0; ; attempt++) {
      const cat = await this.catalog();
      const tx = new Txn(this, cat, this.nextTxnId());
      const done = (e?: unknown) => {
        if (observed) this.report(`BEGIN; ${tx.sqls.join("; ")}; COMMIT`, t0, { plan: "transaction", attempts: attempt + 1 }, null, e);
      };
      try {
        const out = await fn(tx);
        await tx.commit();
        done();
        return out;
      } catch (e) {
        const fail = (): never => {
          done(e);
          throw e;
        };
        // 別の isolate の DDL を知らないだけかもしれないので、表定義を取り直して 1 度だけやり直す。
        if (!refreshed && UNKNOWN_SCHEMA.test((e as Error)?.message ?? "")) {
          refreshed = true;
          this.cached = null;
          continue;
        }
        if (!isRetryable(e) || attempt >= retries) fail();
        this.onRetry(e);
        // 表定義の変更が、表への書き込みを止めている。終わるのを待つ。
        if (isTableLocked(e) && !(await this.schemaMovedPast(cat.version))) fail();
        await backoff(this.rt, attempt);
      }
    }
  }

  /**
   * 文の並びを実行する (D1 の batch)。表定義を変える文を含まなければ、全部を 1 つの取引で実行する。競合したら丸ごとやり直す。
   * 含むと、その位置で区切る。区切りごとに 1 つの取引で実行し、表定義を変える文は区切りの間で実行する。取引の中の DDL と同じ規則である
   * (Db.ddl、specs/m13_txn_schema_boundary.qnt)。競合でやり直すのは、断られた区切りだけである。
   * 途中で失敗したら、そこで止めて誤りを返す。それより前の区切りと DDL は、もう効いている。
   */
  async batch(statements: { sql: string; params?: Params }[]): Promise<QueryResult[]> {
    const out: QueryResult[] = [];
    let part: { sql: string; params: Params }[] = [];
    // 前の区切りで読んだ範囲。読んだ表を DROP するときに確かめる (Db.guardedDrop)。
    const reads: ReadRecord[] = [];
    const flush = async () => {
      if (part.length === 0) return;
      const run = part;
      part = [];
      let done: Txn | undefined;
      out.push(...(await this.transaction(async (tx) => {
        done = tx;
        const results: QueryResult[] = [];
        for (const s of run) results.push(await tx.query(s.sql, s.params));
        return results;
      })));
      reads.push(...done!.readRecord());
    };
    for (const s of statements) {
      if (!changesSchema(s.sql)) {
        part.push({ sql: s.sql, params: s.params ?? [] });
        continue;
      }
      await flush();
      // 1 文の DDL は、読んだ範囲を渡して実行する。複数の文を含むものは、1 文ずつ取引の外で実行する。
      const one = SHARD_KEY_TABLE.test(s.sql) || parseStatements(s.sql).length === 1;
      if (one && !this.current) {
        await this.ddl(s.sql, reads);
        out.push(new QueryResult([], []));
      } else out.push(await this.query(s.sql, s.params ?? []));
    }
    await flush();
    return out;
  }

  /**
   * 表定義の変更が終わる (版が進む) のを待つ。待ち切れなければ false を返す。
   * index を作っている間、シャードはその表への書き込みを断る。作る作業には期限があるので、待てば必ず版が進む。
   */
  private async schemaMovedPast(version: number): Promise<boolean> {
    const deadline = this.rt.now() + (this.opts.schemaWaitMs ?? SCHEMA_WAIT_MS);
    for (let i = 0; ; i++) {
      this.cached = null;
      if ((await this.catalog()).version !== version) return true;
      if (this.rt.now() >= deadline) return false;
      await sleep(this.rt, Math.min(1000, 10 * 2 ** i));
    }
  }

  get inTransaction(): boolean {
    return this.current !== null;
  }

  /** 実行中の取引を捨てる。サーバには何も残っていないので、呼び出すだけでよい。 */
  abandon(): void {
    this.current = null;
  }

  /** 接続の状態を書き出す。 */
  dump(): { token: Ts; tx: TxnDump | null } {
    return { token: this.token, tx: this.current?.dump() ?? null };
  }

  async restore(d: { token: Ts; tx: TxnDump | null }): Promise<void> {
    this.token = cleanToken(d.token);
    if (!d.tx) {
      this.current = null;
      return;
    }
    let cat = await this.catalog();
    // この接続の持つ表定義が、取引のものより古い。取り直す。
    if (cat.version < d.tx.schema) {
      this.cached = null;
      cat = await this.catalog();
    }
    this.current = Txn.load(this, cat, d.tx);
  }

  /** 文を実行する。`;` で区切った複数の文を渡すと順に実行し、最後の結果を返す。 */
  async query(sql: string, params: Params = []): Promise<QueryResult> {
    // SHARD KEY はこの DB の拡張で、パーサは読めない。DDL の解釈に直接渡す。
    if (SHARD_KEY_TABLE.test(sql)) {
      await this.ddl(sql);
      return new QueryResult([], []);
    }
    let last = new QueryResult([], []);
    for (const stmt of parseStatements(sql)) last = await this.statement(stmt, params);
    return last;
  }

  private async statement(stmt: Node, params: Params): Promise<QueryResult> {
    if (!this.opts.onStatement) return this.attemptStatement(stmt, params, { plan: "", attempts: 0 });
    const info = { plan: "", attempts: 0 };
    const t0 = this.rt.now();
    this.touched.clear();
    this.inStatement = true;
    try {
      const r = await this.attemptStatement(stmt, params, info);
      this.report(text(stmt), t0, info, r);
      return r;
    } catch (e) {
      this.report(text(stmt), t0, info, null, e);
      throw e;
    } finally {
      this.inStatement = false;
    }
  }

  private async attemptStatement(stmt: Node, params: Params, info: { plan: string; attempts: number }): Promise<QueryResult> {
    const retries = this.opts.retries ?? 12;
    const source = text(stmt);
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      info.attempts = attempt + 1;
      // 取引の中の文は、取引の表定義で計画する (Txn.catalog)。
      const txn = this.current;
      const cat = txn?.catalog ?? (await this.catalog());
      // 失敗した文の採番を戻す。SQLite でも失敗した INSERT は rowid を消費しない。
      const saved = new Map([...this.ids].map(([k, v]) => [k, { ...v }]));
      try {
        const fresh = attempt === 0 ? stmt : parseStatements(source)[0];
        const ctx = this.current ? this.current.planContext() : this.planContext(cat);
        return await runPlanned(fresh, source, params, cat, ctx, async (p) => {
          // 計画の途中で表を読む文は、読みと書き込みを 1 つの取引にする。
          if (p.kind === "inTxn") {
            let at: (() => Ts | undefined) | undefined;
            const r = await this.transaction(async (tx) => {
              at = () => tx.commitTs ?? tx.T;
              return tx.statement(parseStatements(source)[0], params);
            });
            return new QueryResult(r.columns, r.values, r.changes, r.lastInsertRowid, r.ts ?? at?.());
          }
          return this.dispatch(p, cat);
        }, (p) => (info.plan = p.kind));
      } catch (e) {
        for (const [k, v] of saved) if (this.ids.get(k)?.end === v.end) this.ids.get(k)!.next = v.next;
        // 文が取引を終えたか、別の取引に替えた (取引の中の DDL)。前の取引の分は、もう確定したか、失われた。やり直さない。
        // やり直すと、取引の外の文として、DDL だけが効く (specs/m13_txn_schema_boundary.qnt の m13_red_ddl_anyway)。
        if (txn && this.current !== txn) {
          if (isRetryable(e)) this.onRetry(e);
          throw e;
        }
        // 別の接続の DDL を知らないだけかもしれないので、表定義を取り直して 1 度だけやり直す。
        // 取引の中では、まだ何も読み書きしていないときだけである。読み書きした取引の表定義は変えない (Txn.catalog)。
        // その取引から新しい表が見えないのは、SQLite で、読み始めた取引から、後で作られた表が見えないのと同じである。
        if (!refreshed && UNKNOWN_SCHEMA.test((e as Error)?.message ?? "") && (!this.current || this.current.untouched)) {
          refreshed = true;
          this.cached = null;
          this.current?.rebase(await this.catalog());
          continue;
        }
        // 取引の最初の文なら何も読んでいないので、表定義を取り直してやり直せる。
        if (this.current?.untouched && /stale schema/.test((e as Error)?.message ?? "") && attempt < retries) {
          this.cached = null;
          this.current.rebase(await this.catalog());
          continue;
        }
        // 表定義の変更が、表への書き込みを止めている (index を作っている最中、DROP の前)。終わるのを待って、新しい表定義で計画し直す。
        // 待つのは 1 度だけである (SCHEMA_WAIT_MS)。待ち切れなければ、やり直さずに誤りを返す。やり直すと、そのたびに待つ。
        // 読むか書くかした取引は表定義を取り替えられないので、待たずに誤りを返す。
        if (isTableLocked(e)) {
          if ((!this.current || this.current.untouched) && stmt.type !== "commit_transaction_stmt" && (await this.schemaMovedPast(cat.version))) {
            this.current?.rebase(await this.catalog());
            continue;
          }
          this.onRetry(e);
          throw e;
        }
        // COMMIT は取引を閉じた後で失敗するので再実行できない。競合は呼び出し側に見せる。
        if (this.current || stmt.type === "commit_transaction_stmt" || !isRetryable(e) || attempt >= retries) {
          // 取引の中の文はやり直さないが、古い範囲表は捨てておく。捨てないと、利用者が取引をやり直しても、
          // 同じ接続では同じ「not owner」が続く。
          if (isRetryable(e)) this.onRetry(e);
          throw e;
        }
        this.onRetry(e);
        await backoff(this.rt, attempt);
      }
    }
  }

  private async dispatch(p: Plan, cat: Catalog): Promise<QueryResult> {
    if (p.kind === "tcl") return this.control(p);
    if (p.kind === "noop") return new QueryResult([], []);
    if (p.kind === "ddl") {
      await this.ddl(p.sql);
      return new QueryResult([], []);
    }
    if (this.current) return this.current.execute(p);
    if (p.kind === "shard" || p.kind === "gather" || p.kind === "partial" || p.kind === "meta") {
      const scope = new ReadScope(this, cat);
      const r = await scope.read(p);
      return new QueryResult(r.columns, r.values, 0, null, scope.T);
    }
    const t = p.kind === "write" ? p.targets[0] : undefined;
    const fast = p.kind === "write" && p.targets.length === 1 && p.def.globalIndexes.length === 0
      && t!.route.by === "sk" && t!.route.sks.length === 1;
    if (fast) return this.autoWrite(p, t!, cat);
    // 取引として実行した autocommit の文にも、確定の時刻を付けて返す。読みだけなら、読んだ時刻である。
    let at: (() => Ts | undefined) | undefined;
    const r = await this.transaction(async (tx) => {
      const out = await tx.execute(p);
      at = () => tx.commitTs ?? tx.T;
      return out;
    });
    return new QueryResult(r.columns, r.values, r.changes, r.lastInsertRowid, r.ts ?? at?.());
  }

  private async control(p: Extract<Plan, { kind: "tcl" }>): Promise<QueryResult> {
    const empty = new QueryResult([], []);
    switch (p.op) {
      case "begin":
        if (this.current) throw new SqlError("cannot start a transaction within a transaction");
        this.current = await this.begin();
        this.current.pessimistic = true; // 書き込みは文の時点でロックを取るので、COMMIT はほぼ失敗しない
        this.current.lockReads = p.immediate === true;
        return empty;
      case "commit": {
        if (!this.current) throw new SqlError("cannot commit - no transaction is active");
        const tx = this.current;
        this.current = null;
        try {
          await tx.commit();
        } catch (e) {
          await tx.unlockAll(); // 取引は終わったので、他のシャードのロックも手放す
          throw e;
        }
        return empty;
      }
      case "rollback": {
        if (!this.current) throw new SqlError("cannot rollback - no transaction is active");
        const tx = this.current;
        this.current = null;
        await tx.unlockAll();
        return empty;
      }
      case "savepoint":
        this.current ??= await this.begin();
        this.current.savepoint(p.name!);
        return empty;
      case "release":
        if (!this.current) throw new SqlError(`no such savepoint: ${p.name}`);
        this.current.release(p.name!);
        return empty;
      case "rollbackTo":
        if (!this.current) throw new SqlError(`no such savepoint: ${p.name}`);
        this.current.rollbackTo(p.name!);
        return empty;
    }
  }

  private async autoWrite(p: Extract<Plan, { kind: "write" }>, t: WriteTarget, cat: Catalog): Promise<QueryResult> {
    const sk = (t.route as { sks: string[] }).sks[0]!;
    const table = p.def.name;
    // サブクエリが読む表も span に入れる。入れないと、その表の確定済みで適用待ちの書き込みを待たずに実行してしまう。
    const tables = p.tables ?? [p.def];
    const spans = statementSpans({ tables: await this.tablesOf(t.sql, cat, p.tables ?? [p.def], true), sks: [sk], pk: t.pk, write: true, uniqueReads: t.uniqueReads });
    const res = await this.shardOf(ownerOf(cat.routing, sk)).execAuto({
      sql: t.sql, params: t.params, spans, write: t.write, schema: cat.version, minTs: this.token,
    });
    this.observe(res.hlc);
    return new QueryResult(res.columns, res.values, res.count ?? res.changes.length, p.lastRowid, res.T);
  }
}
