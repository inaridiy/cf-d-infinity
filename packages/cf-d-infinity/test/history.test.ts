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
// 発火するまで続ける。phase 2 と移動の手順の要求の配送を遅らせ、tenant を多くし、移動を詰めて流す (test/move-returns.test.ts と同じ値で、
// 移動の選び方だけが Autoscaler と同じ半分の分割である)。確かめるのは、履歴の直列化可能性と、最後の読み (失われた書き込み)、移動の後の
// 確定して届け終えた取引の intent の残り (history.ts の strandedIntents)、受け取り終える前の move-end (END_AFTER_DRAIN)、移動が閉じた後の
// 行の置き場所、後始末である。
// 遅らせない値 (4 シャード、tenant 6、移動の間に最大 800 ms) では、欠陥のスイッチ pullWithoutEpoch を seed 1 から 40 で 1 度も見つけず、
// phase 2 を遅らせるだけで 8、ここの値で 28 になった (tenant を 40 にするだけ、移動を詰めるだけでは 1 のまま。2026-11-16)。
describe("history checker while the shards of a move restart and its driver stops", () => {
  const memo = new Map<number, ReturnType<typeof runHistory>>();
  const once = (seed: number) => {
    if (!memo.has(seed)) {
      memo.set(seed, run({
        seed, shards: 3, tenants: 40, slowPhase2Ms: 2_000, skewMs: 20, ops: 40, thinkMs: 400,
        moves: { kind: "split", restarts: true, stops: true, slowMoveRpcMs: 60, paceMs: 200 },
      }));
    }
    return memo.get(seed)!;
  };
  const defaults = [61, 62, 63, 64];
  for (const seed of seedsOr(defaults)) {
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
  // 既定の seed で数える (SEEDS で 1 つの seed だけを流しても、この試験は変わらない)。
  it("restarts children and parents mid-move, and some moves finish without their driver", async () => {
    const all = await Promise.all(defaults.map(once));
    const sum = (f: (r: Awaited<ReturnType<typeof runHistory>>) => number) => all.reduce((a, r) => a + f(r), 0);
    expect({ restarts: sum((r) => r.counts.restarts) > 0, byChild: sum((r) => r.counts.byChild) > 0 }).toEqual({ restarts: true, byChild: true });
  }, 240_000);
});

// ---- 生成器 1 と 2 (docs/design-refresh-across-move.md の「乱択の検査に足す生成器」) ----
//
// 1. 全表の集計と、範囲の分割。前の文で行を読んだ取引が、主キーでも shard key でも絞れない文で、全行の数と和か、全行の値を読む。
//    その間に、分割が読む範囲を動かし、ほかの接続が書く。Worker の refresh と exec の配送を遅らせ、分割が文の途中に入る実行を増やす。
//    宛先が 1 つの形 (1 シャードから始める実行の、最初の分割の前) と、2 つ以上の形を混ぜる。
// 2. 1 つの文が、要求を 2 回に分けて送る形。集める予算を小さくし、1 つの tenant の行を大きくして、行の多いシャードが取り分を超え、
//    予算の残りで 2 回目を送る (ReadScope.budgeted)。2 つの表を集める文 (表ごとに送る。ReadScope.collect) と、計画の途中で別の読みを
//    する文 (INSERT の値の副問い合わせを、先に取引の読みとして集めてから、INSERT を送る) も混ぜる。
// 判定は、履歴の検査 (数と和、全行の値) と、どの試験にも掛かる全表の読みの区間の検査 (test/sim.ts の checkTiling) である。
// どの組 (sim、reference-scans、reference-full) でも、全表の読みは全表の経路を通る。
// foundation-4 (517b674) のコードは、移動をまたいだ全表の読みを、範囲の床 (read too old) か、移動の途中の拒否 (migrating) か、範囲表を
// 取り替えた後の競合で断る。断るのは許す (worker が数えて飛ばす)。答えたなら、正しくなければならない。数えた形は、最後の試験が確かめ、
// 1 行で出す。2 回目の実装の枝 (eba3354) では、生成器 1 と 2 の seed 1 から 40 (80 の実行) のうち 74 で、区間の検査が、1 つの文の答えの claim が 2 つの
// 範囲表から来たことを報告した (未解決の問題 56。送り直す要求の claim を、取り替えた後の範囲表で作る)。
describe("history checker with whole-table reads across live splits (generators 1 and 2)", () => {
  const memo = new Map<string, ReturnType<typeof runHistory>>();
  // 半分の seed は、Autoscaler の分割を最後まで進める (splits)。残りは、移動の手順の要求を遅らせ、進める側をときどき startMove の後で
  // 止める (moves)。移動が開いている間 (親が行を渡したが、まだ ack を受けていない間) の全表の読みは、後者でしか起きない。
  const once = (rounds: boolean, seed: number) => {
    const key = `${rounds}/${seed}`;
    if (!memo.has(key)) {
      const slow = Math.floor(seed / 2) % 2 === 1;
      memo.set(key, run({
        seed, skewMs: 20, ops: 30, tenants: 20, shards: seed % 2 === 1 ? 1 : 3,
        ...(slow ? { moves: { kind: "returns" as const, stops: true, slowMoveRpcMs: 60, paceMs: 150 } } : { splits: true, splitPaceMs: 120 }),
        wide: { share: 0.5, thinkMs: 60, holdMs: 40, ...(rounds ? { rounds: { bytes: 16_000 } } : {}) },
      }));
    }
    return memo.get(key)!;
  };
  const defaults = { aggregates: [71, 72, 73, 74], rounds: [81, 82, 83, 84] };
  for (const seed of seedsOr(defaults.aggregates)) {
    it(`1. answers whole-table aggregates at the transaction's snapshot, or refuses (seed ${seed})`, async () => {
      const r = await once(false, seed);
      expect(r.violations.slice(0, 3)).toEqual([]);
    }, 120_000);
  }
  for (const seed of seedsOr(defaults.rounds)) {
    it(`2. answers statements that send their requests in two rounds, or refuses (seed ${seed})`, async () => {
      const r = await once(true, seed);
      expect(r.violations.slice(0, 3)).toEqual([]);
    }, 120_000);
  }
  // 検査が何も確かめていない実行にならないこと。既定の seed で数える。
  it("reaches the shapes: a statement across a move, to one shard and to several, and a second round across a move", async () => {
    const agg = await Promise.all(defaults.aggregates.map((s) => once(false, s)));
    const rounds = await Promise.all(defaults.rounds.map((s) => once(true, s)));
    const sum = (rs: Awaited<ReturnType<typeof runHistory>>[], f: (w: Awaited<ReturnType<typeof runHistory>>["wide"]) => number) => rs.reduce((a, r) => a + f(r.wide), 0);
    const byShape = (rs: Awaited<ReturnType<typeof runHistory>>[]) => {
      const out: Record<string, string> = {};
      const all: Record<string, { statements: number; rounds: number }> = {};
      for (const r of rs) for (const [k, v] of Object.entries(r.wide.byShape)) all[k] = { statements: (all[k]?.statements ?? 0) + v.statements, rounds: (all[k]?.rounds ?? 0) + v.rounds };
      for (const [k, v] of Object.entries(all)) out[k] = `${v.rounds}/${v.statements}`;
      return out;
    };
    const outcomes = (rs: Awaited<ReturnType<typeof runHistory>>[]) => {
      const out: Record<string, number> = {};
      for (const r of rs) for (const [k, n] of Object.entries(r.wide.outcomes)) out[k] = (out[k] ?? 0) + n;
      return out;
    };
    console.info(
      `generator 1: ${sum(agg, (w) => w.statements)} whole-table reads (${sum(agg, (w) => w.oneShard)} to one shard, ${sum(agg, (w) => w.manyShards)} to several), ` +
        `${sum(agg, (w) => w.acrossMove)} across a move: ${JSON.stringify(outcomes(agg))}\n` +
        `generator 2: ${sum(rounds, (w) => w.rounds)} statements in two or more rounds, ${sum(rounds, (w) => w.roundsAcrossMove)} with a move between rounds; ` +
        `${sum(rounds, (w) => w.acrossMove)} across a move: ${JSON.stringify(outcomes(rounds))}; rounds by shape ${JSON.stringify(byShape(rounds))}; ` +
        `${sum(rounds, (w) => w.planReads)} statements that read while planning, ${sum(rounds, (w) => w.planReadsAcrossMove)} with a move after the read`,
    );
    expect({
      across: sum(agg, (w) => w.acrossMove) > 0,
      oneShard: sum(agg, (w) => w.oneShard) > 0,
      manyShards: sum(agg, (w) => w.manyShards) > 0,
      rounds: sum(rounds, (w) => w.rounds) > 0,
      roundsAcrossMove: sum(rounds, (w) => w.roundsAcrossMove) > 0,
      planReadsAcrossMove: sum(rounds, (w) => w.planReadsAcrossMove) > 0,
    }).toEqual({ across: true, oneShard: true, manyShards: true, rounds: true, roundsAcrossMove: true, planReadsAcrossMove: true });
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
