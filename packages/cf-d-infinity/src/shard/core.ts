import { Hlc, SECOND, physicalToTs, tsToPhysical } from "../hlc";
import { SHARD_LIMITS, ShardLimit, shardLimitOf, withinShardLimits } from "../shard-limits";
import type {
  Backend, Change, Clock, CommitReq, CommitRes, ExecReq, ExecRes, Faults, FlushRes, GroupCursor, GroupPayload, LockOwner, MetaApi,
  Participant, PrepareReq, PrepareRes, Row, ShardApi, ShardHealth, ShardMetrics, Span, TableDef, Ts, TxnStatus, Value,
} from "../types";
import {
  ConflictError, MAX_WRITE_SET_BYTES, Migrating, NotOwner, ReadTooOld, STORAGE_FORMAT, SqlError, TableLocked, checkStorageFormat, isWideSpan, spanCovers, utf8Length,
  unprotectedSpans,
} from "../types";
import type { DdlEntry } from "../meta";
import { slotOf } from "../routing";
import { keyString } from "../keys";
import { type Runtime, sleep, systemRuntime } from "../runtime";
import {
  CAPTURE_TABLES, applyChanges, asSqlError, assertKeyed, capturedChanges, decode, deleteRow, encode, encodeKey, insertRow, q,
  rowwiseRestore, selectGroup, selectList, selectRow, setBasedRestore, imageList, typedRow, typedValues,
} from "./rows";

export interface ShardDeps {
  id: string;
  backend: Backend;
  clock: Clock;
  peer(id: string): ShardApi;
  meta: Pick<MetaApi, never> & {
    ddlSince(v: number): Promise<{ version: number; ddl: DdlEntry[] }>;
    /** 適用できなかった版の取り消しを求める。取り消す版の番号か、取り消せなければ null が返る。 */
    revokeDdl(version: number, reason: string): Promise<number | null>;
    /** 分割の枠を示して、子が受け取り始める。分割の版が返る (meta.ts の startSplit)。 */
    startSplit(id: string, move: { parent: string; child: string; start: number; end: number }): Promise<{ version: number }>;
    /** 分割の枠が生きていて、子が受け取り始めていることを確かめる (meta.ts の checkSplit)。 */
    checkSplit(id: string, move: { parent: string; child: string; start: number; end: number }): Promise<void>;
  };
  /** 実時間、待ち、乱数の出どころ。指定しなければ実物を使う。シミュレータは seed から決まる実装を渡す。 */
  runtime?: Runtime;
  /** 応答後も続ける処理。DO では ctx.waitUntil に渡す。 */
  background?(p: Promise<unknown>): void;
  /** phase 2 の再駆動を予約する。DO では storage.setAlarm に渡す。 */
  scheduleRedrive?(): void;
  K?: number;
  faults?: Faults;
  /** ロックの TTL。既定は LOCK_TTL_MS である。 */
  lockTtlMs?: number;
  /** 変更ログを残す時間。これより古い T の取引と過去読みは ReadTooOld になる。 */
  logRetainMs?: number;
  /** 変更ログの世代の表 1 つが受け持つ時間。 */
  logGenMs?: number;
  /** 決着済みの取引記録を残す時間。 */
  txnRetainMs?: number;
  /** 直近の書き込みの索引に持つ項目の上限。超えたら索引を捨てて、それより前から続く検証を失敗させる。 */
  recentMax?: number;
  /**
   * 試験用の検査。文が、宣言した範囲 (span) の外の行に依存していたら呼ばれる。
   * 指定すると、文ごとに、範囲の外の行を消した状態でも同じ結果になるかを確かめる。本番では指定しない。
   */
  spanEscape?: (e: SpanEscape) => void;
}

/** 文の結果が、宣言した範囲の外の行に依存していた。範囲の外の行は決着も検証もされないので、取引の検証が成り立たない。 */
export interface SpanEscape {
  shard: string;
  sql: string;
  params: Value[];
  spans: Span[];
  /** 全部の行がある状態での結果と、範囲の外の行を消した状態での結果。 */
  full: string;
  narrowed: string;
}

/** 範囲の検査をする行数の上限。全行を読んで消すので、大きな表を使う試験では検査を省く。 */
const SPAN_CHECK_MAX_ROWS = 3000;

/** 受け取る時刻が、このシャードの時計よりこれ以上先なら断る。DO の間の時計のずれと、再起動後の先取り (1 秒) より十分に大きい。 */
export const MAX_CLOCK_AHEAD_MS = 10 * 60_000;

/** TiDB の既定の GC 窓 (10 分) に合わせる。 */
export const LOG_RETAIN_MS = 10 * 60_000;
export const LOG_GEN_MS = 2 * 60_000;
export const TXN_RETAIN_MS = 60 * 60_000;
/** この時間を過ぎた intent は、anchor に問い合わせて決着させる。 */
export const ORPHAN_AGE_MS = 2000;
/**
 * 1 回の要求でシャードが返す結果の上限。要求が小さい値を指定すればそちらが効く。
 * 上限がないと、絞り込みのない SELECT が全行を送り返し、シャードと Worker の両方がメモリを使い切る。
 * バイト数は DO の RPC の上限 (32 MiB) より十分小さくしてある。
 */
/** 移動できる 1 グループ (同じ shard key の行の集まり) の大きさの上限。分割転送がないので、これより大きいと移動が終わらない。 */
export const GROUP_MAX_BYTES = 16_000_000;
export const SHARD_MAX_ROWS = 200_000;
export const SHARD_MAX_BYTES = SHARD_LIMITS.resultBytes;
/** 値のおおよその大きさ (バイト)。上限の判定に使うだけで、正確である必要はない。 */
const sizeOf = (v: Value): number =>
  typeof v === "string" ? v.length * 2 : v instanceof Uint8Array ? v.byteLength : 8;

interface Intent {
  tbl: string; pk: string; sk: string; txn: string; anchor: string; prepare_ts: Ts; change: string;
}
interface InFlight {
  pushed: Ts;
  decided: boolean;
  settled: Promise<void>;
  settle(): void;
}

interface FencedRange { start: number; end: number; to: string; done: number }
interface IncomingRange { start: number; end: number; from_id: string }

const ROLLBACK = Symbol("rollback");
const FALLBACK = Symbol("fallback");
const BLOCKED = Symbol("blocked");
const PENDING_UNIQUE = Symbol("pending unique");
/** 述語の検証で読む commit の上限。超えたら競合とみなす。 */
const PRED_WINDOW = 2000;
/** ロックの TTL。Worker の死亡に備える。文を実行するたびに延ばす。 */
const LOCK_TTL_MS = 5000;
/** 読みが、1 つの取引の intent を決着させようとする回数の上限。間で待つので、合わせて 1 秒ほど待つ。 */
const SETTLE_TRIES = 10;
/** ロックを待つ時間の上限。SQLite の busy_timeout に相当する。 */
const LOCK_WAIT_MS = 5000;
/**
 * 古い取引が保持者からロックを奪うまで待つ時間。
 * 保持者は多くの場合すぐ終わるので、すぐ奪うと無駄な abort を増やす。
 * 奪う時期を遅らせても閉路はいずれ解ける。ロックはいつ消えてもよいので安全性は変わらない。
 */
const WOUND_DELAY_MS = 200;
/** DDL の適用が、進行中の取引の決着を待つ上限。超えたら再試行できる誤りを返す。 */
const SCHEMA_WAIT_MS = 5000;

interface RowLock extends LockOwner {
  expires: number;
}
interface Waiter extends LockOwner {
  wake(): void;
}

/**
 * 待ちの後で確かめ直すこと。schema は、要求を計画した表定義の版が、いまも現行であること。owned は、読む範囲と書く行を、読む時刻で
 * このシャードが持っていること。
 */
type Check = "schema" | "owned";

/** 同期区間が頼る表定義の版。要求を計画したときの版である。 */
interface Plan {
  schema: number;
}

/** 同期区間が頼る行。読む範囲、書く行、読む時刻 (null は最新の状態) である。 */
interface Rows {
  spans: Span[];
  writes: Pick<Change, "sk">[];
  at: Ts | null;
}

/** Section を作る鍵。このファイルの外へは出さない。使うのは ShardCore.enter だけである。 */
const ENTER = Symbol("enter");

/**
 * 同期区間に入った印。ShardCore.enter が、待ちの後の確かめ直しを済ませてから作る。ほかに作る方法はない。
 *
 * 要求の文を実行する関数 (run、checked)、取引を検証する関数 (validate、changedSince)、書き込みを受け入れる関数
 * (assertWriteSetFits、prepareSync) は、この印を受け取る。確かめ直しを飛ばした入口は、印を持てないので、型の検査を通らない。
 * 型の引数は、確かめ直したことである。版を確かめ直していない印は、版に頼る関数へ渡せない。
 *
 * 印は、作った同期区間の中だけで使う。待った後は、enter をもう一度呼んで作り直す。
 */
class Section<K extends Check> {
  /** 確かめ直したこと。多く確かめた印は、少なく求める関数へ渡せる。逆は渡せない。 */
  protected readonly rechecked: { readonly [P in K]: true };
  private constructor(rechecked: { readonly [P in K]: true }) {
    this.rechecked = rechecked;
  }
  static [ENTER]<K extends Check>(rechecked: { readonly [P in K]: true }): Section<K> {
    return new Section(rechecked);
  }
}

/** シャード 1 個のプロトコル本体。DO に依存せず、Node の SQLite でも同じコードが動く。 */

/**
 * 2PC の ID (`<取引の ID>#<続きの中身の指紋>`、Txn.commit) から、行ロックの持ち主の ID を取り出す。ロックは、COMMIT の前の
 * 文が取引の ID で取るので、prepare と確定と中止は、この ID で自分のロックを見分けて手放す。
 */
export const lockIdOf = (txn: string): string => {
  const at = txn.indexOf("#");
  return at < 0 ? txn : txn.slice(0, at);
};

export class ShardCore implements ShardApi {
  readonly id: string;
  epoch = 0;
  private b: Backend;
  private hlc = new Hlc(0);
  private ceiling: Ts = 0;
  private defs = new Map<string, TableDef>();
  private schema = 0;
  /** 進行中の DDL の適用。同時に来た要求は同じ適用を待つ。 */
  private schemaChange: Promise<void> | null = null;
  /** 直近の write の索引。キーごとの最新 commit 時刻だけを持ち、検査を O(1) にする。 */
  private recent = new Map<string, Ts>();
  private recentLowWater: Ts = 0;
  private maxCommit: Ts = 0;
  private logLowWater: Ts = 0;
  private ddlFloor: Ts = 0;
  private flushedTs: Ts = 0;
  private inflight = new Map<string, InFlight>();
  private fenced: FencedRange[] = [];
  private incoming: IncomingRange[] = [];
  /** 親：移動済みグループ。 */
  private moved = new Map<string, { m: Ts; to: string; acked: boolean }>();
  /** 子：到着済みグループとその m。 */
  private arrived = new Map<string, Ts>();
  private maxArrived: Ts = 0;
  private pulling = new Map<string, Promise<void>>();
  /** 行ロック。メモリだけに置く。消えても検証が F 以降の変更を見るので安全である。 */
  private locks = new Map<string, RowLock>();
  private waiters = new Map<string, Waiter[]>();
  private stats = { at: 0, reads: 0, writes: 0, groups: new Map<string, number>() };
  private faults: Faults;
  private K: number;
  private rt: Runtime;

  constructor(private deps: ShardDeps) {
    this.id = deps.id;
    this.b = deps.backend;
    this.rt = deps.runtime ?? systemRuntime;
    this.faults = deps.faults ?? {};
    this.K = deps.K ?? 50;
    this.boot();
  }

  // ---- 起動と永続メタデータ ----

  private boot(): void {
    const b = this.b;
    b.exec(`CREATE TABLE IF NOT EXISTS __meta(k TEXT PRIMARY KEY, v)`);
    // ほかの表に触る前に確かめる。新しい形式の DO を、古いコードが作り変えてしまわないようにする。
    checkStorageFormat(b, "__meta", "shard");
    b.exec(`CREATE TABLE IF NOT EXISTS __ddl(version INTEGER PRIMARY KEY, entry TEXT NOT NULL)`);
    b.exec(`CREATE TABLE IF NOT EXISTS __intents(
      tbl TEXT NOT NULL, pk TEXT NOT NULL, sk TEXT NOT NULL, txn TEXT NOT NULL, anchor TEXT NOT NULL,
      prepare_ts INTEGER NOT NULL, change TEXT NOT NULL, PRIMARY KEY(tbl, pk))`);
    for (const ddl of CAPTURE_TABLES) b.exec(ddl);
    b.exec(`CREATE TABLE IF NOT EXISTS __fenced(start INTEGER, end INTEGER, "to" TEXT, done INTEGER NOT NULL DEFAULT 0)`);
    b.exec(`CREATE TABLE IF NOT EXISTS __incoming(start INTEGER, end INTEGER, from_id TEXT)`);
    b.exec(`CREATE TABLE IF NOT EXISTS __moved(g TEXT PRIMARY KEY, m INTEGER NOT NULL, dest TEXT NOT NULL, acked INTEGER NOT NULL DEFAULT 0)`);
    b.exec(`CREATE TABLE IF NOT EXISTS __moved_txn(txn TEXT NOT NULL, g TEXT NOT NULL, dest TEXT NOT NULL, PRIMARY KEY(txn, g))`);
    b.exec(`CREATE TABLE IF NOT EXISTS __arrived(g TEXT PRIMARY KEY, m INTEGER NOT NULL)`);
    b.exec(`CREATE TABLE IF NOT EXISTS __txn(
      txn TEXT PRIMARY KEY, status TEXT NOT NULL, c INTEGER, participants TEXT, done INTEGER NOT NULL DEFAULT 0, at INTEGER)`);
    this.initStorage();

    for (const r of b.exec(`SELECT entry FROM __ddl ORDER BY version`)) {
      const e = JSON.parse(r.entry as string) as DdlEntry & { skipped?: boolean };
      if (!e.skipped) this.loadDefs(e);
    }
    this.schema = (b.exec(`SELECT max(version) v FROM __ddl`)[0]?.v as number) ?? 0;
    this.fenced = b.exec(`SELECT * FROM __fenced`) as unknown as FencedRange[];
    this.incoming = b.exec(`SELECT * FROM __incoming`) as unknown as IncomingRange[];
    for (const r of b.exec(`SELECT g, m, dest, acked FROM __moved`)) {
      this.moved.set(r.g as string, { m: r.m as Ts, to: r.dest as string, acked: r.acked === 1 });
    }
    for (const r of b.exec(`SELECT g, m FROM __arrived`)) {
      this.arrived.set(r.g as string, r.m as Ts);
      this.maxArrived = Math.max(this.maxArrived, r.m as Ts);
    }
    this.epoch = ((this.metaGet("epoch") as number) ?? 0) + 1;
    this.metaSet("epoch", this.epoch);
    this.ceiling = (this.metaGet("ceiling") as number) ?? 0;
    this.flushedTs = (this.metaGet("flushed") as number) ?? 0;
    this.logLowWater = (this.metaGet("log_low_water") as number) ?? 0;
    this.ddlFloor = (this.metaGet("ddl_floor") as number) ?? 0;

    // 直近 write の索引はメモリにしかないので __log から作り直す。GC で消えた commit は logLowWater 以下にある。
    this.maxCommit = this.logLowWater;
    this.logEach("", [], (ts, _txn, blob) => {
      this.maxCommit = Math.max(this.maxCommit, ts);
      for (const c of decode<Change[]>(blob)) this.touch(c.table, c.pk, c.sk, ts);
    });
    const maxPrepare = (b.exec(`SELECT max(prepare_ts) v FROM __intents`)[0]?.v as number) ?? 0;
    // 再起動の前に予約した alarm がなくても、残った intent と phase 2 を片付ける。
    const pendingWork = b.exec(`SELECT (SELECT count(*) FROM __intents) + (SELECT count(*) FROM __txn WHERE status = 'committed' AND done = 0) n`)[0]?.n as number;
    if (pendingWork > 0) this.deps.scheduleRedrive?.();
    // 引数に展開しない。移動したグループが十数万あると、引数の数の上限を超えて、このシャードが起動できなくなる。
    let maxMoved = 0;
    for (const x of this.moved.values()) if (x.m > maxMoved) maxMoved = x.m;
    const resume = Math.max(this.faults.hlcNoCeiling ? 0 : this.ceiling, this.maxCommit, maxPrepare, maxMoved, this.maxArrived);
    this.hlc = new Hlc(resume);
  }

  /** 初めて開く DO に、変更ログの世代の一覧を作る。保存の形式を変えたときの移行は checkStorageFormat (src/types.ts) に置く。 */
  private initStorage(): void {
    if (this.metaGet("log_gens") === null) this.metaSet("log_gens", JSON.stringify([]));
  }

  private logGens(): number[] {
    return JSON.parse((this.metaGet("log_gens") as string | null) ?? "[]") as number[];
  }

  /**
   * 変更ログを commit_ts の昇順で読む。世代は commit_ts の範囲で分かれているので、古い世代から順に読めば全体も昇順になる。
   * where は `commit_ts > ?` のような条件で、各世代の表に同じものを付ける。
   */
  private logScan(where: string, params: Value[], limit?: number): Row[] {
    const out: Row[] = [];
    for (const g of this.logGens()) {
      const rest = limit === undefined ? "" : ` LIMIT ${limit - out.length}`;
      out.push(...this.b.exec(`SELECT commit_ts, txn, blob FROM __log_g${g} ${where} ORDER BY commit_ts${rest}`, ...params));
      if (limit !== undefined && out.length >= limit) break;
    }
    return out;
  }

  /**
   * 変更ログを commit 時刻の順に 1 行ずつ読む。fn が false を返したらそこでやめる。
   * 保持窓の全行を配列にすると、書き込みの多いシャードでは起動と過去時点の読みがメモリを使い切る。
   */
  private logEach(where: string, params: Value[], fn: (commitTs: Ts, txn: string, blob: string) => boolean | void): void {
    for (const g of this.logGens()) {
      const { rows } = this.b.iterate(`SELECT commit_ts, txn, blob FROM __log_g${g} ${where} ORDER BY commit_ts`, ...params);
      for (const r of rows) {
        if (fn(r[0] as Ts, r[1] as string, r[2] as string) === false) return;
      }
    }
  }

  /** commit の変更ログを、c の世代の表へ書く。必ず書き込みの取引の中で呼ぶ。 */
  private logInsert(c: Ts, txn: string, blob: string): void {
    const g = Math.floor(tsToPhysical(c) / (this.deps.logGenMs ?? LOG_GEN_MS));
    const gens = this.logGens();
    if (!gens.includes(g)) {
      this.b.exec(`CREATE TABLE IF NOT EXISTS __log_g${g}(
        commit_ts INTEGER NOT NULL, txn TEXT NOT NULL, blob TEXT NOT NULL, PRIMARY KEY(commit_ts, txn)) WITHOUT ROWID`);
      const next = [...gens, g].sort((a, b) => a - b);
      this.metaSet("log_gens", JSON.stringify(next));
      this.gc(g);
    }
    this.b.exec(`INSERT OR IGNORE INTO __log_g${g}(commit_ts, txn, blob) VALUES (?, ?, ?)`, c, txn, blob);
  }

  /**
   * 保持窓より古い変更ログの世代を DROP し、決着済みの取引記録を消す。
   * DROP TABLE は行の書き込みとして課金されないので、GC の費用は世代の数にしかよらない。
   * 消す前に logLowWater を上げるので、消した範囲を必要とする読みと検証は ReadTooOld か abort になる。
   */
  private gc(writing?: number): void {
    const now = this.deps.clock.now();
    let water = Math.min(this.hlc.value, physicalToTs(now)) - physicalToTs(this.deps.logRetainMs ?? LOG_RETAIN_MS);
    // 未決着の intent は、その prepare 以降に commit し得る。分析へ未送出の範囲も残す。
    const minPrepare = this.b.exec(`SELECT min(prepare_ts) v FROM __intents`)[0]?.v as number | null;
    if (minPrepare !== null && minPrepare !== undefined) water = Math.min(water, minPrepare - 1);
    if (this.flushedTs > 0) water = Math.min(water, this.flushedTs);
    const gens = this.logGens();
    const current = gens.at(-1);
    const drop: number[] = [];
    let low = this.logLowWater;
    for (const g of gens) {
      // 書き込もうとしている世代は消さない。遅れて届いた phase 2 は、最新より古い世代へ書くことがあり、
      // 作ったばかりの空の表は「期限切れ」に見える。消すと、確定済みの取引がいつまでも適用できない。
      if (g === current || g === writing) break;
      const max = (this.b.exec(`SELECT max(commit_ts) v FROM __log_g${g}`)[0]?.v as number | null) ?? 0;
      if (max > water) break;
      drop.push(g);
      low = Math.max(low, max);
    }
    if (drop.length > 0) {
      // dropNoLowWater は、消した範囲を窓の外として扱わない欠陥を戻す。索引の掃除もこの low-water に頼るので、一緒に外す。
      const raise = !this.faults.dropNoLowWater;
      if (raise) this.logLowWater = low;
      this.maxCommit = Math.max(this.maxCommit, low);
      if (raise) this.metaSet("log_low_water", low);
      const keep = gens.filter((g) => !drop.includes(g));
      this.metaSet("log_gens", JSON.stringify(keep));
      for (const g of drop) this.b.exec(`DROP TABLE __log_g${g}`);
      // logLowWater 以下の索引は、検証が先に窓の外として abort するので要らない。
      if (raise) for (const [k, ts] of this.recent) if (ts <= low) this.recent.delete(k);
    }
    const cutoff = now - (this.deps.txnRetainMs ?? TXN_RETAIN_MS);
    // 消すのは、全参加者へ決着を届け終えた (done = 1) 記録だけである。届け終えていない committed の記録を消すと、
    // intent を持つ参加者が「記録なし」から tombstone を書き、確定した取引の書き込みを捨てる (specs/m10_txn_record_gc.qnt)。
    if (this.faults.gcUndone) this.b.exec(`DELETE FROM __txn WHERE at < ?`, cutoff);
    else this.b.exec(`DELETE FROM __txn WHERE done = 1 AND at < ?`, cutoff);
  }

  private metaGet(k: string): Value {
    return this.b.exec(`SELECT v FROM __meta WHERE k = ?`, k)[0]?.v ?? null;
  }
  private metaSet(k: string, v: Value): void {
    this.b.exec(`INSERT INTO __meta(k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`, k, v);
  }

  /** 適用に失敗し、取り消せもしなかった DDL。直るまで、このシャードは要求を受けられない。 */
  private schemaStuck: { version: number; message: string } | null = null;

  private def(table: string): TableDef {
    const d = this.defs.get(table);
    if (!d) throw new SqlError(`no such table: ${table}`);
    return d;
  }
  private loadDefs(e: DdlEntry): void {
    for (const d of e.defs) this.defs.set(d.name, d);
    for (const n of e.drops) this.defs.delete(n);
  }

  private async ensureSchema(version: number): Promise<void> {
    // 古い表定義の要求を通すと、新しいグローバル index の更新が漏れる。経路と同じく取り直させる。
    if (version < this.schema) throw new NotOwner(`stale schema ${version} < ${this.schema}`);
    if (version === this.schema) {
      // DDL の適用が intent の決着を待っている間は、古い表定義の新しい要求を受けない。
      // 受けると intent が増え続けて、DDL がいつまでも適用できない。呼び出し側は表定義を取り直して、同じ待ちに合流する。
      if (this.schemaChange) throw new NotOwner(`stale schema ${version}: a schema change is being applied`);
      return;
    }
    await this.reachSchema(version);
    // Meta にある版は全部適用するので、要求の版を通り越していることがある。要求の版が取り消されたときもそうなる。
    // その場合は、この要求が古い。
    await this.ensureSchema(version);
  }

  /**
   * 少なくともこの版まで DDL を適用する。先の版まで進んでもよい。
   * 要求の計画の版を確かめる ensureSchema と違い、増設の手順 (受け入れ、fence、行の受け取り) が使う。
   * そこでは「この版より古くない」ことだけが要る。
   */
  private async reachSchema(version: number, catchUp = false): Promise<void> {
    while (version > this.schema) {
      // 追いつくための適用は、移動の途中でも通る。進行中の通常の適用 (移動の途中は断られる) には合流しない。
      if (catchUp && this.schemaChange) {
        await this.schemaChange.catch(() => undefined);
        continue;
      }
      const before = this.schema;
      this.schemaChange ??= this.applySchema(catchUp).finally(() => {
        this.schemaChange = null;
      });
      await this.schemaChange;
      if (this.schema === before) throw new SqlError(`schema version ${version} is not recorded yet (shard ${this.id} is at ${before})`);
    }
  }

  /**
   * Meta から DDL を取り、順に適用する。
   * 先に、このシャードが持つ intent をすべて決着させる。intent の行イメージは DDL より前の表の形なので、
   * 表や列が消えた後では適用できない。確定済みの取引がそうなると、再駆動が永久に失敗する。
   */
  private async applySchema(catchUp = false): Promise<void> {
    // 範囲の移動の途中は適用しない。親と子の版がずれると、運ぶ行と intent の形が受け取る側の表と合わなくなる。
    // 親は intent を決着させないと DDL を適用できず、その決着は子へ転送され、子はその行を受け取れない、という行き詰まりになる。
    // 子が親の版へ追いつく場合 (catchUp) だけは通す。届く行がその版の形だからである。
    if (!catchUp && this.moving()) throw new ConflictError(`schema change is waiting for a shard split on ${this.id} to finish`);
    if (!this.faults.ddlIgnoresIntents) await this.settleAllIntents();
    const { ddl } = await this.deps.meta.ddlSince(this.schema);
    // 取り消された版と、それを取り消す版。このシャードがまだ適用していなければ、両方とも実行しない。
    const skip = new Set<number>();
    for (const e of ddl) if (e.reverts !== undefined && e.reverts > this.schema) skip.add(e.reverts).add(e.version);
    for (const e of ddl) {
      if (e.version <= this.schema) continue;
      const skipped = skip.has(e.version);
      try {
        this.b.tx(() => {
          if (!skipped) for (const s of e.sql) this.b.exec(s);
          this.b.exec(`INSERT INTO __ddl(version, entry) VALUES (?, ?)`, e.version, JSON.stringify(skipped ? { ...e, skipped } : e));
        });
      } catch (err) {
        return this.schemaFailed(e, (err as Error).message);
      }
      this.schemaStuck = null;
      if (!skipped) this.loadDefs(e);
      this.schema = e.version;
      // index を公開する版は、時刻を運ぶ。index を使わずに確定した書き込みは、どのシャードのものも、この時刻以下である。
      // ここから先、このシャードで読む文は index を使う。その文が、時刻の順で、それらの書き込みの後ろに来るようにする。
      if (e.at !== undefined && !this.faults.publishWithoutClock) this.observe(e.at);
      // 変更ログの行イメージは DDL より前の形なので、それより古い T は読み戻せない。
      this.ddlFloor = this.issue();
      this.metaSet("ddl_floor", this.ddlFloor);
    }
  }

  /**
   * このシャードの行では DDL を適用できなかった。重複のある列への UNIQUE index や、既存の行が CHECK に反する ADD COLUMN で起きる。
   * 放置すると、このシャードは全要求を断り続ける。Meta に取り消しを求め、取り消す版ごと読み飛ばして先へ進む。
   */
  private async schemaFailed(e: DdlEntry, message: string): Promise<void> {
    const reverted = await this.deps.meta.revokeDdl(e.version, message).catch(() => null);
    if (reverted === null) {
      this.schemaStuck = { version: e.version, message };
      throw new SqlError(`schema change ${e.version} cannot be applied on shard ${this.id}: ${message}`);
    }
    return this.applySchema(true);
  }

  /**
   * 持っている intent を、anchor に尋ねて全部決着させる。進行中の取引は終わるまで待つ。
   * 待っている間、新しい prepare は ensureSchema が断るので、intent は増えない。
   */
  private async settleAllIntents(): Promise<void> {
    // 待ちは実時間のタイマーなので、期限も実時間で測る。
    const deadline = this.rt.now() + SCHEMA_WAIT_MS;
    for (;;) {
      const pending = this.b.exec(`SELECT DISTINCT txn, anchor FROM __intents`) as unknown as Intent[];
      if (pending.length === 0) return;
      for (const i of pending) {
        const res = await this.ask(i.anchor, i.txn, 0);
        if (res.status === "committed") await this.finalize({ txn: i.txn, c: res.c });
        else if (res.status === "aborted") await this.abort({ txn: i.txn });
      }
      if ((this.b.exec(`SELECT count(*) n FROM __intents`)[0]!.n as number) === 0) return;
      if (this.rt.now() > deadline) {
        throw new ConflictError("schema change is waiting for transactions on this shard to finish");
      }
      await sleep(this.rt, 5);
    }
  }

  // ---- 時計 ----

  /** HLC を進めた値が保存済みの上限を超えたら、上限を先取りして保存する (最大で毎秒 1 回)。 */
  private guardCeiling(): void {
    if (this.faults.hlcNoCeiling || this.hlc.value <= this.ceiling) return;
    this.ceiling = this.hlc.value + SECOND;
    this.metaSet("ceiling", this.ceiling);
  }
  private issue(): Ts {
    const t = this.hlc.tick(this.deps.clock.now());
    this.guardCeiling();
    return t;
  }
  private observe(ts: Ts | undefined): void {
    if (ts === undefined) return;
    // 時刻は呼び出し側から届く。接続をまたいで順序を保つ token は、利用者のブラウザを経由することもある。
    // そのまま受け入れると、大きな値 1 つで時計が進みきり、以後の時刻が重複して、変更ログの行が失われる。
    if (!Number.isSafeInteger(ts) || ts < 0) throw new SqlError(`invalid timestamp: ${ts}`);
    if (ts > physicalToTs(this.deps.clock.now() + MAX_CLOCK_AHEAD_MS)) {
      throw new SqlError(`timestamp is more than ${MAX_CLOCK_AHEAD_MS / 60_000} minutes ahead of shard ${this.id}'s clock; the session token is not from this database`);
    }
    this.hlc.observe(ts);
    this.guardCeiling();
  }

  // ---- 所有権 ----

  private fencedRange(sk: string): FencedRange | undefined {
    const slot = slotOf(sk);
    return this.fenced.find((f) => slot >= f.start && slot < f.end);
  }
  private incomingRange(sk: string): IncomingRange | undefined {
    const slot = slotOf(sk);
    return this.incoming.find((f) => slot >= f.start && slot < f.end);
  }
  private sksOf(spans: Span[], writes: Pick<Change, "sk">[] = []): string[] {
    const out = new Set<string>(writes.map((w) => w.sk));
    for (const s of spans) if (s.kind === "pk" || s.kind === "sk" || (s.kind === "pred" && s.sk)) out.add(s.sk!);
    return [...out];
  }

  /** await の前に呼ぶ。未着のグループを引き取る。 */
  private async ensureArrived(sks: string[]): Promise<void> {
    const wanted = sks.filter((g) => this.incomingRange(g) && !this.arrived.has(g));
    if (wanted.length) await this.pullGroups(wanted);
  }

  /**
   * 読む範囲と書く行を、読む時刻でこのシャードが持っているか。親は fence した範囲を一切受理せず、子は T < m を拒否する。
   * 子に T < m の状態はないので、答えると移動前の commit を失った結果を返すことになる。
   *
   * 同期区間の入口では、enter がこれを呼ぶ。ほかに呼ぶのは、intent の決着を始める前だけである (exec、lockedExec、execAuto)。
   * 決着の問い合わせは、相手の取引の確定の時刻を押し上げる。持ち主でない要求は結局断るので、問い合わせる前に断る。
   * そこで通っても、決着を待った後で enter がもう一度確かめる。
   */
  private assertOwned({ spans, writes, at: T }: Rows): void {
    for (const sk of this.sksOf(spans, writes)) {
      const f = this.fencedRange(sk);
      if (f && !this.faults.ignoreFence) throw new NotOwner(f.to);
      if (this.incomingRange(sk) && !this.arrived.has(sk)) throw new ConflictError(`group not arrived: ${sk}`);
      const m = this.arrived.get(sk);
      if (m !== undefined && T !== null && T < m && !this.faults.servePastMove) throw new ReadTooOld(`moved at ${m}`);
    }
    const wide = spans.filter(isWideSpan);
    if (wide.length > 0) {
      // 全表の span が覆うのは、読み手の範囲表でこのシャードが持つ範囲である。
      // その中に手放した範囲があれば、読み手の範囲表は古く、読み手は子を読まない。
      // 移動が終わった後も断り続ける。
      // 親が残りの行だけを答えると、子へ移った行はどのシャードからも返らない。
      if (!this.faults.ignoreFence && !this.faults.staleWideRead) {
        for (const s of wide) {
          for (const [start, end] of s.slots ?? []) {
            const f = this.fenced.find((x) => start < x.end && x.start < end);
            if (f) throw new NotOwner(f.to);
          }
        }
      }
      // 全表の読みは親と子の両方に行く。移動の途中は片方のグループが飛行中で、欠落が起こり得る。
      if (this.incoming.length > 0 || this.fenced.some((f) => !f.done)) throw new Migrating();
      if (T !== null && T < this.maxArrived && !this.faults.servePastMove) throw new ReadTooOld(`moved at ${this.maxArrived}`);
    }
  }

  // ---- 同期区間 ----

  /**
   * 同期区間に入る。要求を処理する関数は、待つ段 (表定義の適用、グループの到着、intent の決着、行ロックの待ち) を終えたら
   * これを呼び、返った印を使って、await を挟まずに状態を読み書きする。もう一度待ったら、もう一度呼ぶ。
   *
   * 待っている間に変わり得ることを、ここで確かめ直す。入口ごとに手で並べない。確かめるのは、引数に挙げたことである。
   *   schema: 要求の表定義が、まだ現行か。入口で確かめた後、行ロックや intent の決着を待っている間に DDL が適用されることがある。
   *     そのまま書くと、新しいグローバル index を保守しない古い計画が通ってしまう。
   *   spans、writes、at: 読む範囲と書く行を、読む時刻でこのシャードが持っているか (assertOwned)。
   * 確かめるだけで、状態は変えない。時計を進める、数える、ロックを延ばすのは、呼び出し側が区間の中でする。
   */
  private enter(claim: Plan & Rows): Section<Check>;
  private enter(claim: Plan): Section<"schema">;
  private enter(claim: Rows): Section<"owned">;
  private enter(claim: Partial<Plan> & Partial<Rows>): Section<Check> {
    const rechecked: { schema?: true; owned?: true } = {};
    if ("schema" in claim) {
      if (!this.faults.noSchemaRecheck && claim.schema !== this.schema) throw new NotOwner(`stale schema ${claim.schema} < ${this.schema}`);
      rechecked.schema = true;
    }
    if ("spans" in claim) {
      this.assertOwned(claim as Rows);
      rechecked.owned = true;
    }
    return Section[ENTER](rechecked as { schema: true; owned: true });
  }

  // ---- ライブ移動 ----

  /** 範囲の移動の途中か。送り出し中 (fence 済みで未完了) か、受け取り中である。 */
  private moving(): boolean {
    return this.incoming.length > 0 || this.fenced.some((f) => !f.done);
  }

  async moves(_req: Record<string, never>): Promise<{ outgoing: { start: number; end: number; to: string }[]; incoming: { start: number; end: number; from: string }[] }> {
    return {
      outgoing: this.fenced.filter((f) => !f.done).map((f) => ({ start: f.start, end: f.end, to: f.to })),
      incoming: this.incoming.map((x) => ({ start: x.start, end: x.end, from: x.from_id })),
    };
  }

  async beginIncoming(req: { start: number; end: number; from: string; slot: string }): Promise<{ schema: number }> {
    const same = () => this.incoming.some((x) => x.start === req.start && x.end === req.end && x.from_id === req.from);
    if (same()) return { schema: this.schema };
    // Meta が分割に渡した枠を示す。枠がある間、Meta は新しい版を記録しない (specs/m15_maintenance_slot.qnt)。
    // 受け取り始める版は、枠を取ったときの Meta の版である。分割を進める側が先に読んだ版は使わない。間に記録された版を、
    // 親だけが先に適用していると、子が親より古い版で受け取り始め、子へ移った行を読めなくなる。
    const { version } = await this.deps.meta.startSplit(req.slot, { parent: req.from, child: this.id, start: req.start, end: req.end });
    await this.reachSchema(version);
    if (same()) return { schema: this.schema };
    // 重なる範囲を別の親から受け取ると、どちらの行が正しいのか決められない。送り出し中のシャードも子にしない。
    const clash = this.incoming.find((x) => x.start < req.end && req.start < x.end);
    if (clash) throw new SqlError(`shard ${this.id} is already receiving slots [${clash.start}, ${clash.end}) from ${clash.from_id}`);
    if (this.fenced.some((f) => !f.done)) throw new ConflictError(`shard ${this.id} is still handing a range over; it cannot receive one until that finishes`);
    this.b.exec(`INSERT INTO __incoming(start, end, from_id) VALUES (?, ?, ?)`, req.start, req.end, req.from);
    this.incoming.push({ start: req.start, end: req.end, from_id: req.from });
    await this.b.sync();
    return { schema: this.schema };
  }

  async fence(req: { start: number; end: number; to: string; schema?: number; slot: string }): Promise<void> {
    const same = () => this.fenced.some((x) => x.start === req.start && x.end === req.end && x.to === req.to);
    if (same()) return;
    // 子の表定義の版まで追いついてから fence する。子が先の版にいると、親の古い形の行と intent を子が受け取れない。
    // 移動の間は、親も子も DDL を適用しない (applySchema)。
    // 親が先の版にいるなら、そのままでよい。子は、行を受け取るときに親の版まで追いつく。
    await this.deps.meta.checkSplit(req.slot, { parent: this.id, child: req.to, start: req.start, end: req.end });
    if (req.schema !== undefined) await this.reachSchema(req.schema);
    if (same()) return;
    // 同じ範囲を 2 つの子へ送り出すと、行が両方へ分かれ、範囲表はどちらか片方しか指さない。
    const clash = this.fenced.find((x) => x.start < req.end && req.start < x.end);
    if (clash) throw new SqlError(`slots [${clash.start}, ${clash.end}) of shard ${this.id} ${clash.done ? "were moved" : "are being moved"} to ${clash.to}`);
    // 受け取り中のシャードは、まだ届いていない行を持っていない。その範囲を送り出すと、届いていない行が取り残される。
    if (this.incoming.length > 0) throw new ConflictError(`shard ${this.id} is still receiving a range; it cannot be split until that finishes`);
    this.b.exec(`INSERT INTO __fenced(start, end, "to") VALUES (?, ?, ?)`, req.start, req.end, req.to);
    this.fenced.push({ start: req.start, end: req.end, to: req.to, done: 0 });
    await this.b.sync();
  }

  /**
   * 範囲のグループを列挙する。fence の後に呼べば取り残しはない。
   * ack されていないグループは移動済みでも返す。子が受け取る前に落ちると応答が失われるからである。
   */
  async listGroups(req: { start: number; end: number; limit: number; cursor?: GroupCursor | null }): Promise<{ groups: string[]; cursor: GroupCursor | null }> {
    const out: string[] = [];
    const seen = new Set<string>();
    const add = (g: string) => {
      const slot = slotOf(g);
      if (slot >= req.start && slot < req.end && !this.moved.get(g)?.acked && !seen.has(g)) {
        seen.add(g);
        out.push(g);
      }
    };
    // 表は名前の順に、表の中は shard key の順に読み、前回の続きから始める。
    // 毎回先頭から読むと、行ごとに shard key が違う表 (既定の `id INTEGER PRIMARY KEY`) では、
    // 呼ぶたびに全行を読み直し、全部を配列に持つことになる。
    const tables = [...this.defs.keys()].sort();
    let cursor: GroupCursor = req.cursor ?? { table: tables[0] ?? null, after: null };
    while (cursor.table !== null) {
      const def = this.defs.get(cursor.table);
      if (def) {
        const cols = def.shardKey.map(q).join(", ");
        const keyset = cursor.after !== null && cursor.after.every((v) => v !== null);
        const where = keyset ? `WHERE (${cols}) > (${def.shardKey.map(() => "?").join(", ")})` : "";
        const skip = keyset ? 0 : (cursor.skip ?? 0);
        const { rows } = this.b.iterate(
          `SELECT DISTINCT ${cols} FROM ${q(def.name)} ${where} ORDER BY ${cols} LIMIT -1 OFFSET ${skip}`,
          ...(keyset ? cursor.after! : []),
        );
        let read = 0;
        for (const r of rows) {
          read++;
          add(keyString(r));
          if (out.length >= req.limit) {
            // NULL を含む shard key は行の比較で絞れないので、読んだ数で続きを表す。
            const next: GroupCursor = r.every((v) => v !== null)
              ? { table: cursor.table, after: r }
              : { table: cursor.table, after: null, skip: skip + read };
            return { groups: out, cursor: next };
          }
        }
      }
      const name: string = cursor.table;
      cursor = { table: tables.find((t) => t > name) ?? null, after: null };
    }
    // 行のないグループも運ぶ。intent だけがある場合と、ack が届いていない場合である。
    for (const r of this.b.exec(`SELECT DISTINCT sk FROM __intents`)) add(r.sk as string);
    for (const [g] of this.moved) add(g);
    return { groups: out, cursor: null };
  }

  /**
   * グループを子へ渡す。m を確定してから応答するので、再送しても同じ m になる。
   * 親は ack まで行を保持する。子が受け取る前に落ちても再送で取り戻せるからである。
   */
  async pull(req: { groups: string[]; to: string; maxBytes: number }): Promise<GroupPayload[]> {
    const out: GroupPayload[] = [];
    let bytes = 0;
    for (const g of req.groups) {
      const f = this.fencedRange(g);
      const known0 = this.moved.get(g);
      if (known0 && known0.to !== req.to) throw new NotOwner(known0.to);
      if (!f) throw new SqlError(`pull of unfenced group ${g}`);
      // fence の宛先でないシャードには渡さない。渡すと、行が範囲表の指さないシャードへ行く。
      if (f.to !== req.to) throw new NotOwner(f.to);
      const rows = [...this.defs.values()].flatMap((def) =>
        selectGroup(this.b, def, g).map((row) => ({ table: def.name, row })),
      );
      const intents = this.faults.dropIntentsOnMove ? [] : this.b.exec(`SELECT * FROM __intents WHERE sk = ?`, g);
      const size = encode(rows).length + encode(intents).length;
      // 1 グループは 1 回の RPC で運ぶ。RPC の上限 (32 MiB) を超える大きさは運べないので、はっきり断る。
      // 断らないと、運べないまま再試行を続け、原因が見えない。
      if (size > GROUP_MAX_BYTES) {
        throw new SqlError(`group too large to move: shard key ${g} holds ${size} bytes (limit ${GROUP_MAX_BYTES}); this split cannot finish`);
      }
      if (out.length > 0 && bytes + size > req.maxBytes) break;
      bytes += size;
      let known = this.moved.get(g);
      if (!known) {
        known = { m: this.issue(), to: req.to, acked: false };
        this.moved.set(g, known);
        this.b.tx(() => {
          this.b.exec(`INSERT INTO __moved(g, m, dest) VALUES (?, ?, ?)`, g, known!.m, req.to);
          for (const i of intents) {
            this.b.exec(`INSERT OR IGNORE INTO __moved_txn(txn, g, dest) VALUES (?, ?, ?)`, i.txn as string, g, req.to);
          }
        });
      }
      out.push({ g, m: known.m, rows, intents, schema: this.schema });
    }
    await this.b.sync();
    return out;
  }

  private pullGroups(groups: string[]): Promise<void> {
    const waits: Promise<void>[] = [];
    const fresh: string[] = [];
    for (const g of groups) {
      const p = this.pulling.get(g);
      if (p) waits.push(p);
      else fresh.push(g);
    }
    if (fresh.length) {
      const job = this.fetchGroups(fresh).finally(() => {
        for (const g of fresh) this.pulling.delete(g);
      });
      for (const g of fresh) this.pulling.set(g, job);
      waits.push(job);
    }
    return Promise.all(waits).then(() => undefined);
  }

  private async fetchGroups(groups: string[]): Promise<void> {
    const byParent = new Map<string, string[]>();
    for (const g of groups) {
      const from = this.incomingRange(g)!.from_id;
      byParent.set(from, [...(byParent.get(from) ?? []), g]);
    }
    for (const [from, list] of byParent) {
      let rest = list;
      while (rest.length) {
        const payload = await this.deps.peer(from).pull({ groups: rest, to: this.id, maxBytes: 1_000_000 });
        await this.receive(payload);
        void this.deps.peer(from).ack({ groups: payload.map((p) => p.g) }).catch(() => {});
        const got = new Set(payload.map((p) => p.g));
        rest = rest.filter((g) => !got.has(g));
      }
    }
  }

  private async receive(payload: GroupPayload[]): Promise<void> {
    // 親の表定義の版まで追いついてから受け取る。子は増設の途中で生まれるので、DDL の「全シャードへの適用」から
    // 漏れることがある。古い版のままだと、届いた行と表の形が合わず、新しい index を保守しない古い計画の書き込みも通る。
    const version = Math.max(0, ...payload.map((p) => p.schema ?? 0));
    if (!this.faults.childKeepsOldSchema) await this.reachSchema(version, true);
    const fresh = payload.filter((p) => !this.arrived.has(p.g));
    this.b.tx(() => {
      for (const p of fresh) {
        for (const { table, row } of p.rows) insertRow(this.b, this.def(table), row);
        for (const i of p.intents) {
          this.b.exec(
            `INSERT OR IGNORE INTO __intents(tbl, pk, sk, txn, anchor, prepare_ts, change) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            i.tbl ?? null, i.pk ?? null, i.sk ?? null, i.txn ?? null, i.anchor ?? null, i.prepare_ts ?? null, i.change ?? null,
          );
        }
        this.b.exec(`INSERT OR IGNORE INTO __arrived(g, m) VALUES (?, ?)`, p.g, p.m);
      }
    });
    // 到着の印は挿入と同じ同期区間で付ける。sync の待ちの間に、要求駆動の pull と背景の drain が
    // 同じグループを受け取ると二重に挿入してしまう。応答は output gate が確定まで止めるので安全である。
    for (const p of fresh) {
      this.arrived.set(p.g, p.m);
      this.maxArrived = Math.max(this.maxArrived, p.m);
      this.observe(p.m);
    }
    await this.b.sync(); // 親が行を消すのは到着の確定後である。
  }

  async ack(req: { groups: string[] }): Promise<void> {
    this.b.tx(() => {
      for (const g of req.groups) {
        const known = this.moved.get(g);
        if (!known || known.acked) continue;
        for (const def of this.defs.values()) {
          for (const row of selectGroup(this.b, def, g)) deleteRow(this.b, def, encodeKey(def, row).pk);
        }
        this.b.exec(`DELETE FROM __intents WHERE sk = ?`, g);
        this.b.exec(`UPDATE __moved SET acked = 1 WHERE g = ?`, g);
        known.acked = true;
      }
    });
  }

  async drain(req: { start: number; end: number }): Promise<{ groups: number; rows: number; bytes: number }> {
    const range = this.incoming.find((x) => x.start === req.start && x.end === req.end);
    if (!range) return { groups: 0, rows: 0, bytes: 0 };
    const parent = this.deps.peer(range.from_id);
    const total = { groups: 0, rows: 0, bytes: 0 };
    // 親のグループを先頭から順に列挙して運ぶ。最後まで行ったら、もう一度先頭から列挙して、取り残しがないことを確かめる。
    // ack 済みのグループは親から消えているので、2 周目は残る側のグループを読むだけである。
    for (let pass = 0; ; pass++) {
      let cursor: GroupCursor | null | undefined = undefined;
      let moved = 0;
      do {
        const page: { groups: string[]; cursor: GroupCursor | null } = await parent.listGroups({ ...req, limit: 256, cursor });
        cursor = page.cursor;
        // 受け取り済みで親に ack が届いていないグループは、ack だけを送り直す。
        const done = page.groups.filter((g) => this.arrived.has(g));
        if (done.length) await parent.ack({ groups: done });
        let rest = page.groups.filter((g) => !this.arrived.has(g));
        moved += page.groups.length;
        // pull は大きさの上限で途中までしか返さないことがある。残りを取り終えるまで繰り返す。
        while (rest.length) {
          const payload = await parent.pull({ groups: rest, to: this.id, maxBytes: 1_000_000 });
          await this.receive(payload);
          await parent.ack({ groups: payload.map((p) => p.g) });
          total.groups += payload.length;
          for (const p of payload) {
            total.rows += p.rows.length;
            total.bytes += encode(p.rows).length;
          }
          const got = new Set(payload.map((p) => p.g));
          rest = rest.filter((g) => !got.has(g));
        }
      } while (cursor !== null);
      if (moved === 0) return total;
      if (pass > 100) throw new SqlError("drain does not converge");
    }
  }

  async finishMove(req: { start: number; end: number }): Promise<{ m: Ts }> {
    this.b.exec(`UPDATE __fenced SET done = 1 WHERE start = ? AND end = ?`, req.start, req.end);
    for (const f of this.fenced) if (f.start === req.start && f.end === req.end) f.done = 1;
    // fence の後、このシャードは範囲の行について何も答えていない。いま発行する時刻は、範囲について答えたどの読みの時刻よりも、
    // 確定したどの書き込みの時刻よりも大きい。
    return { m: this.issue() };
  }

  async finishIncoming(req: { start: number; end: number; m: Ts }): Promise<void> {
    // 行のあるグループは、pull が時刻を運び、時計はそこまで進んでいる (receive)。渡す側に行のなかったグループは運ばれないので、
    // 渡す側の時計を、ここで受け取る。受け取らないと、渡す側が「行はない」と答えた時刻より小さい時刻で、その行を書いてしまい、
    // 答え済みの読みが、後から書き込みの後になる (モデル M5b の noWriteBelowRead)。
    if (!this.faults.finishWithoutClock) this.observe(req.m);
    this.b.exec(`DELETE FROM __incoming WHERE start = ? AND end = ?`, req.start, req.end);
    this.incoming = this.incoming.filter((x) => !(x.start === req.start && x.end === req.end));
  }

  async health(_req: Record<string, never>): Promise<ShardHealth> {
    const one = (sql: string, ...params: Value[]) => (this.b.exec(sql, ...params)[0]?.v as number | null) ?? 0;
    const oldest = one(`SELECT min(prepare_ts) v FROM __intents`);
    return {
      id: this.id, schema: this.schema, format: STORAGE_FORMAT, bytes: this.b.size(),
      intents: one(`SELECT count(*) v FROM __intents`),
      oldestIntentMs: oldest === 0 ? 0 : Math.max(0, this.deps.clock.now() - tsToPhysical(oldest)),
      unapplied: one(`SELECT count(*) v FROM __txn WHERE status = 'committed' AND done = 0`),
      redriveErrors: this.lastRedriveErrors,
      schemaError: this.schemaStuck ? `schema change ${this.schemaStuck.version}: ${this.schemaStuck.message}` : null,
      incoming: this.incoming.length,
      outgoing: this.fenced.filter((f) => !f.done).length,
      logGenerations: this.logGens().length,
    };
  }

  /**
   * 表の行を主キーの順に、after より後から limit 行まで返す。pk は columns の中の主キーの列の位置である。
   * 最新の確定済みの状態を読むだけで、時点はそろえない。移動の途中のシャードでは、同じ行が親と子の両方にあるので断る。
   */
  async exportRows(req: { table: string; after: Value[] | null; limit: number; skip?: number }): Promise<{ columns: string[]; rows: Value[][]; pk: number[] }> {
    if (this.incoming.length > 0 || this.fenced.some((f) => !f.done)) throw new Migrating();
    const def = this.defs.get(req.table);
    if (!def) throw new SqlError(`no such table: ${req.table}`);
    const cols = def.pk.map(q).join(", ");
    const list = imageList(def);
    const keyset = req.after !== null && req.after.every((v) => v !== null);
    const where = keyset ? `WHERE (${cols}) > (${def.pk.map(() => "?").join(", ")})` : "";
    const limit = Math.max(1, Math.min(req.limit, 5000));
    // 主キーに NULL を含む行は、行の比較では「その次」を表せない。その場合は、読んだ行数で続きを表す。
    const offset = keyset ? "" : ` OFFSET ${Math.max(0, Math.floor(req.skip ?? 0))}`;
    const { columns, rows } = this.b.iterate(
      `SELECT ${list} FROM ${q(def.name)} ${where} ORDER BY ${cols} LIMIT ${limit}${offset}`, ...(keyset ? req.after! : []),
    );
    const out: Value[][] = [];
    let bytes = 0;
    for (const r of rows) {
      out.push(r);
      for (const v of r) bytes += sizeOf(v);
      // 1 回の応答が大きくなりすぎないよう、行数の上限より先にバイト数で切る。続きは次の呼び出しで読む。
      if (bytes > 4_000_000) break;
    }
    const typed = typedValues(def, columns, out);
    return { columns: typed.columns, rows: typed.rows, pk: def.pk.map((c) => typed.columns.indexOf(c)) };
  }

  async metrics(_req: Record<string, never>): Promise<ShardMetrics> {
    const now = this.deps.clock.now();
    const s = this.stats;
    const total = [...s.groups.values()].reduce((a, b) => a + b, 0);
    const top = [...s.groups.entries()].sort((a, b) => b[1] - a[1])[0];
    const out: ShardMetrics = {
      id: this.id, size: this.b.size(), reads: s.reads, writes: s.writes,
      elapsedMs: s.at === 0 ? 0 : now - s.at,
      topGroup: top && total > 0 ? { g: top[0], share: top[1] / total } : null,
      migrating: this.incoming.length > 0 || this.fenced.some((f) => !f.done),
    };
    this.stats = { at: now, reads: 0, writes: 0, groups: new Map() };
    return out;
  }

  private count(kind: "reads" | "writes", spans: Span[], writes: Pick<Change, "sk">[] = []): void {
    // 起動後の最初の要求から数え始める。0 のままだと最初の報告の経過時間が 0 になり、
    // Autoscaler は眠っていたシャードの負荷を次の問い合わせまで判断できない。
    if (this.stats.at === 0) this.stats.at = this.deps.clock.now();
    this.stats[kind]++;
    if (this.stats.groups.size > 4096) return;
    for (const sk of this.sksOf(spans, writes)) this.stats.groups.set(sk, (this.stats.groups.get(sk) ?? 0) + 1);
  }

  // ---- 行ロック ----

  private lockKey(table: string, pk: string): string {
    return `${table}\0${pk}`;
  }

  private liveLock(key: string): RowLock | undefined {
    const l = this.locks.get(key);
    if (l && l.expires <= this.deps.clock.now()) {
      this.locks.delete(key);
      this.wakeNext(key);
      return undefined;
    }
    return l;
  }

  private wakeNext(key: string): void {
    const q2 = this.waiters.get(key);
    const next = q2?.shift();
    if (q2 && q2.length === 0) this.waiters.delete(key);
    next?.wake();
  }

  private wakeAll(key: string): void {
    for (const w of this.waiters.get(key) ?? []) w.wake();
    this.waiters.delete(key);
  }

  private grant(key: string, owner: LockOwner): void {
    this.locks.set(key, { ...owner, expires: this.deps.clock.now() + (this.deps.lockTtlMs ?? LOCK_TTL_MS) });
  }

  private renew(txn: string): void {
    const until = this.deps.clock.now() + (this.deps.lockTtlMs ?? LOCK_TTL_MS);
    for (const l of this.locks.values()) if (l.txn === txn) l.expires = until;
  }

  private releaseLocks(txn: string): void {
    const id = lockIdOf(txn);
    for (const [key, l] of this.locks) {
      if (l.txn !== id) continue;
      this.locks.delete(key);
      this.wakeNext(key);
    }
  }

  async unlock(req: { txn: string }): Promise<void> {
    this.releaseLocks(req.txn);
  }

  /** 古い取引が優先される。 */
  private older(a: LockOwner, b: LockOwner): boolean {
    return a.start < b.start || (a.start === b.start && a.txn < b.txn);
  }

  /**
   * ロックか intent が空くまで待つ。wound-wait で、若い保持者からは取り上げる。
   * 取り上げられた取引は commit の検証で気付く。prepare 済みの intent は取り上げられないので待つ。
   * prepare 自身はこの待ちに入らない。入ると閉路ができる。
   */
  private waitForRow(key: string, me: LockOwner, deadline: number): Promise<void> {
    const lock = this.liveLock(key);
    // 欠陥 woundPrepared は、ロックのない行の intent の持ち主 (prepare 済みの取引) も奪う相手にする。
    // intent に開始時刻はないので、prepare_ts の物理時刻で代える。
    const cut = key.indexOf("\0");
    const intent = !lock && this.faults.woundPrepared ? this.intentAt(key.slice(0, cut), key.slice(cut + 1)) : undefined;
    const held: LockOwner | undefined = lock ?? (intent && { txn: intent.txn, start: tsToPhysical(intent.prepare_ts) });
    return new Promise((resolve, reject) => {
      const list = this.waiters.get(key) ?? [];
      const leave = () => {
        const at = list.indexOf(w);
        if (at >= 0) list.splice(at, 1);
        this.rt.cancel(timer);
        this.rt.cancel(wound);
        this.rt.cancel(expiry);
      };
      const timer = this.rt.after(Math.max(1, deadline - this.deps.clock.now()), () => {
        leave();
        reject(new ConflictError("lock wait timeout"));
      });
      const wound = held && this.older(me, held)
        ? this.rt.after(WOUND_DELAY_MS, () => {
            if (intent) {
              if (this.intentAt(intent.tbl, intent.pk)?.txn !== intent.txn) return;
              this.b.exec(`DELETE FROM __intents WHERE tbl = ? AND pk = ?`, intent.tbl, intent.pk);
            } else {
              if (this.locks.get(key)?.txn !== held.txn) return;
              this.locks.delete(key);
            }
            leave();
            resolve();
          })
        : undefined;
      // 保持者の Worker が死ぬと誰もロックを解放しない。期限で確かめないと待ち手が眠ったままになる。
      let expiry: unknown;
      const watch = () => {
        const l = this.liveLock(key); // 切れていれば wakeNext が先頭を起こす
        if (l) expiry = this.rt.after(Math.max(1, l.expires - this.deps.clock.now() + 1), watch);
      };
      if (lock) expiry = this.rt.after(Math.max(1, lock.expires - this.deps.clock.now() + 1), watch);
      const w: Waiter = { ...me, wake: () => { leave(); resolve(); } };
      // 古い取引を先に起こす。同じ開始時刻の間は到着順である。
      const at = list.findIndex((x) => this.older(me, x));
      list.splice(at < 0 ? list.length : at, 0, w);
      this.waiters.set(key, list);
    });
  }

  /**
   * 欠陥 prepareWaits だけが使う。prepare が、書く行の他の取引のロックが空くのを待つ。prepare の要求に開始時刻はないので、
   * 最も若い待ち手として待ち、wound はしない。期限を過ぎたら待つのをやめ、検証に任せる (ロックが残っていれば abort)。
   */
  private async waitForForeignLocks(txn: string, writes: Pick<Change, "table" | "pk">[]): Promise<void> {
    const deadline = this.deps.clock.now() + LOCK_WAIT_MS;
    const me: LockOwner = { txn: lockIdOf(txn), start: Number.MAX_SAFE_INTEGER };
    for (const w of writes) {
      const key = this.lockKey(w.table, w.pk);
      for (let l = this.liveLock(key); l && l.txn !== me.txn; l = this.liveLock(key)) {
        if (this.deps.clock.now() >= deadline) return;
        await this.waitForRow(key, me, deadline).catch(() => undefined);
      }
    }
  }

  private blockedBy(changes: Pick<Change, "table" | "pk">[], me: LockOwner): string | null {
    for (const c of changes) {
      const key = this.lockKey(c.table, c.pk);
      const held = this.liveLock(key);
      if (held && held.txn !== me.txn) return key;
      const intent = this.intentAt(c.table, c.pk);
      if (intent && intent.txn !== me.txn) return key;
    }
    return null;
  }

  /**
   * 悲観的な DML。最新の状態 F で実行し、変更行のロックを取る。
   * 先に intent を決着させる。確定済みで未適用の行を読み飛ばすと、T も F も新しいのに見えない commit ができる。
   */
  private async lockedExec(req: ExecReq, me: LockOwner): Promise<ExecRes> {
    const deadline = this.deps.clock.now() + LOCK_WAIT_MS;
    // 最新の状態を読むので、読む時刻はない。
    const claim: Rows = { spans: req.spans, writes: [], at: null };
    // 起こされた行。取らずに去るなら次の待ち手を起こす。起こすのは先頭の 1 件だけだからである。
    let woken: string | null = null;
    try {
      for (;;) {
        await this.ensureArrived(this.sksOf(req.spans));
        // F はこのシャードが発行する時刻である。取引の T と因果トークンまで時計を進めてから発行するので、F より後の確定は F より大きい
        // (specs/m9_protocol.qnt の m9_red_f_is_t)。
        if (!this.faults.dmlSkipsClock) {
          this.observe(req.minTs);
          this.observe(req.T);
        }
        // 欠陥 dmlAtT は、F を発行せず、取引の T を F として使う。T は別のシャードの時計から来ることがある。
        const atT = this.faults.dmlAtT && req.T !== undefined;
        let F = atT ? req.T! : this.issue();
        this.assertOwned(claim);
        let applied = await this.settleIntents(req.spans, F);
        while (applied) {
          if (!atT) F = this.issue();
          applied = await this.settleIntents(req.spans, F);
        }
        // ここから先は await を挟まない。版は確かめ直さない。行ロックや intent の決着を待っている間に DDL が適用されると、この文は
        // 古い計画のまま実行される。文の変更は、取引の確定 (commitLocal、prepare、commit) が版を確かめる。
        const sec = this.enter(claim);
        this.count("writes", req.spans);
        this.renew(me.txn);
        const overlay = (req.overlay ?? []).map((c) => ({ table: c.table, pk: c.pk, image: c.after }));
        let out: { columns: string[]; values: Value[][]; changes: Change[]; count?: number };
        // 欠陥 lockedReadAtT は、ロック読みを T の snapshot で読む (返す F は変えない)。dmlAtT は、F = T の状態で実行する。
        const readAt = atT ? F : this.faults.lockedReadAtT && !req.write ? req.T : undefined;
        try {
          out = this.rollback(() => {
            if (readAt !== undefined) this.restore(this.deltaAfter(readAt));
            if (overlay.length) setBasedRestore(this.b, (t) => this.def(t), overlay);
            return this.run(sec, req);
          });
        } catch (e) {
          if (e instanceof ReadTooOld || e instanceof ConflictError || e instanceof NotOwner || e instanceof ShardLimit) throw e;
          // 文は F の状態を読んだうえで失敗した。読んだ時刻を付けて返し、呼び出し側に範囲を記録させる (ExecRes.error)。
          return { columns: [], values: [], changes: [], error: asSqlError(e).message, F, T: req.T ?? F, hlc: this.hlc.value, epoch: this.epoch };
        }
        const rows = [...out.changes, ...(req.lockRows ?? [])] as Pick<Change, "table" | "pk">[];
        const blocked = this.blockedBy(rows, me);
        if (!blocked) {
          for (const c of rows) this.grant(this.lockKey(c.table, c.pk), me);
          if (woken && this.locks.get(woken)?.txn === me.txn) woken = null;
          return { ...out, changes: out.changes.map((c) => ({ ...c, since: F })), F, T: req.T ?? F, hlc: this.hlc.value, epoch: this.epoch };
        }
        if (woken && woken !== blocked) this.wakeNext(woken);
        woken = null;
        if (this.deps.clock.now() >= deadline) throw new ConflictError("lock wait timeout");
        await this.waitForRow(blocked, me, deadline);
        woken = blocked;
      }
    } finally {
      if (woken) this.wakeNext(woken);
    }
  }

  async syncSchema(req: { version: number }): Promise<{ moving: boolean }> {
    if (req.version > this.schema) await this.ensureSchema(req.version);
    return { moving: this.moving() };
  }

  async now(_req: Record<string, never>): Promise<Ts> {
    return this.issue();
  }

  // ---- intent の解決 ----

  private overlapping(spans: Span[], upTo: Ts): Intent[] {
    const all = this.b.exec(`SELECT * FROM __intents WHERE prepare_ts <= ?`, upTo) as unknown as Intent[];
    return all.filter((i) => spans.some((s) => spanCovers(s, i.tbl, i.pk, i.sk) && this.intentMatches(s, i)));
  }

  /** intent が述語に関わるか。適用後の行と、本体の現在の行のどちらかが満たせば関わる。 */
  private intentMatches(s: Span, i: Intent): boolean {
    if (s.kind !== "pred") return true;
    const c = decode<Change>(i.change);
    const def = this.defs.get(s.table);
    if (!def) return true;
    const current = selectRow(this.b, def, c.pk);
    return [c.after, current].some((row) => row !== null && this.rowMatches(s, def, c.pk, row));
  }

  /**
   * 行イメージが述語を満たすかを本物の表で判定する。型親和性と照合順序が読み取りと同じになるからである。
   * 判定できないときは競合側へ倒す。誤って「関係ない」と答えると Serializable が破れる。
   */
  private rowMatches(s: Extract<Span, { kind: "pred" }>, def: TableDef, pk: string, row: Row): boolean {
    try {
      return this.rollback(() => {
        deleteRow(this.b, def, pk);
        insertRow(this.b, def, row);
        const key = def.pk.map((c) => `${q(s.alias)}.${q(c)} IS ?`).join(" AND ");
        const sql = `SELECT 1 FROM ${q(def.name)} AS ${q(s.alias)} WHERE (${s.where}) AND ${key} LIMIT 1`;
        return this.b.exec(sql, ...s.params, ...decode<Value[]>(pk)).length > 0;
      });
    } catch {
      return true;
    }
  }

  /** (from, 現在] の commit のうち、述語に関わるものがあるか。 */
  private predicateChanged(s: Extract<Span, { kind: "pred" }>, from: Ts): boolean {
    const def = this.defs.get(s.table);
    if (!def || from < this.logLowWater || from < this.ddlFloor) return true;
    const rows = this.logScan(`WHERE commit_ts > ?`, [from], PRED_WINDOW + 1);
    if (rows.length > PRED_WINDOW) return true;
    for (const r of rows) {
      for (const c of decode<Change[]>(r.blob as string)) {
        if (c.table !== s.table || !spanCovers(s, c.table, c.pk, c.sk)) continue;
        // 各版はどれかの commit の before か after に現れるので、途中の版も見逃さない。
        if ([c.before, c.after].some((row) => row !== null && this.rowMatches(s, def, c.pk, row))) return true;
      }
    }
    return false;
  }

  private async ask(anchor: string, txn: string, pushTo: Ts): Promise<TxnStatus> {
    return anchor === this.id ? this.queryTxn({ txn, pushTo }) : this.deps.peer(anchor).queryTxn({ txn, pushTo });
  }

  /**
   * T 以下で確定し得る intent をすべて決着させる。
   * 無視してよいのは commit 時刻が T を超えると確定した intent だけである。
   */
  private async settleIntents(spans: Span[], T: Ts): Promise<Ts> {
    const pushed = new Set<string>();
    // 取引ごとの、この呼び出しで決着させた回数。決着させた後も intent が残ることはある (運ばれた行の到着を待つ、など)。
    // その場合は、イベントループへ制御を返して待ってから、もう 1 度問い合わせる。上限を超えて残るなら、ここでは適用できない
    // (不変条件 2 の症状)。
    const settled = new Map<string, number>();
    // 適用した取引の commit 時刻の最大値。何も適用していなければ 0。
    let applied: Ts = 0;
    for (;;) {
      const pending = this.overlapping(spans, T).filter((i) => !pushed.has(i.txn));
      if (pending.length === 0) return applied;
      for (const txn of new Set(pending.map((i) => i.txn))) {
        const intent = pending.find((i) => i.txn === txn)!;
        const tries = settled.get(txn) ?? 0;
        if (tries >= SETTLE_TRIES) {
          // 待たずに問い合わせを繰り返すと止まらない。anchor が自分なら問い合わせも適用も microtask だけで済み、イベントループが回らず、
          // どの時間の制限も効かない (未解決の問題 18)。読みを、理由を付けて失敗させる。
          throw new SqlError(`stuck: transaction ${txn} is decided but its write to ${intent.tbl} cannot be applied on ${this.id}`);
        }
        if (tries > 0) await sleep(this.rt, Math.min(100, 2 ** tries));
        settled.set(txn, tries + 1);
        if (this.faults.readerTimeoutPass) {
          pushed.add(txn);
          continue;
        }
        const res = await this.ask(intent.anchor, txn, T);
        if (res.status === "committed") {
          await this.finalize({ txn, c: res.c });
          applied = Math.max(applied, res.c);
        } else if (res.status === "aborted") await this.abort({ txn });
        else pushed.add(txn);
      }
    }
  }

  // ---- rollback-read ----

  private rollback<T>(fn: () => T): T {
    let out: { v: T } | undefined;
    try {
      this.b.tx(() => {
        out = { v: fn() };
        throw ROLLBACK;
      });
    } catch (e) {
      if (e !== ROLLBACK) throw e;
    }
    return out!.v;
  }

  /** T より後の commit について、pk ごとに最も古い before-image を集める。 */
  private deltaAfter(T: Ts): { table: string; pk: string; image: Row | null }[] {
    if (T >= this.maxCommit) return [];
    const floor = Math.max(this.logLowWater, this.ddlFloor);
    if (T < floor) throw new ReadTooOld(`moved at ${floor}`);
    const seen = new Map<string, { table: string; pk: string; image: Row | null }>();
    // K を超えた時点で読むのをやめる。T 以降の全ログを読んでから数えると、古い T の読みが来るたびに保持窓の全行を読む。
    this.logEach(`WHERE commit_ts > ?`, [T], (_ts, _txn, blob) => {
      for (const c of decode<Change[]>(blob)) {
        const key = `${c.table}\0${c.pk}`;
        if (!seen.has(key) && this.defs.has(c.table)) seen.set(key, { table: c.table, pk: c.pk, image: c.before });
      }
      return seen.size <= this.K;
    });
    if (seen.size > this.K) throw new ReadTooOld(`delta exceeds K=${this.K}`);
    return [...seen.values()];
  }

  private restore(targets: { table: string; pk: string; image: Row | null }[]): void {
    if (targets.length === 0) return;
    const cat = (t: string) => this.def(t);
    if (this.faults.rowwiseUndo) rowwiseRestore(this.b, cat, targets);
    else setBasedRestore(this.b, cat, targets);
  }

  /**
   * 文を実行し、書き込み文なら行の変更に落とす。書き込み文は必ず rollback の中で呼ぶ。
   * 文の意味は SQLite が解釈し、変更行は trigger が捕捉するので、UPSERT や
   * INSERT ... SELECT のような構文でも Worker 側で解析する必要がない。
   */
  private run(sec: Section<"owned">, req: ExecReq): { columns: string[]; values: Value[][]; changes: Change[]; count?: number; bytes?: number; over?: boolean } {
    const out = this.checked(sec, req, () => this.runStatement(req));
    // 取引の文は、ここでは変更を返すだけで、確定のときにもう一度確かめられる (assertWriteSetFits)。
    // ここでも断るのは、COMMIT まで待たずに、文の時点で伝えるためである。
    this.assertUnlocked(out.changes);
    return out;
  }

  /**
   * 範囲の検査 (試験用)。範囲の外の行を消した状態で同じ文を実行し、全部の行がある状態と結果を比べる。
   * 結果が違えば、文は宣言していない行を読んでいる。そういう行は intent の決着も commit の検証も受けない。
   * どの文の形にも同じ検査が掛かるので、範囲の作り方を文の形ごとに確かめなくてよい。
   *
   * 要求の文は、run か、ここを通して実行する。同期区間の印を受け取るのは、区間に入っていない入口が文を実行できないように
   * するためである。
   */
  private checked<T>(_sec: Section<"owned">, req: ExecReq, exec: () => T): T {
    const report = this.deps.spanEscape;
    if (!report || this.checking) return exec();
    this.checking = true;
    try {
      const probe = (): string => {
        try {
          return encode(exec());
        } catch (e) {
          return `error: ${e === FALLBACK ? "fallback" : ((e as Error)?.message ?? String(e))}`;
        }
      };
      const narrowed = this.rollback(() => (this.deleteOutside(req) ? probe() : null));
      if (narrowed !== null) {
        const full = this.rollback(probe);
        // random() などで実行のたびに結果が変わる文は、比べても意味がない。同じ状態で 2 回実行して確かめる。
        const stable = full === this.rollback(probe);
        if (stable && full !== narrowed) report({ shard: this.id, sql: req.sql, params: req.params, spans: req.spans, full, narrowed });
      }
    } finally {
      this.checking = false;
    }
    return exec();
  }
  private checking = false;

  /** 範囲の外の行を、利用者の表と index の表から消す。行が多すぎて検査を省くときは false を返す。 */
  private deleteOutside(req: ExecReq): boolean {
    const own = new Set((req.overlay ?? []).map((c) => `${c.table}\0${c.pk}`));
    const doomed: { def: TableDef; pk: string }[] = [];
    let seen = 0;
    for (const def of this.defs.values()) {
      const spans = req.spans.filter((s) => s.table === def.name || s.table === "*");
      // 条件の span は、条件に合う行の主キーを先に求める。
      const matching = spans.flatMap((s) => {
        if (s.kind !== "pred") return [];
        const keys = this.b.exec(`SELECT ${selectList(def)} FROM ${q(def.name)} AS ${q(s.alias)} WHERE (${s.where})`, ...s.params)
          .map((row) => encodeKey(def, row)).filter((k) => s.sk === undefined || s.sk === k.sk);
        return [new Set(keys.map((k) => k.pk))];
      });
      for (const row of this.b.exec(`SELECT ${selectList(def)} FROM ${q(def.name)}`)) {
        if (++seen > SPAN_CHECK_MAX_ROWS) return false;
        const key = encodeKey(def, row);
        // 取引が自分で書いた行は、ほかの取引から守る必要がないので、範囲に入っていなくてよい。
        if (own.has(`${def.name}\0${key.pk}`)) continue;
        const covered = spans.some((s) => s.kind !== "pred" && spanCovers(s, def.name, key.pk, key.sk)) || matching.some((m) => m.has(key.pk));
        if (!covered) doomed.push({ def, pk: key.pk });
      }
    }
    for (const d of doomed) deleteRow(this.b, d.def, d.pk);
    return true;
  }

  private runStatement(req: ExecReq): { columns: string[]; values: Value[][]; changes: Change[]; count?: number; bytes?: number; over?: boolean } {
    if (!req.write) return { ...this.readLimited(req), changes: [] };
    const captured = this.runCaptured(req);
    if (captured) return captured;
    // REPLACE が暗黙に消す行は recursive_triggers がないと DELETE trigger を発火しない。
    this.b.exec(`PRAGMA recursive_triggers = ON`);
    this.b.exec(`INSERT INTO __cap_on VALUES (1)`);
    const out = this.b.raw(req.sql, ...req.params);
    // 文が変更した行の数は、SQLite に尋ねる。捕捉した変更の数とは違う。REPLACE が消した行は、SQLite は数えない。
    // 捕捉のための trigger の中の書き込みは、changes() に入らない。
    const count = this.b.exec(`SELECT changes() AS n`)[0]!.n as number;
    const changes = capturedChanges(this.b, (t) => this.def(t));
    const sk = req.write.sk;
    if (sk !== null) {
      for (const c of changes) {
        if (c.sk !== sk) throw new SqlError(`row of shard key ${c.sk} written through shard key ${sk}`);
      }
    }
    return { ...out, changes, count };
  }

  /** 読み取りの文を実行し、上限を超えた時点で打ち切る。全行を集めてから数えると、数える前にメモリが尽きる。 */
  private readLimited(req: ExecReq): { columns: string[]; values: Value[][]; bytes?: number; over?: boolean } {
    const maxRows = Math.min(req.maxRows ?? SHARD_MAX_ROWS, SHARD_MAX_ROWS);
    const maxBytes = Math.min(req.maxBytes ?? SHARD_MAX_BYTES, SHARD_MAX_BYTES);
    const { columns, rows } = this.b.iterate(req.sql, ...req.params);
    const values: Value[][] = [];
    let bytes = 0;
    for (const row of rows) {
      values.push(row);
      for (const v of row) bytes += sizeOf(v);
      if (values.length > maxRows) throw new SqlError(`result too large: more than ${maxRows} rows from one shard; narrow the query`);
      if (bytes > maxBytes) {
        // 予算を配り直す読みは、拒否せずに溢れたことだけを返す。Worker が残りの予算で読み直すか、合計で断る。
        if (req.budgeted) return { columns, values: [], bytes, over: true };
        throw new SqlError(`result too large: more than ${maxBytes} bytes from one shard; narrow the query or select fewer columns`);
      }
    }
    return req.maxBytes !== undefined ? { columns, values, bytes } : { columns, values };
  }

  /**
   * Worker から届いた文を、DO の SQLite の上限で測る。超える文は、何も読まず書かずに ShardLimit で断る。Worker はそれを受けて、
   * 文を基準経路で実行し直す (src/shard-limits.ts、計画書の不変条件 13)。
   */
  private withinLimits(req: Pick<ExecReq, "sql" | "params">): void {
    const over = shardLimitOf(req.sql, req.params ?? []);
    if (over) throw new ShardLimit(over);
  }

  /** 時刻 T の状態 (と自分の未 commit write) の上で文を実行し、ROLLBACK する。 */
  async exec(req: ExecReq): Promise<ExecRes> {
    this.withinLimits(req);
    await this.ensureSchema(req.schema);
    if (req.lock && (req.write || req.lockRows)) {
      try {
        return await this.lockedExec(req, req.lock);
      } catch (e) {
        if (e instanceof ReadTooOld || e instanceof ConflictError || e instanceof NotOwner || e instanceof ShardLimit) throw e;
        throw asSqlError(e);
      }
    }
    if (req.lock) this.renew(req.lock.txn);
    await this.ensureArrived(this.sksOf(req.spans));
    this.observe(req.minTs);
    let T = req.T ?? this.issue();
    this.observe(T);
    this.assertOwned({ spans: req.spans, writes: [], at: T });
    let applied = await this.settleIntents(req.spans, T);
    // 時刻が未指定の読みは、決着させた取引より後の時刻で読む。先に取った T のままだと、
    // 読み取りの開始前に確定した書き込みが見えない。push した取引の c が新しい T 以下になり得るので、
    // 決着が起きなくなるまで取り直す。
    while (req.T === undefined && applied) {
      T = this.issue();
      applied = await this.settleIntents(req.spans, T);
    }
    // T を指定した autocommit の読み (複数シャードの読み) も同じである。T は対象シャードの時計の最大値だが、
    // phase 2 が届いていない参加者の時計は commit 時刻に追いついていない。anchor の時計が進んでいると c > T になり、
    // そのまま T で読むと、開始前に確定して応答まで返った書き込みが見えない。T を取り直させる。
    if (req.T !== undefined && req.realtime && applied > T && !this.faults.noRealtimeBump) throw new ReadTooOld(`moved at ${this.hlc.value}`);
    // ここから先は await を挟まない。版は確かめ直さない。intent の決着を待っている間に DDL が適用されると、この文は古い計画の
    // まま実行される。取引の文の変更は、取引の確定 (commitLocal、prepare、commit) が版を確かめる。
    const sec = this.enter({ spans: req.spans, writes: [], at: T });
    this.count(req.write ? "writes" : "reads", req.spans);
    if (req.fresh && req.spans.some((s) => this.changedSince(sec, s, T))) {
      throw new ReadTooOld(`moved at ${this.hlc.value}`);
    }
    const delta = this.deltaAfter(T);
    const overlay = (req.overlay ?? []).map((c) => ({ table: c.table, pk: c.pk, image: c.after }));
    try {
      if (delta.length === 0 && overlay.length === 0 && !req.write) {
        // 差分がなければ本体がそのまま T の状態なので、トランザクションは要らない。
        return { ...this.run(sec, req), T, hlc: this.hlc.value, epoch: this.epoch };
      }
      const out = this.rollback(() => {
        this.restore(delta);
        if (overlay.length) setBasedRestore(this.b, (t) => this.def(t), overlay);
        return this.run(sec, req);
      });
      return { ...out, T, hlc: this.hlc.value, epoch: this.epoch };
    } catch (e) {
      if (e instanceof ReadTooOld || e instanceof ConflictError || e instanceof NotOwner || e instanceof ShardLimit) throw e;
      // 文は T の状態を読んだうえで失敗した。読んだ時刻を付けて返し、呼び出し側に範囲を記録させる。
      return { columns: [], values: [], changes: [], error: asSqlError(e).message, T, hlc: this.hlc.value, epoch: this.epoch };
    }
  }

  /** シングルシャードの autocommit 書き込み。1 回の RPC で完結する。 */
  async execAuto(req: ExecReq): Promise<ExecRes> {
    this.withinLimits(req);
    await this.ensureSchema(req.schema);
    await this.ensureArrived(this.sksOf(req.spans));
    this.observe(req.minTs);
    const now = this.issue();
    // 最新の状態に書くので、読む時刻はない。
    const claim: Plan & Rows = { schema: req.schema, spans: req.spans, writes: [], at: null };
    this.assertOwned(claim);
    await this.settleIntents(req.spans, now);
    let sec = this.enter(claim);
    this.count("writes", req.spans);
    // 読む範囲に未決着の intent があると commit 時刻の順序を保証できないので no-wait で返す。
    if (!this.faults.ignoreIntentsInValidation && this.overlapping(req.spans, Number.MAX_SAFE_INTEGER).length > 0) {
      throw new ConflictError("pending intent");
    }
    try {
      if (req.write?.capture && !this.faults.triggerCapture) {
        const direct = await this.execDirect(sec, req, claim, now);
        if (direct) return direct;
        // execDirect の応答を受け取るまでに、制御を 1 回手放している (microtask)。ここでは区間に入り直さず、下の下書きは、手放す前の
        // 印で実行する。版は、確定の直前に確かめ直す。持ち主は確かめ直さない。
      }
      let dry = this.rollback(() => this.run(sec, req));
      // autocommit は取引より若いものとして順番を待つ。待っている間に行が変わるので実行し直す。
      const me: LockOwner = { txn: `auto-${now}`, start: this.deps.clock.now() };
      const deadline = this.deps.clock.now() + LOCK_WAIT_MS;
      // autocommit はロックを取らないので、起こされたら用が済み次第次の待ち手を起こす。
      const woken = new Set<string>();
      try {
        for (let key = this.blockedBy(dry.changes, me); key !== null; key = this.blockedBy(dry.changes, me)) {
          await this.waitForRow(key, me, deadline);
          woken.add(key);
          sec = this.enter(claim);
          if (this.overlapping(req.spans, Number.MAX_SAFE_INTEGER).length > 0) throw new ConflictError("pending intent");
          dry = this.rollback(() => this.run(sec, req));
        }
      } finally {
        for (const key of woken) queueMicrotask(() => this.wakeNext(key));
      }
      // 同じ主キーでなくても、他の取引の intent が同じ UNIQUE の値を持っていれば確定できない。
      const pending = this.faults.autoIgnoresUniqueIntents ? null : this.uniquePending(me.txn, dry.changes);
      if (pending) throw new ConflictError(pending);
      this.assertWriteSetFits(sec, dry.changes);
      // 下書きを取った区間の続きで、間に await はない。execDirect が null を返した後の道では、制御を手放した後の確かめ直しは、
      // これだけである。
      this.enter({ schema: req.schema });
      const c = this.issue();
      if (dry.changes.length) this.b.tx(() => this.applyAndLog(`auto-${c}`, c, dry.changes));
      return { ...dry, T: c, hlc: this.hlc.value, epoch: this.epoch };
    } catch (e) {
      if (e instanceof ConflictError || e instanceof NotOwner) throw e;
      throw asSqlError(e);
    }
  }

  /**
   * 書き込み文を実行し、変更行を trigger ではなく RETURNING と主キーの読みで捕捉する。
   * trigger の捕捉は __cap、__capv、__cap_on へ書くので、ROLLBACK しても 1 文あたり 3 行が課金される。
   * 文の形が想定と合わなければ、その文だけを巻き戻して null を返す。呼び出し側は trigger の経路に任せる。
   */
  private runCaptured(req: ExecReq): { columns: string[]; values: Value[][]; changes: Change[] } | null {
    const capture = req.write?.capture;
    const span = req.spans[0];
    // 2 つ目以降の範囲は、同じ表の、UNIQUE の検査で読む行だけである (spans.ts の規則 3)。ほかの表を読む文は、ここでは扱わない。
    if (!capture || this.faults.triggerCapture || !span || req.spans.some((s) => s.table !== span.table)) return null;
    if (capture === "update" && span.kind !== "pk") return null;
    const def = this.def(span.table);
    // RETURNING で行を読むと文が長くなる (列ごとに typeof と 2^53 の確かめ)。DO の SQLite の上限を超えるなら、文をそのまま
    // 実行する trigger の捕捉に任せる。入口の確かめ (withinLimits) は、受け取った文を測っている (Codex の 2 回目の見直し、指摘 7)。
    if (!withinShardLimits(`${req.sql} RETURNING ${imageList(def)}`, req.params)) return null;
    const sk = req.write!.sk;
    try {
      return this.b.tx(() => {
        const before = span.kind === "pk" && capture === "update" ? selectRow(this.b, def, span.pk) : null;
        const was = before && encodeKey(def, before).pk;
        const rows = this.b.exec(`${req.sql} RETURNING ${imageList(def)}`, ...req.params).map((r) => typedRow(def, r));
        if (capture === "update" && (rows.length > 1 || (rows.length === 1 && was !== encodeKey(def, rows[0]!).pk))) {
          throw FALLBACK;
        }
        if (capture !== "delete") for (const row of rows) assertKeyed(def, row);
        const changes: Change[] = rows.map((row) => ({
          table: def.name, ...encodeKey(def, row),
          before: capture === "insert" ? null : capture === "delete" ? row : before,
          after: capture === "delete" ? null : row,
        }));
        if (sk !== null) {
          for (const c of changes) {
            if (c.sk !== sk) throw new SqlError(`row of shard key ${c.sk} written through shard key ${sk}`);
          }
        }
        return { columns: [], values: [], changes };
      });
    } catch (e) {
      if (e === FALLBACK) return null;
      throw e;
    }
  }

  /**
   * autocommit の高速経路。文を下書きせずに 1 回だけ実行し、そのまま確定する。
   * ROLLBACK した書き込みも課金されるので、下書きと再適用をやめると 1 行の更新が 6 行から 2 行になる。
   * 行ロックに当たったときだけ ROLLBACK して待つ。捕捉できない形なら null を返し、通常の経路に任せる。
   *
   * execAuto が、同期区間の中で呼ぶ。最初の実行は、その区間の印 (sec) で行う。行ロックを待った後は、同じ claim で区間に入り直す。
   */
  private async execDirect(sec: Section<Check>, req: ExecReq, claim: Plan & Rows, now: Ts): Promise<ExecRes | null> {
    const me: LockOwner = { txn: `auto-${now}`, start: this.deps.clock.now() };
    const deadline = this.deps.clock.now() + LOCK_WAIT_MS;
    const woken = new Set<string>();
    try {
      for (;;) {
        const hit: { key: string | null } = { key: null };
        const pending: { reason: string | null } = { reason: null };
        let out: { changes: Change[]; c: Ts } | undefined;
        try {
          out = this.b.tx(() => {
            const r = this.checked(sec, req, () => this.runCaptured(req));
            if (!r) throw FALLBACK;
            hit.key = this.blockedBy(r.changes, me);
            if (hit.key !== null) throw BLOCKED;
            pending.reason = this.faults.autoIgnoresUniqueIntents ? null : this.uniquePending(me.txn, r.changes);
            if (pending.reason) throw PENDING_UNIQUE;
            this.assertWriteSetFits(sec, r.changes);
            const c = this.issue();
            if (r.changes.length) this.logChanges(`auto-${c}`, c, r.changes);
            return { changes: r.changes, c };
          });
        } catch (e) {
          if (e === FALLBACK) return null;
          if (e === PENDING_UNIQUE) throw new ConflictError(pending.reason!);
          if (e !== BLOCKED) throw e;
        }
        if (out) return { columns: [], values: [], changes: out.changes, T: out.c, hlc: this.hlc.value, epoch: this.epoch };
        await this.waitForRow(hit.key!, me, deadline);
        woken.add(hit.key!);
        sec = this.enter(claim);
        if (this.overlapping(req.spans, Number.MAX_SAFE_INTEGER).length > 0) throw new ConflictError("pending intent");
      }
    } finally {
      for (const key of woken) queueMicrotask(() => this.wakeNext(key));
    }
  }

  private intentAt(table: string, pk: string): Intent | undefined {
    return this.b.exec(`SELECT * FROM __intents WHERE tbl = ? AND pk = ?`, table, pk)[0] as unknown as Intent | undefined;
  }

  // ---- 検証 ----

  private touch(table: string, pk: string, sk: string, ts: Ts): void {
    for (const k of [`p\0${table}\0${pk}`, `s\0${table}\0${sk}`, `t\0${table}`, `s\0*\0${sk}`, `t\0*`]) {
      if ((this.recent.get(k) ?? 0) < ts) this.recent.set(k, ts);
    }
  }

  /**
   * from より後の write があるか。to より後の write も含むので保守的に abort する側へ倒れる。
   * 答えは、範囲をこのシャードが持っているときだけ意味がある。だから、持ち主を確かめた同期区間の印を受け取る。
   */
  private changedSince(_sec: Section<"owned">, span: Span, from: Ts): boolean {
    const key =
      span.kind === "pk" ? `p\0${span.table}\0${span.pk}`
      : span.kind === "sk" ? `s\0${span.table}\0${span.sk}`
      : span.kind === "pred" && span.sk ? `s\0${span.table}\0${span.sk}`
      : `t\0${span.table}`;
    // 索引を捨てた時点より前からは、書き込みがなかったとは言えない。検証も読み直しの確認も、ここで失敗させる。
    if (from < this.recentLowWater) return true;
    if ((this.recent.get(key) ?? 0) <= from) return false;
    return span.kind === "pred" ? this.predicateChanged(span, from) : true;
  }

  /**
   * 検証に失敗したら理由を返す。`unique:` で始まる理由はリトライしても通らない。
   * 通った取引は、このまま確定するか intent を置く。だから、版と持ち主の両方を確かめた同期区間の印を受け取る。
   */
  private validate(sec: Section<Check>, txn: string, T: Ts, writes: Change[], spans: Span[]): string | null {
    if (T < this.logLowWater || T < this.recentLowWater) return "T older than conflict window";
    const inf = Number.MAX_SAFE_INTEGER;
    for (const w of writes) {
      const held = this.intentAt(w.table, w.pk);
      if (held && held.txn !== txn) return `intent on ${w.table} ${w.pk}`;
      // prepare は待たない。待つと、prepare 済みの取引を待つ DML との間に閉路ができる。
      const lock = this.liveLock(this.lockKey(w.table, w.pk));
      if (lock && lock.txn !== lockIdOf(txn)) return `row locked by ${lock.txn}`;
      // ロックを持っていても検証は省かない。ロックは再起動、TTL、wound で消えているかもしれない。
      const since = this.faults.validateFromT ? T : (w.since ?? T);
      const trusted = this.faults.trustLocks && w.since !== undefined;
      if (!trusted && this.changedSince(sec, { kind: "pk", table: w.table, pk: w.pk, sk: w.sk }, since)) return `write after T on ${w.pk}`;
      const def = this.def(w.table);
      const row = selectRow(this.b, def, w.pk);
      if (row && w.before === null) return `unique: ${w.table} ${w.pk}`;
    }
    for (const s of spans) {
      if (this.faults.trustLocks && s.since !== undefined) continue;
      if (this.changedSince(sec, s, this.faults.validateFromT ? T : (s.since ?? T))) return `span changed after T`;
      if (this.faults.ignoreIntentsInValidation) continue;
      const hit = this.overlapping([s], inf).find((i) => i.txn !== txn);
      if (hit) return `intent inside read span (${hit.txn})`;
    }
    return this.checkUnique(txn, writes);
  }

  /** シャード内 UNIQUE。本体は SQLite に試適用して、未確定の値は intent と比べて確かめる。 */
  /**
   * 他の取引の intent が、同じ UNIQUE の値を持つ行を書こうとしているか。
   * intent は本体にないので、SQLite の制約では見つからない。見逃すと、確定済みの取引の phase 2 が
   * UNIQUE 違反で適用できなくなり、再駆動が永久に失敗する。書き込みの経路はすべてこれを通す。
   */
  private uniquePending(txn: string, writes: Change[]): string | null {
    const constrained = writes.filter((w) => this.hasUniqueBeyondKey(w.table));
    if (!constrained.some((w) => w.after)) return null;
    // 衝突し得るのは、同じ表の、同じ shard key の値 (グループ) の行だけである。シャードの中の UNIQUE は、shard key の列を
    // すべて含む (sql/ddl.ts が、含まないものをシャードをまたぐ index にするか断る)。shard key の列の照合順序は BINARY なので、
    // 同じグループかはキー文字列の一致で決まる。絞らないと、試しに適用する intent が、そのシャードのその表の未確定の取引の数だけ
    // 増え、巻き戻した書き込みも課金される (未解決の問題 6)。
    const groups = new Set(constrained.map((w) => `${w.table}\0${w.sk}`));
    const others = (this.b.exec(`SELECT * FROM __intents WHERE txn <> ?`, txn) as unknown as Intent[])
      .filter((i) => groups.has(`${i.tbl}\0${i.sk}`))
      .map((i) => decode<Change>(i.change));
    if (others.length === 0) return null;
    // 値を自前で比べない。照合順序、BLOB、部分 index の条件まで SQLite と同じに判定するのは難しく、外すと適用できない取引が残る。
    // ほかの取引の intent をすべて適用した状態を作り、そこへこの取引の変更を入れて、SQLite に判定させる。
    // intent のない状態との衝突は、呼び出し側が本体への試適用か実際の実行で確かめている。行ごとに見れば、相手は本体の版か intent の版の
    // どちらかなので、この 2 つの状態で通れば、どの intent が確定しても衝突しない。
    try {
      this.rollback(() => {
        setBasedRestore(this.b, (t) => this.def(t), others.map((o) => ({ table: o.table, pk: o.pk, image: o.after })));
        setBasedRestore(this.b, (t) => this.def(t), constrained.map((w) => ({ table: w.table, pk: w.pk, image: w.after })));
      });
      return null;
    } catch (e) {
      return `unique pending: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  /**
   * 取引がこのシャードに書く変更を、確定の前に確かめる。書き込みは、取引でも autocommit でも、必ずここを通る。
   *   表が書き込み禁止でないこと。index を既存の行から作っている間、その表の行は変わってはならない。
   *   変更ログの 1 行に収まること。
   * 書き込み禁止の印は表定義にあるので、要求の版が現行であることを確かめた同期区間の印を受け取る。
   */
  private assertWriteSetFits(_sec: Section<"schema">, writes: Change[]): void {
    this.assertUnlocked(writes);
    if (this.faults.noWriteSetLimit || writes.length === 0) return;
    let bytes = 0;
    for (const w of writes) {
      bytes += utf8Length(encode(w));
      if (bytes > MAX_WRITE_SET_BYTES) {
        throw new SqlError(`transaction too large: it changes more than ${MAX_WRITE_SET_BYTES} bytes of rows on one shard; split it into smaller transactions`);
      }
    }
  }

  /** 書き込む表が、表定義の変更で書き込み禁止になっていないか。 */
  private assertUnlocked(writes: Pick<Change, "table">[]): void {
    if (this.faults.ignoreTableLock) return;
    for (const w of writes) {
      const def = this.defs.get(w.table);
      if (def?.building) throw new TableLocked(w.table, `CREATE INDEX ${def.building.name}`);
      if (def?.locked) throw new TableLocked(w.table, def.locked);
    }
  }

  /** 主キーが違っても衝突し得る表か。UNIQUE index のある表である。 */
  private hasUniqueBeyondKey(table: string): boolean {
    return this.def(table).uniques.length > 0;
  }

  private checkUnique(txn: string, writes: Change[]): string | null {
    const constrained = writes.filter((w) => this.hasUniqueBeyondKey(w.table));
    if (constrained.length === 0) return null;
    const pending = this.uniquePending(txn, constrained);
    if (pending) return pending;
    try {
      this.rollback(() => applyChanges(this.b, (t) => this.def(t), constrained));
      return null;
    } catch (e) {
      return `unique: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  // ---- 書き込み ----

  private applyAndLog(txn: string, c: Ts, changes: Change[]): void {
    const logged = changes.map((ch) => {
      const before = selectRow(this.b, this.def(ch.table), ch.pk);
      return { ...ch, before };
    });
    applyChanges(this.b, (t) => this.def(t), logged);
    this.logChanges(txn, c, logged);
  }

  /** 本体へ適用済みの変更を変更ログと直近 write の索引へ記録する。 */
  private logChanges(txn: string, c: Ts, logged: Change[]): void {
    this.logInsert(c, txn, encode(logged));
    this.maxCommit = Math.max(this.maxCommit, c);
    for (const ch of logged) this.touch(ch.table, ch.pk, ch.sk, c);
    this.pruneRecent();
  }

  /** 索引が膨らんだら捨てて low-water を上げる。それより古い T の取引は保守的に abort する。 */
  private pruneRecent(): void {
    if (this.recent.size < (this.deps.recentMax ?? 200_000)) return;
    this.recentLowWater = this.hlc.value;
    this.recent.clear();
  }

  async commitLocal(req: Omit<PrepareReq, "anchor">): Promise<CommitRes> {
    await this.ensureSchema(req.schema);
    await this.ensureArrived(this.sksOf(req.spans, req.writes));
    if (this.faults.prepareWaits) await this.waitForForeignLocks(req.txn, req.writes);
    // グループの到着を待っている間に DDL が適用されることがある。古い計画のまま書かない。
    // 時計は、版を確かめた後、持ち主を確かめる前に進める。版の古い要求の T は、時計に取り込まない。
    this.enter({ schema: req.schema });
    this.observe(req.T);
    const sec = this.enter({ schema: req.schema, spans: req.spans, writes: req.writes, at: req.T });
    try {
      this.assertWriteSetFits(sec, req.writes);
    } catch (e) {
      this.releaseLocks(req.txn);
      throw e;
    }
    const reason = this.validate(sec, req.txn, req.T, req.writes, req.spans);
    if (reason) {
      this.releaseLocks(req.txn); // 失敗した取引のロックを残すと、TTL まで全員が待つ
      return { ok: false, reason };
    }
    const c = this.issue();
    if (req.writes.length) this.b.tx(() => this.applyAndLog(req.txn, c, req.writes));
    this.releaseLocks(req.txn);
    this.count("writes", req.spans, req.writes);
    return { ok: true, c };
  }

  async prepare(req: PrepareReq): Promise<PrepareRes> {
    await this.ensureSchema(req.schema);
    await this.ensureArrived(this.sksOf(req.spans, req.writes));
    if (this.faults.prepareWaits) await this.waitForForeignLocks(req.txn, req.writes);
    return this.prepareSync(this.enter({ schema: req.schema }), req);
  }

  /**
   * prepare の同期区間。呼び出し側 (prepare と、anchor の drive) が、版を確かめて区間に入ってから呼ぶ。
   * 持ち主は、ここで確かめる。再送への答えと、書き込みの大きさの確認が、その前に来るからである。
   */
  private prepareSync(plan: Section<"schema">, req: PrepareReq): PrepareRes {
    const dup = this.b.exec(`SELECT prepare_ts FROM __intents WHERE txn = ? LIMIT 1`, req.txn)[0];
    // 同じ 2PC の ID の intent がもうある。ID は続きの中身の指紋を含むので、同じ書き込みの prepare の再送である。同じ答えを返す。
    if (dup) return { ok: true, prepareTs: dup.prepare_ts as Ts };
    // phase 2 で初めて上限に当たると、確定した取引が適用できなくなる。intent を置く前に拒否する。
    try {
      this.assertWriteSetFits(plan, req.writes);
    } catch (e) {
      this.releaseLocks(req.txn);
      return { ok: false, reason: (e as Error).message };
    }
    this.observe(req.T);
    let sec: Section<Check>;
    try {
      sec = this.enter({ schema: req.schema, spans: req.spans, writes: req.writes, at: req.T });
    } catch (e) {
      // 参加者が非オーナーなら取引は abort で、Worker が経路を更新して再実行する。
      this.releaseLocks(req.txn);
      return { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
    this.count("writes", req.spans, req.writes);
    const reason = this.validate(sec, req.txn, req.T, req.writes, req.spans);
    if (reason) {
      this.releaseLocks(req.txn);
      return { ok: false, reason };
    }
    const prepareTs = this.issue();
    if (req.writes.length) {
      this.b.tx(() => {
        for (const w of req.writes) {
          this.b.exec(
            `INSERT INTO __intents(tbl, pk, sk, txn, anchor, prepare_ts, change) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            w.table, w.pk, w.sk, req.txn, req.anchor, prepareTs, encode(w),
          );
        }
      });
    }
    this.releaseLocks(req.txn); // 以後は intent が同じ行を守る
    // anchor が決着を送り損ねても、参加者が自分で決着させる。
    this.deps.scheduleRedrive?.();
    return { ok: true, prepareTs };
  }

  async refresh(req: { txn: string; spans: Span[]; from: Ts; to: Ts }): Promise<{ ok: boolean; reason?: string }> {
    // 先に HLC を to まで進める。これ以後に置かれる intent は prepare_ts > to になる。
    if (!this.faults.refreshNoBump) this.observe(req.to);
    // DDL や変更ログの切り詰めより古い窓は、変更の有無を確かめられない。
    if (req.from < this.ddlFloor || req.from < this.logLowWater) return { ok: false, reason: "refresh: window too old" };
    let sec: Section<"owned">;
    try {
      // from より後に移動してきたグループは、親での変更を確かめられないので abort する。
      sec = this.enter({ spans: req.spans, writes: [], at: req.from });
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
    for (const s of req.spans) {
      if (this.changedSince(sec, s, Math.max(req.from, s.since ?? 0))) return { ok: false, reason: "refresh: span changed" };
      if (this.faults.ignoreIntentsInValidation) continue;
      const hit = this.overlapping([s], req.to).find((i) => i.txn !== req.txn);
      if (hit) return { ok: false, reason: `refresh: intent ${hit.txn}` };
    }
    return { ok: true };
  }

  /**
   * 表を消す前の確認 (Db の guardedDrop、specs/m14_rebuild_guard.qnt)。
   * 先に、表を書き込み禁止にする版を適用する。適用の前に intent を全部決着させ、適用の後は、その表への書き込みを断る。
   * だから、ここで変更がなければ、表を消すまで、読んだ範囲は変わらない。
   */
  async unchanged(req: { spans: Span[]; from: Ts; schema: number }): Promise<{ ok: boolean; reason?: string }> {
    let sec: Section<"owned">;
    try {
      await this.ensureSchema(req.schema);
      sec = this.enter({ spans: req.spans, writes: [], at: req.from });
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
    for (const s of req.spans) {
      if (this.changedSince(sec, s, Math.max(req.from, s.since ?? 0))) return { ok: false, reason: `${s.table} changed after it was read` };
      // 版の適用は intent を決着させてから行う (settleAllIntents) が、それに頼らず、決着していない書き込みも変更として数える。
      const hit = this.faults.unchangedIgnoresIntents ? undefined : this.overlapping([s], Number.MAX_SAFE_INTEGER)[0];
      if (hit) return { ok: false, reason: `${s.table} has a pending write of ${hit.txn}` };
    }
    return { ok: true };
  }

  async commit(req: CommitReq): Promise<CommitRes> {
    await this.ensureSchema(req.schema);
    // 同じ 2PC の ID の実行は 1 つずつにする。同じ中身の COMMIT が 2 つ同時に届くと (再送が元の COMMIT を追い越す)、後の実行の
    // prepare は、先の実行が適用した行に当たって断られ、中止の abort(ID) が先の実行の残りの intent を消した
    // (specs/m17_txn_id_reuse.qnt の m17_red_resend、2026-11-13 の Codex の 2 回目の見直し、指摘 1)。先の実行が終わるのを待って
    // から記録を確かめ、待ち終えてから実行を登録するまで await を挟まない。
    for (let f = this.inflight.get(req.txn); f && !this.faults.concurrentDrives; f = this.inflight.get(req.txn)) await f.settled;
    // 2PC の ID は、取引の ID と続きの中身の指紋である (Txn.commit)。同じ ID の記録があるのは、同じ中身の COMMIT の再送なので、
    // 前の結果を返す。baton の使い回しでできた中身の違う続きは、別の ID の別の 2PC になる。
    const done = this.b.exec(`SELECT status, c FROM __txn WHERE txn = ?`, req.txn)[0];
    if (done) return done.status === "committed" ? { ok: true, c: done.c as Ts } : { ok: false, reason: "aborted" };
    // 決着の記録は保持時間の後に消す。消した tombstone の後に同じ取引の COMMIT が届いて確定すると、
    // 中止と判断して intent を無視した読み手と矛盾する (specs/m10_txn_record_gc.qnt の反例)。
    // 保持時間の半分より古い取引の COMMIT を受け付けなければ、消した後に確定することはない。
    if (this.deps.clock.now() - tsToPhysical(req.T) > (this.deps.txnRetainMs ?? TXN_RETAIN_MS) / 2) {
      return { ok: false, reason: "conflict: transaction older than the commit window" };
    }
    let settle = () => {};
    const settled = new Promise<void>((r) => (settle = r));
    const flight: InFlight = { pushed: 0, decided: false, settled, settle };
    this.inflight.set(req.txn, flight);
    try {
      const me = req.participants.find((p) => p.shard === this.id);
      if (me) await this.ensureArrived(this.sksOf(me.spans, me.writes));
      return await this.drive(req, flight);
    } finally {
      this.inflight.delete(req.txn);
      flight.settle();
    }
  }

  private async drive(req: CommitReq, flight: InFlight): Promise<CommitRes> {
    const self = req.participants.find((p) => p.shard === this.id);
    if (!self) throw new SqlError("anchor must be a participant");
    let others = req.participants.filter((p) => p.shard !== this.id);
    if (this.faults.skipReadOnlyPrepare) others = others.filter((p) => p.writes.length > 0);

    const acks = await Promise.all(
      others.map((p) =>
        this.deps.peer(p.shard).prepare({
          txn: req.txn, T: req.T, writes: p.writes, spans: p.spans, anchor: this.id, schema: req.schema,
        }),
      ),
    );
    const failed = acks.find((a) => !a.ok);
    if (failed && !failed.ok) return this.decideAbort(req, failed.reason);
    const stamps = acks.map((a) => (a as { prepareTs: Ts }).prepareTs);
    if (this.faults.prepareWaits) await this.waitForForeignLocks(req.txn, self.writes);

    // ここから c の確定までは await を挟まない。
    // 参加者の応答を待っている間に、この anchor に DDL が適用されていれば、取引は古い表定義で計画されている。
    let plan: Section<"schema">;
    try {
      plan = this.enter({ schema: req.schema });
    } catch (e) {
      return this.decideAbort(req, (e as Error).message);
    }
    if (!this.faults.anchorNoAbsorb) this.observe(Math.max(0, ...stamps, flight.pushed));
    const mine = this.prepareSync(plan, {
      txn: req.txn, T: req.T, writes: self.writes, spans: self.spans, anchor: this.id, schema: req.schema,
    });
    if (!mine.ok) return this.decideAbort(req, mine.reason);
    const c = this.faults.anchorNoAbsorb
      ? Math.max(mine.prepareTs, ...stamps, flight.pushed + 1)
      : mine.prepareTs;
    flight.decided = true;

    const stale = others.flatMap((p, i) => {
      const spans = this.faults.predicateProtected
        ? p.spans.filter((s) => !p.writes.some((w) => w.table === s.table))
        : unprotectedSpans(p.spans, p.writes);
      return spans.length > 0 && stamps[i]! < c ? [{ p, spans, from: stamps[i]! }] : [];
    });
    const refreshed = await Promise.all(
      stale.map((s) => this.deps.peer(s.p.shard).refresh({ txn: req.txn, spans: s.spans, from: s.from, to: c })),
    );
    const bad = refreshed.find((r) => !r.ok);
    if (bad) return this.decideAbort(req, bad.reason ?? "refresh failed");

    this.b.exec(
      `INSERT INTO __txn(txn, status, c, participants, at) VALUES (?, 'committed', ?, ?, ?)`,
      req.txn, c, JSON.stringify(req.participants.map((p) => p.shard)), this.deps.clock.now(),
    );
    // record の確定を待ってから phase 2 と応答を送る。先に送ると、確定の前に再起動したとき、記録が消えて
    // 照会した参加者が tombstone を書き、phase 2 を受けた参加者とで決着が割れる (specs/m3_anchor_recovery.qnt の m3_red)。
    if (!this.faults.phase2BeforeSync) await this.b.sync();
    this.deps.scheduleRedrive?.();
    this.spawn(this.phase2(req.txn, c, req.participants));
    return { ok: true, c };
  }

  private decideAbort(req: CommitReq, reason: string): CommitRes {
    this.b.exec(`INSERT OR IGNORE INTO __txn(txn, status, done, at) VALUES (?, 'aborted', 1, ?)`, req.txn, this.deps.clock.now());
    // 記録が確定のまま残ったなら、同じ ID の別の実行が確定させている。abort を送るとその intent を消すので、送らずにその決着を
    // 答える (同じ ID は同じ中身なので、確定が正しい答えである)。実行を 1 つずつにしてあるので、ここには来ないはずの 2 つ目の守り
    // である (specs/m17_txn_id_reuse.qnt の ABORT_CHECKS)。
    const kept = this.decided(req.txn);
    if (kept?.status === "committed" && !this.faults.abortIgnoresRecord) return { ok: true, c: kept.c };
    for (const p of req.participants) {
      this.spawn(p.shard === this.id ? this.abort({ txn: req.txn }) : this.deps.peer(p.shard).abort({ txn: req.txn }));
    }
    return { ok: false, reason };
  }

  private async phase2(txn: string, c: Ts, participants: Pick<Participant, "shard">[]): Promise<void> {
    await this.finalize({ txn, c });
    await Promise.all(
      participants.filter((p) => p.shard !== this.id).map((p) => this.deps.peer(p.shard).finalize({ txn, c })),
    );
    this.b.exec(`UPDATE __txn SET done = 1 WHERE txn = ?`, txn);
  }

  private spawn(p: Promise<unknown>): void {
    const guarded = p.catch(() => {}); // 失敗は redrive が回収する。
    this.deps.background?.(guarded);
  }

  /** 移動済みグループの intent は親で適用しない。応答が飛行中だと、適用した分が子に届かず消えるからである。 */
  private localIntents(txn: string): Intent[] {
    const rows = this.b.exec(`SELECT * FROM __intents WHERE txn = ?`, txn) as unknown as Intent[];
    return this.faults.applyAfterMoved ? rows : rows.filter((r) => !this.moved.has(r.sk));
  }

  private forwards(txn: string): Map<string, string[]> {
    const out = new Map<string, string[]>();
    if (this.faults.applyAfterMoved) return out;
    for (const r of this.b.exec(`SELECT g, dest FROM __moved_txn WHERE txn = ?`, txn)) {
      out.set(r.dest as string, [...(out.get(r.dest as string) ?? []), r.g as string]);
    }
    return out;
  }

  async finalize(req: { txn: string; c: Ts; groups?: string[] }): Promise<void> {
    if (req.groups) await this.ensureArrived(req.groups);
    this.observe(req.c);
    const rows = this.localIntents(req.txn);
    if (rows.length) {
      this.b.tx(() => {
        this.applyAndLog(req.txn, req.c, rows.map((r) => decode<Change>(r.change)));
        for (const r of rows) this.b.exec(`DELETE FROM __intents WHERE tbl = ? AND pk = ?`, r.tbl, r.pk);
      });
    }
    this.releaseLocks(req.txn);
    for (const r of rows) this.wakeAll(this.lockKey(r.tbl, r.pk));
    for (const [dest, groups] of this.forwards(req.txn)) {
      await this.deps.peer(dest).finalize({ txn: req.txn, c: req.c, groups });
    }
  }

  async abort(req: { txn: string; groups?: string[] }): Promise<void> {
    if (req.groups) await this.ensureArrived(req.groups);
    this.releaseLocks(req.txn);
    for (const r of this.localIntents(req.txn)) {
      this.b.exec(`DELETE FROM __intents WHERE tbl = ? AND pk = ?`, r.tbl, r.pk);
      this.wakeAll(this.lockKey(r.tbl, r.pk));
    }
    for (const [dest, groups] of this.forwards(req.txn)) {
      await this.deps.peer(dest).abort({ txn: req.txn, groups });
    }
  }

  // ---- anchor への照会 ----

  private decided(txn: string): TxnStatus | null {
    const r = this.b.exec(`SELECT status, c FROM __txn WHERE txn = ?`, txn)[0];
    if (!r) return null;
    return r.status === "committed" ? { status: "committed", c: r.c as Ts } : { status: "aborted" };
  }

  async queryTxn(req: { txn: string; pushTo: Ts }): Promise<TxnStatus> {
    const known = this.decided(req.txn);
    if (known) return known;
    const flight = this.inflight.get(req.txn);
    // push は c の決定前だけ受理する。決定後に受理しても c は動かず、読み手が intent を誤って無視する。
    if (flight && (!flight.decided || this.faults.pushAfterDecide)) {
      flight.pushed = Math.max(flight.pushed, req.pushTo);
      return { status: "pushed" };
    }
    if (flight) {
      await flight.settled; // c の決定後は決着まで保留する。
      return this.decided(req.txn) ?? { status: "aborted" };
    }
    // 記録がなく in-flight でもない。presumed abort を tombstone で確定させる。
    this.b.exec(`INSERT OR IGNORE INTO __txn(txn, status, done, at) VALUES (?, 'aborted', 1, ?)`, req.txn, this.deps.clock.now());
    return this.decided(req.txn)!;
  }

  async status(req: { txn: string }): Promise<TxnStatus> {
    const flight = this.inflight.get(req.txn);
    if (flight) await flight.settled;
    return this.queryTxn({ txn: req.txn, pushTo: 0 });
  }

  // ---- 保守 ----

  /** alarm の本体。phase 2 の再駆動と、取り残された intent の掃除を行う。 */
  /**
   * 未完了の仕事が残っていれば true を返す。呼び出し側 (DO の alarm) は true なら次の alarm を予約する。
   * 参加者の intent は、anchor が再起動で決着を送り損ねると読み手が来るまで残る。残った intent は変更ログの GC を止めるので、
   * 読み手を待たずにここで決着させる。
   */
  /** 直近の redrive で失敗した処理の理由。運用の診断に使う。 */
  lastRedriveErrors: string[] = [];

  async redrive(): Promise<boolean> {
    let more = false;
    const errors: string[] = [];
    const attempt = async (fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch (e) {
        more = true;
        if (errors.length < 10) errors.push(String((e as Error)?.message ?? e).slice(0, 160));
      }
    };
    for (const r of this.b.exec(`SELECT txn, c, participants FROM __txn WHERE status = 'committed' AND done = 0`)) {
      const shards = JSON.parse(r.participants as string) as string[];
      await attempt(() => this.phase2(r.txn as string, r.c as Ts, shards.map((shard) => ({ shard }))));
    }
    for (const r of this.incoming) await attempt(() => this.drain({ start: r.start, end: r.end }));
    // 進行中の取引の intent には触れない。anchor がまだ決着を送っている最中かもしれないからである。
    const cutoff = physicalToTs(this.deps.clock.now() - ORPHAN_AGE_MS);
    const orphans = this.b.exec(`SELECT DISTINCT txn, anchor FROM __intents WHERE prepare_ts < ?`, cutoff) as unknown as Intent[];
    for (const o of orphans) {
      await attempt(async () => {
        const res = await this.ask(o.anchor, o.txn, 0);
        if (res.status === "committed") await this.finalize({ txn: o.txn, c: res.c });
        else if (res.status === "aborted") await this.abort({ txn: o.txn });
      });
    }
    const left = this.b.exec(`SELECT (SELECT count(*) FROM __intents) + (SELECT count(*) FROM __txn WHERE status = 'committed' AND done = 0) n`)[0]?.n as number;
    this.lastRedriveErrors = errors;
    return more || left > 0 || this.incoming.length > 0;
  }

  /** 分析パスへ渡す変更を読み出す。flushTs は未解決 intent の prepare_ts 未満に抑える。 */
  async flush(req: { upTo?: Ts }): Promise<FlushRes> {
    const minPrepare = this.b.exec(`SELECT min(prepare_ts) v FROM __intents`)[0]?.v as number | null;
    const now = this.issue();
    // 未解決の intent は、prepare_ts 以上のどこか (この flush の時刻以下のこともある) で確定する。flush 時刻をそれより前に抑えないと、
    // 後で届いた phase 2 の commit が flush 済みの範囲に入り、分析へ送られない (specs/m6_watermark.qnt の m6_red_resolved)。
    const resolved = minPrepare === null || this.faults.flushPastIntents ? now : minPrepare - 1;
    const limit = Math.min(req.upTo ?? now, resolved);
    const rows = this.logScan(`WHERE commit_ts > ? AND commit_ts <= ?`, [this.flushedTs, limit]);
    const entries = rows.map((r) => ({
      commitTs: r.commit_ts as Ts, txn: r.txn as string, changes: decode<Change[]>(r.blob as string),
    }));
    this.flushedTs = Math.max(this.flushedTs, limit);
    this.metaSet("flushed", this.flushedTs);
    return { flushTs: this.flushedTs, entries };
  }
}
