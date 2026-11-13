// 行と shard key の同一性 (計画書の不変条件 6)。キー文字列を作る関数はここだけにある。
//
// Worker は、行を置くシャードを、文の中の値から決める。シャードは、入った行の値から行のキーを作る。2 つが同じになるように、
// Worker は、値が列に入ったときに SQLite が何を入れるか (型の親和性による変換) を、ここで写す (`storedAs`)。
// 写し方は、SQLite の文書の「Type Affinity」と、test/open/typed-diff.test.ts の突き合わせで確かめる。
import type { Affinity, Value } from "./types";
import { isIntegerValue, isReal, realOf } from "./value";

const WS = "[ \\t\\n\\v\\f\\r]*";
const NUMERIC_TEXT = new RegExp(`^${WS}([+-]?)(?:(\\d+)(\\.\\d*)?|(\\.\\d+))([eE][+-]?\\d+)?${WS}$`);
const INT64_MAX = 2n ** 63n - 1n;
const INT64_MIN = -(2n ** 63n);

/**
 * 文字列が SQLite の数の literal として読めるなら、その値を返す。整数の literal で 64 ビットに収まれば INTEGER、そうでなければ REAL。
 * 16 進の文字列は読まない (SQLite は型の親和性で 16 進を数にしない)。前後の空白は読み飛ばす。
 */
function textAsNumber(s: string): Value | null {
  const m = NUMERIC_TEXT.exec(s);
  if (!m) return null;
  const isIntLiteral = m[2] !== undefined && m[3] === undefined && m[5] === undefined;
  if (isIntLiteral) {
    const big = BigInt(`${m[1]}${m[2]}`);
    if (big >= INT64_MIN && big <= INT64_MAX) return Number(big);
  }
  return realOf(Number(s.trim()));
}

/** REAL が、値を変えずに 64 ビットの整数になるなら、その整数。 */
function realAsInteger(x: number): number | null {
  return Number.isInteger(x) && Math.abs(x) < 2 ** 63 ? x : null;
}

/**
 * 値が、型の親和性 a の列に入ったときに SQLite が入れる値。Worker が SQLite と同じに作れない変換では undefined を返す。
 *
 * 今は、REAL を TEXT にする変換だけがそれに当たる。SQLite は `%!.15g` で書くが、15 桁への丸め方は版ごとのアルゴリズムで決まる
 * (3.43 で変わった)。JS で写すと、1 つの値でも違えば、その行は Worker が思うのと別のシャードにある。写した関数は 1e14 を "1" と
 * 書き (2026-11-13 の Codex の指摘 C8)、直した後も 15 桁目の丸めが SQLite と違った (test/key-conversions.test.ts)。
 * 呼ぶ側は、その値では行の置き場所を絞らず、書き込みは基準経路に回して、変換を SQLite にさせる。
 */
export function storedAs(v: Value, a: Affinity): Value | undefined {
  if (v === null || v instanceof Uint8Array || a === "BLOB") return v;
  if (typeof v === "string") {
    if (a === "TEXT") return v;
    const n = textAsNumber(v);
    if (n === null) return v;
    return a === "REAL" ? toReal(n) : toNumeric(n);
  }
  // 数。整数の JS の数は INTEGER、それ以外は REAL (src/value.ts)。
  if (a === "TEXT") return isIntegerValue(v) ? String(v) : undefined;
  if (a === "REAL") return toReal(v);
  return toNumeric(v);
}

function toReal(v: Value): Value {
  if (isReal(v)) return v;
  return typeof v === "number" ? realOf(v) : v;
}

function toNumeric(v: Value): Value {
  if (isReal(v)) return realAsInteger(v.real) ?? v;
  if (typeof v === "number" && !isIntegerValue(v)) return realAsInteger(v) ?? v;
  return v;
}

/** キーの値。INTEGER の 5 と REAL の 5.0 は SQLite では同じ主キーなので、同じ文字列にする。 */
function keyValue(v: Value): Value {
  return isReal(v) ? v.real : v;
}

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

/** キー文字列。値の並びを JSON にする。BLOB と、JSON で表せない数 (無限大) には印を付ける。 */
export function keyString(values: Value[]): string {
  return JSON.stringify(values.map(keyValue), (_k, x) =>
    x instanceof Uint8Array ? { $b: hex(x) } : typeof x === "number" && !Number.isFinite(x) ? { $f: String(x) } : x);
}

/**
 * SQL の中でキー文字列の元を作る式 (trigger が変更を捕まえるときに使う)。結果を JSON.parse して keyString に通すと、
 * 同じ行の keyString と同じ文字列になる。BLOB は JSON に入らないので、keyString と同じ印 (小文字の 16 進) の object にする。
 */
export function keySql(exprs: string[]): string {
  // REAL は quote() で書く。SQLite の JSON と printf は有効数字 15 桁か 16 桁で丸めるが、quote() は元の double に戻せる桁数で書く
  // (node:sqlite、workerd、sql.js で確かめた。無限大は 9.0e+999 で、JSON.parse は Infinity に読む)。
  return `json_array(${exprs.map((e) => `CASE typeof(${e}) WHEN 'blob' THEN json_object('$b', lower(hex(${e}))) WHEN 'real' THEN json(quote(${e})) ELSE ${e} END`).join(", ")})`;
}

