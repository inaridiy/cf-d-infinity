// 未解決: 未解決の問題 31 を、列の解決の検査 (test/unique-columns.ts、docs/design-unique-keys.md の段 0 の (b)) で見つける。
//
// 表の制約 (PRIMARY KEY、UNIQUE) と CREATE INDEX に、列を定義と違う大文字と小文字で書くと、DDL の解釈が、書いてある綴りのまま
// 列を記録するか、`no such column` で断る。SQLite は列の名前の大文字と小文字を区別しないので、PRAGMA の答えと食い違う。
// 小さな再現は test/open/constraint-column-case.test.ts にある。不変条件は 7 と 6、持ち主は ddl.ts の createTable と createIndex。
// 設計の段 1 (resolveConstraints。列の名前と照合順序を PRAGMA から読む) で直り、そのとき、この試験は test/ へ移す
// (test/unique-columns.test.ts の caseVariants を既定に入れる)。
import { describe, expect, it } from "vitest";
import { checkColumns } from "../unique-columns";

describe("constraint columns spelled in another case than their definition", () => {
  it("are read as the defined columns, as SQLite's PRAGMA reports them", () => {
    const problems = Array.from({ length: 100 }, (_v, i) => i + 1).flatMap((seed) => checkColumns(seed, { caseVariants: true }).problems.map((p) => `seed ${seed}: ${p}`));
    expect(problems.slice(0, 5)).toEqual([]);
  });
});
