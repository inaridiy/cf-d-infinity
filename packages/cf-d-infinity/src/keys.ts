// 行と shard key の同一性 (計画書の不変条件 6)。キー文字列を作る関数はここだけにある。
//
// Worker は、行を置くシャードを、文の中の値から決める。シャードは、入った行の値から行のキーを作る。2 つが同じになるように、
// Worker は、値が列に入ったときに SQLite が何を入れるか (型の親和性による変換) を、ここで写す (`storedAs`)。
// 写し方は、SQLite の文書の「Type Affinity」と、test/open/typed-diff.test.ts の突き合わせで確かめる。
import type { Affinity, Value } from "./types";
import { isIntegerValue, isReal, realOf, type Real, type TypedValue } from "./value";

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

// ---- 新しいキー文字列 (docs/design-values.md の「キー文字列」。値の作り直しの段 1) ----
//
// ここから下は、まだどこからも呼ばれていない。段 2 で、keyString を keyStringExact に、キー文字列を JSON.parse で読んでいる場所を
// keyValues に替える。形は keyString と同じ (値の並びの JSON) で、数の書き方だけが違う。
// - INTEGER は、桁数に関わらず 10 進の数字で書く。
// - REAL は、整数の値で 64 ビットの整数の範囲 (-2^63 以上、2^63 未満) にあれば、その整数の数字で書く。そうでなければ、
//   keyString と同じ JSON の表記で書く。
// SQLite は INTEGER と REAL を正確に比べる。REAL の 2^53 と INTEGER の 2^53 は同じキーで、INTEGER の 2^53 + 1 は別のキーである。
// JS の数の表記は、2^53 以上では double の正確な値ではないので (2^62 + 1024 は 4611686018427389000 と書かれる)、
// 整数の値の REAL は BigInt にしてから書く。こうすると、キー文字列が等しいことと、SQLite が同じキーと見なすことが、
// 2^53 を超えても一致する (test/key-conversions.test.ts)。
//
// いま保存できる値のキーは、1 つの場合を除いて keyString と 1 バイトも変わらない。変わるのは、絶対値が 2^53 以上で、
// 64 ビットの整数の範囲にある、整数の値の REAL のうち、JS の表記が正確な値と違うものである。

const lowerHex = (b: Uint8Array) => {
  let s = "";
  for (const x of b) s += (x < 16 ? "0" : "") + x.toString(16);
  return s;
};

/** 数のキー。INTEGER として渡された JS の数 (今の Value) も、REAL も、同じ規則で書く。 */
function numberKey(x: number): string {
  if (Number.isInteger(x) && x >= -(2 ** 63) && x < 2 ** 63) return BigInt(x).toString();
  if (!Number.isFinite(x)) return `{"$f":${JSON.stringify(String(x))}}`;
  return JSON.stringify(x);
}

/**
 * キー文字列。値は、今の `Value` (整数の JS の数は INTEGER、`Real` は整数の値の REAL) でも、型のある値 (bigint は INTEGER、
 * number は REAL) でもよい。数のキーは INTEGER と REAL で同じ規則なので、どちらの決まりで渡しても同じ文字列になる。
 */
export function keyStringExact(values: (TypedValue | Real)[]): string {
  const parts = values.map((v) => {
    if (v === null) return "null";
    if (typeof v === "bigint") {
      if (v < INT64_MIN || v > INT64_MAX) throw new RangeError(`the integer ${v} does not fit in 64 bits`);
      return v.toString();
    }
    if (typeof v === "number") return numberKey(v);
    if (typeof v === "string") return JSON.stringify(v);
    if (v instanceof Uint8Array) return `{"$b":"${lowerHex(v)}"}`;
    return numberKey(v.real);
  });
  return `[${parts.join(",")}]`;
}

/**
 * キー文字列を値に戻す。整数は INTEGER (bigint) で返す。整数の値の REAL から作ったキーも INTEGER で戻るが、戻した値は
 * `WHERE 主キー IS ?` に束縛するので、REAL で入っている同じ値の行にも当たる (SQLite は INTEGER と REAL を正確に比べる)。
 *
 * JSON.parse は 2^53 以上の整数を丸めるので、reviver が受け取る元の文面 (context.source) から読む。Node 24 と workerd にある
 * (test/workerd-limits.test.ts)。ない実行環境では、丸まった整数を黙って返さずに、投げる。
 */
export function keyValues(key: string): TypedValue[] {
  const reviver = (_k: string, x: unknown, context?: { source?: string }): unknown => {
    if (typeof x === "number") {
      const source = context?.source;
      if (source === undefined) {
        // 元の文面がない。64 ビットの整数の範囲の外の数は REAL としてしか書かれないので、そのまま返せる。範囲の中の、
        // 2^53 以上の整数は、丸まった後の値しか分からない。
        if (!Number.isInteger(x) || x >= 2 ** 63 || x < -(2 ** 63)) return x;
        if (!Number.isSafeInteger(x)) throw new Error("this runtime does not pass the source text to a JSON.parse reviver; a key with an integer beyond 2^53 cannot be read exactly");
        return BigInt(x);
      }
      if (!/^-?\d+$/.test(source)) return x;
      const big = BigInt(source);
      return big >= INT64_MIN && big <= INT64_MAX ? big : x;
    }
    if (x !== null && typeof x === "object" && !Array.isArray(x)) {
      const o = x as { $b?: unknown; $f?: unknown };
      if (typeof o.$b === "string") return Uint8Array.from(o.$b.match(/../g) ?? [], (h) => parseInt(h, 16));
      if (typeof o.$f === "string") return Number(o.$f);
    }
    return x;
  };
  return JSON.parse(key, reviver as (this: unknown, key: string, value: unknown) => unknown) as TypedValue[];
}
