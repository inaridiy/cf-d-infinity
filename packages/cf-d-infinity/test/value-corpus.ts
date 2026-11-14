// 値の変換と符号の検査が共有する値の集まり (docs/design-values.md の「足す検査」の 3、4、6)。
//
// 同じ値を、node:sqlite、sql.js、workerd の DO の SQLite に入れて比べる。値を作る関数をここ 1 つにしておくと、3 つの検査が
// 同じ集まりを見ていることが、読めば分かる。乱数は seed から決まるので、どの実行でも同じ値になる。
import { prng } from "./sim";

/** 変換を間違えやすい double。10 の冪、整数の値、15 桁と 17 桁の境、非正規化数の近く。 */
export function doubles(n: number, seed: number): number[] {
  const r = prng(seed);
  const out: number[] = [0.1, 0.5, 1.5, 5, 10, 100, 1e14, 1e15, 1e16, 1e-4, 1e-5, 123456789012345, 1234567890123456, 2 ** 53, 2 ** 63, 1e300, 5e-324, 0.30000000000000004];
  for (let e = -30; e <= 30; e++) out.push(10 ** e, 3 * 10 ** e, -(10 ** e), 1.25 * 10 ** e);
  for (let i = 0; i < n; i++) {
    const e = Math.floor(r() * 60) - 30;
    const kind = r();
    if (kind < 0.3) out.push(Math.round(r() * 1e6) * 10 ** Math.max(0, e)); // 整数の値
    else if (kind < 0.6) out.push(Number((r() * 10).toPrecision(1 + Math.floor(r() * 17))) * 10 ** e);
    else out.push((r() - 0.5) * 10 ** e);
  }
  return out.filter((x) => Number.isFinite(x));
}

/** 64 ビットの整数の端と、2^53 の前後の double。整数と REAL の比べ方が変わる場所である。 */
export const EDGE_DOUBLES: number[] = [
  2 ** 53 - 1, 2 ** 53, 2 ** 53 + 2, -(2 ** 53), 2 ** 62, 2 ** 62 + 1024, 2 ** 63 - 1024, 2 ** 63, 2 ** 63 + 2048, -(2 ** 63), -(2 ** 63) - 2048, 2 ** 64, 1e19, -1e19,
  4294967296, 2147483647, 2147483648, -2147483648, -2147483649, Number.MAX_VALUE, Number.MIN_VALUE, -Number.MIN_VALUE, 2.2250738585072014e-308,
];

/** 64 ビットの整数。端、JS の安全な整数の前後、32 ビットの前後、Snowflake の形の ID。 */
export const INT64: bigint[] = [
  0n, 1n, -1n, 5n, 2n ** 31n - 1n, 2n ** 31n, -(2n ** 31n), -(2n ** 31n) - 1n, 2n ** 32n, 2n ** 40n,
  2n ** 53n - 1n, 2n ** 53n, 2n ** 53n + 1n, -(2n ** 53n) + 1n, -(2n ** 53n), -(2n ** 53n) - 1n,
  2n ** 62n, 2n ** 62n + 1n, 2n ** 63n - 1025n, 2n ** 63n - 1024n, 2n ** 63n - 1n, -(2n ** 63n), -(2n ** 63n) + 1n,
  1541815603606036480n, 7215982934112387072n, 1500000000000000001n, 1500000000000000002n,
];

/** 乱択の 64 ビットの整数。桁数をならして選ぶ (一様に選ぶと、ほとんどが 19 桁になる)。 */
export function int64s(n: number, seed: number): bigint[] {
  const r = prng(seed);
  const out: bigint[] = [];
  for (let i = 0; i < n; i++) {
    const bits = 1 + Math.floor(r() * 63);
    let v = 0n;
    for (let b = 0; b < bits; b += 16) v = (v << 16n) | BigInt(Math.floor(r() * 65536));
    v &= (1n << BigInt(bits)) - 1n;
    out.push(r() < 0.5 ? v : -v - 1n);
  }
  return out;
}

/** 数に読めるか、読めそうで読めない文字列。型の親和性が数にするかどうかの境である。 */
export const TRICKY_STRINGS: string[] = [
  "9223372036854775807", "9223372036854775808", "-9223372036854775808", "-9223372036854775809", "9007199254740993", "-9007199254740993",
  "9223372036854775807.0", "9.223372036854775807e18", "9223372036854775807e0", "18446744073709551616", "1e19", "1e400", "-1e400", "1e-400",
  "abc", "", " ", "0x10", " 0x10", "0X1F", "0b1", "0o7", "1_000", "1,5", "Infinity", "-Infinity", "inf", "nan", "NaN", "1e", "1e+", "1e+5", "1E5", ".e1", "e1",
  "+.5", "-.5e-3", "5 5", "5\t", "\n5", "\v5", "\f5\r", "+5", "++5", "-+5", "5-", "007", "-007", "00.50", "3.0", "3.", ".3", ".", "-", "+", "-0", "-0.0", "0.0", "0e0", "1.5e300",
  "0.1", "0.30000000000000004", "1e15", "1e16", "123456789012345678", "1234567890123456789012", "4.9e-324", "2.2250738585072014e-308", "1.7976931348623157e308", "1.7976931348623159e308",
  "５", "5 ", " 5", "5\u0000", "true", "null",
];

/** double を、SQLite が数に読む書き方で書いた文字列。 */
export function numericStrings(xs: number[]): string[] {
  const out: string[] = [];
  for (const x of xs) out.push(String(x), ` ${x} `, x.toExponential(), x.toPrecision(15), x.toPrecision(17), `+${Math.abs(x)}`, x.toFixed(Math.min(20, Math.max(0, 3 - Math.floor(Math.log10(Math.abs(x) || 1))))));
  for (let i = -5; i < 5; i++) out.push(String(i), `${i}.0`, `${i}e2`, `0x${Math.abs(i)}`, `+${Math.abs(i)}`, `${i}.`, `.${Math.abs(i)}`);
  out.push(...TRICKY_STRINGS);
  return out;
}

/** double のビット。-0.0 と 0.0、NaN の符号まで区別して比べるのに使う。 */
export function bitsOf(x: number): string {
  const b = Buffer.alloc(8);
  b.writeDoubleBE(x);
  return b.toString("hex");
}

/** 型のある値。BigInt は INTEGER、数は REAL。node:sqlite は、この決まりのまま束縛する。 */
export type Typed = null | bigint | number | string | Uint8Array;

/**
 * 型のある値を sql.js に束縛するための、引数の書き方と値。sql.js は、BigInt を TEXT として、32 ビットに収まる整数の値の数を
 * INTEGER として束縛するので、型を保つ式で包む (src/value.ts の bindTyped と同じ包み方である)。
 */
export function sqljsBinding(values: Typed[]): { marks: string[]; params: (string | number | Uint8Array | null)[] } {
  return {
    marks: values.map((v) => (typeof v === "bigint" ? "(CAST(? AS INTEGER)+0)" : typeof v === "number" ? "(CAST(? AS REAL)+0.0)" : "?")),
    params: values.map((v) => (typeof v === "bigint" ? String(v) : v)),
  };
}

