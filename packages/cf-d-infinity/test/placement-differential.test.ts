// 置き場所の差分の検査。取引と、その文の間に別の接続が autocommit で書く台本を、シャードの数と行の置き場所を変えて流し、
// 文ごとの答え、確定の成否、最後の表の中身を比べる (計画書の規則 4、不変条件 13。未解決の問題 34 を見つけるために作った)。
//
// 既存の差分の検査 (typed-diff、fuzz、slt) は、1 つの接続の文を 1 文ずつ SQLite と比べる。replay と history は並行の下での
// 直列化可能性を見る。どちらも、別の接続の書き込みを挟んだ取引の答えを、置き場所の間で比べない。未解決の問題 34 は、その形の
// 欠陥である (取引が複数のシャードを読んだ後、2 つのシャードの行が変わると、次の複数シャードの読みが `read too old` で失敗する)。
//
// 何を比べるか、待たされた文をどう扱うかは、test/placement-oracle.ts の先頭に書いた。
//
// 作った日 (2026-11-14) に見つけたもの: 未解決の問題 34 (伏せずに流すと、最初に見つかるのは seed 4。seed 1 から 100 のうち
// sim で 36、reference-scans で 35、reference-full で 45 の seed で見つかる)。分割の前の範囲表で計画した複数行の INSERT が、行を
// 2 つのシャードに入れる欠陥 (test/open/multi-row-insert-after-split.test.ts。分割で切る置き場所の seed 45)。
//
// 既知の未解決の欠陥 (placement-oracle.ts の KNOWN_OPEN) は、既定の実行では伏せる。伏せた数は最後の試験が確かめる
// (伏せた欠陥がもう起きないなら、その試験が落ちる)。OPEN=1 を付けると伏せない。そのときは、欠陥に当たる seed が落ちる。
//   npx vitest run --maxWorkers=2 test/placement-differential.test.ts
//   OPEN=1 npx vitest run --project sim test/placement-differential.test.ts
//   SEEDS=1..300 npx vitest run --project sim test/placement-differential.test.ts
import { describe, expect, it } from "vitest";
import { checkSeed, KNOWN_OPEN } from "./placement-oracle";
import { seedsOr } from "./sim";

const OPEN = Boolean(process.env.OPEN);
const DEFAULTS = Array.from({ length: 30 }, (_v, i) => i + 1);
const listed = KNOWN_OPEN.map((k) => `${k.id} (${k.how}, ${k.repro})`).join("; ");

describe(`transactions interleaved with other connections' writes give the same answers on every placement (${OPEN ? "known open defects included" : `excluded: ${listed}`})`, () => {
  const tally = { runs: 0, masked: {} as Record<string, number> };
  for (const seed of seedsOr(DEFAULTS)) {
    it(`seed ${seed}`, { timeout: 120_000 }, async () => {
      const r = await checkSeed(seed, { mask: !OPEN });
      tally.runs++;
      for (const [k, n] of Object.entries(r.masked)) tally.masked[k] = (tally.masked[k] ?? 0) + n;
      expect(r.divergences.slice(0, 6)).toEqual([]);
    });
  }
  it("still meets the known open defects it excludes", () => {
    // 伏せている欠陥が、既定の seed で実際に起きていることを見る。起きなくなったら、直ったか、検査がその形を作らなくなった。
    // 直ったなら KNOWN_OPEN から外す。seed を選んで流したときと OPEN=1 のときは、数えた実行が足りないので見ない。
    if (OPEN || tally.runs < DEFAULTS.length) return;
    for (const k of KNOWN_OPEN) if (k.how === "masked") expect(tally.masked[k.id] ?? 0, k.id).toBeGreaterThan(0);
  });
});
