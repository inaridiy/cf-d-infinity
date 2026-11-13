// 未解決: 同じ baton を 2 回使うと、1 つの取引が 2 つに分かれ、片方の書き込みが「確定した」と答えられたまま失われる (未解決の問題 23)。
// 2026-11-12 の入口の安全の確認、指摘 2。新しい不変条件 12 (復元した取引は、サーバーが出したもので、1 回だけ使われる)。
//
// baton は署名されているが、使い捨てではない。取引の ID もそのまま戻るので、BEGIN の直後の baton から 2 つの続きを作れる。
// HTTP の再送でも起き得る。偽造は要らない。
import { describe, expect, it } from "vitest";
import { Db } from "../../src/client/db";
import { handlePipeline, type PipelineReq } from "../../src/client/hrana";
import { ownerOf } from "../../src/routing";
import { SimCluster } from "../sim";

const step = (c: SimCluster, baton: string | null, sql: string[]) =>
  handlePipeline({ baton, requests: sql.map((s) => ({ type: "execute", stmt: { sql: s } })) } as PipelineReq, async (token) => new Db(c, { token })) as Promise<{
    baton: string | null; results: { type: string; error?: { message: string } }[];
  }>;

describe("a baton used twice", () => {
  it("never reports a write as committed that is not there", async () => {
    const c = new SimCluster({ shards: 2 });
    await new Db(c).ddl("CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)");
    const { routing } = await c.catalog();
    const on = (s: string, from: number) => { for (let i = from; ; i++) if (ownerOf(routing, JSON.stringify([i])) === s) return i; };
    // どちらの続きも、2 つのシャードに書く (シャードをまたぐ取引は、anchor が取引の ID で結果を覚える)。
    const [a0, a1, b0, b1] = [on("s0", 1), on("s1", 1), on("s0", 100), on("s1", 100)];
    const begun = await step(c, null, ["BEGIN"]);
    const a = await step(c, begun.baton, [`INSERT INTO t VALUES (${a0}, 'a')`, `INSERT INTO t VALUES (${a1}, 'a')`, "COMMIT"]);
    const b = await step(c, begun.baton, [`INSERT INTO t VALUES (${b0}, 'b')`, `INSERT INTO t VALUES (${b1}, 'b')`, "COMMIT"]);
    await c.settle();
    const rows = (await new Db(c).query("SELECT id FROM t ORDER BY id")).rows.map((r) => r.id);
    const committed = (r: typeof a) => r.results.every((x) => x.type === "ok");
    // どちらかが断られてよい。断られなかった続きの書き込みは、全部残っていなければならない。
    if (committed(a)) expect(rows).toEqual(expect.arrayContaining([a0, a1]));
    if (committed(b)) expect(rows).toEqual(expect.arrayContaining([b0, b1]));
  });
});
