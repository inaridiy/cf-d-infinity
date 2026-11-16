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
// 表定義の epoch (Snapshot.schema) は、prepare、commit、abort のどれでも進む (設計書の決めたこと 6)。
import { applyMove, overlaps, shardsOf, type Interval, type Routing } from "./routing";
import type { DdlMode, IndexInfo, ParsedDdl } from "./sql/ddl";
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
  | { kind: "prepare"; mode: DdlMode; ddl: ParsedDdl; fence: string[]; staging?: { sql: string[]; defs: TableDef[] } }
  /**
   * 遷移を確定する。of は終える prepare の epoch で、その prepare の ddl を確定する。at は index を公開する commit が運ぶ時刻で、
   * シャードは、この commit を適用するときに、時計をここまで進める。index を使わずに確定した書き込みは、どれもこの時刻以下である。
   * index を使う文は、この commit を適用したシャードで読むので、この時刻より後になる (M21 の m21_clock、M12 の m12_clock)。
   */
  | { kind: "commit"; of: number; at?: Ts }
  /** 遷移を取り消す。禁止を解くだけで、利用者の表に触る文を持たない。 */
  | { kind: "abort"; of: number; reason: string }
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
}

/** 開いている移動。epoch は、その move-start の epoch。 */
export interface OpenMove extends Move {
  epoch: number;
}

export interface Snapshot {
  /** 畳んだ最後の epoch。 */
  epoch: number;
  /** 表定義が最後に変わった epoch。prepare、commit、abort の記録で進み、移動の記録では進まない (設計書の決めたこと 6)。 */
  schema: number;
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
  aborted?: { of: number; reason: string };
}

/** 表定義の記録か (prepare、commit、abort)。表定義の epoch (Snapshot.schema) は、この記録でだけ進む。 */
export const isDdlRecord = (r: EpochRecord): boolean => r.kind === "prepare" || r.kind === "commit" || r.kind === "abort";

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
export function fold(log: readonly Logged[], upTo = Number.POSITIVE_INFINITY): Snapshot {
  const s: Snapshot = {
    epoch: 0, schema: 0, tables: {}, views: {}, indexes: {}, ddl: [], open: null, opens: [],
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
    if (isDdlRecord(rec)) {
      s.schema = epoch;
      delete s.aborted;
    }
    switch (rec.kind) {
      case "genesis":
        s.routing = rec.routing;
        break;
      case "prepare": {
        const o: OpenDdl = { epoch, mode: rec.mode, fence: rec.fence, ddl: rec.ddl };
        if (rec.staging) o.staging = rec.staging;
        s.opens = [...s.opens, o];
        s.open = o;
        // 内部の表 (index の表) は、prepare から表定義に載る。進める側が、commit の前に、ここへ項目を書くからである。
        // 利用者の文からは見えない (内部の名前で、Worker の SQLite で再生する履歴にもない)。
        for (const d of rec.staging?.defs ?? []) s.tables[d.name] = d;
        break;
      }
      case "commit": {
        const o = close(s, epoch, rec.of, "commit");
        applyParsed(s, o.ddl);
        if (o.ddl.user) s.ddl = [...s.ddl, o.ddl.user];
        break;
      }
      case "abort": {
        const o = close(s, epoch, rec.of, "abort");
        for (const d of o.staging?.defs ?? []) delete s.tables[d.name];
        s.aborted = { of: rec.of, reason: rec.reason };
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
  return s.opens.find((o) => o.fence.includes(table)) ?? null;
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
