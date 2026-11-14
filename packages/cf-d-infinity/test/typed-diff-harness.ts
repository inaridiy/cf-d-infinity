// 値の型を保った突き合わせと、そのための 2 つ目の生成器 (docs/design-values.md の「足す検査」の 2)。
// test/typed-diff.test.ts と test/open/typed-diff-wide.test.ts が使う。
//
// test/typed-diff.test.ts の元の比較は、結果の BigInt を数にしてから比べるので、結果の INTEGER と REAL の違いを見ない。
// ここでは @libsql/client を intMode: "bigint" で使う。INTEGER は BigInt、REAL は JS の数で返るので、型ごと比べられる。
// 基準の node:sqlite も BigInt で読む。
//
// 元の生成器 (typed-diff.test.ts の valueOf と script) には手を入れない。選ぶ候補を 1 つ足すと、乱数の引き方がずれて、
// これまでの seed が別の台本になる。足す値と文は、ここの 2 つ目の生成器 (script2) に置く。
import type { Client } from "@libsql/client";
import { DatabaseSync } from "node:sqlite";
import { clientOf } from "./libsql";
import { prng, SimCluster } from "./sim";

export type Arg = null | bigint | number | string | Uint8Array;
export interface Step {
  sql: string;
  args: Arg[];
  /**
   * 比べる前に、両方の結果の行に掛ける。`random()` を含む文は、行ごとの値が実行のたびに違うので、値そのものではなく、
   * 「値と型が食い違っていない」ことだけを比べる。
   */
  normalize?: (rows: Cell[][]) => Cell[][];
}

/** 型ごと文字にした値。INTEGER は i、REAL は r、TEXT は t、BLOB は b を前に付ける。NULL は null。 */
export type Cell = string | null;
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
export const cell = (x: unknown): Cell =>
  x === null || x === undefined ? null
    : typeof x === "bigint" ? `i${x}`
      : typeof x === "number" ? `r${Object.is(x, -0) ? 0 : x}`
        : typeof x === "string" ? `t${x}`
          : `b${hex(x instanceof ArrayBuffer ? new Uint8Array(x) : (x as Uint8Array))}`;

// ---- 段 3 まで緩める比較 ----
//
// いまの D∞ の結果の型は、次の 2 点で SQLite (と sqld) と違う。どちらも docs/sql-language.md の「値」に書いてある違いで、
// 値の作り直しの段 3 でなくなる。そのとき、この 2 つの関数と RELAXED_UNTIL_STAGE_3 を消す。
// ここに当てはまらない食い違いは、いまの欠陥である。緩める条件を広げて通さないこと。
export const RELAXED_UNTIL_STAGE_3 = true;

/** 「結果の数の型」: 整数の値の REAL (5.0) を、Hrana の `integer` で返す。DO の SQLite が読み出しで INTEGER と REAL を区別しないからである。 */
export function integralRealAsInteger(want: Cell, got: Cell): boolean {
  if (want === null || got === null || want[0] !== "r" || got[0] !== "i") return false;
  const x = Number(want.slice(1));
  return Number.isSafeInteger(x) && got === `i${x}`;
}

/** 「2^53 を超える整数」: SQL の中で計算して 2^53 を超えた INTEGER は、精度を落として `float` で返す。 */
export function wideIntegerAsRoundedFloat(want: Cell, got: Cell): boolean {
  if (want === null || got === null || want[0] !== "i" || got[0] !== "r") return false;
  const big = BigInt(want.slice(1));
  return (big > 2n ** 53n - 1n || big < -(2n ** 53n) + 1n) && Number(got.slice(1)) === Number(big);
}

export interface Relaxed { integralRealAsInteger: number; wideIntegerAsRoundedFloat: number }

/** 2 つの結果が、緩める 2 点を除いて同じか。緩めた回数を数える。 */
function sameRows(want: Cell[][], got: Cell[][], relaxed: Relaxed): boolean {
  if (want.length !== got.length) return false;
  const counted: Relaxed = { integralRealAsInteger: 0, wideIntegerAsRoundedFloat: 0 };
  for (let i = 0; i < want.length; i++) {
    if (want[i]!.length !== got[i]!.length) return false;
    for (let j = 0; j < want[i]!.length; j++) {
      const [w, g] = [want[i]![j]!, got[i]![j]!];
      if (w === g) continue;
      if (RELAXED_UNTIL_STAGE_3 && integralRealAsInteger(w, g)) counted.integralRealAsInteger++;
      else if (RELAXED_UNTIL_STAGE_3 && wideIntegerAsRoundedFloat(w, g)) counted.wideIntegerAsRoundedFloat++;
      else return false;
    }
  }
  relaxed.integralRealAsInteger += counted.integralRealAsInteger;
  relaxed.wideIntegerAsRoundedFloat += counted.wideIntegerAsRoundedFloat;
  return true;
}

export interface TypedRun { problems: string[]; relaxed: Relaxed; statements: number }

/**
 * 台本を、D∞ (Hrana 経由) と node:sqlite に流して、結果を型ごと比べる。
 * stopAtFirst: 最初の食い違いで止める。断られた文の後は 2 つの状態が分かれるので、その後の食い違いには意味がない。
 */
export async function runTyped(schema: string[], steps: Step[], shards: number, o: { stopAtFirst?: boolean } = {}): Promise<TypedRun> {
  const lite = new DatabaseSync(":memory:");
  const c = new SimCluster({ shards });
  const client: Client = clientOf(c, { intMode: "bigint" });
  for (const s of schema) {
    lite.exec(s);
    await client.execute(s);
  }
  const out: TypedRun = { problems: [], relaxed: { integralRealAsInteger: 0, wideIntegerAsRoundedFloat: 0 }, statements: 0 };
  const shown = (x: unknown) => JSON.stringify(x);
  for (const step of steps) {
    out.statements++;
    const norm = step.normalize ?? ((rows: Cell[][]) => rows);
    let want: Cell[][] | "ok" | "error";
    try {
      const st = lite.prepare(step.sql);
      st.setReadBigInts(true);
      st.setReturnArrays(true);
      want = st.columns().length ? norm((st.all(...(step.args as never[])) as unknown as unknown[][]).map((r) => r.map(cell))) : (st.run(...(step.args as never[])), "ok");
    } catch {
      want = "error";
    }
    let got: Cell[][] | "ok" | string;
    try {
      const res = await client.execute({ sql: step.sql, args: step.args as never });
      got = res.columns.length ? norm(res.rows.map((r) => res.columns.map((_c, i) => cell(r[i])))) : "ok";
    } catch (e) {
      const m = (e as Error).message;
      got = /unsupported:/.test(m) ? `unsupported ${m.slice(0, 200)}` : want === "error" ? "error" : `error ${m.slice(0, 160)}`;
    }
    // Hrana は値を JSON で運ぶので、REAL の無限大を運べない (sqld も同じ)。クライアントの誤りになるのを、正しいとする。
    if (typeof got === "string" && /HRANA_PROTO_ERROR/.test(got) && /"r-?Infinity"/.test(shown(want))) continue;
    const same = Array.isArray(want) && Array.isArray(got) ? sameRows(want, got, out.relaxed) : want === got;
    if (!same) {
      out.problems.push(`${step.sql} ${shown(step.args.map(cell))}\n  sqlite: ${shown(want).slice(0, 300)}\n  ours:   ${shown(got).slice(0, 300)}`);
      if (o.stopAtFirst) break;
    }
  }
  return out;
}

// ---- 2 つ目の生成器 ----

export const SCHEMA2 = [
  "CREATE TABLE tv(id INTEGER PRIMARY KEY, i INTEGER, r REAL, n NUMERIC, t TEXT, u)",
  "CREATE TABLE tk(k TEXT PRIMARY KEY, v)",
  "CREATE TABLE nk(k NUMERIC PRIMARY KEY, v)",
  "CREATE TABLE ik(k INT PRIMARY KEY, v)",
  "CREATE TABLE uk(k PRIMARY KEY, v)",
];

export interface Script2Options {
  /** 2^53 を超える整数を値に混ぜる。いまは保存を断るので (計画書の K1)、段 3 までは test/open/ でだけ使う。 */
  wideIntegers?: boolean;
  /** NUL を含む文字列を値に混ぜる。いまは Worker の SQLite を通ると切れるので (test/open/nul-in-text.test.ts)、test/open/ でだけ使う。 */
  nul?: boolean;
}

/** 元の生成器の値に、2^63 以上の REAL と、2^53 の前後の整数の値の REAL を足したもの。指定すれば、2^53 を超える整数と NUL も足す。 */
function valueOf2(r: () => number, o: Script2Options): Arg {
  const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)]!;
  switch (Math.floor(r() * 8)) {
    case 0: return pick([0n, 1n, 5n, -3n, 12n, 2n ** 40n, -(2n ** 53n) + 1n, 2n ** 53n - 1n]);
    case 1: return pick([2.0, 5.0, 0.5, 2.5, -0.25, 0.1 + 0.2, 1e20, 123456789.123456789, 3.0e-7]);
    // "9223372036854775808" は、どの列でも INTEGER にならない (64 ビットに収まらないので REAL になる)。
    case 2: return pick(["5", " 12 ", "+5", ".5", "5.", "1e3", "0x10", "1e400", "007", "3.0", "abc", "", "-", "9223372036854775808", ...(o.wideIntegers ? ["9007199254740993", "-9223372036854775808"] : [])]);
    case 3: return pick([new Uint8Array([1, 2]), new Uint8Array([]), new Uint8Array([0, 255, 0])]);
    case 4: return null;
    // 2^63 以上の REAL。INTEGER の列に入っても REAL のままである。2^53 以上で 2^63 未満の整数の値の REAL は、INTEGER や NUMERIC の
    // 列で 2^53 を超える INTEGER になる (いまは保存を断る) ので、wideIntegers のときだけ混ぜる。
    case 5: return pick([2 ** 63, 2 ** 64, 1e19, -(2 ** 63) - 2048, 1.5e19, ...(o.wideIntegers ? [2 ** 53, 2 ** 53 + 2, 2 ** 60, -(2 ** 53), -(2 ** 63)] : [])]);
    case 6:
      if (o.wideIntegers) return pick([2n ** 53n, 2n ** 53n + 1n, -(2n ** 53n) - 1n, 2n ** 63n - 1n, -(2n ** 63n), 1541815603606036480n, 2n ** 60n, 2n ** 60n + 1n]);
      return pick([1n, 2n, 3n, 2.0, 3.0, "2", "3"]);
    default:
      if (o.nul) return pick(["a\u0000b", "\u0000", "x\u0000", "a\u0000b", "é\u0000é"]);
      return pick(["a b", "é", "x'y", 'q"r']);
  }
}

/** 行ごとに値の違う列 (`random()`) の結果。値そのものではなく、値が許した集まりに入っているかだけを残す。 */
const oneOf = (allowed: Cell[]) => (rows: Cell[][]) => rows.map((row) => row.map((v) => (allowed.includes(v) ? "valid" : `unexpected ${v}`)));

/**
 * 元の生成器が作らない文。RETURNING (整数を入れた REAL の列を含む)、`random()` の列、WITH で始まる文、重なった列名、
 * 100 列の結果、文末の注釈、ORDER BY と LIMIT のある複合 SELECT。
 */
export function script2(seed: number, length: number, o: Script2Options = {}): Step[] {
  const r = prng(seed);
  const n = (m: number) => Math.floor(r() * m);
  const pick = <T,>(xs: T[]) => xs[n(xs.length)]!;
  const v = () => valueOf2(r, o);
  // 主キーの NULL は、断ると決めてある (unsupported。計画書の不変条件 6)。断った文は SQLite と状態が分かれるので、作らない。
  const vk = (): Arg => {
    for (;;) {
      const x = v();
      if (x !== null) return x;
    }
  };
  const keyTable = () => pick(["tk", "nk", "ik", "uk"]);
  let id = 0;
  const some = () => BigInt(1 + n(Math.max(id, 1)));
  // 100 列の結果。DO の SQLite の列の上限ちょうどである。
  const hundred = Array.from({ length: 100 }, (_, i) => pick(["u", "typeof(u)", "r", "i", "n", "t", `${i}`, `${i}.0`, "typeof(r)", "id"])).join(", ");
  const steps: Step[] = [];
  for (let k = 0; k < length; k++) {
    steps.push(pick<() => Step>([
      // 書き込み。整数を REAL の列に、REAL を型のない列に入れる。
      () => ({ sql: "INSERT INTO tv(id, i, r, n, t, u) VALUES (?, ?, ?, ?, ?, ?)", args: [BigInt(++id), v(), v(), v(), v(), v()] }),
      () => ({ sql: `INSERT INTO ${keyTable()}(k, v) VALUES (?, ?)`, args: [vk(), v()] }),
      // RETURNING。REAL の列に入れた整数の値は、REAL で返る。
      () => ({ sql: "INSERT INTO tv(id, i, r, n, t, u) VALUES (?, ?, ?, ?, ?, ?) RETURNING id, typeof(r), r, typeof(u), u, typeof(n), n, typeof(t), hex(t)", args: [BigInt(++id), v(), pick<Arg>([5n, 2n, 7n, 2.0, v()]), v(), v(), v()] }),
      () => ({ sql: "INSERT INTO tv(id, r, u) VALUES (?, ?, ?) RETURNING *", args: [BigInt(++id), pick<Arg>([5n, 3n, 0.5]), v()] }),
      () => ({ sql: `UPDATE tv SET ${pick(["i", "r", "n", "t", "u"])} = ? WHERE id = ? RETURNING id, typeof(r), r, typeof(u), u, r + 1, typeof(u || '')`, args: [v(), some()] }),
      () => ({ sql: "UPDATE tv SET r = ?, u = r WHERE id = ? RETURNING r, typeof(u), u, r * 2", args: [pick<Arg>([4n, 9n, 1.5]), some()] }),
      () => ({ sql: `INSERT INTO ${keyTable()}(k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v RETURNING typeof(k), k, typeof(v), v`, args: [vk(), v()] }),
      () => ({ sql: `DELETE FROM ${keyTable()} WHERE k = ? RETURNING typeof(k), k, typeof(v), v`, args: [v()] }),
      // `random()` の列。値は行ごとに違うが、値と型は食い違わない。
      () => ({ sql: "SELECT CASE WHEN random() % 2 THEN 5 ELSE 'x' END AS x FROM tv", args: [], normalize: oneOf(["i5", "tx"]) }),
      () => ({ sql: "SELECT CASE abs(random()) % 4 WHEN 0 THEN 5 WHEN 1 THEN 5.5 WHEN 2 THEN 'five' ELSE NULL END AS x, 7 AS y FROM tv WHERE id >= ?", args: [some()], normalize: oneOf(["i5", "r5.5", "tfive", null, "i7"]) }),
      () => ({ sql: "SELECT typeof(random()) AS t, count(*) FROM tv GROUP BY 1", args: [] }),
      // WITH で始まる文。
      () => ({ sql: "WITH w(a, b) AS (SELECT id, u FROM tv) SELECT a, typeof(b), b FROM w ORDER BY a", args: [] }),
      () => ({ sql: "WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM c WHERE i < 3) SELECT i, (SELECT count(*) FROM tv WHERE id >= i) AS m, i / 2.0 FROM c", args: [] }),
      () => ({ sql: "WITH w AS (SELECT r, typeof(r) AS t FROM tv WHERE id = ?) SELECT t, r, r FROM w", args: [some()] }),
      // 重なった列名。
      () => ({ sql: "SELECT id, id, u, typeof(u) AS id, u AS u FROM tv ORDER BY 1", args: [] }),
      () => ({ sql: "SELECT a.id, b.id, a.u, b.r FROM tv a JOIN tv b ON a.id = b.id ORDER BY 1", args: [] }),
      // 100 列の結果。
      () => ({ sql: `SELECT ${hundred} FROM tv WHERE id = ?`, args: [some()] }),
      () => ({ sql: `SELECT ${hundred} FROM tv ORDER BY id`, args: [] }),
      // 文末の注釈、ORDER BY と LIMIT のある複合 SELECT。
      () => ({ sql: "SELECT id, typeof(u), u, hex(t) FROM tv ORDER BY id -- trailing comment", args: [] }),
      () => ({ sql: "SELECT typeof(u), u FROM tv UNION ALL SELECT typeof(r), r FROM tv ORDER BY 1, 2 LIMIT 7", args: [] }),
      // 元の生成器と同じ読み。TEXT は 16 進でも読む (ドライバによっては、NUL から後ろを落として返す)。
      () => ({ sql: "SELECT id, typeof(i), i, typeof(r), r, typeof(n), n, typeof(t), hex(t), typeof(u), u FROM tv WHERE id = ?", args: [some()] }),
      () => ({ sql: "SELECT id, typeof(u), u, typeof(t), hex(t), length(t) FROM tv ORDER BY id", args: [] }),
      () => ({ sql: `SELECT typeof(k), k, typeof(v), v FROM ${keyTable()} ORDER BY k`, args: [] }),
      () => ({ sql: `SELECT typeof(k), k, v FROM ${keyTable()} WHERE k = ?`, args: [v()] }),
      () => ({ sql: "SELECT ? AS x, typeof(?) AS t, ? + 1 AS y", args: (() => { const x = v(); return [x, x, x]; })() }),
      () => ({ sql: "INSERT INTO tv(id, i, r, n, t, u) SELECT ?, i, r, n, t, u FROM tv WHERE id = ?", args: [BigInt(++id), BigInt(1 + n(Math.max(id - 1, 1)))] }),
      () => ({ sql: `INSERT OR IGNORE INTO ${keyTable()}(k, v) SELECT u, t FROM tv WHERE id = ? AND u IS NOT NULL`, args: [some()] }),
    ])());
  }
  return steps;
}
