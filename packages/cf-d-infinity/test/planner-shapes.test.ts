// 2 回目の全体レビューで見つかった、文の形によって誤った答えを返す (または誤って書く) 計画の回帰テスト。
import { describe, expect, it } from "vitest";
import { Db } from "../src/client/db";
import { ownerOf } from "../src/routing";
import { SimCluster } from "./sim";

async function cluster() {
  const c = new SimCluster({ shards: 2 });
  const db = c.client();
  const { routing } = await c.catalog();
  const on = (s: string, from = 1) => { for (let t = from; ; t++) if (ownerOf(routing, JSON.stringify([t])) === s) return t; };
  return { c, db, A: on("s0"), B: on("s1") };
}
const rows = async (db: Db, sql: string, params: (string | number | null)[] = []) => (await db.query(sql, params)).rows;

describe("statements that return or write a wrong answer", () => {
  it("1. INSERT with a scalar subquery reads only the target shard", async () => {
    const { db, A, B } = await cluster();
    await db.ddl(`CREATE TABLE names(id INTEGER PRIMARY KEY, name TEXT)`);
    await db.ddl(`CREATE TABLE o(id INTEGER PRIMARY KEY, who TEXT, cnt INTEGER)`);
    await db.query("INSERT INTO names VALUES (?, 'alice')", [A]);
    await db.query("INSERT INTO names VALUES (?, 'bob')", [B]);
    await db.query("INSERT INTO o(id, who, cnt) VALUES (?, (SELECT name FROM names WHERE id = ?), (SELECT count(*) FROM names))", [B, A]);
    const got = await rows(db, "SELECT who, cnt FROM o");
    expect(got).toEqual([{ who: "alice", cnt: 2 }]);
  });

  it("2. global-index route with `IN tablename`", async () => {
    const { db, A, B } = await cluster();
    await db.ddl(`CREATE TABLE u(id INTEGER PRIMARY KEY, email TEXT, grp INTEGER)`);
    await db.ddl(`CREATE INDEX u_email ON u(email)`);
    await db.ddl(`CREATE TABLE allowed(g INTEGER PRIMARY KEY)`);
    await db.query("INSERT INTO u VALUES (?, 'a@x', ?)", [A, B]); // the user is on s0, its group's row is on s1
    await db.query("INSERT INTO allowed VALUES (?)", [B]);
    const viaIndex = await rows(db, "SELECT id FROM u WHERE email = 'a@x' AND grp IN allowed");
    const noIndex = await rows(db, "SELECT id FROM u WHERE email || '' = 'a@x' AND grp IN allowed");
    await db.query("DELETE FROM u WHERE email = 'a@x' AND grp NOT IN allowed"); // must delete nothing
    const left = await rows(db, "SELECT id FROM u");
    expect(noIndex).toEqual([{ id: A }]);
    expect(viaIndex).toEqual([{ id: A }]);
    expect(left).toEqual([{ id: A }]);
  });

  it("3. ORDER BY an alias that has a column's name, with LIMIT", async () => {
    const { db } = await cluster();
    await db.ddl(`CREATE TABLE p(id INTEGER PRIMARY KEY, created INTEGER, updated INTEGER)`);
    for (let i = 1; i <= 20; i++) await db.query("INSERT INTO p VALUES (?, ?, ?)", [i, i, i <= 10 ? i : null]);
    const got = await rows(db, "SELECT id, coalesce(updated, created) AS updated FROM p ORDER BY updated DESC LIMIT 3");
    expect(got.map((r) => r.id)).toEqual([20, 19, 18]);
  });

  it("4. FULL JOIN with a condition on the right table in ON", async () => {
    const { db } = await cluster();
    await db.ddl(`CREATE TABLE a(id INTEGER PRIMARY KEY, x INTEGER)`);
    await db.ddl(`CREATE TABLE b(id INTEGER PRIMARY KEY, x INTEGER, y INTEGER)`);
    for (let i = 1; i <= 4; i++) await db.query("INSERT INTO a VALUES (?, ?)", [i, i]);
    for (let i = 1; i <= 4; i++) await db.query("INSERT INTO b VALUES (?, ?, ?)", [i, i, i % 2]);
    const got = await rows(db, "SELECT a.id AS a, b.id AS b FROM a FULL JOIN b ON a.x = b.x AND b.y = 1 ORDER BY 1, 2");
    expect(got).toEqual([{ a: null, b: 2 }, { a: null, b: 4 }, { a: 1, b: 1 }, { a: 2, b: null }, { a: 3, b: 3 }, { a: 4, b: null }]);
  });

  it("5a. a global index on a column added with ALTER TABLE: lookup by '30' for an INTEGER column", async () => {
    const { db } = await cluster();
    await db.ddl(`CREATE TABLE u(id INTEGER PRIMARY KEY, name TEXT)`);
    await db.ddl(`ALTER TABLE u ADD COLUMN age INTEGER`);
    await db.ddl(`CREATE INDEX u_age ON u(age)`);
    await db.query("INSERT INTO u VALUES (1, 'a', 30)");
    const got = await rows(db, "SELECT id FROM u WHERE age = ?", ["30"]);
    expect(got).toEqual([{ id: 1 }]);
  });

  it("5b. an index on a NOCASE column; RENAME COLUMN is refused", async () => {
    const { db } = await cluster();
    await db.ddl(`CREATE TABLE u(id INTEGER PRIMARY KEY, email TEXT COLLATE NOCASE)`);
    await db.ddl(`CREATE INDEX u_email ON u(email)`);
    await db.query("INSERT INTO u VALUES (1, 'a@x')");
    expect(await rows(db, "SELECT id FROM u WHERE email = 'A@X'")).toEqual([{ id: 1 }]);
    await expect(db.ddl(`ALTER TABLE u RENAME COLUMN email TO mail`)).rejects.toThrow(/^unsupported: ALTER TABLE ... RENAME COLUMN/);
    await expect(db.ddl(`ALTER TABLE u DROP COLUMN email`)).rejects.toThrow(/^unsupported: ALTER TABLE ... DROP COLUMN/);
    expect(await rows(db, "SELECT id FROM u WHERE email = 'A@X'")).toEqual([{ id: 1 }]);
  });

  it("6. max() of a NOCASE column written with a table qualifier", async () => {
    const { db, A, B } = await cluster();
    await db.ddl(`CREATE TABLE n(id INTEGER PRIMARY KEY, name TEXT COLLATE NOCASE)`);
    await db.query("INSERT INTO n VALUES (?, 'b')", [A]);
    await db.query("INSERT INTO n VALUES (?, 'C')", [B]);
    expect(await rows(db, "SELECT max(name) AS m FROM n")).toEqual([{ m: "C" }]);
    const got = await rows(db, "SELECT max(n.name) AS m FROM n");
    expect(got).toEqual([{ m: "C" }]);
  });

  it("7. a CTE in a subquery with the name of a real table used elsewhere", async () => {
    const { db, A, B } = await cluster();
    await db.ddl(`CREATE TABLE u(id INTEGER PRIMARY KEY, name TEXT)`);
    await db.ddl(`CREATE TABLE o(id INTEGER PRIMARY KEY, v INTEGER)`);
    await db.query("INSERT INTO u VALUES (?, 'a')", [A]);
    await db.query("INSERT INTO o VALUES (?, 1)", [A]);
    await db.query("INSERT INTO o VALUES (?, 2)", [B]);
    const got = await rows(db,
      `SELECT (SELECT count(*) FROM o) AS n FROM u, (WITH o AS (SELECT 1 AS c) SELECT c FROM o) x WHERE u.id = ?`, [A]);
    expect(got).toEqual([{ n: 2 }]);
  });
});
