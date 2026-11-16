// 置き場所の差分の検査の部品 (test/placement-differential.test.ts が使う)。
//
// seed から、取引を 1 つ開く接続と、その文の間に autocommit で書く接続 2 つの台本を作る。同じ台本を、シャードの数と行の置き場所を
// 変えたクラスタで流し、文ごとの答え (行、変更した行の数、誤りの種類)、取引の確定の成否、最後の表の中身を比べる。
// 比べるのは、設計が置き場所に依らないと約束していることだけである (下の「何を比べるか」)。約束のない違いは、数えて報告する。
//
// 台本は置き場所を知らない。キーを持ち主のシャードで選ばない (再現の試験の `on("s0")` のような選び方をしない)。主キーは明示し、
// rowid の採番、lastInsertRowid、REAL の和は使わない。結果の順序は、一意な列の ORDER BY で決める。
//
// 何を比べるか (docs/overview.md の「Time and isolation」、docs/sql-language.md の「取引」):
//   - autocommit の文: 開始前に確定した書き込みを全部見る (読み)、最新の状態に書く (書き込み)。置き場所の全部で同じで、
//     同じ文を直列に流した SQLite と同じでなければならない。
//   - 取引の最初の文: 開始前に確定した書き込みを全部見る。同じく厳密に比べる。
//   - 取引の 2 文目以降: 読む時点 T は、最初のスナップショットのままか、それより後へ進む。進めるのは、それまでの読みが
//     変わっていないときだけである (src/client/db.ts の Txn.advance)。文書は「進められなかった取引はスナップショットのまま
//     読み続ける」とだけ言い、どこまで進むかは約束しない。進む先は、変更を知らせたシャードの時計で決まるので、置き場所で変わり得る。
//     そこで、行は「台本の順に確定を並べた状態のどれか (スナップショットから今まで、前の文の時点より前には戻らない) で、それまでの
//     読みと書き込みも同じ答えになる状態」の上で SQLite が返す行のどれかであることを確かめる (下の Model)。誤りの種類は厳密に比べる。
//     「スナップショットのまま読み続ける」と書いてあるので、誤りにはならない。
//   - COMMIT: 読んだ範囲が、読んだ時点 T の後で変わっていれば競合 (SQLITE_BUSY)。範囲は文の形で決まるので、どの文も読む時点が
//     1 つに決まる台本 (モデルの候補が 1 つ) では、成否は置き場所の全部で同じでなければならない。読む時点の候補が 2 つ以上ある
//     (同じ答えを、スナップショットでも、進めた時点でも返せる) と、どちらで読んだかで検証が変わり、文書は成否を約束しない。
//     たとえば、確定の phase 2 がまだ届いていないシャードは、変更を知らせないので、取引は T を進めずにスナップショットで読む。
//     そのときは、どちらの成否もモデルが許すことだけを確かめ、取引の終わりより後の手順は、成否が同じ置き場所の間で比べる。
//     確定したら、書いた取引は、確定の時点で全部の文を直列に流したのと同じ答えでなければならない (直列化可能)。
//   - BEGIN IMMEDIATE の主キーの読みは、行ロックを取って最新を読む (docs/sql-language.md の「取引」の表)。基準経路だけの実行
//     (REFERENCE) は、どの読みも集める経路にするので、この約束を確かめない。
//   - 最後の表の中身: 置き場所の全部で同じで、モデルとも同じでなければならない。どの行も、範囲表の持ち主のシャードにだけある。
//
// 置き場所 (placementsFor): シャード 1、2、4 と、1 シャードから seed で選んだ slot の境目で 3 回分割した 4 シャード (同じ数で、
// 行の分け方が違う)。もう 1 つは、2 シャードで台本の途中 (7 割は取引の途中) に 1 回分割する。分割の後の取引の文と COMMIT は、
// やり直してよい誤り (`not owner`、範囲の床の `read too old`。docs/overview.md の Growing) を許す。文書は、分割をまたいだ取引が
// 続けられるとは約束していない。Db.begin() と SQL の BEGIN の取引は、自分の範囲表を持ち続けるので、動いた範囲に触れる文は
// 取引の終わりまで `not owner` になる。baton は要求ごとに範囲表を取り直すので文は通るが、COMMIT は `not owner` で断られることが
// ある (2026-11-14、seed 1 から 300 で数えた)。だからこの置き場所が分割の後に確かめるのは、ほぼ autocommit の文と、取引の文が
// 通ったときの答えだけである。分割の前の手順だけをほかと比べ、後はモデルとだけ比べる。
//
// モデルの状態の列が台本の順序と同じになるように、手順の間で仮想の時刻を進める (GAP_MS)。HLC は物理の ms を上位に持つので、
// 後の手順の時刻は前の手順のどの時刻よりも大きい。半分の台本 (lag) は、確定の phase 2 の配送を遅らせ、手順の間で背後の仕事を
// 待たない。確定を返した後、参加者に適用が届く前に、次の手順が読む。
//
// 待ちの扱い (docs/sql-language.md: 行ロックの待ちは 5 秒が上限、autocommit は内部でやり直す。docs/overview.md: wound-wait で
// 古い取引が勝つ。ロックは消えてもよく、確定の検証が守る):
//   - 書き手の文は、PATIENCE_MS (仮想の時刻) だけ待って終わらなければ「待たされている」とする。取引の文は先へ進め、
//     その間はどの書き手の文も出さない (台本でその後にある書き手の文は、待たされている文が終わってから、台本の順に出す)。
//     取引が終わったら (COMMIT か ROLLBACK)、待たされている文の終わりを待つ。
//   - 待たされている文の結果は、終わった位置 (取引の終わりの後) で直列に流した SQLite の答えと比べる。待った長さは比べない。
//   - 待たされたかどうかは、置き場所の全部で同じかを比べる。行ロックは行ごとで、文の形と行で決まるからである。
//   - PATIENCE_MS は、ロックの待ちの上限とロックの期限 (どちらも 5 秒) より十分に短い。主キーで絞る autocommit の書き込みも、
//     範囲の autocommit の書き込みも、ロックが空くまで待つ (2026-11-14 に確かめた)。取引が終わるまでの残りの手順は数十 ms で、
//     待っている文が期限に当たることはない。
//   - 待たされるのは、悲観的な取引 (SQL の BEGIN、baton) が主キーで絞る書き込みでロックを取った行だけである。範囲の書き込みは
//     ロックを取らない (test/open/ranged-write-in-begin-takes-no-lock.test.ts)。モデルは、取引の書き込みのロックを仮定しない。
//   - 文書は、誰が先に行を取るか (wound-wait の年齢をどこで測るか) を約束していない。台本の手順の間に時刻を進めるので、
//     後から出た autocommit の文は、取引より若い。
//
// 既知の未解決の欠陥 (KNOWN_OPEN) は、既定の実行では伏せる。OPEN=1 (checkSeed の mask: false) では伏せない。
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { split } from "../src/autoscaler";
import { Db, type Txn } from "../src/client/db";
import { handlePipeline, type PipelineReq } from "../src/client/hrana";
import { keyString } from "../src/keys";
import { ownerOf, shardsOf, SUBSLOTS } from "../src/routing";
import type { Value } from "../src/types";
import { rawRows } from "./ddl-harness";
import { quiescentProblems } from "./invariants";
import { asNumbers, prng, REFERENCE_ONLY, SimCluster } from "./sim";

export const SCHEMA = [
  "CREATE TABLE a(id INTEGER PRIMARY KEY, g INTEGER NOT NULL, v INTEGER NOT NULL)",
  "CREATE INDEX a_g ON a(g)",
  // shard key は k。同じ k の行は同じシャードに載る。
  "CREATE TABLE b(k INTEGER NOT NULL, n INTEGER NOT NULL, aid INTEGER NOT NULL, w INTEGER NOT NULL, PRIMARY KEY (k, n))",
];
const TABLES: Record<string, { cols: string[]; pk: string[]; order: string }> = {
  a: { cols: ["id", "g", "v"], pk: ["id"], order: "id" },
  b: { cols: ["k", "n", "aid", "w"], pk: ["k", "n"], order: "k, n" },
};

/** 書き手の文を待つ仮想の時間 (ms)。上の「待ちの扱い」。 */
export const PATIENCE_MS = 1500;
/** 台本の手順の間に進める仮想の時間 (ms)。HLC の順序を台本の順序に揃える (下の runPlacement)。 */
const GAP_MS = 5;

// ---- 台本 ----

export type Conn = "tx" | "w1" | "w2";
/** 取引の出し方。object は Db.begin() (楽観的)、sql は 1 つの Db で SQL の BEGIN (悲観的)、baton は Hrana の HTTP で、要求ごとに baton から組み立て直す。 */
export type TxMode = "object" | "sql" | "baton";

export interface Step {
  i: number;
  conn: Conn;
  kind: "begin" | "stmt" | "commit" | "rollback";
  shape?: string;
  sql?: string;
  params?: number[];
  write?: boolean;
}

export interface Script {
  seed: number;
  mode: TxMode;
  immediate: boolean;
  /** 確定の phase 2 の配送を遅らせ、手順の間で待たない。確定を返した後、適用が参加者に届くまでの間に、次の手順が走る。 */
  lag: boolean;
  rows: Record<string, Value[][]>;
  steps: Step[];
}

interface Shape {
  shape: string;
  sql: string;
  params: number[];
  write: boolean;
}

export function makeScript(seed: number): Script {
  const r = prng(seed * 7919 + 17);
  const int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
  const mode = (["object", "sql", "baton"] as const)[seed % 3]!;
  const immediate = mode !== "object" && r() < 0.25;
  const lag = r() < 0.5;
  const rows: Record<string, Value[][]> = {
    a: Array.from({ length: 10 }, (_v, i) => [i + 1, (i + 1) % 3, int(0, 9)]),
    b: [],
  };
  for (let k = 1; k <= 4; k++) for (let n = 1; n <= 3; n++) rows.b!.push([k, n, int(1, 10), int(0, 9)]);
  let freshA = 100;
  let offset = 1000;
  const id = () => int(1, 12);
  const k = () => int(1, 5);
  const lohi = (): [number, number] => {
    const lo = int(1, 10);
    return [lo, lo + int(0, 5)];
  };
  const read = (shape: string, sql: string, params: number[] = []): Shape => ({ shape, sql, params, write: false });
  const write = (shape: string, sql: string, params: number[] = []): Shape => ({ shape, sql, params, write: true });
  const reads: (() => Shape)[] = [
    () => read("point", "SELECT id, g, v FROM a WHERE id = ?", [id()]),
    () => read("range", "SELECT id, v FROM a WHERE id BETWEEN ? AND ? ORDER BY id", lohi()),
    () => read("all a", "SELECT id, g, v FROM a ORDER BY id"),
    () => read("index", "SELECT id, v FROM a WHERE g = ? ORDER BY id", [int(0, 2)]),
    () => read("aggregate", "SELECT count(*), sum(v), min(v), max(v) FROM a"),
    () => read("group", "SELECT g, count(*), sum(v) FROM a GROUP BY g ORDER BY g"),
    () => read("filtered aggregate", "SELECT count(*), sum(v) FROM a WHERE v >= ?", [int(0, 9)]),
    () => read("top", "SELECT id, v FROM a ORDER BY v DESC, id LIMIT 3"),
    () => read("group b", "SELECT k, count(*), sum(w) FROM b GROUP BY k ORDER BY k"),
    () => read("pinned group", "SELECT n, aid, w FROM b WHERE k = ? ORDER BY n", [k()]),
    () => read("all b", "SELECT k, n, aid, w FROM b ORDER BY k, n"),
    () => read("join", "SELECT a.id, a.v, b.k, b.n, b.w FROM a JOIN b ON b.aid = a.id ORDER BY a.id, b.k, b.n"),
    () => read("join aggregate", "SELECT a.g, count(*), sum(b.w) FROM a JOIN b ON b.aid = a.id GROUP BY a.g ORDER BY a.g"),
    () => read("left join", "SELECT a.id, count(b.n) FROM a LEFT JOIN b ON b.aid = a.id GROUP BY a.id ORDER BY a.id"),
    () => read("subquery", "SELECT id, v FROM a WHERE id IN (SELECT aid FROM b WHERE w > ?) ORDER BY id", [int(0, 9)]),
  ];
  const writes: (() => Shape)[] = [
    () => write("point update", "UPDATE a SET v = v + ? WHERE id = ?", [int(1, 3), id()]),
    () => write("point update", "UPDATE a SET v = v + ? WHERE id = ?", [int(1, 3), id()]),
    () => write("ranged update", "UPDATE a SET v = v + ? WHERE id BETWEEN ? AND ?", [int(1, 3), ...lohi()]),
    () => write("index update", "UPDATE a SET v = (v + ?) % 10 WHERE g = ?", [int(1, 5), int(0, 2)]),
    () => write("update from subquery", "UPDATE a SET v = (SELECT count(*) FROM b WHERE b.aid = a.id) WHERE id BETWEEN ? AND ?", lohi()),
    () => write("not null violation", "UPDATE a SET v = NULL WHERE id = ?", [id()]),
    () => {
      // 1 割は、既にある主キーへの INSERT (UNIQUE の違反)。
      const fresh = r() < 0.1 ? id() : freshA++;
      return write("insert", "INSERT INTO a(id, g, v) VALUES (?, ?, ?)", [fresh, int(0, 2), int(0, 9)]);
    },
    () => write("upsert", "INSERT INTO a(id, g, v) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET v = a.v + excluded.v", [id(), int(0, 2), int(1, 3)]),
    () => write("point delete", "DELETE FROM a WHERE id = ?", [id()]),
    () => write("pinned group update", "UPDATE b SET w = w + 1 WHERE k = ?", [k()]),
    () => write("ranged update b", "UPDATE b SET w = w - 1 WHERE aid BETWEEN ? AND ?", lohi()),
    () => write("ranged delete", "DELETE FROM b WHERE w > ?", [int(7, 10)]),
    () => write("pinned delete", "DELETE FROM b WHERE k = ? AND w < ?", [k(), int(0, 4)]),
    () => write("insert b", "INSERT INTO b(k, n, aid, w) VALUES (?, ?, ?, ?)", [int(1, 6), offset++, id(), int(0, 9)]),
    () => write("replace b", "REPLACE INTO b(k, n, aid, w) VALUES (?, ?, ?, ?)", [k(), int(1, 4), id(), int(0, 9)]),
    () => {
      const at = (offset += 100);
      return write("insert select", "INSERT INTO b(k, n, aid, w) SELECT ?, id + ?, id, v FROM a WHERE id BETWEEN ? AND ?", [int(1, 6), at, ...lohi()]);
    },
    () => write("insert or ignore select", "INSERT OR IGNORE INTO a(id, g, v) SELECT aid + 20, k % 3, w FROM b WHERE k = ?", [k()]),
  ];
  const steps: Step[] = [];
  const push = (conn: Conn, kind: Step["kind"], s?: Shape) =>
    steps.push({ i: steps.length, conn, kind, ...(s ? { shape: s.shape, sql: s.sql, params: s.params, write: s.write } : {}) });
  const writer = () => {
    const conn = pick(["w1", "w2"] as const);
    push(conn, "stmt", r() < 0.85 ? pick(writes)() : pick(reads)());
  };
  // 半分の台本は、取引の文の間に書き込みを多く挟む。残りは少なく挟み、確定する取引を増やす。
  const heavy = r() < 0.5;
  const gap = () => {
    const x = r();
    const n = heavy ? (x < 0.2 ? 0 : x < 0.55 ? 1 : x < 0.85 ? 2 : 3) : x < 0.55 ? 0 : x < 0.9 ? 1 : 2;
    for (let j = 0; j < n; j++) writer();
  };
  for (let j = int(0, 2); j > 0; j--) writer();
  push("tx", "begin");
  let statements = int(4, 8);
  // 半分の台本は、取引を全部の表を丸ごと読む文で始める (再現の試験の形)。以後、ほかの接続の書き込みは、どれも前の読みを変える。
  const wide = r() < 0.5;
  if (wide) {
    push("tx", "stmt", reads[2]!());
    push("tx", "stmt", reads[10]!());
    statements -= 2;
  }
  // 4 割の台本は、取引が主に狭い範囲 (主キー、主キーの範囲、index、shard key のグループ) を読む。ほかの接続の書き込みが
  // 前の読みを外れることが増え、読む時点を進める道と、確定する取引が増える。
  const narrow = !wide && r() < 0.4;
  const narrowReads = [0, 1, 3, 9].map((j) => reads[j]!);
  for (let j = 0; j < statements; j++) {
    gap();
    push("tx", "stmt", r() < 0.65 ? (narrow && r() < 0.85 ? pick(narrowReads)() : pick(reads)()) : pick(writes)());
  }
  gap();
  push("tx", r() < 0.75 ? "commit" : "rollback");
  for (let j = int(1, 3); j > 0; j--) writer();
  return { seed, mode, immediate, lag, rows, steps };
}

// ---- 結果 ----

export type Outcome =
  | { kind: "rows"; rows: Value[][]; changes: number }
  | { kind: "error"; cls: "busy" | "constraint" | "unsupported" | "error"; message: string };

export function errorOf(e: unknown): Outcome {
  const message = e instanceof Error ? e.message : String(e);
  const cls = /^unsupported:/.test(message) ? "unsupported"
    : /^(conflict|read too old|not owner|migrating|upgrading)/.test(message) ? "busy"
      : /UNIQUE|NOT NULL|CHECK|constraint/i.test(message) ? "constraint" : "error";
  return { kind: "error", cls, message };
}

/** 比べるための文字列。誤りは種類で比べる。種類が error のものは文言も比べる (SQLite の文言で返す約束である)。 */
export function keyOf(o: Outcome, withMessage = true): string {
  if (o.kind === "rows") return JSON.stringify({ rows: o.rows, changes: o.changes });
  return o.cls === "error" && withMessage ? `error ${o.message}` : o.cls;
}

export const show = (o: Outcome | undefined): string =>
  o === undefined ? "(not run)" : o.kind === "rows" ? `${JSON.stringify(o.rows).slice(0, 160)}${o.changes ? ` changes=${o.changes}` : ""}` : `${o.cls}: ${o.message.slice(0, 120)}`;

// ---- 置き場所 ----

export interface Placement {
  name: string;
  shards: number;
  /** 1 シャードから始めて、seed で選んだ slot の境目で、この数だけ分割してから行を入れる。同じシャードの数で、別の行の分け方になる。 */
  cuts?: number;
  /** この手順の前で、シャードを 1 つ分割する (行のある範囲を動かす)。 */
  splitBefore?: number;
}

export function placementsFor(s: Script): Placement[] {
  const r = prng(s.seed * 31 + 5);
  const begin = s.steps.findIndex((x) => x.kind === "begin");
  const end = s.steps.findIndex((x) => x.kind === "commit" || x.kind === "rollback");
  // 分割の位置は、7 割を取引の途中に置く。
  const inTxn = r() < 0.7;
  const lo = inTxn ? begin + 1 : 0;
  const hi = inTxn ? end : s.steps.length - 1;
  const splitBefore = lo + Math.floor(r() * (hi - lo + 1));
  return [
    { name: "1 shard", shards: 1 },
    { name: "2 shards", shards: 2 },
    { name: "4 shards", shards: 4 },
    { name: "4 shards, cut by splits", shards: 4, cuts: 3 },
    { name: "2 shards, split mid-script", shards: 2, splitBefore },
  ];
}

// ---- 実行 ----

export interface StepResult {
  outcome: Outcome;
  /** PATIENCE_MS を過ぎても終わらなかった書き手の文。 */
  blocked?: boolean;
  /** 既知の未解決の欠陥に当たり、伏せた (やり直した) こと。 */
  masked?: string;
}

export interface Trace {
  placement: Placement;
  results: (StepResult | undefined)[];
  /** 文が効いた順 (終わった順)。モデルはこの順に再生する。 */
  order: number[];
  /** 既知の欠陥で比較を打ち切った手順。これ以後の結果は比べない。 */
  truncatedAt?: number;
  truncatedBy?: string;
  /** 分割を実行した位置 (その手順の前)。 */
  splitAt?: number;
  final?: Record<string, Value[][]>;
  quiescent: string[];
}

/**
 * 既知の未解決の欠陥。既定の実行 (OPEN=1 でないとき) では、ここに書いた方法で伏せる。
 * masked: 取引の文の誤りを見分けて、やり直すか、その置き場所の比較を打ち切る (runPlacement)。
 * avoided: 台本の準備の側で、欠陥に当たる形を作らない。OPEN=1 では作る。
 */
export interface Known {
  id: string;
  repro: string;
  how: "masked" | "avoided";
  /** 取引の文の誤りが、この欠陥のものか。 */
  matches(step: Step, outcome: Outcome, p: Placement, beforeSplit: boolean): boolean;
}

export const KNOWN_OPEN: Known[] = [
  {
    id: "open problem 34 (read too old after rows on two shards changed)",
    repro: "test/open/snapshot-read-after-two-shards-changed.test.ts",
    how: "masked",
    // 2 つ以上のシャードがあるときの、取引の文の `read too old: moved at`。分割の後のものは、文書にある範囲の床の拒否なので含めない。
    // この欠陥は、1 つの文が 2 つ以上のシャードへ同時に要求を送るときにだけ起きる。1 つのシャードへ送る読み (主キー、shard key
    // のグループ) の誤りは別の欠陥なので、伏せない。全部の文を表の丸ごとの走査にする実行 (REFERENCE=full) では、どの読みも全シャードへ送る。
    matches: (step, o, p, beforeSplit) =>
      step.conn === "tx" && step.kind === "stmt" && p.shards >= 2 && beforeSplit && o.kind === "error" && /^read too old: moved at/.test(o.message) &&
      (process.env.REFERENCE === "full" || !["point", "pinned group"].includes(step.shape ?? "")),
  },
  {
    // 分割で切る置き場所は、表定義を作った Db (分割の前の範囲表を覚えている) で初めの行を複数行の INSERT で入れると、これに当たる。
    // 既定の実行では、分割の後に作った Db で入れる。
    id: "a multi-row INSERT planned before a split writes its rows to two shards",
    repro: "test/open/multi-row-insert-after-split.test.ts",
    how: "avoided",
    matches: () => false,
  },
];

const toH = (v: number) => ({ type: "integer" as const, value: String(v) });
const fromH = (v: { type: string; value?: string | number }): Value =>
  v.type === "null" ? null : v.type === "integer" || v.type === "float" ? Number(v.value) : (v.value as Value);

interface HranaOut {
  baton: string | null;
  results: ({ type: "ok"; response: { result: { rows: { type: string; value?: string }[][]; affected_row_count: number } } } | { type: "error"; error: { message: string } })[];
}

/** 取引の接続。3 通りの出し方を同じ形にする。 */
function txDriver(c: SimCluster, s: Script) {
  const begin = s.immediate ? "BEGIN IMMEDIATE" : "BEGIN";
  const asRows = async (p: Promise<{ values: Value[][]; changes: number }>): Promise<Outcome> => {
    try {
      const r = await p;
      return { kind: "rows", rows: asNumbers(r.values), changes: r.changes };
    } catch (e) {
      return errorOf(e);
    }
  };
  if (s.mode === "object") {
    const db = new Db(c, { retries: 0 });
    let tx: Txn | null = null;
    return {
      async begin(): Promise<Outcome> {
        tx = await db.begin();
        return { kind: "rows", rows: [], changes: 0 };
      },
      exec: (sql: string, params: number[]) => asRows(tx!.query(sql, params)),
      commit: () => asRows(tx!.commit().then(() => ({ values: [], changes: 0 }))),
      rollback: () => asRows(tx!.unlockAll().then(() => ({ values: [], changes: 0 }))),
    };
  }
  if (s.mode === "sql") {
    const db = new Db(c, { retries: 0 });
    return {
      begin: () => asRows(db.query(begin)),
      exec: (sql: string, params: number[]) => asRows(db.query(sql, params)),
      commit: () => asRows(db.query("COMMIT")),
      rollback: () => asRows(db.query("ROLLBACK")),
    };
  }
  let baton: string | null = null;
  const one = async (sql: string, params: number[] = []): Promise<Outcome> => {
    const req = { baton, requests: [{ type: "execute", stmt: { sql, args: params.map(toH) } }] } as PipelineReq;
    const res = (await handlePipeline(req, async (token) => new Db(c, { token }))) as unknown as HranaOut;
    baton = res.baton;
    const r = res.results[0]!;
    if (r.type === "error") return errorOf(new Error(r.error.message));
    return { kind: "rows", rows: r.response.result.rows.map((row) => row.map(fromH)), changes: r.response.result.affected_row_count };
  };
  return { begin: () => one(begin), exec: one, commit: () => one("COMMIT"), rollback: () => one("ROLLBACK") };
}

/** 範囲 [start, end) の中の slot の境目を seed で選び、その後ろを child へ分割する。 */
async function splitAt(c: SimCluster, r: () => number, child: string): Promise<void> {
  const { routing } = await c.catalog();
  const parents = shardsOf(routing);
  const parent = parents[Math.floor(r() * parents.length)]!;
  const widest = routing.ranges.filter((x) => x.shard === parent).sort((x, y) => y.end - y.start - (x.end - x.start))[0]!;
  const first = Math.ceil(widest.start / SUBSLOTS) + 1;
  const last = Math.floor(widest.end / SUBSLOTS) - 1;
  const cut = (first + Math.floor(r() * (last - first + 1))) * SUBSLOTS;
  await split(c, parent, child, { range: { start: cut, end: widest.end } });
}

/** 範囲表の持ち主でないシャードに載っている行。行は、持ち主のシャードにちょうど 1 つある。 */
async function misplaced(c: SimCluster): Promise<string[]> {
  const { routing } = await c.catalog();
  const out: string[] = [];
  for (const [t, d] of Object.entries(TABLES)) {
    const sk = d.pk[0]!;
    for (const { shard, row } of await rawRows(c, t)) {
      if (ownerOf(routing, keyString([row[sk] ?? null])) !== shard) out.push(`row ${t} ${JSON.stringify(row)} is on ${shard}, not on its owner`);
    }
  }
  return out;
}

async function dump(db: Db): Promise<Record<string, Value[][]>> {
  const out: Record<string, Value[][]> = {};
  for (const [t, d] of Object.entries(TABLES)) out[t] = asNumbers((await db.query(`SELECT ${d.cols.join(", ")} FROM ${t} ORDER BY ${d.order}`)).values);
  return out;
}

export async function runPlacement(s: Script, p: Placement, o: { mask: boolean }): Promise<Trace> {
  const c = new SimCluster({ shards: p.cuts ? 1 : p.shards, seed: s.seed });
  const net = prng(s.seed * 131 + 7);
  c.net.jitter = () => (net() < 0.5 ? 0 : net() * 3);
  if (s.lag) c.net.gate = (m) => (m.method === "finalize" && net() < 0.4 ? c.sleep(net() * 25) : undefined);
  /** 手順の間。lag でなければ、背後の仕事 (phase 2 など) が終わるのを待つ。どちらでも時刻を進める (HLC の順序を台本の順序に揃える)。 */
  const between = async () => {
    if (!s.lag) await c.settle();
    await c.sleep(GAP_MS);
  };
  const trace: Trace = { placement: p, results: [], order: [], quiescent: [] };
  const work = (async () => {
    const admin = new Db(c);
    for (const ddl of SCHEMA) await admin.ddl(ddl);
    const cuts = prng(s.seed * 977 + 3);
    for (let j = 1; j <= (p.cuts ?? 0); j++) await splitAt(c, cuts, `s${j}`);
    // 既定の実行では、分割の後に作った Db で入れる (KNOWN_OPEN の 2 つ目)。
    const loader = o.mask ? new Db(c) : admin;
    for (const [t, rows] of Object.entries(s.rows)) {
      await loader.query(`INSERT INTO ${t} VALUES ${rows.map((row) => `(${row.join(", ")})`).join(", ")}`);
    }
    await c.settle();
    await c.sleep(50);
    const tx = txDriver(c, s);
    const writers = { w1: new Db(c), w2: new Db(c) };
    let pending: { i: number; promise: Promise<Outcome>; done: boolean } | null = null;
    const deferred: Step[] = [];
    const record = (i: number, r: StepResult) => {
      trace.results[i] = r;
      trace.order.push(i);
    };
    const writerStep = async (step: Step) => {
      const promise = writers[step.conn as "w1" | "w2"].query(step.sql!, step.params!).then(
        (r): Outcome => ({ kind: "rows", rows: asNumbers(r.values), changes: r.changes }),
        errorOf,
      );
      const flag = { i: step.i, promise, done: false };
      void promise.then(() => (flag.done = true));
      const raced = await Promise.race([promise, c.sleep(PATIENCE_MS).then(() => null)]);
      if (raced !== null) record(step.i, { outcome: raced });
      else pending = flag;
    };
    /** 待たされている文が終わっていれば記録し、後回しにした書き手の文を台本の順に出す。wait なら終わるまで待つ。 */
    const release = async (wait: boolean) => {
      if (!pending) return;
      if (!pending.done && !wait) return;
      const it = pending;
      pending = null;
      record(it.i, { outcome: await it.promise, blocked: true });
      while (deferred.length > 0 && !pending) {
        await writerStep(deferred.shift()!);
        await between();
      }
    };
    const beforeSplit = (i: number) => p.splitBefore === undefined || i < p.splitBefore;
    for (const step of s.steps) {
      if (p.splitBefore === step.i) {
        await splitAt(c, prng(s.seed * 59 + 11), `s${p.shards}`);
        trace.splitAt = step.i;
      }
      await release(false);
      if (step.conn !== "tx") {
        if (pending) deferred.push(step);
        else await writerStep(step);
      } else if (step.kind === "begin") {
        record(step.i, { outcome: await tx.begin() });
      } else if (step.kind === "stmt") {
        let outcome = await tx.exec(step.sql!, step.params!);
        const known = KNOWN_OPEN.find((k) => k.matches(step, outcome, p, beforeSplit(step.i)));
        if (known && o.mask) {
          // 既知の欠陥。同じ Txn を使い続ける出し方では、Txn がスナップショットのまま読むと決めた後なので、同じ文をもう 1 度出すと
          // 答えが返る。baton では要求ごとに組み立て直すので、何度出しても同じ誤りになる。その置き場所の比較をここで打ち切る。
          if (s.mode === "baton") {
            trace.truncatedAt = step.i;
            trace.truncatedBy = known.id;
            return;
          }
          outcome = await tx.exec(step.sql!, step.params!);
          if (KNOWN_OPEN.some((k) => k.matches(step, outcome, p, beforeSplit(step.i)))) {
            trace.truncatedAt = step.i;
            trace.truncatedBy = known.id;
            return;
          }
          record(step.i, { outcome, masked: known.id });
        } else record(step.i, { outcome });
      } else {
        record(step.i, { outcome: step.kind === "commit" ? await tx.commit() : await tx.rollback() });
        await release(true);
      }
      await between();
    }
    await release(true);
    await c.settle();
    try {
      trace.final = await dump(new Db(c));
    } catch (e) {
      trace.quiescent.push(`reading the final table contents failed: ${(e as Error).message}`);
    }
    trace.quiescent.push(...(await quiescentProblems(c)), ...(await misplaced(c)));
  })();
  await Promise.race([work, c.stalled(600_000, 3_000_000)]);
  return trace;
}

// ---- モデル ----
//
// 台本の順に確定を並べた状態の列 P_0, P_1, … を、node:sqlite で計算する。取引の文は、状態 P_k に取引自身の書き込み (overlay)
// を重ねた上で評価する。k の候補は、取引の文ごとに広がる (上の「何を比べるか」)。

type Rows = Record<string, Value[][]>;
/** 取引の書き込み。`表\0主キー` から行 (消したなら null)。 */
type Overlay = Map<string, Value[] | null>;

const pkKey = (t: string, row: Value[]) => `${t}\0${JSON.stringify(TABLES[t]!.pk.map((c) => row[TABLES[t]!.cols.indexOf(c)]))}`;
const overlayKey = (o: Overlay) => JSON.stringify([...o].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)));
const rowsKey = (rows: Rows) => createHash("sha1").update(JSON.stringify(rows)).digest("hex");

function withOverlay(rows: Rows, o: Overlay): Rows {
  if (o.size === 0) return rows;
  const out: Rows = {};
  for (const t of Object.keys(TABLES)) {
    const m = new Map((rows[t] ?? []).map((row) => [pkKey(t, row), row]));
    for (const [key, row] of o) {
      if (!key.startsWith(`${t}\0`)) continue;
      if (row === null) m.delete(key);
      else m.set(key, row);
    }
    out[t] = [...m.values()];
  }
  return sortRows(out);
}

function sortRows(rows: Rows): Rows {
  const out: Rows = {};
  for (const t of Object.keys(TABLES)) {
    const at = TABLES[t]!.pk.map((c) => TABLES[t]!.cols.indexOf(c));
    out[t] = [...(rows[t] ?? [])].sort((x, y) => {
      for (const i of at) if (x[i] !== y[i]) return (x[i] as number) - (y[i] as number);
      return 0;
    });
  }
  return out;
}

interface Evaluated {
  out: Outcome;
  /** 書き込みが変えた行。 */
  delta: Overlay;
  after: Rows;
}

export class Model {
  private dbs = new Map<string, DatabaseSync>();
  private memo = new Map<string, Evaluated>();

  private open(rows: Rows): { db: DatabaseSync; key: string } {
    const key = rowsKey(rows);
    let db = this.dbs.get(key);
    if (!db) {
      db = new DatabaseSync(":memory:");
      for (const s of SCHEMA) db.exec(s);
      for (const [t, list] of Object.entries(rows)) {
        const st = db.prepare(`INSERT INTO ${t} VALUES (${TABLES[t]!.cols.map(() => "?").join(", ")})`);
        for (const row of list) st.run(...(row as never[]));
      }
      if (this.dbs.size > 400) {
        const [k0, d0] = this.dbs.entries().next().value!;
        d0.close();
        this.dbs.delete(k0);
      }
      this.dbs.set(key, db);
    }
    return { db, key };
  }

  private read(db: DatabaseSync): Rows {
    const out: Rows = {};
    for (const [t, d] of Object.entries(TABLES)) {
      const st = db.prepare(`SELECT ${d.cols.join(", ")} FROM ${t} ORDER BY ${d.order}`);
      st.setReturnArrays(true);
      out[t] = st.all() as unknown as Value[][];
    }
    return out;
  }

  /** 状態 rows の上で文を実行し、答えと、変えた行と、変えた後の状態を返す。状態は変えない。 */
  eval(rows: Rows, sql: string, params: number[]): Evaluated {
    const memoKey = `${rowsKey(rows)}\0${sql}\0${params.join(",")}`;
    const hit = this.memo.get(memoKey);
    if (hit) return hit;
    const { db } = this.open(rows);
    db.exec("SAVEPOINT m");
    let res: Evaluated;
    try {
      const st = db.prepare(sql);
      let out: Outcome;
      if (st.columns().length > 0) {
        st.setReturnArrays(true);
        out = { kind: "rows", rows: st.all(...(params as never[])) as unknown as Value[][], changes: 0 };
      } else {
        out = { kind: "rows", rows: [], changes: Number(st.run(...(params as never[])).changes) };
      }
      const after = this.read(db);
      res = { out, delta: diff(rows, after), after };
    } catch (e) {
      res = { out: errorOf(e), delta: new Map(), after: rows };
    } finally {
      db.exec("ROLLBACK TO m");
      db.exec("RELEASE m");
    }
    this.memo.set(memoKey, res);
    return res;
  }

  close(): void {
    for (const db of this.dbs.values()) db.close();
    this.dbs.clear();
    this.memo.clear();
  }
}

function diff(before: Rows, after: Rows): Overlay {
  const out: Overlay = new Map();
  for (const t of Object.keys(TABLES)) {
    const b = new Map((before[t] ?? []).map((row) => [pkKey(t, row), JSON.stringify(row)]));
    const seen = new Set<string>();
    for (const row of after[t] ?? []) {
      const key = pkKey(t, row);
      seen.add(key);
      if (b.get(key) !== JSON.stringify(row)) out.set(key, row);
    }
    for (const key of b.keys()) if (!seen.has(key)) out.set(key, null);
  }
  return out;
}

/** 取引の文の記録。モデルの「世界」の中で、後の時点でも同じ答えになることを確かめるのに使う。 */
interface Entry {
  sql: string;
  params: number[];
  /** 文の前の、取引自身の書き込み。 */
  before: Overlay;
  /** 評価した状態の番号。 */
  at: number;
  out: Outcome;
  delta: Overlay;
}
/** 取引の時点の候補。k は読む時点 (状態の番号)、overlay は取引の書き込み、hist はそこまでの文。 */
interface World {
  k: number;
  overlay: Overlay;
  hist: Entry[];
}

export interface Verdict {
  /** モデルで説明できない答え。 */
  problems: string[];
  /** 手順ごとの、モデルが許す答えの数 (取引の文だけ)。2 以上なら、置き場所で違ってよい。 */
  choices: Map<number, number>;
  /** 取引の読む時点が、どの文でも 1 つに決まっていた。決まっていなければ、COMMIT の成否は置き場所で違ってよい。 */
  forced: boolean;
}

/** 台本を、trace が記録した順に再生し、各手順の答えがモデルで説明できるかを確かめる。 */
export function checkTrace(s: Script, t: Trace, m: Model): Verdict {
  const problems: string[] = [];
  const choices = new Map<number, number>();
  const states: Rows[] = [sortRows(s.rows)];
  const latest = () => states.length - 1;
  let worlds: World[] | null = null;
  let first = true;
  let unforced = false;
  const relaxed = (i: number) => t.splitAt !== undefined && i >= t.splitAt;
  const same = (x: Outcome, y: Outcome) => keyOf(x, false) === keyOf(y, false);
  const holdsAt = (e: Entry, k: number) => {
    const r = m.eval(withOverlay(states[k]!, e.before), e.sql, e.params);
    return same(r.out, e.out) && overlayKey(r.delta) === overlayKey(e.delta);
  };
  const fail = (i: number, what: string) => problems.push(`step ${i}: ${what}`);
  for (const i of t.order) {
    if (problems.length > 0) break;
    const step = s.steps[i]!;
    const got = t.results[i]!.outcome;
    if (step.conn !== "tx") {
      const want = m.eval(states[latest()]!, step.sql!, step.params!);
      if (!same(want.out, got)) {
        fail(i, `${step.conn} ${step.sql} ${JSON.stringify(step.params)}: serial SQLite ${show(want.out)}, got ${show(got)}`);
        break;
      }
      if (want.out.kind === "rows" && want.delta.size > 0) states.push(want.after);
      continue;
    }
    if (step.kind === "begin") {
      worlds = [{ k: latest(), overlay: new Map(), hist: [] }];
      first = true;
      if (got.kind !== "rows") fail(i, `BEGIN failed: ${show(got)}`);
      continue;
    }
    if (step.kind === "stmt") {
      if (got.kind === "error" && got.cls === "busy" && relaxed(i)) {
        // 分割の後の、範囲の床と移動の拒否 (docs/overview.md の Growing)。やり直してよい誤りで、文は何も変えていない。
        // ただし、取引の最初の文なら、断られる前に読む時点 T が決まっていることがある (複数シャードの読みは、送る前に T を選ぶ)。
        // 次の文は、この時点から後のどこでも読んでよいものとする。
        if (first) {
          for (const w of worlds!) w.k = latest();
          first = false;
          unforced = true;
        }
        continue;
      }
      const next: World[] = [];
      const seen = new Set<string>();
      const distinct = new Set<string>();
      // BEGIN IMMEDIATE の主キーの読みは、行ロックを取って最新を読む (docs/sql-language.md の「取引」の表)。基準経路だけの実行は、
      // どの読みも集める経路にするので、この約束の外である (試験のための実行の形)。
      const latestOnly = first || (s.immediate && step.shape === "point" && !REFERENCE_ONLY);
      const keepsT = !first && (step.write || latestOnly);
      for (const w of worlds!) {
        const ks = latestOnly ? [latest()] : Array.from({ length: latest() - w.k + 1 }, (_v, j) => w.k + j);
        for (const k of ks) {
          // 読む時点を進めるなら、それまでの文が、進めた時点でも同じ答えになっていなければならない (Txn.advance の確かめ)。
          // 書き込みと BEGIN IMMEDIATE の主キーの読みは、T を進めずに最新の状態で実行することがあるので、確かめない (緩い側)。
          if (k > w.k && !keepsT && !w.hist.every((e) => e.at > k || holdsAt(e, k))) continue;
          const r = m.eval(withOverlay(states[k]!, w.overlay), step.sql!, step.params!);
          distinct.add(keyOf(r.out, false));
          if (!same(r.out, got)) continue;
          const overlay = new Map([...w.overlay, ...r.delta]);
          // 書き込みは、最新の状態で実行することがある (悲観的な取引の行ロックの書き込み)。読む時点 T は動かさない側に取る。
          const nk = first ? k : keepsT ? w.k : k;
          const hist = [...w.hist, { sql: step.sql!, params: step.params!, before: w.overlay, at: k, out: r.out, delta: r.delta }];
          const id = `${nk}|${overlayKey(overlay)}|${hist.map((e) => e.at).join(",")}`;
          if (seen.has(id)) continue;
          seen.add(id);
          next.push({ k: nk, overlay, hist });
        }
      }
      choices.set(i, distinct.size);
      // 読む時点の候補が 2 つ以上残った。どの時点で読んだかで COMMIT の検証が変わるので、確定の成否は文書の約束の外になる。
      // 悲観的な取引の書き込みは、文の時点の行に対して実行する (docs/sql-language.md の「取引」の表) ので数えない。
      if ((!step.write || s.mode === "object") && new Set(next.map((w) => w.hist.at(-1)!.at)).size > 1) unforced = true;
      first = false;
      if (next.length === 0) {
        fail(i, `tx ${step.sql} ${JSON.stringify(step.params)}: no state between the snapshot and now gives ${show(got)} (serial SQLite gives ${[...distinct].map((x) => x.slice(0, 80)).join(" or ")})`);
        break;
      }
      worlds = next.slice(0, 64);
      continue;
    }
    // COMMIT と ROLLBACK
    if (step.kind === "rollback" || (got.kind === "error" && got.cls === "busy")) {
      if (step.kind === "rollback" && got.kind !== "rows") fail(i, `ROLLBACK failed: ${show(got)}`);
      worlds = null;
      continue;
    }
    if (got.kind !== "rows") {
      fail(i, `COMMIT failed with ${show(got)}`);
      break;
    }
    // 確定した。書いた取引は、確定の時点で全部の文が同じ答えでなければならない。読むだけの取引は、最後の時点で済んでいる。
    const ok = worlds!.filter((w) => w.overlay.size === 0 || w.hist.every((e) => holdsAt(e, latest())));
    if (ok.length === 0) {
      fail(i, `COMMIT succeeded, but the transaction's statements do not all give the same answers at its commit point`);
      break;
    }
    const results = new Set(ok.map((w) => rowsKey(withOverlay(states[latest()]!, w.overlay))));
    if (results.size > 1) {
      fail(i, `COMMIT: the model cannot decide what the transaction wrote (${results.size} candidates)`);
      break;
    }
    if (ok[0]!.overlay.size > 0) states.push(withOverlay(states[latest()]!, ok[0]!.overlay));
    worlds = null;
  }
  if (problems.length === 0 && t.truncatedAt === undefined && t.final) {
    const want = states[latest()]!;
    for (const tbl of Object.keys(TABLES)) {
      if (JSON.stringify(want[tbl]) !== JSON.stringify(t.final[tbl])) {
        problems.push(`final ${tbl}: model ${JSON.stringify(want[tbl]).slice(0, 200)}, got ${JSON.stringify(t.final[tbl]).slice(0, 200)}`);
      }
    }
  }
  return { problems, choices, forced: !unforced };
}

// ---- 比較 ----

export interface Report {
  divergences: string[];
  /** 伏せた既知の欠陥の数 (やり直した文、打ち切った置き場所)。 */
  masked: Record<string, number>;
  /** 置き場所によって違い、どちらもモデルが許すもの (文書が約束していない違い)。取引の 2 文目以降の行と、確定の成否。 */
  unpromised: { reads: number; commits: number };
  traces: Trace[];
  verdicts: Verdict[];
}

function groupBy<T>(xs: T[], key: (x: T) => string): T[][] {
  const out = new Map<string, T[]>();
  for (const x of xs) out.set(key(x), [...(out.get(key(x)) ?? []), x]);
  return [...out.values()];
}

/** seed の台本を全部の置き場所で流して比べる。s を渡すと、その台本を流す (検査の誤りを調べるときに、台本の一部を変えて流す)。 */
export async function checkSeed(seed: number, o: { mask: boolean }, s: Script = makeScript(seed)): Promise<Report> {
  const traces: Trace[] = [];
  for (const p of placementsFor(s)) traces.push(await runPlacement(s, p, o));
  const m = new Model();
  const divergences: string[] = [];
  const masked: Record<string, number> = {};
  const unpromised = { reads: 0, commits: 0 };
  const label = (t: Trace) => t.placement.name;
  let verdicts: Verdict[] = [];
  try {
    verdicts = traces.map((t) => checkTrace(s, t, m));
    traces.forEach((t, j) => {
      for (const x of verdicts[j]!.problems) divergences.push(`seed ${seed} (${s.mode}${s.immediate ? ", immediate" : ""}), ${label(t)}: model: ${x}`);
      for (const x of t.quiescent) divergences.push(`seed ${seed}, ${label(t)}: after the run: ${x}`);
      for (const r of t.results) if (r?.masked) masked[r.masked] = (masked[r.masked] ?? 0) + 1;
      if (t.truncatedBy) masked[t.truncatedBy] = (masked[t.truncatedBy] ?? 0) + 1;
    });
    // 置き場所の間の比較。分割を挟む実行は、分割の前の手順だけを比べる (後は、文書にある、やり直してよい拒否を許すので)。
    // COMMIT の成否が置き場所で違ってよい場合 (Verdict.forced) は、取引の終わりより後の手順を、確定の成否が同じ置き場所の間でだけ比べる。
    const end = s.steps.find((x) => x.kind === "commit" || x.kind === "rollback")!.i;
    const ended = (t: Trace) => (t.results[end] ? keyOf(t.results[end]!.outcome) : "(not run)");
    const allowedAt = (t: Trace, i: number) => {
      const v = verdicts[traces.indexOf(t)]!;
      return !v.problems.some((x) => x.startsWith(`step ${i}:`));
    };
    for (const step of s.steps) {
      const runs = traces.filter((t) => (t.truncatedAt === undefined || step.i < t.truncatedAt) && (t.splitAt === undefined || step.i < t.splitAt) && t.results[step.i]);
      const groups = step.i > end ? groupBy(runs, ended) : [runs];
      for (const comparable of groups) {
        if (comparable.length < 2) continue;
        const keys = comparable.map((t) => keyOf(t.results[step.i]!.outcome));
        const blocked = comparable.map((t) => Boolean(t.results[step.i]!.blocked));
        const firstStmt = s.steps.find((x) => x.conn === "tx" && x.kind === "stmt")?.i;
        if (new Set(keys).size > 1) {
          const later = step.conn === "tx" && step.kind === "stmt" && step.i !== firstStmt;
          const rowsOnly = comparable.every((t) => t.results[step.i]!.outcome.kind === "rows");
          const allowed = comparable.every((t) => allowedAt(t, step.i));
          if (later && rowsOnly && allowed) {
            unpromised.reads++;
            continue;
          }
          // 確定の成否。読む時点が決まっていなかった置き場所があれば、文書は成否を約束していない。どちらもモデルが許すことだけを見る。
          const unforcedEnd = step.i === end && step.kind === "commit" && comparable.some((t) => !verdicts[traces.indexOf(t)]!.forced);
          if (unforcedEnd && allowed && comparable.every((t) => t.results[step.i]!.outcome.kind === "rows" || (t.results[step.i]!.outcome as { cls: string }).cls === "busy")) {
            unpromised.commits++;
            continue;
          }
          divergences.push(
            `seed ${seed} (${s.mode}${s.immediate ? ", immediate" : ""}), step ${step.i} ${step.conn} ${step.kind} ${step.sql ?? ""} ${step.params ? JSON.stringify(step.params) : ""}:\n` +
              comparable.map((t) => `    ${label(t).padEnd(28)} ${show(t.results[step.i]!.outcome)}`).join("\n"),
          );
        } else if (new Set(blocked).size > 1) {
          divergences.push(`seed ${seed}, step ${step.i} ${step.conn} ${step.sql}: blocked in ${comparable.filter((t) => t.results[step.i]!.blocked).map(label).join(", ")} only`);
        }
      }
    }
    const finals = traces.filter((t) => t.truncatedAt === undefined && t.splitAt === undefined && t.final);
    for (const group of groupBy(finals, ended)) {
      if (new Set(group.map((t) => JSON.stringify(t.final))).size > 1) divergences.push(`seed ${seed}: final table contents differ between ${group.map(label).join(", ")}`);
    }
  } finally {
    m.close();
  }
  return { divergences, masked, unpromised, traces, verdicts };
}
