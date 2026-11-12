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

/** SQLite が REAL を文字列にする書き方 (`%!.15g`)。有効数字 15 桁で、整数の値にも小数点を付ける。 */
export function realText(x: number): string {
  if (Number.isNaN(x)) return "";
  if (!Number.isFinite(x)) return x > 0 ? "Inf" : "-Inf";
  if (x === 0) return "0.0";
  const [mant, expStr] = x.toExponential(14).split("e") as [string, string];
  const e = Number(expStr);
  const trim = (t: string) => {
    const u = t.replace(/0+$/, "");
    return u.endsWith(".") ? `${u}0` : u;
  };
  if (e < -4 || e >= 15) return `${trim(mant)}e${e < 0 ? "-" : "+"}${String(Math.abs(e)).padStart(2, "0")}`;
  return trim(x.toFixed(14 - e));
}

/** 値が、型の親和性 a の列に入ったときに SQLite が入れる値。 */
export function storedAs(v: Value, a: Affinity): Value {
  if (v === null || v instanceof Uint8Array || a === "BLOB") return v;
  if (typeof v === "string") {
    if (a === "TEXT") return v;
    const n = textAsNumber(v);
    if (n === null) return v;
    return a === "REAL" ? toReal(n) : toNumeric(n);
  }
  // 数。整数の JS の数は INTEGER、それ以外は REAL (src/value.ts)。
  if (a === "TEXT") return isIntegerValue(v) ? String(v) : realText(isReal(v) ? v.real : (v as number));
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

/** 列に入る値のキー文字列。Worker が、文の中の値から行の置き場所を決めるときに使う。 */
export function keyOfValues(values: Value[], affinities: Affinity[]): string {
  return keyString(values.map((v, i) => storedAs(v, affinities[i] ?? "BLOB")));
}
