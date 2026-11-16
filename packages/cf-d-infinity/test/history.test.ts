import { describe, expect, it } from "vitest";
import { REFERENCE_ONLY, seedsOr } from "./sim";
import { runHistory } from "./history";
import type { Faults } from "../src/types";

const run = runHistory;

describe("history checker on the real shard code", () => {
  for (const seed of seedsOr([1, 2, 3, 4, 5, 6])) {
    it(`stays serializable with clock skew (seed ${seed})`, async () => {
      const { history, violations } = await run({ seed, skewMs: 40 });
      expect(history.filter((h) => !h.readOnly).length).toBeGreaterThan(20);
      expect(violations.slice(0, 3)).toEqual([]);
    });
  }
  for (const seed of seedsOr([11, 12, 13, 14])) {
    it(`stays serializable with restarts (seed ${seed})`, async () => {
      const { history, violations, unknown } = await run({ seed, skewMs: 20, restarts: true });
      expect(history.length).toBeGreaterThan(20);
      expect(unknown).toBeGreaterThanOrEqual(0);
      expect(violations.slice(0, 3)).toEqual([]);
    });
  }
});

describe("history checker across live splits", () => {
  for (const seed of seedsOr([21, 22, 23, 24, 25, 26])) {
    it(`stays serializable while shards are added (seed ${seed})`, async () => {
      const { history, violations, splits } = await run({ seed, skewMs: 20, splits: true, ops: 60 });
      expect(splits).toBeGreaterThan(0);
      expect(history.filter((h) => !h.readOnly).length).toBeGreaterThan(20);
      expect(violations.slice(0, 3)).toEqual([]);
    });
  }
  for (const seed of seedsOr([31, 32, 33, 34])) {
    it(`stays serializable with splits and restarts together (seed ${seed})`, async () => {
      const { history, violations, splits } = await run({ seed, skewMs: 20, splits: true, restarts: true, ops: 60 });
      expect(splits).toBeGreaterThan(0);
      expect(history.length).toBeGreaterThan(20);
      expect(violations.slice(0, 3)).toEqual([]);
    });
  }
});

describe("history checker with pessimistic transactions", () => {
  for (const seed of seedsOr([41, 42, 43, 44, 45, 46])) {
    it(`stays serializable (seed ${seed})`, async () => {
      const { history, violations } = await run({ seed, skewMs: 20, pessimistic: true, ops: 25 });
      expect(history.filter((h) => !h.readOnly).length).toBeGreaterThan(10);
      expect(violations.slice(0, 3)).toEqual([]);
    }, 60000);
  }
  for (const seed of seedsOr([51, 52, 53, 54])) {
    it(`stays serializable with splits and restarts (seed ${seed})`, async () => {
      const { history, violations } = await run({ seed, skewMs: 20, pessimistic: true, splits: true, restarts: true, ops: 25 });
      expect(history.length).toBeGreaterThan(10);
      expect(violations.slice(0, 3)).toEqual([]);
    }, 60000);
  }
});

// 段 4 から、子が自分で移動を進める (move-start を適用したときの応答の後の仕事と、5 秒ごとの alarm)。ここでは、移動の手順の要求の前に
// 子か親を乱択で再起動し、進める側 (Autoscaler の split) を、ときどき startMove の後で止めるか、再起動で失敗した drain をやり直さずに
// 離れさせる。子は、alarm で続きを進める (シミュレータの alarm は仮想の時計で発火する)。取引の間に待ちを置き、作業負荷を alarm が何度か
// 発火するまで続ける。確かめるのは、履歴の直列化可能性と、最後の読み (失われた書き込み)、移動の後の確定して届け終えた取引の intent の
// 残り (history.ts の strandedIntents)、受け取り終える前の move-end (END_AFTER_DRAIN)、移動が閉じた後の行の置き場所、後始末である。
describe("history checker while the shards of a move restart and its driver stops", () => {
  const memo = new Map<number, ReturnType<typeof runHistory>>();
  const once = (seed: number) => {
    if (!memo.has(seed)) memo.set(seed, run({ seed, skewMs: 20, ops: 40, thinkMs: 400, moves: { kind: "split", restarts: true, stops: true } }));
    return memo.get(seed)!;
  };
  const seeds = seedsOr([61, 62, 63, 64]);
  for (const seed of seeds) {
    it(`stays serializable, and every move finishes (seed ${seed})`, async () => {
      const r = await once(seed);
      expect(r.counts.moves).toBeGreaterThan(0);
      // 全部の文を基準経路で実行する組 (REFERENCE=full) では、どの読みも全表の読みで、移動の途中の親と子は、それを migrating で断る。
      // 子が再起動すると、alarm (5 秒後) が続きを進めるまで受け取り中なので、その間の取引はほとんど断られる (seed 1 から 300 の 15 個で、
      // 確定した書き込みの取引が 20 以下だった。seed 2 は 240 のうち 15)。その組では、確定した取引の数を求めない。
      expect(r.history.filter((h) => !h.readOnly).length).toBeGreaterThan(process.env.REFERENCE === "full" ? 0 : 20);
      expect(r.violations.slice(0, 3)).toEqual([]);
      expect(r.problems.slice(0, 5)).toEqual([]);
    }, 120_000);
  }
  // 検査が何も確かめていない実行にならないこと。子と親は移動の途中で再起動し、進める側の drain が完了を返さないまま閉じる移動がある。
  it("restarts children and parents mid-move, and some moves finish without their driver", async () => {
    const all = await Promise.all(seeds.map(once));
    const sum = (f: (r: Awaited<ReturnType<typeof runHistory>>) => number) => all.reduce((a, r) => a + f(r), 0);
    expect({ restarts: sum((r) => r.counts.restarts) > 0, byChild: sum((r) => r.counts.byChild) > 0 }).toEqual({ restarts: true, byChild: true });
  }, 240_000);
});

// 範囲の移動で時計を渡さない欠陥 (finishWithoutClock) は、この作業負荷では見つからない (2026-11-12 に seed 1 から 1000 で 0 件。
// その前は 1000 のうち 1 つだった)。決定的な再現は test/move-timestamp.test.ts にある。見つける作業負荷は、計画書の
// 「Early 版の線」の順番の 4 で作る。

describe("the simulator is deterministic for this workload", () => {
  it("the same seed gives the same run, with clock skew, restarts and splits", async () => {
    const o = { seed: 31, skewMs: 20, splits: true, restarts: true, ops: 60 };
    const a = await run(o);
    const b = await run(o);
    expect(b.c.fingerprint()).toBe(a.c.fingerprint());
    expect(b.history.length).toBe(a.history.length);
    // 同じ実行を 2 回流すので、単独でも 25 秒かかる (基準経路だけの実行)。既定の 30 秒では、ほかの試験と CPU を取り合うと落ちる。
  }, 120000);
});

// 欠陥を戻して、検査が気付くことを確かめる。欠陥は最適化の経路の上で現れるものなので、基準経路だけの実行では流さない。
describe.skipIf(REFERENCE_ONLY)("the checker is not vacuous", () => {
  // 欠陥を入れた実装で異常を検出できなければ、上の合格は意味を持たない。
  const detects = async (faults: Faults, skewMs = 40) => {
    for (let seed = 100; seed < 112; seed++) {
      const { violations } = await run({ seed, faults, skewMs, ops: 30 });
      if (violations.length > 0) return true;
    }
    return false;
  };
  it("detects a reader that passes pending intents", async () => {
    expect(await detects({ readerTimeoutPass: true })).toBe(true);
  });
  it("detects validation that ignores intents", async () => {
    expect(await detects({ ignoreIntentsInValidation: true })).toBe(true);
  });
});
