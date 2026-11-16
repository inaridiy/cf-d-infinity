// 入口の値の場面 (計画書の未解決の問題 47、不変条件 11)。シミュレータの試験 (test/entry-values.test.ts) と、本物の workerd の試験
// (test/binding.test.ts が test/fixtures/app.ts を通して流す) が、同じ入力と同じ期待を使う。期待は docs/design-values.md の
// 「D1 互換の API、Service Binding、HTTP の JSON」の規則である。
//
//   - HTTP の /sql と /batch: JSON の数の literal は文面で決める。数字だけなら INTEGER (64 ビットまで正確)、小数点か指数があれば REAL。
//     64 ビットに収まらない数字だけの literal は、SQLite の literal と同じく REAL である。
//   - D1 互換の API と Service Binding: JS の数は、安全な整数なら INTEGER、ほかは REAL。bigint は INTEGER で、64 ビットの外は断る。
//     BLOB は Uint8Array、ArrayBuffer、型つき配列のバイトである (D1 は型つき配列を要素ごとに 1 バイトへ切る。src/client/d1.ts)。
//   - D1 互換の API だけは、D1 と同じく、0 以上 256 未満の数の配列を BLOB として受け付ける (2026-11-16、持ち主から任された判断)。
//     要素は 0 へ向けて切り捨てる (1.5 は 1)。範囲の外の数、数でない要素、穴のある配列は、bind が断る。Service Binding と HTTP は、
//     配列を断る。D1 の挙動は Miniflare 4.20260730.0 のローカルの D1 で測った (docs/sql-language.md の「引数の型」)。
//   - どの入口も、値でないもの (配列、object など) を、文を実行する前に利用者の誤りとして断る。内部の TypeError にしない。
import type { Value } from "../src/types";

export type Want = { t: string; v: Value } | { error: RegExp };

/** 表を読まない文。答えるのは、シャードが 1 つならシャード、2 つ以上なら Worker の SQLite である。 */
export const SELECT = "SELECT typeof(?1) AS t, ?1 AS v";
/** 値を主キーにも列にも置く。値はキー文字列 (src/keys.ts) と要素 (src/value.ts) になり、シャードが主キーで読み書きする。 */
export const TABLE = "CREATE TABLE IF NOT EXISTS ev(n INTEGER, id, x, PRIMARY KEY (n, id))";
export const INSERT = "INSERT INTO ev(n, id, x) VALUES (?1, ?2, ?2)";
export const BY_KEY = "SELECT typeof(id) AS t, id AS v, typeof(x) AS tx, x AS vx FROM ev WHERE n = ?1 AND id = ?2";

const ARRAY = /parameter \d+ is an array/;
const OBJECT = /parameter \d+ is an object/;
const WIDE = /parameter \d+: the integer -?\d+ does not fit in 64 bits/;
/** D1 互換の API が断る配列 (バイトにならない要素がある)。 */
const BYTES = /parameter \d+ is an array with .+ at index \d+; an array parameter is the bytes of a BLOB/;
const blob = (...b: number[]) => ({ t: "blob", v: new Uint8Array(b) });

/** HTTP の本文の JSON の literal (文面のまま送る) と、規則が決める値。 */
export const HTTP_LITERALS: [string, Want][] = [
  ["5", { t: "integer", v: 5n }],
  ["5.0", { t: "real", v: 5 }],
  ["1e5", { t: "real", v: 100000 }],
  ["1E5", { t: "real", v: 100000 }],
  ["1e20", { t: "real", v: 1e20 }],
  ["0.5", { t: "real", v: 0.5 }],
  ["-0", { t: "integer", v: 0n }],
  ["9223372036854775807", { t: "integer", v: 2n ** 63n - 1n }],
  ["-9223372036854775808", { t: "integer", v: -(2n ** 63n) }],
  ["9007199254740993", { t: "integer", v: 2n ** 53n + 1n }],
  ["99999999999999999999", { t: "real", v: 1e20 }],
  ["true", { t: "integer", v: 1n }],
  ["false", { t: "integer", v: 0n }],
  ['"x"', { t: "text", v: "x" }],
  ["[65,66]", { error: ARRAY }],
  ["[]", { error: ARRAY }],
  ['{"a":1}', { error: OBJECT }],
];

/**
 * D1 互換の API と Service Binding に渡す JS の値と、規則が決める値。rpc が false の値は、structured clone で運べないので、
 * Service Binding では流さない (呼び出し元の実行環境が送る前に断る)。d1 は、D1 互換の API の期待が Service Binding と違う値の、
 * D1 互換の API の期待である (数の配列)。
 */
export const JS_VALUES: { label: string; value: () => unknown; want: Want; d1?: Want; rpc?: false }[] = [
  { label: "5", value: () => 5, want: { t: "integer", v: 5n } },
  // JS の数では 5.0 と 5 を見分けられない。
  { label: "5.0", value: () => 5.0, want: { t: "integer", v: 5n } },
  { label: "1e5", value: () => 1e5, want: { t: "integer", v: 100000n } },
  { label: "1e20", value: () => 1e20, want: { t: "real", v: 1e20 } },
  { label: "2 ** 63", value: () => 2 ** 63, want: { t: "real", v: 2 ** 63 } },
  { label: "0.5", value: () => 0.5, want: { t: "real", v: 0.5 } },
  { label: "-0", value: () => -0, want: { t: "integer", v: 0n } },
  { label: "2n ** 63n - 1n", value: () => 2n ** 63n - 1n, want: { t: "integer", v: 2n ** 63n - 1n } },
  { label: "-(2n ** 63n)", value: () => -(2n ** 63n), want: { t: "integer", v: -(2n ** 63n) } },
  { label: "2n ** 63n", value: () => 2n ** 63n, want: { error: WIDE } },
  { label: "-(2n ** 63n) - 1n", value: () => -(2n ** 63n) - 1n, want: { error: WIDE } },
  { label: "true", value: () => true, want: { t: "integer", v: 1n } },
  { label: "false", value: () => false, want: { t: "integer", v: 0n } },
  { label: '"x"', value: () => "x", want: { t: "text", v: "x" } },
  { label: "Uint8Array", value: () => new Uint8Array([65, 66]), want: { t: "blob", v: new Uint8Array([65, 66]) } },
  { label: "ArrayBuffer", value: () => new Uint8Array([65, 66]).buffer, want: { t: "blob", v: new Uint8Array([65, 66]) } },
  { label: "Uint16Array", value: () => new Uint16Array([0x4241]), want: { t: "blob", v: new Uint8Array([0x41, 0x42]) } },
  // 数の配列。D1 互換の API は、D1 と同じく BLOB として受け付け、Service Binding は断る。
  { label: "[65, 66]", value: () => [65, 66], want: { error: ARRAY }, d1: blob(65, 66) },
  { label: "[]", value: () => [], want: { error: ARRAY }, d1: blob() },
  { label: "[0, 255]", value: () => [0, 255], want: { error: ARRAY }, d1: blob(0, 255) },
  // D1 は、範囲の中の整数でない数を 0 へ向けて切り捨てる。
  { label: "[1.5, 255.9, -0]", value: () => [1.5, 255.9, -0], want: { error: ARRAY }, d1: blob(1, 255, 0) },
  { label: "[256]", value: () => [256], want: { error: ARRAY }, d1: { error: BYTES } },
  { label: "[-1]", value: () => [-1], want: { error: ARRAY }, d1: { error: BYTES } },
  { label: "[-0.5]", value: () => [-0.5], want: { error: ARRAY }, d1: { error: BYTES } },
  { label: "[NaN]", value: () => [NaN], want: { error: ARRAY }, d1: { error: BYTES } },
  { label: "[Infinity]", value: () => [Infinity], want: { error: ARRAY }, d1: { error: BYTES } },
  { label: '["65"]', value: () => ["65"], want: { error: ARRAY }, d1: { error: BYTES } },
  { label: "[65n]", value: () => [65n], want: { error: ARRAY }, d1: { error: BYTES } },
  { label: "[true]", value: () => [true], want: { error: ARRAY }, d1: { error: BYTES } },
  { label: "[null]", value: () => [null], want: { error: ARRAY }, d1: { error: BYTES } },
  { label: "[[1]]", value: () => [[1]], want: { error: ARRAY }, d1: { error: BYTES } },
  { label: "[65, \"x\"]", value: () => [65, "x"], want: { error: ARRAY }, d1: { error: BYTES } },
  // 穴のある配列。D1 は bind で通し、実行のときに本文の誤り (D1_ERROR) で落ちる。D∞ は bind が断る。
  { label: "[, 1]", value: () => [, 1], want: { error: ARRAY }, d1: { error: BYTES } },
  { label: "new Array(2)", value: () => new Array(2), want: { error: ARRAY }, d1: { error: BYTES } },
  { label: "{ a: 1 }", value: () => ({ a: 1 }), want: { error: OBJECT } },
  { label: "Date", value: () => new Date(0), want: { error: OBJECT } },
  { label: "symbol", value: () => Symbol("s"), want: { error: /parameter \d+ is a symbol/ }, rpc: false },
];

/** 値を JSON で運べる形にする (workerd の試験の結果を比べるため)。INTEGER は `<数字>n`、BLOB は `x'<16 進>'` と書く。 */
export function shownValue(v: unknown): unknown {
  if (typeof v === "bigint") return `${v}n`;
  if (v instanceof Uint8Array) return `x'${[...v].map((b) => b.toString(16).padStart(2, "0").toUpperCase()).join("")}'`;
  return v;
}
export const shownRow = (row: Record<string, unknown> | null | undefined): unknown =>
  row ? Object.fromEntries(Object.entries(row).map(([k, v]) => [k, shownValue(v)])) : row;
