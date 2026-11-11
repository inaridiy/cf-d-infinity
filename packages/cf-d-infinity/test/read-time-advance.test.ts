// 取引は、読む行に新しい確定があると、それまでの読みが変わっていないことを確かめたうえで、読む時点 T を先へ進める。
// その確認の対象は「記録済みの読み」である。別のシャードへ送って応答を待っている読みは、まだ記録されていない。
// それを古い T のまま使うと、1 つの文の中で、あるシャードは新しい時点、別のシャードは古い時点の行になる。
// 文の再生の検査 (test/replay.test.ts) が、複数シャードを読む文で見つけた。ここは、その最小の台本である。
import { describe, expect, it } from "vitest";
import { Db } from "../src/client/db";
import { ownerOf } from "../src/routing";
import { hold } from "./ddl-harness";
import { SimCluster } from "./sim";

describe("a transaction that advances its read timestamp while another shard's answer is in flight", () => {
  it("does not mix rows from two points in time in one statement", async () => {
    const c = new SimCluster({ shards: 2 });
    const db = c.client();
    await db.ddl("CREATE TABLE flat(id INTEGER PRIMARY KEY, v INTEGER NOT NULL)");
    const { routing } = await c.catalog();
    const on = (shard: string, skip = 0) => { for (let i = 1, n = 0; ; i++) if (ownerOf(routing, JSON.stringify([i])) === shard && n++ === skip) return i; };
    const [a0, a1, b0] = [on("s0", 0), on("s0", 1), on("s1", 0)];
    for (const id of [a0, a1, b0]) await db.query("INSERT INTO flat VALUES (?, 1)", [id]);
    c.time += 10;

    // 取引 X は、まず s0 の 1 行を読む。読む時点は s0 の時計で決まる。
    const x = await new Db(c, { retries: 0 }).begin();
    expect((await x.query("SELECT v FROM flat WHERE id = ?", [a0])).rows).toEqual([{ v: 1 }]);

    // X が全シャードを読む。s0 の応答は、返る途中で止める。s1 への要求は、届く前に止める。
    const isScan = (to: string) => (m: { to: string; method: unknown; req: unknown }) =>
      m.to === to && m.method === "exec" && /FROM "flat"/.test((m.req as { sql: string }).sql) && !/WHERE/.test((m.req as { sql: string }).sql);
    const s0Reply = hold(c, "reply", isScan("s0") as never);
    const s1Gate = hold(c, "gate", isScan("s1") as never);
    const sum = x.query("SELECT sum(v) AS s FROM flat").then((r) => r.rows[0]!.s, (e: Error) => e.message);
    await s0Reply.reached; // s0 は、まだ何も変わっていない状態を答えた

    // その間に、s0 と s1 の行が 1 つずつ書き換わって確定する。
    c.time += 10;
    await new Db(c).query("UPDATE flat SET v = 10 WHERE id = ?", [a1]);
    c.time += 10;
    await new Db(c).query("UPDATE flat SET v = 100 WHERE id = ?", [b0]);

    // s1 は「読む時点より後に変わった」と答える。X は読む時点を進めて s1 を読み直す。そこへ s0 の古い応答が届く。
    s1Gate.release();
    await c.sleep(30);
    s0Reply.release();
    const got = await sum;
    // 順に並べられる結果は、両方の書き換えの前 (3)、s0 の後 (12)、両方の後 (111) のどれかである。
    // s1 の書き換えだけを見た 102 は、どの時点の状態でもない。
    expect([3, 12, 111].includes(got as number) || typeof got === "string").toBe(true);
    expect(got).not.toBe(102);
  });
});
