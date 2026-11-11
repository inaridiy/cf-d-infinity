// Review of f2224ce, fix 1 (DDL validation, reserved names). Each test asserts the correct behaviour and fails today.
import { describe, expect, it } from "vitest";
import { Db } from "../../src/client/db";
import { SimCluster } from "../sim";

const outcome = async <T>(p: Promise<T>) => p.then((v) => ({ ok: v as unknown }), (e: Error) => ({ err: e.message }));

describe("DDL that Meta accepts but the Worker's SQLite (history replay) rejects", () => {
  // Meta validates only the shard statements (entry.sql). entry.user is replayed by openScratch() on every
  // statement that gathers rows; one failing entry makes every such statement fail, and no later DDL removes it.
  const brick = async (name: string, setup: string[], bad: string, repair: string[]) => {
    it(`${name}: is refused, or at least leaves multi-shard reads of other tables working`, async () => {
      const c = new SimCluster({ shards: 2 });
      const db = c.client();
      await db.ddl("CREATE TABLE other(id INTEGER PRIMARY KEY, n INTEGER)");
      for (let i = 1; i <= 6; i++) await db.query("INSERT INTO other VALUES (?, ?)", [i, i]);
      for (const s of setup) await db.ddl(s);
      const ddl = await outcome(db.ddl(bad));
      const read = await outcome(new Db(c, { retries: 2 }).query("SELECT n FROM other ORDER BY n DESC").then((r) => r.rows.length));
      const repaired: unknown[] = [];
      for (const s of repair) repaired.push(await outcome(new Db(c, { retries: 2 }).ddl(s)));
      const after = await outcome(new Db(c, { retries: 2 }).query("SELECT n FROM other ORDER BY n DESC").then((r) => r.rows.length));
      console.log(JSON.stringify({ name, ddl, read, repaired, after }));
      expect(read).toEqual({ ok: 6 });
      expect(after).toEqual({ ok: 6 });
    });
  };
  brick("CREATE VIEW named like an existing table", ["CREATE TABLE u(id INTEGER PRIMARY KEY, name TEXT)"], "CREATE VIEW u AS SELECT 1 AS x", ["DROP VIEW u", "DROP TABLE u"]);
  brick("global CREATE INDEX named like an existing table",
    ["CREATE TABLE u(id INTEGER PRIMARY KEY, name TEXT)", "CREATE TABLE v(id INTEGER PRIMARY KEY, name TEXT)"],
    "CREATE INDEX v ON u(name)", ["DROP INDEX v", "DROP TABLE u"]);
});

describe("names starting with __ are internal everywhere a user names an object", () => {
  it("DROP TABLE of a global-index table is refused; the base table stays writable", async () => {
    const c = new SimCluster({ shards: 2 });
    const db = c.client();
    await db.ddl("CREATE TABLE u(id INTEGER PRIMARY KEY, email TEXT UNIQUE)");
    await db.query("INSERT INTO u VALUES (1, 'a')");
    const drop = await outcome(db.ddl(`DROP TABLE "__gidx_u_0_key"`));
    const insert = await outcome(new Db(c, { retries: 2 }).query("INSERT INTO u VALUES (2, 'b')"));
    const repair = await outcome(new Db(c, { retries: 2 }).ddl("DROP INDEX u_0_key"));
    console.log(JSON.stringify({ drop, insert, repair }));
    expect(drop).toHaveProperty("err");
    expect(insert).toHaveProperty("ok");
  });

  it("ALTER TABLE ... RENAME of a global-index table is refused", async () => {
    const c = new SimCluster({ shards: 2 });
    const db = c.client();
    await db.ddl("CREATE TABLE u(id INTEGER PRIMARY KEY, email TEXT UNIQUE)");
    const alter = await outcome(db.ddl(`ALTER TABLE "__gidx_u_0_key" RENAME TO stolen`));
    const insert = await outcome(new Db(c, { retries: 2 }).query("INSERT INTO u VALUES (2, 'b')"));
    console.log(JSON.stringify({ alter, insert }));
    expect(alter).toHaveProperty("err");
    expect(insert).toHaveProperty("ok");
  });

  it("DML addressed to a global-index table by its key is refused; the UNIQUE constraint keeps holding", async () => {
    const c = new SimCluster({ shards: 2 });
    const db = c.client();
    await db.ddl("CREATE TABLE u(id INTEGER PRIMARY KEY, email TEXT UNIQUE)");
    await db.query("INSERT INTO u VALUES (1, 'a')");
    const k = JSON.stringify(["a"]);
    const del = await outcome(db.query(`DELETE FROM "__gidx_u_0_key" WHERE k = ?`, [k]).then((r) => r.changes));
    const dup = await outcome(new Db(c, { retries: 2 }).query("INSERT INTO u VALUES (2, 'a')").then((r) => r.changes));
    const scan = await outcome(new Db(c, { retries: 2 }).query("SELECT id, email FROM u ORDER BY email, id").then((r) => r.rows));
    console.log(JSON.stringify({ del, dup, scan }));
    expect(del).toHaveProperty("err");
    expect(dup).toHaveProperty("err");
    expect(scan).toEqual({ ok: [{ id: 1, email: "a" }] });
  });

  it("a shard's internal tables cannot be read through a CTE of the same name defined elsewhere in the statement", async () => {
    const c = new SimCluster({ shards: 2 });
    const db = c.client();
    await db.ddl("CREATE TABLE u(id INTEGER PRIMARY KEY, name TEXT)");
    await db.query("INSERT INTO u VALUES (1, 'a')");
    const read = await outcome(db.query(
      `SELECT (SELECT group_concat(k) FROM __meta) AS leaked FROM u WHERE id = 1 AND EXISTS (WITH __meta AS (SELECT 1) SELECT 1 FROM __meta)`,
    ).then((r) => r.rows));
    const write = await outcome(db.query(
      `UPDATE u SET name = (SELECT group_concat(entry) FROM __ddl) WHERE id = 1 AND EXISTS (WITH __ddl AS (SELECT 1) SELECT 1 FROM __ddl)`,
    ).then(() => db.query("SELECT length(name) AS n FROM u WHERE id = 1")).then((r) => r.rows));
    console.log(JSON.stringify({ read, write }));
    expect(read).toHaveProperty("err");
    expect(write).toHaveProperty("err");
  });
});

describe("CREATE TABLE ... SHARD KEY followed by a second statement", () => {
  it("does not make multi-shard reads return a row that no shard holds", async () => {
    const c = new SimCluster({ shards: 2 });
    const db = c.client();
    const ddl = await outcome(db.query("CREATE TABLE a(id INTEGER PRIMARY KEY, n INTEGER) SHARD KEY (id); INSERT INTO a VALUES (100, 7)"));
    const point = await outcome(new Db(c).query("SELECT n FROM a WHERE id = 100").then((r) => r.rows));
    const scan = await outcome(new Db(c).query("SELECT id, n FROM a ORDER BY n DESC").then((r) => r.rows));
    console.log(JSON.stringify({ ddl, point, scan }));
    // Either the INSERT ran (both reads see the row) or it did not (neither does).
    expect((scan as { ok: unknown[] }).ok?.length).toBe((point as { ok: unknown[] }).ok?.length);
  });
});
