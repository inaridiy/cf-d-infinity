// 照合順序 (NOCASE など) のある列は、主キー、shard key、シャードをまたぐ UNIQUE には使えない。
// 行の同一性を値そのもので決めているので、'abc' と 'ABC' を同じ行として扱う規則を、経路、分割、ロック、検証のすべてで
// 揃える必要がある。揃えきるまでは、黙って通さずに断る。キーでない列の照合順序は、SQLite がそのまま扱う。
import { describe, expect, it } from "vitest";
import { SimCluster } from "./sim";

describe("collations on key columns", () => {
  it("are refused on the primary key, the shard key and a UNIQUE that spans shards", async () => {
    const db = new SimCluster({ shards: 2 }).client();
    for (const sql of [
      "CREATE TABLE a(name TEXT COLLATE NOCASE PRIMARY KEY, n INTEGER)",
      "CREATE TABLE a(tenant TEXT COLLATE RTRIM NOT NULL, id INTEGER NOT NULL, PRIMARY KEY (tenant, id))",
      "CREATE TABLE a(tenant_id INTEGER NOT NULL, code TEXT COLLATE NOCASE NOT NULL, PRIMARY KEY (tenant_id, code))",
      "CREATE TABLE a(id INTEGER PRIMARY KEY, email TEXT COLLATE NOCASE UNIQUE)",
    ]) await expect(db.ddl(sql)).rejects.toThrow(/^unsupported: COLLATE/);
    await db.ddl("CREATE TABLE b(id INTEGER PRIMARY KEY, email TEXT COLLATE NOCASE)");
    await expect(db.ddl("CREATE UNIQUE INDEX b_email ON b(email)")).rejects.toThrow(/^unsupported: COLLATE/);
  });

  it("work on other columns, including a UNIQUE inside one shard key", async () => {
    const db = new SimCluster({ shards: 2 }).client();
    await db.ddl("CREATE TABLE p(tenant_id INTEGER NOT NULL, id INTEGER NOT NULL, code TEXT COLLATE NOCASE, PRIMARY KEY (tenant_id, id), UNIQUE (tenant_id, code))");
    await db.query("INSERT INTO p VALUES (1, 1, 'abc')");
    await expect(db.query("INSERT INTO p VALUES (1, 2, 'ABC')")).rejects.toThrow(/UNIQUE/);
    await db.query("INSERT INTO p VALUES (2, 1, 'ABC')");
    expect((await db.query("SELECT tenant_id FROM p WHERE code = 'Abc' ORDER BY tenant_id")).rows).toEqual([{ tenant_id: 1 }, { tenant_id: 2 }]);
  });
});
