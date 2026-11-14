import { Hlc, SECOND, physicalToTs, tsToPhysical } from "../hlc";
import { SHARD_LIMITS, ShardLimit, shardLimitOf, withinShardLimits } from "../shard-limits";
import type {
  Backend, Change, Clock, CommitReq, CommitRes, ExecReq, ExecRes, Faults, FlushRes, GroupCursor, LockOwner, MetaApi,
  Participant, Piece, PiecePayload, PieceWant, Pos, PrepareReq, PrepareRes, Row, ShardApi, ShardHealth, ShardMetrics, Span, TableDef, Ts,
  TxnStatus, Value,
} from "../types";
import {
  ConflictError, MAX_WRITE_SET_BYTES, Migrating, NotOwner, ReadTooOld, STORAGE_FORMAT, SqlError, TableLocked, checkStorageFormat, isWideSpan, spanCovers, utf8Length,
  unprotectedSpans,
} from "../types";
import type { DdlEntry, SplitMove } from "../meta";
import { blockOf, checkInterval, overlaps, rangeText, sameInterval, slotAligned, slotOf, tokenOf, type Interval } from "../routing";
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
    startSplit(id: string, move: SplitMove): Promise<{ version: number }>;
    /** 分割の枠が生きていて、子が受け取り始めていることを確かめる (meta.ts の checkSplit)。 */
    checkSplit(id: string, move: SplitMove): Promise<void>;
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
export const SPAN_CHECK_MAX_ROWS = 3000;

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
export const sizeOf = (v: Value): number =>
  typeof v === "string" ? v.length * 2 : v instanceof Uint8Array ? v.byteLength : 8;

export interface Intent {
  tbl: string; pk: string; sk: string; txn: string; anchor: string; prepare_ts: Ts; change: string;
}
export interface InFlight {
  pushed: Ts;
  decided: boolean;
  settled: Promise<void>;
  settle(): void;
}

/** 送り出した範囲 (__fenced の行)。token の区間である。終えた後も残し、その範囲の要求を断り続ける。 */
export interface FencedRange extends Interval { to: string; done: number }
/** 受け取り中の範囲 (__incoming の、終えていない行)。終えた行は表に残るが、メモリには載せない。 */
export interface IncomingRange extends Interval { from_id: string }
/** 範囲の記録から、区間だけを取り出す。要求や応答には、これを載せる。 */
export const intervalOf = (x: Interval): Interval => ({ start: x.start, end: x.end });

/**
 * 位置を、記録の表 (__moved、__moved_txn、__arrived) の列に書く形にする。JSON の文字列で、端は `null` である。
 * 主キーの列なので NULL にはしない (SQLite は、主キーの NULL を互いに別の値として扱う)。
 */
export const posKey = (p: Pos): string => JSON.stringify(p);
export const posOf = (key: string): Pos => JSON.parse(key) as Pos;
/** グループの全体を 1 つで運ぶ piece の区間の端。いまは、どの piece も、始まりも終わりもこれである。 */
export const END = posKey(null);
/** 運んだデータから、piece の名前だけを取り出す。 */
export const pieceOf = (p: PiecePayload): Piece => ({ g: p.g, range: p.range, after: p.after });

export const ROLLBACK = Symbol("rollback");
export const FALLBACK = Symbol("fallback");
export const BLOCKED = Symbol("blocked");
export const PENDING_UNIQUE = Symbol("pending unique");
/** 述語の検証で読む commit の上限。超えたら競合とみなす。 */
export const PRED_WINDOW = 2000;
/** ロックの TTL。Worker の死亡に備える。文を実行するたびに延ばす。 */
export const LOCK_TTL_MS = 5000;
/** 読みが、1 つの取引の intent を決着させようとする回数の上限。間で待つので、合わせて 1 秒ほど待つ。 */
export const SETTLE_TRIES = 10;
/** ロックを待つ時間の上限。SQLite の busy_timeout に相当する。 */
export const LOCK_WAIT_MS = 5000;
/**
 * 古い取引が保持者からロックを奪うまで待つ時間。
 * 保持者は多くの場合すぐ終わるので、すぐ奪うと無駄な abort を増やす。
 * 奪う時期を遅らせても閉路はいずれ解ける。ロックはいつ消えてもよいので安全性は変わらない。
 */
export const WOUND_DELAY_MS = 200;
/** DDL の適用が、進行中の取引の決着を待つ上限。超えたら再試行できる誤りを返す。 */
export const SCHEMA_WAIT_MS = 5000;

export interface RowLock extends LockOwner {
  expires: number;
}
export interface Waiter extends LockOwner {
  wake(): void;
}

/**
 * 待ちの後で確かめ直すこと。schema は、要求を計画した表定義の版が、いまも現行であること。owned は、読む範囲と書く行を、読む時刻で
 * このシャードが持っていること。
 */
export type Check = "schema" | "owned";

/** 同期区間が頼る表定義の版。要求を計画したときの版である。 */
export interface Plan {
  schema: number;
}

/** 同期区間が頼る行。読む範囲、書く行、読む時刻 (null は最新の状態) である。書く行は、主キーで token が決まる。 */
export interface Rows {
  spans: Span[];
  writes: Pick<Change, "table" | "pk" | "sk">[];
  at: Ts | null;
}

/** Section を作る鍵。このファイルの外へは出さない。使うのは ShardCore.enter だけである。 */
export const ENTER = Symbol("enter");

/**
 * 同期区間に入った印。ShardCore.enter が、待ちの後の確かめ直しを済ませてから作る。コンストラクタは private で、作る関数は、
 * このファイルの外へ出さない鍵 (ENTER) でしか呼べない。このファイルの中でも、enter のほかでは作らない。
 *
 * 要求の文を実行する関数 (run、checked)、取引を検証する関数 (validate、changedSince)、書き込みを受け入れる関数
 * (assertWriteSetFits、prepareSync) は、この印を受け取る。確かめ直しを飛ばした入口は、印を持てないので、型の検査を通らない。
 * 型の引数は、確かめ直したことである。版を確かめ直していない印は、版に頼る関数へ渡せない。
 *
 * 型が確かめるのは、区間に入ったことまでである。印を await の後まで持ち越していないことは、型では確かめられない。
 * 印は、作った同期区間の中だけで使い、待った後は、enter をもう一度呼んで作り直す。
 */
export class Section<K extends Check> {
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

export class ShardKernel {
  readonly id: string;
  epoch = 0;
  b: Backend;
  hlc = new Hlc(0);
  ceiling: Ts = 0;
  defs = new Map<string, TableDef>();
  schema = 0;
  /** 直近の write の索引。キーごとの最新 commit 時刻だけを持ち、検査を O(1) にする。 */
  recent = new Map<string, Ts>();
  recentLowWater: Ts = 0;
  maxCommit: Ts = 0;
  logLowWater: Ts = 0;
  ddlFloor: Ts = 0;
  flushedTs: Ts = 0;
  inflight = new Map<string, InFlight>();
  fenced: FencedRange[] = [];
  incoming: IncomingRange[] = [];
  // 送り出しと到着の記録は、表では piece ごと (g, lo, after) に持つ。いまは、どの piece もグループの全体 (位置の区間が端から端まで) で、
  // fence はブロックを途中で切らないので、メモリではグループの名前で引く。
  /** 親：移動済みグループ。 */
  moved = new Map<string, { m: Ts; to: string; acked: boolean }>();
  /** 子：到着済みグループとその m。 */
  arrived = new Map<string, Ts>();
  maxArrived: Ts = 0;
  /** 行ロック。メモリだけに置く。消えても検証が F 以降の変更を見るので安全である。 */
  locks = new Map<string, RowLock>();
  waiters = new Map<string, Waiter[]>();
  stats = { at: 0, reads: 0, writes: 0, groups: new Map<string, number>() };
  faults: Faults;
  K: number;
  rt: Runtime;

  constructor(readonly deps: ShardDeps) {
    this.id = deps.id;
    this.b = deps.backend;
    this.rt = deps.runtime ?? systemRuntime;
    this.faults = deps.faults ?? {};
    this.K = deps.K ?? 50;
    this.boot();
  }

  // ---- 起動と永続メタデータ ----

  boot(): void {
    const b = this.b;
    b.exec(`CREATE TABLE IF NOT EXISTS __meta(k TEXT PRIMARY KEY, v)`);
    // ほかの表に触る前に確かめる。新しい形式の DO を、古いコードが作り変えてしまわないようにする。
    checkStorageFormat(b, "__meta", "shard");
    b.exec(`CREATE TABLE IF NOT EXISTS __ddl(version INTEGER PRIMARY KEY, entry TEXT NOT NULL)`);
    b.exec(`CREATE TABLE IF NOT EXISTS __intents(
      tbl TEXT NOT NULL, pk TEXT NOT NULL, sk TEXT NOT NULL, txn TEXT NOT NULL, anchor TEXT NOT NULL,
      prepare_ts INTEGER NOT NULL, change TEXT NOT NULL, PRIMARY KEY(tbl, pk))`);
    for (const ddl of CAPTURE_TABLES) b.exec(ddl);
    // 範囲の移動の記録 (docs/design-subslots.md の「シャードの記録」、docs/storage-format.md)。
    // 範囲は token の区間 [lo, hi) である。
    // piece は (グループ g, fence の区間 [lo, hi), 位置の区間 (after, up_to]) で、after と up_to は位置の JSON (端は 'null') である。
    // fence は重ならないので、(g, lo, after) で 1 つに決まる。
    // __incoming は、受け取り終えても消さず、done と、渡した側から受け取った時刻 m を残す。
    b.exec(`CREATE TABLE IF NOT EXISTS __fenced(lo INTEGER NOT NULL, hi INTEGER NOT NULL, "to" TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0)`);
    b.exec(`CREATE TABLE IF NOT EXISTS __incoming(lo INTEGER NOT NULL, hi INTEGER NOT NULL, from_id TEXT NOT NULL,
      done INTEGER NOT NULL DEFAULT 0, m INTEGER)`);
    b.exec(`CREATE TABLE IF NOT EXISTS __moved(g TEXT NOT NULL, lo INTEGER NOT NULL, hi INTEGER NOT NULL, "after" TEXT NOT NULL, up_to TEXT NOT NULL,
      m INTEGER NOT NULL, dest TEXT NOT NULL, acked INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(g, lo, "after"))`);
    b.exec(`CREATE TABLE IF NOT EXISTS __moved_txn(txn TEXT NOT NULL, g TEXT NOT NULL, lo INTEGER NOT NULL, "after" TEXT NOT NULL,
      dest TEXT NOT NULL, PRIMARY KEY(txn, g, lo, "after"))`);
    b.exec(`CREATE TABLE IF NOT EXISTS __arrived(g TEXT NOT NULL, lo INTEGER NOT NULL, hi INTEGER NOT NULL, "after" TEXT NOT NULL, up_to TEXT NOT NULL,
      m INTEGER NOT NULL, PRIMARY KEY(g, lo, "after"))`);
    b.exec(`CREATE TABLE IF NOT EXISTS __txn(
      txn TEXT PRIMARY KEY, status TEXT NOT NULL, c INTEGER, participants TEXT, done INTEGER NOT NULL DEFAULT 0, at INTEGER)`);
    this.initStorage();

    for (const r of b.exec(`SELECT entry FROM __ddl ORDER BY version`)) {
      const e = JSON.parse(r.entry as string) as DdlEntry & { skipped?: boolean };
      if (!e.skipped) this.loadDefs(e);
    }
    this.schema = (b.exec(`SELECT max(version) v FROM __ddl`)[0]?.v as number) ?? 0;
    this.fenced = b.exec(`SELECT lo AS start, hi AS "end", "to", done FROM __fenced`) as unknown as FencedRange[];
    // 受け取り終えた範囲は、メモリに載せない。載せると、移動の途中として扱われる。
    this.incoming = b.exec(`SELECT lo AS start, hi AS "end", from_id FROM __incoming WHERE done = 0`) as unknown as IncomingRange[];
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
  initStorage(): void {
    if (this.metaGet("log_gens") === null) this.metaSet("log_gens", JSON.stringify([]));
  }

  logGens(): number[] {
    return JSON.parse((this.metaGet("log_gens") as string | null) ?? "[]") as number[];
  }

  /**
   * 変更ログを commit_ts の昇順で読む。世代は commit_ts の範囲で分かれているので、古い世代から順に読めば全体も昇順になる。
   * where は `commit_ts > ?` のような条件で、各世代の表に同じものを付ける。
   */
  logScan(where: string, params: Value[], limit?: number): Row[] {
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
  logEach(where: string, params: Value[], fn: (commitTs: Ts, txn: string, blob: string) => boolean | void): void {
    for (const g of this.logGens()) {
      const { rows } = this.b.iterate(`SELECT commit_ts, txn, blob FROM __log_g${g} ${where} ORDER BY commit_ts`, ...params);
      for (const r of rows) {
        if (fn(r[0] as Ts, r[1] as string, r[2] as string) === false) return;
      }
    }
  }

  /** commit の変更ログを、c の世代の表へ書く。必ず書き込みの取引の中で呼ぶ。 */
  logInsert(c: Ts, txn: string, blob: string): void {
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
  gc(writing?: number): void {
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

  metaGet(k: string): Value {
    return this.b.exec(`SELECT v FROM __meta WHERE k = ?`, k)[0]?.v ?? null;
  }
  metaSet(k: string, v: Value): void {
    this.b.exec(`INSERT INTO __meta(k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`, k, v);
  }

  /** 適用に失敗し、取り消せもしなかった DDL。直るまで、このシャードは要求を受けられない。 */
  schemaStuck: { version: number; message: string } | null = null;

  def(table: string): TableDef {
    const d = this.defs.get(table);
    if (!d) throw new SqlError(`no such table: ${table}`);
    return d;
  }
  loadDefs(e: DdlEntry): void {
    for (const d of e.defs) this.defs.set(d.name, d);
    for (const n of e.drops) this.defs.delete(n);
  }






  // ---- 時計 ----

  /** HLC を進めた値が保存済みの上限を超えたら、上限を先取りして保存する (最大で毎秒 1 回)。 */
  guardCeiling(): void {
    if (this.faults.hlcNoCeiling || this.hlc.value <= this.ceiling) return;
    this.ceiling = this.hlc.value + SECOND;
    this.metaSet("ceiling", this.ceiling);
  }
  issue(): Ts {
    const t = this.hlc.tick(this.deps.clock.now());
    this.guardCeiling();
    return t;
  }
  observe(ts: Ts | undefined): void {
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

  // 所有は token の区間で引く。1 行 (書く行、主キーの span) は token 1 つで、shard key の span は、そのブロックの全体である。
  // いまは、fence も受け取り中の範囲もブロックを途中で切らないので、同じ shard key の 1 行と全体は、同じ範囲に当たる。

  /** 所有を確かめる対象の区間。pk を省くと、その shard key のブロックの全体である。 */
  areaOf(sk: string, pk?: string): Interval {
    if (pk === undefined) return blockOf(sk);
    const token = tokenOf(sk, pk);
    return { start: token, end: token + 1 };
  }
  fencedIn(area: Interval): FencedRange | undefined {
    return this.fenced.find((f) => overlaps(f, area));
  }
  incomingIn(area: Interval): IncomingRange | undefined {
    return this.incoming.find((f) => overlaps(f, area));
  }
  /**
   * 所有を確かめる対象。書く行、範囲の順に並べる。この順は、sksOf の順と同じである。
   * 複数の対象が別々の理由で断られるとき、先に並んだものの理由が、要求の答えになる。
   */
  areasOf(spans: Span[], writes: Pick<Change, "pk" | "sk">[]): { sk: string; area: Interval }[] {
    const out = writes.map((w) => ({ sk: w.sk, area: this.areaOf(w.sk, w.pk) }));
    for (const s of spans) {
      if (s.kind === "pk") out.push({ sk: s.sk, area: this.areaOf(s.sk, s.pk) });
      else if (s.kind === "sk" || (s.kind === "pred" && s.sk)) out.push({ sk: s.sk!, area: this.areaOf(s.sk!) });
    }
    return out;
  }
  /**
   * 両端が slot の境目にない範囲を断る。ブロックを途中で切る移動は、形式 (範囲表、記録の表、要求) が扱えるだけで、
   * シャードの手順 (グループの列挙、pull、ack) は、まだグループの全体を運ぶことを前提にしている。途中まで受けると、
   * 同じ shard key の、範囲の外の行まで運んでしまうので、範囲の移動の入口で断る。
   */
  wholeSlotsOnly(x: Interval): void {
    try {
      checkInterval(x);
    } catch (e) {
      throw new SqlError((e as Error).message);
    }
    if (!slotAligned(x)) throw new SqlError(`moving a part of a slot is not supported yet: ${rangeText(x)}`);
  }
  sksOf(spans: Span[], writes: Pick<Change, "sk">[] = []): string[] {
    const out = new Set<string>(writes.map((w) => w.sk));
    for (const s of spans) if (s.kind === "pk" || s.kind === "sk" || (s.kind === "pred" && s.sk)) out.add(s.sk!);
    return [...out];
  }


  /**
   * 読む範囲と書く行を、読む時刻でこのシャードが持っているか。親は fence した範囲を一切受理せず、子は T < m を拒否する。
   * 子に T < m の状態はないので、答えると移動前の commit を失った結果を返すことになる。
   *
   * 同期区間の入口では、enter がこれを呼ぶ。ほかに呼ぶのは、intent の決着を始める前だけである (exec、lockedExec、execAuto)。
   * 決着の問い合わせは、相手の取引の確定の時刻を押し上げる。持ち主でない要求は結局断るので、問い合わせる前に断る。
   * そこで通っても、決着を待った後で enter がもう一度確かめる。
   */
  assertOwned({ spans, writes, at: T }: Rows): void {
    for (const { sk, area } of this.areasOf(spans, writes)) {
      const f = this.fencedIn(area);
      if (f && !this.faults.ignoreFence) throw new NotOwner(f.to);
      if (this.incomingIn(area) && !this.arrived.has(sk)) throw new ConflictError(`group not arrived: ${sk}`);
      const m = this.arrived.get(sk);
      if (m !== undefined && T !== null && T < m && !this.faults.servePastMove) throw new ReadTooOld(`moved at ${m}`);
    }
    const wide = spans.filter(isWideSpan);
    if (wide.length > 0) {
      // 全表の span が覆うのは、読み手の範囲表でこのシャードが持つ範囲 (claim) である。
      // その中に手放した範囲があれば、読み手の範囲表は古く、読み手は子を読まない。
      // 移動が終わった後も断り続ける。
      // 親が残りの行だけを答えると、子へ移った行はどのシャードからも返らない。
      if (!this.faults.ignoreFence && !this.faults.staleWideRead) {
        for (const s of wide) {
          for (const range of s.claim ?? []) {
            const f = this.fencedIn(range);
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
   *   spans、writes、at: 読む範囲と書く行を、読む時刻でこのシャードが持っているか (assertOwned)。所有は token の区間で
   *     確かめる。1 行は token 1 つ、shard key の範囲はブロックの全体、全表の範囲は読み手の claim である。
   * 確かめるだけで、状態は変えない。時計を進める、数える、ロックを延ばすのは、呼び出し側が区間の中でする。
   */
  enter(claim: Plan & Rows): Section<Check>;
  enter(claim: Plan): Section<"schema">;
  enter(claim: Rows): Section<"owned">;
  enter(claim: Partial<Plan> & Partial<Rows>): Section<Check> {
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
  moving(): boolean {
    return this.incoming.length > 0 || this.fenced.some((f) => !f.done);
  }

  moves(_req: Record<string, never>): { outgoing: (Interval & { to: string })[]; incoming: (Interval & { from: string })[] } {
    return {
      outgoing: this.fenced.filter((f) => !f.done).map((f) => ({ start: f.start, end: f.end, to: f.to })),
      incoming: this.incoming.map((x) => ({ start: x.start, end: x.end, from: x.from_id })),
    };
  }



  /**
   * 範囲のグループを列挙する。fence の後に呼べば取り残しはない。
   * ack されていないグループは移動済みでも返す。子が受け取る前に落ちると応答が失われるからである。
   */
  listGroups(req: Interval & { limit: number; cursor?: GroupCursor | null }): { groups: string[]; cursor: GroupCursor | null } {
    // ブロックを途中で切る範囲では、範囲の中に行か intent を持つグループだけを挙げることになる。いまは、切らない範囲だけを受ける。
    this.wholeSlotsOnly(req);
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





  ack(req: { pieces: Piece[] }): void {
    this.b.tx(() => {
      for (const p of req.pieces) {
        const g = p.g;
        // いまは、渡した piece はどれもグループの全体で、グループに 1 つである。記録もグループの名前で引く。
        const known = p.after === null ? this.moved.get(g) : undefined;
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


  finishMove(req: Interval): { m: Ts } {
    this.b.exec(`UPDATE __fenced SET done = 1 WHERE lo = ? AND hi = ?`, req.start, req.end);
    for (const f of this.fenced) if (sameInterval(f, req)) f.done = 1;
    // fence の後、このシャードは範囲の行について何も答えていない。いま発行する時刻は、範囲について答えたどの読みの時刻よりも、
    // 確定したどの書き込みの時刻よりも大きい。
    return { m: this.issue() };
  }

  finishIncoming(req: Interval & { m: Ts }): void {
    // 行のあるグループは、pull が時刻を運び、時計はそこまで進んでいる (receive)。渡す側に行のなかったグループは運ばれないので、
    // 渡す側の時計を、ここで受け取る。受け取らないと、渡す側が「行はない」と答えた時刻より小さい時刻で、その行を書いてしまい、
    // 答え済みの読みが、後から書き込みの後になる (モデル M5b の noWriteBelowRead)。
    if (!this.faults.finishWithoutClock) this.observe(req.m);
    // 記録は消さずに、終えた印と、渡した側から受け取った時刻を残す。メモリからは外すので、移動の途中ではなくなる。
    // 残した記録を読むもの (受け取った範囲の床、受け取った範囲の外の要求を断る確かめ) は、後の段で足す
    // (docs/design-subslots.md の「drain と finishMove」)。
    this.b.exec(`UPDATE __incoming SET done = 1, m = ? WHERE lo = ? AND hi = ? AND done = 0`, req.m, req.start, req.end);
    this.incoming = this.incoming.filter((x) => !sameInterval(x, req));
  }

  health(_req: Record<string, never>): ShardHealth {
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
  exportRows(req: { table: string; after: Value[] | null; limit: number; skip?: number }): { columns: string[]; rows: Value[][]; pk: number[] } {
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

  metrics(_req: Record<string, never>): ShardMetrics {
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

  count(kind: "reads" | "writes", spans: Span[], writes: Pick<Change, "sk">[] = []): void {
    // 起動後の最初の要求から数え始める。0 のままだと最初の報告の経過時間が 0 になり、
    // Autoscaler は眠っていたシャードの負荷を次の問い合わせまで判断できない。
    if (this.stats.at === 0) this.stats.at = this.deps.clock.now();
    this.stats[kind]++;
    if (this.stats.groups.size > 4096) return;
    for (const sk of this.sksOf(spans, writes)) this.stats.groups.set(sk, (this.stats.groups.get(sk) ?? 0) + 1);
  }

  // ---- 行ロック ----

  lockKey(table: string, pk: string): string {
    return `${table}\0${pk}`;
  }

  liveLock(key: string): RowLock | undefined {
    const l = this.locks.get(key);
    if (l && l.expires <= this.deps.clock.now()) {
      this.locks.delete(key);
      this.wakeNext(key);
      return undefined;
    }
    return l;
  }

  wakeNext(key: string): void {
    const q2 = this.waiters.get(key);
    const next = q2?.shift();
    if (q2 && q2.length === 0) this.waiters.delete(key);
    next?.wake();
  }

  wakeAll(key: string): void {
    for (const w of this.waiters.get(key) ?? []) w.wake();
    this.waiters.delete(key);
  }

  grant(key: string, owner: LockOwner): void {
    this.locks.set(key, { ...owner, expires: this.deps.clock.now() + (this.deps.lockTtlMs ?? LOCK_TTL_MS) });
  }

  renew(txn: string): void {
    const until = this.deps.clock.now() + (this.deps.lockTtlMs ?? LOCK_TTL_MS);
    for (const l of this.locks.values()) if (l.txn === txn) l.expires = until;
  }

  releaseLocks(txn: string): void {
    const id = lockIdOf(txn);
    for (const [key, l] of this.locks) {
      if (l.txn !== id) continue;
      this.locks.delete(key);
      this.wakeNext(key);
    }
  }

  unlock(req: { txn: string }): void {
    this.releaseLocks(req.txn);
  }

  /** 古い取引が優先される。 */
  older(a: LockOwner, b: LockOwner): boolean {
    return a.start < b.start || (a.start === b.start && a.txn < b.txn);
  }



  blockedBy(changes: Pick<Change, "table" | "pk">[], me: LockOwner): string | null {
    for (const c of changes) {
      const key = this.lockKey(c.table, c.pk);
      const held = this.liveLock(key);
      if (held && held.txn !== me.txn) return key;
      const intent = this.intentAt(c.table, c.pk);
      if (intent && intent.txn !== me.txn) return key;
    }
    return null;
  }



  now(_req: Record<string, never>): Ts {
    return this.issue();
  }

  // ---- intent の解決 ----

  overlapping(spans: Span[], upTo: Ts): Intent[] {
    const all = this.b.exec(`SELECT * FROM __intents WHERE prepare_ts <= ?`, upTo) as unknown as Intent[];
    return all.filter((i) => spans.some((s) => spanCovers(s, i.tbl, i.pk, i.sk) && this.intentMatches(s, i)));
  }

  /** intent が述語に関わるか。適用後の行と、本体の現在の行のどちらかが満たせば関わる。 */
  intentMatches(s: Span, i: Intent): boolean {
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
  rowMatches(s: Extract<Span, { kind: "pred" }>, def: TableDef, pk: string, row: Row): boolean {
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
  predicateChanged(s: Extract<Span, { kind: "pred" }>, from: Ts): boolean {
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



  // ---- rollback-read ----

  rollback<T>(fn: () => T): T {
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
  deltaAfter(T: Ts): { table: string; pk: string; image: Row | null }[] {
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

  restore(targets: { table: string; pk: string; image: Row | null }[]): void {
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
  run(sec: Section<"owned">, req: ExecReq): { columns: string[]; values: Value[][]; changes: Change[]; count?: number; bytes?: number; over?: boolean } {
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
  checked<T>(_sec: Section<"owned">, req: ExecReq, exec: () => T): T {
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
  checking = false;

  /** 範囲の外の行を、利用者の表と index の表から消す。行が多すぎて検査を省くときは false を返す。 */
  deleteOutside(req: ExecReq): boolean {
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

  runStatement(req: ExecReq): { columns: string[]; values: Value[][]; changes: Change[]; count?: number; bytes?: number; over?: boolean } {
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
  readLimited(req: ExecReq): { columns: string[]; values: Value[][]; bytes?: number; over?: boolean } {
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
  withinLimits(req: Pick<ExecReq, "sql" | "params">): void {
    const over = shardLimitOf(req.sql, req.params ?? []);
    if (over) throw new ShardLimit(over);
  }



  /**
   * 書き込み文を実行し、変更行を trigger ではなく RETURNING と主キーの読みで捕捉する。
   * trigger の捕捉は __cap、__capv、__cap_on へ書くので、ROLLBACK しても 1 文あたり 3 行が課金される。
   * 文の形が想定と合わなければ、その文だけを巻き戻して null を返す。呼び出し側は trigger の経路に任せる。
   */
  runCaptured(req: ExecReq): { columns: string[]; values: Value[][]; changes: Change[] } | null {
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


  intentAt(table: string, pk: string): Intent | undefined {
    return this.b.exec(`SELECT * FROM __intents WHERE tbl = ? AND pk = ?`, table, pk)[0] as unknown as Intent | undefined;
  }

  // ---- 検証 ----

  touch(table: string, pk: string, sk: string, ts: Ts): void {
    for (const k of [`p\0${table}\0${pk}`, `s\0${table}\0${sk}`, `t\0${table}`, `s\0*\0${sk}`, `t\0*`]) {
      if ((this.recent.get(k) ?? 0) < ts) this.recent.set(k, ts);
    }
  }

  /**
   * from より後の write があるか。to より後の write も含むので保守的に abort する側へ倒れる。
   * 答えは、範囲をこのシャードが持っているときだけ意味がある。だから、持ち主を確かめた同期区間の印を受け取る。
   */
  changedSince(_sec: Section<"owned">, span: Span, from: Ts): boolean {
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
  validate(sec: Section<Check>, txn: string, T: Ts, writes: Change[], spans: Span[]): string | null {
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
  uniquePending(txn: string, writes: Change[]): string | null {
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
  assertWriteSetFits(_sec: Section<"schema">, writes: Change[]): void {
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
  assertUnlocked(writes: Pick<Change, "table">[]): void {
    if (this.faults.ignoreTableLock) return;
    for (const w of writes) {
      const def = this.defs.get(w.table);
      if (def?.building) throw new TableLocked(w.table, `CREATE INDEX ${def.building.name}`);
      if (def?.locked) throw new TableLocked(w.table, def.locked);
    }
  }

  /** 主キーが違っても衝突し得る表か。UNIQUE index のある表である。 */
  hasUniqueBeyondKey(table: string): boolean {
    return this.def(table).uniques.length > 0;
  }

  checkUnique(txn: string, writes: Change[]): string | null {
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

  applyAndLog(txn: string, c: Ts, changes: Change[]): void {
    const logged = changes.map((ch) => {
      const before = selectRow(this.b, this.def(ch.table), ch.pk);
      return { ...ch, before };
    });
    applyChanges(this.b, (t) => this.def(t), logged);
    this.logChanges(txn, c, logged);
  }

  /** 本体へ適用済みの変更を変更ログと直近 write の索引へ記録する。 */
  logChanges(txn: string, c: Ts, logged: Change[]): void {
    this.logInsert(c, txn, encode(logged));
    this.maxCommit = Math.max(this.maxCommit, c);
    for (const ch of logged) this.touch(ch.table, ch.pk, ch.sk, c);
    this.pruneRecent();
  }

  /** 索引が膨らんだら捨てて low-water を上げる。それより古い T の取引は保守的に abort する。 */
  pruneRecent(): void {
    if (this.recent.size < (this.deps.recentMax ?? 200_000)) return;
    this.recentLowWater = this.hlc.value;
    this.recent.clear();
  }



  /**
   * prepare の同期区間。呼び出し側 (prepare と、anchor の drive) が、版を確かめて区間に入ってから呼ぶ。
   * 持ち主は、ここで確かめる。再送への答えと、書き込みの大きさの確認が、その前に来るからである。
   */
  prepareSync(plan: Section<"schema">, req: PrepareReq): PrepareRes {
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

  refresh(req: { txn: string; spans: Span[]; from: Ts; to: Ts }): { ok: boolean; reason?: string } {
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







  /** 移動済みグループの intent は親で適用しない。応答が飛行中だと、適用した分が子に届かず消えるからである。 */
  localIntents(txn: string): Intent[] {
    const rows = this.b.exec(`SELECT * FROM __intents WHERE txn = ?`, txn) as unknown as Intent[];
    return this.faults.applyAfterMoved ? rows : rows.filter((r) => !this.moved.has(r.sk));
  }

  /** 取引の intent を運んだ piece を、転送先ごとに返す。 */
  forwards(txn: string): Map<string, Piece[]> {
    const out = new Map<string, Piece[]>();
    if (this.faults.applyAfterMoved) return out;
    for (const r of this.b.exec(`SELECT g, lo, "after", dest FROM __moved_txn WHERE txn = ?`, txn)) {
      const g = r.g as string;
      // piece が運ぶ区間は、送り出した fence の区間である。fence は重ならず、記録は消さないので、区間の始まり lo から引ける。
      const f = this.fenced.find((x) => x.start === r.lo);
      if (!f) throw new SqlError(`group ${g} was moved to ${r.dest as string}, but shard ${this.id} has no record of the range it moved with`);
      const piece: Piece = { g, range: intervalOf(f), after: posOf(r.after as string) };
      out.set(r.dest as string, [...(out.get(r.dest as string) ?? []), piece]);
    }
    return out;
  }



  // ---- anchor への照会 ----

  decided(txn: string): TxnStatus | null {
    const r = this.b.exec(`SELECT status, c FROM __txn WHERE txn = ?`, txn)[0];
    if (!r) return null;
    return r.status === "committed" ? { status: "committed", c: r.c as Ts } : { status: "aborted" };
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


  /** 分析パスへ渡す変更を読み出す。flushTs は未解決 intent の prepare_ts 未満に抑える。 */
  flush(req: { upTo?: Ts }): FlushRes {
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
