// シャードの核。シャードの状態 (SQLite の表、時計、行ロック、範囲の記録) を読み書きするのは、ここだけである。
//
// 核は同期である。async の関数も、await も、Promise も、タイマーも持たない (test/determinism.test.ts が確かめる)。
// Durable Object は、保存の入出力のほかを await しないかぎり、1 本の糸で動く原子的な状態機械なので、同期の関数 1 つは、
// ほかの要求から見て原子的である。
//
// 待ちを含む要求は、手続き (xxxStep) で処理する。手続きは同期の 1 歩で、frame (待ちをまたいで残るデータ) を見て、
// 済んでいない最初のことをする。待つ必要があれば、待ちたいこと (step.ts の Effect) を返す。殻 (core.ts) が待ちを実行し、
// 同じ 1 歩を先頭から呼び直す。状態に頼る処理 (文の実行、検証、書き込みの受け入れ) は、同期区間の印 (Section) を受け取る。
// 印は enter が、表定義の epoch と範囲の持ち主を確かめてから作る。印は frame に入れられないので、待ちの後は、必ず確かめ直す。
import { Hlc, SECOND, physicalToTs, tsToPhysical } from "../hlc";
import { SHARD_LIMITS, ShardLimit, shardLimitOf, withinShardLimits } from "../shard-limits";
import type {
  Backend, Change, Clock, CommitReq, CommitRes, Dep, ExecReq, ExecRes, Faults, FlushRes, GroupCursor, LockOwner, TxnLease,
  Participant, Piece, PiecePayload, PieceWant, Pos, PrepareReq, PrepareRes, Row, ShardApi, ShardHealth, ShardMetrics, Span, TableDef, Ts,
  TxnStatus, Plain, Value,
} from "../types";
import {
  ConflictError, LOCK_LEASE_SLACK_MS, LOCK_TTL_MS, MAX_WRITE_SET_BYTES, Migrating, NotOwner, ReadTooOld, STORAGE_FORMAT, SqlError, TableLocked, WriteOutsideClaim, checkStorageFormat, isWideSpan,
  spanCovers, utf8Length, unprotectedSpans,
} from "../types";
import { ALL_OBJECTS, describeOpen, fencedBy, fold, isDdlRecord, objectKey, type Logged, type OpenDdl, type Snapshot } from "../catalog";
import type { ParsedDdl } from "../sql/ddl";
import { blockOf, checkInterval, overlaps, rangeText, sameInterval, slotAligned, slotOf, tokenOf, type Interval } from "../routing";
import { keyString } from "../keys";
import { type Runtime, systemRuntime } from "../runtime";
import { attempt, done, tail, unwrap, wait, type Effect, type Fork, type Outcome, type PeerCall, type Program, type Step } from "./step";
import {
  CAPTURE_TABLES, applyChanges, asSqlError, capturedChanges, checkAfter, decode, deleteRow, encode, imageSql, insertRow, pkValues, predicateRowSql, q,
  queryAll, returnedRows, rowwiseRestore, selectGroup, selectRow, setBasedRestore, tupleKey,
} from "./rows";
import { decodeElem, decodeReturned, decodeTuple, parseTuple, selectElemSql, tupleSql, typedReadSql, type Tuple } from "../value";

/**
 * 核の依存。同期のものだけである。相手のシャード、Meta、背景の仕事は、殻の依存 (core.ts の ShardDeps) にあり、核からは見えない。
 * 保存先の確定の待ち (sync) は呼ばない (test/determinism.test.ts が確かめる)。実行環境からは、実時間だけを読む。
 */
export interface KernelDeps {
  id: string;
  backend: Backend;
  clock: Clock;
  /** 実時間の出どころ。指定しなければ実物を使う。シミュレータは seed から決まる実装を渡す。 */
  runtime?: Pick<Runtime, "now">;
  /**
   * phase 2 の再駆動と、子として受け取っている移動の続きを予約する。DO では storage.setAlarm に渡す (alarm は 1 つで、どちらも redrive が
   * 進める)。why が "move" なら、子として進める移動のための予約である (シミュレータは、これを仮想の時計の alarm にする)。
   */
  scheduleRedrive?(why?: "move"): void;
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
  /**
   * 試験用の検査。シャードが書き込みを受け入れる前に、その書き込みを渡す (書き込みの守り claimed の入口)。守りを欠陥のスイッチで
   * 外していても呼ぶ。シミュレータは、守りとは別に、宣言した範囲と、範囲表での持ち主を確かめる。本番では指定しない。
   */
  writeCheck?: (e: WriteCheck) => void;
}

/** シャードが受け入れようとしている書き込み (KernelDeps.writeCheck)。 */
export interface WriteCheck {
  shard: string;
  /**
   * 文の実行なら、その文と、文が宣言した範囲。取引が溜めた変更を確定のときに受け取る経路 (commitLocal、prepare) では null である。
   * そこでは、変更それぞれが名乗る行が、宣言である。
   */
  sql: string | null;
  spans: Span[] | null;
  changes: Change[];
  /** 変更の表の定義。行イメージから行のキーを読むのに使う。 */
  def(table: string): TableDef;
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
/** 取引の大きさの上限を超えた書き込みの誤り。 */
const writeSetTooLarge = (): string =>
  `transaction too large: it changes more than ${MAX_WRITE_SET_BYTES} bytes of rows on one shard; split it into smaller transactions`;
/**
 * 書き込みの文を実行する。行イメージのタプルが DO の SQLite の値の長さの上限を超えると、SQLite が捕捉の中で文を止める
 * (「string or blob too big」。BLOB は 16 進で 2 倍になり、JSON は文字を逃がす)。1 行のイメージがその上限を超える書き込みは、
 * 取引の大きさの上限 (MAX_WRITE_SET_BYTES) も必ず超えるので、同じ誤りにする (docs/design-values.md の「大きさの勘定」)。
 * 値そのものが上限を超える書き込みも、同じく大きすぎる。捕捉の経路 (trigger と RETURNING) は、どちらもここを通る。
 */
function imageFits<T>(write: () => T): T {
  try {
    return write();
  } catch (e) {
    if (e instanceof Error && /string or blob too big/i.test(e.message)) throw new SqlError(writeSetTooLarge());
    throw e;
  }
}
/**
 * 宣言した範囲 s が、変更の行を覆うか (書き込みの守り ShardKernel.claimed)。覆い方は spanCovers と同じで、全表の範囲に claim が
 * あれば、claim の token の区間に載る行だけを覆う (Span.claim)。
 */
function declares(s: Span, c: Pick<Change, "table" | "pk" | "sk">): boolean {
  if (!spanCovers(s, c.table, c.pk, c.sk)) return false;
  if (!isWideSpan(s) || s.claim === undefined) return true;
  const token = tokenOf(c.sk, c.pk);
  return s.claim.some((x) => token >= x.start && token < x.end);
}
/** 型つきの読みに包んだ文。同じ形の読みが何度も届くので、文ごとに覚える (ShardKernel.executed)。 */
const wrappedReads = new Map<string, string>();

/**
 * 値のおおよその大きさ (バイト)。上限の判定に使うだけで、正確である必要はない。値に戻した後で数える (INTEGER と REAL は 8 バイト)。
 * 型つきの読みの印 (`i`、`t`) は数えないので、段 2 までと同じ数になり、集める予算の配り方は変わらない。
 */
const sizeOf = (v: Value): number =>
  typeof v === "string" ? v.length * 2 : v instanceof Uint8Array ? v.byteLength : 8;

export interface Intent {
  tbl: string; pk: string; sk: string; txn: string; anchor: string; prepare_ts: Ts; change: string;
}
/** 進行中の確定 (anchor の drive) の記録。 */
export interface Flight {
  /** 読み手が、確定の時刻をこれより後へ押した。 */
  pushed: Ts;
  /** 確定の時刻を決めた。決めた後は押せない。 */
  decided: boolean;
  /** 決着を待つもの。殻が、起こしてもらう関数を登録する。 */
  waiters: (() => void)[];
}

/**
 * 送り出した範囲 (__fenced の行)。token の区間である。epoch は、その移動の move-start の epoch で、親が move-start を適用したときに
 * 書く (段 4)。終えた後も残す (移動をまたぐ確かめが、尋ねたシャードが fence の宛先かを確かめるのに使う)。所有は、この記録ではなく、
 * スナップショットの範囲表で引く。
 */
export interface FencedRange extends Interval { to: string; done: number; epoch: number }
/** 受け取り中の範囲 (__incoming の、終えていない行)。終えた行は表に残るが、メモリには載せない。epoch は、その移動の move-start の epoch。 */
export interface IncomingRange extends Interval { from_id: string; epoch: number }
/** 範囲の記録から、区間だけを取り出す。要求や応答には、これを載せる。 */
const intervalOf = (x: Interval): Interval => ({ start: x.start, end: x.end });

/**
 * 位置を、記録の表 (__moved、__moved_txn、__arrived) の列に書く形にする。JSON の文字列で、端は `null` である。
 * 主キーの列なので NULL にはしない (SQLite は、主キーの NULL を互いに別の値として扱う)。
 */
const posKey = (p: Pos): string => JSON.stringify(p);
const posOf = (key: string): Pos => JSON.parse(key) as Pos;
/** グループの全体を 1 つで運ぶ piece の区間の端。いまは、どの piece も、始まりも終わりもこれである。 */
const END = posKey(null);
/** 運んだデータから、piece の名前だけを取り出す。 */
const pieceOf = (p: PiecePayload): Piece => ({ g: p.g, range: p.range, after: p.after, epoch: p.epoch });

const ROLLBACK = Symbol("rollback");
const FALLBACK = Symbol("fallback");
const BLOCKED = Symbol("blocked");
const PENDING_UNIQUE = Symbol("pending unique");
/** 述語の検証で読む commit の上限。超えたら競合とみなす。 */
const PRED_WINDOW = 2000;
/** 読みが、1 つの取引の intent を決着させようとする回数の上限。間で待つので、合わせて 1 秒ほど待つ。 */
const SETTLE_TRIES = 10;
/** ロックを待つ時間の上限。SQLite の busy_timeout に相当する。 */
const LOCK_WAIT_MS = 5000;
/**
 * 古い取引が保持者からロックを奪うまで待つ時間。
 * 保持者は多くの場合すぐ終わるので、すぐ奪うと無駄な abort を増やす。
 * 奪う時期を遅らせても閉路はいずれ解ける。ロックはいつ消えてもよいので安全性は変わらない。
 */
export const WOUND_DELAY_MS = 200;
/** DDL の適用が、進行中の取引の決着を待つ上限。超えたら再試行できる誤りを返す。 */
const SCHEMA_WAIT_MS = 5000;
/** prepare の適用が、fence の表の行ロックが空いたかを見直す間隔。 */
const LOCK_POLL_MS = 10;
/** その待ちの間に、遷移が閉じたかを Meta の列で確かめる間隔 (最初と、上限)。確かめるたびに 2 倍にする。 */
const LOCK_REFETCH_MS = 50;
const LOCK_REFETCH_MAX_MS = 400;

/** 行ロック。期限は持たない。取引の lease (ShardKernel.leases) で生きる。 */
export type RowLock = LockOwner;
export interface Waiter extends LockOwner {
  wake(): void;
}

/** 要求の文を実行した結果 (ExecRes の、時刻を除いた部分)。inserted は書き込みの文だけにある。 */
type Ran = Pick<ExecRes, "columns" | "values" | "changes" | "count" | "bytes" | "over" | "inserted">;

/**
 * 待ちの後で確かめ直すこと。schema は、要求が頼る表定義のもの (ExecReq.deps) の epoch が、どれも、いまも現行であること。owned は、
 * 読む範囲と書く行を、読む時刻でこのシャードが持っていること。
 */
export type Check = "schema" | "owned";

/** 同期区間が頼る表定義のもの。要求を計画したスナップショットでの、ものごとの epoch (ExecReq.deps) である。 */
export interface Plan {
  deps: Dep[];
}

/** 同期区間が頼る行。読む範囲、書く行、読む時刻 (null は最新の状態) である。書く行は、主キーで token が決まる。 */
export interface Rows {
  spans: Span[];
  writes: Pick<Change, "table" | "pk" | "sk">[];
  at: Ts | null;
}

/** Section を作る鍵。このファイルの外へは出さない。使うのは ShardCore.enter だけである。 */
const ENTER = Symbol("enter");

/**
 * 同期区間に入った印。ShardCore.enter が、待ちの後の確かめ直しを済ませてから作る。コンストラクタは private で、作る関数は、
 * このファイルの外へ出さない鍵 (ENTER) でしか呼べない。このファイルの中でも、enter のほかでは作らない。
 *
 * 要求の文を実行する関数 (run、checked)、取引を検証する関数 (validate、changedSince)、書き込みを受け入れる関数
 * (assertWriteSetFits、prepareSync) は、この印を受け取る。確かめ直しを飛ばした入口は、印を持てないので、型の検査を通らない。
 * 型の引数は、確かめ直したことである。版を確かめ直していない印は、版に頼る関数へ渡せない。
 *
 * 印は、作った 1 歩の中だけで使う。待ちをまたいで残るのは frame だけで、frame には印を入れない (frame の宣言に Section が
 * 現れないことを、test/determinism.test.ts が確かめる)。だから、待ちの後で印が要る処理は、enter をもう一度通る。
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

/**
 * 2PC の ID (`<取引の ID>#<続きの中身の指紋>`、Txn.commit) から、行ロックの持ち主の ID を取り出す。ロックは、COMMIT の前の
 * 文が取引の ID で取るので、prepare と確定と中止は、この ID で自分のロックを見分けて手放す。
 */
export const lockIdOf = (txn: string): string => {
  const at = txn.indexOf("#");
  return at < 0 ? txn : txn.slice(0, at);
};

// ---- 手続きの frame ----
//
// frame は、手続きが待ちをまたいで持ち越すものの全部である。3 種類に分けて書く。
//   確かめ直さないこと: 待ちの前に 1 回だけ待った (確かめた) ことの印。印がある間、その待ちは繰り返さない。
//                       核と殻に分ける前の振る舞いを写したものである。待ちの後で確かめ直すべきことを、ここに足さない。
//                       表定義の版と範囲の持ち主は、印ではなく、同期区間に入るたびに enter が確かめる。
//   持ち越す選択:       要求の時刻、期限、起こされた行、手順のどこまで済んだかなど、1 度決めたら変えない値。
//   待ちの結果:         殻が書く。
// frame はデータだけである。同期区間の印 (Section) は入れない。

/** 要求の入口の確かめ (schemaStep) の frame。 */
export interface SchemaFrame {
  /** 要求が頼る表定義のもの (ExecReq.deps)。 */
  deps: Dep[];
  /**
   * 要求の epoch (ExecReq.epoch) と、要求が読み書きする行。これがあれば、表定義の epoch を確かめた後で、所有を見る。要求の epoch が
   * 自分の epoch より新しく、行が自分のスナップショットで自分のものでなければ、範囲の記録を適用してから進む (M21 の gate)。
   */
  epoch?: number;
  rows?: Pick<Rows, "spans" | "writes">;
  /** 少なくともここまで列を適用してから答える epoch (ExecReq.atLeast。表定義の遷移の仕事の要求が運ぶ prepare の epoch)。 */
  atLeast?: number;
  /**
   * 新しい仕事を始める要求か (文の実行)。記録の適用が、その記録の変える表の intent の決着を待っている間、その表に頼る新しい文は、
   * 適用が終わるまで待つ。確定の途中の要求 (prepare、commitLocal、commit) は待たせない。待たせると、2 つのシャードの適用と、2 つの取引の
   * prepare が、互いを待つ輪になる。
   */
  statement?: true;
  /** atLeast の epoch まで、列の適用を待った。 */
  reached?: true;
  /** 要求のほうが新しいものの epoch まで、列の適用を待った回数。 */
  ahead?: number;
  /** 進行中の適用が終わるのを待った回数。 */
  waited?: number;
  /** 書く表の書き込み禁止を解く記録を適用した。 */
  unfenced?: true;
  /** 範囲の記録を適用した (catchUpStep)。確かめ直しは、同期区間の入口 (enter) が行う。 */
  caught?: true;
}

/** reach (少なくともこの epoch まで、列の全部を適用する) の frame。 */
export interface ReachFrame {
  /** 少なくともここまで写しを進める epoch。 */
  epoch: number;
  catchUp: boolean;
  /** 適用を待つ前の、写しの最後の epoch。適用の後も同じなら、Meta にその epoch がまだない。 */
  before?: number;
}

/** applySchema の frame。 */
export interface ApplyFrame {
  catchUp: boolean;
  /** 移動の途中でないことを、最初に確かめた。 */
  checked?: true;
  /** Meta から受け取った、写しの続きの記録。 */
  got?: Logged[];
  /** intent の決着を待つ期限 (実時間)。 */
  deadline?: number;
  /**
   * prepare の適用が、fence の表の行ロックが空くのを待っている。待つ間に、その遷移が閉じることがある (ロックを持つ取引が取り消させる、
   * 進める側が止まって期限が切れる)。Meta の列を、ときどき取り直して確かめる。refetchAt は次に取り直す時刻 (実時間)、every は、その間隔。
   */
  lockWait?: { refetchAt: number; every: number };
}

/** catchUp (範囲の記録だけを適用する) の frame。 */
export interface CatchUpFrame {
  /** 少なくともここまで写しを進めたい epoch (要求の epoch)。 */
  epoch: number;
  got?: Logged[];
}

/** prepared (表定義の遷移の prepare を適用したかを答える) の frame。 */
export interface PreparedFrame {
  req: { epoch: number; early?: true };
  /** prepare の epoch まで、列の適用を待った。 */
  reached?: true;
  /** 欠陥のスイッチ checkBeforePrepare: 適用せずに読んだ、その prepare の記録。 */
  got?: Logged[];
}

/** settleAllIntents の frame。 */
export interface SettleAllFrame {
  /** 決着させる intent の表 (小文字の名前)。なければ、全部の表。 */
  tables?: string[];
  deadline?: number;
  /** いま決着させている intent の一覧 (取引ごとに 1 つ)。先頭が、いまの取引である。 */
  batch?: Intent[];
  res?: TxnStatus;
  finishing?: true;
  slept?: true;
}

/** ensureArrived の frame。 */
export interface ArriveFrame {
  groups: string[];
  asked?: true;
}

/** toEpoch (少なくともこの epoch まで列を適用する) の frame。 */
export interface EpochFrame {
  epoch: number;
  /** 範囲の記録だけを適用した (catchUp)。 */
  caught?: true;
  /** 表定義の記録が手前にあったので、列の全部を適用した回数と、その最後の結果。 */
  full?: number;
  out?: Outcome<unknown>;
}

/** pull の frame。 */
export interface PullFrame {
  req: Interval & { want: PieceWant[]; to: string; maxBytes: number; epoch?: number };
  /** 移動の epoch まで列を適用した (fence が付いた)。 */
  reached?: true;
  out?: PiecePayload[];
}

/** listGroups の frame。 */
export interface GroupsFrame {
  req: Interval & { limit: number; cursor?: GroupCursor | null; epoch?: number };
  reached?: true;
}

/** finishMove の frame。 */
export interface FinishMoveFrame {
  req: Interval & { epoch?: number };
  reached?: true;
}

/**
 * move (子が移動を終えるまで進める) の frame。epoch は移動の move-start の epoch である。
 * 手は、受け取る (drain)、親の時計を受け取る (親の finishMove)、受け取り終えた印を付ける (finishIncoming)、Meta に move-end を記録させる
 * (endMove)、その記録まで写しを進める、の順である。
 */
export interface MoveFrame {
  epoch: number;
  /** 移動の epoch まで列を適用した。 */
  reached?: true;
  /** 受け取り中の範囲と、渡す側。受け取り終えていれば undefined のまま、drain と finishIncoming を飛ばす。 */
  range?: IncomingRange | null;
  total?: { groups: number; rows: number; bytes: number };
  m?: { m: Ts };
  finished?: true;
  /** 欠陥のスイッチ endBeforeDrained: 受け取り終える前に記録させた。 */
  early?: { epoch: number };
  ended?: { epoch: number };
  caught?: true;
}

/** fetchGroups の frame。 */
export interface FetchFrame {
  groups: string[];
  /** 受け取り中の範囲ごとの、まだ届いていないグループ。先頭が、いまの範囲である。 */
  queue?: { range: IncomingRange; rest: string[] }[];
  payload?: PiecePayload[];
  received?: true;
}

/** receive の frame。 */
export interface ReceiveFrame {
  payload: PiecePayload[];
  reached?: true;
  stored?: true;
}

/** drain の frame。epoch は、受け取っている移動の move-start の epoch である。 */
export interface DrainFrame {
  epoch: number;
  /** 渡す側のシャードと、範囲。 */
  from?: string;
  interval?: Interval;
  total?: { groups: number; rows: number; bytes: number };
  /** 何周目か、この周で見たグループの数、列挙の続きの位置。 */
  pass?: number;
  moved?: number;
  cursor?: GroupCursor | null;
  /** いまのページ、その中のまだ届いていないグループ、いま受け取っている分。 */
  page?: { groups: string[]; cursor: GroupCursor | null };
  ackedArrived?: true;
  rest?: string[];
  payload?: PiecePayload[];
  received?: true;
  acked?: true;
}

/** waitForForeignLocks の frame。 */
export interface ForeignLocksFrame {
  txn: string;
  writes: Pick<Change, "table" | "pk">[];
  deadline?: number;
  /** 何番目の行まで見たか。 */
  at?: number;
}

/** lockedExec の frame。 */
export interface LockedFrame {
  req: ExecReq;
  me: LockOwner;
  // ---- 持ち越す選択 ----
  deadline?: number;
  /** 要求が着いた時刻 (シャードの時計)。新しく与えるロックの期限は、行を待った後でも、ここから数える。 */
  since?: number;
  /** 起こされた行。取らずに去るなら、次の待ち手を起こす。起こすのは先頭の 1 件だけだからである。 */
  woken?: string | null;
  /** 待っている行。 */
  waiting?: string;
  // ---- 1 周 (行を待つたびにやり直す) の間だけ持ち越すもの ----
  arrived?: true;
  F?: Ts;
  // ---- 待ちの結果 ----
  applied?: Ts;
}

/** settleIntents の frame。 */
export interface SettleFrame {
  spans: Span[];
  T: Ts;
  /** 確定の時刻を T より後へ押した取引。もう尋ねない。 */
  pushed?: Set<string>;
  /** 取引ごとの、この手続きで決着させた回数。 */
  tries?: Map<string, number>;
  /** 適用した取引の commit 時刻の最大値。何も適用していなければ 0。 */
  applied?: Ts;
  /** いま決着させている intent の一覧 (取引ごとに 1 つ)。先頭が、いまの取引である。 */
  batch?: Intent[];
  slept?: true;
  res?: TxnStatus;
  finishing?: true;
}

/** exec の frame。 */
export interface ExecFrame {
  req: ExecReq;
  // ---- 確かめ直さないこと ----
  /** 表定義の同期を、入口で待った。待つのは 1 回だけで、版そのものは、文を実行する同期区間で確かめ直す。 */
  planned?: true;
  /** グループの到着を待った。 */
  arrived?: true;
  // ---- 持ち越す選択 ----
  /** 読む時刻。 */
  T?: Ts;
  // ---- 待ちの結果 ----
  applied?: Ts;
  locked?: Outcome<ExecRes>;
}

/** execAuto の frame。 */
export interface AutoFrame {
  req: ExecReq;
  // ---- 確かめ直さないこと ----
  /** 表定義の同期を、入口で待った。版そのものは、書き込む同期区間に入るたびに確かめる。 */
  planned?: true;
  /** グループの到着を待った。 */
  arrived?: true;
  /** intent の決着を待った後の、最初の同期区間に入った。要求を数えるのは、そこで 1 回だけである。 */
  entered?: true;
  // ---- 持ち越す選択 ----
  /** この要求の時刻。決着させる intent の上限で、行を待つときの名前にもなる。 */
  now?: Ts;
  me?: LockOwner;
  deadline?: number;
  /** 待っている行と、起こされた行。 */
  key?: string;
  woken?: Set<string>;
  // ---- 待ちの結果 ----
  direct?: Outcome<ExecRes | null>;
  waited?: Outcome<void>;
}

/** execDirect の frame。 */
export interface DirectFrame {
  req: ExecReq;
  claim: Plan & Rows;
  now: Ts;
  // ---- 持ち越す選択 ----
  me?: LockOwner;
  deadline?: number;
  key?: string;
  woken?: Set<string>;
}

/** commitLocal と prepare の frame。 */
export interface PrepareFrame<R> {
  req: R;
  /** 表定義の epoch を、入口で確かめた (表定義の同期を待った)。待ちの後で、もう一度確かめる。 */
  planned?: true;
  arrived?: true;
  /** 欠陥 prepareWaits: 書く行の、他の取引のロックを待った。 */
  waitedLocks?: true;
}

/** unchanged の frame。 */
export interface UnchangedFrame {
  req: { spans: Span[]; from: Ts; atLeast?: number };
  synced?: Outcome<void>;
}

/** syncSchema の frame。 */
export interface SyncSchemaFrame {
  req: { atLeast: number };
  asked?: true;
}

/** commit の frame。 */
export interface CommitFrame {
  req: CommitReq;
  planned?: true;
  /** 登録した、この実行の記録。 */
  flight?: Flight;
  driving?: true;
  res?: CommitRes;
}

/** drive の frame。 */
export interface DriveFrame {
  req: CommitReq;
  flight: Flight;
  /** 参加者の prepare の答え。 */
  acks?: PrepareRes[];
  /** 欠陥 prepareWaits: 自分の書く行の、他の取引のロックを待った。 */
  waitedLocks?: true;
  /** 決めた確定の時刻。 */
  c?: Ts;
  refreshed?: { ok: boolean; reason?: string }[];
  /** 確定の記録を書いた。 */
  recorded?: true;
}

/** phase2 の frame。 */
export interface Phase2Frame {
  txn: string;
  c: Ts;
  shards: string[];
  local?: true;
  sent?: true;
}

/** finalize と abort の frame。 */
export interface SettleTxnFrame<R> {
  req: R;
  arrived?: true;
  /** 運んだ piece の決着を、まだ転送していない先。 */
  queue?: [string, Piece[]][];
}

/** queryTxn と status の frame。 */
export interface TxnQueryFrame<R> {
  req: R;
  waited?: true;
}

/** redrive の frame。 */
export interface RedriveFrame {
  more?: boolean;
  errors?: string[];
  /** 届け終えていない確定、子として進める移動の epoch (配列と位置)、取り残された intent。 */
  txns?: Row[];
  moves?: number[];
  at?: number;
  orphans?: Intent[];
  last?: Outcome<unknown>;
}

/** 失敗しても続ける仕事 1 つの frame。待ちの失敗を、結果として返す。 */
export interface GuardedFrame {
  effect: Effect;
  out?: Outcome<unknown>;
}

/** 取り残された intent の決着の frame。 */
export interface OrphanFrame {
  anchor: string;
  txn: string;
  res?: TxnStatus;
  finishing?: true;
}

/** 手続きごとの、frame と結果の型。 */
export interface Sig {
  schema: [SchemaFrame, void];
  reach: [ReachFrame, void];
  apply: [ApplyFrame, void];
  catchUp: [CatchUpFrame, void];
  prepared: [PreparedFrame, { ok: boolean; reason?: string }];
  settleAll: [SettleAllFrame, void];
  arrive: [ArriveFrame, void];
  toEpoch: [EpochFrame, void];
  pull: [PullFrame, PiecePayload[]];
  groups: [GroupsFrame, { groups: string[]; cursor: GroupCursor | null }];
  finishMove: [FinishMoveFrame, { m: Ts }];
  fetch: [FetchFrame, void];
  receive: [ReceiveFrame, void];
  drain: [DrainFrame, { groups: number; rows: number; bytes: number }];
  move: [MoveFrame, { groups: number; rows: number; bytes: number }];
  foreignLocks: [ForeignLocksFrame, void];
  locked: [LockedFrame, ExecRes];
  settle: [SettleFrame, Ts];
  exec: [ExecFrame, ExecRes];
  execAuto: [AutoFrame, ExecRes];
  direct: [DirectFrame, ExecRes | null];
  commitLocal: [PrepareFrame<Omit<PrepareReq, "anchor">>, CommitRes];
  prepare: [PrepareFrame<PrepareReq>, PrepareRes];
  unchanged: [UnchangedFrame, { ok: boolean; reason?: string }];
  syncSchema: [SyncSchemaFrame, { moving: boolean }];
  commit: [CommitFrame, CommitRes];
  drive: [DriveFrame, CommitRes];
  phase2: [Phase2Frame, void];
  finalize: [SettleTxnFrame<{ txn: string; c: Ts; pieces?: Piece[] }>, void];
  abort: [SettleTxnFrame<{ txn: string; pieces?: Piece[] }>, void];
  queryTxn: [TxnQueryFrame<{ txn: string; pushTo: Ts }>, TxnStatus];
  status: [TxnQueryFrame<{ txn: string }>, TxnStatus];
  redrive: [RedriveFrame, boolean];
  guarded: [GuardedFrame, Outcome<unknown>];
  orphan: [OrphanFrame, void];
}

export class ShardKernel {
  readonly id: string;
  epoch = 0;
  private b: Backend;
  private hlc = new Hlc(0);
  private ceiling: Ts = 0;
  private defs = new Map<string, TableDef>();
  /** スナップショットの、どれかの DDL が最後に確定した epoch (snap.schema)。渡す行の形の版として運ぶ (PiecePayload.schema)。 */
  private schema = 0;
  /**
   * Meta の epoch の列のうち、このシャードが適用した分の写し (__epoch の行) と、それを畳んだスナップショット (src/catalog.ts の fold)。
   * 表定義 (defs、schema) と所有を引く範囲表は、ここから作る。写しは epoch 0 から隙間なく続く。適用するたびに畳み直す。
   * 起動の回数の epoch (this.epoch、ExecRes.epoch) とは別の数である。
   */
  private log: Logged[] = [];
  private snap: Snapshot = fold([]);
  /** 表定義の適用が進行中か。殻が、適用を始めるときと終えたときに書く。 */
  private schemaChanging = false;
  /**
   * 適用が、いま intent の決着を待っている記録の、変えるもの (小文字の名前)。待っていなければ null。"all" は、欠陥のスイッチ
   * applyRefusesAll (段 3 の形) で、全部の表である。これに頼る新しい文は、適用が終わるまで待つ (schemaStep)。受けると、その表の intent が
   * 増え続けて、適用がいつまでも終わらない。ほかの表の文は通す (docs/design-catalog-epoch.md の「表ごとの epoch」の「シャード」)。
   */
  private applying: Set<string> | "all" | null = null;
  /** 直近の write の索引。キーごとの最新 commit 時刻だけを持ち、検査を O(1) にする。 */
  private recent = new Map<string, Ts>();
  private recentLowWater: Ts = 0;
  private maxCommit: Ts = 0;
  private logLowWater: Ts = 0;
  /**
   * 表ごとの、表定義の変更の床 (docs/design-catalog-epoch.md の「表ごとの epoch」の「シャード」の床)。鍵は小文字の表の名前で、値は、その表の
   * 読みの epoch を進める commit を適用したときに、このシャードの変更ログにあった、その表の確定の時刻の最大である (lastLogged。モデル
   * M23j の m23j_exact_*)。それらの確定の行イメージは、commit より前の表の形なので、床より古い時刻には、その表の行を読み戻せない。床より
   * 古い時刻の、その表の読み戻し、refresh、述語の検証を断る。床以上の時刻の読みが戻す行イメージは、commit の後の形のものだけである。
   * その表の確定が変更ログにないシャードは、床を置かない。ほかの表の読みは断らない (M24 の m24_floor_red_global)。
   * 床を見るのは、行を T まで戻すシャードである (自分の変更ログで戻すので、自分の床を見る)。
   * 欠陥のスイッチ globalDdlFloor は、どの commit でも、全部の表 (ALL_OBJECTS) の床を、適用した時刻に置く (段 3 の形)。ddlFloorAtApply は、
   * 表ごとの床を、適用した時刻に置く (M23j の m23j_always_*。前の形の最後の確定から適用までの間の時刻の読みを、要らないのに断る)。
   */
  private tableFloors = new Map<string, Ts>();
  private flushedTs: Ts = 0;
  private inflight = new Map<string, Flight>();
  private fenced: FencedRange[] = [];
  private incoming: IncomingRange[] = [];
  // 送り出しと到着の記録は、表では移動と piece ごと (g, epoch, after) に持つ。範囲が前の持ち主へ戻ると、同じシャードが同じグループを
  // 何度も渡し、受け取るからである。いまは、どの piece もグループの全体 (位置の区間が端から端まで) で、fence はブロックを途中で
  // 切らないので、メモリではグループの名前で、いまの状態だけを引く。
  /** 親：渡して、まだ受け取り直していないグループ。epoch は、渡した移動の move-start の epoch。 */
  private moved = new Map<string, { m: Ts; to: string; acked: boolean; epoch: number }>();
  /** 子：いちばん新しい到着と、その m と、その移動の epoch。 */
  private arrived = new Map<string, { m: Ts; epoch: number }>();
  private maxArrived: Ts = 0;
  /**
   * 範囲の床。受け取り終えた範囲と、そのとき渡した側から受け取った時刻 m である (__incoming の、終えた行)。
   * m は、渡した側が fence の後に発行した時刻で、渡した側がその範囲に確定したどの書き込みよりも大きい。このシャードは、範囲の
   * m より前の状態を持っていない。行のあったグループは到着の記録 (arrived) が同じことを守るが、渡した側が移動の前に空にした
   * グループは運ばれず、到着の記録がない。だから、範囲ごとに m を残し、その範囲のキーを T < m で読む要求を断る
   * (specs/m5b_live_migration.qnt の RANGE_FLOOR)。
   */
  private floors: (Interval & { m: Ts })[] = [];
  private maxFloor: Ts = 0;
  /** 行ロック。メモリだけに置く。消えても検証が F 以降の変更を見るので安全である。 */
  private locks = new Map<string, RowLock>();
  /**
   * 取引ごとの lease (docs/design-lock-lease.md、モデル M25)。鍵は取引の ID で、until は期限 (このシャードの時計の時刻)、epoch は、受けた
   * lease の版である。取引の行ロックは、どれも、この lease で生きる。期限は時刻で決まる。期限を過ぎた取引のロックは、誰かが見たか
   * どうかに関わらず、消えたものである。取引の生きているロックがなくなれば、lease も忘れる。再起動では、ロックと一緒に消える。
   */
  private leases = new Map<string, { until: number; epoch: number }>();
  private waiters = new Map<string, Waiter[]>();
  private stats = { at: 0, reads: 0, writes: 0, groups: new Map<string, number>() };
  private faults: Faults;
  private K: number;
  private rt: Pick<Runtime, "now">;

  constructor(private deps: KernelDeps) {
    this.id = deps.id;
    this.b = deps.backend;
    this.rt = deps.runtime ?? systemRuntime;
    this.faults = deps.faults ?? {};
    this.K = deps.K ?? 50;
    this.boot();
  }

  /** 試験が、状態を確かめるのに覗く。moves は、子として進める移動の数 (childMoves) である。 */
  peek(): { locks: ReadonlyMap<string, RowLock>; recentLowWater: Ts; moves: number } {
    return { locks: this.locks, recentLowWater: this.recentLowWater, moves: this.childMoves().length };
  }

  // ---- 起動と永続メタデータ ----

  private boot(): void {
    const b = this.b;
    b.exec(`CREATE TABLE IF NOT EXISTS __meta(k TEXT PRIMARY KEY, v)`);
    // ほかの表に触る前に確かめる。新しい形式の DO を、古いコードが作り変えてしまわないようにする。
    checkStorageFormat(b, "__meta", "shard");
    // Meta の epoch の列の写し (docs/design-catalog-epoch.md の段 2)。適用した記録を、Meta と同じ epoch と形で持つ。
    b.exec(`CREATE TABLE IF NOT EXISTS __epoch(epoch INTEGER PRIMARY KEY, rec TEXT NOT NULL)`);
    b.exec(`CREATE TABLE IF NOT EXISTS __intents(
      tbl TEXT NOT NULL, pk TEXT NOT NULL, sk TEXT NOT NULL, txn TEXT NOT NULL, anchor TEXT NOT NULL,
      prepare_ts INTEGER NOT NULL, change TEXT NOT NULL, PRIMARY KEY(tbl, pk))`);
    for (const ddl of CAPTURE_TABLES) b.exec(ddl);
    // 範囲の移動の記録 (docs/design-subslots.md の「シャードの記録」、docs/storage-format.md)。
    // 範囲は token の区間 [lo, hi) である。どの記録も、その移動の move-start の epoch を持つ (段 4)。範囲が前の持ち主へ戻ると、同じ
    // シャードが同じ区間とグループを何度も渡し、受け取るので、記録は移動ごとに分ける (docs/design-refresh-across-move.md の
    // 「受け取りの記録を残す期間」)。
    // piece は (グループ g, 移動の epoch, 位置の区間 (after, up_to]) で、after と up_to は位置の JSON (端は 'null') である。
    // __fenced と __incoming は、親と子が move-start を適用したときに書く。__incoming は、受け取り終えても消さず、done と、渡した側から
    // 受け取った時刻 m を残す。
    b.exec(`CREATE TABLE IF NOT EXISTS __fenced(lo INTEGER NOT NULL, hi INTEGER NOT NULL, "to" TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0,
      epoch INTEGER PRIMARY KEY)`);
    b.exec(`CREATE TABLE IF NOT EXISTS __incoming(lo INTEGER NOT NULL, hi INTEGER NOT NULL, from_id TEXT NOT NULL,
      done INTEGER NOT NULL DEFAULT 0, m INTEGER, epoch INTEGER PRIMARY KEY)`);
    b.exec(`CREATE TABLE IF NOT EXISTS __moved(g TEXT NOT NULL, lo INTEGER NOT NULL, hi INTEGER NOT NULL, "after" TEXT NOT NULL, up_to TEXT NOT NULL,
      m INTEGER NOT NULL, dest TEXT NOT NULL, acked INTEGER NOT NULL DEFAULT 0, epoch INTEGER NOT NULL, PRIMARY KEY(g, epoch, "after"))`);
    b.exec(`CREATE TABLE IF NOT EXISTS __moved_txn(txn TEXT NOT NULL, g TEXT NOT NULL, lo INTEGER NOT NULL, "after" TEXT NOT NULL,
      dest TEXT NOT NULL, epoch INTEGER NOT NULL, PRIMARY KEY(txn, g, epoch, "after"))`);
    b.exec(`CREATE TABLE IF NOT EXISTS __arrived(g TEXT NOT NULL, lo INTEGER NOT NULL, hi INTEGER NOT NULL, "after" TEXT NOT NULL, up_to TEXT NOT NULL,
      m INTEGER NOT NULL, epoch INTEGER NOT NULL, PRIMARY KEY(g, epoch, "after"))`);
    b.exec(`CREATE TABLE IF NOT EXISTS __txn(
      txn TEXT PRIMARY KEY, status TEXT NOT NULL, c INTEGER, participants TEXT, done INTEGER NOT NULL DEFAULT 0, at INTEGER)`);
    this.initStorage();

    this.log = b.exec(`SELECT epoch, rec FROM __epoch ORDER BY epoch`).map((r) => ({ epoch: r.epoch as number, rec: JSON.parse(r.rec as string) }));
    this.resnap();
    this.fenced = b.exec(`SELECT lo AS start, hi AS "end", "to", done, epoch FROM __fenced ORDER BY epoch`) as unknown as FencedRange[];
    // 受け取り終えた範囲は、メモリに載せない。載せると、移動の途中として扱われる。
    this.incoming = b.exec(`SELECT lo AS start, hi AS "end", from_id, epoch FROM __incoming WHERE done = 0 ORDER BY epoch`) as unknown as IncomingRange[];
    // 受け取り終えた範囲は、床として読み戻す。再起動で忘れると、床のない実装と同じになる (モデル m5b_red_floor_volatile)。
    for (const r of b.exec(`SELECT lo, hi, m FROM __incoming WHERE done = 1`)) {
      this.raiseFloor({ start: r.lo as number, end: r.hi as number }, (r.m as Ts | null) ?? 0);
    }
    // グループごとに、いちばん新しい送り出しと到着を読み戻す。送り出した後に受け取り直したグループは、渡した印を持たない。
    let maxMoved = 0;
    for (const r of b.exec(`SELECT g, m, dest, acked, epoch FROM __moved ORDER BY epoch`)) {
      this.moved.set(r.g as string, { m: r.m as Ts, to: r.dest as string, acked: r.acked === 1, epoch: r.epoch as number });
      if ((r.m as Ts) > maxMoved) maxMoved = r.m as Ts;
    }
    for (const r of b.exec(`SELECT g, m, epoch FROM __arrived ORDER BY epoch`)) {
      this.arrived.set(r.g as string, { m: r.m as Ts, epoch: r.epoch as number });
      this.maxArrived = Math.max(this.maxArrived, r.m as Ts);
    }
    // 「渡した」印は、そのグループが届き直したとき (到着の記録) か、そのグループを含む範囲を受け取り終えたとき (終えた __incoming) に
    // 外す (unmarked)。起動の後も、動いている間と同じ規則で作り直す。
    // 欠陥のスイッチ unmarkOnReturn は、段 4 のコードのとおり、受け取り始めただけの範囲でも外す。
    const received = b.exec(`SELECT lo, hi, epoch FROM __incoming ${this.faults.unmarkOnReturn ? "" : "WHERE done = 1"}`)
      .map((r) => ({ start: r.lo as number, end: r.hi as number, epoch: r.epoch as number }));
    for (const [g, k] of this.moved) if (this.unmarked(g, k.epoch, received)) this.moved.delete(g);
    this.epoch = ((this.metaGet("epoch") as number) ?? 0) + 1;
    this.metaSet("epoch", this.epoch);
    this.ceiling = (this.metaGet("ceiling") as number) ?? 0;
    this.flushedTs = (this.metaGet("flushed") as number) ?? 0;
    this.logLowWater = (this.metaGet("log_low_water") as number) ?? 0;
    this.tableFloors = new Map(JSON.parse((this.metaGet("ddl_floors") as string | null) ?? "[]") as [string, Ts][]);

    // 直近 write の索引はメモリにしかないので __log から作り直す。GC で消えた commit は logLowWater 以下にある。
    this.maxCommit = this.logLowWater;
    this.logEach("", [], (ts, _txn, blob) => {
      this.maxCommit = Math.max(this.maxCommit, ts);
      for (const c of decode<Change[]>(blob)) this.touch(c.table, c.pk, c.sk, ts);
    });
    const maxPrepare = (b.exec(`SELECT max(prepare_ts) v FROM __intents`)[0]?.v as number) ?? 0;
    // 再起動の前に予約した alarm がなくても、残った intent と phase 2 を片付け、子として受け取っている移動を進める
    // (docs/design-catalog-epoch.md の決めたこと 4)。
    const pendingWork = b.exec(`SELECT (SELECT count(*) FROM __intents) + (SELECT count(*) FROM __txn WHERE status = 'committed' AND done = 0) n`)[0]?.n as number;
    if (this.childMoves().length > 0) this.deps.scheduleRedrive?.("move");
    else if (pendingWork > 0) this.deps.scheduleRedrive?.();
    const resume = Math.max(this.faults.hlcNoCeiling ? 0 : this.ceiling, this.maxCommit, maxPrepare, maxMoved, this.maxArrived, this.maxFloor);
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
  private logScan(where: string, params: Plain[], limit?: number): Row[] {
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
  private logEach(where: string, params: Plain[], fn: (commitTs: Ts, txn: string, blob: string) => boolean | void): void {
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

  private metaGet(k: string): Plain {
    return this.b.exec(`SELECT v FROM __meta WHERE k = ?`, k)[0]?.v ?? null;
  }
  private metaSet(k: string, v: Plain): void {
    this.b.exec(`INSERT INTO __meta(k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`, k, v);
  }

  /**
   * 適用に失敗した commit。試しに通った文が、同じ行に対して通らなかった (保存の障害のほかには起きないはずである。M21 の commitApplies)。
   * 取り消しはないので、直るまで、このシャードは要求を受けられない。health が報告する。
   */
  private schemaStuck: { epoch: number; message: string } | null = null;

  private def(table: string): TableDef {
    const d = this.defs.get(table);
    if (!d) throw new SqlError(`no such table: ${table}`);
    return d;
  }
  /** 写しを畳み直し、表定義と表定義の epoch を取り直す。 */
  private resnap(): void {
    this.snap = fold(this.log, undefined, this.faults);
    this.defs = new Map(Object.entries(this.snap.tables));
    this.schema = this.snap.schema;
  }
  /** 写しが進んだ最後の epoch。まだ何も適用していなければ -1。 */
  private get applied(): number {
    return this.log.at(-1)?.epoch ?? -1;
  }
  /** 記録を写しに足す。呼び出し側は、同じ取引の中で、記録の文を実行していてよい。畳み直しは呼び出し側が resnap で行う。 */
  private store(x: Logged): void {
    this.b.exec(`INSERT INTO __epoch(epoch, rec) VALUES (?, ?)`, x.epoch, JSON.stringify(x.rec));
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

  // 所有は token の区間で引く。1 行 (書く行、主キーの span) は token 1 つで、shard key の span は、そのブロックの全体である。
  // いまは、fence も受け取り中の範囲もブロックを途中で切らないので、同じ shard key の 1 行と全体は、同じ範囲に当たる。

  /** 所有を確かめる対象の区間。pk を省くと、その shard key のブロックの全体である。 */
  private areaOf(sk: string, pk?: string): Interval {
    if (pk === undefined) return blockOf(sk);
    const token = tokenOf(sk, pk);
    return { start: token, end: token + 1 };
  }
  /** 欠陥のスイッチで、範囲の床を見ない。servePastMove は、到着の記録の確かめと一緒に、床の確かめも外す。 */
  private pastFloor(): boolean {
    return Boolean(this.faults.servePastMove || this.faults.noRangeFloor);
  }
  private incomingIn(area: Interval): IncomingRange | undefined {
    return this.incoming.find((f) => overlaps(f, area));
  }
  /** グループ g が、受け取り中の移動 range で、もう届いたか。前の移動で届いて、その後に渡したグループは、届いていない。 */
  private arrivedIn(g: string, range: IncomingRange): boolean {
    return this.arrived.get(g)?.epoch === range.epoch;
  }
  /**
   * 移動 epoch で渡したグループ g の「渡した」印 (moved) を外してよいか。印のある間、g の intent はここでは適用せず、phase 2 は渡した先へ
   * 転送する (localIntents、forwards)。外すのは、g がその後の移動で届き直したとき (到着の記録) か、g を含む範囲をその後の移動で受け取り
   * 終えたとき (received。行も intent もないグループは運ばれず、到着の記録がない) だけである。範囲を受け取り始めただけでは外さない。
   * 外すと、g が届く前に来た phase 2 を、ここでは intent がないので何もせず、印がないので転送もせずに、受け取ったと答える。anchor は
   * 届け終えた印を付け、記録を消した後は、届いた intent を presumed abort で捨てる (未解決の問題 54、specs/m5c_phase2_return.qnt の
   * m5c_red_clear_at_start。不変条件: 参加者は、intent を適用したか、いまの持ち主へ転送した後でだけ、phase 2 を受け取ったと答える)。
   * 起動のときも、動いている間 (receiveStep、finishIncoming) も、この規則で外す。
   */
  private unmarked(g: string, epoch: number, received: (Interval & { epoch: number })[]): boolean {
    if ((this.arrived.get(g)?.epoch ?? -1) > epoch) return true;
    return received.some((r) => r.epoch > epoch && overlaps(blockOf(g), r));
  }
  /** 子として進める移動の epoch。受け取り中の移動と、受け取り終えたが、自分の写しでまだ閉じていない (move-end を記録させていない) 移動である。 */
  private childMoves(): number[] {
    const out = new Set(this.incoming.map((x) => x.epoch));
    for (const m of this.snap.moves) if (m.to === this.id) out.add(m.epoch);
    return [...out].sort((a, b) => a - b);
  }
  /** 区間に掛かる範囲の床のうち、いちばん大きい m。掛かる床がなければ 0。 */
  private floorIn(area: Interval): Ts {
    let m = 0;
    for (const f of this.floors) if (f.m > m && overlaps(f, area)) m = f.m;
    return m;
  }
  /** 範囲の床を上げる。同じ範囲の床がもうあれば、大きい方の m を残す。 */
  private raiseFloor(range: Interval, m: Ts): void {
    const known = this.floors.find((f) => sameInterval(f, range));
    if (known) known.m = Math.max(known.m, m);
    else this.floors.push({ ...range, m });
    this.maxFloor = Math.max(this.maxFloor, m);
  }
  /**
   * 所有を確かめる対象。書く行、範囲の順に並べる。この順は、sksOf の順と同じである。
   * 複数の対象が別々の理由で断られるとき、先に並んだものの理由が、要求の答えになる。
   */
  private areasOf(spans: Span[], writes: Pick<Change, "pk" | "sk">[]): { sk: string; area: Interval }[] {
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
  private wholeSlotsOnly(x: Interval): void {
    try {
      checkInterval(x);
    } catch (e) {
      throw new SqlError((e as Error).message);
    }
    if (!slotAligned(x)) throw new SqlError(`moving a part of a slot is not supported yet: ${rangeText(x)}`);
  }
  /**
   * 区間 area の全体が、自分のスナップショットの範囲表で、自分の区間に入るか (docs/design-catalog-epoch.md の「要求ごとの確かめ」)。
   * 範囲表の項目は、区間の始まりの順に並び、重ならない。まだ何も適用していないシャードの範囲表は空で、どの区間も持たない。
   */
  private mineInSnapshot(area: Interval): boolean {
    let at = area.start;
    for (const r of this.snap.routing.ranges) {
      if (r.shard !== this.id || r.end <= at) continue;
      if (r.start > at) return false;
      at = r.end;
      if (at >= area.end) return true;
    }
    return false;
  }
  /** スナップショットの範囲表で、区間 area に掛かる、自分でない持ち主。断る誤りに書く。 */
  private ownerInSnapshot(area: Interval): string {
    return this.snap.routing.ranges.find((r) => r.shard !== this.id && overlaps(r, area))?.shard ?? `nobody in the range table of epoch ${this.applied}`;
  }
  /**
   * 要求の行と範囲が、どれも自分のスナップショットで自分のものか。入口 (schemaStep) が、範囲の記録を適用するかを決めるのに使う。
   * 1 行は token 1 つ、shard key の範囲はそのブロック、全表の範囲は読み手の claim である。claim のない全表の範囲は数えない。
   */
  private ownsRows({ spans, writes }: Pick<Rows, "spans" | "writes">): boolean {
    for (const { area } of this.areasOf(spans, writes)) if (!this.mineInSnapshot(area)) return false;
    for (const s of spans) if (isWideSpan(s)) for (const c of s.claim ?? []) if (!this.mineInSnapshot(c)) return false;
    return true;
  }
  /**
   * 区間 area (shard key sk の 1 行か、そのブロック) を、このシャードが持っていないときの、断る誤り。持っていれば null。
   * 時刻に依らない部分だけを見る。断るのは 2 つで、先に当たったものの誤りを返す。
   *   1. 自分のスナップショットの範囲表で自分のものでない範囲。NotOwner (宛先はスナップショットの持ち主)。要求の epoch が新しければ、
   *      入口で範囲の記録を適用してから、ここへ来る (schemaStep)。親の fence は、move-start を適用したことで、そのときから
   *      スナップショットの範囲表が区間を子に渡す (段 4)。手放した記録 (__fenced) とは比べない。比べると、範囲が前の持ち主へ戻った後も、
   *      前の持ち主が断り続ける。
   *   2. 受け取り中の範囲の、まだ届いていないグループ。競合である。
   * 同期区間の入口 (assertOwned) と、書き込みの守り (claimed) が、同じこの規則で所有を引く。欠陥のスイッチ ignoreFence は、1 を外す。
   */
  private notOwned(sk: string, area: Interval): Error | null {
    if (!this.faults.ignoreFence && !this.mineInSnapshot(area)) return new NotOwner(this.ownerInSnapshot(area));
    const range = this.incomingIn(area);
    if (range && !this.arrivedIn(sk, range)) return new ConflictError(`group not arrived: ${sk}`);
    return null;
  }
  private sksOf(spans: Span[], writes: Pick<Change, "sk">[] = []): string[] {
    const out = new Set<string>(writes.map((w) => w.sk));
    for (const s of spans) if (s.kind === "pk" || s.kind === "sk" || (s.kind === "pred" && s.sk)) out.add(s.sk!);
    return [...out];
  }


  /**
   * 読む範囲と書く行を、読む時刻でこのシャードが持っているか。親は fence した (move-start を適用した) 範囲を一切受理せず、子は T < m を拒否する。
   * 子に T < m の状態はないので、答えると移動前の commit を失った結果を返すことになる。
   *
   * 同期区間の入口では、enter がこれを呼ぶ。ほかに呼ぶのは、intent の決着を始める前だけである (exec、lockedExec、execAuto)。
   * 決着の問い合わせは、相手の取引の確定の時刻を押し上げる。持ち主でない要求は結局断るので、問い合わせる前に断る。
   * そこで通っても、決着を待った後で enter がもう一度確かめる。
   */
  private assertOwned({ spans, writes, at: T }: Rows): void {
    for (const { sk, area } of this.areasOf(spans, writes)) {
      const refused = this.notOwned(sk, area);
      if (refused) throw refused;
      const m = this.arrived.get(sk)?.m;
      if (m !== undefined && T !== null && T < m && !this.faults.servePastMove) throw new ReadTooOld(`moved at ${m}`);
      // 範囲の床。受け取り終えた範囲のキーは、到着の記録があってもなくても、T < m では答えない。
      const floor = this.pastFloor() ? 0 : this.floorIn(area);
      if (T !== null && T < floor) throw new ReadTooOld(`moved at ${floor}`);
    }
    const wide = spans.filter(isWideSpan);
    if (wide.length > 0) {
      // 全表の span が覆うのは、読み手の範囲表でこのシャードが持つ範囲 (claim) である。
      // claim が自分のスナップショットで自分の区間に入らなければ (手放した範囲を含めば)、読み手の範囲表は古く、読み手は子を読まない。
      // 移動が終わった後も断り続ける。親が残りの行だけを答えると、子へ移った行はどのシャードからも返らない (1 行と同じ規則。notOwned)。
      if (!this.faults.ignoreFence && !this.faults.staleWideRead) {
        for (const s of wide) {
          for (const range of s.claim ?? []) if (!this.mineInSnapshot(range)) throw new NotOwner(this.ownerInSnapshot(range));
        }
      }
      // 全表の読みは親と子の両方に行く。移動の途中は片方のグループが飛行中で、欠落が起こり得る。
      if (this.incoming.length > 0 || this.fenced.some((f) => !f.done)) throw new Migrating();
      if (T !== null && T < this.maxArrived && !this.faults.servePastMove) throw new ReadTooOld(`moved at ${this.maxArrived}`);
      // 行を 1 つも運ばなかった移動では、到着の記録がなく、maxArrived は 0 のままである。範囲の床は、その移動も覚えている。
      if (T !== null && T < this.maxFloor && !this.pastFloor()) throw new ReadTooOld(`moved at ${this.maxFloor}`);
    }
  }

  // ---- 表定義のものの epoch ----

  /**
   * 頼るもの d の、このシャードのスナップショットでの epoch (docs/design-catalog-epoch.md の「表ごとの epoch」)。書き込みとして頼るものは
   * 書き込みの epoch、ほかは読みの epoch である。このシャードが知らない名前は 0 で、要求のほうが新しければ、列を適用してから比べ直す。
   * 欠陥のスイッチ writeComparesRead は、書き込みも読みの epoch と比べる (M24 の m24_red_write_epoch)。
   */
  private epochOf(d: Dep): number {
    const o = this.snap.objects[d.name];
    if (!o) return 0;
    return d.write && !this.faults.writeComparesRead ? o.write : o.read;
  }
  /** 要求が頼るもの d の epoch が、このシャードのものと違うときの、断る誤り。計画を取り直させる (経路の拒否と同じ)。 */
  private staleSchema(d: Dep): NotOwner {
    return new NotOwner(`stale schema: ${d.name} is at ${d.write ? "write " : ""}epoch ${this.epochOf(d)} on shard ${this.id}, and the request was planned at epoch ${d.epoch}`);
  }

  // ---- 同期区間 ----

  /**
   * 同期区間に入る。要求を処理する関数は、待つ段 (表定義の適用、グループの到着、intent の決着、行ロックの待ち) を終えたら
   * これを呼び、返った印を使って、await を挟まずに状態を読み書きする。もう一度待ったら、もう一度呼ぶ。
   *
   * 待っている間に変わり得ることを、ここで確かめ直す。入口ごとに手で並べない。確かめるのは、引数に挙げたことである。
   *   deps: 要求が頼る表定義のもの (表と view) が、どれも、まだ現行か。入口で確かめた後、行ロックや intent の決着を待っている間に
   *     DDL が適用されることがある。そのまま書くと、新しいグローバル index を保守しない古い計画が通ってしまう。
   *   spans、writes、at: 読む範囲と書く行を、読む時刻でこのシャードが持っているか (assertOwned)。所有は token の区間で
   *     確かめる。1 行は token 1 つ、shard key の範囲はブロックの全体、全表の範囲は読み手の claim である。
   * 確かめるだけで、状態は変えない。時計を進める、数える、ロックを延ばすのは、呼び出し側が区間の中でする。
   */
  private enter(claim: Plan & Rows): Section<Check>;
  private enter(claim: Plan): Section<"schema">;
  private enter(claim: Rows): Section<"owned">;
  private enter(claim: Partial<Plan> & Partial<Rows>): Section<Check> {
    const rechecked: { schema?: true; owned?: true } = {};
    if ("deps" in claim) {
      const moved = this.faults.noSchemaRecheck ? undefined : claim.deps!.find((d) => d.epoch !== this.epochOf(d));
      if (moved) throw this.staleSchema(moved);
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

  moves(_req: Record<string, never>): { outgoing: (Interval & { to: string })[]; incoming: (Interval & { from: string })[] } {
    return {
      outgoing: this.fenced.filter((f) => !f.done).map((f) => ({ start: f.start, end: f.end, to: f.to })),
      incoming: this.incoming.map((x) => ({ start: x.start, end: x.end, from: x.from_id })),
    };
  }



  /**
   * 子からの移動の要求 (listGroups、pull、finishMove) が名指しする fence。epoch は移動の move-start の epoch で、親はその epoch まで
   * 列を適用してから引く (M21 の PULL_AT_EPOCH)。区間も、その fence の区間でなければならない。epoch を運ばない要求 (試験が直に
   * 送る) は、区間の終わっていない fence を引く。
   */
  private fenceOf(req: Interval & { epoch?: number }): FencedRange | undefined {
    if (req.epoch !== undefined) return this.fenced.find((x) => x.epoch === req.epoch && sameInterval(x, req));
    return this.fenced.find((x) => sameInterval(x, req) && !x.done);
  }

  /**
   * 範囲のグループを列挙する。fence の後に呼べば取り残しはない。
   * ack されていないグループは移動済みでも返す。子が受け取る前に落ちると応答が失われるからである。
   * 渡して ack を受けたと数えるのは、この移動 (fence の epoch) で渡したグループだけである。前の移動で渡して、受け取り直したグループは数えない。
   */
  private listGroups(req: Interval & { limit: number; cursor?: GroupCursor | null; epoch?: number }): { groups: string[]; cursor: GroupCursor | null } {
    // ブロックを途中で切る範囲では、範囲の中に行か intent を持つグループだけを挙げることになる。いまは、切らない範囲だけを受ける。
    this.wholeSlotsOnly(req);
    const epoch = this.fenceOf(req)?.epoch ?? req.epoch;
    const handed = (g: string) => {
      const k = this.moved.get(g);
      return k !== undefined && k.epoch === epoch && k.acked;
    };
    const out: string[] = [];
    const seen = new Set<string>();
    const add = (g: string) => {
      const slot = slotOf(g);
      if (slot >= req.start && slot < req.end && !handed(g) && !seen.has(g)) {
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
        // shard key の値は、タプルで読む。素の列で読むと、DO のドライバは 2^53 を超える INTEGER を丸める。丸めたキーのグループは、
        // 移動で運ばれずに取り残される。
        const { rows } = this.b.query(
          `SELECT ${tupleSql(def.shardKey.map(q))} FROM (SELECT DISTINCT ${cols} FROM ${q(def.name)} ${where} ORDER BY ${cols} LIMIT -1 OFFSET ${skip})`,
          keyset ? cursor.after! : [],
        );
        let read = 0;
        for (const raw of rows) {
          read++;
          const r = decodeTuple(parseTuple(raw[0] as string));
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
    for (const [g, k] of this.moved) if (k.epoch === epoch) add(g);
    return { groups: out, cursor: null };
  }





  ack(req: { pieces: Piece[] }): void {
    this.b.tx(() => {
      for (const p of req.pieces) {
        const g = p.g;
        // いまは、渡した piece はどれもグループの全体で、移動ごとにグループに 1 つである。記録もグループの名前で引く。
        // 前の移動の piece の遅れた ack は数えない。受け取り直した後の行を消してしまう。
        const known = p.after === null ? this.moved.get(g) : undefined;
        if (!known || known.acked || known.epoch !== p.epoch) continue;
        for (const def of this.defs.values()) {
          for (const row of selectGroup(this.b, def, g)) deleteRow(this.b, def, tupleKey(def, row).pk);
        }
        this.b.exec(`DELETE FROM __intents WHERE sk = ?`, g);
        this.b.exec(`UPDATE __moved SET acked = 1 WHERE g = ? AND epoch = ?`, g, p.epoch);
        known.acked = true;
      }
    });
  }

  /** 範囲を渡し終えた印を付けて、子に渡す時刻を返す。呼ぶのは、移動の epoch まで列を適用した後である (finishMoveStep)。 */
  private finishHanding(req: Interval & { epoch?: number }): { m: Ts } {
    const f = this.fenceOf(req);
    if (f && !f.done) {
      this.b.exec(`UPDATE __fenced SET done = 1 WHERE epoch = ?`, f.epoch);
      f.done = 1;
    }
    // fence の後、このシャードは範囲の行について何も答えていない。いま発行する時刻は、範囲について答えたどの読みの時刻よりも、
    // 確定したどの書き込みの時刻よりも大きい。もう終えた範囲にもう一度呼ばれても、新しく発行してよい (どちらの時刻も、この性質を持つ)。
    return { m: this.issue() };
  }

  /**
   * 範囲を受け取り終えた印を付ける (子が、移動を進める手順 moveStep の中で、親の finishMove の後に呼ぶ)。
   * 行のあるグループは、pull が時刻を運び、時計はそこまで進んでいる (receive)。渡す側に行のなかったグループは運ばれないので、
   * 渡す側の時計を、ここで受け取る。受け取らないと、渡す側が「行はない」と答えた時刻より小さい時刻で、その行を書いてしまい、
   * 答え済みの読みが、後から書き込みの後になる (モデル M5b の noWriteBelowRead)。
   * 記録は消さずに、終えた印と、渡した側から受け取った時刻を残す。メモリからは外すので、移動の途中ではなくなる。残した記録が、範囲の床で
   * あり、移動をまたぐ確かめがたどる受け取りの記録である。記録は受け取りごとにあり、書き換えるのは、いま受け取っている移動の行だけで
   * ある (docs/design-refresh-across-move.md の「実装がすること」の 5)。もう受け取り終えた移動には何もしない。前の受け取りの m を
   * 書き換えると、尋ねる列が、どの受け取りをたどるかを選べなくなる。
   */
  finishIncoming(req: Interval & { m: Ts }): void {
    if (!this.faults.finishWithoutClock) this.observe(req.m);
    const cur = this.incoming.find((x) => sameInterval(x, req));
    if (!cur) return;
    this.b.exec(`UPDATE __incoming SET done = 1, m = ? WHERE epoch = ? AND done = 0`, req.m, cur.epoch);
    this.incoming = this.incoming.filter((x) => x !== cur);
    this.raiseFloor(intervalOf(req), req.m);
    // 範囲が前の持ち主へ戻ったとき、運ばれなかった (行も intent もない) グループの「渡した」印は、受け取り終えたここで外す (unmarked)。
    for (const [g, k] of [...this.moved]) if (this.unmarked(g, k.epoch, [cur])) this.moved.delete(g);
  }

  health(_req: Record<string, never>): ShardHealth {
    const one = (sql: string, ...params: Plain[]) => (this.b.exec(sql, ...params)[0]?.v as number | null) ?? 0;
    const oldest = one(`SELECT min(prepare_ts) v FROM __intents`);
    return {
      id: this.id, schema: this.schema, format: STORAGE_FORMAT, bytes: this.b.size(),
      intents: one(`SELECT count(*) v FROM __intents`),
      oldestIntentMs: oldest === 0 ? 0 : Math.max(0, this.deps.clock.now() - tsToPhysical(oldest)),
      unapplied: one(`SELECT count(*) v FROM __txn WHERE status = 'committed' AND done = 0`),
      redriveErrors: this.lastRedriveErrors,
      schemaError: this.schemaStuck ? `schema change of epoch ${this.schemaStuck.epoch}: ${this.schemaStuck.message}` : null,
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
    // 列ごとに要素の式を掛けて、型ごと読む (docs/design-values.md の「エクスポートと取り込み」)。D∞ が作る文で、列の参照だけを
    // 読むので、包む CTE は要らない。PRIMARY KEY のない表は rowid も読む (行の所在を決める値である)。
    const columns = [...(def.implicitRowid ? ["rowid"] : []), ...def.columns];
    const list = columns.map((c) => selectElemSql(c === "rowid" ? "rowid" : q(c))).join(", ");
    const keyset = req.after !== null && req.after.every((v) => v !== null);
    const where = keyset ? `WHERE (${cols}) > (${def.pk.map(() => "?").join(", ")})` : "";
    const limit = Math.max(1, Math.min(req.limit, 5000));
    // 主キーに NULL を含む行は、行の比較では「その次」を表せない。その場合は、読んだ行数で続きを表す。
    const offset = keyset ? "" : ` OFFSET ${Math.max(0, Math.floor(req.skip ?? 0))}`;
    const { rows } = this.b.query(
      `SELECT ${list} FROM ${q(def.name)} ${where} ORDER BY ${cols} LIMIT ${limit}${offset}`, keyset ? req.after! : [],
    );
    const out: Value[][] = [];
    let bytes = 0;
    for (const raw of rows) {
      const r = raw.map(decodeElem);
      out.push(r);
      for (const v of r) bytes += sizeOf(v);
      // 1 回の応答が大きくなりすぎないよう、行数の上限より先にバイト数で切る。続きは次の呼び出しで読む。
      if (bytes > 4_000_000) break;
    }
    return { columns, rows: out, pk: def.pk.map((c) => columns.indexOf(c)) };
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

  liveLock(key: string): RowLock | undefined {
    const l = this.locks.get(key);
    if (!l) return undefined;
    const lease = this.leases.get(l.txn);
    if (!lease || lease.until <= this.deps.clock.now()) {
      this.expire(l.txn);
      return undefined;
    }
    return l;
  }

  /** 行のロックの期限 (持ち主の取引の lease の期限)。ロックがなければ undefined。殻が、待ち手を起こすタイマーを掛けるのに使う。 */
  lockExpiry(key: string): number | undefined {
    const l = this.locks.get(key);
    return l ? this.leases.get(l.txn)?.until : undefined;
  }

  /** 取引の lease が切れた。取引のロックを全部消し、待ち手を起こす。lease も忘れる。 */
  private expire(txn: string): void {
    this.leases.delete(txn);
    for (const [key, l] of this.locks) {
      if (l.txn !== txn) continue;
      this.locks.delete(key);
      this.wakeNext(key);
    }
  }

  /** 取引 txn に、生きている行ロックがあるか。期限を過ぎた lease は、ここで片付ける。 */
  private hasLocks(txn: string): boolean {
    const lease = this.leases.get(txn);
    if (!lease) return false;
    if (lease.until <= this.deps.clock.now()) {
      this.expire(txn);
      return false;
    }
    return true;
  }

  /**
   * 取引の lease を、要求か renew が運ぶ lease で延ばす (docs/design-lock-lease.md の「シャードがすること」)。
   *   取引の生きているロックがなければ、何もしない。lease も作らない。期限を過ぎたロックは、延長では戻らない (EXTEND_ONLY)。
   *   運ばれた版が、持っている版より大きければ、期限を、受けた時刻 + 残りにする。等しいか小さければ、何もしない。受けたことのある版の
   *   延長が、ランタイムの再試行で何度届いても、延びない (EPOCH_CHECK)。
   * 欠陥のスイッチ perShardLockTtl は、運ばれた lease を見ない。leaseIgnoresEpoch は、版を比べずに延ばす。
   */
  private extend(txn: string, lease: TxnLease | undefined): void {
    if (!lease || this.faults.perShardLockTtl || !this.hasLocks(txn)) return;
    const mine = this.leases.get(txn)!;
    const until = this.deps.clock.now() + lease.ms;
    if (this.faults.leaseIgnoresEpoch) mine.until = Math.max(mine.until, until);
    else if (lease.epoch > mine.epoch) mine.until = until;
    mine.epoch = Math.max(mine.epoch, lease.epoch);
  }

  /** 取引の lease を延ばす (ShardApi.renew)。 */
  renew(req: { txn: string; lease: TxnLease }): void {
    this.extend(req.txn, req.lease);
  }

  wakeNext(key: string): void {
    const q2 = this.waiters.get(key);
    const next = q2?.shift();
    if (q2 && q2.length === 0) this.waiters.delete(key);
    next?.wake();
  }

  private wakeAll(key: string): void {
    // 列の写しをたどる。起こされた待ち手は、その場で同じ列から自分を消す (殻の waitForRow の leave)。列そのものをたどると、
    // 1 つおきに飛ばされ、飛ばされた待ち手は、行が空いた後も待ちの期限 (5 秒) まで待って失敗した
    // (test/waiters-behind-intent.test.ts。2026-11-14 に、核と殻に分ける作業で見つけた)。
    const list = [...(this.waiters.get(key) ?? [])];
    this.waiters.delete(key);
    for (const w of list) w.wake();
  }

  /**
   * 行のロックを与える。ロックは、取引の lease に加わる。lease がまだなければ、要求の lease で作る。arrived は、要求が着いた時刻である
   * (ロックを待った後で与えるときも、期限は、着いた時刻 + 残りで決める。待っている間の文を、文を受けたシャードだけが延ばすと、行が 1 つの
   * シャードにある取引だけが、長くロックを持つ)。lease を運ばない要求 (試験が直に送る) の期限は、着いた時刻 + TTL である。
   */
  private grant(key: string, owner: LockOwner, arrived: number): void {
    if (!this.hasLocks(owner.txn)) {
      // 欠陥のスイッチ perShardLockTtl と localLockLease は、自分の時計で期限を決める (arrive)。
      const own = this.faults.perShardLockTtl ? this.ttl() : this.faults.localLockLease ? this.ttl() + this.ttl() * (LOCK_LEASE_SLACK_MS / LOCK_TTL_MS) : undefined;
      const until = own !== undefined ? this.deps.clock.now() + own : arrived + (owner.lease?.ms ?? this.ttl());
      this.leases.set(owner.txn, { until, epoch: owner.lease?.epoch ?? 0 });
    }
    this.locks.set(key, owner);
  }

  private ttl(): number {
    return this.deps.lockTtlMs ?? LOCK_TTL_MS;
  }

  /**
   * ロックを取る文が着いた。取引の lease を、要求の lease で延ばす。
   * 欠陥のスイッチ perShardLockTtl (2026-11-17 までの形) は、自分の時計で TTL だけ延ばす。localLockLease は、自分の時計で lease の長さ
   * (TTL + 余裕) だけ延ばす。どちらも、文を受けたシャードのロックだけが延びる。
   */
  private arrive(me: LockOwner): void {
    if (this.faults.perShardLockTtl || this.faults.localLockLease) {
      const mine = this.hasLocks(me.txn) ? this.leases.get(me.txn)! : undefined;
      const ttl = this.ttl();
      if (mine) mine.until = this.deps.clock.now() + (this.faults.localLockLease ? ttl + ttl * (LOCK_LEASE_SLACK_MS / LOCK_TTL_MS) : ttl);
      if (mine && me.lease) mine.epoch = Math.max(mine.epoch, me.lease.epoch);
      return;
    }
    this.extend(me.txn, me.lease);
  }

  private releaseLocks(txn: string): void {
    const id = lockIdOf(txn);
    this.leases.delete(id);
    for (const [key, l] of this.locks) {
      if (l.txn !== id) continue;
      this.locks.delete(key);
      this.wakeNext(key);
    }
  }

  unlock(req: { txn: string }): void {
    this.releaseLocks(req.txn);
  }

  // ---- 行を待つ (殻の waitForRow が使う) ----
  //
  // 待ち手の列と、奪う判断は、核が持つ。殻は、期限、奪うまでの猶予、保持者の期限切れの 3 つのタイマーを掛け、起こされるのを待つ。

  /**
   * 行を押さえている相手。ロックの持ち主か、欠陥 woundPrepared のときは、ロックのない行の intent の持ち主 (prepare 済みの取引) である。
   * intent に開始時刻はないので、prepare_ts の物理時刻で代える。
   */
  holderOf(key: string): { lock: RowLock | undefined; intent: Intent | undefined; held: LockOwner | undefined } {
    const lock = this.liveLock(key);
    const cut = key.indexOf("\0");
    const intent = !lock && this.faults.woundPrepared ? this.intentAt(key.slice(0, cut), key.slice(cut + 1)) : undefined;
    const held: LockOwner | undefined = lock ?? (intent && { txn: intent.txn, start: tsToPhysical(intent.prepare_ts) });
    return { lock, intent, held };
  }

  /**
   * 待ち手を、行の列に入れる。古い取引を先に起こす。同じ開始時刻の間は到着順である。
   * 返すのは、入れた列である。待ち手は、去るときに、入れた列から自分を消す (leave)。
   */
  enqueue(key: string, w: Waiter): Waiter[] {
    const list = this.waiters.get(key) ?? [];
    const at = list.findIndex((x) => this.older(w, x));
    list.splice(at < 0 ? list.length : at, 0, w);
    this.waiters.set(key, list);
    return list;
  }

  leave(list: Waiter[], w: Waiter): void {
    const at = list.indexOf(w);
    if (at >= 0) list.splice(at, 1);
  }

  /**
   * 古い取引が、猶予の後で、若い保持者から行を奪う (wound-wait)。保持者が替わっていたら、奪わずに false を返す。
   * 奪われた取引は commit の検証で気付く。
   */
  wound(key: string, held: LockOwner, intent: Intent | undefined): boolean {
    if (intent) {
      if (this.intentAt(intent.tbl, intent.pk)?.txn !== intent.txn) return false;
      this.b.exec(`DELETE FROM __intents WHERE tbl = ? AND pk = ?`, intent.tbl, intent.pk);
    } else {
      if (this.locks.get(key)?.txn !== held.txn) return false;
      this.locks.delete(key);
      // 取引のロックが全部なくなったら、lease も忘れる。
      if (![...this.locks.values()].some((l) => l.txn === held.txn)) this.leases.delete(held.txn);
    }
    return true;
  }

  /** 進行中の確定の決着を待つものを登録する。 */
  onSettled(txn: string, wake: () => void): void {
    this.inflight.get(txn)!.waiters.push(wake);
  }

  /** 殻が、表定義の適用を始めたときと、終えたときに呼ぶ。 */
  schemaChangeStarted(): void {
    this.schemaChanging = true;
  }
  schemaChangeEnded(): void {
    this.schemaChanging = false;
  }

  /**
   * 行ロックの待ちの順序 (wound-wait。古い者が先に起き、若い保持者から行を奪う)。全順序である。
   *   1. 開始時刻の早いほうが古い。
   *   2. 同じ開始時刻なら、取引が autocommit の書き込みより古い。autocommit はロックを持たず、行が空くのを待つ側にしかいない (autoStep)。
   *      取引の行を奪うと、取引の COMMIT が検証で競合になる。前は ID の文字列で比べ、`auto-` が `t-` より前なので、同じミリ秒の
   *      autocommit がいつも取引を奪った (test/wound-wait-tie.test.ts)。
   *   3. autocommit どうしは、シャードが発行した時刻 (auto) の順である。
   *   4. 取引どうしは ID で比べる。どちらが先でもよいが、順序は全体で 1 つに決まっていなければならない (specs/m9_protocol.qnt の older は
   *      取引の番号で比べる)。
   */
  older(a: LockOwner, b: LockOwner): boolean {
    if (a.start !== b.start) return a.start < b.start;
    if ((a.auto === undefined) !== (b.auto === undefined)) return a.auto === undefined;
    if (a.auto !== undefined && b.auto !== undefined && a.auto !== b.auto) return a.auto < b.auto;
    return a.txn < b.txn;
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



  now(_req: Record<string, never>): Ts {
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
  private rowMatches(s: Extract<Span, { kind: "pred" }>, def: TableDef, pk: string, row: Tuple): boolean {
    try {
      return this.rollback(() => {
        deleteRow(this.b, def, pk);
        insertRow(this.b, def, row);
        // 利用者の表に触る文なので、query で読む。結果に INTEGER を返さない (query は INTEGER をドライバの数で読む文を受けない)。
        return queryAll(this.b, predicateRowSql(def, s.alias, s.where), [...s.params, ...pkValues(pk)]).length > 0;
      });
    } catch {
      return true;
    }
  }

  /** (from, 現在] の commit のうち、述語に関わるものがあるか。 */
  private predicateChanged(s: Extract<Span, { kind: "pred" }>, from: Ts): boolean {
    const def = this.defs.get(s.table);
    if (!def || from < this.logLowWater || from < this.floorOf([s.table])) return true;
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

  /**
   * 変更ログにある、表 keys (小文字の名前) の行の確定の時刻の最大。なければ 0。表定義の変更の床に使う (tableFloors)。
   * 表ごとの最新の確定の時刻は、直近 write の索引が持つ (touch の `t\0表`。起動のときに変更ログから作り直す)。索引は、膨らむと捨てる
   * (pruneRecent)。捨てた時刻以下の確定は索引にないので、変更ログから探す。変更ログの切り詰めで消えた確定は、数えない (それより古い
   * 時刻の読みは、logLowWater が断る)。
   * RENAME TO は、前の名前と後の名前の両方が keys に入る。後の名前の床は、前の名前で記録された確定の時刻になる。
   */
  private lastLogged(keys: ReadonlySet<string>): Ts {
    let last = 0;
    for (const [k, ts] of this.recent) {
      if (ts > last && k.startsWith("t\0") && keys.has(objectKey(k.slice(2)))) last = ts;
    }
    if (last < this.recentLowWater && this.recentLowWater > this.logLowWater) {
      this.logEach(`WHERE commit_ts > ? AND commit_ts <= ?`, [last, this.recentLowWater], (ts, _txn, blob) => {
        if (decode<Change[]>(blob).some((c) => keys.has(objectKey(c.table)))) last = Math.max(last, ts);
      });
    }
    return last;
  }

  /**
   * 表 tables (範囲の表の名前。"*" は全部の表) の、表定義の変更の床のうち、いちばん大きいもの。床がなければ 0。
   */
  private floorOf(tables: Iterable<string>): Ts {
    let floor = this.tableFloors.get(ALL_OBJECTS) ?? 0;
    for (const t of tables) {
      if (t === ALL_OBJECTS) for (const f of this.tableFloors.values()) floor = Math.max(floor, f);
      else floor = Math.max(floor, this.tableFloors.get(objectKey(t)) ?? 0);
    }
    return floor;
  }

  /**
   * T より後の commit について、pk ごとに最も古い before-image を集める。集めるのは、文が読む表 (範囲 spans の表) の行だけである。
   * 見る床も、その表のものだけである。ほかの表の DDL の後でも、古い時刻の読みに答えられる (M24 の m24_floor_red_restore_all)。
   * 欠陥のスイッチ restoreAllTables は、T より後に確定した全部の表の行を戻し、全部の表の床を見る (段 3 の形)。
   */
  private deltaAfter(T: Ts, spans: readonly Span[]): { table: string; pk: string; image: Tuple | null }[] {
    if (T >= this.maxCommit) return [];
    const all = this.faults.restoreAllTables || spans.some((s) => s.table === ALL_OBJECTS);
    const tables = new Set(spans.map((s) => s.table));
    const floor = Math.max(this.logLowWater, this.floorOf(all ? [ALL_OBJECTS] : tables));
    if (T < floor) throw new ReadTooOld(`moved at ${floor}`);
    const seen = new Map<string, { table: string; pk: string; image: Tuple | null }>();
    // K を超えた時点で読むのをやめる。T 以降の全ログを読んでから数えると、古い T の読みが来るたびに保持窓の全行を読む。
    this.logEach(`WHERE commit_ts > ?`, [T], (_ts, _txn, blob) => {
      for (const c of decode<Change[]>(blob)) {
        if (!all && !tables.has(c.table)) continue;
        const key = `${c.table}\0${c.pk}`;
        if (!seen.has(key) && this.defs.has(c.table)) seen.set(key, { table: c.table, pk: c.pk, image: c.before });
      }
      return seen.size <= this.K;
    });
    if (seen.size > this.K) throw new ReadTooOld(`delta exceeds K=${this.K}`);
    return [...seen.values()];
  }

  private restore(targets: { table: string; pk: string; image: Tuple | null }[]): void {
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
  private run(sec: Section<"owned">, req: ExecReq): Ran {
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
   * するためである。文が捕捉した変更は、ここで書き込みの守り (claimed) に掛ける。要求の文を実行する経路 (exec の下書き、悲観的な
   * DML、autocommit の下書きと高速経路) は、どれもここを通るので、守りを経路ごとに並べない。
   */
  private checked<T extends { changes: Change[] } | null>(sec: Section<"owned">, req: ExecReq, exec: () => T): T {
    // 範囲の検査の下書きの中では、守りを掛けない。下書きは巻き戻すので、守りは、結果を返す 1 回に掛ければ足りる。
    if (this.checking) return exec();
    const report = this.deps.spanEscape;
    if (report) {
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
    }
    const out = exec();
    // 守りが断ると、呼び出し側の巻き戻し (rollback か b.tx) が、文の書き込みを全部取り消す。変更は、返しも溜めもしない。
    if (out) this.claimed(sec, out.changes, req);
    return out;
  }
  private checking = false;

  /**
   * 書き込みの守り (計画書の不変条件 1 の書き込みの側: 行は、その token を持つシャードにだけある。未解決の問題 35)。
   * シャードが受け入れようとしている変更の行のどれもが、次の 2 つを満たすことを確かめる。満たさない行が 1 つでもあれば、
   * WriteOutsideClaim で書き込みの全体を断る。断った書き込みは、本体にも、intent にも、Worker へ返す変更にも残らない。
   *   1. 行の token を、このシャードが持っている。所有は、同期区間の入口 (assertOwned) と同じ規則 (notOwned) で引く。
   *   2. 行が、宣言の中にある。文の実行なら、文が宣言した範囲のどれかが行を覆う (全表の範囲は、claim の token の区間の中の行だけを
   *      覆う)。取引が溜めた変更を確定のときに受け取る経路 (req が null。commitLocal と prepare) では、変更が名乗る行 (持ち主を
   *      enter が確かめた行) が宣言で、変更後の行イメージのキーが、名乗る行と同じでなければならない。
   *
   * Worker は文を、宣言した範囲の持ち主へ送る。宣言の外の行を書いた文は、行を持ち主でないシャードに置くか、同じ行を 2 つの
   * シャードに置く。今までは Worker だけがこれを守っていた。所有は「手放していない」で引くので、分割で生まれた兄弟のシャードの
   * 行は、所有の確かめ (1) を通ってしまう。それを止めるのは 2 である。
   *
   * 掛けるのは、要求の文の実行 (checked) と、取引の変更の受け入れ (commitLocal、prepareSync) だけである。もう決まった書き込みは
   * 掛けずに受け入れる: 確定した intent の適用 (finalize)、移動の後に転送された phase 2、届いた piece (receive、pull の応答)、
   * 過去の時点への巻き戻し (restore)、overlay の適用。どれも、行の置き場所を、すでに一度この守りか移動の手順が決めている。
   * 断ると、確定した取引が適用できなくなるか、移動が終わらない。
   *
   * いまの Worker は、書き込みの文に全表の範囲を付けない (書き込みは shard key で絞った宛先へだけ送る)。付ける経路を足すなら、
   * 次に気を付ける。範囲表の古い Worker の claim は、後で受け取った範囲を含まない。受け取ったシャードは同じ文をこの守りで断り、
   * 渡した側は NotOwner で断る。その経路を足す者は、Worker が経路の拒否を先に扱い、範囲表を取り直して文を計画し直すように
   * しなければならない (いまの Worker は、先に返った誤りを返す)。そうしないと、分割の途中の文が、どちらの拒否が先に返るかで、
   * やり直されたり失敗したりする (AGENTS.md の規則 4)。
   */
  private claimed(_sec: Section<"owned">, changes: Change[], req: Pick<ExecReq, "sql" | "spans"> | null): void {
    if (changes.length === 0) return;
    this.deps.writeCheck?.({ shard: this.id, sql: req?.sql ?? null, spans: req?.spans ?? null, changes, def: (t) => this.def(t) });
    if (this.faults.ignoreWriteClaim) return;
    const report = "nothing was written; the request was built wrongly, please report this";
    for (const c of changes) {
      const row = `${c.table} row ${c.pk}`;
      if (!req && c.after) {
        const k = tupleKey(this.def(c.table), c.after);
        if (k.pk !== c.pk || k.sk !== c.sk) {
          throw new WriteOutsideClaim(`a change for ${row} on shard ${this.id} carries the image of ${c.table} row ${k.pk}; ${report}`);
        }
      }
      const refused = this.notOwned(c.sk, this.areaOf(c.sk, c.pk));
      if (refused) throw new WriteOutsideClaim(`shard ${this.id} does not own ${row} (${refused.message}); ${report}`);
      if (req && !req.spans.some((s) => declares(s, c))) {
        throw new WriteOutsideClaim(`the statement wrote ${row} (shard key ${c.sk}) on shard ${this.id}, outside the spans it declared; ${report}`);
      }
    }
  }

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
        const keys = queryAll(this.b, `SELECT ${imageSql(def)} FROM ${q(def.name)} AS ${q(s.alias)} WHERE (${s.where})`, s.params)
          .map((r) => tupleKey(def, parseTuple(r[0] as string))).filter((k) => s.sk === undefined || s.sk === k.sk);
        return [new Set(keys.map((k) => k.pk))];
      });
      for (const r of queryAll(this.b, `SELECT ${imageSql(def)} FROM ${q(def.name)}`, [])) {
        if (++seen > SPAN_CHECK_MAX_ROWS) return false;
        const key = tupleKey(def, parseTuple(r[0] as string));
        // 取引が自分で書いた行は、ほかの取引から守る必要がないので、範囲に入っていなくてよい。
        if (own.has(`${def.name}\0${key.pk}`)) continue;
        const covered = spans.some((s) => s.kind !== "pred" && spanCovers(s, def.name, key.pk, key.sk)) || matching.some((m) => m.has(key.pk));
        if (!covered) doomed.push({ def, pk: key.pk });
      }
    }
    for (const d of doomed) deleteRow(this.b, d.def, d.pk);
    return true;
  }

  private runStatement(req: ExecReq): Ran {
    if (!req.write) return { ...this.readLimited(req), changes: [] };
    return imageFits(() => this.runWrite(req));
  }

  private runWrite(req: ExecReq): Ran {
    const captured = this.runCaptured(req);
    if (captured) return captured;
    // REPLACE が暗黙に消す行は recursive_triggers がないと DELETE trigger を発火しない。
    this.b.exec(`PRAGMA recursive_triggers = ON`);
    this.b.exec(`INSERT INTO __cap_on VALUES (1)`);
    const out = this.returned(req, queryAll(this.b, req.sql, req.params));
    // 文が変更した行の数は、SQLite に尋ねる。捕捉した変更の数とは違う。REPLACE が消した行は、SQLite は数えない。
    // 捕捉のための trigger の中の書き込みは、changes() に入らない。
    const count = this.b.exec(`SELECT changes() AS n`)[0]!.n as number;
    const { changes, inserted } = capturedChanges(this.b, (t) => this.def(t));
    const sk = req.write!.sk;
    if (sk !== null) {
      for (const c of changes) {
        if (c.sk !== sk) throw new SqlError(`row of shard key ${c.sk} written through shard key ${sk}`);
      }
    }
    return { ...out, changes, count, inserted };
  }

  /**
   * 書き込みの文の結果 (利用者の RETURNING) を値に戻す。Worker は RETURNING の項を要素の式に書き換えて送り (src/sql/returning.ts)、
   * 書き換える前の文の列名を columns に付ける。列名のない書き込みが行を返したら、書き換えていない RETURNING なので、断る。
   * 素のまま返すと、DO のドライバが丸めた INTEGER を、黙って REAL として返すことになる。
   */
  private returned(req: ExecReq, rows: Plain[][]): { columns: string[]; values: Value[][] } {
    if (rows.length > 0 && req.columns.length === 0) throw new SqlError("a write that returns rows must name its result columns (protocol 5); please report this");
    return { columns: req.columns, values: rows.map((r) => r.map(decodeReturned)) };
  }

  /**
   * シャードが実行する形の文。読みは、型つきの読みに包む (src/value.ts の typedReadSql、docs/design-values.md の「シャードからの
   * 読み」)。DO の SQL の API は INTEGER を丸めた数で返すので、それを知る場所をここ 1 か所にする。列の数は Worker が渡す
   * (ExecReq.columns)。書き込みは、Worker が RETURNING を書き換えた文をそのまま実行する。
   */
  private executed(req: Pick<ExecReq, "sql" | "columns" | "write">): string {
    if (req.write) return req.sql;
    if (req.columns.length === 0) throw new SqlError("a read must name its result columns (protocol 5); please report this");
    const fenced = !this.faults.unfencedRead;
    const key = `${req.columns.length}\0${fenced}\0${req.sql}`;
    let hit = wrappedReads.get(key);
    if (hit === undefined) {
      hit = typedReadSql(req.sql, req.columns.length, selectElemSql, fenced);
      if (wrappedReads.size >= 512) wrappedReads.delete(wrappedReads.keys().next().value!);
      wrappedReads.set(key, hit);
    }
    return hit;
  }

  /** 読み取りの文を実行し、上限を超えた時点で打ち切る。全行を集めてから数えると、数える前にメモリが尽きる。 */
  private readLimited(req: ExecReq): { columns: string[]; values: Value[][]; bytes?: number; over?: boolean } {
    const maxRows = Math.min(req.maxRows ?? SHARD_MAX_ROWS, SHARD_MAX_ROWS);
    const maxBytes = Math.min(req.maxBytes ?? SHARD_MAX_BYTES, SHARD_MAX_BYTES);
    // 文の種類ごとの行数の集計 (src/worker.ts の rowStats) は、包む前の文面で数える。
    const { rows } = this.b.query(this.executed(req), req.params, req.sql);
    const columns = req.columns;
    const values: Value[][] = [];
    let bytes = 0;
    for (const raw of rows) {
      const row = raw.map(decodeElem);
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
  private withinLimits(req: Pick<ExecReq, "sql" | "params" | "columns" | "write">): void {
    // 実行する形 (読みは包んだ後の文) で測る。
    const over = shardLimitOf(this.executed(req), req.params ?? []);
    if (over) throw new ShardLimit(over);
  }



  /**
   * 書き込み文を実行し、変更行を trigger ではなく RETURNING と主キーの読みで捕捉する。
   * trigger の捕捉は __cap と __cap_on へ書くので、ROLLBACK しても 1 行の文で 2 行が課金される。
   * 文の形が想定と合わなければ、その文だけを巻き戻して null を返す。呼び出し側は trigger の経路に任せる。
   */
  private runCaptured(req: ExecReq): Ran | null {
    const capture = req.write?.capture;
    const span = req.spans[0];
    // 2 つ目以降の範囲は、同じ表の、UNIQUE の検査で読む行だけである (spans.ts の規則 3)。ほかの表を読む文は、ここでは扱わない。
    if (!capture || this.faults.triggerCapture || !span || req.spans.some((s) => s.table !== span.table)) return null;
    if (capture === "update" && span.kind !== "pk") return null;
    const def = this.def(span.table);
    // RETURNING で行を読むと文が長くなる (行のタプルの式)。DO の SQLite の上限を超えるなら、文をそのまま実行する trigger の
    // 捕捉に任せる。入口の確かめ (withinLimits) は、受け取った文を測っている (Codex の 2 回目の見直し、指摘 7)。
    const returning = `${req.sql} RETURNING ${imageSql(def)}`;
    if (!withinShardLimits(returning, req.params)) return null;
    const sk = req.write!.sk;
    try {
      return this.b.tx(() => {
        const before = span.kind === "pk" && capture === "update" ? selectRow(this.b, def, span.pk) : null;
        const was = before && tupleKey(def, before).pk;
        const rows = returnedRows(def, queryAll(this.b, returning, req.params), capture !== "delete");
        if (capture === "update" && (rows.length > 1 || (rows.length === 1 && was !== tupleKey(def, rows[0]!).pk))) {
          throw FALLBACK;
        }
        const changes: Change[] = rows.map((row) => ({
          table: def.name, ...tupleKey(def, row),
          before: capture === "insert" ? null : capture === "delete" ? row : before,
          after: capture === "delete" ? null : row,
        }));
        for (const c of changes) checkAfter(this.b, def, c.pk, c.after, "the RETURNING capture");
        if (sk !== null) {
          for (const c of changes) {
            if (c.sk !== sk) throw new SqlError(`row of shard key ${c.sk} written through shard key ${sk}`);
          }
        }
        // RETURNING で捕捉する INSERT は、返った行の全部を入れた (OR 句も UPSERT もない形だけを、ここで扱う)。
        return { columns: [], values: [], changes, inserted: capture === "insert" ? changes.map((c) => ({ table: c.table, pk: c.pk })) : [] };
      });
    } catch (e) {
      if (e === FALLBACK) return null;
      return imageFits(() => {
        throw e;
      });
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
   *   表が書き込み禁止でないこと。表定義の遷移の prepare から commit か abort まで、fence の表の行は変わってはならない。
   *   変更ログの 1 行に収まること。
   * 書き込み禁止は、このシャードのスナップショットの開いている遷移なので、要求の表定義の epoch が現行であることを確かめた
   * 同期区間の印を受け取る。
   */
  private assertWriteSetFits(_sec: Section<"schema">, writes: Change[]): void {
    this.assertUnlocked(writes);
    if (this.faults.noWriteSetLimit || writes.length === 0) return;
    let bytes = 0;
    for (const w of writes) {
      bytes += utf8Length(encode(w));
      if (bytes > MAX_WRITE_SET_BYTES) throw new SqlError(writeSetTooLarge());
    }
  }

  /**
   * 書き込む表が、開いている表定義の遷移の fence にないか (docs/design-catalog-epoch.md の「要求ごとの確かめ」の書き込み禁止)。
   * 禁止は、このシャードが prepare を適用したときから、commit か abort を適用するまで続く。
   */
  private assertUnlocked(writes: Pick<Change, "table" | "pk">[]): void {
    if (this.faults.ignoreTableLock || this.snap.opens.length === 0) return;
    for (const w of writes) {
      const by = fencedBy(this.snap, w.table);
      if (!by) continue;
      const refused = new TableLocked(w.table, describeOpen(by), by.epoch);
      refused.rows = writes.filter((x) => fencedBy(this.snap, x.table) !== null).map((x) => ({ table: x.table, pk: x.pk }));
      throw refused;
    }
  }

  /**
   * ロックを持つ取引の文が、書き込み禁止に当たった (docs/design-catalog-epoch.md の「表ごとの epoch」の「シャード」、M24 の HOLD)。
   * 要求が、取引がその表の行ロックを (ほかのシャードに) 持つと運んでいれば、文を断るときに、文が書こうとした行のロックを取引に与える。
   * 行は書かない。そのロックは、ほかの行ロックと同じく、やり直しの prepare を待たせ、取引の COMMIT か ROLLBACK で放され、期限で切れる。
   * ほかの取引がロックか intent を持つ行は、与えない。1 つでも与えたら、与えた印の付いた誤りを返す。
   */
  private heldAtFence(e: TableLocked, me: LockOwner, arrived: number): TableLocked {
    if (this.faults.noLockAtFence || !me.holds || me.holds.length === 0) return e;
    const holds = new Set(me.holds);
    let granted = false;
    for (const r of e.rows) {
      if (!holds.has(objectKey(r.table)) || this.blockedBy([r], me) !== null) continue;
      this.grant(this.lockKey(r.table, r.pk), me, arrived);
      granted = true;
    }
    if (!granted) return e;
    const held = new TableLocked(e.table, e.by, e.epoch, true);
    held.rows = e.rows;
    return held;
  }

  /**
   * 表 tables のどれかに、生きている行ロックがあれば、その表の名前。なければ null。表の prepare は、その表の行ロックがある間は
   * 適用しない (M24 の WAIT_LOCKS)。
   */
  private lockedTable(tables: readonly string[]): string | null {
    if (this.locks.size === 0 || tables.length === 0) return null;
    const wanted = new Set(tables.map(objectKey));
    for (const key of [...this.locks.keys()]) {
      if (!this.liveLock(key)) continue;
      const table = key.slice(0, key.indexOf("\0"));
      if (wanted.has(objectKey(table))) return table;
    }
    return null;
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
      sec = this.enter({ deps: req.deps, spans: req.spans, writes: req.writes, at: req.T });
    } catch (e) {
      // 参加者が非オーナーなら取引は abort で、Worker が経路を更新して再実行する。
      this.releaseLocks(req.txn);
      return { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
    try {
      // 取引が溜めた変更の行を、intent を置く前に確かめる (書き込みの守り)。断れば、anchor が取引を中止する。
      this.claimed(sec, req.writes, null);
    } catch (e) {
      this.releaseLocks(req.txn);
      return { ok: false, reason: (e as Error).message };
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

  refresh(req: { txn: string; spans: Span[]; from: Ts; to: Ts; deps: Dep[] }): { ok: boolean; reason?: string } {
    // 先に HLC を to まで進める。これ以後に置かれる intent は prepare_ts > to になる。
    if (!this.faults.refreshNoBump) this.observe(req.to);
    // 前の形の確定が窓に入る表や、変更ログの切り詰めより古い窓は、変更の有無を確かめられない。ほかの表の DDL は、窓を古くしない。
    if (req.from < this.floorOf(req.spans.map((s) => s.table)) || req.from < this.logLowWater) return { ok: false, reason: "refresh: window too old" };
    let sec: Section<"owned">;
    try {
      // 取引が読んだ表の DDL が、読んだ後に確定していれば、断る (deps が、このシャードの epoch と違う)。表の床は、適用した時刻より前に
      // あるので、床だけでは、行の変更のない DDL をまたぐ前進を止められない。取引は、DDL の前の表と、DDL の後のほかの表を見ることになる。
      // 範囲は、このシャードが、同じ deps の読みに答えたものなので、このシャードが要求より古いことはない。違えば、どちら向きでも断る。
      // 欠陥のスイッチ refreshIgnoresSchema は、比べない。
      // from より後に移動してきたグループは、親での変更を確かめられないので abort する。
      sec = this.enter({ deps: this.faults.refreshIgnoresSchema ? [] : req.deps, spans: req.spans, writes: [], at: req.from });
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
  private localIntents(txn: string): Intent[] {
    const rows = this.b.exec(`SELECT * FROM __intents WHERE txn = ?`, txn) as unknown as Intent[];
    return this.faults.applyAfterMoved ? rows : rows.filter((r) => !this.moved.has(r.sk));
  }

  /** 取引の intent を運んだ piece を、転送先ごとに返す。 */
  private forwards(txn: string): Map<string, Piece[]> {
    const out = new Map<string, Piece[]>();
    if (this.faults.applyAfterMoved) return out;
    for (const r of this.b.exec(`SELECT g, "after", dest, epoch FROM __moved_txn WHERE txn = ?`, txn)) {
      const g = r.g as string;
      // いまも渡したままの移動の記録だけを転送する。グループが範囲と一緒に戻っていれば、intent も戻っていて、ここで適用する
      // (localIntents)。前の移動の記録をたどると、戻した先と戻ってきた先が互いに転送し合い、終わらない。
      if (this.moved.get(g)?.epoch !== r.epoch) continue;
      // piece が運ぶ区間は、送り出した fence の区間である。fence の記録は消さないので、移動の epoch から引ける。
      const f = this.fenced.find((x) => x.epoch === r.epoch);
      if (!f) throw new SqlError(`group ${g} was moved to ${r.dest as string}, but shard ${this.id} has no record of the range it moved with`);
      const piece: Piece = { g, range: intervalOf(f), after: posOf(r.after as string), epoch: r.epoch as number };
      out.set(r.dest as string, [...(out.get(r.dest as string) ?? []), piece]);
    }
    return out;
  }



  // ---- anchor への照会 ----

  private decided(txn: string): TxnStatus | null {
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


  // ---- 手続き ----
  //
  // ここから下は、待ちを含む要求の処理である。どれも同期の 1 歩 (xxxStep) で、殻 (core.ts の walk) が、終わるまで繰り返し呼ぶ。
  // 1 歩は、frame を見て、済んでいない最初のことをする。待つ必要があれば、待ち (Effect) を返す。待ちの後は、同じ 1 歩が
  // 先頭から呼ばれるので、待ちの前に読んだ状態は、frame に書いたもの以外、残らない。

  /** 核の別の手続きを走らせる待ち。 */
  private call<N extends keyof Sig>(program: N, frame: Sig[N][0]): Effect {
    return { kind: "call", program, frame };
  }
  private peer<M extends keyof ShardApi>(to: string, method: M, req: Parameters<ShardApi[M]>[0]): PeerCall {
    return { to, method, req };
  }

  // ---- 手続き: 表定義 ----

  /**
   * 要求の入口の確かめ (docs/design-catalog-epoch.md の「要求ごとの確かめ」と「表ごとの epoch」、M21 の gate、M24)。
   *   遷移の仕事: f.atLeast があれば、その epoch まで列を適用する (prepare は、どのものの epoch も進めないので、別に運ぶ)。
   *   表定義: 要求が頼るもの (f.deps) ごとに、要求の epoch を自分の epoch と比べる。要求のほうが古いものが 1 つでもあれば断る。新しい
   *     ものがあれば、Meta の列をその epoch まで適用してから、もう一度比べる。運ばれなかった表の DDL は、要求を古くしない。
   *   適用中: 記録の適用が、その記録の変える表の intent の決着を待っている間、その表に頼る新しい文は、適用が終わるまで待つ。断らない
   *     (失敗する DDL が、触った表の取引を断らないように。M24 の m24_red_apply_touched)。ほかの表の文は通す (m24_red_apply_all)。
   *   書き込み禁止: 書く表が、自分のスナップショットで書き込み禁止で、要求の epoch (f.epoch) が自分の epoch より新しければ、列を適用して
   *     から進む。commit だけが epoch を進める形では、abort の後に、要求が頼るものの epoch は進まない。禁止を解く記録を適用させるのは、
   *     遷移が閉じたと知った Worker の、この要求である。
   *   所有: f.epoch と f.rows があれば、表定義を確かめた後で見る。要求の epoch が自分の epoch より新しく、要求の行が自分の
   *     スナップショットでは自分のものでないときだけ、範囲の記録を適用する (catchUpStep)。要求の epoch が古いことでは断らない。
   *     範囲表だけが進んだ epoch は、動いていない行の要求を古くしない (M21 の pinnedSurvives、m21_red_strict_epoch)。
   *     断るかどうかは、同期区間の入口 (enter の assertOwned) が、自分のスナップショットと移動の記録で決める。
   */
  private schemaStep(f: SchemaFrame): Step<void, SchemaFrame> {
    if (!f.reached && f.atLeast !== undefined && f.atLeast > this.applied) {
      f.reached = true;
      return wait(this.call("reach", { epoch: f.atLeast, catchUp: false }));
    }
    // 古い表定義の要求を通すと、新しいグローバル index の更新が漏れる。経路と同じく取り直させる。
    const older = f.deps.find((d) => d.epoch < this.epochOf(d));
    if (older) throw this.staleSchema(older);
    const newer = f.deps.filter((d) => d.epoch > this.epochOf(d));
    if (newer.length > 0) {
      // Meta にある記録は全部適用するので、適用の後で、要求のほうが古くなっていることがある。もう一度、先頭から比べる。
      // 2 度適用しても届かない epoch は、Meta の列にない。
      f.ahead = (f.ahead ?? 0) + 1;
      if (f.ahead > 2) throw new SqlError(`schema epoch ${newer[0]!.epoch} of ${newer[0]!.name} is not recorded yet (shard ${this.id} has applied the epoch log up to ${this.applied})`);
      return wait(this.call("reach", { epoch: Math.max(...newer.map((d) => d.epoch)), catchUp: false }));
    }
    // 欠陥のスイッチ applyRefusesAll (段 3 の形): 適用が進んでいる間は、どの表の、どの要求も断る。
    if (this.faults.applyRefusesAll && this.schemaChanging) throw new NotOwner(`stale schema: a schema change is being applied on shard ${this.id}`);
    if (f.statement && this.applying !== null) {
      const touched = this.applying;
      const hit = touched === "all" || f.deps.some((d) => touched.has(d.name));
      // 欠陥のスイッチ applyRefusesTouched: 変わるものに頼る文を、待たせずに断る。
      if (hit && this.faults.applyRefusesTouched) throw new NotOwner(`stale schema: a schema change is being applied on shard ${this.id}`);
      if (hit) {
        f.waited = (f.waited ?? 0) + 1;
        // 適用は、決着の待ちの期限 (SCHEMA_WAIT_MS) で終わる。待ち続けることはない。
        if (f.waited > 50) throw new ConflictError(`a schema change is being applied on shard ${this.id}`);
        return wait({ kind: "schemaChangeOver" });
      }
    }
    if (!f.unfenced && f.epoch !== undefined && f.epoch > this.applied && this.snap.opens.length > 0
      && f.deps.some((d) => d.write && this.snap.opens.some((o) => o.fence.some((t) => objectKey(t) === d.name)))) {
      f.unfenced = true;
      return wait(this.call("reach", { epoch: f.epoch, catchUp: false }));
    }
    if (!f.caught && f.epoch !== undefined && f.rows && f.epoch > this.applied && !this.ownsRows(f.rows)) {
      f.caught = true;
      return wait(this.call("catchUp", { epoch: f.epoch }));
    }
    return done(undefined);
  }

  /**
   * 少なくとも epoch まで、Meta の列の全部 (表定義の記録も) を適用する。先まで進んでもよい。
   * 要求の入口 (schemaStep)、prepare の適用の答え (preparedStep)、増設の手順 (行の受け取り) が使う。
   */
  private reachStep(f: ReachFrame): Step<void, ReachFrame> {
    if (f.before !== undefined) {
      if (this.applied === f.before) throw new SqlError(`epoch ${f.epoch} is not recorded yet (shard ${this.id} has applied the epoch log up to ${f.before})`);
      f.before = undefined;
    }
    if (f.epoch <= this.applied) return done(undefined);
    // 追いつくための適用は、移動の途中でも通る。進行中の通常の適用 (移動の途中は断られる) には合流しない。
    if (f.catchUp && this.schemaChanging) return wait({ kind: "schemaChangeOver" });
    f.before = this.applied;
    return wait({ kind: "schemaChange", catchUp: f.catchUp });
  }

  /**
   * Meta の列の続きを取り、順に 1 つずつ写しに足す (docs/design-catalog-epoch.md の「列の適用」と「表ごとの epoch」の「シャード」)。
   * 表定義の記録は、その記録が変える表 (fence の表、文が作る、変える、消す表、index の表) の intent を決着させてから適用する。intent の
   * 行イメージは DDL より前の表の形なので、表や列が消えた後では適用できない。確定済みの取引がそうなると、再駆動が永久に失敗する。
   * ほかの表の intent は待たない。決着を待つ間、その表に頼る新しい文は入口で待つ (schemaStep) ので、待つ intent は増え続けない。
   * prepare の後は fence の表に新しい intent ができないので、commit の文は、決着していない書き込みのない表に掛かる。
   * 記録ごとの手は次のとおりで、どれも記録を写しに足すのと同じ 1 つの同期の取引で行う。
   *   prepare  staging の表 (index の表) を作る。以後、fence の表への書き込みを断る (assertUnlocked)。利用者の表には触らない。
   *   commit   prepare の ddl の文を実行する。at があれば時計を進め、読みの epoch が進む表の床を置く (tableFloors)。
   *   abort    staging の表を名前で消す。禁止が解ける。
   *   範囲の記録 (genesis、move-start、move-end)  文を持たない (catchUpStep も、これだけを適用する)。move-start は、親と子の移動の
   *            記録を書く (moveRows)。
   * commit の文が通らなければ (試しに通った文が、同じ行に対して通らない。保存の障害のほかには起きないはずである)、取り消しはせず、
   * このシャードは止まる (schemaStuck。health が報告する)。
   */
  private applyStep(f: ApplyFrame): Step<void, ApplyFrame> {
    this.applying = null;
    if (!f.checked) {
      // 範囲の移動の途中は適用しない。親と子の版がずれると、運ぶ行と intent の形が受け取る側の表と合わなくなる。
      // 親は intent を決着させないと DDL を適用できず、その決着は子へ転送され、子はその行を受け取れない、という行き詰まりになる。
      // 子が親の版へ追いつく場合 (catchUp) だけは通す。届く行がその版の形だからである。
      if (!f.catchUp && this.moving()) throw new ConflictError(`schema change is waiting for a shard split on ${this.id} to finish`);
      f.checked = true;
    }
    if (!f.got) return wait({ kind: "meta", method: "epochsSince", args: [this.applied] }, "got");
    // 待ちは実時間のタイマーなので、期限も実時間で測る。
    f.deadline ??= this.rt.now() + SCHEMA_WAIT_MS;
    // 範囲の記録の後は、畳み直しを後回しにする。表定義の記録の文は、直前までを畳んだスナップショットから決めるので、その前に畳む。
    let stale = false;
    const forks: Fork[] = [];
    for (const x of f.got) {
      if (x.epoch <= this.applied) continue;
      if (x.epoch !== this.applied + 1) throw new SqlError(`shard ${this.id} has applied the epoch log up to ${this.applied}, but the next record is epoch ${x.epoch}`);
      const rec = x.rec;
      // 先頭の確かめと同じ。同じ続きの中で move-start を適用して、移動の途中になることがある (Meta は、移動が開いている間に表定義の
      // 記録を足さないので、起きるのは Meta の条件が破れたときだけである。M21 の movingNow)。適用した分は残し、続きは移動の後にする。
      // 移動を進め始める仕事は捨てるが、子は alarm を予約している (moveStarted)。
      if (isDdlRecord(rec) && !f.catchUp && this.moving()) {
        if (stale) this.resnap();
        throw new ConflictError(`schema change is waiting for a shard split on ${this.id} to finish`);
      }
      if (stale && isDdlRecord(rec)) {
        this.resnap();
        stale = false;
      }
      // 表の prepare は、その表 (fence) に行ロックがある間は適用しない (M24 の WAIT_LOCKS)。行を書いた取引がロックを持つ間、その表の DDL の
      // ほうが待つ。SQLite で、書いた取引が書き込みのロックを持つ間、ほかの接続の DDL が busy_timeout まで待つのと同じである。
      // 待つのは、prepare の記録が運ぶ DDL の待ちの期限 (waitUntil) までで、過ぎれば適用せずに断る (進める側の DDL が SQLITE_BUSY で失敗する)。
      // 待つ間、要求は通す (ロックを持つ取引の、その後の文と COMMIT を待たせない)。取ってきた続きで、もう閉じている prepare は、待たない
      // (遅れたシャードが prepare と abort を続けて適用するときに、ロックの持ち主が追いつきを止めないように)。
      if (rec.kind === "prepare" && !this.faults.prepareIgnoresLocks && !f.got.some((y) => (y.rec.kind === "abort" || y.rec.kind === "commit") && y.rec.of === x.epoch)) {
        const held = this.lockedTable(rec.fence);
        if (held !== null) {
          if (stale) this.resnap();
          const now = this.rt.now();
          if (rec.waitUntil === undefined || now >= rec.waitUntil) {
            throw new ConflictError(`a transaction holds row locks on table ${held}, and the schema change (${describeOpen(rec)}) of epoch ${x.epoch} did not get the table within its wait`);
          }
          const w = (f.lockWait ??= { refetchAt: now + LOCK_REFETCH_MS, every: LOCK_REFETCH_MS });
          let effect: Effect = { kind: "sleep", ms: Math.max(1, Math.min(LOCK_POLL_MS, rec.waitUntil - now)) };
          let into: "got" | undefined;
          if (now >= w.refetchAt) {
            // その遷移が、待っている間に閉じたかもしれない。列の続きを取り直して、先頭から見直す。
            w.every = Math.min(LOCK_REFETCH_MAX_MS, w.every * 2);
            w.refetchAt = now + w.every;
            effect = { kind: "meta", method: "epochsSince", args: [this.applied] };
            into = "got";
          }
          return { done: false, wait: effect, ...(into ? { into } : {}), ...(forks.length > 0 ? { forks } : {}) };
        }
        f.lockWait = undefined;
      }
      // この記録が変える表の intent を、先に決着させる。決着を待つ間は、その表に頼る新しい文を入口で待たせる (applying)。
      // 待ちの後は、この 1 歩を先頭から呼び直し、intent がなくなったことを確かめた同じ 1 歩の中で、記録を適用する。
      const touched = this.faults.ddlIgnoresIntents ? null : this.touchedBy(x, f.got);
      if (touched !== null && this.intentsOn(touched)) {
        if (stale) this.resnap();
        if (this.rt.now() > f.deadline) throw new ConflictError("schema change is waiting for transactions on this shard to finish");
        this.applying = touched;
        const settle = this.call("settleAll", touched === "all" ? {} : { tables: [...touched] });
        return forks.length > 0 ? { done: false, wait: settle, forks } : wait(settle);
      }
      const statements = this.statementsOf(rec);
      try {
        this.b.tx(() => {
          for (const stmt of statements) this.b.exec(stmt);
          this.moveRows(x);
          this.store(x);
        });
      } catch (err) {
        if (stale) this.resnap();
        if (rec.kind !== "commit") throw err;
        this.schemaStuck = { epoch: x.epoch, message: (err as Error).message };
        throw new SqlError(`schema change of epoch ${x.epoch} cannot be applied on shard ${this.id}: ${(err as Error).message}`);
      }
      this.log.push(x);
      forks.push(...this.moveStarted(x));
      stale = !isDdlRecord(rec);
      if (!stale) this.resnap();
      if (rec.kind !== "commit") continue;
      this.schemaStuck = null;
      // index を公開する commit は、時刻を運ぶ。index を使わずに確定した書き込みは、どのシャードのものも、この時刻以下である。
      // ここから先、このシャードで読む文は index を使う。その文が、時刻の順で、それらの書き込みの後ろに来るようにする。
      if (rec.at !== undefined && !this.faults.publishWithoutClock) this.observe(rec.at);
      // 変更ログの行イメージは DDL より前の形なので、それより古い T には、形の変わった表の行を読み戻せない。読みの epoch が進む表に床を置く。
      // 床は、変更ログにある、その表の確定の時刻の最大である (lastLogged)。それ以上の T の読みが戻す行イメージは、この commit の後の
      // 形のものだけなので、断らなくてよい (M23j の m23j_exact_*)。その表の確定が変更ログになければ、床を置かない。
      // index を作るか消すだけの DDL (書き込みの epoch だけが進む) は、行の形を変えないので、床を置かない。
      // 欠陥のスイッチ globalDdlFloor は、どの commit でも全部の表の床を、ddlFloorAtApply は、形の変わった表の床を、適用した時刻に置く。
      // noFloorOnChange は、床を置かない。
      const changed = this.faults.globalDdlFloor ? [ALL_OBJECTS] : this.faults.noFloorOnChange ? []
        : Object.entries(this.snap.objects).filter(([k, o]) => k !== ALL_OBJECTS && o.read === x.epoch).map(([k]) => k);
      if (changed.length > 0) {
        const floor = this.faults.globalDdlFloor || this.faults.ddlFloorAtApply ? this.issue() : this.lastLogged(new Set(changed));
        if (floor > 0) {
          for (const k of changed) this.tableFloors.set(k, Math.max(this.tableFloors.get(k) ?? 0, floor));
          this.metaSet("ddl_floors", JSON.stringify([...this.tableFloors]));
        }
      }
    }
    if (stale) this.resnap();
    return done(undefined, forks.length > 0 ? forks : undefined);
  }

  /** 適用が、intent の決着を待ったまま終わったとき (期限、失敗) の後始末。入口で待つ文を、通す。 */
  private applyExit(_f: ApplyFrame): Fork[] {
    this.applying = null;
    return [];
  }

  /**
   * 記録 x を適用する前に、intent を決着させる表 (小文字の名前)。決着の要らない記録なら null。
   *   prepare  fence の表と、その DDL が確定で変えるもの、作る内部の表。取ってきた続き (got) で、もう abort で閉じている prepare は、
   *            禁止を掛けた途端に解くだけなので、何も待たない。
   *   commit   閉じる prepare と同じもの。fence の表には、prepare の適用の後、新しい intent ができていない。
   * 欠陥のスイッチ applyRefusesAll (段 3 の形) は、どの表定義の記録の前にも、全部の表の intent を決着させる。
   */
  private touchedBy(x: Logged, got: readonly Logged[]): Set<string> | "all" | null {
    const rec = x.rec;
    if (!isDdlRecord(rec)) return null;
    if (this.faults.applyRefusesAll) return "all";
    const names = (o: Pick<OpenDdl, "fence" | "ddl" | "staging">) => new Set(
      [...o.fence, ...(o.ddl.changes?.read ?? []), ...(o.ddl.changes?.write ?? []), ...(o.staging?.defs ?? []).map((d) => d.name)].map(objectKey),
    );
    if (rec.kind === "prepare") return got.some((y) => y.rec.kind === "abort" && y.rec.of === x.epoch) ? null : names(rec);
    if (rec.kind === "commit") return names(this.openOf(rec.of));
    return null;
  }

  /** 表 tables (小文字の名前。"all" なら全部) に、決着していない intent があるか。 */
  private intentsOn(tables: Set<string> | "all"): boolean {
    if (tables === "all") return (this.b.exec(`SELECT count(*) n FROM __intents`)[0]!.n as number) > 0;
    return this.b.exec(`SELECT DISTINCT tbl FROM __intents`).some((r) => tables.has(objectKey(r.tbl as string)));
  }

  /** 記録を写しに足すときに、同じ取引で実行する文。いまのスナップショット (記録の直前まで畳んだもの) から決める。 */
  private statementsOf(rec: Logged["rec"]): string[] {
    switch (rec.kind) {
      case "prepare":
        return rec.staging?.sql ?? [];
      case "commit":
        return this.openOf(rec.of).ddl.sql;
      case "abort":
        return (this.openOf(rec.of).staging?.defs ?? []).map((d) => `DROP TABLE IF EXISTS ${q(d.name)}`);
      default:
        return [];
    }
  }
  private openOf(epoch: number): OpenDdl {
    const o = this.snap.opens.find((x) => x.epoch === epoch);
    if (!o) throw new SqlError(`shard ${this.id}: epoch ${epoch} is not an open schema change in the epoch log it applied`);
    return o;
  }

  /**
   * 移動の記録 (move-start) を写しに足すときに、同じ取引で書く移動の記録 (docs/design-catalog-epoch.md の「列の適用」、段 4)。
   * 親 (from) は __fenced に、子 (to) は __incoming に、移動の epoch の行を足す。親にとって、これが fence である。以後、スナップショットの
   * 範囲表が区間を子に渡すので、親はその区間の書き込みと prepare を断る。子は、これで受け取り始める。intent は決着させない (行と一緒に運ぶ)。
   */
  private moveRows(x: Logged): void {
    const rec = x.rec;
    if (rec.kind !== "move-start") return;
    if (rec.from === this.id) this.b.exec(`INSERT INTO __fenced(lo, hi, "to", epoch) VALUES (?, ?, ?, ?)`, rec.start, rec.end, rec.to, x.epoch);
    if (rec.to === this.id) this.b.exec(`INSERT INTO __incoming(lo, hi, from_id, epoch) VALUES (?, ?, ?, ?)`, rec.start, rec.end, rec.from, x.epoch);
  }

  /**
   * moveRows を書いた取引の後で、メモリの記録を足す。子なら、自分で移動を進め始める (決めたこと 4)。応答の後の仕事ですぐに始め、
   * DO が落ちて仕事が消えても続くように、alarm も予約する。返す fork を、手続きの 1 歩の結果に付ける。
   * 範囲が前の持ち主へ戻るときも、その範囲のグループの「渡した」印は、ここでは外さない。グループが届くか、受け取り終えたときに外す
   * (unmarked)。欠陥のスイッチ unmarkOnReturn は、段 4 のコードのとおり、ここで外す。
   */
  private moveStarted(x: Logged): Fork[] {
    const rec = x.rec;
    if (rec.kind !== "move-start") return [];
    const range = { start: rec.start, end: rec.end };
    if (rec.from === this.id) this.fenced.push({ ...range, to: rec.to, done: 0, epoch: x.epoch });
    if (rec.to !== this.id) return [];
    this.incoming.push({ ...range, from_id: rec.from, epoch: x.epoch });
    if (this.faults.unmarkOnReturn) for (const g of [...this.moved.keys()]) if (overlaps(blockOf(g), range)) this.moved.delete(g);
    this.deps.scheduleRedrive?.("move");
    return [{ kind: "background", effect: { kind: "move", epoch: x.epoch } }];
  }

  /**
   * 表定義の遷移の prepare を適用したかを答える (ShardApi.prepared)。epoch まで列を適用し (intent を決着させ、fence の表への
   * 書き込みを止める)、その遷移が自分のスナップショットで開いていれば ok を返す。mode が trial なら、書き込みを止めた表に文を試して
   * 巻き戻し、SQLite が通したかを返す。表は止まっているので、試した結果は commit を適用するまで変わらない。
   * 遷移がもう開いていなければ (先に abort を適用した)、ok: false を返す。
   */
  private preparedStep(f: PreparedFrame): Step<{ ok: boolean; reason?: string }, PreparedFrame> {
    const { epoch, early } = f.req;
    if (early) {
      // 欠陥のスイッチ checkBeforePrepare (Worker の側): 列を適用せずに、記録だけを読んで、いまの表で試す。表は止まっていない。
      if (!f.got) return wait({ kind: "meta", method: "epochsSince", args: [epoch - 1] }, "got");
      const rec = f.got.find((x) => x.epoch === epoch)?.rec;
      if (rec?.kind !== "prepare") return done({ ok: false, reason: `epoch ${epoch} is not a schema change` });
      return done(rec.mode === "trial" ? this.trial(rec.ddl) : { ok: true });
    }
    if (!f.reached) {
      f.reached = true;
      return wait(this.call("reach", { epoch, catchUp: false }));
    }
    const open = this.snap.opens.find((o) => o.epoch === epoch);
    if (!open) return done({ ok: false, reason: `stale epoch: the schema change of epoch ${epoch} is no longer open on shard ${this.id}` });
    return done(open.mode === "trial" ? this.trial(open.ddl) : { ok: true });
  }

  /** 表定義の変更の文を、巻き戻す取引の中で実行し、SQLite が通したかを返す (mode trial)。 */
  private trial(d: Pick<ParsedDdl, "sql">): { ok: boolean; reason?: string } {
    try {
      this.rollback(() => {
        for (const stmt of d.sql) this.b.exec(stmt);
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: (e as Error)?.message ?? String(e) };
    }
  }

  /**
   * 範囲の記録だけを適用する。要求の epoch が自分より新しく、要求の行が自分のスナップショットで自分のものでないときに、入口
   * (schemaStep) が呼ぶ。子は、範囲表の切り替え (move-start) を適用するまで、自分が宛先だと知らない。
   * 表定義の記録の手前で止まる。表定義の記録は、intent を決着させてから適用するもので (applyStep)、要求の表定義の epoch が
   * 自分より新しいときに、入口がそちらへ回す。続きを取っている間に、別の要求がもう適用していれば、その分は飛ばす。
   */
  private catchUpStep(f: CatchUpFrame): Step<void, CatchUpFrame> {
    if (f.epoch <= this.applied) return done(undefined);
    if (!f.got) return wait({ kind: "meta", method: "epochsSince", args: [this.applied] }, "got");
    let stored = false;
    const forks: Fork[] = [];
    for (const x of f.got) {
      if (x.epoch <= this.applied) continue;
      if (x.epoch !== this.applied + 1 || isDdlRecord(x.rec)) break;
      this.b.tx(() => {
        this.moveRows(x);
        this.store(x);
      });
      this.log.push(x);
      forks.push(...this.moveStarted(x));
      stored = true;
    }
    if (stored) this.resnap();
    return done(undefined, forks.length > 0 ? forks : undefined);
  }

  /**
   * 少なくとも epoch まで、Meta の列を適用する。子からの移動の要求 (listGroups、pull、finishMove) を受けた親と、子が移動を進める手順が
   * 使う (M21 の PULL_AT_EPOCH)。先に範囲の記録だけを適用し (catchUp。intent を決着させない)、手前に表定義の記録があれば、列の全部を
   * 適用する (applyStep。intent を決着させる)。移動が開いている間、Meta は表定義の記録を足さないので、表定義の記録が手前にあるのは、
   * move-start より前に確定した DDL を、まだ適用していないときだけである。親は、その DDL を適用してから行を渡す。渡す行の形が、子の表と
   * 同じになる (m21_red_pull_unfenced の pullOldShapeTest)。全部の適用は、進行中の適用に合流することがあるので、何度か試す。
   */
  private toEpochStep(f: EpochFrame): Step<void, EpochFrame> {
    if (f.epoch <= this.applied) return done(undefined);
    if (!f.caught) {
      f.caught = true;
      return wait(this.call("catchUp", { epoch: f.epoch }));
    }
    if (f.epoch <= this.applied) return done(undefined);
    // 全部の適用は、epoch を越えた先の表定義の記録で断られることがある (移動の途中になった後の記録。Meta の条件が破れたときだけ
    // 起きる)。epoch まで適用できていれば、それでよいので、断られたことを結果として受け取る。
    if (f.out && !f.out.ok && f.full! >= 3) throw f.out.error;
    f.full = (f.full ?? 0) + 1;
    if (f.full <= 3) return attempt({ kind: "schemaChange", catchUp: false }, "out");
    throw new SqlError(`epoch ${f.epoch} is not recorded yet (shard ${this.id} has applied the epoch log up to ${this.applied})`);
  }

  /**
   * 表 f.tables の intent (なければ、持っている intent の全部) を、anchor に尋ねて決着させる。進行中の取引は終わるまで待つ。
   * 待っている間、その表に頼る新しい文は、入口で待つ (schemaStep) ので、intent は増え続けない。確定の途中の取引の prepare は通るので、
   * その intent も、ここで決着を待つ。
   */
  private settleAllStep(f: SettleAllFrame): Step<void, SettleAllFrame> {
    // 待ちは実時間のタイマーなので、期限も実時間で測る。
    f.deadline ??= this.rt.now() + SCHEMA_WAIT_MS;
    const tables = f.tables ? new Set(f.tables) : null;
    const pendingNow = (): Intent[] => {
      const all = this.b.exec(`SELECT DISTINCT txn, anchor, tbl FROM __intents`) as unknown as Intent[];
      const seen = new Set<string>();
      return all.filter((i) => (tables === null || tables.has(objectKey(i.tbl))) && !seen.has(i.txn) && seen.add(i.txn));
    };
    for (;;) {
      if (!f.batch) {
        const pending = pendingNow();
        if (pending.length === 0) return done(undefined);
        f.batch = pending;
      }
      const i = f.batch[0];
      if (i) {
        if (!f.res) return wait({ kind: "ask", anchor: i.anchor, txn: i.txn, pushTo: 0 }, "res");
        if (!f.finishing) {
          f.finishing = true;
          if (f.res.status === "committed") return wait(this.call("finalize", { req: { txn: i.txn, c: f.res.c } }));
          if (f.res.status === "aborted") return wait(this.call("abort", { req: { txn: i.txn } }));
        }
        f.batch.shift();
        f.res = undefined;
        f.finishing = undefined;
        continue;
      }
      if (!f.slept) {
        if (pendingNow().length === 0) return done(undefined);
        if (this.rt.now() > f.deadline) {
          throw new ConflictError("schema change is waiting for transactions on this shard to finish");
        }
        f.slept = true;
        return wait({ kind: "sleep", ms: 5 });
      }
      f.slept = undefined;
      f.batch = undefined;
    }
  }

  private syncSchemaStep(f: SyncSchemaFrame): Step<{ moving: boolean }, SyncSchemaFrame> {
    if (!f.asked && f.req.atLeast > this.applied) {
      f.asked = true;
      return wait(this.call("toEpoch", { epoch: f.req.atLeast }));
    }
    return done({ moving: this.moving() });
  }

  // ---- 手続き: ライブ移動 ----

  /** 未着のグループを引き取る。 */
  private arriveStep(f: ArriveFrame): Step<void, ArriveFrame> {
    if (f.asked) return done(undefined);
    const wanted = f.groups.filter((g) => {
      const range = this.incomingIn(this.areaOf(g));
      return range !== undefined && !this.arrivedIn(g, range);
    });
    if (!wanted.length) return done(undefined);
    f.asked = true;
    return wait({ kind: "pull", groups: wanted });
  }

  /**
   * 子から親への移動の要求 (listGroups、pull、finishMove) を受けた親が、答える前に、要求が運ぶ move-start の epoch まで列を適用するか
   * (M21 の PULL_AT_EPOCH)。適用すると fence が付く。欠陥のスイッチ pullWithoutEpoch は、適用せずに (fence の前に) 答える。
   */
  private reachMove(req: { epoch?: number }): boolean {
    return !this.faults.pullWithoutEpoch && req.epoch !== undefined && req.epoch > this.applied;
  }

  /** 範囲のグループを列挙する (ShardApi.listGroups)。親は、移動の epoch まで列を適用してから (fence が付いてから) 答える。 */
  private groupsStep(f: GroupsFrame): Step<{ groups: string[]; cursor: GroupCursor | null }, GroupsFrame> {
    if (!f.reached) {
      f.reached = true;
      if (this.reachMove(f.req)) return wait(this.call("toEpoch", { epoch: f.req.epoch! }));
    }
    return done(this.listGroups(f.req));
  }

  /** 範囲を渡し終えた印を付ける (ShardApi.finishMove)。親は、移動の epoch まで列を適用してから答える。 */
  private finishMoveStep(f: FinishMoveFrame): Step<{ m: Ts }, FinishMoveFrame> {
    if (!f.reached) {
      f.reached = true;
      if (this.reachMove(f.req)) return wait(this.call("toEpoch", { epoch: f.req.epoch! }));
    }
    return done(this.finishHanding(f.req));
  }

  /**
   * piece を子へ渡す。m を確定してから応答するので、再送しても同じ m になる。
   * 親は ack まで行を保持する。子が受け取る前に落ちても再送で取り戻せるからである。
   *
   * 要求は、区間 [start, end) で fence を名指しする。区間の境目をブロックの中に置くと、同じグループが別々の fence に
   * 入り得るからである。
   * いまは、どの piece もグループの全体である (区間は端から端まで)。1 通に収まらないグループを主キーの順の区間に切るのは、
   * 後の段で足す (docs/design-subslots.md の「piece の pull」)。
   */
  private pullStep(f: PullFrame): Step<PiecePayload[], PullFrame> {
    if (f.out) return done(f.out);
    if (!f.reached) {
      // 移動の epoch まで列を適用してから渡す。適用で fence が付き、以後、この区間の書き込みを断る。適用する前に渡すと、渡した後も古い
      // 範囲表の書き込みを受け、子へ渡した行に届かない (M21 の m21_red_pull_unfenced)。
      f.reached = true;
      if (this.reachMove(f.req)) return wait(this.call("toEpoch", { epoch: f.req.epoch! }));
    }
    f.out = this.pullPieces(f.req);
    return wait({ kind: "sync" });
  }

  private pullPieces(req: Interval & { want: PieceWant[]; to: string; maxBytes: number; epoch?: number }): PiecePayload[] {
    // 欠陥のスイッチ pullWithoutEpoch: move-start を適用していない (fence していない) 親が、頼まれた区間を、頼んだシャードへ渡す。
    const fence = this.fenceOf(req) ?? (this.faults.pullWithoutEpoch ? { ...intervalOf(req), to: req.to, done: 0, epoch: req.epoch ?? 0 } : undefined);
    const out: PiecePayload[] = [];
    let bytes = 0;
    for (const w of req.want) {
      const g = w.g;
      // 続きの位置からの要求は、グループを分けて運ぶようになってから受ける。
      if ("from" in w && w.from !== null) throw new SqlError(`pull of group ${g} from a position: a group is still moved as one piece`);
      const f = fence && overlaps(fence, blockOf(g)) ? fence : undefined;
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
      // この移動で、もう渡したグループなら、同じ m で渡し直す (応答が失われた子の再送)。前の移動で渡した印は、範囲が戻って、グループが
      // 届くか受け取り終えたときに外している (unmarked)。範囲を送り出すのは受け取り終えた後だけなので、ここにあるのは、この移動の印である。
      let known = this.moved.get(g);
      if (!known || known.epoch !== f.epoch) {
        known = { m: this.issue(), to: req.to, acked: false, epoch: f.epoch };
        this.moved.set(g, known);
        this.b.tx(() => {
          this.b.exec(
            `INSERT INTO __moved(g, lo, hi, "after", up_to, m, dest, epoch) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, g, f.start, f.end, END, END, known!.m, req.to, f.epoch,
          );
          for (const i of intents) {
            this.b.exec(
              `INSERT OR IGNORE INTO __moved_txn(txn, g, lo, "after", dest, epoch) VALUES (?, ?, ?, ?, ?, ?)`, i.txn as string, g, f.start, END, req.to, f.epoch,
            );
          }
        });
      }
      out.push({ g, range: intervalOf(f), after: null, epoch: f.epoch, upTo: null, m: known.m, rows, intents, schema: this.schema });
    }
    return out;
  }

  /** グループを、渡す側から引き取る。 */
  private fetchStep(f: FetchFrame): Step<void, FetchFrame> {
    if (!f.queue) {
      // pull は、渡す側の fence を範囲で名指しする。受け取り中の範囲ごとにまとめて送る。
      const byRange = new Map<IncomingRange, string[]>();
      for (const g of f.groups) {
        const range = this.incomingIn(this.areaOf(g))!;
        byRange.set(range, [...(byRange.get(range) ?? []), g]);
      }
      f.queue = [...byRange].map(([range, rest]) => ({ range, rest }));
    }
    let forks: Fork[] | undefined;
    for (;;) {
      const cur = f.queue[0];
      if (!cur) return done(undefined, forks);
      const from = cur.range.from_id;
      if (f.payload) {
        if (!f.received) {
          f.received = true;
          return wait(this.call("receive", { payload: f.payload }));
        }
        // 受け取った。渡す側には、待たずに ack を送る。
        const payload = f.payload;
        forks = [{ kind: "detached", effect: { kind: "peer", call: this.peer(from, "ack", { pieces: payload.map(pieceOf) }) } }];
        const got = new Set(payload.map((p) => p.g));
        cur.rest = cur.rest.filter((g) => !got.has(g));
        f.payload = undefined;
        f.received = undefined;
      }
      if (!cur.rest.length) {
        f.queue.shift();
        continue;
      }
      const pull = this.peer(from, "pull", {
        ...intervalOf(cur.range), want: cur.rest.map((g) => ({ g, from: null })), to: this.id, maxBytes: 1_000_000, epoch: cur.range.epoch,
      });
      return wait({ kind: "peer", call: pull }, "payload", forks);
    }
  }

  private receiveStep(f: ReceiveFrame): Step<void, ReceiveFrame> {
    const payload = f.payload;
    if (f.stored) return done(undefined);
    if (!f.reached) {
      // グループの一部だけの piece は、まだ受け取れない。受け取ると、一部しか届いていないグループを「到着した」と記録してしまう。
      const part = payload.find((p) => p.after !== null || p.upTo !== null);
      if (part) throw new SqlError(`received a part of group ${part.g}: a group is still moved as one piece`);
      // 親の表定義の版まで追いついてから受け取る。子は増設の途中で生まれるので、DDL の「全シャードへの適用」から
      // 漏れることがある。古い版のままだと、届いた行と表の形が合わず、新しい index を保守しない古い計画の書き込みも通る。
      const schema = Math.max(0, ...payload.map((p) => p.schema));
      f.reached = true;
      if (!this.faults.childKeepsOldSchema) return wait(this.call("reach", { epoch: schema, catchUp: true }));
    }
    // この移動で、まだ届いていない piece だけを入れる。到着の記録は移動ごとにある。前の移動で届いて、その後に渡したグループが、範囲と
    // 一緒に戻ってきたら、それは新しい到着である (docs/design-refresh-across-move.md の「実装がすること」の 5)。
    const fresh = payload.filter((p) => this.arrived.get(p.g)?.epoch !== p.epoch);
    this.b.tx(() => {
      for (const p of fresh) {
        for (const { table, row } of p.rows) insertRow(this.b, this.def(table), row);
        for (const i of p.intents) {
          this.b.exec(
            `INSERT OR IGNORE INTO __intents(tbl, pk, sk, txn, anchor, prepare_ts, change) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            i.tbl ?? null, i.pk ?? null, i.sk ?? null, i.txn ?? null, i.anchor ?? null, i.prepare_ts ?? null, i.change ?? null,
          );
        }
        this.b.exec(
          `INSERT OR IGNORE INTO __arrived(g, lo, hi, "after", up_to, m, epoch) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          p.g, p.range.start, p.range.end, posKey(p.after), posKey(p.upTo), p.m, p.epoch,
        );
      }
    });
    // 到着の印は挿入と同じ同期区間で付ける。確定の待ちの間に、要求駆動の pull と背景の drain が
    // 同じグループを受け取ると二重に挿入してしまう。応答は output gate が確定まで止めるので安全である。
    for (const p of fresh) {
      this.arrived.set(p.g, { m: p.m, epoch: p.epoch });
      this.moved.delete(p.g);
      this.maxArrived = Math.max(this.maxArrived, p.m);
      this.observe(p.m);
    }
    f.stored = true;
    return wait({ kind: "sync" }); // 親が行を消すのは到着の確定後である。
  }

  /** 子が、受け取り中の範囲の全グループを引き取る。f.epoch は、受け取っている移動の move-start の epoch である。 */
  private drainStep(f: DrainFrame): Step<{ groups: number; rows: number; bytes: number }, DrainFrame> {
    if (!f.total) {
      const range = this.incoming.find((x) => x.epoch === f.epoch);
      if (!range) return done({ groups: 0, rows: 0, bytes: 0 });
      f.from = range.from_id;
      f.interval = intervalOf(range);
      f.total = { groups: 0, rows: 0, bytes: 0 };
      f.pass = 0;
      f.moved = 0;
    }
    const from = f.from!;
    const interval = f.interval!;
    const total = f.total;
    // 到着済みのグループの piece。いまは、グループの全体の 1 つである。
    const whole = (g: string): Piece => ({ g, range: interval, after: null, epoch: f.epoch });
    const here = (g: string) => this.arrived.get(g)?.epoch === f.epoch;
    // 親のグループを先頭から順に列挙して運ぶ。最後まで行ったら、もう一度先頭から列挙して、取り残しがないことを確かめる。
    // ack 済みのグループは親から消えているので、2 周目は残る側のグループを読むだけである。
    for (;;) {
      if (!f.rest) {
        if (!f.page) return wait({ kind: "peer", call: this.peer(from, "listGroups", { ...interval, limit: 256, cursor: f.cursor, epoch: f.epoch }) }, "page");
        const page = f.page;
        if (!f.ackedArrived) {
          f.cursor = page.cursor;
          f.ackedArrived = true;
          // 受け取り済みで親に ack が届いていないグループは、ack だけを送り直す。
          const arrived = page.groups.filter(here);
          if (arrived.length) return wait({ kind: "peer", call: this.peer(from, "ack", { pieces: arrived.map(whole) }) });
        }
        f.rest = page.groups.filter((g) => !here(g));
        f.moved! += page.groups.length;
      }
      if (f.payload) {
        const payload = f.payload;
        if (!f.received) {
          f.received = true;
          return wait(this.call("receive", { payload }));
        }
        if (!f.acked) {
          f.acked = true;
          return wait({ kind: "peer", call: this.peer(from, "ack", { pieces: payload.map(pieceOf) }) });
        }
        total.groups += payload.length;
        for (const p of payload) {
          total.rows += p.rows.length;
          total.bytes += encode(p.rows).length;
        }
        const got = new Set(payload.map((p) => p.g));
        f.rest = f.rest.filter((g) => !got.has(g));
        f.payload = undefined;
        f.received = undefined;
        f.acked = undefined;
      }
      // pull は大きさの上限で途中までしか返さないことがある。残りを取り終えるまで繰り返す。
      if (f.rest.length) {
        const pull = this.peer(from, "pull", { ...interval, want: f.rest.map((g) => ({ g, from: null })), to: this.id, maxBytes: 1_000_000, epoch: f.epoch });
        return wait({ kind: "peer", call: pull }, "payload");
      }
      f.rest = undefined;
      f.page = undefined;
      f.ackedArrived = undefined;
      if (f.cursor !== null) continue;
      if (f.moved === 0) return done(total);
      if (f.pass! > 100) throw new SqlError("drain does not converge");
      f.pass!++;
      f.cursor = undefined;
      f.moved = 0;
    }
  }

  /**
   * 子が、移動を終えるまで進める (docs/design-catalog-epoch.md の「移動の遷移」と決めたこと 4)。f.epoch は移動の move-start の epoch で
   * ある。move-start を適用したときに応答の後の仕事として始まり (moveStarted)、alarm (redrive) と、進める側の drain の要求も、同じ手順に
   * 合流する (殻が epoch ごとに 1 つにまとめる)。手は次の順で、どれも、やり直してよい。
   *   1. 移動の epoch まで列を適用する (適用すると受け取り始める)。
   *   2. 全グループを親から引き取る (drainStep)。
   *   3. 親に finishMove を頼み、親の時計を受け取る。
   *   4. 受け取り終えた印を付ける (finishIncoming)。以後、このシャードは移動の途中ではない。
   *   5. Meta に move-end を記録させる。受け取り終えた後でだけ記録させる (M21 の END_AFTER_DRAIN。列からは決まらないので、ここで守る)。
   *      受け取り終える前に記録されると、その後に開いた表定義の遷移を、受け取り中のこのシャードが適用できない (m21_red_end_early)。
   *   6. その記録まで、自分の写しを進める。写しで閉じた移動は、alarm がもう進めない。
   * 受け取り終えた後に呼ばれたら (4 まで済んでいる)、5 から進める。写しでも閉じていれば、何もしない。
   */
  private moveStep(f: MoveFrame): Step<{ groups: number; rows: number; bytes: number }, MoveFrame> {
    if (!f.reached) {
      f.reached = true;
      if (f.epoch > this.applied) return wait(this.call("toEpoch", { epoch: f.epoch }));
    }
    if (f.range === undefined) {
      const rec = this.log.find((x) => x.epoch === f.epoch)?.rec;
      if (rec?.kind !== "move-start" || rec.to !== this.id) throw new SqlError(`epoch ${f.epoch} is not a move to shard ${this.id}`);
      f.range = this.incoming.find((x) => x.epoch === f.epoch) ?? null;
      if (!f.range && !this.snap.moves.some((m) => m.epoch === f.epoch)) return done({ groups: 0, rows: 0, bytes: 0 });
    }
    const range = f.range;
    if (range) {
      // 欠陥のスイッチ endBeforeDrained: 受け取り終える前に、move-end を記録させる。
      if (this.faults.endBeforeDrained && !f.early) return wait({ kind: "meta", method: "endMove", args: [f.epoch] }, "early");
      if (!f.total) return wait(this.call("drain", { epoch: f.epoch }), "total");
      if (!f.m) return wait({ kind: "peer", call: this.peer(range.from_id, "finishMove", { ...intervalOf(range), epoch: f.epoch }) }, "m");
      if (!f.finished) {
        this.finishIncoming({ ...intervalOf(range), m: f.m.m });
        f.finished = true;
      }
    }
    if (!f.ended) return wait({ kind: "meta", method: "endMove", args: [f.epoch] }, "ended");
    if (!f.caught) {
      f.caught = true;
      return wait(this.call("catchUp", { epoch: f.ended.epoch }));
    }
    return done(f.total ?? { groups: 0, rows: 0, bytes: 0 });
  }

  // ---- 手続き: 行ロックの待ち ----

  /**
   * 欠陥 prepareWaits だけが使う。prepare が、書く行の他の取引のロックが空くのを待つ。prepare の要求に開始時刻はないので、
   * 最も若い待ち手として待ち、wound はしない。期限を過ぎたら待つのをやめ、検証に任せる (ロックが残っていれば abort)。
   */
  private foreignLocksStep(f: ForeignLocksFrame): Step<void, ForeignLocksFrame> {
    f.deadline ??= this.deps.clock.now() + LOCK_WAIT_MS;
    const me: LockOwner = { txn: lockIdOf(f.txn), start: Number.MAX_SAFE_INTEGER };
    for (f.at ??= 0; f.at < f.writes.length; f.at++) {
      const w = f.writes[f.at]!;
      const key = this.lockKey(w.table, w.pk);
      const l = this.liveLock(key);
      if (l && l.txn !== me.txn) {
        if (this.deps.clock.now() >= f.deadline) return done(undefined);
        return wait({ kind: "row", key, me, deadline: f.deadline, quiet: true });
      }
    }
    return done(undefined);
  }

  /**
   * 悲観的な DML。最新の状態 F で実行し、変更行のロックを取る。
   * 先に intent を決着させる。確定済みで未適用の行を読み飛ばすと、T も F も新しいのに見えない commit ができる。
   */
  private lockedStep(f: LockedFrame): Step<ExecRes, LockedFrame> {
    const { req, me } = f;
    f.deadline ??= this.deps.clock.now() + LOCK_WAIT_MS;
    const deadline = f.deadline;
    if (f.since === undefined) {
      // 要求が着いた。取引の lease を、要求の lease で延ばす。延ばすのは、着いたときだけである (行を待った後では延ばさない)。
      f.since = this.deps.clock.now();
      this.arrive(me);
    }
    const since = f.since;
    // 最新の状態を読むので、読む時刻はない。
    const claim: Plan & Rows = { deps: req.deps, spans: req.spans, writes: [], at: null };
    if (f.waiting !== undefined) {
      // 行を待って、起こされた。到着の待ちからやり直す。
      f.woken = f.waiting;
      f.waiting = undefined;
      f.arrived = undefined;
      f.F = undefined;
    }
    if (!f.arrived) {
      f.arrived = true;
      return wait(this.call("arrive", { groups: this.sksOf(req.spans) }));
    }
    // 欠陥 dmlAtT は、F を発行せず、取引の T を F として使う。T は別のシャードの時計から来ることがある。
    const atT = this.faults.dmlAtT && req.T !== undefined;
    if (f.F === undefined) {
      // F はこのシャードが発行する時刻である。取引の T と因果トークンまで時計を進めてから発行するので、F より後の確定は F より大きい
      // (specs/m9_protocol.qnt の m9_red_f_is_t)。
      if (!this.faults.dmlSkipsClock) {
        this.observe(req.minTs);
        this.observe(req.T);
      }
      f.F = atT ? req.T! : this.issue();
      this.assertOwned(claim);
      return wait(this.call("settle", { spans: req.spans, T: f.F }), "applied");
    }
    if (f.applied) {
      if (!atT) f.F = this.issue();
      return wait(this.call("settle", { spans: req.spans, T: f.F }), "applied");
    }
    const F = f.F;
    // ここから先は待たない。行ロックや intent の決着を待っている間に DDL が適用されていたら、この文は古い計画である。
    // 入口で断るのと同じに、ここで断る (待ちの後の確かめ直し)。
    const sec = this.enter(claim);
    this.count("writes", req.spans);
    // 欠陥のスイッチ perShardLockTtl (2026-11-17 までの形): 文を実行するたびに、このシャードのロックだけを、自分の時計で延ばす。
    if (this.faults.perShardLockTtl) this.arrive(me);
    const overlay = (req.overlay ?? []).map((c) => ({ table: c.table, pk: c.pk, image: c.after }));
    let out: { columns: string[]; values: Value[][]; changes: Change[]; count?: number };
    // 欠陥 lockedReadAtT は、ロック読みを T の snapshot で読む (返す F は変えない)。dmlAtT は、F = T の状態で実行する。
    const readAt = atT ? F : this.faults.lockedReadAtT && !req.write ? req.T : undefined;
    try {
      out = this.rollback(() => {
        if (readAt !== undefined) this.restore(this.deltaAfter(readAt, req.spans));
        if (overlay.length) setBasedRestore(this.b, (t) => this.def(t), overlay);
        return this.run(sec, req);
      });
      // 書いた行のロックを取る読み (Worker の SQLite で実行した文の、Txn.lockWritten) は、行を書かないので、文の実行では書き込み禁止に
      // 当たらない。書き込みとして頼る表 (Dep.write) の行のロックは、その表が書き込み禁止なら、ここで断る。断らないと、文は通り、取引の
      // COMMIT が禁止に当たる。文をシャードで実行する経路では文が断られるので、成否が、文の経路で変わる。
      this.assertUnlocked((req.lockRows ?? []).filter((r) => req.deps.some((d) => d.write === true && d.name === objectKey(r.table))));
    } catch (e) {
      // 書き込み禁止に当たった。取引がその表の行ロックを持つなら、断る前に、書こうとした行のロックを与える (heldAtFence)。
      if (e instanceof TableLocked) throw this.heldAtFence(e, me, since);
      if (e instanceof ReadTooOld || e instanceof ConflictError || e instanceof NotOwner || e instanceof ShardLimit) throw e;
      // 文は F の状態を読んだうえで失敗した。読んだ時刻を付けて返し、呼び出し側に範囲を記録させる (ExecRes.error)。
      return done({ columns: [], values: [], changes: [], error: asSqlError(e).message, F, T: req.T ?? F, hlc: this.hlc.value, epoch: this.epoch });
    }
    const rows = [...out.changes, ...(req.lockRows ?? [])] as Pick<Change, "table" | "pk">[];
    const blocked = this.blockedBy(rows, me);
    if (!blocked) {
      for (const c of rows) this.grant(this.lockKey(c.table, c.pk), me, since);
      if (f.woken && this.locks.get(f.woken)?.txn === me.txn) f.woken = null;
      return done({ ...out, changes: out.changes.map((c) => ({ ...c, since: F })), F, T: req.T ?? F, hlc: this.hlc.value, epoch: this.epoch });
    }
    if (f.woken && f.woken !== blocked) this.wakeNext(f.woken);
    f.woken = null;
    if (this.deps.clock.now() >= deadline) throw new ConflictError("lock wait timeout");
    f.waiting = blocked;
    return wait({ kind: "row", key: blocked, me, deadline });
  }

  /** 起こされた行を取らずに去るなら、次の待ち手を起こす。 */
  private lockedExit(f: LockedFrame): Fork[] {
    if (f.woken) this.wakeNext(f.woken);
    return [];
  }

  // ---- 手続き: intent の決着 ----

  /**
   * T 以下で確定し得る intent をすべて決着させる。
   * 無視してよいのは commit 時刻が T を超えると確定した intent だけである。
   */
  private settleStep(f: SettleFrame): Step<Ts, SettleFrame> {
    const pushed = (f.pushed ??= new Set());
    // 取引ごとの、この手続きで決着させた回数。決着させた後も intent が残ることはある (運ばれた行の到着を待つ、など)。
    // その場合は、イベントループへ制御を返して待ってから、もう 1 度問い合わせる。上限を超えて残るなら、ここでは適用できない
    // (不変条件 2 の症状)。
    const tries = (f.tries ??= new Map());
    f.applied ??= 0;
    for (;;) {
      if (!f.batch) {
        const pending = this.overlapping(f.spans, f.T).filter((i) => !pushed.has(i.txn));
        if (pending.length === 0) return done(f.applied);
        f.batch = [...new Set(pending.map((i) => i.txn))].map((txn) => pending.find((i) => i.txn === txn)!);
      }
      const intent = f.batch[0];
      if (!intent) {
        f.batch = undefined;
        continue;
      }
      const txn = intent.txn;
      if (!f.res) {
        const n = tries.get(txn) ?? 0;
        if (!f.slept) {
          if (n >= SETTLE_TRIES) {
            // 待たずに問い合わせを繰り返すと止まらない。anchor が自分なら問い合わせも適用も microtask だけで済み、イベントループが回らず、
            // どの時間の制限も効かない (未解決の問題 18)。読みを、理由を付けて失敗させる。
            throw new SqlError(`stuck: transaction ${txn} is decided but its write to ${intent.tbl} cannot be applied on ${this.id}`);
          }
          f.slept = true;
          if (n > 0) return wait({ kind: "sleep", ms: Math.min(100, 2 ** n) });
        }
        tries.set(txn, n + 1);
        if (this.faults.readerTimeoutPass) pushed.add(txn);
        else return wait({ kind: "ask", anchor: intent.anchor, txn, pushTo: f.T }, "res");
      } else if (f.res.status === "committed") {
        if (!f.finishing) {
          f.finishing = true;
          return wait(this.call("finalize", { req: { txn, c: f.res.c } }));
        }
        f.applied = Math.max(f.applied, f.res.c);
      } else if (f.res.status === "aborted") {
        if (!f.finishing) {
          f.finishing = true;
          return wait(this.call("abort", { req: { txn } }));
        }
      } else pushed.add(txn);
      f.batch.shift();
      f.slept = undefined;
      f.res = undefined;
      f.finishing = undefined;
    }
  }

  /** 取り残された intent を、anchor に尋ねて決着させる (redrive)。 */
  private orphanStep(f: OrphanFrame): Step<void, OrphanFrame> {
    if (!f.res) return wait({ kind: "ask", anchor: f.anchor, txn: f.txn, pushTo: 0 }, "res");
    if (!f.finishing) {
      f.finishing = true;
      if (f.res.status === "committed") return wait(this.call("finalize", { req: { txn: f.txn, c: f.res.c } }));
      if (f.res.status === "aborted") return wait(this.call("abort", { req: { txn: f.txn } }));
    }
    return done(undefined);
  }

  // ---- 手続き: 文の実行 ----

  /** 時刻 T の状態 (と自分の未 commit write) の上で文を実行し、ROLLBACK する。 */
  private execStep(f: ExecFrame): Step<ExecRes, ExecFrame> {
    const req = f.req;
    if (!f.planned) {
      this.withinLimits(req);
      f.planned = true;
      return wait(this.call("schema", { deps: req.deps, epoch: req.epoch, rows: { spans: req.spans, writes: [] }, atLeast: req.atLeast, statement: true }));
    }
    if (req.lock && (req.write || req.lockRows)) {
      if (!f.locked) return attempt(this.call("locked", { req, me: req.lock }), "locked");
      if (f.locked.ok) return done(f.locked.value);
      const e = f.locked.error;
      if (e instanceof ReadTooOld || e instanceof ConflictError || e instanceof NotOwner || e instanceof ShardLimit) throw e;
      throw asSqlError(e);
    }
    if (!f.arrived) {
      // 悲観の取引の、ロックを取らない文。取引の lease を、要求の lease で延ばす (取引のどの文も、取引の全部のロックを延ばす)。
      if (req.lease) this.extend(req.lease.txn, req.lease);
      f.arrived = true;
      return wait(this.call("arrive", { groups: this.sksOf(req.spans) }));
    }
    if (f.T === undefined) {
      this.observe(req.minTs);
      const first = req.T ?? this.issue();
      this.observe(first);
      f.T = first;
      this.assertOwned({ spans: req.spans, writes: [], at: first });
      return wait(this.call("settle", { spans: req.spans, T: first }), "applied");
    }
    // 時刻が未指定の読みは、決着させた取引より後の時刻で読む。先に取った T のままだと、
    // 読み取りの開始前に確定した書き込みが見えない。push した取引の c が新しい T 以下になり得るので、
    // 決着が起きなくなるまで取り直す。
    if (req.T === undefined && f.applied) {
      f.T = this.issue();
      return wait(this.call("settle", { spans: req.spans, T: f.T }), "applied");
    }
    const T = f.T;
    const applied = f.applied!;
    // T を指定した autocommit の読み (複数シャードの読み) も同じである。T は対象シャードの時計の最大値だが、
    // phase 2 が届いていない参加者の時計は commit 時刻に追いついていない。anchor の時計が進んでいると c > T になり、
    // そのまま T で読むと、開始前に確定して応答まで返った書き込みが見えない。T を取り直させる。
    if (req.T !== undefined && req.realtime && applied > T && !this.faults.noRealtimeBump) throw new ReadTooOld(`moved at ${this.hlc.value}`);
    // ここから先は待たない。intent の決着を待っている間に DDL が適用されていたら、この文は古い計画である。入口で断るのと同じに、
    // ここで断る。断らないと、読むだけの取引が、古い計画の読みの答えを、検証なしでそのまま使う
    // (test/stale-plan-after-wait.test.ts)。
    const sec = this.enter({ deps: req.deps, spans: req.spans, writes: [], at: T });
    this.count(req.write ? "writes" : "reads", req.spans);
    if (req.fresh && req.spans.some((s) => this.changedSince(sec, s, T))) {
      throw new ReadTooOld(`moved at ${this.hlc.value}`);
    }
    const delta = this.deltaAfter(T, req.spans);
    const overlay = (req.overlay ?? []).map((c) => ({ table: c.table, pk: c.pk, image: c.after }));
    try {
      if (delta.length === 0 && overlay.length === 0 && !req.write) {
        // 差分がなければ本体がそのまま T の状態なので、トランザクションは要らない。
        return done({ ...this.run(sec, req), T, hlc: this.hlc.value, epoch: this.epoch });
      }
      const out = this.rollback(() => {
        this.restore(delta);
        if (overlay.length) setBasedRestore(this.b, (t) => this.def(t), overlay);
        return this.run(sec, req);
      });
      return done({ ...out, T, hlc: this.hlc.value, epoch: this.epoch });
    } catch (e) {
      if (e instanceof ReadTooOld || e instanceof ConflictError || e instanceof NotOwner || e instanceof ShardLimit) throw e;
      // 文は T の状態を読んだうえで失敗した。読んだ時刻を付けて返し、呼び出し側に範囲を記録させる。
      return done({ columns: [], values: [], changes: [], error: asSqlError(e).message, T, hlc: this.hlc.value, epoch: this.epoch });
    }
  }

  /** シングルシャードの autocommit 書き込み。1 回の RPC で完結する。 */
  private autoStep(f: AutoFrame): Step<ExecRes, AutoFrame> {
    const req = f.req;
    if (!f.planned) {
      this.withinLimits(req);
      f.planned = true;
      return wait(this.call("schema", { deps: req.deps, epoch: req.epoch, rows: { spans: req.spans, writes: [] }, statement: true }));
    }
    if (!f.arrived) {
      f.arrived = true;
      return wait(this.call("arrive", { groups: this.sksOf(req.spans) }));
    }
    // 最新の状態に書くので、読む時刻はない。
    const claim: Plan & Rows = { deps: req.deps, spans: req.spans, writes: [], at: null };
    if (f.now === undefined) {
      this.observe(req.minTs);
      f.now = this.issue();
      this.assertOwned(claim);
      return wait(this.call("settle", { spans: req.spans, T: f.now }));
    }
    const now = f.now;
    const woken = (f.woken ??= new Set());
    let sec: Section<Check> | undefined;
    if (!f.entered) {
      f.entered = true;
      sec = this.enter(claim);
      this.count("writes", req.spans);
      // 読む範囲に未決着の intent があると commit 時刻の順序を保証できないので no-wait で返す。
      if (!this.faults.ignoreIntentsInValidation && this.overlapping(req.spans, Number.MAX_SAFE_INTEGER).length > 0) {
        throw new ConflictError("pending intent");
      }
    }
    try {
      if (sec) {
        // 入口の同期区間の続き。捕捉できる形の文は、先に高速経路 (directStep) を試す。
        if (req.write?.capture && !this.faults.triggerCapture) return attempt(this.call("direct", { req, claim, now }), "direct");
      } else if (f.direct) {
        const direct = unwrap(f.direct);
        f.direct = undefined;
        if (direct) return done(direct);
        // 高速経路は使えなかった。その結果を待つ間に、制御を 1 回手放している。区間に入り直して、入口と同じことを確かめ直す。
        // 手放している間に走れるのは、もう起こされていた行の待ち手の続きだけで、持ち主も intent も変えない
        // (test/autocommit-fallback.test.ts)。それでも、待ちの前の確かめは、待ちの後へ持ち越さない。
        sec = this.enter(claim);
        if (!this.faults.ignoreIntentsInValidation && this.overlapping(req.spans, Number.MAX_SAFE_INTEGER).length > 0) {
          throw new ConflictError("pending intent");
        }
      } else {
        // 行を待った後。autocommit は取引より若いものとして順番を待つ。待っている間に行が変わるので、区間に入り直して実行し直す。
        unwrap(f.waited!);
        f.waited = undefined;
        woken.add(f.key!);
        sec = this.enter(claim);
        if (this.overlapping(req.spans, Number.MAX_SAFE_INTEGER).length > 0) throw new ConflictError("pending intent");
      }
      const dry = this.rollback(() => this.run(sec!, req));
      if (!f.me) {
        f.me = { txn: `auto-${now}`, start: this.deps.clock.now(), auto: now };
        f.deadline = this.deps.clock.now() + LOCK_WAIT_MS;
      }
      const me = f.me;
      const key = this.blockedBy(dry.changes, me);
      if (key !== null) {
        f.key = key;
        return attempt({ kind: "row", key, me, deadline: f.deadline! }, "waited");
      }
      // 同じ主キーでなくても、他の取引の intent が同じ UNIQUE の値を持っていれば確定できない。
      const pending = this.faults.autoIgnoresUniqueIntents ? null : this.uniquePending(me.txn, dry.changes);
      if (pending) throw new ConflictError(pending);
      this.assertWriteSetFits(sec, dry.changes);
      // 下書きを取った区間の続きで、間に待ちはない。版も持ち主も、この区間の入口 (enter) で確かめてある。
      const c = this.issue();
      if (dry.changes.length) this.b.tx(() => this.applyAndLog(`auto-${c}`, c, dry.changes));
      return done({ ...dry, T: c, hlc: this.hlc.value, epoch: this.epoch });
    } catch (e) {
      if (e instanceof ConflictError || e instanceof NotOwner) throw e;
      throw asSqlError(e);
    }
  }

  /** autocommit はロックを取らないので、起こされたら、用が済み次第、次の待ち手を起こす。 */
  private autoExit(f: { woken?: Set<string> }): Fork[] {
    return [...(f.woken ?? [])].map((key) => ({ kind: "wake", key }));
  }

  /**
   * autocommit の高速経路。文を下書きせずに 1 回だけ実行し、そのまま確定する。
   * ROLLBACK した書き込みも課金されるので、下書きと再適用をやめると 1 行の更新が 6 行から 2 行になる。
   * 行ロックに当たったときだけ ROLLBACK して待つ。捕捉できない形なら null を返し、通常の経路に任せる。
   */
  private directStep(f: DirectFrame): Step<ExecRes | null, DirectFrame> {
    const { req, claim } = f;
    if (!f.me) {
      f.me = { txn: `auto-${f.now}`, start: this.deps.clock.now(), auto: f.now };
      f.deadline = this.deps.clock.now() + LOCK_WAIT_MS;
    }
    const me = f.me;
    const woken = (f.woken ??= new Set());
    if (f.key !== undefined) woken.add(f.key);
    // 最初の 1 歩は、autoStep が入った同期区間の続きで、間に待ちはない。行を待った後は、ここで区間に入り直す。
    const sec = this.enter(claim);
    if (f.key !== undefined && this.overlapping(req.spans, Number.MAX_SAFE_INTEGER).length > 0) throw new ConflictError("pending intent");
    const hit: { key: string | null } = { key: null };
    const pending: { reason: string | null } = { reason: null };
    let out: { changes: Change[]; inserted: Ran["inserted"]; c: Ts } | undefined;
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
        return { changes: r.changes, inserted: r.inserted, c };
      });
    } catch (e) {
      if (e === FALLBACK) return done(null);
      if (e === PENDING_UNIQUE) throw new ConflictError(pending.reason!);
      if (e !== BLOCKED) throw e;
    }
    if (out) return done({ columns: [], values: [], changes: out.changes, inserted: out.inserted, T: out.c, hlc: this.hlc.value, epoch: this.epoch });
    f.key = hit.key!;
    return wait({ kind: "row", key: f.key, me, deadline: f.deadline! });
  }

  // ---- 手続き: 確定 ----

  private commitLocalStep(f: PrepareFrame<Omit<PrepareReq, "anchor">>): Step<CommitRes, PrepareFrame<Omit<PrepareReq, "anchor">>> {
    const req = f.req;
    if (!f.planned) {
      f.planned = true;
      this.extend(lockIdOf(req.txn), req.lease);
      return wait(this.call("schema", { deps: req.deps, epoch: req.epoch, rows: { spans: req.spans, writes: req.writes } }));
    }
    if (!f.arrived) {
      f.arrived = true;
      return wait(this.call("arrive", { groups: this.sksOf(req.spans, req.writes) }));
    }
    if (this.faults.prepareWaits && !f.waitedLocks) {
      f.waitedLocks = true;
      return wait(this.call("foreignLocks", { txn: req.txn, writes: req.writes }));
    }
    // グループの到着を待っている間に DDL が適用されることがある。古い計画のまま書かない。
    // 時計は、版を確かめた後、持ち主を確かめる前に進める。版の古い要求の T は、時計に取り込まない。
    this.enter({ deps: req.deps });
    this.observe(req.T);
    const sec = this.enter({ deps: req.deps, spans: req.spans, writes: req.writes, at: req.T });
    try {
      this.assertWriteSetFits(sec, req.writes);
      // 取引が溜めた変更の行を、適用する前に確かめる (書き込みの守り)。
      this.claimed(sec, req.writes, null);
    } catch (e) {
      this.releaseLocks(req.txn);
      throw e;
    }
    const reason = this.validate(sec, req.txn, req.T, req.writes, req.spans);
    if (reason) {
      this.releaseLocks(req.txn); // 失敗した取引のロックを残すと、TTL まで全員が待つ
      return done({ ok: false, reason });
    }
    const c = this.issue();
    if (req.writes.length) this.b.tx(() => this.applyAndLog(req.txn, c, req.writes));
    this.releaseLocks(req.txn);
    this.count("writes", req.spans, req.writes);
    return done({ ok: true, c });
  }

  private prepareStep(f: PrepareFrame<PrepareReq>): Step<PrepareRes, PrepareFrame<PrepareReq>> {
    const req = f.req;
    if (!f.planned) {
      f.planned = true;
      this.extend(lockIdOf(req.txn), req.lease);
      return wait(this.call("schema", { deps: req.deps, epoch: req.epoch, rows: { spans: req.spans, writes: req.writes } }));
    }
    if (!f.arrived) {
      f.arrived = true;
      return wait(this.call("arrive", { groups: this.sksOf(req.spans, req.writes) }));
    }
    if (this.faults.prepareWaits && !f.waitedLocks) {
      f.waitedLocks = true;
      return wait(this.call("foreignLocks", { txn: req.txn, writes: req.writes }));
    }
    return done(this.prepareSync(this.enter({ deps: req.deps }), req));
  }

  /**
   * 表を消す前の確認 (Db の changeSchema の mode guard、M21 の DROP の場面)。
   * 先に、表を書き込み禁止にする prepare (要求の atLeast) を適用する。適用の前に、その表の intent を決着させ、適用の後は、その表への
   * 書き込みを断る。だから、ここで変更がなければ、表を消すまで、読んだ範囲は変わらない。
   */
  private unchangedStep(f: UnchangedFrame): Step<{ ok: boolean; reason?: string }, UnchangedFrame> {
    const req = f.req;
    if (!f.synced) return attempt(this.call("schema", { deps: [], atLeast: req.atLeast }), "synced");
    let sec: Section<"owned">;
    try {
      unwrap(f.synced);
      sec = this.enter({ spans: req.spans, writes: [], at: req.from });
    } catch (e) {
      return done({ ok: false, reason: e instanceof Error ? e.message : String(e) });
    }
    for (const s of req.spans) {
      if (this.changedSince(sec, s, Math.max(req.from, s.since ?? 0))) return done({ ok: false, reason: `${s.table} changed after it was read` });
      // 版の適用は intent を決着させてから行う (settleAllStep) が、それに頼らず、決着していない書き込みも変更として数える。
      const hit = this.faults.unchangedIgnoresIntents ? undefined : this.overlapping([s], Number.MAX_SAFE_INTEGER)[0];
      if (hit) return done({ ok: false, reason: `${s.table} has a pending write of ${hit.txn}` });
    }
    return done({ ok: true });
  }

  /** 複数のシャードに書く取引の確定。このシャードが anchor である。 */
  private commitStep(f: CommitFrame): Step<CommitRes, CommitFrame> {
    const req = f.req;
    if (!f.planned) {
      f.planned = true;
      this.extend(lockIdOf(req.txn), req.lease);
      const me = req.participants.find((p) => p.shard === this.id);
      return wait(this.call("schema", { deps: me?.deps ?? [], epoch: req.epoch, ...(me ? { rows: { spans: me.spans, writes: me.writes } } : {}) }));
    }
    if (!f.flight) {
      // 同じ 2PC の ID の実行は 1 つずつにする。同じ中身の COMMIT が 2 つ同時に届くと (再送が元の COMMIT を追い越す)、後の実行の
      // prepare は、先の実行が適用した行に当たって断られ、中止の abort(ID) が先の実行の残りの intent を消した
      // (specs/m17_txn_id_reuse.qnt の m17_red_resend、2026-11-13 の Codex の 2 回目の見直し、指摘 1)。先の実行が終わるのを待って
      // から記録を確かめ、待ち終えてから実行を登録するまで待ちを挟まない。
      if (this.inflight.get(req.txn) && !this.faults.concurrentDrives) return wait({ kind: "flight", txn: req.txn });
      // 2PC の ID は、取引の ID と続きの中身の指紋である (Txn.commit)。同じ ID の記録があるのは、同じ中身の COMMIT の再送なので、
      // 前の結果を返す。baton の使い回しでできた中身の違う続きは、別の ID の別の 2PC になる。
      const known = this.b.exec(`SELECT status, c FROM __txn WHERE txn = ?`, req.txn)[0];
      if (known) return done(known.status === "committed" ? { ok: true, c: known.c as Ts } : { ok: false, reason: "aborted" });
      // 決着の記録は保持時間の後に消す。消した tombstone の後に同じ取引の COMMIT が届いて確定すると、
      // 中止と判断して intent を無視した読み手と矛盾する (specs/m10_txn_record_gc.qnt の反例)。
      // 保持時間の半分より古い取引の COMMIT を受け付けなければ、消した後に確定することはない。
      if (this.deps.clock.now() - tsToPhysical(req.T) > (this.deps.txnRetainMs ?? TXN_RETAIN_MS) / 2) {
        return done({ ok: false, reason: "conflict: transaction older than the commit window" });
      }
      f.flight = { pushed: 0, decided: false, waiters: [] };
      this.inflight.set(req.txn, f.flight);
      const me = req.participants.find((p) => p.shard === this.id);
      if (me) return wait(this.call("arrive", { groups: this.sksOf(me.spans, me.writes) }));
    }
    if (!f.driving) {
      f.driving = true;
      return wait(this.call("drive", { req, flight: f.flight }), "res");
    }
    return done(f.res!);
  }

  /** 実行の登録を消し、決着を待っていたものを起こす。 */
  private commitExit(f: CommitFrame): Fork[] {
    if (f.flight) {
      this.inflight.delete(f.req.txn);
      for (const wake of f.flight.waiters) wake();
    }
    return [];
  }

  private driveStep(f: DriveFrame): Step<CommitRes, DriveFrame> {
    const { req, flight } = f;
    const self = req.participants.find((p) => p.shard === this.id);
    if (!self) throw new SqlError("anchor must be a participant");
    let others = req.participants.filter((p) => p.shard !== this.id);
    if (this.faults.skipReadOnlyPrepare) others = others.filter((p) => p.writes.length > 0);

    if (!f.acks) {
      const calls = others.map((p) =>
        this.peer(p.shard, "prepare", {
          txn: req.txn, T: req.T, writes: p.writes, spans: p.spans, anchor: this.id, deps: p.deps, epoch: req.epoch, ...(req.lease ? { lease: req.lease } : {}),
        }),
      );
      return wait({ kind: "peers", calls }, "acks");
    }
    if (f.c === undefined) {
      const acks = f.acks;
      const failed = acks.find((a) => !a.ok);
      if (failed && !failed.ok) return this.decideAbort(req, failed.reason);
      const stamps = acks.map((a) => (a as { prepareTs: Ts }).prepareTs);
      if (this.faults.prepareWaits && !f.waitedLocks) {
        f.waitedLocks = true;
        return wait(this.call("foreignLocks", { txn: req.txn, writes: self.writes }));
      }

      // ここから c の確定までは待たない。
      // 参加者の応答を待っている間に、この anchor に DDL が適用されていれば、取引は古い表定義で計画されている。
      let plan: Section<"schema">;
      try {
        plan = this.enter({ deps: self.deps });
      } catch (e) {
        return this.decideAbort(req, (e as Error).message);
      }
      if (!this.faults.anchorNoAbsorb) this.observe(Math.max(0, ...stamps, flight.pushed));
      const mine = this.prepareSync(plan, {
        txn: req.txn, T: req.T, writes: self.writes, spans: self.spans, anchor: this.id, deps: self.deps, epoch: req.epoch,
      });
      if (!mine.ok) return this.decideAbort(req, mine.reason);
      const c = this.faults.anchorNoAbsorb
        ? Math.max(mine.prepareTs, ...stamps, flight.pushed + 1)
        : mine.prepareTs;
      flight.decided = true;
      f.c = c;

      const stale = others.flatMap((p, i) => {
        const spans = this.faults.predicateProtected
          ? p.spans.filter((s) => !p.writes.some((w) => w.table === s.table))
          : unprotectedSpans(p.spans, p.writes);
        return spans.length > 0 && stamps[i]! < c ? [{ p, spans, from: stamps[i]! }] : [];
      });
      // 確かめは、参加者の prepare と同じ deps を運ぶ。prepare の後に、読んだだけの表の DDL が確定していれば、参加者は断る。
      const calls = stale.map((s) => this.peer(s.p.shard, "refresh", { txn: req.txn, spans: s.spans, from: s.from, to: c, deps: s.p.deps }));
      return wait({ kind: "peers", calls }, "refreshed");
    }
    const c = f.c;
    if (!f.recorded) {
      const bad = f.refreshed!.find((r) => !r.ok);
      if (bad) return this.decideAbort(req, bad.reason ?? "refresh failed");

      this.b.exec(
        `INSERT INTO __txn(txn, status, c, participants, at) VALUES (?, 'committed', ?, ?, ?)`,
        req.txn, c, JSON.stringify(req.participants.map((p) => p.shard)), this.deps.clock.now(),
      );
      f.recorded = true;
      // record の確定を待ってから phase 2 と応答を送る。先に送ると、確定の前に再起動したとき、記録が消えて
      // 照会した参加者が tombstone を書き、phase 2 を受けた参加者とで決着が割れる (specs/m3_anchor_recovery.qnt の m3_red)。
      if (!this.faults.phase2BeforeSync) return wait({ kind: "sync" });
    }
    this.deps.scheduleRedrive?.();
    const phase2 = this.call("phase2", { txn: req.txn, c, shards: req.participants.map((p) => p.shard) });
    return done({ ok: true, c }, [{ kind: "background", effect: phase2 }]);
  }

  private decideAbort(req: CommitReq, reason: string): { done: true; value: CommitRes; forks?: Fork[] } {
    this.b.exec(`INSERT OR IGNORE INTO __txn(txn, status, done, at) VALUES (?, 'aborted', 1, ?)`, req.txn, this.deps.clock.now());
    // 記録が確定のまま残ったなら、同じ ID の別の実行が確定させている。abort を送るとその intent を消すので、送らずにその決着を
    // 答える (同じ ID は同じ中身なので、確定が正しい答えである)。実行を 1 つずつにしてあるので、ここには来ないはずの 2 つ目の守り
    // である (specs/m17_txn_id_reuse.qnt の ABORT_CHECKS)。
    const kept = this.decided(req.txn);
    if (kept?.status === "committed" && !this.faults.abortIgnoresRecord) return done({ ok: true, c: kept.c });
    const aborts: Fork[] = req.participants.map((p) => ({
      kind: "background",
      effect: p.shard === this.id ? this.call("abort", { req: { txn: req.txn } }) : { kind: "peer", call: this.peer(p.shard, "abort", { txn: req.txn }) },
    }));
    return done({ ok: false, reason }, aborts);
  }

  /** 確定した取引を、自分と、ほかの参加者に適用させる。全員に届いたら、記録に印を付ける。 */
  private phase2Step(f: Phase2Frame): Step<void, Phase2Frame> {
    if (!f.local) {
      f.local = true;
      return wait(this.call("finalize", { req: { txn: f.txn, c: f.c } }));
    }
    if (!f.sent) {
      f.sent = true;
      const calls = f.shards.filter((shard) => shard !== this.id).map((shard) => this.peer(shard, "finalize", { txn: f.txn, c: f.c }));
      return wait({ kind: "peers", calls });
    }
    this.b.exec(`UPDATE __txn SET done = 1 WHERE txn = ?`, f.txn);
    return done(undefined);
  }

  private finalizeStep(f: SettleTxnFrame<{ txn: string; c: Ts; pieces?: Piece[] }>): Step<void, SettleTxnFrame<{ txn: string; c: Ts; pieces?: Piece[] }>> {
    const req = f.req;
    if (!f.arrived) {
      f.arrived = true;
      // いまは、どの piece もグループの全体なので、到着はグループの名前で確かめる。
      if (req.pieces) return wait(this.call("arrive", { groups: req.pieces.map((p) => p.g) }));
    }
    if (!f.queue) {
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
      f.queue = [...this.forwards(req.txn)];
    }
    const next = f.queue.shift();
    if (!next) return done(undefined);
    return wait({ kind: "peer", call: this.peer(next[0], "finalize", { txn: req.txn, c: req.c, pieces: next[1] }) });
  }

  private abortStep(f: SettleTxnFrame<{ txn: string; pieces?: Piece[] }>): Step<void, SettleTxnFrame<{ txn: string; pieces?: Piece[] }>> {
    const req = f.req;
    if (!f.arrived) {
      f.arrived = true;
      if (req.pieces) return wait(this.call("arrive", { groups: req.pieces.map((p) => p.g) }));
    }
    if (!f.queue) {
      this.releaseLocks(req.txn);
      for (const r of this.localIntents(req.txn)) {
        this.b.exec(`DELETE FROM __intents WHERE tbl = ? AND pk = ?`, r.tbl, r.pk);
        this.wakeAll(this.lockKey(r.tbl, r.pk));
      }
      f.queue = [...this.forwards(req.txn)];
    }
    const next = f.queue.shift();
    if (!next) return done(undefined);
    return wait({ kind: "peer", call: this.peer(next[0], "abort", { txn: req.txn, pieces: next[1] }) });
  }

  // ---- 手続き: anchor への照会 ----

  private queryTxnStep(f: TxnQueryFrame<{ txn: string; pushTo: Ts }>): Step<TxnStatus, TxnQueryFrame<{ txn: string; pushTo: Ts }>> {
    const req = f.req;
    if (f.waited) return done(this.decided(req.txn) ?? { status: "aborted" });
    const known = this.decided(req.txn);
    if (known) return done(known);
    const flight = this.inflight.get(req.txn);
    // push は c の決定前だけ受理する。決定後に受理しても c は動かず、読み手が intent を誤って無視する。
    if (flight && (!flight.decided || this.faults.pushAfterDecide)) {
      flight.pushed = Math.max(flight.pushed, req.pushTo);
      return done({ status: "pushed" });
    }
    if (flight) {
      f.waited = true;
      return wait({ kind: "flight", txn: req.txn }); // c の決定後は決着まで保留する。
    }
    // 記録がなく in-flight でもない。presumed abort を tombstone で確定させる。
    this.b.exec(`INSERT OR IGNORE INTO __txn(txn, status, done, at) VALUES (?, 'aborted', 1, ?)`, req.txn, this.deps.clock.now());
    return done(this.decided(req.txn)!);
  }

  private statusStep(f: TxnQueryFrame<{ txn: string }>): Step<TxnStatus, TxnQueryFrame<{ txn: string }>> {
    if (!f.waited) {
      f.waited = true;
      if (this.inflight.get(f.req.txn)) return wait({ kind: "flight", txn: f.req.txn });
    }
    return tail(this.call("queryTxn", { req: { txn: f.req.txn, pushTo: 0 } }));
  }

  // ---- 手続き: 保守 ----

  /**
   * alarm の本体。phase 2 の再駆動と、取り残された intent の掃除を行う。
   * 未完了の仕事が残っていれば true を返す。呼び出し側 (DO の alarm) は true なら次の alarm を予約する。
   * 参加者の intent は、anchor が再起動で決着を送り損ねると読み手が来るまで残る。残った intent は変更ログの GC を止めるので、
   * 読み手を待たずにここで決着させる。
   */
  private redriveStep(f: RedriveFrame): Step<boolean, RedriveFrame> {
    const errors = (f.errors ??= []);
    if (f.last) {
      if (!f.last.ok) {
        f.more = true;
        const e = f.last.error;
        if (errors.length < 10) errors.push(String((e as Error)?.message ?? e).slice(0, 160));
      }
      f.last = undefined;
    }
    const guarded = (effect: Effect) => wait(this.call("guarded", { effect }), "last");
    f.txns ??= this.b.exec(`SELECT txn, c, participants FROM __txn WHERE status = 'committed' AND done = 0`);
    const r = f.txns.shift();
    if (r) {
      const shards = JSON.parse(r.participants as string) as string[];
      return guarded(this.call("phase2", { txn: r.txn as string, c: r.c as Ts, shards }));
    }
    // 子として受け取っている移動と、受け取り終えたが move-end を記録させていない移動を、終えるまで進める (決めたこと 4)。
    f.moves ??= this.childMoves();
    f.at ??= 0;
    if (f.at < f.moves.length) return guarded({ kind: "move", epoch: f.moves[f.at++]! });
    if (!f.orphans) {
      // 進行中の取引の intent には触れない。anchor がまだ決着を送っている最中かもしれないからである。
      const cutoff = physicalToTs(this.deps.clock.now() - ORPHAN_AGE_MS);
      f.orphans = this.b.exec(`SELECT DISTINCT txn, anchor FROM __intents WHERE prepare_ts < ?`, cutoff) as unknown as Intent[];
    }
    const o = f.orphans.shift();
    if (o) return guarded(this.call("orphan", { anchor: o.anchor, txn: o.txn }));
    const left = this.b.exec(`SELECT (SELECT count(*) FROM __intents) + (SELECT count(*) FROM __txn WHERE status = 'committed' AND done = 0) n`)[0]?.n as number;
    this.lastRedriveErrors = errors;
    return done(Boolean(f.more) || left > 0 || this.childMoves().length > 0);
  }

  /** 待ち 1 つを実行し、失敗しても、結果として返す。 */
  private guardedStep(f: GuardedFrame): Step<Outcome<unknown>, GuardedFrame> {
    if (!f.out) return attempt(f.effect, "out");
    return done(f.out);
  }

  /** 手続きの表。殻は、名前で手続きを引いて走らせる。 */
  readonly programs: { [N in keyof Sig]: Program<ShardKernel, Sig[N][0], Sig[N][1]> } = {
    schema: { step: this.schemaStep },
    reach: { step: this.reachStep },
    apply: { step: this.applyStep, exit: this.applyExit },
    catchUp: { step: this.catchUpStep },
    prepared: { step: this.preparedStep },
    settleAll: { step: this.settleAllStep },
    arrive: { step: this.arriveStep },
    toEpoch: { step: this.toEpochStep },
    pull: { step: this.pullStep },
    groups: { step: this.groupsStep },
    finishMove: { step: this.finishMoveStep },
    fetch: { step: this.fetchStep },
    receive: { step: this.receiveStep },
    drain: { step: this.drainStep },
    move: { step: this.moveStep },
    foreignLocks: { step: this.foreignLocksStep },
    locked: { step: this.lockedStep, exit: this.lockedExit },
    settle: { step: this.settleStep },
    exec: { step: this.execStep },
    execAuto: { step: this.autoStep, exit: this.autoExit },
    direct: { step: this.directStep, exit: this.autoExit },
    commitLocal: { step: this.commitLocalStep },
    prepare: { step: this.prepareStep },
    unchanged: { step: this.unchangedStep },
    syncSchema: { step: this.syncSchemaStep },
    commit: { step: this.commitStep, exit: this.commitExit },
    drive: { step: this.driveStep },
    phase2: { step: this.phase2Step },
    finalize: { step: this.finalizeStep },
    abort: { step: this.abortStep },
    queryTxn: { step: this.queryTxnStep },
    status: { step: this.statusStep },
    redrive: { step: this.redriveStep },
    guarded: { step: this.guardedStep },
    orphan: { step: this.orphanStep },
  };

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
