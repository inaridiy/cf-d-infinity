import type {
  Change, CommitRes, Dep, ExecReq, ExecRes, GlobalIndexDef, LockOwner, Row, ShardApi, Span, TableDef, Ts, Value,
} from "../types";
import { ConflictError, MAX_WRITE_SET_BYTES, ReadTooOld, SqlError, isTableLocked, isWideSpan, isWriteOutsideClaim, tableLockOf, utf8Length } from "../types";
import { CAPTURE_TABLES, capturedChanges, captureDdl, decode, encode, encodeKey, imageAt, imageStatements, joinTerms, pkValues, q, scanList, tupleOfRow } from "../shard/rows";
import { decodeReturned, typedReadSql, type Tuple } from "../value";
import { DDL_WAIT_MS, type Catalog, type Prepared } from "../meta";
import { ALL_OBJECTS, objectKey, type Move, type OpenMove } from "../catalog";
import { hashKey, ownerOf, regionsOf, shardsOf, type Interval, type Routing } from "../routing";
import { type Runtime, sleep, systemRuntime } from "../runtime";
import { ident, parseStatements, text, type Node, type Params } from "../sql/cst";
import { keyString } from "../keys";
import { sha256Text } from "../sha256";
import { SHARD_LIMITS, builtLimitOf, isShardLimit, withinShardLimits } from "../shard-limits";
import { scanColumns, scanFits, SCHEMA_STATEMENTS, findTable, fullScan, planStatement, type Plan, type PlanContext, type Reference, type Route, type Scan, type WriteTarget } from "../sql/plan";
import { sqlJs } from "../sql/scratch";
import { initStoredValue, storedValueReady } from "../sql/stored";
import { parseDdl, type DdlMode, type ParsedDdl } from "../sql/ddl";
import { openScratch, ScratchDb, type Compiled } from "../sql/scratch";
import { groupSpan, rowSpan, scanSpans, statementSpans, tableSpan } from "./spans";
import { rowsOut } from "./results";

export interface Cluster {
  shard(id: string): ShardApi;
  catalog(): Promise<Catalog>;
  /**
   * 表定義の epoch が schema だったときの表定義に、いまの範囲表を合わせたスナップショット (meta.ts の catalogAt)。接続をまたぐ取引を、
   * その取引の表定義で組み立て直すのに使う (Txn.load)。
   */
  catalogAt(schema: number): Promise<Catalog>;
  /**
   * 表定義の遷移を開く (meta.ts の prepare)。basedOn は、呼び出し側が文を解釈した表定義の epoch で、最新と違えば `schema moved` で
   * 断られる。guard は、取引が読んだ表の DROP で、その取引が読んだ表である。waitUntil は、DDL の待ちの期限 (この Worker の時計の時刻)。
   */
  prepare(sql: string, opts: { guard?: string[]; waitUntil?: number }, basedOn?: number): Promise<Prepared>;
  /** 遷移を確定する。acks は prepared に ok と答えたシャード、at は index を公開する commit が運ぶ時刻 (meta.ts の commit)。 */
  commit(epoch: number, acks: string[], at?: Ts): Promise<Catalog>;
  /**
   * 遷移を取り消す。もう取り消されていれば (期限切れか、取り消させる手)、記録した理由を返す。wound は、fence の表の行ロックを持つ取引が
   * 取り消させる手である。答えの wound は、記録された abort がその手のものか、である。
   */
  abort(epoch: number, reason: string, wound?: boolean): Promise<{ reason: string; wound: boolean }>;
  /** 開いている遷移の期限を延ばす。epoch は prepare の epoch。期限の長さを返す。 */
  renew(epoch: number): Promise<{ leaseMs: number }>;
  /**
   * 範囲の移動を開く (meta.ts の startMove。move-start を記録する)。同じ移動がもう開いていれば、その epoch を返す。表定義の遷移が
   * 開いていれば `schema busy`、重なる移動が開いていれば `split busy` で断られる。
   */
  startMove(move: Move): Promise<{ epoch: number; routing: Routing }>;
  /** 開いている移動 (move-start の後、move-end の前)。 */
  moves(): Promise<OpenMove[]>;
  allocate(table: string, n: number, min?: number): Promise<number>;
  /** 実時間、待ち、乱数、識別子の出どころ。なければ実物を使う。シミュレータのクラスタは、seed から決まる実装を持つ。 */
  runtime?: Runtime;
  /** このクラスタへつなぐ Db の、基準経路だけで実行する指定の既定。試験が使う。 */
  reference?: Reference;
  /** このクラスタへつなぐ Db の、欠陥を再導入するスイッチの既定。検査が欠陥を見つけるかを測る試験だけが使う。 */
  clientFaults?: ClientFaults;
}

/** Worker の側の欠陥を再導入するスイッチ (シャードの側は types.ts の Faults)。検査が欠陥を見つけることを確かめる試験だけが使う。 */
export interface ClientFaults {
  /**
   * 2PC の ID に、続きの中身の指紋を付けず、取引の ID をそのまま使う (specs/m17_txn_id_reuse.qnt の m17_red_impl)。同じ baton の
   * 2 つの続きが 1 つの 2PC に混ざり、確定と答えた書き込みが消える。
   */
  commitIdIsTxn?: boolean;
  /** 書き出した取引を組み立て直すとき、表定義が変わっていても、新しい版を名乗らせる (モデル m13_red_repin)。 */
  repinOnRestore?: boolean;
  /** DDL を実行した batch も、競合したら頭からやり直す (モデル m13_red_retry_whole)。 */
  replayAcrossSchemaChange?: boolean;
  /** 取引が読んだ表を、書き込みを止めず、確かめずに DROP する (2026-11 までの挙動。モデル m14_red_no_lock と m14_red_no_check)。 */
  dropWithoutGuard?: boolean;
  /** 取引の中の DDL が、開いている取引を先に確定しない。取引の版はそのままである (モデル m13_red_pin_only)。 */
  noImplicitCommit?: boolean;
  /** 取引の中の DDL が、先の確定に失敗しても実行される (モデル m13_red_ddl_anyway)。 */
  ddlAfterFailedCommit?: boolean;
  /** 既存の行から作る index を、行を読んで項目を書く前に commit する (モデル m11_red_early_public、M21 の m21_red_early_commit)。 */
  publishBeforeBackfill?: boolean;
  /**
   * 表定義の遷移の確かめ (index の作成の行の走査、試し、取引が読んだ表の DROP の前の unchanged) を、シャードが prepare を適用する前に
   * 行う (M21 の m21_red_scan_early、m21_red_trial_early、m21_red_drop_check_early。段 3 まではあった scanBeforeLock の意味を広げた)。
   * 走査と unchanged は prepare の前の表定義の epoch を名乗り、試しは列を適用しないシャードで行う。prepared の ok は、その後で集める。
   */
  checkBeforePrepare?: boolean;
  /**
   * 1 つのシャード (範囲表の最後のシャード) の prepared を待たずに commit を記録させる (M21 の m21_red_early_commit、_trial_missing_ack、
   * _drop_missing_ack)。Meta の側の同じ名前のスイッチ (types.ts の Faults) と組で、Meta は ok の集合を確かめない。
   */
  commitWithoutAcks?: boolean;
  /** 既存の行から index を作るとき、行のないシャードの時計を公開の時刻に入れない (モデル m12_clock_red_skip_empty、M21 の m21_clock_red_skip_empty)。 */
  scanSkipsEmpty?: boolean;
  /** 取引が読んだ表を DROP する前の確認を、どのシャードでも、読んだ時刻ではなく確定の時刻から行う (モデル m14_red_commit_ts、M21 の m21_guard_red_commit_ts)。 */
  guardFromCommitTs?: boolean;
  /** 読みだけの取引は、ロックを取って最新を読んだ範囲があっても、COMMIT で検証せずにロックを手放して終える (モデル m9_red_ro_skip)。 */
  lockedReadsSkipValidation?: boolean;
  /** 同じ行への 2 回目の DML で、書き込みの since を 2 回目の F にする (モデル m9_red_second_f。守りの 1 つ目、Txn.buffer の min)。 */
  secondDmlNewSince?: boolean;
  /** 後の DML が同じ範囲を記録すると、前の DML が F で記録した範囲を捨てる (モデル m9_red_second_f。守りの 2 つ目、最初の F の範囲)。 */
  secondDmlNewSpanSince?: boolean;
  /**
   * どの要求も、表定義の全体 (どれかの DDL が最後に確定した epoch) に頼る (段 3 の形を、commit だけで進めたもの。M24 の m24_red_global と
   * m24_red_global_commit_only)。関係のない表の DDL が確定すると、開いている取引が全部古くなる。
   */
  globalSchemaEpoch?: boolean;
  /** view を名指す文の要求が、view にだけ頼り、その元の表に頼らない (M24 の m24_red_view)。元の表を作り直した後も、古い計画の読みが通る。 */
  viewDepsOnly?: boolean;
  /**
   * 書き込みの要求と、書いた取引の COMMIT が、書く表にだけ頼り、文が読んだ表に頼らない (M24 の m24_red_read_deps)。読んだ表の形が
   * 変わった後も、古い計画の書き込みが通る。
   */
  writeDepsOnlyWritten?: boolean;
  /**
   * 表定義の全体の epoch が変わっていたら、取引を続けさせない (段 3 の形。M24 の m24_red_global の Worker の側)。接続をまたぐ取引を
   * 組み立て直すときに失敗させ (Txn.load)、範囲の移動で断られた文の範囲表を取り替えない (Txn.reroute)。
   */
  doomOnSchemaChange?: boolean;
  /**
   * 行ロックを持つ取引の文が、その表の書き込み禁止に当たっても、DDL を取り消させず、禁止が解けるのを待つ (M24 の m24_lock_red_no_wound、
   * m24_retry_red_no_wound)。DDL は、取引のほかのシャードの行ロックを待っているので、取引の文は、DDL の待ちの期限まで待たされる。
   */
  noWound?: boolean;
  /**
   * DDL を進める側が、ロックを持つ取引に取り消させられた DDL を、やり直さない (やり直しを入れる前の形。M24 の m24_retry_red_no_retry)。
   * 取引の行が 2 つのシャードにあると DDL が失敗し、1 つのシャードにあると通る。
   */
  noRetryAfterWound?: boolean;
  /** 取り消させられた DDL をやり直すたびに、DDL の待ちの期限を数え直す (M24 の m24_retry_red_restart)。DDL が、始めてから 5 秒を過ぎても終わらない。 */
  retryRestartsBudget?: boolean;
  /**
   * 取り消させられた DDL のやり直しが、取り消された試みで集めた ok を使い続ける (M24 の m24_retry_red_same_epoch)。その ok を答えた
   * シャードには、やり直しの prepare を適用させない。そのシャードの確かめ (CHECK の試し) は、取引がその後に書いた行を見ていない。
   */
  retrySameEpoch?: boolean;
}

/** 要求には載せない、要求が頼るものの材料 (depsOf)。 */
export interface Reliance {
  /** 書き込みの epoch で頼る表。要求が書く表と、文が INDEXED BY で index を名指す表。 */
  write?: readonly string[];
  /** 文が名指す view (view を通して読む view も)。 */
  views?: readonly string[];
}

/**
 * 要求が頼る表定義のもの (ExecReq.deps。docs/design-catalog-epoch.md の「表ごとの epoch」の「規則」)。要求の範囲と書き込みが名指す表と、
 * 文が名指す view を、要求を計画したスナップショット cat の epoch で運ぶ。書く表と、index を名指す表は書き込みの epoch、ほかは読みの
 * epoch である。view を通る読みは、走査の範囲が元の表を名指すので、元の表にも頼る。
 * スナップショットが知らない名前 (どの表を読むか分からない範囲の "*") は、表定義の全体に頼る。
 */
export function depsOf(cat: Catalog, faults: ClientFaults, spans: readonly Span[], rely: Reliance = {}, writes: readonly Pick<Change, "table">[] = []): Dep[] {
  const write = new Set<string>();
  for (const t of rely.write ?? []) write.add(objectKey(t));
  for (const w of writes) write.add(objectKey(w.table));
  const views = new Set((rely.views ?? []).map(objectKey));
  const tables = new Set<string>();
  // 欠陥のスイッチ viewDepsOnly: view を名指す文は、元の表に頼らない。writeDepsOnlyWritten: 書く要求は、読む表に頼らない。
  if (!(faults.viewDepsOnly && views.size > 0) && !(faults.writeDepsOnlyWritten && write.size > 0)) for (const s of spans) tables.add(objectKey(s.table));
  for (const t of write) tables.add(t);
  const out: Dep[] = [];
  let all = faults.globalSchemaEpoch === true;
  for (const name of tables) {
    const o = cat.objects[name];
    if (!o || name === ALL_OBJECTS) all = true;
    else out.push(write.has(name) ? { name, epoch: o.write, write: true } : { name, epoch: o.read });
  }
  for (const name of views) {
    const o = cat.objects[name];
    if (!o) all = true;
    else if (!tables.has(name)) out.push({ name, epoch: o.read });
  }
  if (all) out.push({ name: ALL_OBJECTS, epoch: cat.schema });
  return out;
}

/** 取引の表定義 (cat) に、新しいスナップショット (fresh) の範囲表と、その epoch を合わせる。表定義と、ものの epoch は、取引のままである。 */
function withRouting(cat: Catalog, fresh: Catalog): Catalog {
  const { open: _o, aborted: _a, ...kept } = cat;
  return {
    ...kept, routing: fresh.routing, epoch: fresh.epoch,
    ...(fresh.open ? { open: fresh.open } : {}), ...(fresh.aborted ? { aborted: fresh.aborted } : {}),
  };
}

/** シャードへ送る文の、Worker が決める部分。時点、因果トークン、頼るもの、epoch、overlay は、送るときに足す。rely は送らない。 */
type Outgoing = Omit<ExecReq, "T" | "minTs" | "deps" | "epoch" | "overlay"> & { rely?: Reliance };

/**
 * 取引が、あるシャードで読んだ範囲と、その時刻。表を消す前の確認に使う (Db.changeSchema の mode guard)。
 * from は、そのシャードがこの範囲の変更を確かめてよい最初の時刻である。読んだ時刻、ただし同じ取引がそこへ書いたなら確定の時刻。
 * どちらも、そのシャードが見た時刻である (読みの要求が運ぶ時刻、確定の phase 2 が運ぶ時刻)。
 */
export interface ReadRecord {
  shard: string;
  spans: Span[];
  from: Ts;
}

/** 表定義を変える文を含むか。読めない文は、含まないものとして扱う (実行すれば、その誤りが返る)。 */
export function changesSchema(sql: string): boolean {
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

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

export class QueryResult {
  constructor(
    readonly columns: string[],
    /** 型のある値 (bigint は INTEGER、number は REAL)。Hrana と Worker の中の計算が使う。 */
    readonly values: Value[][],
    readonly changes = 0,
    readonly lastInsertRowid: bigint | null = null,
    /** 読み取りの T、または autocommit の commit 時刻。 */
    readonly ts?: Ts,
  ) {}
  /**
   * 列名で引ける行。同名の列は後の列が勝つ。値は D1 と同じ形で、INTEGER は JS の数である (src/client/results.ts の intMode "number"。
   * JS の数で正確に表せない INTEGER は誤りにする)。入口は、利用者の選んだ intMode で rowsOut を呼ぶ。
   */
  get rows(): Row[] {
    return rowsOut(this.columns, this.values, "number");
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

/**
 * 範囲の移動による拒否か (シャードの NotOwner)。表定義が古いという拒否 (`not owner: stale schema`) は含めない。範囲表を取り直して
 * 計画し直せば通り得るのは、こちらだけである。
 */
const isRouteRefusal = (e: unknown): boolean => {
  const m = (e as Error)?.message ?? "";
  return /^not owner: /.test(m) && !/^not owner: stale schema/.test(m);
};

/** 区間 x の全体が、区間の組 parts (重ならない) の和に入るか。 */
function covered(x: Interval, parts: Interval[]): boolean {
  let at = x.start;
  for (const p of [...parts].sort((a, b) => a.start - b.start)) {
    if (p.end <= at) continue;
    if (p.start > at) return false;
    at = p.end;
    if (at >= x.end) return true;
  }
  return false;
}

/** 1 回の採番 (Db.nextId)。終わりが end のブロックから、first から n 個を取った。戻したら returned を付ける。 */
interface Allocation {
  table: string;
  first: number;
  n: number;
  end: number;
  returned?: true;
}

/**
 * 文の 1 回の試みが採番した番号 (計画書の未解決の問題 50。不変条件: 採番した rowid は、どの接続にも 1 度しか配らない)。
 * 試みを捨てるか、試みが失敗すると、Db.giveBack がこの番号を戻す (SQLite も、失敗した INSERT の rowid を使わない)。
 * 戻すのは、ブロックの次の番号が、まだその採番の直後にあるときだけである。同じブロックを共有する別の接続 (worker.ts の sharedIds) が
 * 後から取っていれば、戻さずに飛ばす。前は、試みの前のブロックの控えに戻していたので、その間に別の接続が取った番号を、もう一度配った。
 * 入れ子の試み (計画の途中の読み、INSERT … SELECT が分けた文、取引として計画し直した文) の採番は、外の試みの控えにも入る。
 * 外の試みが失敗すれば、中の試みが採番して使わなかった番号も戻せる。1 つの採番は 1 度しか戻さない (returned)。
 */
export class Taken {
  readonly list: Allocation[] = [];
  constructor(private readonly outer: Taken | null = null) {}
  add(a: Allocation): void {
    this.list.push(a);
    this.outer?.add(a);
  }
}

/**
 * 文の結果の lastInsertRowid (docs/sql-language.md の「lastInsertRowid」、計画書の未解決の問題 46)。文が最後に入れた行の rowid で、
 * 行を入れなかった文は null である。どの経路の結果も、ここだけで決める。
 * inserted は、文が入れた行を、SQLite が入れた順に並べたものである。文を実行した SQLite の捕捉が記録する (シャードの ExecRes.inserted、
 * Worker の SQLite の rows.ts の capturedChanges)。REPLACE で入れ直した行は入り、UPSERT の DO UPDATE で更新した行と、OR IGNORE が
 * 入れなかった行は入らない。SQLite の last_insert_rowid と同じである。
 * 前は経路ごとに数えていた。基準経路は Worker の SQLite の last_insert_rowid() を読み、捕捉の印の INSERT の rowid (1) や、TEXT の
 * 主キーの表の隠れた rowid を返した。シャードへ送る経路は、計画が VALUES の最後の行の rowid を返し、DO UPDATE で更新しただけの行も
 * 入れたことにした。利用者が明示した rowid 0 は null にしていた。
 * rowid が行のキーでない表 (INTEGER PRIMARY KEY でない主キーの表) の行は、rowid を返さない。D∞ の行は、そういう rowid を持たない。
 */
export function lastInsertRowid(cat: Catalog, inserted: readonly Pick<Change, "table" | "pk">[]): bigint | null {
  const last = inserted.at(-1);
  if (!last) return null;
  const def = cat.tables[last.table];
  if (!def || (def.rowidAlias === null && !def.implicitRowid)) return null;
  const id = pkValues(last.pk)[0];
  return typeof id === "bigint" ? id : null;
}

/**
 * 宛先ごとに分けて実行した文の、入れた行を、文の VALUES の順に並べる (lastInsertRowid に渡す)。宛先の中の順は、そのシャードの
 * SQLite が入れた順である。宛先の VALUES の行 (WriteTarget.rows) に、入れた行を前から当てて、VALUES の中の位置を知る。
 * 同じ主キーの行が 2 つあれば (OR IGNORE が 2 つ目を入れない)、先の行に当てる。行を知らない宛先 (UPDATE、DELETE) は、送った順に並べる。
 */
function valuesOrder(parts: readonly { rows?: WriteTarget["rows"]; inserted: readonly Pick<Change, "table" | "pk">[] }[]): Pick<Change, "table" | "pk">[] {
  const placed: { at: number; seq: number; row: Pick<Change, "table" | "pk"> }[] = [];
  for (const part of parts) {
    const rows = part.rows ?? [];
    let j = 0;
    for (const row of part.inserted) {
      let k = j;
      while (k < rows.length && rows[k]!.pk !== row.pk) k++;
      // 当たる行がなければ (行を知らない宛先)、後ろに置き、次の行は同じ位置から探す。
      const at = k < rows.length ? rows[k]!.at : Number.MAX_SAFE_INTEGER;
      if (k < rows.length) j = k + 1;
      placed.push({ at, seq: placed.length, row });
    }
  }
  return placed.sort((x, y) => x.at - y.at || x.seq - y.seq).map((x) => x.row);
}

/**
 * 確定が断られた理由を、呼び出し側へ返す誤りにする。1 シャードの確定 (commitLocal) が返す理由も、anchor が参加者の prepare の
 * 拒否を運んできた理由も、ここを通す。やり直して通り得る理由だけを競合 (ConflictError) にする。
 *   unique             UNIQUE の違反。SQLite と同じ誤りにする。
 *   write outside claim シャードの書き込みの守りの拒否 (src/types.ts の WriteOutsideClaim)。要求の作り方の誤りで、やり直しても同じ変更を
 *                      送るので、また断られる。前は競合として、Db.transaction が上限までやり直した (test/prepare-refusal-not-retried.test.ts)。
 */
function commitRefusal(reason: string): Error {
  if (reason.startsWith("unique")) return new SqlError(`UNIQUE constraint failed (${reason})`);
  if (isWriteOutsideClaim(new Error(reason))) return new SqlError(reason);
  return new ConflictError(reason);
}

/** 悲観的な取引が、書いた行のロックを取るために送る読み (Txn.lockWritten)。行を読まない。 */
const LOCK_SQL = `SELECT NULL AS "locked" WHERE 0`;

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
 * 表定義の変更が終わるのを待つ時間。表定義の遷移の prepare から commit か abort までは、fence の表への書き込みと、ほかの表定義の変更が待つ。
 * 進める側が止まれば、期限 (meta.ts の LEASE_MS、既定 5 秒) のうちに abort されて書ける。進める側が動き続けている間は、
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

/**
 * シャードが DO の SQLite の上限で断った文 (src/shard-limits.ts) は、基準経路で実行し直す。上限に当たるかは、行がシャードに
 * どう分かれているかで変わるので、断ると成否が置き場所で決まる (計画書の不変条件 13)。シャードは何も読まず書かずに断るので、
 * 読んだ範囲も取引の変更も残らない。それ以外の誤りはそのまま投げる。
 */
/** 行の変更の大きさ (取引の大きさの上限で数える単位)。同じ変更を何度も数えないように覚えておく。 */
const changeSizes = new WeakMap<Change, number>();
const changeBytes = (c: Change): number => {
  let n = changeSizes.get(c);
  if (n === undefined) changeSizes.set(c, (n = utf8Length(encode(c))));
  return n;
};

const rerouted = (e: unknown): never => {
  throw isShardLimit(e) ? new NeedsReference((e as Error).message) : e;
};

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
  // プランナは、値が列に入ったときの値を Worker の SQLite に尋ねる (src/sql/stored.ts)。その SQLite は、sql.js と一緒に、isolate に
  // 1 度だけ開く。開いた後は待たない (待ちを足すと、並行する文の RPC の順序が変わる)。
  if (!storedValueReady()) await initStoredValue(sqlJs());
  try {
    const p = await planStatement(stmt, params, cat, ctx);
    seen?.(p);
    return await run(p);
  } catch (e) {
    if (!(e instanceof NeedsReference)) throw e;
    const p = await planStatement(parseStatements(source)[0], params, cat, { ...ctx, reference: "scans" });
    seen?.(p);
    try {
      return await run(p);
    } catch (again) {
      // 基準経路の走査は、作りとして上限に収まる (Scan を作るプランナが確かめる)。ここに来れば、それが崩れている。
      if (again instanceof NeedsReference) throw new SqlError(`the reference path sent a shard a statement over its limits (${again.message}); please report this`);
      throw again;
    }
  }
}

/** 集めた行の、`表名\0主キー` の形のキー。行の順に返す。主キーの列が走査の結果になければ、空を返す。 */
function keysOf(l: Loaded): string[] {
  const at = l.table.pk.map((c) => l.columns.indexOf(c));
  if (at.some((i) => i < 0)) return [];
  return l.rows.map((row) => `${l.table.name}\0${keyString(at.map((i) => row[i] ?? null))}`);
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
/** 取引の 1 文が、範囲の移動で断られて範囲表を取り替え、計画し直す回数の上限 (Txn.reroute)。 */
const REROUTES = 3;
/** 1 文が、表への書き込みを止めている遷移が閉じるのを待って、やり直す回数の上限。 */
const LOCK_WAITS = 4;

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
 * shard key を絞らない span に、この範囲表で宛先のシャードが持つ範囲 (claim) を付ける。
 * 全表の読みは範囲表の全シャードへ送るが、範囲表が古いと、分割で生まれたシャードには送らない。
 * 親は自分に残った行だけを答えるので、範囲を付けないと、子へ移った行が黙って欠ける。
 * shard key で絞る span には、まだ付けない。区間の境目を shard key のブロックの中に置くようになったら、付ける
 * (docs/design-subslots.md の「宛先と claim」)。
 */
function withClaims(routing: Routing, shard: string, spans: Span[]): Span[] {
  if (!spans.some(isWideSpan)) return spans;
  const claim = regionsOf(routing, shard);
  return spans.map((s) => (isWideSpan(s) ? { ...s, claim } : s));
}

/** 1 回の読み取りで Worker へ集める行の上限。メモリからの推定で、本番で調整する。 */
export const ROW_BUDGET = 200_000;
/**
 * 1 文で Worker へ集めてよいバイト数の合計。isolate のメモリは 128 MB で、集めた行は wasm の SQLite にも入る。
 * 1 つのシャードが 1 回で返せる大きさ (SHARD_LIMITS.resultBytes) を超えない。超えると、行が 1 つのシャードに偏ったときだけ、
 * 予算の内側の結果を集められない (計画書の不変条件 13)。
 */
export const BYTE_BUDGET = SHARD_LIMITS.resultBytes;

/** 読み取りのコンテキスト。autocommit と Txn で実行経路を共有する。 */
class ReadScope {
  T: Ts | undefined;
  /** 取引でない読み取りは、開始前に確定した書き込みを必ず見る。取引は自分のスナップショットを読み続ける。 */
  protected realtime = true;
  constructor(protected db: Db, protected cat: Catalog) {}

  protected overlay(_shard: string, _spans?: readonly Span[]): Change[] {
    return [];
  }
  protected record(_shard: string, _spans: Span[], _views?: readonly string[]): void {}

  /** 読みを 1 つ送る。autocommit の読みは T を進めないので、新しい確定を知らせてもらわない (fresh なし)。 */
  call(shard: string, req: Outgoing): Promise<ExecRes> {
    return this.send(shard, req, { T: this.T, fresh: false });
  }

  /**
   * 要求を、時点 at.T で送る。at.fresh なら、範囲に at.T より新しい確定があるとき、シャードは読まずに `read too old: moved at` で
   * 答える。答えの判断は、この要求が運んだ at だけで行う (Txn.call)。
   */
  protected async send(shard: string, req: Outgoing, at: { T: Ts | undefined; fresh: boolean }): Promise<ExecRes> {
    const spans = withClaims(this.cat.routing, shard, req.spans);
    const { rely, ...wire } = req;
    const full: ExecReq = {
      ...wire, spans, T: at.T, minTs: this.db.token, deps: depsOf(this.cat, this.db.faults, spans, rely), epoch: this.cat.epoch, overlay: this.overlay(shard, spans),
      fresh: at.fresh, realtime: this.realtime,
    };
    const res = await this.db.shardOf(shard).exec(full).catch(rerouted);
    this.T ??= res.T;
    this.db.observe(res.hlc);
    this.record(shard, spans, rely?.views);
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

  protected async shardRead(p: Extract<Plan, { kind: "shard" }>, t: Target, maxBytes?: number): Promise<ExecRes> {
    const { tables, columns } = await this.db.shapeOf(p.sql, this.cat, p.tables, false);
    return this.call(t.shard, {
      sql: p.sql, params: p.params, columns, spans: statementSpans({ tables, sks: t.sks, pk: p.pk, write: false }),
      ...(maxBytes === undefined ? {} : { maxBytes, budgeted: true }),
      // INDEXED BY で index を名指す表には、書き込みの epoch で頼る。index が消えた後で古い計画のまま届くと、シャードの SQLite が断る。
      ...(p.indexed ? { rely: { write: p.indexed } } : {}),
    });
  }

  /** 文 1 つが集めてよいバイト数の合計。 */
  protected byteBudget(): number {
    return Math.min(this.db.byteBudget, SHARD_LIMITS.resultBytes);
  }

  /**
   * 複数のシャードから、合わせて budget バイトまでの結果を読む。
   *
   * 予算は、まず対象のシャードで等分する。溢れたシャードにだけ、ほかのシャードが使わなかった分を配り直して読み直す。
   * 1 回ごとに、少なくとも 1 つのシャードが読み終わるか (溢れたシャードの合計が残りの予算以下なら、平均以下のシャードがある)、
   * 溢れたシャード全部が取り分を超えて合計が予算を超えたと分かる。だから成否は結果の合計の大きさだけで決まり、行がどの
   * シャードに偏っているかでは変わらない (計画書の不変条件 13)。等分だけでは、同じ結果が偏った置き場所でだけ断られた
   * (2026-11-13 の README の確認の指摘 2)。読み直しは同じ時点 T で読むので、答えは 1 回で読んだときと同じである。
   * 届いている途中の行は、合計で予算と、シャードごとの 1 行の超過を超えない。
   */
  protected async budgeted(targets: Target[], budget: number, read: (t: Target, maxBytes: number) => Promise<ExecRes>): Promise<{ parts: ExecRes[]; bytes: number }> {
    const done = new Map<Target, ExecRes>();
    let pending = targets;
    let left = budget;
    while (pending.length > 0) {
      const share = Math.floor(left / pending.length);
      const res = await Promise.all(pending.map((t) => read(t, share)));
      const over = pending.filter((_t, i) => res[i]!.over);
      res.forEach((r, i) => {
        if (r.over) return;
        done.set(pending[i]!, r);
        left -= r.bytes ?? 0;
      });
      if (over.length === pending.length) {
        throw new SqlError(`result too large: the statement reads more than ${budget} bytes; narrow the query or select fewer columns`);
      }
      pending = over;
    }
    return { parts: targets.map((t) => done.get(t)!), bytes: budget - left };
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

  /**
   * 走査を実行して行を返す。集める行は、合わせて budget バイトまでである (budgeted)。rely は、走査の要求が、範囲の表のほかに頼るもの
   * (元の文が名指す view、書き込みの文が書く表) である。
   */
  protected async scan(s: Scan, budget = this.byteBudget(), rely?: Reliance): Promise<{ columns: string[]; rows: Value[][]; bytes: number }> {
    const targets = await this.resolve(s.sks ? { by: "sk", sks: s.sks } : { by: "all" });
    if (targets.length === 0) return { columns: [], rows: [], bytes: 0 };
    await this.pickT(targets.map((t) => t.shard));
    // 上限はシャードの側で打ち切らせる。全行が届いてから数えると、数える前に Worker のメモリが尽きる。
    // シャードは走査を型つきの読みで返すので、集めた行は型のある値である。Worker の SQLite に、そのまま入れ直せる。
    const { parts, bytes } = await this.budgeted(targets, budget, (t, maxBytes) =>
      this.call(t.shard, {
        sql: s.sql, params: s.params, columns: s.columns, spans: scanSpans(s, t.sks), maxRows: this.db.rowBudget, maxBytes, budgeted: true,
        ...(rely ? { rely } : {}),
      }),
    );
    return { columns: s.columns, rows: parts.flatMap((r) => r.values), bytes };
  }

  /**
   * 走査を実行して、行を集める。sql が実際に開く表は本物のプランナに尋ね、走査にない表は全行を読み足す。
   * 走査の要求は、sql が名指す view にも頼る (view を通る読みは、view と、その元の表に頼る)。write は、sql が書く表である。
   */
  protected async collect(planned: Scan[], sql: string, write?: readonly string[]): Promise<Loaded[]> {
    const seen = await this.db.compiled(sql, this.cat);
    const used = seen.read;
    const rely: Reliance | undefined = seen.views.length > 0 || write ? { ...(seen.views.length > 0 ? { views: seen.views } : {}), ...(write ? { write } : {}) } : undefined;
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
    // バイト数の予算は文全体で 1 つである。走査ごとに、残りを渡す。
    let bytesLeft = this.byteBudget();
    for (const s of scans) {
      const { columns, rows, bytes } = await this.scan(s, bytesLeft, rely);
      bytesLeft -= bytes;
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
          // 結果を返す文は、型ごと正確に読む (ScratchDb.select)。PRAGMA と EXPLAIN は包めないので、素の列で読む。
          const r = p.pragma ? w.pragma(p.sql, p.params) : w.select(p.sql, p.params);
          return new QueryResult(r.columns, r.values, 0, null, this.T);
        } finally {
          w.close();
        }
      }
      case "shard": {
        const targets = await this.resolve(p.route);
        await this.pickT(targets.map((t) => t.shard));
        // DO の SQLite の上限に当たる文は、シャードが断り、call が基準経路への切り替えにする (src/shard-limits.ts)。
        // 結果の大きさは、集める読みと同じ予算の合計で決める (budgeted)。
        const { parts } = await this.budgeted(targets, this.byteBudget(), (t, maxBytes) => this.shardRead(p, t, maxBytes));
        return new QueryResult(parts[0]!.columns, parts.flatMap((r) => r.values), 0, null, this.T);
      }
      case "gather": {
        const w = await this.gather(p.scans, p.sql);
        try {
          const r = w.select(p.sql, p.params);
          return new QueryResult(r.columns, r.values, 0, null, this.T);
        } finally {
          w.close();
        }
      }
      case "partial": {
        // 部分の集約は、型のない __p の表へ入れて計算し直す。走査は型つきで読むので、整数の値の REAL も REAL のまま入る。
        const { rows } = await this.scan(p.scan);
        const w = await openScratch({ ddl: [] });
        try {
          w.exec(`CREATE TABLE "__p" (${p.columns.map(q).join(", ")})`);
          w.load("__p", p.columns, rows);
          const r = w.select(p.mergeSql, p.mergeParams);
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
  /**
   * 取引が文を計画した表定義を名指す epoch (Txn.catalog の Catalog.schema。どれかの DDL が最後に確定した epoch)。組み立て直す側は、
   * Meta の列をこの epoch まで畳んだ表定義で、取引を続ける (Txn.load)。
   */
  schema: number;
  /** シャードごとの、取引の文が名指した view。COMMIT の要求が、それにも頼る。 */
  views?: [string, string[]][];
  /** 取引が行ロックを取った表と、行ロックを持ち得るシャード (Txn.lockTables、Txn.lockShards)。 */
  locks?: { tables: string[]; shards: string[] };
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
  /**
   * これから送る読みに、新しい確定を知らせてもらうか (ExecReq.fresh)。T を進められなかったら (advance)、以後はスナップショットのまま
   * 読み続けるので、付けない。送った読みの答えは、この値ではなく、その読みが運んだ値で判断する (call)。
   */
  private wantsFresh = true;
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
  /** シャードごとの、取引の文が名指した view。そのシャードの読みは、view にも頼る。COMMIT の要求が運ぶ。 */
  private views = new Map<string, Set<string>>();
  /**
   * 取引が行ロックを取った表 (小文字の名前) と、取引が行ロックを持ち得るシャード。悲観の取引の、ロックを取る文 (書き込みと、行ロックを
   * 取る読み) が足す。書き込み禁止で断られて、シャードからロックを与えられた文 (M24 の HOLD) も、そのシャードを足す。その文は、範囲を
   * 記録しないので、ここにだけ残る。ROLLBACK は、このシャードのロックも放す (unlockAll)。
   */
  private lockTables = new Set<string>();
  private lockShards = new Set<string>();
  constructor(db: Db, cat: Catalog, private id: string) {
    super(db, cat);
  }

  private get txnId(): string {
    return this.id;
  }

  /**
   * 取引が溜めた、このシャード宛の変更。spans を渡すと、その範囲が名指す表の変更だけを返す (文に付けて送る overlay)。文は、範囲の外の
   * 行に依らないので、ほかの表の変更は要らない。要求が頼るのは、範囲の表だけである (depsOf)。ほかの表の変更まで送ると、その表の形が
   * ほかの接続の DDL で変わった後に、古い形の行イメージが、頼ると名乗っていない表へ適用される。
   */
  protected override overlay(shard: string, spans?: readonly Span[]): Change[] {
    const all = [...(this.writes.get(shard)?.values() ?? [])];
    if (!spans || all.length === 0 || spans.some((s) => s.table === ALL_OBJECTS)) return all;
    const tables = new Set(spans.map((s) => s.table));
    return all.filter((c) => tables.has(c.table));
  }
  protected override record(shard: string, spans: Span[], views?: readonly string[]): void {
    if (views && views.length > 0) {
      const seen = this.views.get(shard) ?? new Set<string>();
      for (const v of views) seen.add(v);
      this.views.set(shard, seen);
    }
    let prior = this.spans.get(shard) ?? [];
    if (this.db.faults.secondDmlNewSpanSince) {
      // 条件の範囲の引数には bigint が入るので、JSON は encode で作る。
      const bare = (s: Span) => encode({ ...s, since: undefined });
      const again = new Set(spans.filter((s) => s.since !== undefined).map(bare));
      prior = prior.filter((p) => p.since === undefined || !again.has(bare(p)));
    }
    this.spans.set(shard, [...prior, ...spans]);
  }

  /**
   * 読む行に T より新しい commit があれば、それまでの読みが変わっていないことを確かめて T を進める。
   * 別のシャードの時計が進んでいるだけで、確定済みの行が見えなくなるのを防ぐ。
   * 確かめた範囲に変更があれば、T を進めず、スナップショットのまま読み続ける。書き込みがあれば、commit の検証で競合になる。
   *
   * 答えは、その要求が運んだ時点と fresh だけで判断する。1 つの文が複数のシャードへ並べて送った要求の答えを、並んだ別の要求の答えが
   * 変えた取引の状態 (wantsFresh) で判断すると、答えが置き場所で変わる。前は、1 つ目の答えで T を進められないと決めた後、2 つ目の
   * シャードの `moved at` (fresh を付けて送った要求の答え) を、やり直さずに `read too old` として投げた。変わった行が 1 つのシャードに
   * あればスナップショットが返り、2 つのシャードにあれば失敗した (計画書の未解決の問題 34、test/snapshot-read-after-two-shards-changed.test.ts)。
   */
  override async call(shard: string, req: Outgoing): Promise<ExecRes> {
    for (let attempt = 0; ; attempt++) {
      // この要求が運ぶ時点と fresh。応答を待っている間に、別の読みが T を進めるか、T を進めるのをやめることがある。
      const at = { T: this.T, fresh: this.wantsFresh };
      let res: ExecRes | undefined;
      let failure: unknown;
      try {
        res = await this.send(shard, req, at);
      } catch (e) {
        failure = e;
      }
      // T を進める確認の最中に届いた応答は、その確認に入っていない。終わるのを待ってから、古い時点の読みかどうかを見る。
      while (this.advancing) await this.advancing;
      // 送った後で T が進んでいた。この応答は古い時点の状態で、進んだ T までの間に変わっていないことを誰も確かめていない。
      // そのまま使うと、1 つの文の中で別々の時点の行が混ざる。いまの T で読み直す。失敗した文の「読み」も同じである。
      const stale = at.T !== undefined && this.T !== undefined && at.T < this.T;
      if (failure === undefined) {
        if (!stale) return res!;
        if (attempt >= 20) throw new ConflictError("the read timestamp kept moving while this statement was reading");
        continue;
      }
      // fresh を付けて送った要求の `moved at` は、範囲に新しい確定があるという知らせで、読みの失敗ではない。T を進められれば進めた T で、
      // 進められなければ (この要求か、並んだ別の要求の答えで、進めないと決めた後なら) fresh を付けずに、スナップショットで読み直す。
      // fresh を付けずに送った要求の `moved at` (範囲の床) は、そのまま返す。
      const moved = /moved at (\d+)/.exec((failure as Error)?.message ?? "");
      if (moved && at.fresh && attempt < 4 && this.T !== undefined) {
        if (this.wantsFresh) await this.advance(Number(moved[1]));
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
   * シャードは、要求が運ぶものの epoch を、その計画に使った表定義のものとして信じる (自分より古い epoch の計画を断る)。溜めた書き込みを
   * 計画し直さずに新しい epoch を運ぶと、新しい index を保守しない書き込みが通る。表定義が変わるのは、確定の境目だけである。
   * ほかの接続の DDL が確定しても、取引は、この表定義のまま続く。古くなるのは、その DDL が変えた表に頼る文と COMMIT だけである
   * (docs/design-catalog-epoch.md の「表ごとの epoch」)。範囲表は、文が範囲の移動で断られると、新しいものに取り替える (reroute)。
   */
  get catalog(): Catalog {
    return this.cat;
  }

  /** まだ何も読み書きしていない取引を、新しい表定義へ移す。 */
  rebase(cat: Catalog): void {
    if (!this.untouched) throw new Error("a transaction that has read or written keeps its schema version until it commits");
    this.cat = cat;
  }

  /**
   * 文が、範囲の移動で断られた (`not owner:`。表定義が古いという `not owner: stale schema` は除く)。範囲表がより新しいスナップショットが
   * あれば、取引の範囲表をそれに取り替えて true を返す。呼び出し側は、断られた試みを捨て、文を新しい範囲表で計画し直す (断られた試みの
   * 要求を、送り直さない)。表定義は、取引のスナップショットのまま計画する。範囲表と表定義は独立で、ほかの接続の DDL が確定していても、
   * 範囲表は取り替える (docs/design-catalog-epoch.md の「表ごとの epoch」の「Worker」。段 3 までは、表定義全体の epoch が同じ
   * スナップショットでなければ取り替えず、関係のない DDL の後の分割で、取引の文が `not owner` で失敗した)。
   * plannedWith は、断られた試みを計画したスナップショットである。その間に、同じ取引の別の文 (計画の途中の読み) が取り替えていれば、
   * 取り直さずに true を返す。
   */
  async reroute(e: unknown, plannedWith: Catalog): Promise<boolean> {
    if (!isRouteRefusal(e)) return false;
    if (this.cat !== plannedWith) return true;
    const fresh = await this.db.freshCatalog();
    // 欠陥のスイッチ doomOnSchemaChange (段 3 の形): 表定義全体の epoch が変わっていれば、取り替えない。
    if (this.db.faults.doomOnSchemaChange && fresh.schema !== this.cat.schema) return false;
    if (fresh.epoch <= this.cat.epoch) return false;
    this.follow(fresh);
    return true;
  }

  /**
   * 取引の範囲表を、より新しいスナップショット fresh のものに取り替える。まだ何も読み書きしていない取引は、表定義ごと fresh へ移る。
   * 読むか書くかした取引は、表定義と、ものの epoch を、自分のスナップショットのまま持つ。fresh の epoch を運ぶようになるので、シャードは、
   * 取引の書く表の書き込み禁止を解く記録 (abort) を、取引の次の要求で適用する。
   * 取り替えるのは範囲表だけである。取引が溜めた読みと書き込みは、それを読んだか計画したシャードのものとして残る。
   * そのため、次のどちらかがあれば、取り替えずに競合で断る (test/transaction-own-writes-across-split.test.ts)。
   *   溜めた書き込みの行が、新しい範囲表で別のシャードのものになった。取り替えると、新しい持ち主へ送る文の overlay に、その行の
   *     書き込みが入らず、行ロックを取る文 (最新の状態で実行する) が、取引自身の書き込みを見ないまま答える。
   *   行ロックを取って読んだ範囲 (since のある範囲) が、新しい範囲表で、読んだシャードのものでなくなった。ロックは読んだシャードの
   *     メモリにだけあるので、新しい持ち主では別の接続が書ける。取り替えて同じ行を読み直すと、同じ取引の 2 つの読みが食い違う。
   * 時刻 T で読んだ範囲 (since のない範囲) は、新しい持ち主が T を範囲の床と比べて断るので、取り替えてよい。溜めた書き込みと読みを
   * 新しい持ち主へ移して続ける規則は、移動をまたぐ読みの確かめ直しと一緒に、モデルを書いてから入れる (未解決の問題 37)。
   */
  follow(fresh: Catalog): void {
    if (fresh.epoch <= this.cat.epoch) return;
    if (this.untouched) {
      this.cat = fresh;
      return;
    }
    for (const [shard, m] of this.writes) {
      for (const c of m.values()) {
        if (ownerOf(fresh.routing, c.sk) !== shard) {
          throw new ConflictError(`rows this transaction wrote moved to another shard in a split (${c.table} ${c.pk} is now on ${ownerOf(fresh.routing, c.sk)}); roll back and run the transaction again`);
        }
      }
    }
    for (const [shard, spans] of this.spans) {
      const mine = regionsOf(fresh.routing, shard);
      const kept = (x: Interval) => covered(x, mine);
      for (const sp of spans) {
        if (sp.since === undefined) continue;
        const moved = isWideSpan(sp) ? (sp.claim ?? []).some((x) => !kept(x)) : sp.kind !== "table" && sp.sk !== undefined && ownerOf(fresh.routing, sp.sk) !== shard;
        if (moved) throw new ConflictError(`rows this transaction read under a lock moved to another shard in a split (${sp.table}); roll back and run the transaction again`);
      }
    }
    this.cat = withRouting(this.cat, fresh);
  }

  /**
   * 同じ取引 (BEGIN から) の、前の区切りで読んだ範囲。DDL が区切りを作るたびに、次の取引へ引き継ぐ。
   * 取引が読んだ表を DROP するときに、読んだ後に別の接続が書いていないかを確かめる (Db.changeSchema の mode guard)。
   */
  earlier: ReadRecord[] = [];

  /** この取引が読んだ範囲。確定した後に呼ぶ。 */
  readRecord(): ReadRecord[] {
    const T = this.T ?? 0;
    // 欠陥のスイッチ guardFromCommitTs: 書いていないシャードでも確定の時刻を使う。確定の時刻を見ていないシャードの書き込みを見落とす。
    const wrote = (shard: string) => this.db.faults.guardFromCommitTs || (this.writes.get(shard)?.size ?? 0) > 0;
    return [...this.spans].map(([shard, spans]) => ({
      shard, spans,
      from: this.commitTs !== undefined && wrote(shard) ? Math.max(T, this.commitTs) : T,
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

  /** 取引が、表 table の行ロックを持つ (と、Worker が信じる) か。 */
  holdsLocksOn(table: string): boolean {
    return this.lockTables.has(objectKey(table));
  }

  /** 接続を跨ぐ取引のために状態を書き出す。Worker は状態を持たないので Hrana の baton に載せる。 */
  dump(): TxnDump {
    const m = (x: Map<string, Map<string, Change>>) => [...x].map(([k, v]) => [k, [...v]] as const);
    return {
      id: this.id, schema: this.cat.schema, earlier: this.earlier, T: this.T, writes: m(this.writes), spans: [...this.spans],
      pessimistic: this.pessimistic, lockReads: this.lockReads, lockOwner: this.lockOwner,
      saves: [...this.saves].map(([k, v]) => [k, { writes: m(v.writes), spans: [...v.spans] }] as const),
      ...(this.views.size > 0 ? { views: [...this.views].map(([k, v]) => [k, [...v]] as [string, string[]]) } : {}),
      ...(this.lockShards.size > 0 ? { locks: { tables: [...this.lockTables], shards: [...this.lockShards] } } : {}),
    };
  }

  /**
   * 書き出した取引を組み立て直す。cat は、いまのスナップショットである。
   * 書き出した後で、ほかの接続の DDL が確定していても、取引を失敗させない。取引は、最初に読むか書くかしたときの表定義で続く。その
   * 表定義は、Meta の列を、取引が運ぶ epoch まで畳んだものである (Cluster.catalogAt)。範囲表は、いまのものを使う。古くなるのは、
   * その DDL が変えた表に頼る文と COMMIT だけで、シャードが断る (docs/design-catalog-epoch.md の「表ごとの epoch」の「Worker」)。
   * 新しい表定義を名乗らせるわけにはいかない (Txn.catalog)。何もしていない取引は、いまの表定義で続ける。
   * 段 3 までは、表定義全体の epoch が変わっていれば、ここで取引を失敗させた (欠陥のスイッチ doomOnSchemaChange)。
   */
  static async load(db: Db, cat: Catalog, d: TxnDump): Promise<Txn> {
    const tx = Txn.restore(db, cat, d);
    // 何もしていない取引は、いまの表定義で続けてよい。欠陥のスイッチ repinOnRestore は、読み書きした取引にも、いまの表定義を名乗らせる。
    if (tx.untouched || db.faults.repinOnRestore || d.schema === cat.schema) return tx;
    if (db.faults.doomOnSchemaChange) {
      // 表定義の epoch は書き出し直しても変わらないので、次の要求でも、その次でも失敗する。
      tx.cat = { ...cat, schema: d.schema };
      tx.doom(new ConflictError(`the schema changed while the transaction was open (schema epoch ${d.schema} to ${cat.schema}); roll back and run the transaction again`));
      return tx;
    }
    tx.cat = await db.cluster.catalogAt(d.schema);
    return tx;
  }

  private static restore(db: Db, cat: Catalog, d: TxnDump): Txn {
    const tx = new Txn(db, cat, d.id);
    const m = (x: TxnDump["writes"]) => new Map(x.map(([k, v]) => [k, new Map(v)] as const));
    tx.earlier = d.earlier ?? [];
    tx.T = d.T;
    tx.pessimistic = d.pessimistic;
    tx.lockReads = d.lockReads;
    tx.lockOwner = d.lockOwner;
    tx.replaceWrites(m(d.writes));
    tx.spans = new Map(d.spans);
    tx.saves = new Map(d.saves.map(([k, v]) => [k, { writes: m(v.writes), spans: new Map(v.spans) }]));
    tx.views = new Map((d.views ?? []).map(([k, v]) => [k, new Set(v)]));
    tx.lockTables = new Set(d.locks?.tables ?? []);
    tx.lockShards = new Set(d.locks?.shards ?? []);
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
    this.replaceWrites(new Map([...s.writes].map(([k, v]) => [k, new Map(v)])));
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

  /**
   * 文を、取引の表定義と範囲表で計画して実行する。範囲の移動で断られたら (reroute)、試みを捨てて、新しい範囲表で計画し直す。
   * 断られた試みの要求は送り直さない。計画し直すと、宛先と文の分け方 (複数行の INSERT のまとめ) が、新しい範囲表で決まり直すからである。
   * 試みが採番した rowid は、試みを捨てるか、文が失敗したら戻す (Taken、Db.giveBack)。文が失敗しても、溜めた変更は文の前に戻る
   * (atomically) ので、番号はどこにも使われていない。outer は、この文を中に含む試みの控えである (INSERT … SELECT が分けた文など)。
   */
  async statement(stmt: Node, params: Params, outer: Taken | null = null): Promise<QueryResult> {
    if (this.doomed) throw this.doomed;
    const source = text(stmt);
    for (let attempt = 0; ; attempt++) {
      const cat = this.cat;
      const taken = new Taken(outer);
      try {
        return await runPlanned(attempt === 0 ? stmt : parseStatements(source)[0], source, params, cat, this.planContext(taken), (p) => this.execute(p, taken));
      } catch (e) {
        this.db.giveBack(taken.list);
        if (attempt >= REROUTES || !(await this.reroute(e, cat))) throw e;
      }
    }
  }

  /** 計画の途中で表を読む式は、この取引の読みとして実行する。読んだ範囲が commit で検証される。taken は、計画している試みの控えである。 */
  planContext(taken: Taken | null = null): PlanContext {
    return {
      ...this.db.planContext(this.cat, taken),
      read: async (sql, params) => (await this.statement(parseStatements(sql)[0], params, taken)).values[0] ?? null,
    };
  }

  /**
   * BEGIN IMMEDIATE の主キー読みはロックを取って最新を読む。本物の SQLite も先に書き込みロックを取る。
   * 楽観の読みのまま後で同じ行を書くと、検証で競合になるのが正しい動きなので、ホットな行が崩壊する。
   */
  protected override async shardRead(p: Extract<Plan, { kind: "shard" }>, t: Target): Promise<ExecRes> {
    if (!this.lockReads || !p.pk || p.tables.length !== 1) return super.shardRead(p, t);
    const { tables, columns } = await this.db.shapeOf(p.sql, this.cat, p.tables, false);
    return this.dml(t.shard, {
      sql: p.sql, params: p.params, columns, spans: statementSpans({ tables, sks: t.sks, pk: p.pk, write: false }),
      lockRows: [{ table: p.tables[0]!.name, pk: p.pk }],
      ...(p.indexed ? { rely: { write: p.indexed } } : {}),
    });
  }

  /**
   * 悲観的な取引では最新の状態で実行してロックを取る。読んだ範囲は F から検証する。
   * overlay は、文が取引自身の書き込みを読むときに要る。何も読まない要求 (lockWritten) には送らない (シャードが巻き戻す書き込みも課金される)。
   */
  private async dml(shard: string, req: Outgoing, o: { overlay?: false } = {}): Promise<ExecRes> {
    if (!this.pessimistic) return this.call(shard, req);
    this.lockOwner ??= { txn: this.txnId, start: this.db.startStamp() };
    const spans = withClaims(this.cat.routing, shard, req.spans);
    const { rely, ...wire } = req;
    // 取引が行ロックを持つ表。この文が、その表の書き込み禁止に当たったら、シャードは、断るときに、その行のロックを与える (M24 の HOLD)。
    const lock: LockOwner = this.lockTables.size > 0 ? { ...this.lockOwner, holds: [...this.lockTables] } : this.lockOwner;
    const res = await this.db.shardOf(shard).exec({
      ...wire, spans, T: this.T, minTs: this.db.token, deps: depsOf(this.cat, this.db.faults, spans, rely), epoch: this.cat.epoch,
      overlay: o.overlay === false ? [] : this.overlay(shard, spans),
      lock,
    }).catch((e) => {
      // 断ったシャードが、ロックを与えた。取引がロックを持ち得るシャードに数える (範囲は記録されないので、ここで覚える)。
      if (tableLockOf(e)?.held) this.lockShards.add(shard);
      return rerouted(e);
    });
    this.T ??= res.T;
    this.db.observe(res.hlc);
    if (wire.write || wire.lockRows) {
      this.lockShards.add(shard);
      for (const c of res.changes) this.lockTables.add(objectKey(c.table));
      for (const r of wire.lockRows ?? []) this.lockTables.add(objectKey(r.table));
    }
    this.record(shard, spans.map((s) => ({ ...s, since: res.F })), rely?.views);
    if (res.error !== undefined) throw new SqlError(res.error);
    return res;
  }

  /** rollback でロックを手放す。届かなくても TTL で消える。書き込み禁止で断られて、ロックだけを与えられたシャードにも送る。 */
  async unlockAll(): Promise<void> {
    if (!this.lockOwner) return;
    const shards = new Set([...this.spans.keys(), ...this.lockShards]);
    await Promise.allSettled([...shards].map((id) => this.db.shardOf(id).unlock({ txn: this.txnId })));
  }

  /** 文の途中で失敗したら、その文の変更だけを取り消す。SQLite の文の原子性と同じである。 */
  private async atomically(fn: () => Promise<QueryResult>): Promise<QueryResult> {
    const saved = new Map([...this.writes].map(([k, v]) => [k, new Map(v)]));
    const savedBytes = this.writeBytes;
    try {
      const out = await fn();
      // 大きすぎる取引は、上限を超えさせた文で断る。COMMIT まで待つと、どの文が原因か分からない。
      this.assertWriteSetBudget();
      return out;
    } catch (e) {
      this.writes = saved;
      this.writeBytes = savedBytes;
      throw e;
    }
  }

  /** 計画を実行する。taken は、計画した試みの控えである (INSERT … SELECT が分けた文の採番を、そこへ入れる)。 */
  async execute(p: Plan, taken: Taken | null = null): Promise<QueryResult> {
    if (this.doomed) throw this.doomed;
    switch (p.kind) {
      case "write": return this.atomically(() => this.write(p));
      case "wasmWrite": return this.atomically(() => this.wasmWrite(p));
      case "insertSelect": return this.atomically(() => this.insertSelect(p, taken));
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
    // 宛先ごとの、入れた行。文の lastInsertRowid は、これを VALUES の順に並べて決める (valuesOrder)。
    const inserted: { rows?: WriteTarget["rows"]; inserted: Pick<Change, "table" | "pk">[] }[] = [];
    // 利用者の RETURNING の列名。書き換える前の文を、Worker の SQLite でコンパイルして取る。
    const columns = p.returning ? (await this.db.compiled(p.returning, this.cat)).columns : [];
    const one = async (t: WriteTarget, target: Target) => {
      // index 経由の UPDATE と DELETE は、文を shard key に絞らずに送る。読みと同じく、span も絞らない。
      // 絞ると、ほかの行の確定済みで適用待ちの更新が決着されず、文がその行を古い値から書き換えてしまう。
      const tables = await this.db.tablesOf(t.sql, this.cat, p.tables ?? [p.def], true);
      const spans = statementSpans({ tables, sks: target.sks, pk: t.pk, write: true, uniqueReads: t.uniqueReads });
      const res = await this.dml(target.shard, { sql: t.sql, params: t.params, columns, spans, write: t.write, rely: { write: [p.def.name] } });
      if (res.columns.length) out.columns = res.columns;
      out.values.push(...res.values);
      changes += res.count ?? res.changes.length;
      inserted.push({ rows: t.rows, inserted: res.inserted ?? [] });
      // 悲観的な取引では、シャードが文を実行するときに、変えた行のロックを取っている (dml)。
      const locking = this.wrote(res.changes.map((change) => ({ shard: target.shard, change })));
      if (locking) await locking;
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
    // 全部のシャードの応答を待ってから失敗を返す。1 つのシャードの失敗で先に返すと、まだ応答を待っているシャードの変更が、
    // 文を取り消した後 (atomically) に取引へ入る。基準経路で実行し直すときも同じで、失敗した文の変更が確定した
    // (2026-11-13 の Codex の 2 回目の見直し、指摘 2。test/shard-limits.test.ts の「stays atomic」)。
    const settled = await Promise.allSettled([...byShard.values()].map(async (list) => {
      for (const j of list) await one(j.t, j.target);
    }));
    const failed = settled.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failed) throw failed.reason;
    return new QueryResult(out.columns, out.values, changes, lastInsertRowid(this.cat, valuesOrder(inserted)));
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
    // 文が書く表。行を集める読みも、衝突し得る行を探す読みも、その表には書き込みの epoch で頼る。index の DDL が確定した後の古い計画を、
    // COMMIT まで待たずに、文の時点で断らせる。
    const write = [p.def.name];
    const loaded = await this.collect(p.scans, p.sql, write);
    // 利用者の RETURNING の列名。書き換える前の文を、Worker の SQLite でコンパイルして取る。
    const columns = p.returning ? (await this.db.compiled(p.returning, this.cat)).columns : [];
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
        // 捕捉の trigger は、Worker の SQLite を作った表定義 (this.cat) で作る。計画の表定義 (p.tables) は、計画した後に取引が
        // 新しい版で始まると古い。古い版の trigger は列の少ないタプルを書き、新しい列の値を落とす (REPLACE が入れ直した行の既定値など)。
        // 行イメージが列名を持っていた間は、変更後の行を本体から読み直していたので、見えなかった (test/setup.ts の行イメージの検査が
        // 基準経路だけの実行の test/ddl-concurrent.test.ts で見つけた)。
        for (const d of p.tables) for (const ddl of captureDdl(catalog(d.name))) w.exec(ddl);
        w.exec(`PRAGMA recursive_triggers = ON`);
        w.exec(`INSERT INTO __cap_on VALUES (1)`);
        // 利用者の RETURNING は、項ごとに要素の式に書き換えてある (src/sql/returning.ts)。TEXT は BLOB で届くので、NUL で切れない。
        const returned = [...w.query(p.sql, p.params).rows].map((row) => row.map(decodeReturned));
        // 変更した行の数は、SQLite の数え方そのままである。REPLACE が消した行は数えない。
        const counted = w.raw(`SELECT changes()`).values[0]?.[0] as number;
        // 文の lastInsertRowid は、捕捉が記録した、入れた行から決める (lastInsertRowid)。Worker の SQLite の last_insert_rowid() は
        // 読まない。捕捉の印の INSERT (__cap_on) の rowid や、利用者に見えない rowid を返すからである。
        const { changes, inserted } = capturedChanges(w, catalog);
        const more = await this.conflicting(changes, catalog, have, asked, write);
        if (more.length > 0) {
          loaded.push(...more);
          this.withinRowBudget(have.size);
          continue;
        }
        // 書いた行を、持ち主のシャードの変更として取引へ入れる。悲観的な取引では、ここでロックを取る (wrote)。
        const locking = this.wrote(changes.map((change) => ({ shard: ownerOf(this.cat.routing, change.sk), change })));
        if (locking) await locking;
        // 同じ値の行は全部ここにあり、SQLite が一意性を確かめ終えている。index の項目は、確かめ直さずに書く。
        await this.indexChanges(changes, "trusted");
        return new QueryResult(columns, returned, counted, lastInsertRowid(this.cat, inserted));
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
  private async conflicting(changes: Change[], catalog: (t: string) => TableDef, have: Set<string>, asked: Set<string>, write: readonly string[]): Promise<Loaded[]> {
    // 行の持ち主のシャードへの問いを、表と shard key の値ごとにまとめる。1 つの行が 2 つの条件に当たっても、1 回だけ返る。
    const wanted = new Map<string, { def: TableDef; sk: string; conds: { sql: string; params: Value[] }[] }>();
    const want = (def: TableDef, sk: string, cols: string[], vals: Value[], op: "=" | "IS") => {
      const id = `${def.name}\0${sk}\0${cols.join("\0")}\0${keyString(vals)}`;
      if (asked.has(id)) return;
      asked.add(id);
      const key = `${def.name}\0${sk}`;
      const g = wanted.get(key) ?? { def, sk, conds: [] };
      wanted.set(key, g);
      g.conds.push({ sql: `(${joinTerms(cols.map((c) => `${q(def.name)}.${q(c)} ${op} ?`), "AND")})`, params: vals });
    };
    for (const c of changes) {
      if (!c.after) continue;
      const def = catalog(c.table);
      // 主キー。新しく現れた主キーに、行が既にあるか。
      if (c.before === null && !have.has(`${def.name}\0${c.pk}`)) want(def, c.sk, def.pk, pkValues(c.pk), "IS");
      // シャード内の UNIQUE。shard key を含むので、同じ値の行は同じ shard key の値の中にある。`=` は列の照合順序で比べる。
      for (const cols of def.uniques) {
        const vals = cols.map((col) => imageAt(def, c.after!, col));
        if (vals.some((v) => v === null)) continue;
        if (c.before && cols.every((col, i) => keyString([imageAt(def, c.before!, col)]) === keyString([vals[i]!]))) continue;
        want(def, c.sk, cols, vals, "=");
      }
      // シャードをまたぐ UNIQUE。index の表を引き、同じ値を持つ行の主キーと場所を知ってから、その行を読む。
      for (const ix of def.globalIndexes) {
        const keyOf = (r: Tuple | null): string | null => {
          if (!r) return null;
          const vals = ix.columns.map((col) => imageAt(def, r, col));
          return vals.some((v) => v === null) ? null : keyString(vals);
        };
        const k = keyOf(c.after);
        if (k === null || k === keyOf(c.before) || asked.has(`${ix.table}\0${k}`)) continue;
        asked.add(`${ix.table}\0${k}`);
        const sk = keyString([k]);
        // 並べて出さない。取引の最初の読みが 2 つ並ぶと、読む時点が 2 つでき、片方は検証の窓から漏れる。
        const hit = await this.call(ownerOf(this.cat.routing, sk), {
          sql: `SELECT "pk", "sk" FROM ${q(ix.table)} WHERE "k" = ?`, params: [k], columns: ["pk", "sk"],
          spans: [rowSpan(ix.table, keyString([k]), sk)],
        });
        for (const [pk, at] of hit.values) {
          if (!have.has(`${def.name}\0${pk as string}`)) want(def, at as string, def.pk, pkValues(pk as string), "IS");
        }
      }
    }
    const out: Loaded[] = [];
    // 問いが多いと、1 つの走査が DO の SQLite の上限 (変数 100 個、文 100 KB) を超える。上限に収まる数ずつに分けて読む
    // (src/shard-limits.ts。基準経路の走査は、作りとして上限に収める)。
    const batches: { def: TableDef; sk: string; conds: { sql: string; params: Value[] }[] }[] = [];
    for (const g of wanted.values()) {
      let batch: typeof g.conds = [];
      const scanOf = (conds: typeof g.conds): Scan => {
        // 問いの数だけ OR でつなぐと、式の木が問いの数だけ深くなる (DO の SQLite の上限は 100)。釣り合った木に組む。
        const where = joinTerms(conds.map((x) => x.sql), "OR");
        const params = conds.flatMap((x) => x.params);
        return { table: g.def, sql: `SELECT ${scanList(g.def)} FROM ${q(g.def.name)} WHERE ${where}`, params, sks: [g.sk], where: { alias: g.def.name, sql: where, params }, columns: scanColumns(g.def) };
      };
      for (const c of g.conds) {
        const next = [...batch, c];
        const s = scanOf(next);
        if (batch.length > 0 && !scanFits(s)) {
          batches.push({ def: g.def, sk: g.sk, conds: batch });
          batch = [c];
        } else batch = next;
      }
      if (batch.length > 0) batches.push({ def: g.def, sk: g.sk, conds: batch });
    }
    for (const g of batches) {
      const where = joinTerms(g.conds.map((x) => x.sql), "OR");
      const params = g.conds.flatMap((x) => x.params);
      const scan: Scan = { table: g.def, sql: `SELECT ${scanList(g.def)} FROM ${q(g.def.name)} WHERE ${where}`, params, sks: [g.sk], where: { alias: g.def.name, sql: where, params }, columns: scanColumns(g.def) };
      const { columns, rows } = await this.scan(scan, undefined, { write });
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

  /**
   * INSERT … SELECT。SELECT を読み、読んだ行を引数にした INSERT … VALUES に分けて、順に実行する。分けた文の結果を、1 つの文の結果に
   * まとめる。RETURNING の行はつなぎ (前は捨てていた。計画書の未解決の問題 40)、変更した行の数は足し、lastInsertRowid は、最後に
   * 行を入れた文のものである。分けた文は VALUES の順に流すので、文の間の順は SQLite が入れる順と同じである。
   * 結果の列名は、元の文を Worker の SQLite でコンパイルして取る。行を 1 つも入れなくても、RETURNING の列名を返す (SQLite と同じ)。
   * taken は、この文を計画した試みの控えで、分けた文の採番もそこへ入れる (文が失敗したら、外の試みが戻す)。
   */
  private async insertSelect(p: Extract<Plan, { kind: "insertSelect" }>, taken: Taken | null): Promise<QueryResult> {
    // 読みは型つきなので、読んだ値は型のある値である。INTEGER と REAL を取り違えずに、そのまま引数として束縛し直せる。
    const src = await this.read(p.select);
    const cols = p.columns ? `(${p.columns.map(q).join(", ")}) ` : "";
    const values: Value[][] = [];
    let changes = 0;
    let last: bigint | null = null;
    // DO の bound parameter の上限 (100) に収まる行数ずつ流す。
    const width = Math.max(1, src.columns.length);
    const per = Math.max(1, Math.floor((100 - p.tailParams.length) / width));
    for (let at = 0; at < src.values.length; at += per) {
      const chunk = src.values.slice(at, at + per);
      const rows = chunk.map((row) => `(${row.map(() => "?").join(", ")})`).join(", ");
      const sql = `${p.head} ${cols}VALUES ${rows}${p.tail ? ` ${p.tail}` : ""}`;
      this.sqls.push(sql);
      const r = await this.statement(parseStatements(sql)[0], [...chunk.flat(), ...p.tailParams], taken);
      values.push(...r.values);
      changes += r.changes;
      last = r.lastInsertRowid ?? last;
    }
    const columns = p.returning ? (await this.db.compiled(p.returning, this.cat)).columns : [];
    return new QueryResult(columns, values, changes, last);
  }

  /**
   * 書き込みの文が変えた行を、取引へ入れる。文をどこで実行したか (シャードの SQLite か、Worker の SQLite か) によらず、文の変更は
   * 全部ここを通る。index の項目 (indexWrite) は通らない。
   *   1. 悲観的な取引 (SQL の BEGIN、baton) では、まだロックのない行のロックを取る (lockWritten)。文書は、書き込みは経路によらず
   *      文の時点で行ロックを取ると約束している (docs/sql-language.md の「取引」、docs/design.md の「悲観的な取引」)。シャードで実行した
   *      文 (Txn.write) は、シャードが文を実行するときにロックを取り、変更に F (since) を付けて返すので、ここでは取らない。Worker の
   *      SQLite で実行した文 (Txn.wasmWrite) の行は、ここで取る。前は取らず、別の接続が待たずに書けて、COMMIT が競合になった
   *      (計画書の未解決の問題 36、test/ranged-write-in-begin-takes-no-lock.test.ts)。
   *   2. 行を持ち主のシャードの変更として溜める (buffer)。
   *   3. 文が新しいキーに置いた行 (入れた行と、主キーを書き換えた行) の rowid を採番に知らせる (Db.sawId。以後の採番は、それより
   *      大きくする)。前からあった行の rowid は、その行を入れた文が知らせている。
   * ロックを取らないなら待たない (Promise を返さない)。待ちを 1 つ足すと、並べて送る文の RPC の順序が変わる。
   */
  private wrote(changes: { shard: string; change: Change }[]): Promise<void> | undefined {
    const finish = () => {
      for (const { shard, change } of changes) {
        this.buffer(shard, change);
        const def = this.cat.tables[change.table];
        const idColumn = def ? (def.rowidAlias ?? (def.implicitRowid ? "rowid" : null)) : null;
        const id = def && idColumn !== null && change.after && change.before === null ? imageAt(def, change.after, idColumn) : undefined;
        if (typeof id === "bigint") this.db.sawId(def!.name, id);
      }
    };
    const unlocked = this.pessimistic ? changes.filter((x) => x.change.since === undefined) : [];
    if (unlocked.length === 0) return void finish();
    return this.lockWritten(unlocked).then(finish);
  }

  /**
   * 悲観的な取引で、文が書いた行のロックを取る (wrote)。シャードごとに 1 回、行ロックを取る読み (ExecReq.lockRows) を送る。BEGIN IMMEDIATE
   * の主キーの読み (shardRead) と同じ手順で、シャードは行の intent を決着させ、最新の時刻 F でロックを取る (specs/m9_protocol.qnt の
   * ロック読み。待ちは wound-wait)。読む文は行を読まず (LOCK_SQL)、範囲は書いた行の主キーである (持ち主の確かめと intent の決着に使う。
   * 範囲は F から検証される)。
   * 行の値は、文が読んだ時点 T のスナップショットから計算してある。T と F の間に別の接続が同じ行を確定していれば、文が読んだ範囲
   * (T から検証する) が COMMIT で競合になる。変更には F を付けない (書き込みも T から検証する。M9 の F からの検証より厳しい)。
   */
  private async lockWritten(rows: { shard: string; change: Change }[]): Promise<void> {
    const byShard = new Map<string, Change[]>();
    for (const { shard, change } of rows) byShard.set(shard, [...(byShard.get(shard) ?? []), change]);
    const settled = await Promise.allSettled([...byShard].map(([shard, list]) =>
      this.dml(shard, {
        sql: LOCK_SQL, params: [], columns: ["locked"],
        spans: list.map((c) => rowSpan(c.table, c.pk, c.sk)),
        lockRows: list.map((c) => ({ table: c.table, pk: c.pk })),
        rely: { write: [...new Set(list.map((c) => c.table))] },
      }, { overlay: false })));
    const failed = settled.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failed) throw failed.reason;
  }

  private buffer(shard: string, c: Change): void {
    const m = this.writes.get(shard) ?? new Map<string, Change>();
    this.writes.set(shard, m);
    const key = `${c.table}\0${c.pk}`;
    const prior = m.get(key);
    // 検証の窓は最初の F から取る。2 回目の DML は自分の overlay を読むだけで、他者の変更を見ていない。
    const first = prior?.since !== undefined && c.since !== undefined ? Math.min(prior.since, c.since) : (prior?.since ?? c.since);
    const since = this.db.faults.secondDmlNewSince && c.since !== undefined ? c.since : first;
    const next = prior ? { ...c, before: prior.before, since } : c;
    this.writeBytes += changeBytes(next) - (prior ? changeBytes(prior) : 0);
    m.set(key, next);
  }

  /**
   * 取引が変える行の大きさの合計 (行イメージの UTF-8 のバイト数)。上限は取引全体で数える。シャードごとに数えると、同じ取引が、
   * 行が分かれていれば通り、1 つのシャードに集まれば断られる (計画書の不変条件 13、test/shard-limits.test.ts)。
   * 合計が上限以下なら、シャードごとの変更ログの 1 行にも必ず収まる (ShardCore.assertWriteSetFits)。
   */
  private writeBytes = 0;
  /** 書き込みの集まりを丸ごと入れ替える (baton からの組み立て直し、SAVEPOINT への巻き戻し)。合計を数え直す。 */
  private replaceWrites(writes: Map<string, Map<string, Change>>): void {
    this.writes = writes;
    this.writeBytes = 0;
    for (const m of writes.values()) for (const c of m.values()) this.writeBytes += changeBytes(c);
  }
  private assertWriteSetBudget(): void {
    if (this.writeBytes > this.db.writeSetBudget) {
      throw new SqlError(`transaction too large: it changes more than ${this.db.writeSetBudget} bytes of rows; split it into smaller transactions`);
    }
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
        const keyOf = (r: Tuple | null): string | null => {
          if (!r) return null;
          const vals = ix.columns.map((col) => imageAt(def!, r, col));
          return vals.some((v) => v === null) ? null : keyString(vals);
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
    const sk = keyString([k]);
    const res = await this.call(ownerOf(this.cat.routing, sk), {
      sql: `SELECT "pk" FROM ${q(ix.table)} WHERE "k" = ?`, params: [k], columns: ["pk"],
      spans: [rowSpan(ix.table, keyString([k]), sk)],
    });
    if (res.values.some((r) => r[0] !== pk)) {
      if (resolve) throw new NeedsReference(`a row on another shard holds the same ${ix.columns.join(", ")}`);
      throw new SqlError(`UNIQUE constraint failed: ${def.name}.${ix.columns.join(", ")}`);
    }
  }

  indexWrite(ix: GlobalIndexDef, row: Row, remove: boolean): void {
    const def = this.cat.tables[ix.table]!;
    const key = encodeKey(def, row);
    const image = tupleOfRow(def, row);
    this.buffer(ownerOf(this.cat.routing, key.sk), {
      table: ix.table, ...key, before: remove ? image : null, after: remove ? null : image,
    });
  }

  async commit(): Promise<void> {
    if (this.doomed) throw this.doomed;
    // 大きすぎる取引は、シャードへ送る前にここで断る。シャードも同じ検査をするが、そちらの拒否は競合と同じ扱いで再試行される。
    // 文ごとにも確かめているが (atomically)、取引を組み立て直した後 (baton) にも効くように、ここでも確かめる。
    try {
      this.assertWriteSetBudget();
    } catch (e) {
      await this.unlockAll().catch(() => undefined);
      throw e;
    }
    const shards = new Set([...this.writes.keys()].filter((s) => this.writes.get(s)!.size > 0));
    // 読み取りだけなら T の snapshot で完結する。ただしロックを取って最新を読んだ取引は、
    // 読みの時刻が揃っていないので検証が要る。検証でロックも手放す。
    const latest = [...this.spans.values()].some((list) => list.some((s) => s.since !== undefined));
    if (shards.size === 0 && !latest) return;
    if (shards.size === 0 && this.db.faults.lockedReadsSkipValidation) return this.unlockAll();
    for (const s of this.spans.keys()) shards.add(s);

    // 参加者ごとに、その書き込みと確かめる範囲が頼るものを運ぶ。epoch は、取引が計画した表定義のものである (Txn.catalog)。書いた表には
    // 書き込みの epoch で、読んだ表と、文が名指した view には読みの epoch で頼る。範囲表は、文が断られて取り替えていれば、新しい
    // スナップショットのもの。
    const parts = [...shards].map((shard) => {
      const writes = this.overlay(shard);
      const spans = this.spans.get(shard) ?? [];
      return { shard, writes, spans, deps: depsOf(this.cat, this.db.faults, spans, { views: [...(this.views.get(shard) ?? [])] }, writes) };
    });
    const T = this.T ?? 0;
    const epoch = this.cat.epoch;
    let res: CommitRes;
    if (parts.length === 1) {
      const p = parts[0]!;
      res = await this.db.shardOf(p.shard).commitLocal({ txn: this.id, T, writes: p.writes, spans: p.spans, deps: p.deps, epoch });
    } else {
      // anchor は最後に prepare するので refresh が要らない。未保護の span が多い参加者を選ぶ。
      const score = (p: (typeof parts)[number]) =>
        p.spans.filter((s) => !(s.kind === "pk" && p.writes.some((w) => w.table === s.table && w.pk === s.pk))).length;
      const sorted = [...parts].sort((a, b) => score(b) - score(a) || hashKey(this.id + a.shard) - hashKey(this.id + b.shard));
      const anchor = this.db.shardOf(sorted[0]!.shard);
      // 2PC の ID は、取引の ID と、この続きの中身 (時点、参加者ごとの書き込みと読んだ範囲と頼るもの) の指紋である。
      // baton は使い捨てではないので、同じ取引の ID の続きが 2 つできる。ID が取引の ID だけだと、2 つの COMMIT が 1 つの 2PC に
      // 混ざる。断られた続きの中止が、確定した続きの intent を消し、確定と答えた書き込みが消えた (2026-11-13 の Codex の指摘 C1、
      // specs/m17_txn_id_reuse.qnt の m17_red_abort)。中身ごとに ID を分けると、2 つの続きは別の 2PC になり、同じ行を書けば普通の
      // 競合で片方が断られる。同じ中身の再送は同じ ID なので、anchor の記録から同じ答えを返す。指紋は SHA-256 で、利用者が
      // 中身を選んでも衝突を作れない。行ロックは取引の ID のままで、シャードは ID の # の前で自分のロックを見分ける (lockIdOf)。
      const txn = this.db.faults.commitIdIsTxn ? this.id
        : `${this.id}#${sha256Text(encode([T, parts.map((p) => [p.shard, p.writes, p.spans, p.deps])])).slice(0, 32)}`;
      try {
        res = await anchor.commit({ txn, T, participants: parts, epoch });
      } catch (e) {
        const st = await anchor.status({ txn }); // 応答不明は status で決着を知る。
        if (st.status === "committed") res = { ok: true, c: st.c };
        else if (st.status === "aborted") throw new ConflictError(`commit outcome: ${e instanceof Error ? e.message : e}`);
        else throw e;
      }
    }
    if (!res.ok) throw commitRefusal(res.reason);
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
      /**
       * 接続の取引が確定するたびに呼ぶ (COMMIT、取引の中の DDL の前の確定、batch の区切り)。at は確定の時刻、読むだけなら読んだ時刻。
       * 文を再生する検査が、区切りを直列の順序に置くのに使う。Hrana の応答には時刻がないので、ここで受け取る。
       */
      onCommit?: (c: { at: Ts | undefined; readOnly: boolean }) => void;
    } = {},
  ) {
    this.rt = opts.runtime ?? cluster.runtime ?? systemRuntime;
    this.reference = opts.reference ?? cluster.reference;
    this.faults = opts.faults ?? cluster.clientFaults ?? {};
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

  /** 覚えている表定義を捨てて、Meta から取り直す。 */
  async freshCatalog(): Promise<Catalog> {
    this.cached = null;
    return this.catalog();
  }

  /**
   * 捨てる試みか、失敗した試みが採番した番号を戻す (Taken。SQLite も、失敗した INSERT の rowid を使わない)。後の採番から順に見て、
   * ブロックの次の番号がまだその採番の直後にあれば、次の番号をその採番の先頭へ戻す。直後になければ (同じブロックを共有する別の接続が
   * 後から取った)、その表のそれより前の採番は戻さない。戻した番号は、もう一度配っても、どこにも使われていない。
   */
  giveBack(list: readonly Allocation[]): void {
    const kept = new Set<string>();
    for (let i = list.length - 1; i >= 0; i--) {
      const a = list[i]!;
      if (a.returned || kept.has(a.table)) continue;
      const b = this.ids.get(a.table);
      if (b && b.end === a.end && b.next === a.first + a.n) {
        b.next = a.first;
        a.returned = true;
      } else kept.add(a.table);
    }
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
    return this.checkTables(await this.compiled(sql, cat), known, write);
  }

  /**
   * tablesOf と同じ確かめをして、文が読む表と、結果の列名 (シャードへ送る読みの ExecReq.columns) を返す。待つのは compiled の 1 回で、
   * tablesOf と同じである (待ちの数が変わると、並行する文の RPC の順序が変わる)。
   */
  async shapeOf(sql: string, cat: Catalog, known: TableDef[], write: boolean): Promise<{ tables: TableDef[]; columns: string[] }> {
    const seen = await this.compiled(sql, cat);
    return { tables: this.checkTables(seen, known, write), columns: seen.columns };
  }

  private checkTables(seen: Compiled, known: TableDef[], write: boolean): TableDef[] {
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

  /** 文を計画するときの、Db の側の材料。taken は、計画している試みの控えで、プランナの採番をそこへ入れる (null なら記録しない)。 */
  planContext(cat: Catalog, taken: Taken | null = null): PlanContext {
    return {
      reference: this.reference,
      nextId: (table, n) => this.nextId(table, n, taken),
      sawId: (table, big) => this.sawId(table, big),
      evaluate: async (sql, params) => {
        const w = await openScratch(cat);
        try {
          return w.select(sql, params).values[0] ?? null;
        } finally {
          w.close();
        }
      },
    };
  }

  /** 利用者が明示した rowid か、文が新しいキーに置いた行の rowid を知らせる。以後の採番は、それより大きくする。 */
  sawId(table: string, big: bigint): void {
    // 採番は 2^53 未満の範囲で続ける (docs/design-values.md の持ち主の判断の 4)。それより大きい ID は、採番した ID と重ならない。
    if (big > MAX_SAFE || big < -MAX_SAFE) return;
    const id = Number(big);
    const b = this.ids.get(table);
    if (!b || id >= b.next) this.pendingSeen.set(table, Math.max(this.pendingSeen.get(table) ?? 0, id));
  }

  private pendingSeen = new Map<string, number>();

  /**
   * rowid をブロック単位で採番する。Meta への問い合わせはブロックごとの 1 回で済む。番号は INTEGER (bigint) で返す。
   * 採番は taken (試みの控え) に記録する。試みを捨てるか、試みが失敗したら、giveBack が戻す。
   */
  private async nextId(table: string, n: number, taken: Taken | null): Promise<bigint> {
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
    taken?.add({ table, first, n, end: b.end });
    return BigInt(first);
  }

  /**
   * DDL の履歴は、Worker の SQLite でも再生する (行を集めて実行する文のため)。記録する前に、ここで再生できることを確かめる。
   * Meta が確かめるのはシャードで実行する文だけで、利用者が書いた形の文は確かめない。再生できない文が履歴に入ると、
   * 履歴は書き換えられないので、以後、行を集める文がすべて失敗する。
   */
  private async assertReplays(sql: string, cat: Catalog): Promise<void> {
    const parsed = parseDdl(sql, cat);
    // 基準経路は、条件を押し下げられなければ表を丸ごと読む (scanOf)。その走査と、シャードが行イメージを読み書きする文
    // (捕捉の trigger、主キーとグループの読み、行を入れ直す文。src/shard/rows.ts の imageStatements) は、作りとして DO の SQLite の
    // 上限 (文の長さ、束縛の変数の数、式の木の深さ) に収まらなければならない。収まらない表 (極端に長い列名、多すぎる列など) は、
    // 表定義で断る (src/shard-limits.ts の builtLimitOf、計画書の不変条件 13)。断るかどうかは表定義だけで決まる。
    // 確かめを落とすと、表は CREATE TABLE を通り、後でシャードが trigger を作れないか、1 行も書けない
    // (test/wide-table-expression-depth.test.ts)。
    for (const def of parsed.defs ?? []) {
      // 全表の走査は、シャードが実行する形 (型つきの読みに包んだ文) で測る。
      const scan = fullScan(def);
      const statements = [{ sql: typedReadSql(scan.sql, scan.columns.length), params: [] as Value[] }, ...imageStatements(def)];
      const over = statements.map((s) => builtLimitOf(s.sql, s.params)).find((x) => x !== null);
      if (over) {
        throw new SqlError(`unsupported: the table ${def.name} is too wide for a shard to scan and capture its rows within Durable Object SQLite limits (${over}); use fewer or shorter column names`);
      }
    }
    // 文は commit のときに Worker の SQLite の履歴に入る。ここで確かめておく。
    const user = parsed.user;
    if (parsed.noop || !user) return;
    const w = await openScratch(cat);
    try {
      try {
        w.exec(user);
      } catch (e) {
        throw new SqlError((e as Error)?.message ?? String(e));
      }
    } finally {
      w.close();
    }
  }

  /**
   * 全シャードに、このスナップショットの epoch までの記録を適用させる。表定義の遷移を終えた後で、書き込みの禁止を早く解くために呼ぶ。
   * 正しさには要らないので、失敗は捨てる (届かなかったシャードは、次の要求が適用させる)。
   * 欠陥のスイッチ commitWithoutAcks では、prepared を尋ねなかったシャード (範囲表の最後のシャード) にも送らない。進める側は、
   * そのシャードと一度も話さずに完了を返す (M21 の m21_red_drop_missing_ack の「DDL が完了を返す」)。
   */
  private async syncAll(cat: Catalog): Promise<void> {
    const ids = shardsOf(cat.routing);
    const to = this.faults.commitWithoutAcks ? ids.slice(0, -1) : ids;
    await Promise.allSettled(to.map((id) => this.shardOf(id).syncSchema({ atLeast: cat.epoch })));
  }

  private publish(cat: Catalog): void {
    this.cached = cat;
    // 呼び出し側のキャッシュにも渡す。渡さないと、同じ isolate の次の要求が DDL の前の表定義で計画する。
    this.opts.onCatalog?.(cat);
  }

  /**
   * 表定義の遷移を開く (Meta の prepare)。先に、文を Worker の SQLite で再生できることを確かめる (assertReplays)。
   * Meta は、表定義が呼び出し側の見たものから進んでいれば `schema moved` で、遷移が開いているか分割の途中なら `schema busy` で断る。
   * どちらも、表定義を取り直してやり直す。待つ時間は 1 つの期限で測る。before は、文を解釈したスナップショットの表定義の epoch である。
   * waitUntil は DDL の待ちの期限で、prepare の記録が運ぶ (シャードは、fence の表の行ロックを、その時刻まで待つ)。
   */
  private async prepareDdl(sql: string, guard: string[], waitUntil: number): Promise<Prepared & { before: number }> {
    const deadline = this.rt.now() + (this.opts.splitWaitMs ?? SPLIT_WAIT_MS);
    const wait = async (what: string) => {
      if (this.rt.now() > deadline) throw new SqlError(`${what} is in progress; retry the schema change when it finishes`);
      await sleep(this.rt, 20);
    };
    for (let attempt = 0; ; attempt++) {
      const before = await this.cluster.catalog();
      try {
        await this.assertReplays(sql, before);
        return { ...(await this.cluster.prepare(sql, { guard, waitUntil }, before.schema)), before: before.schema };
      } catch (e) {
        const m = (e as Error)?.message ?? "";
        if (attempt < 5 && /schema moved to epoch/.test(m)) continue;
        // 別の表定義の遷移か分割が進行中である。終わるか、期限で abort されるまで待つ。
        if (/schema busy:/.test(m)) {
          attempt = Math.min(attempt, 3);
          await wait(m.replace(/^schema busy: | is in progress$/g, ""));
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
    if (this.faults.noImplicitCommit) return this.changeSchema(sql, reads);
    this.current = null;
    try {
      await open.commit();
    } catch (e) {
      await open.unlockAll().catch(() => undefined);
      if (this.faults.ddlAfterFailedCommit) await this.changeSchema(sql, reads).catch(() => undefined);
      throw e;
    }
    this.committed(open);
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

  /**
   * 表定義を変える (docs/design-catalog-epoch.md の「Worker」)。どの DDL も同じ 3 手で進む。
   *   1. Meta が prepare を記録する。fence の表への書き込みが止まる (シャードが prepare を適用したときから)。
   *   2. 全シャードに prepare を適用させ、答えを集める (ShardApi.prepared)。trial の DDL では、各シャードが書き込みを止めた表に文を試す。
   *      mode ごとの仕事をする。build は止まった行を読んで index の表へ項目を書き、guard は取引が読んだ範囲が変わっていないかを確かめる。
   *   3. 全シャードが ok なら、Meta が commit を記録する。どこかで失敗すれば abort を記録し、理由を利用者へ返す。
   * この呼び出しが途中で止まっても、期限 (meta.ts の LEASE_MS) が来れば Meta が abort を記録する。取り消しの文 (逆操作) はない。
   * commit の後で全シャードへ適用させるのは、書き込みの禁止を早く解くためで、正しさには要らない。
   * reads は、この DDL を含む取引が、それまでに読んだ範囲である。読んだ表を DROP するなら、mode guard になる。
   */
  private async changeSchema(sql: string, reads: ReadRecord[] = []): Promise<void> {
    const guard = this.faults.dropWithoutGuard ? [] : await this.droppedAfterRead(sql, reads);
    // DDL の待ちの期限 (docs/design-catalog-epoch.md の「表ごとの epoch」の「Worker」)。DDL を始めてから、busy_timeout と同じ 5 秒である。
    // 表の行を書いた取引が行ロックを持つ間、シャードは prepare の適用を待つ (M24 の WAIT_LOCKS)。その待ちの上限で、遷移ごとの期限
    // (lease) とは別のものである。取り消させられた DDL をやり直すときも、数え直さない (KEEP_BUDGET)。
    let waitUntil = this.rt.now() + DDL_WAIT_MS;
    // 取り消された試みで ok と答えたシャード。欠陥のスイッチ retrySameEpoch だけが、やり直しに使う。
    let stale: string[] = [];
    for (;;) {
      const p = await this.prepareDdl(sql, guard, waitUntil);
      this.publish(p.catalog);
      this.ids.clear();
      if (p.epoch === null) return; // 何も記録されなかった
      const epoch = p.epoch;
      const lease = this.keepLease(epoch);
      const acked: string[] = [];
      let committed: Catalog;
      try {
        committed = await this.drive({ ...p, epoch }, reads, guard, acked, stale);
      } catch (e) {
        // Worker の 1 回の呼び出しで使える要求の数を使い切ったときは、abort の要求も通らない。その場合は、期限が来れば Meta が abort する。
        const exhausted = p.mode === "build" && /too many subrequests|subrequest/i.test((e as Error)?.message ?? "");
        const index = p.catalog.open?.index ?? "";
        const reason = exhausted
          ? `CREATE INDEX ${index} did not finish: the table has too many rows to index within one request. The index was not created and the table is unchanged. A UNIQUE constraint declared in CREATE TABLE needs no build.`
          : ((e as Error)?.message ?? String(e));
        const withdrawn = await this.cluster.abort(epoch, reason).catch(() => null);
        const now = await this.cluster.catalog().catch(() => null);
        if (now) {
          this.publish(now);
          await this.syncAll(now);
        }
        if (exhausted) throw new SqlError(reason);
        // 行ロックを持つ取引が、書き込み禁止に当たって、この遷移を取り消させた (M24 の WOUND)。待ちの期限のうちなら、同じ DDL を、
        // 新しい遷移でやり直す (RETRY)。新しい遷移は、新しい epoch の prepare を記録し、全部のシャードの ok を集め直す (FRESH_EPOCH)。
        // やり直さないと、DDL の成否が、取引の行の置き場所で決まる。取引の行が 1 つのシャードにあれば、DDL は、取引の確定を待って通る。
        // 行の確かめ (CHECK の試し、UNIQUE の重複) や、期限切れで取り消された遷移は、やり直さない。
        if (withdrawn?.wound && !this.faults.noRetryAfterWound && this.rt.now() < waitUntil) {
          // 欠陥のスイッチ: やり直すたびに期限を数え直す (retryRestartsBudget)。取り消された試みの ok を使い続ける (retrySameEpoch)。
          if (this.faults.retryRestartsBudget) waitUntil = this.rt.now() + DDL_WAIT_MS;
          if (this.faults.retrySameEpoch) stale = [...new Set([...stale, ...acked])];
          continue;
        }
        // 期限で先に abort されていれば、その理由を返す。
        if (withdrawn && withdrawn.reason !== reason) throw withdrawn.wound ? new ConflictError(withdrawn.reason) : new SqlError(withdrawn.reason);
        throw e;
      } finally {
        lease.stop();
      }
      this.publish(committed);
      this.ids.clear();
      // commit を全シャードへ適用させて、書き込みの禁止を早く解く。届かなくても、次の要求が適用させる。
      await this.syncAll(committed);
      return;
    }
  }

  /** 開いた遷移を、prepared の答えを集めて commit まで進める。commit の後のスナップショットを返す。 */
  private async drive(p: Prepared & { epoch: number; before: number }, reads: ReadRecord[], guard: string[], acked: string[], stale: string[]): Promise<Catalog> {
    // 欠陥のスイッチ retrySameEpoch: 取り消された試みで ok と答えたシャード (stale) には、尋ね直さない。
    const shards = shardsOf(p.catalog.routing).filter((id) => !stale.includes(id));
    // 欠陥のスイッチ checkBeforePrepare: 確かめを、シャードが prepare を適用する前に、prepare より前の表定義の epoch を名乗って行う。
    const early = this.faults.checkBeforePrepare === true;
    let at: Ts | undefined;
    if (early) at = await this.work(p, reads, guard, undefined);
    // trial の確かめは prepared そのものである。早すぎる確かめでは、列を適用しないシャードで試す。
    const acks = await this.preparedAll(p.epoch, shards, early && p.mode === "trial", acked);
    if (!early) at = await this.work(p, reads, guard, p.epoch);
    return this.cluster.commit(p.epoch, [...stale, ...acks], at);
  }

  /**
   * 範囲表の全シャードに prepared を尋ね、ok と答えたシャードを返す。どれかが ok でなければ、その理由で失敗する (trial なら SQLite の誤りの文)。
   * 移動の途中のシャードは表定義の記録を適用しないが、Meta は移動が開いている間に prepare を記録しない (M21 の DDL_WAITS_MOVE。段 4 から
   * 列で決まる)。移動が閉じるのは、子が受け取り終え、親が渡し終えた後なので、prepare の後に移動の途中のシャードはない。段 3 までの、
   * 移動の途中のシャードを待って尋ね直す手は消した。そのシャードの誤りは、そのまま DDL の失敗になる。
   */
  private async preparedAll(epoch: number, shards: string[], early: boolean, acked: string[]): Promise<string[]> {
    // 欠陥のスイッチ commitWithoutAcks: 最後のシャードの答えを待たない。
    const pending = this.faults.commitWithoutAcks ? shards.slice(0, -1) : shards;
    // 全部の答えを待ってから、シャードの順で最初の失敗を返す。
    const answers = await Promise.allSettled(pending.map((id) => this.shardOf(id).prepared(early ? { epoch, early: true } : { epoch })));
    // ok と答えたシャードは、失敗する試みの分も、呼び出し側に知らせる (acked。欠陥のスイッチ retrySameEpoch が使う)。
    for (const [i, a] of answers.entries()) if (a.status === "fulfilled" && a.value.ok) acked.push(pending[i]!);
    const acks: string[] = [];
    for (const [i, a] of answers.entries()) {
      const id = pending[i]!;
      if (a.status === "rejected") throw a.reason;
      if (!a.value.ok) throw new SqlError(a.value.reason ?? `shard ${id} did not prepare the schema change`);
      acks.push(id);
    }
    return acks;
  }

  /**
   * mode ごとの、commit の前の仕事。atLeast は、確かめの要求が運ぶ prepare の epoch で、シャードは、そこまで列を適用してから答える
   * (prepare は、どのものの epoch も進めないので、deps では運べない)。欠陥のスイッチ checkBeforePrepare では運ばず、シャードは prepare を
   * 適用せずに答える。build なら、index を公開する commit が運ぶ時刻を返す。
   */
  private async work(p: Prepared & { epoch: number }, reads: ReadRecord[], guard: string[], atLeast: number | undefined): Promise<Ts | undefined> {
    if (p.mode === "build") {
      const def = p.ddl!.defs[0]!;
      const ix = def.globalIndexes.at(-1)!;
      // 欠陥のスイッチ: 既存の行の項目を書く前に commit する。
      if (this.faults.publishBeforeBackfill) return 0;
      const { entries, at } = await this.scanForIndex(p.catalog.tables[def.name] ?? def, ix, p.epoch, atLeast);
      const written = await this.writeIndex(ix, entries, p.epoch);
      return Math.max(at, written);
    }
    if (p.mode === "guard") {
      // 取引が読んだ範囲を持つシャードごとに、読んだ後に変更がないかを確かめる。シャードは prepare を適用した後で答えるので
      // (intent を決着させ、以後の書き込みを断る)、ここで変更がなければ、表を消すまで読んだ範囲は変わらない (M21 の guardHolds)。
      const names = new Set(guard);
      for (const r of reads) {
        const spans = r.spans.filter((s) => names.has(s.table));
        if (spans.length === 0) continue;
        const res = await this.shardOf(r.shard).unchanged({ spans, from: r.from, ...(atLeast === undefined ? {} : { atLeast }) });
        if (!res.ok) {
          throw new ConflictError(`another connection wrote to ${guard.join(", ")} after this transaction read it (${res.reason}); nothing was dropped, run the change again`);
        }
      }
    }
    return undefined;
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
   * 開いている遷移の期限を、期限の半分ごとに延ばし続ける (meta.ts の LEASE_MS)。期限の長さは Meta が返す。
   * 最初の延長は、すぐに行う。それまでは期限の長さを知らないからである。
   * 作業の段ごとではなく時計で延ばすのは、1 つの要求が長くかかる間 (シャードが取引の決着を待つ、など) も、延ばし続けるためである。
   * この呼び出しが止まれば、延長も止まり、Meta が abort する。延長が断られたら (もう abort された)、そこでやめる。
   */
  private keepLease(epoch: number): { stop(): void } {
    let stopped = false;
    let handle: unknown;
    const tick = () => {
      if (stopped) return;
      this.cluster.renew(epoch).then(
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

  /** epoch の遷移が、まだ開いているか。abort されていれば、その理由で失敗させる。 */
  private async stillOpen(epoch: number): Promise<Catalog> {
    const cat = await this.cluster.catalog();
    if (cat.open?.epoch === epoch) return cat;
    throw new SqlError(cat.aborted?.of === epoch ? cat.aborted.reason : `CREATE INDEX: the schema change of epoch ${epoch} was withdrawn while the index was being built`);
  }

  /**
   * 全シャードの行を読んで、index の項目を集める。値ごとに 1 行。同じ値を持つ行が 2 つあれば失敗する。
   * 返す at は、読んだシャードの時計の最大である。index を使わずに確定した書き込みは、どれもこの時刻以下である。
   * 行のないシャードも読む。そのシャードで行を消した書き込みの時刻も、at に入れなければならないからである。
   * 遷移が開いている間は、分割が始まらない (保守の操作の枠)。範囲表は変わらないので、1 度読めば足りる。
   */
  private async scanForIndex(
    def: TableDef, ix: GlobalIndexDef, epoch: number, atLeast: number | undefined,
  ): Promise<{ entries: Map<string, { pk: string; sk: string }>; at: Ts }> {
    const cat = await this.stillOpen(epoch);
    const entries = new Map<string, { pk: string; sk: string }>();
    let at: Ts = 0;
    for (const shard of shardsOf(cat.routing)) at = Math.max(at, await this.scanShard(def, ix, shard, cat, entries, atLeast));
    return { entries, at };
  }

  /**
   * 1 シャードの行を主キーの順に少しずつ読む。読んだ時点のシャードの時計を返す。要求は prepare の epoch を運ぶ (atLeast)。
   * シャードは、その epoch まで列を適用してから答えるので、読んだ時点で、そのシャードの行は止まっている。
   */
  private async scanShard(
    def: TableDef, ix: GlobalIndexDef, shard: string, cat: Catalog, entries: Map<string, { pk: string; sk: string }>, atLeast: number | undefined,
  ): Promise<Ts> {
    // 要るのは、行の同一性 (主キーと shard key) と、index の列だけである。
    const names = [...new Set([...def.pk, ...def.shardKey, ...ix.columns])];
    const cols = names.map(q).join(", ");
    const pkCols = def.pk.map(q).join(", ");
    let after: Value[] | null = null;
    let at: Ts = 0;
    for (;;) {
      const spans = withClaims(cat.routing, shard, [tableSpan(def.name)]);
      const res = await this.shardOf(shard).exec({
        sql: `SELECT ${cols} FROM ${q(def.name)} ${after ? `WHERE (${pkCols}) > (${def.pk.map(() => "?").join(", ")})` : ""} ORDER BY ${pkCols} LIMIT ${BUILD_PAGE}`,
        columns: names, params: after ?? [], spans, deps: depsOf(cat, this.faults, spans), epoch: cat.epoch, ...(atLeast === undefined ? {} : { atLeast }),
      });
      if (res.error !== undefined) throw new SqlError(res.error);
      // 欠陥のスイッチ scanSkipsEmpty: 行のないシャードは、読まなかったのと同じく、その時計を公開の時刻に入れない。
      if (!(this.faults.scanSkipsEmpty && after === null && res.values.length === 0)) at = Math.max(at, res.T, res.hlc);
      // 行は型のある値のまま使う (D1 と同じ形の rows は、2^53 を超える INTEGER を誤りにする)。
      const rows = res.values.map((v): Row => Object.fromEntries(names.map((c, i) => [c, v[i] ?? null])));
      for (const row of rows) {
        const vals = ix.columns.map((col) => row[col] ?? null);
        if (vals.some((v) => v === null)) continue; // NULL のある値は、どの行とも衝突しない
        const k = keyString(vals);
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
  private async writeIndex(ix: GlobalIndexDef, entries: Map<string, { pk: string; sk: string }>, epoch: number): Promise<Ts> {
    let at: Ts = 0;
    let left = [...entries].map(([k, row]) => ({ k, ...row }));
    let cat = await this.stillOpen(epoch);
    for (let attempt = 0; left.length > 0; ) {
      const owner = ownerOf(cat.routing, keyString([left[0]!.k]));
      const batch = left.filter((e) => ownerOf(cat.routing, keyString([e.k])) === owner).slice(0, BUILD_BATCH);
      const tx = new Txn(this, cat, this.nextTxnId());
      try {
        const ks = batch.map((e) => e.k);
        // 値の一覧は 1 つの引数で渡す。1 つずつ渡すと、文に付けられる引数の数の上限 (100) に当たる。
        const found = await tx.call(owner, {
          sql: `SELECT "k", "pk" FROM ${q(ix.table)} WHERE "k" IN (SELECT value FROM json_each(?))`, columns: ["k", "pk"],
          params: [JSON.stringify(ks)],
          spans: ks.map((k) => rowSpan(ix.table, keyString([k]), keyString([k]))),
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
        // 範囲が移った、などの一時的な失敗。範囲表を取り直して、同じ項目からやり直す。abort されていれば、ここで失敗する。
        if (!isRetryable(e) || attempt++ >= BUILD_RETRIES) throw e;
        this.onRetry(e);
        await backoff(this.rt, attempt);
        cat = await this.stillOpen(epoch);
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
        // 表定義の変更が、表への書き込みを止めている。その遷移が閉じるのを待つ。
        const lock = tableLockOf(e);
        if (lock && !(await this.transitionClosed(lock.epoch))) fail();
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
    // 前の区切りで読んだ範囲。読んだ表を DROP するときに確かめる (Db.changeSchema の mode guard)。
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
      this.committed(done!);
    };
    for (const s of statements) {
      if (!changesSchema(s.sql)) {
        part.push({ sql: s.sql, params: s.params ?? [] });
        continue;
      }
      await flush();
      // 1 文の DDL は、読んだ範囲を渡して実行する。複数の文を含むものは、1 文ずつ取引の外で実行する。
      const one = parseStatements(s.sql).length === 1;
      if (one && !this.current) {
        await this.ddl(s.sql, reads);
        out.push(new QueryResult([], []));
      } else out.push(await this.query(s.sql, s.params ?? []));
    }
    await flush();
    return out;
  }

  /** 接続の取引が確定したことを、試験の観察者 (opts.onCommit) に知らせる。 */
  private committed(tx: Txn): void {
    this.opts.onCommit?.({ at: tx.commitTs ?? tx.T, readOnly: tx.commitTs === undefined });
  }

  /**
   * 表への書き込みを止めている遷移 (prepare の epoch) が閉じる (commit か abort が記録される) のを待つ。閉じた後のスナップショットを返す。
   * 待ち切れなければ null を返す。
   * 表定義の遷移の prepare から commit か abort まで、シャードは fence の表への書き込みを断る。遷移には期限があるので、待てば必ず閉じる。
   * 段 3 までは、表定義全体の epoch が進むのを待った。commit だけが epoch を進める形では、abort の後に epoch が進まないので、遷移を見る。
   */
  private async transitionClosed(epoch: number): Promise<Catalog | null> {
    const deadline = this.rt.now() + (this.opts.schemaWaitMs ?? SCHEMA_WAIT_MS);
    for (let i = 0; ; i++) {
      this.cached = null;
      const cat = await this.catalog();
      if (cat.open?.epoch !== epoch) return cat;
      if (this.rt.now() >= deadline) return null;
      await sleep(this.rt, Math.min(1000, 10 * 2 ** i));
    }
  }

  get inTransaction(): boolean {
    return this.current !== null;
  }

  /**
   * 実行中の取引を捨てる。取引が取った行ロックを、ここで手放す (sqld も、ストリームを閉じると取引を巻き戻す)。
   * 手放さないと、ほかの接続の書き込みが、ロックの期限 (5 秒) まで待たされる (test/closed-stream-locks.test.ts)。
   * 呼び出し側が消えて、閉じる要求も届かない取引のロックは、期限で切れる。
   */
  abandon(): Promise<void> {
    const tx = this.current;
    this.current = null;
    return tx ? tx.unlockAll().catch(() => undefined) : Promise.resolve();
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
    if (cat.schema < d.tx.schema) {
      this.cached = null;
      cat = await this.catalog();
    }
    this.current = await Txn.load(this, cat, d.tx);
  }

  /** 文を実行する。`;` で区切った複数の文を渡すと順に実行し、最後の結果を返す。 */
  async query(sql: string, params: Params = []): Promise<QueryResult> {
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
    let rerouted = 0;
    let lockWaits = 0;
    for (let attempt = 0; ; attempt++) {
      info.attempts = attempt + 1;
      // 取引の中の文は、取引の表定義で計画する (Txn.catalog)。
      const txn = this.current;
      const cat = txn?.catalog ?? (await this.catalog());
      // この試みの採番。文が失敗したら戻す (Taken)。SQLite でも失敗した INSERT は rowid を消費しない。
      const taken = new Taken();
      try {
        const fresh = attempt === 0 ? stmt : parseStatements(source)[0];
        const ctx = this.current ? this.current.planContext(taken) : this.planContext(cat, taken);
        return await runPlanned(fresh, source, params, cat, ctx, async (p) => {
          // 計画の途中で表を読む文は、読みと書き込みを 1 つの取引にする。試みごとに、取引の表定義で計画し直す。
          if (p.kind === "inTxn") {
            let at: (() => Ts | undefined) | undefined;
            const r = await this.transaction(async (tx) => {
              at = () => tx.commitTs ?? tx.T;
              return tx.statement(parseStatements(source)[0], params, taken);
            });
            return new QueryResult(r.columns, r.values, r.changes, r.lastInsertRowid, r.ts ?? at?.());
          }
          return this.dispatch(p, cat, { source, params, taken });
        }, (p) => (info.plan = p.kind));
      } catch (e) {
        this.giveBack(taken.list);
        // 文が取引を終えたか、別の取引に替えた (取引の中の DDL)。前の取引の分は、もう確定したか、失われた。やり直さない。
        // やり直すと、取引の外の文として、DDL だけが効く (specs/m13_txn_schema_boundary.qnt の m13_red_ddl_anyway)。
        if (txn && this.current !== txn) {
          if (isRetryable(e)) this.onRetry(e);
          throw e;
        }
        // 取引の中の文が、範囲の移動で断られた。表定義が同じ新しい範囲表があれば、取引の範囲表を取り替え、文を計画し直す
        // (Txn.reroute)。断られた試みの要求は送り直さない。COMMIT は計画し直す文ではない。
        if (txn && stmt.type !== "commit_transaction_stmt" && rerouted < REROUTES && (await txn.reroute(e, cat))) {
          rerouted++;
          continue;
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
        // 表定義の変更が、表への書き込みを止めている (列を足している最中、index を作っている最中、DROP の前)。その遷移が閉じるのを待って、
        // やり直す。待ち切れなければ (SCHEMA_WAIT_MS)、やり直さずに誤りを返す。
        // 何もしていない取引と、取引の外の文は、新しい表定義で計画し直す。読むか書くかした取引は、自分の表定義のまま、同じ文を送り直す。
        // DDL が失敗していれば、文はそのまま通る (失敗した DDL は何も変えない)。確定していれば、その表の epoch が進んでいるので、シャードが
        // 古い計画として断る (docs/design-catalog-epoch.md の「表ごとの epoch」の「Worker」)。COMMIT は計画し直す文ではない。
        if (isTableLocked(e)) {
          const lock = tableLockOf(e);
          // 取引が、その表の行ロックを (ほかのシャードに) 持っている。DDL は、そのロックを待っているので、取引が禁止の解けるのを待つと、
          // 互いを DDL の待ちの期限まで待つ。取引は待たずに、Meta に、その遷移を取り消させる (M24 の WOUND)。断ったシャードは、断るときに、
          // 文が書こうとした行のロックを取引に与えている (HOLD)。DDL を進める側は、同じ待ちの期限の中で、新しい遷移でやり直す (RETRY)。
          // 取引の文は、取り消しの往復だけ待って、やり直す。
          if (lock && txn && this.current === txn && txn.holdsLocksOn(lock.table) && !this.faults.noWound && stmt.type !== "commit_transaction_stmt" && lockWaits++ < LOCK_WAITS) {
            await this.cluster.abort(lock.epoch, `a transaction that holds row locks on ${lock.table} reached the table's write lock on another shard, so the schema change was withdrawn to be run again`, true).catch(() => undefined);
            // 取り消しの後のスナップショットの epoch を運ばせる。断ったシャードは、禁止を解く記録を、取引の次の要求で適用する。
            txn.follow(await this.freshCatalog());
            continue;
          }
          const fresh = lock && stmt.type !== "commit_transaction_stmt" && lockWaits++ < LOCK_WAITS ? await this.transitionClosed(lock.epoch) : null;
          if (fresh && this.current === txn) {
            // 遷移が閉じた後のスナップショットの epoch を運ばせる。シャードは、禁止を解く記録を、その要求で適用する。
            if (txn) txn.untouched ? txn.rebase(fresh) : txn.follow(fresh);
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

  /**
   * 計画を実行する。again は、計画し直すための材料 (文の文面と引数、計画の前の採番の控え) である。
   * 複数のシャードに書く autocommit の文は、取引として実行し、競合や移動で断られたらやり直す (Db.transaction)。やり直す試みの
   * スナップショットが、計画したもの (cat) と違えば (範囲表か表定義が進んだ)、計画は古いので捨て、その試みのスナップショットで
   * 文を計画し直す。古い計画を新しい範囲表で振り分け直すと、まとめた行の文が、別のシャードの行まで書く (未解決の問題 35)。
   * 古い表定義の計画は、足された列を知らない (未解決の問題 38)。スナップショットが同じなら、同じ計画で送り直す (計画は待ちを
   * 含み、採番もするので、競合のたびに計画し直すと、分割も DDL もない実行の RPC の列まで変わる)。
   */
  private async dispatch(p: Plan, cat: Catalog, again: { source: string; params: Params; taken: Taken }): Promise<QueryResult> {
    if (p.kind === "tcl") return this.control(p);
    if (p.kind === "noop") return new QueryResult([], []);
    if (p.kind === "ddl") {
      await this.ddl(p.sql);
      return new QueryResult([], []);
    }
    if (this.current) return this.current.execute(p, again.taken);
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
    // 最初の計画 (p) の採番。計画し直すときに、捨てる計画の番号を戻す (giveBack)。
    let planned: Allocation[] | null = [...again.taken.list];
    const r = await this.transaction(async (tx) => {
      const now = tx.catalog;
      let out: QueryResult;
      // p は cat で計画したものである。試みのスナップショットが cat と違えば、その試みでも、後の試みでも、p は使わない
      // (計画し直した試みが競合で断られた後に p へ戻ると、古い計画を送り直すことになる)。
      if (now.epoch === cat.epoch && now.schema === cat.schema) out = await tx.execute(p, again.taken);
      else {
        // 捨てる最初の計画の採番を戻す (1 度だけ)。計画し直した文の採番は、この試みの控え (again.taken) に入り、文が失敗すれば
        // attemptStatement が戻す。
        if (planned) this.giveBack(planned);
        planned = null;
        out = await tx.statement(parseStatements(again.source)[0], again.params, again.taken);
      }
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
        this.committed(tx);
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
    // 利用者の RETURNING の列名。書き換える前の文を、Worker の SQLite でコンパイルして取る。
    const columns = p.returning ? (await this.compiled(p.returning, cat)).columns : [];
    const res = await this.shardOf(ownerOf(cat.routing, sk)).execAuto({
      sql: t.sql, params: t.params, columns, spans, write: t.write, deps: depsOf(cat, this.faults, spans, { write: [table] }), epoch: cat.epoch, minTs: this.token,
    }).catch(rerouted);
    this.observe(res.hlc);
    return new QueryResult(res.columns, res.values, res.count ?? res.changes.length, lastInsertRowid(cat, res.inserted ?? []), res.T);
  }
}
