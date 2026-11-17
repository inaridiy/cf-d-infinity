// Meta の epoch の列と、その畳み込み (docs/design-catalog-epoch.md)。
//
// Meta は、表定義の変更と範囲表の切り替えを、追記だけの 1 本の列 (Meta の表 __epoch(epoch, rec)) に記録する。1 行が 1 つの epoch で、
// epoch e のスナップショット (表定義、表の状態、範囲表) は、列の先頭から e までを畳んだものである。畳み込みと、記録を足せる条件
// (M21、specs/m21_catalog_epoch.qnt の Meta の手) を、副作用のない関数としてここに置く。Meta、シャード、Worker が同じ関数で畳む。
//
// 記録は 6 種類である。
//   genesis     epoch 0。最初の範囲表。Meta が最初に範囲表を引いたときに書く。
//   prepare     表定義の遷移を開く (段 3)。fence の表への書き込みを止める。ddl は、まだ表定義に入らない。
//   commit      遷移を確定する。of は終える prepare の epoch で、その prepare の ddl を表定義に入れる。
//   abort       遷移を取り消す。禁止を解き、prepare が作った内部の表 (staging) を消すだけで、利用者の表に触る文を持たない。
//   move-start  範囲の移動を開く (MetaCore.startMove。段 4)。範囲表の切り替えであり、親の fence であり、子の受け取りの始まりである。
//   move-end    移動を閉じる (MetaCore.endMove)。子が受け取り終えた後で、子が記録させる。
// 表定義の epoch は、表と view ごとに持つ (Snapshot.objects。設計書の「表ごとの epoch」、モデル M24)。進むのは commit の記録だけで、
// 進むのは、その DDL が変えたもの (ParsedDdl.changes) の epoch だけである。prepare と abort は、どの epoch も進めない (決めたこと 6 を
// 2026-11-17 に改めた)。失敗した DDL は、触った表の取引も古くしない。prepare が作る内部の表 (staging) だけは、prepare の epoch で生まれる。
import { applyMove, overlaps, shardsOf, type Interval, type Routing } from "./routing";
import { isInternalName, type DdlChanges, type DdlMode, type IndexInfo, type ParsedDdl } from "./sql/ddl";
import type { TableDef, Ts } from "./types";

export type { DdlMode } from "./sql/ddl";

/** 範囲の移動。from は渡す側 (親)、to は受け取る側 (子) である。 */
export interface Move extends Interval {
  from: string;
  to: string;
}

export type EpochRecord =
  /** epoch 0。最初の範囲表。 */
  | { kind: "genesis"; routing: Routing }
  /**
   * 表定義の遷移を開く。fence の表を書き込み禁止にする。ddl は commit で確定する。staging は、prepare を適用したシャードが作る
   * 内部の表で、abort を適用したシャードが名前で消す (ParsedDdl.staging)。
   */
  | {
      kind: "prepare"; mode: DdlMode; ddl: ParsedDdl; fence: string[]; staging?: { sql: string[]; defs: TableDef[] };
      /**
       * DDL の待ちの期限 (進める側の時計の時刻、ms)。fence の表に行ロックがある間、シャードは、この時刻まで prepare の適用を待つ
       * (設計書の「表ごとの epoch」の「シャード」の行ロック、M24 の WAIT_LOCKS)。DDL を始めてから、busy_timeout と同じ 5 秒である。
       * やり直しの prepare も、最初の試みの期限を運ぶ (KEEP_BUDGET)。ない記録は、待たない。
       */
      waitUntil?: number;
      /**
       * やり直しの prepare である。値は、その DDL の最初の試みの prepare の epoch (何度やり直しても同じ)。Meta が、取り消させる手 (wound) の
       * abort と同じ 1 手で記録する (M24c の ONE_RESTART)。DDL が始まってから終わるまで、開いている試みのない時がない。進める側は、
       * 自分の DDL のやり直しを、これで見分けて、引き継ぐ (MetaCore.abort の答えの next、Catalog.open.retryOf)。
       */
      retryOf?: number;
    }
  /**
   * 遷移を確定する。of は終える prepare の epoch で、その prepare の ddl を確定する。at は index を公開する commit が運ぶ時刻で、
   * シャードは、この commit を適用するときに、時計をここまで進める。index を使わずに確定した書き込みは、どれもこの時刻以下である。
   * index を使う文は、この commit を適用したシャードで読むので、この時刻より後になる (M21 の m21_clock、M12 の m12_clock)。
   */
  | { kind: "commit"; of: number; at?: Ts }
  /**
   * 遷移を取り消す。禁止を解くだけで、利用者の表に触る文を持たない。wound は、fence の表の行ロックを持つ取引が、書き込み禁止に当たって
   * 取り消させた印である (M24 の WOUND)。Meta は、この印のある取り消しのすぐ後ろに、同じ 1 手で、やり直しの prepare (retryOf) を記録する
   * (M24c の ONE_RESTART)。DDL を進める側は、待ちの期限のうちなら、それを引き継ぐ。
   */
  | { kind: "abort"; of: number; reason: string; wound?: true }
  | ({ kind: "move-start" } & Move)
  /** 移動を閉じる。of は、その移動の move-start の epoch。 */
  | { kind: "move-end"; of: number };

export interface Logged {
  epoch: number;
  rec: EpochRecord;
}

/** 開いている表定義の遷移。書き込み禁止の表は fence である。 */
export interface OpenDdl {
  epoch: number;
  mode: DdlMode;
  fence: string[];
  /** prepare の ddl。commit が表定義に入れる。 */
  ddl: ParsedDdl;
  staging?: { sql: string[]; defs: TableDef[] };
  /** やり直しの試みなら、その DDL の最初の試みの prepare の epoch (prepare の記録の retryOf)。 */
  retryOf?: number;
}

/** 開いている移動。epoch は、その move-start の epoch。 */
export interface OpenMove extends Move {
  epoch: number;
}

/** 表か view の epoch。view は、2 つが同じ値である。 */
export interface ObjectEpochs {
  /** 読みの epoch。その表の読みが返すものか、古い時刻の行を読み戻せるかを変えた、最後の commit の epoch。 */
  read: number;
  /** 書き込みの epoch。読みの epoch を進める commit に加えて、その表の index を作るか消した commit でも進む。 */
  write: number;
}

/** 名前を、ものの epoch を引く鍵にする。SQLite の名前は、大文字と小文字を区別しない。 */
export const objectKey = (name: string): string => name.toLowerCase();
/**
 * 表定義の全体を表す、ものの名前。その epoch は、Snapshot.schema (どれかの DDL が最後に確定した epoch) である。どの表を読むか分からない
 * 要求 (表の名前が "*" の範囲) と、欠陥のスイッチ globalSchemaEpoch (段 3 の形。M24 の m24_red_global) が、これに頼る。
 */
export const ALL_OBJECTS = "*";

export interface Snapshot {
  /** 畳んだ最後の epoch。 */
  epoch: number;
  /**
   * どれかの DDL が最後に確定した epoch。commit の記録でだけ進む。Meta の basedOn (文を解釈した表定義が最新か) と、Worker が取引の
   * 表定義を名指すのに使う (TxnDump.schema)。要求の成否は、これではなく、ものごとの epoch (objects) で決まる。
   */
  schema: number;
  /**
   * 表と view の epoch (設計書の「表ごとの epoch」)。鍵は小文字の名前 (objectKey)。消した名前も、消した epoch を持ち続ける。
   * 作り直した表は、より新しい epoch になる。内部の表 (__gidx_<index>) も、名前で持つ。
   */
  objects: Record<string, ObjectEpochs>;
  tables: Record<string, TableDef>;
  views: Record<string, string>;
  indexes: Record<string, IndexInfo>;
  /** Worker の SQLite で再生する DDL の履歴。commit された DDL の文だけが入る。 */
  ddl: string[];
  /** 開いている表定義の遷移。Meta は同時に 1 つしか開かない (M21 の ONE_OPEN)。 */
  open: OpenDdl | null;
  /**
   * 開いている表定義の遷移の全部。Meta の条件が守られていれば、open だけの 1 つか空である。欠陥のスイッチ overlappingTransitions
   * (2 つ目の遷移を開く) を入れた Meta の列も畳めるように、一覧で持つ。書き込み禁止の表は、この全部の fence の和である。
   */
  opens: OpenDdl[];
  /** 範囲表。版は、最初の範囲表の版に、それまでの move-start の数を足したもの (今の Routing.version)。 */
  routing: Routing;
  /** 開いている移動 (move-start の後、move-end の前)。設計書の routing.ranges[].moving の代わりに、範囲表とは別に持つ。 */
  moves: OpenMove[];
  /** 最後の表定義の記録が abort なら、その遷移と理由。DDL を出した側が、失敗を利用者へ返すのに使う。 */
  aborted?: { of: number; reason: string; wound?: true };
}

/** 表定義の記録か (prepare、commit、abort)。シャードは、この記録を、変える表の intent を決着させてから適用する。 */
export const isDdlRecord = (r: EpochRecord): boolean => r.kind === "prepare" || r.kind === "commit" || r.kind === "abort";

/** 畳み込みの欠陥のスイッチ (src/types.ts の Faults の一部)。 */
export interface FoldFaults {
  /**
   * 表定義の epoch を、prepare と abort でも進める (段 3 の形。M24 の m24_red_prepare_advances)。失敗した DDL が、触った表の取引を断る。
   */
  epochOnPrepare?: boolean;
  /**
   * index を作るか消すだけの DDL が、その表の書き込みの epoch を進めない (index を、表とは別のものとして扱う形。M24 の m24_red_index)。
   * index を知らない計画の書き込みが、index の確定の後も通り、index の項目のない行ができる。
   */
  indexAsObject?: boolean;
}

/**
 * DDL が、確定で epoch を進めるもの。both は読みの epoch と書き込みの epoch の両方が進むもの、write は書き込みの epoch だけが進む表である。
 * 畳み込み (advance) と、DDL が待つ表の集合 (fenceOf) は、どちらも、ここから作る。
 */
function advanced(c: DdlChanges, faults: FoldFaults = {}): { both: string[]; write: string[] } {
  return { both: [...c.read, ...c.views], write: faults.indexAsObject ? [] : c.write };
}

/** DDL が変えるものの epoch を、epoch e に進める。 */
function advance(s: Snapshot, d: Pick<ParsedDdl, "changes">, e: number, faults: FoldFaults): void {
  if (!d.changes) return;
  const a = advanced(d.changes, faults);
  for (const n of a.both) s.objects[objectKey(n)] = { read: e, write: e };
  for (const n of a.write) {
    const k = objectKey(n);
    s.objects[k] = { read: s.objects[k]?.read ?? 0, write: e };
  }
}

/**
 * DDL が待つ表の集合 (fence。計画書の不変条件 16、モデル M24c の FENCE_COVERS)。その DDL が確定で書き込みの epoch を進める表のうち、
 * prepare の直前の表定義にある、利用者の表である。prepare は、この表の行ロックが空くのを待ち、prepare から commit か abort まで、
 * この表への書き込みを止める。DDL の種類ごとに並べず、畳み込みが epoch を進めるのと同じ一覧 (advanced) から作る。
 *   書き込みの epoch が進むと、その表を書いた取引の、次の書き込みと COMMIT は、古い計画として断られる。行を書いた取引がロックを持つ間、
 *   DDL のほうが待たなければ、取引が DDL のために失敗する (SQLite では、DDL のほうが、書いた取引を待つ)。
 * 入れないもの。
 *   まだない名前 (作る表、RENAME の新しい名前) と view。行がないので、行ロックもない。
 *   内部の表 (__gidx_<index>)。その行は、元の表を書く取引が、同じ取引で書き、行ロックを取らない。止めると、行ロックを持つ取引の
 *   COMMIT が、index の項目のシャード (元の表の行ロックがなく、prepare をもう適用している) で断られる。成否が、項目の置き場所で
 *   決まる。元の表の fence が、項目を書く取引を待たせ、止める。
 * tables は、prepare の直前のスナップショットの表定義である。返す名前は、表定義にある綴りである。
 */
export function fenceOf(d: Pick<ParsedDdl, "changes">, tables: Readonly<Record<string, unknown>>): string[] {
  if (!d.changes) return [];
  const a = advanced(d.changes);
  const names = new Map(Object.keys(tables).map((n) => [objectKey(n), n]));
  const out: string[] = [];
  for (const n of [...a.both, ...a.write]) {
    const name = names.get(objectKey(n));
    if (name !== undefined && !isInternalName(name) && !out.includes(name)) out.push(name);
  }
  return out;
}
/** 表定義の全体の epoch を進める。 */
function advanceAll(s: Snapshot, e: number): void {
  s.schema = e;
  s.objects[ALL_OBJECTS] = { read: e, write: e };
}

/** 表定義の変更を、表定義と index と view に当てる。 */
function applyParsed(s: Snapshot, d: Pick<ParsedDdl, "defs" | "drops" | "views" | "dropViews" | "indexes" | "dropIndexes">): void {
  for (const t of d.defs) s.tables[t.name] = t;
  for (const n of d.drops) delete s.tables[n];
  Object.assign(s.views, d.views);
  for (const n of d.dropViews ?? []) delete s.views[n];
  Object.assign(s.indexes, d.indexes);
  for (const n of d.dropIndexes ?? []) delete s.indexes[n];
}

/** 遷移を閉じる。of が開いていなければ投げる (列が壊れている)。 */
function close(s: Snapshot, epoch: number, of: number, kind: string): OpenDdl {
  const hit = s.opens.find((o) => o.epoch === of);
  if (!hit) throw new Error(`the epoch log is broken: epoch ${epoch} ${kind}s epoch ${of}, which is not open`);
  s.opens = s.opens.filter((o) => o !== hit);
  s.open = s.opens.at(-1) ?? null;
  return hit;
}

/**
 * 列を、先頭から upTo の epoch まで畳む。列は epoch の昇順で、epoch は 0 (genesis) か 1 から 1 ずつ増える。
 * 列が壊れていれば (番号が飛ぶ、開いていない遷移を終える、開いていない移動を閉じる) 投げる。記録を足す前に refusal を通していれば、
 * 起きない。
 */
export function fold(log: readonly Logged[], upTo = Number.POSITIVE_INFINITY, faults: FoldFaults = {}): Snapshot {
  const s: Snapshot = {
    epoch: 0, schema: 0, objects: {}, tables: {}, views: {}, indexes: {}, ddl: [], open: null, opens: [],
    routing: { version: 0, ranges: [] }, moves: [],
  };
  let last = -1;
  for (const { epoch, rec } of log) {
    if (epoch > upTo) break;
    const expected = last < 0 && rec.kind !== "genesis" ? 1 : last + 1;
    if (epoch !== expected || (rec.kind === "genesis") !== (epoch === 0)) {
      throw new Error(`the epoch log is broken: a ${rec.kind} record at epoch ${epoch} follows epoch ${last}`);
    }
    last = epoch;
    s.epoch = epoch;
    if (isDdlRecord(rec)) delete s.aborted;
    switch (rec.kind) {
      case "genesis":
        s.routing = rec.routing;
        break;
      case "prepare": {
        const o: OpenDdl = { epoch, mode: rec.mode, fence: rec.fence, ddl: rec.ddl };
        if (rec.staging) o.staging = rec.staging;
        if (rec.retryOf !== undefined) o.retryOf = rec.retryOf;
        s.opens = [...s.opens, o];
        s.open = o;
        // 内部の表 (index の表) は、prepare から表定義に載る。進める側が、commit の前に、ここへ項目を書くからである。
        // 利用者の文からは見えない (内部の名前で、Worker の SQLite で再生する履歴にもない)。その表は、prepare の epoch で生まれる。
        for (const d of rec.staging?.defs ?? []) {
          s.tables[d.name] = d;
          s.objects[objectKey(d.name)] = { read: epoch, write: epoch };
        }
        if (faults.epochOnPrepare) {
          advance(s, rec.ddl, epoch, faults);
          advanceAll(s, epoch);
        }
        break;
      }
      case "commit": {
        const o = close(s, epoch, rec.of, "commit");
        applyParsed(s, o.ddl);
        if (o.ddl.user) s.ddl = [...s.ddl, o.ddl.user];
        advance(s, o.ddl, epoch, faults);
        advanceAll(s, epoch);
        break;
      }
      case "abort": {
        const o = close(s, epoch, rec.of, "abort");
        for (const d of o.staging?.defs ?? []) delete s.tables[d.name];
        s.aborted = { of: rec.of, reason: rec.reason, ...(rec.wound ? { wound: true as const } : {}) };
        if (faults.epochOnPrepare) {
          advance(s, o.ddl, epoch, faults);
          advanceAll(s, epoch);
        }
        break;
      }
      case "move-start": {
        s.routing = applyMove(s.routing, rec);
        s.moves = [...s.moves, { epoch, from: rec.from, to: rec.to, start: rec.start, end: rec.end }];
        break;
      }
      case "move-end":
        if (!s.moves.some((m) => m.epoch === rec.of)) throw new Error(`the epoch log is broken: epoch ${epoch} ends the move of epoch ${rec.of}, which is not open`);
        s.moves = s.moves.filter((m) => m.epoch !== rec.of);
        break;
    }
  }
  return s;
}

/** 書き込みを止めている遷移のうち、表 table を fence に持つもの。なければ null。 */
export function fencedBy(s: Pick<Snapshot, "opens">, table: string): OpenDdl | null {
  const key = objectKey(table);
  return s.opens.find((o) => o.fence.some((t) => objectKey(t) === key)) ?? null;
}

/** 開いている遷移の名前。誤りの文 (TableLocked、SchemaBusy、期限切れの abort の理由) に使う。 */
export function describeOpen(o: Pick<OpenDdl, "mode" | "fence" | "ddl">): string {
  if (o.mode === "build") return `CREATE INDEX ${Object.keys(o.ddl.indexes ?? {})[0] ?? ""}`.trim();
  if (o.mode === "guard") return `the lock on ${o.fence.join(", ")} before DROP TABLE`;
  return o.ddl.user ?? "a schema change";
}

/** 記録を足せない理由。M21 の Meta の手の条件のどれに当たるかを rule に書く。 */
export type Refusal =
  /** 表定義の遷移が開いている間に、別の遷移を開く (M21 の ONE_OPEN)。 */
  | { rule: "one-open"; open: OpenDdl }
  /** 移動が開いている間に、表定義の遷移を開く (DDL_WAITS_MOVE)。 */
  | { rule: "ddl-waits-move"; moves: OpenMove[] }
  /** 表定義の遷移が開いている間に、移動を開く (MOVE_WAITS_DDL)。 */
  | { rule: "move-waits-ddl"; open: OpenDdl }
  /** 開いていない遷移を終える (ONE_EXIT)。 */
  | { rule: "one-exit"; of: number }
  /** 範囲表の全シャードの ok がそろう前に確定する (ALL_ACKS)。 */
  | { rule: "all-acks"; missing: string[] }
  /** 移す区間の全体を、渡す側が持っていない。 */
  | { rule: "owner"; owners: string[] }
  /** 開いている移動と、区間か、親か子が重なる。 */
  | { rule: "moves-overlap"; moves: OpenMove[] }
  /** 受け取る側が、もう範囲を持っている。 */
  | { rule: "child-owns" }
  /** 開いていない移動を閉じる。 */
  | { rule: "move-not-open"; of: number }
  /** 最初の範囲表は、空の列の epoch 0 にだけ書ける。 */
  | { rule: "genesis" };

/**
 * スナップショット s (列の最後まで畳んだもの) の後に、記録 rec を足せるか。足せなければ理由を返す。
 * 条件は設計書の「同時に開ける遷移」と「Meta の入口」で、M21 の Meta の手 (prepareOp、commitOp、expire、startSplit、endSplit) の
 * 条件と同じものである。acks は、commit を記録する前に、進める側が集めた ok のシャードである。
 * Meta は、記録を足すたびに、ここで決める (段 3 から表定義の遷移の条件、段 4 から表定義の遷移と移動の排他と、移動の条件)。
 * 移動の中身の条件 (子が受け取り終えた後でだけ move-end を記録する、M21 の END_AFTER_DRAIN) は、列からは決まらない。受け取り終えた
 * 子が自分で move-end を記録させることで守る (kernel.ts の moveStep)。
 */
export function refusal(s: Snapshot, rec: EpochRecord, acks: readonly string[] = []): Refusal | null {
  switch (rec.kind) {
    case "genesis":
      return s.epoch === 0 && s.routing.ranges.length === 0 ? null : { rule: "genesis" };
    case "prepare":
      if (s.open) return { rule: "one-open", open: s.open };
      if (s.moves.length > 0) return { rule: "ddl-waits-move", moves: s.moves };
      return null;
    case "commit": {
      if (!s.opens.some((o) => o.epoch === rec.of)) return { rule: "one-exit", of: rec.of };
      // prepare から終わりまで、範囲表のシャードは変わらない (遷移が開いている間は move-start を記録しない)。
      const missing = shardsOf(s.routing).filter((x) => !acks.includes(x));
      return missing.length > 0 ? { rule: "all-acks", missing } : null;
    }
    case "abort":
      return s.opens.some((o) => o.epoch === rec.of) ? null : { rule: "one-exit", of: rec.of };
    case "move-start": {
      if (s.open) return { rule: "move-waits-ddl", open: s.open };
      const owners = [...new Set(s.routing.ranges.filter((x) => overlaps(x, rec)).map((x) => x.shard))];
      if (!(owners.length === 1 && owners[0] === rec.from)) return { rule: "owner", owners };
      const ends = [rec.from, rec.to];
      const clash = s.moves.filter((m) => overlaps(m, rec) || ends.includes(m.to) || ends.includes(m.from));
      if (clash.length > 0) return { rule: "moves-overlap", moves: clash };
      if (s.routing.ranges.some((x) => x.shard === rec.to)) return { rule: "child-owns" };
      return null;
    }
    case "move-end":
      return s.moves.some((m) => m.epoch === rec.of) ? null : { rule: "move-not-open", of: rec.of };
  }
}
