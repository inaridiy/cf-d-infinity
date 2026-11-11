// Review of f2224ce, fix 6. Asserts the correct behaviour; fails today.
//
// A child that was told to expect a range at schema version N, whose parent applied version N+1 before it fenced, is
// behind its parent. It may catch up only when a group arrives (applySchema(catchUp)). But a request for a row of the
// moved range is checked against the schema (ensureSchema) BEFORE the child pulls the group (ensureArrived), and that
// check refuses to apply DDL on a moving shard. So on-demand pulling is dead: the range is unavailable until the
// background drain delivers its first group, and for good if the split driver stopped after the range-table switch.
import { describe, expect, it } from "vitest";
import { split } from "../../src/autoscaler";
import { Db } from "../../src/client/db";
import { planSplit, slotOf } from "../../src/routing";
import { SimCluster } from "../sim";

const outcome = async <T>(p: Promise<T>) => p.then((v) => ({ ok: v as unknown }), (e: Error) => ({ err: e.message }));

describe("split whose child is one schema version behind its parent", () => {
  it("serves a moved row on demand before the background copy has started", async () => {
    const c = new SimCluster({ shards: 1 });
    const db = c.client();
    await db.ddl("CREATE TABLE items(id INTEGER PRIMARY KEY, n INTEGER NOT NULL)");
    const ids = Array.from({ length: 40 }, (_, i) => i + 1);
    await db.query(`INSERT INTO items(id, n) VALUES ${ids.map((i) => `(${i}, ${i})`).join(", ")}`);
    const cat = await c.catalog();
    const range = planSplit(cat.routing, "s0")!;
    const moved = ids.find((id) => slotOf(JSON.stringify([id])) >= range.start && slotOf(JSON.stringify([id])) < range.end)!;

    // split(): step 1, the child prepares to receive the range (schema version 1).
    const { schema } = await c.shard("s1").beginIncoming({ ...range, from: "s0", schema: cat.version });
    // A schema change lands now. The parent is not fenced yet, so it applies it; the child is not in the range table.
    await new Db(c).ddl("CREATE TABLE other(id INTEGER PRIMARY KEY)");
    // split(): steps 2 and 3. The driver stops here (request cut off, Worker limit); the copy has not started.
    await c.shard("s0").fence({ ...range, to: "s1", schema });
    await c.switchRange({ ...range, to: "s1", from: "s0" });

    const health = await Promise.all(["s0", "s1"].map((id) => c.cores.get(id)!.health({}).then((h) => ({ id, schema: h.schema, incoming: h.incoming, outgoing: h.outgoing }))));
    const read = await outcome(new Db(c, { retries: 5 }).query("SELECT n FROM items WHERE id = ?", [moved]).then((r) => r.rows));
    const write = await outcome(new Db(c, { retries: 5 }).query("UPDATE items SET n = 0 WHERE id = ?", [moved]));
    console.log(JSON.stringify({ health, read, write }));

    // Running the split again finishes it.
    const resumed = await outcome(split(c, "s0", "s1"));
    const after = await outcome(new Db(c, { retries: 5 }).query("SELECT n FROM items WHERE id = ?", [moved]).then((r) => r.rows));
    console.log(JSON.stringify({ resumed: "err" in resumed ? resumed : "ok", after }));

    expect(read).toEqual({ ok: [{ n: moved }] });
    expect(write).toHaveProperty("ok");
  }, 60_000);
});
