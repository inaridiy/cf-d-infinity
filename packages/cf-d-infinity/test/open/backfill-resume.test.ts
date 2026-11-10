// Review of f2224ce, fix 8 (index backfill with saved progress). Asserts the correct behaviour; fails today.
//
// Db.backfill keeps ONE progress record per index: { routing version, shard, last primary key }. backfillShard returns
// `true` ("moved") without finishing a shard when that shard answers "not owner: stale schema" - which is what a shard
// says when another connection's DDL has reached it. The loop then goes on to the next shard, whose pages overwrite the
// progress record. The next round resumes from that record and skips every earlier shard, including the unfinished one,
// and then publishes the index.
import { describe, expect, it } from "vitest";
import { Db } from "../../src/client/db";
import { encode } from "../../src/shard/rows";
import { ownerOf } from "../../src/routing";
import { SimCluster } from "../sim";

describe("CREATE INDEX backfill while another connection changes the schema", () => {
  it("publishes an index that finds every row", async () => {
    const c = new SimCluster({ shards: 2 });
    const db = c.client();
    await db.ddl("CREATE TABLE t(id INTEGER PRIMARY KEY, email TEXT)");
    const { routing } = await c.catalog();
    const idsOn = (s: string, n: number) => {
      const out: number[] = [];
      for (let id = 1; out.length < n; id++) if (ownerOf(routing, JSON.stringify([id])) === s) out.push(id);
      return out;
    };
    // Rows on s1 get values whose index entries also live on s1, so that page commits on s1 alone.
    const emailOn = (s: string, seed: number) => {
      for (let i = 0; ; i++) {
        const e = `u${seed}_${i}@example.com`;
        if (ownerOf(routing, encode([encode([e])])) === s) return e;
      }
    };
    const rows: { id: number; email: string }[] = [
      ...idsOn("s0", 5).map((id) => ({ id, email: `s0row${id}@example.com` })),
      ...idsOn("s1", 5).map((id) => ({ id, email: emailOn("s1", id) })),
    ];
    for (const r of rows) await db.query("INSERT INTO t VALUES (?, ?)", [r.id, r.email]);

    let releaseS1!: () => void;
    const s1Held = new Promise<void>((r) => (releaseS1 = r));
    let raced = false;
    let heldOnce = false;
    let other: Promise<unknown> = Promise.resolve();
    c.net.gate = async (m) => {
      const req = m.req as { sql?: string; version?: number };
      // The other connection's DDL (version 3) reaches s0 at once and s1 a little later.
      if (!heldOnce && m.method === "syncSchema" && m.to === "s1" && req.version === 3) {
        heldOnce = true;
        return s1Held;
      }
      // The backfill is about to read its first page from s0.
      if (!raced && m.method === "exec" && m.to === "s0" && /FROM "t".*ORDER BY "id" LIMIT/.test(req.sql ?? "")) {
        raced = true;
        other = new Db(c).ddl("CREATE TABLE z(id INTEGER PRIMARY KEY)").catch((e) => e);
        for (let i = 0; i < 500 && (await c.cores.get("s0")!.health({})).schema < 3; i++) await new Promise((r) => setTimeout(r, 2));
      }
    };
    const created = await db.ddl("CREATE INDEX t_email ON t(email)").then(() => "ok", (e: Error) => e.message);
    releaseS1();
    await other;
    c.net.gate = () => undefined;
    await c.settle();

    const cat = await c.catalog();
    const state = cat.tables.t!.globalIndexes.map((g) => `${g.name}:${g.state}`);
    const reader = new Db(c);
    const missing: number[] = [];
    for (const r of rows) {
      const hit = await reader.query("SELECT id FROM t WHERE email = ?", [r.email]);
      if (hit.rows.length !== 1) missing.push(r.id);
    }
    const scanned = (await reader.query("SELECT count(*) AS n FROM t WHERE email LIKE '%@example.com'")).rows;
    console.log(JSON.stringify({ created, state, rowsInTable: scanned, lookupsThatFoundNothing: missing }));
    expect(raced).toBe(true);
    // Either the index is public and complete, or the statement failed and the index is not public.
    if (state.includes("t_email:public")) expect(missing).toEqual([]);
    else expect(created).not.toBe("ok");
  });
});
