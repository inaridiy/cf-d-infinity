import { DuckDBInstance } from "@duckdb/node-api";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collect } from "../src/analytics";
import { ORDERS, SimCluster } from "./sim";

describe("analytics path", () => {
  it("rebuilds the latest state in DuckDB and agrees with the OLTP tier", async () => {
    const c = new SimCluster();
    const db = c.client();
    await db.ddl(ORDERS);
    await db.ddl(`CREATE TABLE tenants(tenant_id INTEGER PRIMARY KEY, plan TEXT)`);
    for (let t = 1; t <= 10; t++) {
      await db.query("INSERT INTO tenants VALUES (?,?)", [t, t % 2 ? "pro" : "free"]);
      await db.query("INSERT INTO orders VALUES (?,1,1,'open',?)", [t, t * 10]);
    }
    await db.query("UPDATE orders SET status = 'paid' WHERE tenant_id = 1 AND id = 1");
    await db.query("DELETE FROM orders WHERE tenant_id = 2 AND id = 1");
    await c.settle();
    const oltp = await db.query("SELECT plan, sum(total) s FROM orders o JOIN tenants t ON t.tenant_id = o.tenant_id GROUP BY plan ORDER BY plan");

    c.time += 1000; // W は全シャードの flush 時刻の最小値なので、物理時刻が進んで初めて追いつく
    const snap = await collect(c);
    const dir = mkdtempSync(join(tmpdir(), "newsql-"));
    const file = join(dir, "changes.ndjson");
    writeFileSync(file, snap.changes.filter((x) => x.commit_ts <= snap.W).map((x) => JSON.stringify({ ...x, row: JSON.stringify(x.row) })).join("\n"));

    const duck = await (await DuckDBInstance.create(":memory:")).connect();
    await duck.run(`CREATE VIEW latest AS
      SELECT * FROM (SELECT *, row_number() OVER (PARTITION BY "table", pk ORDER BY commit_ts DESC) rn
                     FROM read_json('${file}', format='newline_delimited', columns={commit_ts:'BIGINT', "table":'VARCHAR', pk:'VARCHAR', deleted:'BOOLEAN', row:'VARCHAR'}))
      WHERE rn = 1 AND NOT deleted`);
    await duck.run(`CREATE VIEW orders AS SELECT (row->>'tenant_id')::INT tenant_id, row->>'status' status, (row->>'total')::INT total FROM latest WHERE "table" = 'orders'`);
    await duck.run(`CREATE VIEW tenants AS SELECT (row->>'tenant_id')::INT tenant_id, row->>'plan' plan FROM latest WHERE "table" = 'tenants'`);
    const r = await duck.runAndReadAll(`SELECT t.plan, sum(o.total)::INT s, count(*)::INT c FROM orders o JOIN tenants t USING (tenant_id) GROUP BY t.plan ORDER BY t.plan`);
    expect(r.getRowObjects()).toEqual([{ plan: "free", s: 280, c: 4 }, { plan: "pro", s: 250, c: 5 }]);
    // OLTP 層の同じ集計と一致する。
    expect(oltp.rows).toEqual([{ plan: "free", s: 280 }, { plan: "pro", s: 250 }]);
  });
});
