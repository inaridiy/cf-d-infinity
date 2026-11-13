// 同じ baton を 2 回使っても、確定と答えた書き込みは必ず入る (不変条件 12、specs/m17_txn_id_reuse.qnt、2026-11-13 に直した)。
//
// baton は署名されているが、使い捨てではない。取引の ID もそのまま戻るので、BEGIN の直後の baton から 2 つの続きを作れる
// (HTTP の再送でも起き得る)。直す前は、anchor が取引の ID だけで決着を覚えていて、2 つ目の続きの COMMIT に 1 つ目の結果
// (確定) を返した。2 つ目の書き込みは入らない。参加者も、同じ ID の 2 回目の prepare に、前の intent を残して ok と答えた。
// いまは、確定の記録と intent の中身で、同じ ID の別の続きを見分けて断る。見つけたのは 2026-11-12 の入口の安全の確認 (指摘 2)。
import { describe, expect, it } from "vitest";
import { Db } from "../src/client/db";
import { handlePipeline, type PipelineReq } from "../src/client/hrana";
import { keyString } from "../src/keys";
import { ownerOf } from "../src/routing";
import type { Faults } from "../src/types";
import { SimCluster } from "./sim";

const step = (c: SimCluster, baton: string | null, sql: string[]) =>
  handlePipeline({ baton, requests: sql.map((s) => ({ type: "execute", stmt: { sql: s } })) } as PipelineReq, async (token) => new Db(c, { token })) as Promise<{
    baton: string | null; results: { type: string; error?: { message: string } }[];
  }>;

/** BEGIN の直後の baton から、それぞれ 2 つのシャードに書いて COMMIT する続きを 2 つ作る。 */
async function twoContinuations(faults: Faults) {
  const c = new SimCluster({ shards: 2, faults });
  await new Db(c).ddl("CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)");
  const { routing } = await c.catalog();
  const on = (s: string, from: number) => { for (let i = from; ; i++) if (ownerOf(routing, keyString([i])) === s) return i; };
  const [a0, a1, b0, b1] = [on("s0", 1), on("s1", 1), on("s0", 100), on("s1", 100)];
  const begun = await step(c, null, ["BEGIN"]);
  const a = await step(c, begun.baton, [`INSERT INTO t VALUES (${a0}, 'a')`, `INSERT INTO t VALUES (${a1}, 'a')`, "COMMIT"]);
  const b = await step(c, begun.baton, [`INSERT INTO t VALUES (${b0}, 'b')`, `INSERT INTO t VALUES (${b1}, 'b')`, "COMMIT"]);
  await c.settle();
  const rows = (await new Db(c).query("SELECT id FROM t ORDER BY id")).rows.map((r) => r.id as number);
  const committed = (r: typeof a) => r.results.every((x) => x.type === "ok");
  return { committed: [committed(a), committed(b)], rows, a: [a0, a1], b: [b0, b1] };
}

describe("a baton used twice (m17)", () => {
  it("commits one continuation and refuses the other, so no write reported as committed is missing", async () => {
    const r = await twoContinuations({});
    expect(r.committed).toEqual([true, false]);
    expect(r.rows).toEqual(expect.arrayContaining(r.a));
    expect(r.rows.some((id) => r.b.includes(id))).toBe(false);
  });

  it("put back m17_red_prepare_only: an anchor that returns the earlier outcome tells the second continuation it committed, and loses its writes", async () => {
    const r = await twoContinuations({ commitIgnoresDigest: true });
    expect(r.committed).toEqual([true, true]);
    expect(r.rows.some((id) => r.b.includes(id))).toBe(false);
  });

  it("refuses a second prepare of the same transaction id with other writes on a participant (m17_red_commit_only)", async () => {
    for (const faults of [{}, { prepareKeepsFirst: true }] as Faults[]) {
      const c = new SimCluster({ shards: 1, faults });
      await new Db(c).ddl("CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)");
      const { version } = await c.catalog();
      const change = (id: number) => ({ table: "t", pk: keyString([id]), sk: keyString([id]), before: null, after: { id, v: "x" } });
      const T = await c.shard("s0").now({});
      const req = (id: number) => ({ txn: "t-reused", T, writes: [change(id)], spans: [], anchor: "s0", schema: version });
      expect((await c.shard("s0").prepare(req(1))).ok).toBe(true);
      expect((await c.shard("s0").prepare(req(1))).ok).toBe(true); // 同じ書き込みの再送は、同じ答え
      const second = await c.shard("s0").prepare(req(2));
      if ("prepareKeepsFirst" in faults) expect(second.ok).toBe(true); // 欠陥: 後の書き込みを捨てて ok と答える
      else expect(second).toEqual({ ok: false, reason: "conflict: transaction t-reused was prepared here with other writes" });
    }
  });
});
