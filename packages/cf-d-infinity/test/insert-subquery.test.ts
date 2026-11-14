// INSERT ... VALUES の値の式が表を読むとき、その読みが取引の読みとして検証されることを確かめる。
import { describe, expect, it } from "vitest";
import { Db } from "../src/client/db";
import { SimCluster } from "./sim";

const NEXT = "INSERT INTO items(tenant_id, id, pos) VALUES (1, ?, (SELECT coalesce(max(pos), 0) + 1 FROM items WHERE tenant_id = 1))";

describe("INSERT ... VALUES (..., (SELECT max(pos) + 1 ...)) in two concurrent transactions", () => {
  for (const begin of ["BEGIN", "BEGIN IMMEDIATE"]) {
    it(`${begin}: the two rows do not get the same position`, async () => {
      const c = new SimCluster({ shards: 2 });
      await c.client().ddl(`CREATE TABLE items(tenant_id INTEGER NOT NULL, id INTEGER NOT NULL, pos INTEGER NOT NULL, PRIMARY KEY (tenant_id, id))`);
      const [a, b] = [new Db(c), new Db(c)];
      await a.query(begin);
      await b.query(begin);
      await a.query(NEXT, [101]);
      await b.query(NEXT, [102]);
      const commits = await Promise.all([a, b].map((d) => d.query("COMMIT").then(() => "committed", (e: Error) => e.message)));
      const rows = (await new Db(c).query("SELECT id, pos FROM items ORDER BY id")).rows;
      // Serializable: either one transaction fails, or the positions are 1 and 2.
      const positions = rows.map((r) => r.pos);
      expect(new Set(positions).size).toBe(positions.length);
    });
  }

  it("control: the same read written as a separate SELECT is validated", async () => {
    const c = new SimCluster({ shards: 2 });
    await c.client().ddl(`CREATE TABLE items(tenant_id INTEGER NOT NULL, id INTEGER NOT NULL, pos INTEGER NOT NULL, PRIMARY KEY (tenant_id, id))`);
    const [a, b] = [new Db(c), new Db(c)];
    for (const d of [a, b]) await d.query("BEGIN");
    const next = async (d: Db) => Number((await d.query("SELECT coalesce(max(pos), 0) + 1 AS n FROM items WHERE tenant_id = 1")).rows[0]!.n);
    const [na, nb] = [await next(a), await next(b)];
    await a.query("INSERT INTO items VALUES (1, 101, ?)", [na]);
    await b.query("INSERT INTO items VALUES (1, 102, ?)", [nb]);
    const commits = await Promise.all([a, b].map((d) => d.query("COMMIT").then(() => "committed", (e: Error) => e.message)));
    expect(commits.filter((x) => x === "committed").length).toBe(1);
  });
});
