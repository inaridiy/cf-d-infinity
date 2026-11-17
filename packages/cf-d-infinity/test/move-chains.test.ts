// 前へ進む移動の鎖に、遅れた移動のメッセージを混ぜる (生成器 10。test/history.ts の LateMoves と MoveChaos の chain)。
//
// 本番の分割 (Autoscaler と /admin/split) は、親の最も広い区間の半分を、範囲を持たない新しいシャードへ渡す。範囲は前の持ち主へ戻らない。
// ここでは、その半分の分割の親を、いちばん新しい子にしやすくして (s0 から s3 へ、s3 から s4 へ、と 2 度の分割が 1 つの範囲を運ぶ)、移動の
// メッセージの要求か応答を 1 つずつ止め、その移動と後の移動が閉じてから届ける。前の移動の遅れた pull が、範囲を先へ渡した後の親に届き
// (類の表の 4 と 5)、遅れた応答が、受け取り終えた子に届く (7)。作業負荷と移動の乱択は、test/history.test.ts の「移動の途中の再起動」と
// 同じ値で、移動を作業負荷の全体に散らす (paceMs と maxMoves)。
//
// 確かめるのは、履歴の直列化可能性、最後の読み、行の置き場所、移動がどれも閉じること、取り残された intent、内部の表の誤り、「group not
// arrived」の断り、静止した後のメモリの印と記録から作り直す印、遅れた配送が受け手の記録を変えたこと (計画書の不変条件 15) である。
// 2026-11-17 の木 (5808b08) は、この類を直していない (test/late-pull-forward-chain.test.ts ほか)。既定では、受け手がもう生きた記録を
// 持たない移動の pull と、その応答の配送を落とし、落とした数を数える。OPEN=1 では落とさずに届け、検査が見つける。
// このファイルは基準経路の組 (vitest.config.ts の oracles) に入れない。全部の文を基準経路で流すと、移動の途中の読みはほとんど断られ、
// 生成器が何かを作ったことを確かめる最後の試験が、組によって変わる。
import { describe, expect, it } from "vitest";
import { readEpochs } from "../src/meta";
import { runHistory, type RunResult } from "./history";
import { seedsOr } from "./sim";

const MASK_LATE = !process.env.OPEN;
const memo = new Map<number, Promise<RunResult>>();
const run = (seed: number) => {
  if (!memo.has(seed)) {
    memo.set(seed, runHistory({
      seed, shards: 3, tenants: 40, skewMs: 20, ops: 40, thinkMs: 400, slowPhase2Ms: 2_000,
      // 再起動は seed ごとに入れたり外したりする (test/move-returns.test.ts の生成器 10 と同じ。再起動した子には、遅れた応答の結果が起きない)。
      moves: { kind: "chain", restarts: seed % 2 === 1, stops: true, slowMoveRpcMs: 60, paceMs: 500, maxMoves: 16, late: { share: 0.4, max: 3, mask: MASK_LATE } },
    }));
  }
  return memo.get(seed)!;
};

describe("a forward chain of half splits, with move messages that outlive their moves (generator 10)", () => {
  const defaults = [1, 2, 3, 4, 5, 6, 7, 8];
  for (const seed of seedsOr(defaults)) {
    it(`stays serializable, loses no write, and keeps its move records (seed ${seed})`, async () => {
      const r = await run(seed);
      expect(r.counts.moves).toBeGreaterThan(0);
      expect(r.counts.returns).toBe(0);
      expect(r.violations.slice(0, 3)).toEqual([]);
      expect(r.problems.slice(0, 5)).toEqual([]);
    }, 120_000);
  }
  // 生成器が何もしない実行にならないこと。2 度の分割が同じ範囲を運び (子が次の移動の親になる)、止めたメッセージが、移動が閉じた後に届き、
  // 遅れた pull とその応答が届く。既定では、mask がその配送を落としたことも確かめる。数えた形は 1 行で出す。
  it("chains half splits, delivers move messages after their moves closed, and the mask hides the known defects", async () => {
    const all = await Promise.all(defaults.map(run));
    const add = (pick: (r: RunResult) => Record<string, number>) => {
      const out: Record<string, number> = {};
      for (const r of all) for (const [k, n] of Object.entries(pick(r))) out[k] = (out[k] ?? 0) + n;
      return out;
    };
    const total = (x: Record<string, number>) => Object.values(x).reduce((a, n) => a + n, 0);
    const situations = add((r) => r.late.situations);
    const masked = add((r) => r.late.masked);
    // 鎖: ある移動の子が、後の移動の親になった。
    const chained = all.filter((r) => {
      const starts = readEpochs(r.c.metaBackend).flatMap((x) => (x.rec.kind === "move-start" ? [x.rec] : []));
      return starts.some((a, i) => starts.slice(i + 1).some((b) => b.from === a.to));
    }).length;
    console.info(`generator 10 (chain): chained runs ${chained}; held ${JSON.stringify(add((r) => r.late.held))}; outlived ${JSON.stringify(add((r) => r.late.outlived))}; situations ${JSON.stringify(situations)}; masked ${JSON.stringify(masked)}`);
    expect({
      chained: chained > 0,
      outlived: total(add((r) => r.late.outlived)) > 0,
      late: total(situations) - (situations["request window"] ?? 0) > 0,
      masked: MASK_LATE ? total(masked) > 0 : true,
    }).toEqual({ chained: true, outlived: true, late: true, masked: true });
  }, 240_000);
});
