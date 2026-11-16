// Review of f2224ce, fix 6. Passes since 2026-11-11: a split holds the maintenance slot at Meta, which records no schema change while it does, and the split uses the version Meta gives with the slot (invariant 4, specs/m15_maintenance_slot.qnt).
// Since catalog epoch stage 4 (2026-11-16) the slot is gone: the move-start record in Meta's epoch log is the range-table switch, the
// parent's fence and the start of the child's receive, and Meta records no schema transition while a move is open (M21's
// DDL_WAITS_MOVE). The child applies the log in order, so it starts receiving at the parent's schema epoch.
//
// A child that was told to expect a range at schema version N, whose parent applied version N+1 before it fenced, is
// behind its parent. It may catch up only when a group arrives (applySchema(catchUp)). But a request for a row of the
// moved range is checked against the schema (ensureSchema) BEFORE the child pulls the group (ensureArrived), and that
// check refuses to apply DDL on a moving shard. So on-demand pulling is dead: the range is unavailable until the
// background drain delivers its first group, and for good if the split driver stopped after the range-table switch.
import { describe, expect, it } from "vitest";
import { split } from "../src/autoscaler";
import { Db } from "../src/client/db";
import { planSplit, slotOf } from "../src/routing";
import { SimCluster } from "./sim";

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

    // The child's own copy of the rows starts when it applies the move-start. Hold it at its first step (listing the parent's
    // groups), so that the copy has not started when the reads below arrive.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    c.net.gate = (m) => (m.from === "s1" && m.method === "listGroups" ? held : undefined);
    // split(): the driver opens the move at Meta and tells the child, then stops (request cut off, Worker limit).
    await c.moveAt("s0", "s1", range, ["s1"]);
    // A schema change arrives now. While the move is open, Meta does not record it; it waits for the move.
    const ddl = outcome(new Db(c).ddl("CREATE TABLE other(id INTEGER PRIMARY KEY)"));
    const health = await Promise.all(["s0", "s1"].map((id) => c.cores.get(id)!.health({}).then((h) => ({ id, schema: h.schema, incoming: h.incoming, outgoing: h.outgoing }))));
    const read = await outcome(new Db(c, { retries: 5 }).query("SELECT n FROM items WHERE id = ?", [moved]).then((r) => r.rows));
    const write = await outcome(new Db(c, { retries: 5 }).query("UPDATE items SET n = 0 WHERE id = ?", [moved]));
    console.log(JSON.stringify({ health, read, write }));

    // Running the split again finishes it, and the schema change goes through after it.
    c.net.gate = () => undefined;
    release();
    const resumed = await outcome(split(c, "s0", "s1"));
    expect(await ddl).toHaveProperty("ok");
    const after = await outcome(new Db(c, { retries: 5 }).query("SELECT n FROM items WHERE id = ?", [moved]).then((r) => r.rows));
    console.log(JSON.stringify({ resumed: "err" in resumed ? resumed : "ok", after }));

    expect(read).toEqual({ ok: [{ n: moved }] });
    expect(write).toHaveProperty("ok");
  }, 60_000);
});
