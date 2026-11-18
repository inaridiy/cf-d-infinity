// 未解決 (計画書の未解決の問題 37 の続き): 移行の道具が表を作り直す取引 (新しい表を作り、古い表の行を写し、古い表を DROP し、名前を
// 変える) は、写した後に、写した範囲が分割で動くと、誰も古い表に書いていなくても、DROP が失敗する。
//
// 見つけたのは、生成器 6 (test/rebuild-across-split.ts、test/ddl-concurrent.test.ts の 8。2026-11-17)。分割がなければ、同じ取引は確定する。
// 成否が置き場所で変わる (AGENTS.md の規則 4)。
//
// DROP は、取引の中の DDL なので、先に、写した区切り (INSERT … SELECT。新しい表を書き、古い表を全表で読んだ) を確定する
// (specs/m13_txn_schema_boundary.qnt)。確定の検証は、読んだ範囲を、読んだときのシャード (分割の親) へ送る。親は、手放した区間の確かめに
// 答えないので、確定は `not owner` か、`conflict: not owner` で断られ、DROP の文がその誤りで失敗する (`not owner` は、利用者に見えては
// ならない誤りである)。確定が通っても、DROP の前の確かめ (mode guard の unchanged) も、読んだときのシャードへ送るので、同じく断られる
// (M23i の m23i_red_no_rehome。docs/design-refresh-across-move.md の「3 回目の実装の規則」の不変条件 D の「取引が読んだ表を DROP する
// 前の確かめも、同じ規則で通す」)。
// 不変条件: 確かめの窓 (確定の検証、DROP の前の確かめ) は、その行を受け持ったシャードの記録を全部通る (不変条件 D)。持ち主は、シャードの
// 確かめの経路と、Worker の宛先の決め直し。
import { describe, expect, it } from "vitest";
import { split } from "../../src/autoscaler";
import { Db } from "../../src/client/db";
import { SUBSLOTS } from "../../src/routing";
import { SimCluster } from "../sim";

const outcome = (p: Promise<unknown>) => p.then(() => "ok", (e: Error) => e.message);

describe("a transaction that rebuilds a table, while the range its copy read splits and nobody writes the table", () => {
  it("drops the old table, renames the new one and commits", async () => {
    const c = new SimCluster({ shards: 1 });
    await new Db(c).ddl("CREATE TABLE t(id INTEGER PRIMARY KEY, v INTEGER NOT NULL)");
    await new Db(c).query(`INSERT INTO t VALUES ${Array.from({ length: 30 }, (_v, i) => `(${i + 1}, ${i + 1})`).join(", ")}`);
    const r = (await c.catalog()).routing.ranges.find((x) => x.shard === "s0")!;
    const cut = Math.floor((r.start + r.end) / 2 / SUBSLOTS) * SUBSLOTS;
    const db = new Db(c, { retries: 0 });
    await db.query("BEGIN");
    await db.query("CREATE TABLE __new_t(id INTEGER PRIMARY KEY, v INTEGER NOT NULL, w INTEGER)");
    await db.query("INSERT INTO __new_t(id, v) SELECT id, v FROM t");
    await split(c, "s0", "s1", { range: { start: cut, end: r.end } });
    const drop = await outcome(db.query("DROP TABLE t"));
    const rename = drop === "ok" ? await outcome(db.query("ALTER TABLE __new_t RENAME TO t")) : "skipped";
    const commit = drop === "ok" ? await outcome(db.query("COMMIT")) : await outcome(db.query("ROLLBACK"));
    expect({ drop, rename, commit }).toEqual({ drop: "ok", rename: "ok", commit: "ok" });
    expect((await new Db(c).query("SELECT count(*) AS n, sum(v) AS s FROM t")).rows).toEqual([{ n: 30, s: 465 }]);
  });
});
