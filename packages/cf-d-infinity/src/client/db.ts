import type {
  Change, CommitRes, ExecReq, ExecRes, GlobalIndexDef, LockOwner, Row, ShardApi, Span, TableDef, Ts, Value,
} from "../types";
import { ConflictError, MAX_WRITE_SET_BYTES, ReadTooOld, SqlError, isWideSpan, utf8Length } from "../types";
import { CAPTURE_TABLES, capturedChanges, captureDdl, decode, encode, encodeKey, fold, q, selectList } from "../shard/rows";
import type { Catalog } from "../meta";
import { hashKey, ownerOf, rangesOf, shardsOf, type Routing } from "../routing";
import { parseStatements, text, type Node, type Params } from "../sql/cst";
import { findTable, fullScan, planStatement, type Plan, type PlanContext, type Route, type Scan, type WriteTarget } from "../sql/plan";
import { parseDdl } from "../sql/ddl";
import { openScratch, ScratchDb } from "../sql/scratch";
import { groupSpan, rowSpan, scanSpans, statementSpans, tableSpan } from "./spans";

export interface Cluster {
  shard(id: string): ShardApi;
  catalog(): Promise<Catalog>;
  /** basedOn は呼び出し側が全シャードへ適用し終えた版。現在の版と違えば `schema moved` で断られる。 */
  applyDdl(sql: string, basedOn?: number): Promise<Catalog>;
  publishIndex(table: string, name: string, basedOn?: number): Promise<Catalog>;
  allocate(table: string, n: number, min?: number): Promise<number>;
  switchRange(move: { start: number; end: number; to: string; from?: string }): Promise<Routing>;
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

/** index の backfill が 1 回に読む行数と、競合や移動でやり直す回数の上限。 */
const BACKFILL_PAGE = 50;
const BACKFILL_RETRIES = 200;

/** 表定義が古いと出る誤り。取り直すと解けることがある。 */
const UNKNOWN_SCHEMA = /^(no such (table|column|index)|table \S+ has no column)/;

/**
 * 文が、制約の衝突を自分で解決する形か (OR IGNORE、OR REPLACE、REPLACE、ON CONFLICT)。
 * シャードの中の衝突は SQLite が解決する。行が別のシャードにある衝突 (シャードをまたぐ UNIQUE、集めなかった行の主キー) は、
 * ここでは解決できない。SQLite なら行を無視するか置き換える場面なので、UNIQUE 違反ではなく、対応していない文として断る。
 */
const resolvesConflicts = (sql: string): boolean => /^\s*(INSERT|UPDATE)\s+OR\s+|^\s*REPLACE\b|\bON\s+CONFLICT\b/i.test(sql);
const UNRESOLVED = (what: string): string =>
  `unsupported: this statement resolves conflicts itself (OR IGNORE, OR REPLACE or ON CONFLICT), but the conflicting row of ${what} is on another shard`;

/** 文が読む表を SQLite に尋ねた結果。キーは DDL の履歴と文の文面。null はコンパイルできなかった文。 */
const tablesSeen = new Map<string, string[]>();
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

const backoff = (attempt: number) =>
  new Promise((r) => setTimeout(r, Math.random() * Math.min(50, 2 ** attempt)));

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
    const tables = await this.db.tablesOf(p.sql, this.cat, p.tables);
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

  /** 行を集めた Worker の SQLite を開く。sql が実際に開く表は本物のプランナに尋ねて読み足す。 */
  protected async gather(planned: Scan[], sql: string): Promise<ScratchDb> {
    const w = await openScratch(this.cat);
    let total = 0;
    try {
      const have = new Set(planned.map((s) => s.table.name));
      const missing = w.tablesUsed(sql).filter((t) => !have.has(t)).flatMap((t) => {
        const def = findTable(this.cat, t);
        return def ? [fullScan(def)] : [];
      });
      const scans = [...planned, ...missing];
      const all = await Promise.all(scans.map((s) => this.resolve(s.sks ? { by: "sk", sks: s.sks } : { by: "all" })));
      await this.pickT([...new Set(all.flat().map((t) => t.shard))]);
      for (const s of scans) {
        const { columns, rows } = await this.scan(s);
        total += rows.length;
        if (total > this.db.rowBudget) {
          throw new SqlError(`query reads more than ${this.db.rowBudget} rows; narrow it or use the analytics tier`);
        }
        w.load(s.table.name, columns, rows, s.table.generated);
      }
      return w;
    } catch (e) {
      w.close();
      throw e;
    }
  }

  async read(p: Plan): Promise<QueryResult> {
    switch (p.kind) {
      case "meta": {
        const w = await this.gather([], p.sql);
        try {
          for (const t of Object.values(this.cat.triggers)) w.exec(t.sql);
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
          // 上限 500 の Worker の SQLite で、同じ文を実行し直す。
          if (p.wasm && /too many terms in compound SELECT/.test((e as Error)?.message ?? "")) return this.read(p.wasm);
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
  constructor(db: Db, cat: Catalog, private id: string) {
    super(db, cat);
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
   * 取引の外で時刻 T に読んだ範囲を、この取引が読んだものとして扱う。
   * commit の検証が T より後の変更を見つけるので、読んだ後に変わった行をもとに書くことがない。
   */
  assume(shard: string, spans: Span[], T: Ts): void {
    if (this.T !== undefined && this.T !== T) throw new SqlError("assume: the transaction already has a read timestamp");
    this.T = T;
    this.record(shard, spans);
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

  useCatalog(cat: Catalog): void {
    this.cat = cat;
  }

  /** まだ何も読み書きしていない。 */
  get untouched(): boolean {
    return this.spans.size === 0 && this.writes.size === 0;
  }

  /** 接続を跨ぐ取引のために状態を書き出す。Worker は状態を持たないので Hrana の baton に載せる。 */
  dump(): TxnDump {
    const m = (x: Map<string, Map<string, Change>>) => [...x].map(([k, v]) => [k, [...v]] as const);
    return {
      id: this.id, T: this.T, writes: m(this.writes), spans: [...this.spans],
      pessimistic: this.pessimistic, lockReads: this.lockReads, lockOwner: this.lockOwner,
      saves: [...this.saves].map(([k, v]) => [k, { writes: m(v.writes), spans: [...v.spans] }] as const),
    };
  }

  static load(db: Db, cat: Catalog, d: TxnDump): Txn {
    const tx = new Txn(db, cat, d.id);
    const m = (x: TxnDump["writes"]) => new Map(x.map(([k, v]) => [k, new Map(v)] as const));
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
    const p = await planStatement(stmt, params, this.cat, this.planContext());
    return this.execute(p);
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
    const tables = await this.db.tablesOf(p.sql, this.cat, p.tables);
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
    switch (p.kind) {
      case "write": return this.atomically(() => this.write(p));
      case "wasmWrite": return this.atomically(() => this.wasmWrite(p));
      case "insertSelect": return this.atomically(() => this.insertSelect(p));
      case "noop":
        return new QueryResult([], []);
      case "ddl":
      case "ctas":
      case "tcl":
        throw new SqlError(`${p.kind} is not supported inside a transaction`);
      default: return this.read(p);
    }
  }

  private async write(p: Extract<Plan, { kind: "write" }>): Promise<QueryResult> {
    const out: { columns: string[]; values: Value[][] } = { columns: [], values: [] };
    let changes = 0;
    const one = async (t: WriteTarget, target: Target) => {
      // index 経由の UPDATE と DELETE は、文を shard key に絞らずに送る。読みと同じく、span も絞らない。
      // 絞ると、ほかの行の確定済みで適用待ちの更新が決着されず、文がその行を古い値から書き換えてしまう。
      const tables = await this.db.tablesOf(t.sql, this.cat, p.tables ?? [p.def]);
      const spans = statementSpans({ tables, sks: target.sks, pk: t.pk, write: true, uniqueReads: t.uniqueReads });
      const res = await this.dml(target.shard, { sql: t.sql, params: t.params, spans, write: t.write });
      if (res.columns.length) out.columns = res.columns;
      out.values.push(...res.values);
      changes += res.changes.length;
      for (const c of res.changes) this.buffer(target.shard, c);
      await this.indexChanges(res.changes, resolvesConflicts(t.sql));
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

  /** 行を集めて Worker の SQLite で文を実行し、捕捉した行の変更を所有シャードへ振り分ける。 */
  private async wasmWrite(p: Extract<Plan, { kind: "wasmWrite" }>): Promise<QueryResult> {
    const w = await this.gather(p.scans, p.sql);
    try {
      const catalog = (t: string) => {
        const d = findTable(this.cat, t);
        if (!d) throw new SqlError(`no such table: ${t}`);
        return d;
      };
      for (const ddl of CAPTURE_TABLES) w.exec(ddl);
      for (const d of p.tables) for (const ddl of captureDdl(d)) w.exec(ddl);
      // 利用者の trigger は行を読み込んだ後に作る。先に作ると読み込みで発火する。
      for (const t of Object.values(this.cat.triggers)) w.exec(t.sql);
      w.exec(`PRAGMA recursive_triggers = ON`);
      w.exec(`INSERT INTO __cap_on VALUES (1)`);
      const r = w.raw(p.sql, ...p.params);
      const last = w.raw(`SELECT last_insert_rowid()`).values[0]?.[0] as number;
      const changes = capturedChanges(w, catalog);
      const soft = resolvesConflicts(p.sql);
      for (const c of changes) {
        if (c.before === null) await this.assertAbsent(catalog(c.table), c, soft);
        this.buffer(ownerOf(this.cat.routing, c.sk), c);
        const def = catalog(c.table);
        const id = def.rowidAlias ? c.after?.[def.rowidAlias] : def.implicitRowid ? c.after?.rowid : undefined;
        if (typeof id === "number") this.db.planContext(this.cat).sawId(def.name, id);
      }
      await this.indexChanges(changes, soft);
      const target = changes.filter((c) => c.table === p.tables[0]?.name).length;
      return new QueryResult(r.columns, r.values, target, last || null);
    } finally {
      w.close();
    }
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

  /** グローバル index を同じ取引の参加者として更新する。 */
  private async indexChanges(changes: Change[], soft = false): Promise<void> {
    for (const c of changes) {
      const def = this.cat.tables[c.table];
      for (const ix of def?.globalIndexes ?? []) {
        const keyOf = (r: Row | null): string | null => {
          if (!r) return null;
          const vals = ix.columns.map((col) => fold(r[col] ?? null, def!.collation[col]));
          return vals.some((v) => v === null) ? null : encode(vals);
        };
        const oldK = keyOf(c.before);
        const newK = keyOf(c.after);
        if (oldK === newK) continue;
        if (oldK !== null) this.indexWrite(ix, { k: oldK, pk: c.pk, sk: c.sk }, true);
        if (newK !== null) {
          if (ix.unique) await this.assertUnique(def!, ix, newK, c.pk, soft);
          this.indexWrite(ix, { k: newK, pk: c.pk, sk: c.sk }, false);
        }
      }
    }
  }

  /** 新しい主キーが既存の行と衝突しないかを確かめる。押し下げで集めなかった行とは Worker の SQLite では比べられない。 */
  private async assertAbsent(def: TableDef, c: Change, soft = false): Promise<void> {
    const where = def.pk.map((k) => `${q(k)} IS ?`).join(" AND ");
    const res = await this.call(ownerOf(this.cat.routing, c.sk), {
      sql: `SELECT 1 FROM ${q(def.name)} WHERE ${where}`, params: decode<Value[]>(c.pk),
      spans: [rowSpan(def.name, c.pk, c.sk)],
    });
    if (res.values.length) throw new SqlError(soft ? UNRESOLVED(`the primary key of ${def.name}`) : `UNIQUE constraint failed: ${def.name}.${def.pk.join(", ")}`);
  }

  /** SQLite と同じく文の時点で検査する。commit の検証だけだと、文が成功した後で COMMIT が失敗する。 */
  async assertUnique(def: TableDef, ix: GlobalIndexDef, k: string, pk: string, soft = false): Promise<void> {
    const sk = encode([k]);
    const res = await this.call(ownerOf(this.cat.routing, sk), {
      sql: `SELECT "pk" FROM ${q(ix.table)} WHERE "k" = ?`, params: [k],
      spans: [rowSpan(ix.table, encode([k]), sk)],
    });
    if (res.values.some((r) => r[0] !== pk)) {
      throw new SqlError(soft ? UNRESOLVED(`UNIQUE (${ix.columns.join(", ")}) of ${def.name}`) : `UNIQUE constraint failed: ${def.name}.${ix.columns.join(", ")}`);
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
  constructor(
    readonly cluster: Cluster,
    private opts: {
      retries?: number; idPrefix?: string; token?: Ts; catalog?: Catalog; idBlock?: number;
      /** DDL が、進行中のシャードの増設が終わるのを待つ時間 (ms)。既定は 60 秒。 */
      splitWaitMs?: number;
      /** 取り直した表定義を呼び出し側のキャッシュへ戻す。 */
      onCatalog?: (c: Catalog) => void;
      /** 採番のブロック。要求ごとに Db を作る環境では共有しないと番号が大きく飛ぶ。 */
      ids?: Map<string, { next: number; end: number }>;
      /** 上限の上書き。試験と、上限を下げたい利用者のためにある。既定は ROW_BUDGET、BYTE_BUDGET、MAX_WRITE_SET_BYTES。 */
      limits?: { rows?: number; bytes?: number; writeSetBytes?: number };
      /** 文が終わるたびに呼ぶ。失敗した文でも呼ぶ。 */
      onStatement?: (s: StatementStat) => void;
    } = {},
  ) {
    this.token = cleanToken(opts.token);
    this.cached = opts.catalog ?? null;
    this.ids = opts.ids ?? new Map();
  }

  observe(ts: Ts): void {
    this.token = Math.max(this.token, ts);
  }

  /** ロックの優先順位に使う開始時刻。古い取引が勝つ。 */
  startStamp(): Ts {
    return Date.now();
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
   * 文が読む表を、SQLite のコンパイル結果で確かめる。構文から拾った表のほかに SQLite が開く表があれば、文を断る。
   * 手書きの解析は、サブクエリや `x IN 表` などの参照を見落とし得る。見落とした表は、経路の判断にも範囲にも入っていない。
   * コンパイルできない文は断る。Worker の SQLite には利用者の表しかないので、内部の表を名指す文もここで落ちる。
   * 結果は文の文面と表定義の版ごとに覚えておく。同じ文の 2 回目からは、Worker の SQLite を開かない。
   */
  async tablesOf(sql: string, cat: Catalog, known: TableDef[]): Promise<TableDef[]> {
    const key = `${historyKey(cat)}\0${sql}`;
    let names = tablesSeen.get(key);
    if (names === undefined) {
      const w = await openScratch(cat);
      try {
        names = w.tablesUsed(sql);
      } catch (e) {
        // Worker の SQLite には利用者の表と view しかない。ここでコンパイルできない文は、内部の表を名指ししているか、
        // SQLite が受け付けない文である。シャードへ送らずに断る。
        throw new SqlError((e as Error)?.message ?? String(e));
      } finally {
        w.close();
      }
      if (tablesSeen.size >= 2000) tablesSeen.delete(tablesSeen.keys().next().value!);
      tablesSeen.set(key, names);
    }
    // プランナが知らない表を、SQLite が開くと答えた。プランナは、知っている表についてだけ「この文が読む行は、送り先の
    // シャードにある」と確かめている。知らない表の行は別のシャードにもあり得るので、そのまま送ると黙って行が欠ける。
    const have = new Set(known.map((d) => d.name));
    const unknown = names.filter((n) => !have.has(n));
    if (unknown.length > 0) {
      throw new SqlError(`unsupported: the statement reads ${unknown.join(", ")} in a way the planner does not handle; rewrite it with an explicit subquery or JOIN`);
    }
    return known;
  }

  planContext(cat: Catalog): PlanContext {
    return {
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
   * 履歴は書き換えられないので、以後、行を集める文がすべて失敗する。trigger も同じ SQLite に作るので、ここで確かめる。
   */
  private async assertReplays(sql: string, cat: Catalog): Promise<void> {
    const parsed = parseDdl(sql, cat);
    const statements = [...(parsed.user ? [parsed.user] : []), ...Object.values(parsed.triggers ?? {}).map((t) => t.sql)];
    if (parsed.noop || statements.length === 0) return;
    const w = await openScratch(cat);
    try {
      for (const t of Object.values(cat.triggers)) w.exec(t.sql);
      for (const s of statements) w.exec(s);
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
    const deadline = Date.now() + (this.opts.splitWaitMs ?? SPLIT_WAIT_MS);
    for (let attempt = 0; ; attempt++) {
      const before = await this.cluster.catalog();
      const { failed, moving } = await this.syncAll(before);
      // シャードの増設の途中は、新しい版を記録しない。増設の間、親と子は DDL を適用しないので、記録すると、
      // 新しい版で計画した要求がそのシャードで通らなくなる。終わるのを待つ。
      if (moving) {
        if (Date.now() > deadline) throw new SqlError("a shard split is in progress; retry the schema change when it finishes");
        attempt = Math.min(attempt, 3);
        await new Promise((r) => setTimeout(r, 20));
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
        if (attempt < 5 && /schema moved to version/.test((e as Error)?.message ?? "")) continue;
        throw e;
      }
    }
  }

  async ddl(sql: string): Promise<void> {
    await this.checkUnique(sql);
    const { before, cat } = await this.record(async (basedOn, at) => {
      await this.assertReplays(sql, at);
      return this.cluster.applyDdl(sql, basedOn);
    });
    this.publish(cat);
    this.ids.clear();
    if (cat.version === before.version) {
      // 何も記録されなかった。同じ index を作る文の出し直しなら、前回の要求が途中で終わっているので、埋める作業を再開する。
      const name = /^\s*CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"((?:[^"]|"")+)"|([^\s(]+))/i.exec(sql);
      const wanted = name?.[1]?.replaceAll('""', '"') ?? name?.[2];
      for (const def of Object.values(cat.tables)) {
        for (const ix of def.globalIndexes) if (ix.state === "writeOnly" && ix.name === wanted) await this.backfill(def, ix);
      }
      return;
    }
    // 全シャードへ適用してから完了を返す。適用が遅れると、古い表定義の Worker がそのシャードへ書き、
    // 後から DROP が適用されて行が消える。適用後は古い要求を全シャードが拒否する。
    let { failed, moving } = await this.syncAll(cat);
    // 記録した直後に増設が始まると、そのシャードは増設が終わるまで適用しない。終われば適用するので、待つ。
    for (const deadline = Date.now() + (this.opts.splitWaitMs ?? SPLIT_WAIT_MS); failed && moving; ) {
      if (Date.now() > deadline) {
        throw new SqlError("the schema change is recorded, but a shard split is in progress; shards being split apply it when the split finishes");
      }
      await new Promise((r) => setTimeout(r, 20));
      ({ failed, moving } = await this.syncAll(cat));
    }
    if (failed) {
      // シャードの行によっては適用できない文がある (重複のある列への UNIQUE index など)。
      // そのシャードが取り消しを求めているので、取り消しを全シャードへ行き渡らせてから、理由を返す。
      const now = await this.cluster.catalog();
      if (now.revoked?.version !== cat.version) throw failed;
      this.publish(now);
      await this.syncAll(now);
      throw new SqlError(now.revoked.reason);
    }
    for (const def of Object.values(cat.tables)) {
      for (const ix of def.globalIndexes) {
        const known = before.tables[def.name]?.globalIndexes.some((g) => g.name === ix.name);
        if (ix.state === "writeOnly" && !known) await this.backfill(def, ix);
      }
    }
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
   * F1 の write-only 状態の index を既存の行で埋めて public にする。
   * 書き込みは DDL の時点から index を更新しているので、埋め終われば全行が揃う。
   */
  /**
   * 既存の行から、新しいグローバル index の項目を作る。index は書き込み専用の状態で、並行する書き込みは自分で index を保守する。
   *
   * 走査と書き込みは別々に行うので、その間に行が変わり得る。変わった行の古い値を index に書くと、行のない項目が残る。
   * そこで、走査した行を「取引が時刻 T に読んだ」ものとして扱い、commit の検証に掛ける。変わっていれば競合になり、読み直す。
   * UNIQUE は、すでにある項目と、同じ取引で書く項目の両方と照合する。
   * 増設が挟まると行が別のシャードへ移るので、範囲表が変わらなくなるまで全体を繰り返す。
   */
  private async backfill(def: TableDef, ix: GlobalIndexDef): Promise<void> {
    try {
      for (let round = 0; ; round++) {
        const cat = await this.cluster.catalog();
        this.cached = cat;
        this.opts.onCatalog?.(cat);
        let moved = false;
        // 毎回、先頭から埋める。途中経過を保存して続きから埋める作りは、別の DDL や増設と重なったときに、
        // 終わっていないシャードを飛ばして index を公開した。再開できる埋め込みは、状態を持つ駆動役を用意してから入れる。
        for (const shard of shardsOf(cat.routing)) moved = (await this.backfillShard(def, ix, shard, cat)) || moved;
        const after = await this.cluster.catalog();
        if (!moved && after.routing.version === cat.routing.version) break;
        if (round >= 20) throw new SqlError(`CREATE INDEX ${ix.name}: shards kept splitting during the backfill`);
      }
    } catch (e) {
      // Worker の 1 回の呼び出しで使える要求の数を使い切った。後始末の DROP も通らないので、index は書き込み専用のまま残る。
      if (/too many subrequests|subrequest/i.test((e as Error)?.message ?? "")) {
        throw new SqlError(`CREATE INDEX ${ix.name} did not finish: the table has too many rows to index within one request. Drop the index; a UNIQUE constraint declared in CREATE TABLE needs no backfill.`);
      }
      // 作りかけの index を消した表定義を、呼び出し側のキャッシュにも戻す。
      // 戻さないと、同じ isolate の次の要求が、消えた index を保守する計画を立てて失敗する。
      const { cat: without } = await this.record((basedOn) => this.cluster.applyDdl(`DROP INDEX IF EXISTS ${q(ix.name)}`, basedOn));
      this.publish(without);
      await this.syncAll(without);
      throw e;
    }
    const { cat } = await this.record((basedOn) => this.cluster.publishIndex(def.name, ix.name, basedOn));
    this.publish(cat);
  }

  /** 1 シャードの行を主キーの順に少しずつ読み、index の項目を書く。途中で範囲が移ったら true を返す。 */
  private async backfillShard(def: TableDef, ix: GlobalIndexDef, shard: string, cat: Catalog): Promise<boolean> {
    const pkCols = def.pk.map(q).join(", ");
    let after: Value[] | null = null;
    for (let attempt = 0; ; ) {
      let res: ExecRes;
      try {
        res = await this.shardOf(shard).exec({
          sql: `SELECT ${selectList(def)} FROM ${q(def.name)} ${after ? `WHERE (${pkCols}) > (${def.pk.map(() => "?").join(", ")})` : ""} ORDER BY ${pkCols} LIMIT ${BACKFILL_PAGE}`,
          params: after ?? [], spans: withSlots(cat.routing, shard, [tableSpan(def.name)]), schema: cat.version,
        });
      } catch (e) {
        const m = (e as Error)?.message ?? "";
        // 範囲の持ち主が変わった。呼び出し側が範囲表を取り直して、全体をやり直す。
        if (/^not owner|stale schema/.test(m)) return true;
        // 移動の途中は表全体を読めない。終わるのを待つ。
        if (/^migrating|group not arrived|read too old/.test(m) && attempt++ < BACKFILL_RETRIES) {
          await backoff(attempt);
          continue;
        }
        throw e;
      }
      if (res.error !== undefined) throw new SqlError(res.error);
      const rows = new QueryResult(res.columns, res.values).rows;
      if (rows.length === 0) return false;
      const tx = new Txn(this, cat, this.nextTxnId());
      try {
        const keys = rows.map((row) => encodeKey(def, row));
        tx.assume(shard, keys.map((key) => rowSpan(def.name, key.pk, key.sk)), res.T);
        const inBatch = new Map<string, string>();
        const entries: { k: string; pk: string; sk: string }[] = [];
        for (const [i, row] of rows.entries()) {
          const vals = ix.columns.map((col) => fold(row[col] ?? null, def.collation[col]));
          if (vals.some((v) => v === null)) continue;
          const k = encode(vals);
          const key = keys[i]!;
          if (ix.unique) {
            // 同じ取引の中の 2 件目は、バッファの上で 1 件目を上書きするだけで、シャードには届かない。ここで照合する。
            const prior = inBatch.get(k);
            if (prior !== undefined && prior !== key.pk) throw new SqlError(`UNIQUE constraint failed: ${def.name}.${ix.columns.join(", ")}`);
            inBatch.set(k, key.pk);
          }
          entries.push({ k, pk: key.pk, sk: key.sk });
        }
        // すでにある項目は、index のシャードごとに 1 回で読む。1 行ずつ読むと、行数だけ往復が要り、
        // Worker の 1 回の呼び出しで使える要求の数を、数百行の表で使い切る。
        const byShard = new Map<string, Set<string>>();
        for (const e of entries) {
          const owner = ownerOf(cat.routing, encode([e.k]));
          byShard.set(owner, (byShard.get(owner) ?? new Set()).add(e.k));
        }
        const existing = new Map<string, Set<string>>();
        for (const [owner, ks] of byShard) {
          const list = [...ks];
          const found = await tx.call(owner, {
            sql: `SELECT "k", "pk" FROM ${q(ix.table)} WHERE "k" IN (${list.map(() => "?").join(", ")})`,
            params: list,
            // 読んだ k の項目が commit までに変われば競合になる。UNIQUE では、同じ値の項目が後から入るのを防ぐ。
            spans: list.map((k) => groupSpan(ix.table, encode([k]))),
          });
          for (const [k, pk] of found.values as [string, string][]) existing.set(k, (existing.get(k) ?? new Set()).add(pk));
        }
        for (const e of entries) {
          const have = existing.get(e.k);
          if (ix.unique && have && [...have].some((pk) => pk !== e.pk)) {
            throw new SqlError(`UNIQUE constraint failed: ${def.name}.${ix.columns.join(", ")}`);
          }
          if (!have?.has(e.pk)) tx.indexWrite(ix, e, false);
        }
        await tx.commit();
      } catch (e) {
        await tx.unlockAll().catch(() => undefined);
        // index の項目を書く先のシャードが、範囲を手放していた。この取引は古い範囲表で組んであるので、
        // 同じ範囲表でやり直しても同じ誤りになる。呼び出し側に範囲表を取り直させ、全体をやり直す。
        if (/not owner/.test((e as Error)?.message ?? "")) return true;
        // 走査の後で行が変わった、などの競合。同じ位置から読み直す。
        if (!isRetryable(e) || attempt++ >= BACKFILL_RETRIES) throw e;
        this.onRetry(e);
        await backoff(attempt);
        continue;
      }
      attempt = 0;
      const last = rows[rows.length - 1]!;
      after = def.pk.map((col) => last[col] ?? null);
    }
  }

  private nextTxnId(): string {
    // UUID を丸ごと使う。anchor は同じ ID の記録があればその決着を返すので、ID が衝突すると、
    // 後の取引は何も書かずに「確定」と応答される。先頭 8 桁 (32 bit) では、負荷があれば 1 時間に何度か衝突する。
    return `${this.opts.idPrefix ?? "t"}-${crypto.randomUUID()}-${this.seq++}`;
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
      sql, ms: Date.now() - t0, plan: info.plan, shards: this.touched.size,
      rows: r?.values.length ?? 0, changes: r?.changes ?? 0, attempts: info.attempts,
      ...(e === undefined ? {} : { error: (e as Error)?.message ?? String(e) }),
    });
  }

  /** リトライしない取引を開始する。commit の失敗は呼び出し側に見える。 */
  async begin(): Promise<Txn> {
    return new Txn(this, await this.catalog(), this.nextTxnId());
  }

  /** fn を 1 取引として実行する。競合は jitter 付きでリトライするので fn は再実行に耐える必要がある。 */
  async transaction<T>(fn: (tx: Txn) => Promise<T>): Promise<T> {
    const retries = this.opts.retries ?? 12;
    let refreshed = false;
    const observed = this.opts.onStatement && !this.inStatement;
    const t0 = Date.now();
    if (observed) this.touched.clear();
    for (let attempt = 0; ; attempt++) {
      const tx = new Txn(this, await this.catalog(), this.nextTxnId());
      const done = (e?: unknown) => {
        if (observed) this.report(`BEGIN; ${tx.sqls.join("; ")}; COMMIT`, t0, { plan: "transaction", attempts: attempt + 1 }, null, e);
      };
      try {
        const out = await fn(tx);
        await tx.commit();
        done();
        return out;
      } catch (e) {
        if (!(!refreshed && UNKNOWN_SCHEMA.test((e as Error)?.message ?? "")) && (!isRetryable(e) || attempt >= retries)) done(e);
        // 別の isolate の DDL を知らないだけかもしれないので、表定義を取り直して 1 度だけやり直す。
        if (!refreshed && UNKNOWN_SCHEMA.test((e as Error)?.message ?? "")) {
          refreshed = true;
          this.cached = null;
          continue;
        }
        if (!isRetryable(e) || attempt >= retries) throw e;
        this.onRetry(e);
        await backoff(attempt);
      }
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
    this.current = d.tx ? Txn.load(this, await this.catalog(), d.tx) : null;
  }

  /** 文を実行する。`;` で区切った複数の文を渡すと順に実行し、最後の結果を返す。 */
  async query(sql: string, params: Params = []): Promise<QueryResult> {
    // SHARD KEY はこの DB の拡張で、パーサは読めない。DDL の解釈に直接渡す。
    if (/^\s*CREATE\s+TABLE\b[\s\S]*\bSHARD\s+KEY\s*\(/i.test(sql)) {
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
    const t0 = Date.now();
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
      const cat = await this.catalog();
      // 失敗した文の採番を戻す。SQLite でも失敗した INSERT は rowid を消費しない。
      const saved = new Map([...this.ids].map(([k, v]) => [k, { ...v }]));
      try {
        const fresh = attempt === 0 ? stmt : parseStatements(source)[0];
        const p = await planStatement(fresh, params, cat, this.current ? this.current.planContext() : this.planContext(cat));
        info.plan = p.kind;
        // 計画の途中で表を読む文は、読みと書き込みを 1 つの取引にする。
        if (p.kind === "inTxn") {
          let at: (() => Ts | undefined) | undefined;
          const r = await this.transaction(async (tx) => {
            at = () => tx.commitTs ?? tx.T;
            return tx.statement(parseStatements(source)[0], params);
          });
          return new QueryResult(r.columns, r.values, r.changes, r.lastInsertRowid, r.ts ?? at?.());
        }
        return await this.dispatch(p, cat);
      } catch (e) {
        for (const [k, v] of saved) if (this.ids.get(k)?.end === v.end) this.ids.get(k)!.next = v.next;
        // 別の接続の DDL を知らないだけかもしれないので、表定義を取り直して 1 度だけやり直す。
        if (!refreshed && UNKNOWN_SCHEMA.test((e as Error)?.message ?? "")) {
          refreshed = true;
          this.cached = null;
          this.current?.useCatalog(await this.catalog());
          continue;
        }
        // 取引の最初の文なら何も読んでいないので、表定義を取り直してやり直せる。
        if (this.current?.untouched && /stale schema/.test((e as Error)?.message ?? "") && attempt < retries) {
          this.cached = null;
          this.current.useCatalog(await this.catalog());
          continue;
        }
        // COMMIT は取引を閉じた後で失敗するので再実行できない。競合は呼び出し側に見せる。
        if (this.current || stmt.type === "commit_transaction_stmt" || !isRetryable(e) || attempt >= retries) {
          // 取引の中の文はやり直さないが、古い範囲表は捨てておく。捨てないと、利用者が取引をやり直しても、
          // 同じ接続では同じ「not owner」が続く。
          if (isRetryable(e)) this.onRetry(e);
          throw e;
        }
        this.onRetry(e);
        await backoff(attempt);
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
    if (p.kind === "ctas") return this.createAs(p, cat);
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

  /** CREATE TABLE ... AS SELECT。結果の列で表を作り、行を入れる。 */
  private async createAs(p: Extract<Plan, { kind: "ctas" }>, cat: Catalog): Promise<QueryResult> {
    if (findTable(cat, p.name)) {
      if (p.ifNotExists) return new QueryResult([], []);
      throw new SqlError(`table ${p.name} already exists`);
    }
    const src = await new ReadScope(this, cat).read(p.select);
    await this.ddl(`CREATE TABLE ${q(p.name)} (${src.columns.map(q).join(", ")})`);
    // 行はまとめて入れる。1 行ずつ入れると、行数だけ往復が要り、Worker の 1 回の呼び出しで使える要求の数を超える。
    // 途中で失敗したら表ごと消す。SQLite でも、失敗した CREATE TABLE AS は表を残さない。
    try {
      const tuple = `(${src.columns.map(() => "?").join(", ")})`;
      for (let at = 0; at < src.values.length; ) {
        const batch: Value[][] = [];
        for (let bytes = 0; at < src.values.length && batch.length < 200 && (batch.length === 0 || bytes < 100_000); at++) {
          batch.push(src.values[at]!);
          bytes += utf8Length(encode(src.values[at]!));
        }
        await this.query(`INSERT INTO ${q(p.name)} VALUES ${batch.map(() => tuple).join(", ")}`, batch.flat());
      }
    } catch (e) {
      await this.ddl(`DROP TABLE IF EXISTS ${q(p.name)}`).catch(() => undefined);
      throw e;
    }
    return new QueryResult([], []);
  }

  private async autoWrite(p: Extract<Plan, { kind: "write" }>, t: WriteTarget, cat: Catalog): Promise<QueryResult> {
    const sk = (t.route as { sks: string[] }).sks[0]!;
    const table = p.def.name;
    // サブクエリが読む表も span に入れる。入れないと、その表の確定済みで適用待ちの書き込みを待たずに実行してしまう。
    const tables = p.tables ?? [p.def];
    const spans = statementSpans({ tables: await this.tablesOf(t.sql, cat, p.tables ?? [p.def]), sks: [sk], pk: t.pk, write: true, uniqueReads: t.uniqueReads });
    const res = await this.shardOf(ownerOf(cat.routing, sk)).execAuto({
      sql: t.sql, params: t.params, spans, write: t.write, schema: cat.version, minTs: this.token,
    });
    this.observe(res.hlc);
    return new QueryResult(res.columns, res.values, res.changes.length, p.lastRowid, res.T);
  }
}
