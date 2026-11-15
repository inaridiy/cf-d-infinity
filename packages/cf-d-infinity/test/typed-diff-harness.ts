// 値の型を保った突き合わせと、そのための 2 つ目の生成器 (docs/design-values.md の「足す検査」の 2)。
// test/typed-diff.test.ts が使う。
//
// test/typed-diff.test.ts の元の比較は、結果の BigInt を数にしてから比べるので、結果の INTEGER と REAL の違いを見ない。
// ここでは @libsql/client を intMode: "bigint" で使う。INTEGER は BigInt、REAL は JS の数で返るので、型ごと比べられる。
// 基準の node:sqlite も BigInt で読む。
//
// 元の生成器 (typed-diff.test.ts の valueOf と script) には手を入れない。選ぶ候補を 1 つ足すと、乱数の引き方がずれて、
// これまでの seed が別の台本になる。足す値と文は、ここの 2 つ目の生成器 (script2) に置く。
import type { Client } from "@libsql/client";
import { DatabaseSync } from "node:sqlite";
import { bindParams, ident, parseStatements, render, type Node } from "../src/sql/cst";
import { returningClause, rewriteReturning } from "../src/sql/returning";
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

// ---- 比較 ----
//
// 結果を型ごと比べる。段 0 から段 2 までは、文書にある 2 点 (整数の値の REAL を Hrana の `integer` で返す、SQL の中で計算した 2^53 を
// 超える整数を丸めて `float` で返す) を緩めていた。値の作り直しの段 3 で、どちらの違いもなくなったので、緩めるのをやめた。

/** 2 つの結果が同じか。 */
function sameRows(want: Cell[][], got: Cell[][]): boolean {
  return JSON.stringify(want) === JSON.stringify(got);
}

// ---- 基準の読み方 ----
//
// node:sqlite のドライバは、結果の TEXT を最初の NUL で切って返す (docs/design-values.md の「確かめた事実」)。そのまま読むと、
// NUL を含む TEXT は、基準の側でも切れて、D∞ が切っても食い違いが見えない (test/open/nul-in-text.test.ts が見つけた検査の欠け)。
// 基準は、TEXT を BLOB にして読み、UTF-8 として戻す (CAST(... AS BLOB) は全部のバイトを返す)。
// - 結果を返す文 (SELECT、VALUES、WITH) は、文を包み直して、結果の列ごとに TEXT を BLOB、BLOB を 16 進にする。
// - DML の RETURNING は包めないので、項ごとに書き換える。項の切り分けは D∞ と同じ関数 (src/sql/returning.ts) を使うが、要素の式と
//   読み方はここに独立に置く。台本の typeof() と hex() の項が、書き換えに頼らない確かめである。

const READS_ROWS = /^\s*(SELECT|VALUES|WITH)\b/i;
const utf8 = new TextDecoder();
const unhex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (h) => parseInt(h, 16));

/** 結果を返す文を包み直して、TEXT を全部読む。 */
function wholeSelect(sql: string, n: number): string {
  const cols = Array.from({ length: n }, (_v, i) => `"c${i}"`);
  const read = cols.map((c) => `CASE typeof(${c}) WHEN 'text' THEN CAST(${c} AS BLOB) WHEN 'blob' THEN hex(${c}) ELSE ${c} END`);
  return `WITH "__ref"(${cols.join(", ")}) AS (\n${sql}\n) SELECT ${read.join(", ")} FROM (SELECT * FROM "__ref" LIMIT -1 OFFSET 0)`;
}
const fromWhole = (v: unknown): unknown => (v instanceof Uint8Array ? utf8.decode(v) : typeof v === "string" ? unhex(v) : v);

/** RETURNING の項の要素の式。どの格納の型にも印を付け、TEXT は BLOB で運ぶ。 */
const returnedElem = (c: string) =>
  `CASE typeof(${c}) WHEN 'integer' THEN 'i'||${c} WHEN 'text' THEN CAST(${c} AS BLOB) WHEN 'real' THEN 'r'||quote(${c}) WHEN 'blob' THEN 'b'||hex(${c}) END`;
function fromReturned(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (v instanceof Uint8Array) return utf8.decode(v);
  const s = v as string;
  return s[0] === "i" ? BigInt(s.slice(1)) : s[0] === "r" ? Number(s.slice(1)) : unhex(s.slice(1));
}

/** 文が書く表の名前。 */
function writtenTable(stmt: Node): string {
  const head = (stmt.clauses as Node[]).find((c) => /^(insert|update|delete)_clause$/.test(c.type));
  let t: Node = head.type === "insert_clause" ? head.table : head.tables.items[0];
  while (t.type === "alias" || t.expr) t = t.expr;
  return ident(t.type === "member_expr" ? t.property : t);
}

/** 基準の node:sqlite で文を実行する。結果を返さない文は "ok"。 */
export function referenceRows(lite: DatabaseSync, sql: string, args: Arg[]): Cell[][] | "ok" {
  const st = lite.prepare(sql);
  const n = st.columns().length;
  if (n === 0) return (st.run(...(args as never[])), "ok");
  let read = st;
  let args2: unknown[] = args;
  let convert: (v: unknown) => unknown = (v) => v;
  if (READS_ROWS.test(sql)) {
    read = lite.prepare(wholeSelect(sql, n));
    convert = fromWhole;
  } else {
    const stmt = parseStatements(sql)[0];
    const values = bindParams(stmt, args as never);
    const clause = returningClause(stmt);
    if (clause) {
      const table = writtenTable(stmt);
      const columns = (lite.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as { name: string }[]).map((r) => r.name);
      rewriteReturning(clause, columns, returnedElem);
      const r = render(stmt, values);
      read = lite.prepare(r.sql);
      args2 = r.params;
      convert = fromReturned;
    }
  }
  read.setReadBigInts(true);
  read.setReturnArrays(true);
  return (read.all(...(args2 as never[])) as unknown as unknown[][]).map((r) => r.map((v) => cell(convert(v))));
}

export interface TypedRun { problems: string[]; statements: number }

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
  const out: TypedRun = { problems: [], statements: 0 };
  const shown = (x: unknown) => JSON.stringify(x);
  for (const step of steps) {
    out.statements++;
    const norm = step.normalize ?? ((rows: Cell[][]) => rows);
    let want: Cell[][] | "ok" | "error";
    try {
      const rows = referenceRows(lite, step.sql, step.args);
      want = rows === "ok" ? "ok" : norm(rows);
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
    const same = Array.isArray(want) && Array.isArray(got) ? sameRows(want, got) : want === got;
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
  /** 2^53 を超える整数を値に混ぜる。 */
  wideIntegers?: boolean;
  /** NUL を含む文字列を値に混ぜる。 */
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
