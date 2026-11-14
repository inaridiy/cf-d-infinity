// 値の作り直しの段 1 まで使っていたキー文字列の関数 (保存の形式 1)。段 2 で src/keys.ts の keyStringExact に替えた。
// 試験 (test/key-conversions.test.ts) が、新しい関数が、いま保存できる値で、この関数と同じ文字列を返すことを確かめるために残す。
// 書き換えない。
import type { Value } from "../src/types";
import { isReal } from "../src/value";

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

/** キー文字列。値の並びを JSON にする。BLOB と、JSON で表せない数 (無限大) には印を付ける。整数の値の REAL は数にする。 */
export function oldKeyString(values: Value[]): string {
  return JSON.stringify(values.map((v) => (isReal(v) ? v.real : v)), (_k, x) =>
    x instanceof Uint8Array ? { $b: hex(x) } : typeof x === "number" && !Number.isFinite(x) ? { $f: String(x) } : x);
}
