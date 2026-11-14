// 範囲の検査 (ShardDeps.spanEscape) そのものの試験。
// 検査は、どの試験にも test/setup.ts から掛かっている。ここでは、検査が本当に欠陥を見つけることを、過去の欠陥を戻して確かめる。
import { afterEach, describe, expect, it } from "vitest";
import { Db } from "../src/client/db";
import { spanFaults } from "../src/client/spans";
import { allSpanEscapes, SimCluster } from "./sim";

const P = `CREATE TABLE p(tenant_id INTEGER NOT NULL, id INTEGER NOT NULL, code TEXT, PRIMARY KEY (tenant_id, id))`;

describe("the span check", () => {
  afterEach(() => {
    spanFaults.rowSpanDespiteUnique = false;
    allSpanEscapes.length = 0; // ここで見つけたものは、この試験が確かめた。全体の検査には渡さない
  });

  const unique = async () => {
    const c = new SimCluster({ shards: 1 });
    const db = c.client();
    await db.ddl(P);
    await db.ddl(`CREATE UNIQUE INDEX p_code ON p(tenant_id, code)`);
    await db.query("INSERT INTO p VALUES (1, 1, 'a')");
    return { c, db };
  };

  it("reports a write that reads a row outside its span: REPLACE that removes the row holding the same UNIQUE value", async () => {
    spanFaults.rowSpanDespiteUnique = true;
    const { c, db } = await unique();
    await db.query("INSERT OR REPLACE INTO p VALUES (1, 2, 'a')");
    expect(c.spanEscapes.map((e) => e.sql)).toEqual([expect.stringMatching(/^INSERT OR REPLACE INTO "p"/)]);
  });

  it("reports an insert whose UNIQUE check read another row", async () => {
    spanFaults.rowSpanDespiteUnique = true;
    const { c, db } = await unique();
    await expect(db.query("INSERT INTO p VALUES (1, 2, 'a')")).rejects.toThrow(/UNIQUE/);
    await db.query("INSERT OR IGNORE INTO p VALUES (1, 3, 'a')");
    expect(c.spanEscapes.length).toBe(2);
  });

  it("stays silent for the same statements with the real spans", async () => {
    const { c, db } = await unique();
    await db.query("INSERT OR REPLACE INTO p VALUES (1, 2, 'a')");
    await expect(db.query("INSERT INTO p VALUES (1, 3, 'a')")).rejects.toThrow(/UNIQUE/);
    await db.query("INSERT OR IGNORE INTO p VALUES (1, 4, 'a')");
    await db.transaction(async (tx) => {
      await tx.query("UPDATE p SET code = 'b' WHERE tenant_id = 1 AND id = 2");
      await tx.query("INSERT INTO p VALUES (1, 5, 'a')");
    });
    expect(c.spanEscapes).toEqual([]);
  });

  it("ignores a statement whose result changes from run to run", async () => {
    const { c, db } = await unique();
    await db.query("UPDATE p SET code = hex(randomblob(4)) WHERE tenant_id = 1 AND id = 1");
    expect(c.spanEscapes).toEqual([]);
  });

  it("reports a read that depends on a table it did not declare", async () => {
    const c = new SimCluster({ shards: 1 });
    const db = c.client();
    await db.ddl(P);
    await db.ddl(`CREATE TABLE q(tenant_id INTEGER NOT NULL, id INTEGER NOT NULL, PRIMARY KEY (tenant_id, id))`);
    await db.query("INSERT INTO p VALUES (1, 1, 'a')");
    await db.query("INSERT INTO q VALUES (1, 1)");
    const { version } = await c.catalog();
    // 文は q も読むのに、範囲には p の 1 行しか入れていない。
    await c.shard("s0").exec({
      sql: "SELECT code, (SELECT count(*) FROM q WHERE tenant_id = 1) AS n FROM p WHERE tenant_id = 1 AND id = 1", params: [],
      spans: [{ kind: "pk", table: "p", pk: "[1,1]", sk: "[1]" }], schema: version,
    });
    expect(c.spanEscapes.length).toBe(1);
    // 同じ文を Db から出すと、q も範囲に入る。
    c.spanEscapes.length = 0;
    await db.query("SELECT code, (SELECT count(*) FROM q WHERE tenant_id = 1) AS n FROM p WHERE tenant_id = 1 AND id = 1");
    expect(c.spanEscapes).toEqual([]);
  });
});
