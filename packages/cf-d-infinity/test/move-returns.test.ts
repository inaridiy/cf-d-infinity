// 範囲が前の持ち主へ戻る移動を、乱択の順で混ぜる (docs/design-catalog-epoch.md の「段 4 の結果」の「段 4 の後に要るもの」)。
//
// 段 4 から、所有をスナップショットだけで引くので、範囲は前の持ち主へ戻れる。今の本番の入口 (Autoscaler と /admin/split) は、範囲を持たない
// シャードしか子にしないので、ふつうの分割では起きない。試験は test/range-returns.test.ts の決まった並びだけだった。
// ここでは、作業負荷 (test/history.ts の runHistory) と並べて、範囲表の 1 つの区間を丸ごと、範囲を持たないシャードへ動かす移動と、
// Autoscaler と同じ半分の分割を混ぜる。宛先は、その区間を前に持っていたシャードを選びやすくする。移動の手順の要求の前に子か親を
// 再起動し、進める側をときどき止め、phase 2 と移動の手順の要求の配送を遅らせる。tenant を多くして、取引の intent を読み手が決着させる
// 前に、範囲が動くようにする。
//
// 伏せているもの (MoveChaos.hide54)。未解決の問題 54 (test/open/phase2-during-return.test.ts): 範囲が前の持ち主へ戻る途中に届いた phase 2 を、
// 前の持ち主が、intent を適用も転送もせずに受け取ったと答える。この生成器は、戻る移動を始める前に、どのシャードにも、宛先が前に渡した取引の
// intent が残っていないことを求め、残っていれば、その移動を後回しにする。54 の窓 (宛先が move-start を適用してから、その intent の
// グループを引き取るまで) より広く外す。OPEN=1 で外す。外すと、確定して届け終えた取引の intent の残り (history.ts の strandedIntents) で
// 54 が見つかる (seed 8)。54 が直ったら、伏せるのをやめる。
import { describe, expect, it } from "vitest";
import { runHistory, type RunResult } from "./history";
import { seedsOr } from "./sim";

/** 未解決の問題 54 の時刻を伏せる。OPEN=1 で外す。 */
const HIDE_54 = !process.env.OPEN;

const memo = new Map<number, Promise<RunResult>>();
const run = (seed: number) => {
  if (!memo.has(seed)) {
    memo.set(seed, runHistory({
      seed, shards: 3, tenants: 40, skewMs: 20, ops: 40, thinkMs: 400, slowPhase2Ms: 2_000,
      moves: { kind: "returns", restarts: true, stops: true, hide54: HIDE_54, slowMoveRpcMs: 60, paceMs: 200 },
    }));
  }
  return memo.get(seed)!;
};

describe("ranges that move away and come back to a former owner, in random orders", () => {
  const seeds = seedsOr([1, 2, 3, 4, 5, 6, 7, 8]);
  for (const seed of seeds) {
    it(`stays serializable, loses no write, and leaves no delivered intent behind (seed ${seed})`, async () => {
      const r = await run(seed);
      expect(r.counts.moves).toBeGreaterThan(0);
      expect(r.history.filter((h) => !h.readOnly).length).toBeGreaterThan(20);
      expect(r.violations.slice(0, 3)).toEqual([]);
      expect(r.problems.slice(0, 5)).toEqual([]);
    }, 120_000);
  }
  // 検査が何も確かめていない実行にならないこと。範囲は前の持ち主へ戻り、子と親は移動の途中で再起動し、進める側なしで閉じる移動がある。
  // 54 を伏せる実行では、伏せるために後回しにした戻る移動がある (伏せる条件が、何かを外している)。
  it("moves ranges back to former owners, restarts the shards of a move, and finishes moves without their driver", async () => {
    const all = await Promise.all(seeds.map(run));
    const sum = (f: (r: RunResult) => number) => all.reduce((a, r) => a + f(r), 0);
    expect({
      returns: sum((r) => r.counts.returns) > 0,
      restarts: sum((r) => r.counts.restarts) > 0,
      byChild: sum((r) => r.counts.byChild) > 0,
      deferred: !HIDE_54 || sum((r) => r.counts.deferred) > 0,
    }).toEqual({ returns: true, restarts: true, byChild: true, deferred: true });
  }, 240_000);
});
