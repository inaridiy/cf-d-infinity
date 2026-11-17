// 範囲が前の持ち主へ戻る移動を、乱択の順で混ぜる (docs/design-catalog-epoch.md の「段 4 の結果」の「段 4 の後に要るもの」)。
//
// 段 4 から、所有をスナップショットだけで引くので、範囲は前の持ち主へ戻れる。今の本番の入口 (Autoscaler と /admin/split) は、範囲を持たない
// シャードしか子にしないので、ふつうの分割では起きない。試験は test/range-returns.test.ts の決まった並びだけだった。
// ここでは、作業負荷 (test/history.ts の runHistory) と並べて、範囲表の 1 つの区間を丸ごと、範囲を持たないシャードへ動かす移動と、
// Autoscaler と同じ半分の分割を混ぜる。宛先は、その区間を前に持っていたシャードを選びやすくする。移動の手順の要求の前に子か親を
// 再起動し、進める側をときどき止め、phase 2 と移動の手順の要求の配送を遅らせる。tenant を多くして、取引の intent を読み手が決着させる
// 前に、範囲が動くようにする。
//
// 未解決の問題 54 (範囲が前の持ち主へ戻る途中に届いた phase 2) は、2026-11-17 に直した (test/phase2-during-return.test.ts、M5c)。
// それまで伏せていた MoveChaos.hide54 は外した。
//
// 問題 55 (終わった移動の遅れた pull) は、54 の直しで渡した印がグループの戻るまで残るので起きない (test/stale-pull-after-return.test.ts)。
// それまで伏せていた MoveChaos.hideStalePull も外した (2026-11-17。シミュレータの再起動が飛んでいる要求を失敗させる形で、OPEN=1 の
// seed 1 から 300 が通った)。
import { describe, expect, it } from "vitest";
import { runHistory, type RunResult } from "./history";
import { seedsOr } from "./sim";

/** 見つけて直していない欠陥の時刻を伏せる (上の 2 つ)。OPEN=1 で外す。 */

const memo = new Map<number, Promise<RunResult>>();
const run = (seed: number) => {
  if (!memo.has(seed)) {
    memo.set(seed, runHistory({
      seed, shards: 3, tenants: 40, skewMs: 20, ops: 40, thinkMs: 400, slowPhase2Ms: 2_000,
      moves: { kind: "returns", restarts: true, stops: true, hide54: false, hideStalePull: false, slowMoveRpcMs: 60, paceMs: 200 },
    }));
  }
  return memo.get(seed)!;
};

describe("ranges that move away and come back to a former owner, in random orders", () => {
  const defaults = [1, 2, 3, 4, 5, 6, 7, 8];
  for (const seed of seedsOr(defaults)) {
    it(`stays serializable, loses no write, and leaves no delivered intent behind (seed ${seed})`, async () => {
      const r = await run(seed);
      expect(r.counts.moves).toBeGreaterThan(0);
      expect(r.history.filter((h) => !h.readOnly).length).toBeGreaterThan(20);
      expect(r.violations.slice(0, 3)).toEqual([]);
      expect(r.problems.slice(0, 5)).toEqual([]);
    }, 120_000);
  }
  // 検査が何も確かめていない実行にならないこと。範囲は前の持ち主へ戻り、子と親は移動の途中で再起動し、進める側なしで閉じる移動がある。
  // 既定の seed で数える。
  it("moves ranges back to former owners, restarts the shards of a move, and finishes moves without their driver", async () => {
    const all = await Promise.all(defaults.map(run));
    const sum = (f: (r: RunResult) => number) => all.reduce((a, r) => a + f(r), 0);
    expect({
      returns: sum((r) => r.counts.returns) > 0,
      restarts: sum((r) => r.counts.restarts) > 0,
      byChild: sum((r) => r.counts.byChild) > 0,
    }).toEqual({ returns: true, restarts: true, byChild: true });
  }, 240_000);
});

// ---- 生成器 4 (docs/design-refresh-across-move.md の「乱択の検査に足す生成器」) ----
//
// 範囲が前の持ち主へ戻る間に、持ち主が前の持ち主へ尋ねる要求 (history.ts の ASK_RPCS) と、その応答を遅らせる (MoveChaos.slowAsksMs)。
// 尋ねてから同期区間に入るまでの間に、範囲が戻ってくる形 (C → D → C、P → C → P。M23g) を作る。取引の文と文の間に待ちを置き
// (RunOpts.innerThinkMs)、読むだけの取引 (移動の前の T のまま読み続ける) と、書く取引 (確定の検証の窓が移動をまたぐ) を、戻る移動に
// またがらせる。tenant を少なくして、読むだけの取引の読んだ行がほかの接続に書かれ、T を進められずに古い T で読む実行を増やす。
// foundation-4 (517b674) のコードは、前の持ち主に尋ねないので、遅らせる手は効かない (数えた delayedAsks は 0)。移動をまたいだ読みと
// 確かめを、範囲の床 (read too old) か競合で断る。断るのは許す。答えたなら、正しくなければならない。数えた形は、最後の試験が確かめる。
describe("transactions across ranges that return to a former owner, with the asks to former owners delayed (generator 4)", () => {
  const memo4 = new Map<number, Promise<RunResult>>();
  const run4 = (seed: number) => {
    if (!memo4.has(seed)) {
      memo4.set(seed, runHistory({
        seed, shards: 3, tenants: 12, skewMs: 20, ops: 20, thinkMs: 300, innerThinkMs: 600, slowPhase2Ms: 2_000,
        moves: { kind: "returns", restarts: true, stops: true, slowMoveRpcMs: 60, paceMs: 400, maxMoves: 40, slowAsksMs: 300 },
      }));
    }
    return memo4.get(seed)!;
  };
  const defaults4 = [101, 102, 103, 104, 105, 106];
  for (const seed of seedsOr(defaults4)) {
    it(`stays serializable while transactions span returns and the asks are slow (seed ${seed})`, async () => {
      const r = await run4(seed);
      expect(r.counts.moves).toBeGreaterThan(0);
      expect(r.violations.slice(0, 3)).toEqual([]);
      expect(r.problems.slice(0, 5)).toEqual([]);
    }, 120_000);
  }
  // 検査が何も確かめていない実行にならないこと。範囲は前の持ち主へ戻り、読むだけの取引と書く取引が、その移動をまたぐ。既定の seed で数える。
  it("makes read-only and writing transactions span moves that return a range", async () => {
    const all = await Promise.all(defaults4.map(run4));
    const sum = (f: (r: RunResult) => number) => all.reduce((a, r) => a + f(r), 0);
    const outcomes: Record<string, number> = {};
    for (const r of all) for (const [k, n] of Object.entries(r.across.outcomes)) outcomes[k] = (outcomes[k] ?? 0) + n;
    console.info(
      `generator 4: ${sum((r) => r.counts.returns)} returns; transactions across a return: ${sum((r) => r.across.readOnly)} read-only, ` +
        `${sum((r) => r.across.writing)} writing, ${sum((r) => r.across.twoMoves)} of them across two moves of one range: ${JSON.stringify(outcomes)}; ` +
        `asks delayed: ${sum((r) => r.across.delayedAsks)}`,
    );
    expect({ readOnly: sum((r) => r.across.readOnly) > 0, writing: sum((r) => r.across.writing) > 0 }).toEqual({ readOnly: true, writing: true });
  }, 240_000);
});
