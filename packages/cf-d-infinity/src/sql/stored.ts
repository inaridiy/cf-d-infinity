// 値が、型の親和性のある列に入ったときに SQLite が入れる値 (docs/design-values.md の「型の親和性の変換」。値の作り直しの段 1)。
//
// Worker は、行を置くシャードを、文の中の値から決める。値が列に入ると SQLite は型の親和性で変換するので、キーは変換した後の値で
// 作らなければならない。段 2 までの storedAs (src/keys.ts) は、数に読める文字列の文法を正規表現で写していた。ここでは写さない。
// 変換のない場合と、1 行で書ける正確な変換だけを JS で決め、ほかは Worker の SQLite (sql.js) の列に入れて、入った値を読む。
//
// プランナ (src/sql/plan.ts の pinsOf、pkOf、planInsert) が呼ぶ。変換の SQLite は、Worker の SQLite (src/sql/scratch.ts) が sql.js を
// 初期化するときに一緒に開く (同じ engine を使う。sql.js を 2 つ読み込まない)。文を計画する前に、Db がその初期化を待つ (runPlanned)。
import type { Database, SqlJsStatic, Statement } from "sql.js";
import type { Affinity, Value } from "../types";
import { decodeElem, jsonElemSql } from "../value";

/** 型の親和性ごとの列を持つ、1 行だけの表。TEXT と型なしの列は要らない (その変換は JS で決まるか、決めない)。 */
const COLUMNS = ["n", "i", "r"] as const;
const DDL = "CREATE TABLE conv(id INTEGER PRIMARY KEY, n NUMERIC, i INTEGER, r REAL)";
/**
 * 値を 3 つの列に入れ、入った値をタプルで読む文。CAST は使わない。`CAST('abc' AS INTEGER)` は 0 だが、列の親和性は 'abc' を
 * TEXT のまま残す。入った値は、素の列ではなくタプル (JSON) で読む。sql.js のドライバは、結果の TEXT を最初の NUL で切って
 * 返すので、素の列で読むと、NUL を含む文字列 (数の列でも文字列のまま残る) が切れる。
 */
const convert = (bound: string) =>
  `INSERT OR REPLACE INTO conv(id, n, i, r) VALUES (1, ${bound}, ${bound}, ${bound}) RETURNING json_array(${COLUMNS.map(jsonElemSql).join(", ")})`;

interface Conversion {
  db: Database;
  /** 束縛する値の型ごとの文。sql.js は BigInt を TEXT として、32 ビットに収まる整数の値の数を INTEGER として束縛するので、包んで型を決める。 */
  text: Statement;
  integer: Statement;
  real: Statement;
  /** 直前の変換。同じ値を、複数の列の親和性で続けて尋ねることが多い。 */
  last: { v: Value; out: Value[] } | null;
}
let conversion: Conversion | null = null;

/** 変換のための SQLite を、もう開いたか。 */
export const storedValueReady = (): boolean => conversion !== null;

/**
 * 変換のための SQLite を開く。isolate に 1 つだけ開いて、持ち続ける。2 回目からは何もしない。
 * engine は、sql.js の初期化の結果である。Worker では wasm を実行時に生成できないので、engine は呼ぶ側が用意する。
 */
export async function initStoredValue(engine: SqlJsStatic | Promise<SqlJsStatic>): Promise<void> {
  if (conversion) return;
  const SQL = await engine;
  if (conversion) return;
  const db = new SQL.Database();
  db.run(DDL);
  conversion = {
    db,
    text: db.prepare(convert("?1")),
    integer: db.prepare(convert("(CAST(?1 AS INTEGER)+0)")),
    real: db.prepare(convert("(CAST(?1 AS REAL)+0.0)")),
    last: null,
  };
}

/** 値を数の 3 つの列に入れて、入った値を [NUMERIC, INTEGER, REAL] の順に返す。 */
function inColumns(v: bigint | number | string): Value[] {
  const c = conversion;
  if (!c) throw new Error("storedValue was called before initStoredValue; wait for initStoredValue() once before planning a statement");
  if (c.last && Object.is(c.last.v, v)) return c.last.out;
  const [st, bound] = typeof v === "string" ? [c.text, v] : typeof v === "bigint" ? [c.integer, String(v)] : [c.real, v];
  const row = st.get([bound]);
  st.reset();
  const out = (JSON.parse(row[0] as string) as (string | null)[]).map(decodeElem);
  c.last = { v, out };
  return out;
}

/**
 * 値 v が、型の親和性 a の列に入ったときに SQLite が入れる値。Worker が SQLite と同じに決められない変換では undefined を返す。
 * 呼ぶ側は、その値では行の置き場所を絞らず、書き込みは基準経路に回して、変換を SQLite にさせる。
 *
 * undefined を返すのは、REAL を TEXT にする変換だけである。SQLite は `%!.15g` で書くが、15 桁への丸め方は版ごとのアルゴリズムで
 * 決まる (3.43 で変わった)。Worker の SQLite と DO の SQLite は版が違うので、Worker で変換した文字列が、シャードに入る文字列と
 * 同じとは限らない。違えば、その行は Worker が思うのと別のシャードにある。
 * 文字列を数にする変換も版に依り得るが、手元の workerd の DO の SQLite と sql.js は、11 万個の文字列で 1 件も食い違わなかった
 * (test/workerd-limits.test.ts が流し続ける)。
 */
export function storedValue(v: Value, a: Affinity): Value | undefined {
  if (!conversion) throw new Error("storedValue was called before initStoredValue; wait for initStoredValue() once before planning a statement");
  // SQLite は NaN を NULL として束縛する。型のない列でも同じである。
  if (typeof v === "number" && Number.isNaN(v)) return null;
  if (v === null || v instanceof Uint8Array || a === "BLOB") return v;
  if (typeof v === "string") return a === "TEXT" ? v : inColumns(v)[at(a)];
  if (typeof v === "bigint") {
    if (a === "TEXT") return String(v);
    if (a !== "REAL") return v;
    // 2^53 までの整数は、REAL でも同じ値である。それより大きい整数は、いちばん近い double になる。丸め方は SQLite に任せる。
    return v >= -MAX_SAFE && v <= MAX_SAFE ? Number(v) : inColumns(v)[at(a)];
  }
  if (a === "TEXT") return undefined;
  if (a === "REAL") return v;
  // INTEGER と NUMERIC の列は、値を変えずに整数にできる REAL を INTEGER にする。2^53 を超える整数の値と、整数でない値は SQLite に任せる。
  return Number.isSafeInteger(v) ? BigInt(v) : inColumns(v)[at(a)];
}

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const at = (a: Affinity): number => COLUMNS.indexOf(a === "NUMERIC" ? "n" : a === "INTEGER" ? "i" : "r");
