// Review of f2224ce, fix 5 (the `late` check of an autocommit read through a global index). Asserts the correct
// behaviour; fails today.
//
// The read takes T from the index entry's shard and then asks the row's shard to refuse ("read too old") if the range
// it reads changed after T. The retry starts over: a new T from the index shard, the same check on the row shard.
// Nothing makes the second attempt more likely to succeed than the first, so under steady writes to rows that match
// the condition the read can lose every attempt and the statement fails.
import { describe, expect, it } from "vitest";
import { Db } from "../../src/client/db";
import { ownerOf } from "../../src/routing";
import { SimCluster } from "../sim";

describe("autocommit read through a global index while matching rows are being written", () => {
  it("(deterministic) finishes even if one committed write reaches the row's shard between each index lookup and row read", async () => {
    const c = new SimCluster({ shards: 2, now: () => Date.now() });
    const db = c.client();
    await db.ddl(`CREATE TABLE t(tenant_id INTEGER NOT NULL, id INTEGER NOT NULL, v INTEGER, n INTEGER NOT NULL, PRIMARY KEY (tenant_id, id)) SHARD KEY (tenant_id)`);
    await db.ddl(`CREATE INDEX ix ON t(v)`);
    const { routing } = await c.catalog();
    let P = 1;
    while (ownerOf(routing, JSON.stringify([P])) !== "s1") P++;
    let V = 100;
    while (ownerOf(routing, JSON.stringify([JSON.stringify([V])])) !== "s0") V++;
    await db.query("INSERT INTO t VALUES (?, 1, ?, 0)", [P, V]);
    await c.settle();

    // One other session keeps updating the row (the index key does not change). Each time the reader's request is on
    // its way to the row's shard, exactly one such update commits first.
    const writer = new Db(c);
    let writes = 0;
    let attempts = 0;
    c.net.gate = async (m) => {
      const req = m.req as { sql?: string; fresh?: boolean };
      if (m.method === "exec" && m.to === "s1" && req.fresh && /"v" = \?|v = \?/.test(req.sql ?? "")) {
        attempts++;
        await writer.query("UPDATE t SET n = n + 1 WHERE tenant_id = ? AND id = 1", [P]);
        writes++;
      }
    };
    const read = await new Db(c).query("SELECT n FROM t WHERE v = ?", [V]).then((r) => ({ ok: r.rows }), (e: Error) => ({ err: e.message }));
    c.net.gate = () => undefined;
    console.log(JSON.stringify({ attempts, writes, read }));
    expect(read).toHaveProperty("ok");
  }, 60_000);

  it("(load) 16 writers inserting rows with the same indexed value, 1-4 ms per RPC hop, do not make reads of that value fail", async () => {
    const c = new SimCluster({ shards: 2, now: () => Date.now() });
    c.net.jitter = () => 1 + Math.random() * 3;
    const db = c.client();
    await db.ddl(`CREATE TABLE o(id INTEGER PRIMARY KEY, status TEXT, n INTEGER)`);
    await db.ddl(`CREATE INDEX o_status ON o(status)`);
    for (let i = 1; i <= 20; i++) await db.query("INSERT INTO o VALUES (?, 'open', 0)", [i]);
    let stop = false;
    let next = 1000;
    let written = 0;
    const writers = Array.from({ length: 16 }, async () => {
      const w = new Db(c);
      while (!stop) {
        await w.query("INSERT INTO o VALUES (?, 'open', 0)", [next++]).then(() => written++, () => undefined);
      }
    });
    const results: Record<string, number> = {};
    let tries = 0;
    for (let i = 0; i < 25; i++) {
      const r = new Db(c, { onStatement: (s) => (tries += s.attempts) });
      const out = await r.query("SELECT count(*) AS n FROM o WHERE status = 'open'").then(() => "ok", (e: Error) => e.message.replace(/\d+/g, "N"));
      results[out] = (results[out] ?? 0) + 1;
    }
    stop = true;
    await Promise.all(writers);
    await c.settle();
    console.log(JSON.stringify({ reads: 25, results, attemptsPerRead: tries / 25, rowsWrittenMeanwhile: written }));
    expect(results).toEqual({ ok: 25 });
  }, 120_000);
});
