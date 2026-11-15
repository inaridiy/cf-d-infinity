// 列の解決の検査 (docs/design-unique-keys.md の段 0 の (b))。DDL の解釈が表の制約と CREATE INDEX から読む列の名前と照合順序を、
// 同じ DDL を実行した SQLite の PRAGMA (table_xinfo、index_list、index_xinfo) と比べる。部品は test/unique-columns.ts にある。
//
// 既知の未解決の欠陥の形は、既定の実行では作らない。それぞれを作る生成の指定と、再現の試験は次のとおりである。
// 最後の 3 つの試験は、指定を入れるとこの検査が欠陥に気付くこと (直ったら、その試験が落ちるので、指定を既定に戻す) を確かめる。
//   caseVariants    未解決の問題 31。表の制約と CREATE INDEX の列を、定義と違う大文字と小文字で書く。
//                   test/open/unique-columns-case.test.ts、test/open/constraint-column-case.test.ts
//   tableCase       CREATE INDEX の ON の表の名前を、定義と違う大文字と小文字で書くと、no such table で断る。
//                   test/open/create-index-table-case.test.ts
//   primaryKeyDesc  列の定義の `INTEGER PRIMARY KEY DESC` を、rowid の別名として記録する (SQLite では別名にならない)。
//                   test/open/integer-primary-key-desc.test.ts
//
//   npx vitest run --project sim test/unique-columns.test.ts
//   SEEDS=1..5000 npx vitest run --project sim test/unique-columns.test.ts
import { describe, expect, it } from "vitest";
import { checkColumns, REFUSALS, type GenOptions } from "./unique-columns";
import { seedsOr } from "./sim";

const DEFAULTS = Array.from({ length: 400 }, (_v, i) => i + 1);
const seeds = seedsOr(DEFAULTS);
const KNOWN: { option: keyof GenOptions; what: string }[] = [
  { option: "caseVariants", what: "open problem 31 (a constraint column spelled in another case)" },
  { option: "tableCase", what: "CREATE INDEX on a table name spelled in another case" },
  { option: "primaryKeyDesc", what: "INTEGER PRIMARY KEY DESC recorded as the rowid alias" },
];

describe(`constraint columns and collations read by the DDL parser match SQLite's PRAGMA (not generated: ${KNOWN.map((k) => k.what).join("; ")})`, () => {
  const refused: Record<string, number> = {};
  let compared = 0;
  for (let k = 0; k < seeds.length; k += 100) {
    const chunk = seeds.slice(k, k + 100);
    it(`seeds ${chunk[0]} to ${chunk[chunk.length - 1]}`, () => {
      const problems: string[] = [];
      for (const seed of chunk) {
        const r = checkColumns(seed);
        compared += r.compared;
        for (const [id, n] of Object.entries(r.refused)) refused[id] = (refused[id] ?? 0) + n;
        problems.push(...r.problems.map((p) => `seed ${seed}: ${p}`));
      }
      expect(problems.slice(0, 5)).toEqual([]);
    });
  }

  it("meets every listed refusal, and compares most statements", () => {
    // 断る形の一覧は、段 2 で減る。生成器がもう作らない形か、D∞ が受け付けるようになった形は、一覧から外す。
    console.log(`UNIQUE-COLUMNS ${seeds.length} seeds: ${compared} statements compared; refused ${JSON.stringify(refused)}`);
    if (seeds !== DEFAULTS) return;
    for (const r of REFUSALS) expect(refused[r.id] ?? 0, r.id).toBeGreaterThan(0);
    expect(compared).toBeGreaterThan(seeds.length * 0.8);
  });

  for (const k of KNOWN) {
    it(`still finds ${k.what} when the generator makes it (${k.option})`, () => {
      const found = seeds.slice(0, 100).flatMap((seed) => checkColumns(seed, { [k.option]: true }).problems);
      console.log(`UNIQUE-COLUMNS with ${k.option}: ${found.length} problems in 100 seeds, first: ${found[0]}`);
      expect(found.length).toBeGreaterThan(0);
    });
  }
});
