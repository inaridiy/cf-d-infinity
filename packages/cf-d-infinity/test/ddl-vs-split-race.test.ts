// Review of f2224ce, fix 6 (schema changes and splits exclude each other). Passes since 2026-11-11: a split holds the maintenance slot at Meta, which records no schema change while it does, and the split uses the version Meta gives with the slot (invariant 4, specs/m15_maintenance_slot.qnt).
//
// Before 2026-11-11, Db.record() asked every shard "are you moving?" (syncSchema) and then recorded the new version at
// Meta. The two steps were not atomic. If a split fenced the shard in between, the version was recorded anyway. From then
// on every Worker planned with the new version, and the parent and the child refused it ("schema change is waiting for a
// shard split") until the split had moved all its data - for every statement that touches them, not only for DDL.
// Since catalog epoch stage 3 (2026-11-16) the driver no longer asks the shards first: it reads the catalog and asks
// Meta to record the prepare. The replay starts the split between those two steps.
import { describe, expect, it } from "vitest";
import { split } from "../src/autoscaler";
import { Db } from "../src/client/db";
import { SimCluster, withOverrides } from "./sim";

const outcome = async <T>(p: Promise<T>) => p.then((v) => ({ ok: v as unknown }), (e: Error) => ({ err: e.message }));

describe("a schema change recorded just after a split fenced a shard", () => {
  it("does not make the rows of the splitting shards unreadable while the split runs", async () => {
    const c = new SimCluster({ shards: 1 });
    const db = c.client();
    await db.ddl("CREATE TABLE items(id INTEGER PRIMARY KEY, n INTEGER NOT NULL)");
    await db.ddl("CREATE TABLE other(id INTEGER PRIMARY KEY)");
    const ids = Array.from({ length: 40 }, (_, i) => i + 1);
    await db.query(`INSERT INTO items(id, n) VALUES ${ids.map((i) => `(${i}, ${i})`).join(", ")}`);

    let releaseDrain!: () => void;
    const drainHeld = new Promise<void>((r) => (releaseDrain = r));
    let splitting: Promise<unknown> = Promise.resolve();
    let started = false;
    c.net.gate = (m) => (m.method === "drain" ? drainHeld : undefined);
    const driver = withOverrides(c, {
      prepare: async (sql, opts, basedOn) => {
        // The DDL driver has read the catalog. Before it asks Meta to record the prepare, the autoscaler starts a split of s0
        // and gets as far as the range-table switch.
        if (!started) {
          started = true;
          splitting = outcome(split(c, "s0", "s1"));
          for (let i = 0; i < 500 && (await c.cores.get("s0")!.moves({})).outgoing.length === 0; i++) await c.sleep(2);
          for (let i = 0; i < 500 && (await c.catalog()).routing.ranges.length < 2; i++) await c.sleep(2);
        }
        return c.prepare(sql, opts, basedOn);
      },
    });
    const before = (await c.catalog()).schema;
    const ddl = await outcome(new Db(driver, { splitWaitMs: 300 }).ddl("ALTER TABLE other ADD COLUMN x INTEGER"));
    const recorded = (await c.catalog()).schema;

    // The split is still moving data (drain is held). Point reads and writes by primary key normally work during a split.
    const reads: Record<string, number> = {};
    const count = (k: string) => (reads[k] = (reads[k] ?? 0) + 1);
    for (const id of ids) {
      const r = await outcome(new Db(c, { retries: 3 }).query("SELECT n FROM items WHERE id = ?", [id]));
      count("err" in r ? `read: ${r.err.slice(0, 70)}` : "read: ok");
    }
    const write = await outcome(new Db(c, { retries: 3 }).query("UPDATE items SET n = n + 1 WHERE id = 1"));
    const health = await Promise.all(["s0", "s1"].map((id) => c.cores.get(id)!.health({}).then((h) => ({ id, schema: h.schema, incoming: h.incoming, outgoing: h.outgoing }))));
    console.log(JSON.stringify({ before, recorded, ddl, reads, write, health }, null, 1));

    releaseDrain();
    await splitting;
    await c.settle();
    const afterSplit = await outcome(new Db(c, { retries: 3 }).query("SELECT n FROM items WHERE id = 2").then((r) => r.rows));
    console.log(JSON.stringify({ afterSplit }));

    expect(started).toBe(true);
    expect(reads).toEqual({ "read: ok": ids.length });
    expect(write).toHaveProperty("ok");
  }, 60_000);
});
