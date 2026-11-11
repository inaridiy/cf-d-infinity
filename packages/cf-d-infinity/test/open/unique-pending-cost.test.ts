// Review of f2224ce, fix 2 (uniquePending). Measures the work one write does on a table with a UNIQUE index while other
// transactions hold intents on that table. Asserts that the work does not grow with the number of pending intents.
import { describe, expect, it } from "vitest";
import { Db } from "../../src/client/db";
import { ownerOf } from "../../src/routing";
import { SimCluster } from "../sim";

describe("write on a table with a local UNIQUE index while N other transactions are pending", () => {
  it("costs about the same for N = 0 and N = 200", async () => {
    const measure = async (pending: number) => {
      const c = new SimCluster({ shards: 2 });
      const db = c.client();
      await db.ddl(`CREATE TABLE p(tenant_id INTEGER NOT NULL, id INTEGER NOT NULL, code TEXT, PRIMARY KEY (tenant_id, id), UNIQUE (tenant_id, code)) SHARD KEY (tenant_id)`);
      const { routing } = await c.catalog();
      const on = (s: string) => { for (let t = 1; ; t++) if (ownerOf(routing, JSON.stringify([t])) === s) return t; };
      const [A, B] = [on("s1"), on("s0")];
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      c.net.gate = (m) => (m.method === "finalize" && m.to === "s1" ? held : undefined);
      // `pending` two-shard transactions, anchored on s0, each leaves one intent on s1 (tenant A) until phase 2 arrives.
      for (let i = 0; i < pending; i++) {
        const x = await new Db(c).begin();
        await x.query("SELECT code FROM p WHERE tenant_id = ? AND id = ?", [B, 1_000_000 + i]);
        await x.query("INSERT INTO p VALUES (?, ?, ?)", [A, i, `a${i}`]);
        await x.query("INSERT INTO p VALUES (?, ?, ?)", [B, i, `b${i}`]);
        await x.commit();
      }
      const b = c.backends.get("s1")!;
      let statements = 0;
      let writes = 0;
      for (const k of ["exec", "raw", "iterate"] as const) {
        const orig = b[k].bind(b) as (sql: string, ...p: never[]) => unknown;
        (b as unknown as Record<string, unknown>)[k] = (sql: string, ...p: never[]) => {
          statements++;
          if (/^\s*(INSERT|DELETE|UPDATE)\b/i.test(sql) && /"p"/.test(sql)) writes++;
          return orig(sql, ...p);
        };
      }
      // Another tenant on the same shard would be the fair case; the shard key does not matter to uniquePending.
      await new Db(c).query("INSERT INTO p VALUES (?, ?, 'fresh')", [A, 5_000_000]);
      const out = { pending, statements, rowWritesOnUserTable: writes };
      c.net.gate = () => undefined;
      release();
      await c.settle();
      return out;
    };
    const base = await measure(0);
    const loaded = await measure(200);
    console.log(JSON.stringify({ base, loaded }));
    expect(loaded.rowWritesOnUserTable).toBeLessThanOrEqual(base.rowWritesOnUserTable + 5);
  }, 120_000);
});
