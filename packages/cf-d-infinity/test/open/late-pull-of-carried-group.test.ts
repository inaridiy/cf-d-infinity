// 未解決 (2026-11-17、consult-58 の表 (test/history.ts の LateRow) の 3。遅れた移動のメッセージの類): 終わった移動の遅れた pull が、範囲が前の持ち主へ戻って受け取り終えた
// 後で届き、そのグループが、その移動で運ばれていた (行があった) とき、前の持ち主は、そのグループを渡し直そうとして、内部の誤り
// (UNIQUE constraint failed: __moved.g, __moved.epoch, __moved.after) で答える。その pull を待っていた利用者の文も、この誤りで失敗する。
// 渡した印は、表に書く前にメモリへ付けるので、書き込みが失敗した後も、メモリにだけ残る。その後でそのグループを書いた取引の phase 2 を、
// 前の持ち主 (いまの持ち主) は、印のために適用せず、転送する記録もないので、どこへも送らずに受け取ったと答える。intent が残る。
// 再起動すると、印は表から作り直されて消える。
//
// 台本: s0 の範囲を s2 へ動かし (移動 1)、s2 の on-demand の pull (行のあるグループ z) を止める。移動 1 は drain で z を運んで閉じる。範囲を
// s0 へ戻し (移動 2。z は戻ってくる)、s0 が受け取り終えてから、止めた pull を届ける。その後で、z (s0) と y (s1) を書く取引を確定する。
// 問題 55 (test/stale-pull-after-return.test.ts) は、遅れた pull を範囲が戻る途中に届ける。ここでは受け取り終えた後に届ける。見つけたのは
// consult-58 の見直しの C である。乱択の検査では、生成器 5 (test/move-returns.test.ts の「generator 5」を OPEN=1 で流す) が「situation 3」として
// 数え、内部の誤りの検査と、メモリの印と記録から作り直す印の比べ (test/history.ts の marksProblems) が見つける。
//
// 不変条件 (計画書の不変条件 15): シャードは、生きた記録 (親なら終わっていない fence、子なら受け取り中の __incoming) を持つ移動の epoch を
// 名指しする要求と応答でだけ、渡しと受け取りの記録 (__moved、__moved_txn、__arrived) を変える。メモリの印 (moved、arrived) は、その記録から
// 導く。ここでは、親 s0 が、終わった fence の pull で渡しを始め、記録を書けずにメモリの印だけを変えた。持ち主は、シャードの移動の手順
// (src/shard/kernel.ts の pullPieces と fenceOf)。
import { describe, expect, it } from "vitest";
import { Db } from "../../src/client/db";
import { keyString } from "../../src/keys";
import { ownerOf, regionsOf } from "../../src/routing";
import { strandedIntents } from "../history";
import { SimCluster, type Rpc } from "../sim";

const latch = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};
const wants = (m: Rpc, g: string) => (m.req as { want: { g: string }[] }).want.some((w) => w.g === g);
const kernelOf = (c: SimCluster, id: string) => (c.cores.get(id) as unknown as { k: { moved: Map<string, unknown> } }).k;
const closed = async (c: SimCluster, tries = 400) => {
  for (let i = 0; i < tries && (await c.moves()).length > 0; i++) await c.sleep(50);
  return (await c.moves()).length === 0;
};

describe("a late pull of a finished move for a group that the move carried, after the range came back", () => {
  it("does not fail with an internal error, leaves no mark in memory only, and a later transaction on the group is applied", async () => {
    const c = new SimCluster({ shards: 2 });
    await new Db(c).ddl("CREATE TABLE items(id INTEGER PRIMARY KEY, n INTEGER NOT NULL)");
    const { routing } = await c.catalog();
    const [range] = regionsOf(routing, "s0");
    const on = (shard: string, skip = 0) => {
      for (let i = 1; ; i++) if (ownerOf(routing, keyString([BigInt(i)])) === shard && skip-- === 0) return i;
    };
    const [z, kept, y] = [on("s0"), on("s0", 1), on("s1")];
    await new Db(c).query("INSERT INTO items VALUES (?, 1), (?, 1), (?, 1)", [z, kept, y]);
    const g = keyString([BigInt(z)]);
    // s2 の drain の最初の listGroups と、s2 の on-demand の pull (グループ z) を止める。
    const gates = { list: latch(), pull: latch() };
    let [listed, pulled] = [false, false];
    c.net.gate = (m) => {
      if (m.from === "s2" && m.method === "listGroups" && !listed) return (listed = true), gates.list.promise;
      if (m.from === "s2" && m.method === "pull" && !pulled && wants(m, g)) return (pulled = true), gates.pull.promise;
      return undefined;
    };
    await c.moveAt("s0", "s2", range!, ["s0", "s2"]);
    const reader = new Db(c).query("SELECT n FROM items WHERE id = ?", [z]).then(() => "ok", (e: Error) => e.message);
    for (let i = 0; i < 100 && !pulled; i++) await c.sleep(5);
    expect(pulled).toBe(true);
    gates.list.resolve();
    expect(await closed(c)).toBe(true);
    await c.moveAt("s2", "s0", range!, ["s2", "s0"]);
    expect(await closed(c)).toBe(true);
    // 範囲は z と一緒に s0 に戻った。移動 1 の止めた pull を届ける。
    gates.pull.resolve();
    const read = await reader;
    await c.settle();
    await c.sleep(200);
    const mark = kernelOf(c, "s0").moved.get(g) ?? null;

    // z (s0) と y (s1) を書く取引。anchor が phase 2 を届け終えるまで待ち、読み手と再駆動が来る前に、直に SQLite を読む。
    const done = () => ["s0", "s1"].reduce((n, id) => n + c.backends.get(id)!.exec("SELECT txn FROM __txn WHERE status = 'committed' AND done = 1").length, 0);
    const base = done();
    const tx = await new Db(c).begin();
    await tx.query("UPDATE items SET n = 5 WHERE id = ?", [z]);
    await tx.query("UPDATE items SET n = 5 WHERE id = ?", [y]);
    const commit = await tx.commit().then(() => "ok", (e: Error) => e.message);
    for (let i = 0; i < 200 && done() === base; i++) await c.sleep(5);
    const stranded = strandedIntents(c);
    const applied = c.backends.get("s0")!.exec("SELECT n FROM items WHERE id = ?", z);
    expect({
      read: /^(ok|not owner|conflict|migrating|read too old)/.test(read) ? "ok or retryable" : read,
      mark, commit, stranded, applied,
    }).toEqual({ read: "ok or retryable", mark: null, commit: "ok", stranded: [], applied: [{ n: 5 }] });
  });
});
