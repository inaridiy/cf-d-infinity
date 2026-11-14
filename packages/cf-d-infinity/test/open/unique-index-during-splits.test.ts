// シャードの分割と並行に作ったシャードをまたぐ UNIQUE の index が、作り終えた直後に行と合わない (計画書の不変条件 7 と 4)。
//
// 2 週間分の一晩分の試験 (2026-11-13、seed 900001 から 904200、コミット faa6f20) で、表定義の変更の並行の検査の
// 「CREATE UNIQUE INDEX (global) and ADD COLUMN while shards split」が seed 903321 で落ちた。CREATE UNIQUE INDEX が成功を
// 返した直後に作業負荷を止めて調べると、index の表に、3 つの行の項目がなく ([5,3]、[6,3]、[4,3])、行のない項目が 1 つある
// ([1,2])。公開された index に行が欠けると、v で引く読みが行を返さない。今日の変更の前のコミット (38bb072) でも同じに落ちるので、
// 前からある欠陥である。毎晩の 300 seed では出ていなかった。
// 正しい振る舞い: index を作り終えたとき (公開したとき)、index の項目と行は一致する。
import { describe, expect, it } from "vitest";
import { runScenario, type Env, type Scenario } from "../ddl-harness";

/** test/ddl-concurrent.test.ts の uniqueIndexAndSplits と同じ場面。 */
const scenario: Scenario = {
  splits: true, ops: 60, replyJitter: true, values: "dup",
  ddl: async (e: Env) => {
    await e.at(0.3);
    const first = await e.ddl("CREATE UNIQUE INDEX acct_v ON acct(v)");
    await e.checkpoint("after first CREATE UNIQUE INDEX");
    if (first !== "ok") {
      await e.at(0.6);
      await e.ddl("CREATE UNIQUE INDEX acct_v ON acct(v)");
      await e.checkpoint("after second CREATE UNIQUE INDEX");
    }
    await e.at(0.7);
    await e.ddl("ALTER TABLE acct ADD COLUMN extra INTEGER DEFAULT 5");
    e.useExtra = true;
  },
};

describe("a cross-shard UNIQUE index built while shards split", () => {
  it("agrees with the rows when it is published (seed 903321 of the 2026-11-13 soak)", async () => {
    const r = await runScenario(903321, scenario);
    const points = [...r.checkpoints, { label: "final", ...r.index }];
    expect(points.flatMap((p) => [...p.missing, ...p.dangling].map((x) => `${p.label}: ${x}`))).toEqual([]);
  }, 120_000);
});
