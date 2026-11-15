// UNIQUE の文の差分の検査 (docs/design-unique-keys.md の段 0 の (c))。UNIQUE に触れる文を、シャード 1、2、4 と分割で切った置き場所で
// node:sqlite と比べる。何を比べるか、行を訪ねる順で答えが変わる文をどう扱うかは、test/unique-diff.ts の先頭に書いた。
// 基準経路だけの 2 つの実行 (reference-scans、reference-full) でも流す (vitest.config.ts の oracles)。
//
// D∞ がいま断る UNIQUE の形は、REFUSED (test/unique-diff.ts) にある。最後の試験が、一覧の形に全部当たったこと、流した文の形が全部
// 出たことを確かめる。断る形を受け付けるようになったら (段 2)、一覧から外す。既知の未解決の欠陥 (KNOWN_OPEN) は、既定の実行では
// 伏せる。OPEN=1 を付けると伏せない。
//   npx vitest run --maxWorkers=2 test/unique-diff.test.ts
//   SEEDS=1..300 npx vitest run --project sim test/unique-diff.test.ts
//   OPEN=1 SEEDS=17 npx vitest run --project sim test/unique-diff.test.ts
import { describe, expect, it } from "vitest";
import { keyString } from "../src/keys";
import { ownerOf } from "../src/routing";
import { checkSeed, KNOWN_OPEN, REFUSED, SHAPES } from "./unique-diff";
import { seedsOr, SimCluster } from "./sim";

const OPEN = Boolean(process.env.OPEN);
// 1 から 40 と、OR REPLACE が消す行の値を受け取る欠陥 (KNOWN_OPEN の最後) に当たる 152 と 378。最後の試験が、伏せた欠陥に既定の seed で
// 当たることを確かめる。生成を変えると seed の台本が変わるので、ここを選び直す (2026-11-15 に OR FAIL と OR ROLLBACK を生成から外した)。
const DEFAULTS = [...Array.from({ length: 40 }, (_v, i) => i + 1), 152, 378];
const seeds = seedsOr(DEFAULTS);
const listed = KNOWN_OPEN.length ? KNOWN_OPEN.map((k) => `${k.id} (${k.repro})`).join("; ") : "none";

describe(`UNIQUE statements give SQLite's answers on every placement (${OPEN ? "known open defects included" : `excluded: ${listed}`})`, () => {
  const tally = { runs: 0, refused: {} as Record<string, number>, shapes: {} as Record<string, number>, masked: {} as Record<string, number> };
  for (const seed of seeds) {
    it(`seed ${seed}`, { timeout: 120_000 }, async () => {
      const r = await checkSeed(seed, { mask: !OPEN });
      tally.runs++;
      for (const [k, n] of Object.entries(r.refused)) tally.refused[k] = (tally.refused[k] ?? 0) + n;
      for (const [k, n] of Object.entries(r.shapes)) tally.shapes[k] = (tally.shapes[k] ?? 0) + n;
      for (const [k, n] of Object.entries(r.masked)) tally.masked[k] = (tally.masked[k] ?? 0) + n;
      if (r.divergences.length) console.log(`UNIQUE-DIFF seed ${seed}:\n${r.divergences.slice(0, 6).join("\n")}`);
      expect(r.divergences.slice(0, 6)).toEqual([]);
    });
  }

  it("met every listed refusal and every statement shape, and still meets the known open defects it excludes", () => {
    console.log(`UNIQUE-DIFF ${tally.runs} seeds: refused ${JSON.stringify(tally.refused)}; shapes ${JSON.stringify(tally.shapes)}; masked ${JSON.stringify(tally.masked)}`);
    if (OPEN || tally.runs < DEFAULTS.length || seeds !== DEFAULTS) return;
    // 断る形の一覧は、段 2 で減る。D∞ が受け付けるようになった形は、ここで落ちるので、一覧から外す。
    for (const r of REFUSED) expect(tally.refused[r.id] ?? 0, r.id).toBeGreaterThan(0);
    for (const s of SHAPES) expect(tally.shapes[s] ?? 0, s).toBeGreaterThan(0);
    // 流さない (skip) ことで避けている欠陥は、数えても意味がない (その形が台本にあれば、いつも数える)。伏せている欠陥だけを見る。
    for (const k of KNOWN_OPEN) if (!k.skip) expect(tally.masked[k.id] ?? 0, k.id).toBeGreaterThan(0);
  });

  it("puts the tenants 'a' and 'A' on different shards with 2 and 4 shards", async () => {
    // shard key の列を NOCASE で比べる UNIQUE (FAMILIES の tn と ti) は、'a' と 'A' のテナントの行がぶつかる。2 つが別のシャードにある
    // 置き場所で比べる (設計の段 0 の (c))。いまは表定義で断る形なので、受け付けるようになったら効く。
    for (const shards of [2, 4]) {
      const { routing } = await new SimCluster({ shards }).catalog();
      expect(ownerOf(routing, keyString(["a"])), `${shards} shards`).not.toBe(ownerOf(routing, keyString(["A"])));
    }
  });
});
