// Meta の epoch の列と、その畳み込み (docs/design-catalog-epoch.md)。
//
// Meta は、表定義の変更と範囲表の切り替えを、追記だけの 1 本の列 (Meta の表 __epoch(epoch, rec)) に記録する。1 行が 1 つの epoch で、
// epoch e のスナップショット (表定義、表の状態、範囲表) は、列の先頭から e までを畳んだものである。畳み込みと、記録を足せる条件
// (M21、specs/m21_catalog_epoch.qnt の Meta の手) を、副作用のない関数としてここに置く。
//
// 段 1 (いま) の Meta が書く記録は 3 種類である。
//   commit (of なし)  表定義の版 1 つ。今の DdlEntry をそのまま持つ。index の作成と公開、DROP の前の書き込み禁止と DROP、
//                     取り消し (逆操作の文を持つ次の版) も、それぞれ 1 つの commit である
//   move-start        範囲表の切り替え (MetaCore.switchRange)
//   move-end          分割の枠を返すこと (MetaCore.endSplit)
// epoch 0 は最初の範囲表 (genesis) で、Meta が最初に範囲表を引いたときに書く。
//
// prepare、abort、prepare を終える commit (of のある commit) は、段 3 で Meta が書き始める。M21 の遷移の条件と突き合わせるために
// (test/catalog-m21.test.ts)、型と畳み込みと条件 (refusal) は、いまから 5 種類を持つ。段 1 の Meta は refusal を呼ばない。
// 記録を足してよいかは、今の仕組み (分割の枠、期限、basedOn、最新の版の確認) が決める。枠は範囲表の切り替えより前に取られ、
// 記録を残さずに期限で消えるので、列だけからは決められないからである。
import { applyMove, overlaps, shardsOf, type Interval, type Routing } from "./routing";
import type { IndexInfo, ParsedDdl } from "./sql/ddl";
import type { TableDef, Ts } from "./types";

/** 表定義の版。段 1 の commit の記録が、この形のまま運ぶ。シャードは MetaCore.ddlSince で受け取り、__ddl に写す。 */
export interface DdlEntry extends ParsedDdl {
  version: number;
  /** この版が取り消す版。取り消された版をまだ適用していないシャードは、両方を飛ばす。 */
  reverts?: number;
  /** 取り消しの理由。シャードが適用に失敗したときの SQLite のメッセージ。 */
  reason?: string;
  /** 取引が読んだ表を DROP する前に、その表を書き込み禁止にする版。次の版が、その DROP か、取り消しである (finishLock)。 */
  guard?: { tables: string[] };
  /**
   * index を公開する版が運ぶ時刻。シャードは、この版を適用するときに、時計をここまで進める。
   * index を使わずに確定した書き込みは、どれもこの時刻以下である。index を使う文は、この版を適用したシャードで読むので、
   * この時刻より後になる。公開が、時刻の順の中の 1 点になる (specs/m12_unique_index_build.qnt の m12_clock)。
   */
  at?: Ts;
}

/** prepare の進め方 (設計書の「表定義の遷移」の表)。 */
export type DdlMode = "plain" | "trial" | "build" | "guard";

/** 範囲の移動。from は渡す側で、段 1 の switchRange は from を省けるので、区間の持ち主が 1 つに決まらなければ持たない。 */
export interface Move extends Interval {
  from?: string;
  to: string;
}

export type EpochRecord =
  /** epoch 0。最初の範囲表。 */
  | { kind: "genesis"; routing: Routing }
  /** 表定義の遷移を開く (段 3)。fence の表を書き込み禁止にする。ddl は commit で確定する。 */
  | { kind: "prepare"; mode: DdlMode; ddl: ParsedDdl; fence: string[] }
  /** 段 1 の形。それだけで、表定義の版 1 つを記録する。 */
  | { kind: "commit"; ddl: DdlEntry }
  /** 遷移を確定する (段 3)。of は終える prepare の epoch で、その prepare の ddl を確定する。 */
  | { kind: "commit"; of: number; at?: Ts }
  /** 遷移を取り消す (段 3)。禁止を解くだけで、利用者の表に触る文を持たない。 */
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
  /** 段 1 では、遷移を開いた版 (index の作成か、DROP の前の書き込み禁止)。段 3 では、prepare の ddl。 */
  ddl: ParsedDdl | DdlEntry;
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
  /**
   * 段 1 の間だけ持つ、表定義の版 (DdlEntry.version。今の Catalog.version)。シャードと Worker が比べるのは、まだこれである。
   * 要求が epoch を運ぶのは段 2 からである。of のある commit (段 3) は、版を進めない。
   */
  version: number;
  tables: Record<string, TableDef>;
  views: Record<string, string>;
  indexes: Record<string, IndexInfo>;
  /** Worker の SQLite で再生する DDL の履歴。 */
  ddl: string[];
  /** 開いている表定義の遷移。 */
  open: OpenDdl | null;
  /** 範囲表。版は、最初の範囲表の版に、それまでの move-start の数を足したもの (今の Routing.version)。 */
  routing: Routing;
  /** 開いている移動 (move-start の後、move-end の前)。設計書の routing.ranges[].moving の代わりに、範囲表とは別に持つ。 */
  moves: OpenMove[];
  /** 段 1: 最後の表定義の版が取り消しなら、取り消された版と理由 (今の Catalog.revoked)。 */
  revoked?: { version: number; reason: string };
  /** 段 3: 最後の表定義の記録が abort なら、その遷移と理由。 */
  aborted?: { of: number; reason: string };
}

const isDdlRecord = (r: EpochRecord): boolean => r.kind === "prepare" || r.kind === "commit" || r.kind === "abort";

/** 表定義の変更を、表定義と index と view に当てる。順番は今の MetaCore.current と同じ。 */
function applyParsed(s: Snapshot, d: ParsedDdl): void {
  for (const t of d.defs) s.tables[t.name] = t;
  for (const n of d.drops) delete s.tables[n];
  Object.assign(s.views, d.views);
  for (const n of d.dropViews ?? []) delete s.views[n];
  Object.assign(s.indexes, d.indexes);
  for (const n of d.dropIndexes ?? []) delete s.indexes[n];
}

/** 段 1 の版が開く遷移。index の作成と、DROP の前の書き込み禁止だけが、次の版まで表への書き込みを止める。 */
function opensWith(epoch: number, e: DdlEntry): OpenDdl | null {
  if (e.build) return { epoch, mode: "build", fence: [e.build.table], ddl: e };
  if (e.guard) return { epoch, mode: "guard", fence: e.guard.tables, ddl: e };
  return null;
}

/**
 * 列を、先頭から upTo の epoch まで畳む。列は epoch の昇順で、epoch は 0 (genesis) か 1 から 1 ずつ増える。
 * 列が壊れていれば (番号が飛ぶ、開いていない遷移を終える、開いていない移動を閉じる) 投げる。記録を足す前に refusal と
 * Meta の今の確かめを通していれば、起きない。
 */
export function fold(log: readonly Logged[], upTo = Number.POSITIVE_INFINITY): Snapshot {
  const s: Snapshot = {
    epoch: 0, schema: 0, version: 0, tables: {}, views: {}, indexes: {}, ddl: [], open: null,
    routing: { version: 0, ranges: [] }, moves: [],
  };
  // Worker で再生する文と、その文を記録した版。取り消しの版は、取り消された版の文を除き、自分の文も足さない (段 1)。
  const replay: { version: number | null; user: string }[] = [];
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
      delete s.revoked;
      delete s.aborted;
    }
    switch (rec.kind) {
      case "genesis":
        s.routing = rec.routing;
        break;
      case "prepare":
        s.open = { epoch, mode: rec.mode, fence: rec.fence, ddl: rec.ddl };
        break;
      case "commit":
        if ("ddl" in rec) {
          const e = rec.ddl;
          applyParsed(s, e);
          s.version = e.version;
          if (e.reverts !== undefined) {
            const i = replay.findIndex((x) => x.version === e.reverts);
            if (i >= 0) replay.splice(i, 1);
            s.revoked = { version: e.reverts, reason: e.reason ?? "" };
          } else if (e.user) {
            replay.push({ version: e.version, user: e.user });
          }
          // 段 1 では、最新の版が index の作成か書き込み禁止であるときだけ、遷移が開いている (今の MetaCore.building)。
          s.open = opensWith(epoch, e);
        } else {
          const open = s.open;
          if (open?.epoch !== rec.of) throw new Error(`the epoch log is broken: epoch ${epoch} commits epoch ${rec.of}, which is not open`);
          applyParsed(s, open.ddl);
          if (open.ddl.user) replay.push({ version: null, user: open.ddl.user });
          s.open = null;
        }
        break;
      case "abort":
        if (s.open?.epoch !== rec.of) throw new Error(`the epoch log is broken: epoch ${epoch} aborts epoch ${rec.of}, which is not open`);
        s.open = null;
        s.aborted = { of: rec.of, reason: rec.reason };
        break;
      case "move-start": {
        s.routing = applyMove(s.routing, rec);
        const m: OpenMove = { epoch, to: rec.to, start: rec.start, end: rec.end };
        if (rec.from !== undefined) m.from = rec.from;
        s.moves = [...s.moves, m];
        break;
      }
      case "move-end":
        if (!s.moves.some((m) => m.epoch === rec.of)) throw new Error(`the epoch log is broken: epoch ${epoch} ends the move of epoch ${rec.of}, which is not open`);
        s.moves = s.moves.filter((m) => m.epoch !== rec.of);
        break;
    }
  }
  s.ddl = replay.map((x) => x.user);
  return s;
}

/** 分割の枠の名前 (MetaCore.beginSplit が付ける)。段 1 の endSplit が、どの移動を閉じるかを、これで引く。 */
export const splitId = (m: { parent: string; child: string; start: number; end: number }): string =>
  `split:${m.parent}:${m.child}:${m.start}:${m.end}`;

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
 * 条件と同じものである。acks は、of のある commit を記録する前に、進める側が集めた ok のシャードである。
 * 移動の中身の条件 (子が受け取り終えた後でだけ move-end を記録する、M21 の END_AFTER_DRAIN) は、列からは決まらない。段 4 で、
 * 受け取り終えた子が自分で move-end を記録させることで守る。
 * 段 1 の commit (of なし) の条件は、今の Meta が決めるので、ここでは扱わない (投げる)。
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
      if (!("of" in rec)) throw new Error("a commit without of is a stage 1 version; MetaCore checks it, not refusal");
      if (s.open?.epoch !== rec.of) return { rule: "one-exit", of: rec.of };
      // prepare から終わりまで、範囲表のシャードは変わらない (遷移が開いている間は move-start を記録しない)。
      const missing = shardsOf(s.routing).filter((x) => !acks.includes(x));
      return missing.length > 0 ? { rule: "all-acks", missing } : null;
    }
    case "abort":
      return s.open?.epoch === rec.of ? null : { rule: "one-exit", of: rec.of };
    case "move-start": {
      if (s.open) return { rule: "move-waits-ddl", open: s.open };
      const owners = [...new Set(s.routing.ranges.filter((x) => overlaps(x, rec)).map((x) => x.shard))];
      if (!(owners.length === 1 && owners[0] === rec.from)) return { rule: "owner", owners };
      const ends = [rec.from, rec.to];
      const clash = s.moves.filter((m) => overlaps(m, rec) || ends.includes(m.to) || (m.from !== undefined && ends.includes(m.from)));
      if (clash.length > 0) return { rule: "moves-overlap", moves: clash };
      if (s.routing.ranges.some((x) => x.shard === rec.to)) return { rule: "child-owns" };
      return null;
    }
    case "move-end":
      return s.moves.some((m) => m.epoch === rec.of) ? null : { rule: "move-not-open", of: rec.of };
  }
}
