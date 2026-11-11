import { describe, expect, it } from "vitest";
import { logRows, ORDERS, SimCluster, USERS } from "./sim";
import { slotOf } from "../src/routing";

async function setup(opts = {}) {
  const c = new SimCluster(opts);
  const db = c.client();
  await db.ddl(USERS);
  await db.ddl(ORDERS);
  return { c, db };
}
/** 別シャードに載る tenant を 2 つ探す。 */
function twoTenants(c: SimCluster): [number, number] {
  const s = (t: number) => Math.floor((slotOf(JSON.stringify([t])) * c.shardIds.length) / 4096);
  for (let b = 2; ; b++) if (s(b) !== s(1)) return [1, b];
}

describe("SQL on one shard", () => {
  it("insert, select, update, delete", async () => {
    const { db } = await setup();
    await db.query("INSERT INTO users(tenant_id,id,name) VALUES (?,?,?)", [1, 1, "a"]);
    await db.query("UPDATE users SET n = n + 5 WHERE tenant_id = ? AND id = ?", [1, 1]);
    expect((await db.query("SELECT name, n FROM users WHERE tenant_id = ? AND id = ?", [1, 1])).rows).toEqual([{ name: "a", n: 5 }]);
    const del = await db.query("DELETE FROM users WHERE tenant_id = ? AND id = ? RETURNING name", [1, 1]);
    expect(del.rows).toEqual([{ name: "a" }]);
    expect((await db.query("SELECT * FROM users WHERE tenant_id = 1")).rows).toEqual([]);
  });
  it("runs real SQLite inside the shard: join, group by, window, CTE-free subquery", async () => {
    const { db } = await setup();
    await db.query("INSERT INTO users(tenant_id,id,name) VALUES (1,1,'a'),(1,2,'b')");
    await db.query("INSERT INTO orders VALUES (1,1,1,'paid',10),(1,2,1,'paid',20),(1,3,2,'open',5)");
    const r = await db.query(
      `SELECT u.name, sum(o.total) s FROM users u JOIN orders o ON o.tenant_id = u.tenant_id AND o.user_id = u.id
       WHERE u.tenant_id = ? GROUP BY u.name ORDER BY s DESC`, [1]);
    expect(r.rows).toEqual([{ name: "a", s: 30 }, { name: "b", s: 5 }]);
    const w = await db.query("SELECT id, row_number() OVER (ORDER BY total DESC) r FROM orders WHERE tenant_id = 1 ORDER BY id");
    expect(w.rows.map((x) => x.r)).toEqual([2, 1, 3]);
    const sub = await db.query("SELECT name FROM users WHERE tenant_id = 1 AND id IN (SELECT user_id FROM orders WHERE tenant_id = 1 AND status = 'open')");
    expect(sub.rows).toEqual([{ name: "b" }]);
  });
  it("evaluates non-deterministic SQL once, on the shard", async () => {
    const { db } = await setup();
    await db.query("INSERT INTO users(tenant_id,id,n) VALUES (1,1,0)");
    await db.transaction(async (tx) => {
      await tx.query("UPDATE users SET n = abs(random()) % 1000 + 1 WHERE tenant_id = 1 AND id = 1");
      const a = (await tx.query("SELECT n FROM users WHERE tenant_id = 1 AND id = 1")).rows[0]!.n;
      const b = (await tx.query("SELECT n FROM users WHERE tenant_id = 1 AND id = 1")).rows[0]!.n;
      expect(a).toBe(b);
    });
  });
});

describe("writes go through SQLite itself, not through the parser", () => {
  it("captures UPSERT, INSERT SELECT, UPDATE FROM and REPLACE", async () => {
    const { c, db } = await setup();
    await db.query("INSERT INTO users(tenant_id,id,n) VALUES (1,1,1),(1,2,2)");
    await db.query("INSERT INTO users(tenant_id,id,n) VALUES (1,1,0) ON CONFLICT(tenant_id,id) DO UPDATE SET n = n + 10");
    await db.query("INSERT INTO users(tenant_id,id,n) SELECT tenant_id, id + 10, n FROM users WHERE tenant_id = 1");
    await db.query("UPDATE users SET n = x.m FROM (SELECT max(n) m FROM users WHERE tenant_id = 1) x WHERE tenant_id = 1 AND id = 2");
    await db.query("INSERT OR REPLACE INTO users(tenant_id,id,name,n) VALUES (1,12,'r',7)");
    await c.settle();
    const rows = (await db.query("SELECT id, n, name FROM users WHERE tenant_id = 1 ORDER BY id")).rows;
    expect(rows).toEqual([
      { id: 1, n: 11, name: null }, { id: 2, n: 11, name: null },
      { id: 11, n: 11, name: null }, { id: 12, n: 7, name: "r" },
    ]);
  });
  it("logs the row that REPLACE removes implicitly, so the snapshot can restore it", async () => {
    const { c, db } = await setup();
    await db.ddl(`CREATE TABLE p(tenant_id INTEGER NOT NULL, id INTEGER NOT NULL, code TEXT NOT NULL, PRIMARY KEY (tenant_id,id)) SHARD KEY (tenant_id)`);
    await db.ddl(`CREATE UNIQUE INDEX p_code ON p(tenant_id, code)`);
    await db.query("INSERT INTO p VALUES (1,1,'a')");
    await db.query("INSERT OR REPLACE INTO p(tenant_id,id,code) VALUES (1,2,'a')");
    await c.settle();
    expect((await db.query("SELECT id FROM p WHERE tenant_id = 1")).rows).toEqual([{ id: 2 }]);
    const log = logRows(c.backends.get(c.shardIds[Math.floor((slotOf("[1]") * c.shardIds.length) / 4096)]!)!).slice(-1);
    const logged = JSON.parse(log[0]!.blob as string) as { pk: string; after: unknown }[];
    expect(logged.map((l) => [l.pk, l.after === null])).toEqual(expect.arrayContaining([["[1,1]", true], ["[1,2]", false]]));
  });
});

describe("distributed planning", () => {
  it("runs a query that touches every shard without any hint", async () => {
    const { db } = await setup();
    await db.query("INSERT INTO users(tenant_id,id,name) VALUES (1,1,'a'),(2,1,'a'),(3,1,'b')");
    expect((await db.query("SELECT tenant_id FROM users WHERE name = 'a' ORDER BY tenant_id")).rows).toEqual([{ tenant_id: 1 }, { tenant_id: 2 }]);
  });
  it("joins tables across shards", async () => {
    const { db } = await setup();
    await db.query("INSERT INTO users(tenant_id,id,name) VALUES (1,5,'a'),(2,6,'b')");
    await db.query("INSERT INTO orders VALUES (3,1,5,'x',1),(4,2,6,'y',2)");
    const r = await db.query("SELECT u.name, o.status FROM users u JOIN orders o ON o.user_id = u.id ORDER BY u.name");
    expect(r.rows).toEqual([{ name: "a", status: "x" }, { name: "b", status: "y" }]);
  });
  it("merges scatter aggregates", async () => {
    const { db } = await setup();
    for (let t = 1; t <= 12; t++) {
      await db.query("INSERT INTO orders VALUES (?,1,1,?,?)", [t, t % 2 ? "paid" : "open", t * 10]);
    }
    const r = await db.query(
      "SELECT status, count(*) c, sum(total) s, avg(total) a, min(total) lo, max(total) hi FROM orders GROUP BY status ORDER BY c DESC, status");
    expect(r.rows).toEqual([
      { status: "open", c: 6, s: 420, a: 70, lo: 20, hi: 120 },
      { status: "paid", c: 6, s: 360, a: 60, lo: 10, hi: 110 },
    ]);
    const top = await db.query("SELECT tenant_id, total FROM orders ORDER BY total DESC LIMIT 2 OFFSET 1");
    expect(top.rows).toEqual([{ tenant_id: 11, total: 110 }, { tenant_id: 10, total: 100 }]);
    const empty = await db.query("SELECT count(*) c FROM users");
    expect(empty.rows).toEqual([{ c: 0 }]);
  });
});

describe("features that need the whole result are computed correctly", () => {
  const data = async () => {
    const { db } = await setup();
    for (let t = 1; t <= 6; t++) await db.query("INSERT INTO orders VALUES (?,1,1,?,?)", [t, t % 2 ? "paid" : "open", t]);
    return db;
  };
  it("DISTINCT", async () => {
    const db = await data();
    expect((await db.query("SELECT DISTINCT status FROM orders ORDER BY status")).rows).toEqual([{ status: "open" }, { status: "paid" }]);
  });
  it("window functions", async () => {
    const db = await data();
    const r = await db.query("SELECT tenant_id, row_number() OVER (ORDER BY tenant_id) r FROM orders ORDER BY tenant_id");
    expect(r.rows.map((x) => x.r)).toEqual([1, 2, 3, 4, 5, 6]);
  });
  it("HAVING and COUNT(DISTINCT)", async () => {
    const db = await data();
    expect((await db.query("SELECT status, count(*) c FROM orders GROUP BY status HAVING c > 2 ORDER BY status")).rows).toHaveLength(2);
    expect((await db.query("SELECT count(DISTINCT status) c FROM orders")).rows).toEqual([{ c: 2 }]);
  });
  it("creates partial and expression indexes on every shard", async () => {
    const { db } = await setup();
    await db.ddl("CREATE INDEX p ON orders(tenant_id, status) WHERE status = 'x'");
    await db.ddl("CREATE INDEX e ON orders(tenant_id, lower(status))");
    await expect(db.ddl("CREATE UNIQUE INDEX pu ON orders(status) WHERE status = 'x'")).rejects.toThrow(/shard key/);
  });
});

describe("indexes on tables that already hold data", () => {
  it("builds a local index", async () => {
    const { db } = await setup();
    await db.query("INSERT INTO orders VALUES (1,1,1,'paid',1)");
    await db.ddl("CREATE INDEX lo ON orders(tenant_id, total)");
    expect((await db.query("SELECT total FROM orders WHERE tenant_id = 1 AND total = 1")).rows).toEqual([{ total: 1 }]);
  });
  it("makes a plain index a local index on every shard: no index table, and writes stay on one shard", async () => {
    const { c, db } = await setup();
    await db.query("INSERT INTO orders VALUES (1,1,1,'paid',1),(2,1,1,'paid',1),(3,1,1,'open',1)");
    await db.ddl("CREATE INDEX st ON orders(status)");
    await c.settle();
    expect((await db.query("SELECT tenant_id FROM orders WHERE status = 'paid' ORDER BY tenant_id")).rows).toHaveLength(2);
    const cat = await c.catalog();
    expect(cat.tables.orders!.globalIndexes).toEqual([]);
    expect(cat.indexes.st).toEqual({ table: "orders", global: false });
    c.net.log = [];
    await db.query("INSERT INTO orders VALUES (4,1,1,'paid',1)");
    expect(c.net.log.some((m) => m.method === "prepare")).toBe(false);
  });
  it("backfills a UNIQUE index that spans shards from existing rows", async () => {
    const { c, db } = await setup();
    await db.query("INSERT INTO orders VALUES (1,1,1,'a',1),(2,1,1,'b',1),(3,1,1,'c',1)");
    await db.ddl("CREATE UNIQUE INDEX us ON orders(status)");
    await c.settle();
    expect((await c.catalog()).tables.orders!.globalIndexes[0]!.state).toBe("public");
    await expect(db.query("INSERT INTO orders VALUES (4,1,1,'a',1)")).rejects.toThrow(/UNIQUE/);
  });
  it("fails a UNIQUE global index over duplicates and removes it", async () => {
    const { c, db } = await setup();
    await db.query("INSERT INTO orders VALUES (1,1,1,'dup',1),(2,1,1,'dup',1)");
    await expect(db.ddl("CREATE UNIQUE INDEX us ON orders(status)")).rejects.toThrow(/UNIQUE/);
    expect((await c.catalog()).tables.orders!.globalIndexes).toEqual([]);
  });
  it("refuses UNIQUE over duplicates instead of breaking the shard", async () => {
    const { db } = await setup();
    await db.query("INSERT INTO orders VALUES (1,1,1,'paid',1),(1,2,1,'paid',1)");
    await expect(db.ddl("CREATE UNIQUE INDEX un ON orders(tenant_id, total)")).rejects.toThrow(/UNIQUE/);
    expect((await db.query("SELECT count(*) c FROM orders WHERE tenant_id = 1")).rows).toEqual([{ c: 2 }]);
  });
});

describe("routing", () => {
  it("sends a statement once per shard even when several shard keys share it", async () => {
    const { c, db } = await setup();
    // 2 シャードに 10 個の tenant を載せて、同じシャードの shard key が必ず重なるようにする。
    const small = new SimCluster({ shards: 2 });
    const d = small.client();
    await d.ddl(USERS);
    for (let t = 1; t <= 10; t++) await d.query("INSERT INTO users(tenant_id,id,n) VALUES (?,1,1)", [t]);
    const r = await d.query("SELECT sum(n) s, count(*) c FROM users WHERE tenant_id IN (1,2,3,4,5,6,7,8,9,10)");
    expect(r.rows).toEqual([{ s: 10, c: 10 }]);
    void c; void db;
  });
});

describe("transactions", () => {
  it("commits atomically across shards", async () => {
    const { c, db } = await setup();
    const [a, b] = twoTenants(c);
    await db.query("INSERT INTO users(tenant_id,id,n) VALUES (?,1,100)", [a]);
    await db.query("INSERT INTO users(tenant_id,id,n) VALUES (?,1,0)", [b]);
    await db.transaction(async (tx) => {
      await tx.query("UPDATE users SET n = n - 30 WHERE tenant_id = ? AND id = 1", [a]);
      await tx.query("UPDATE users SET n = n + 30 WHERE tenant_id = ? AND id = 1", [b]);
    });
    await c.settle();
    expect((await db.query("SELECT n FROM users WHERE tenant_id = ? AND id = 1", [a])).rows).toEqual([{ n: 70 }]);
    expect((await db.query("SELECT n FROM users WHERE tenant_id = ? AND id = 1", [b])).rows).toEqual([{ n: 30 }]);
  });
  it("reads its own writes through pushdown SQL", async () => {
    const { db } = await setup();
    await db.query("INSERT INTO orders VALUES (1,1,1,'paid',10)");
    await db.transaction(async (tx) => {
      await tx.query("INSERT INTO orders VALUES (1,2,1,'paid',32)");
      await tx.query("UPDATE orders SET total = 100 WHERE tenant_id = 1 AND id = 1");
      const r = await tx.query("SELECT sum(total) s, count(*) c FROM orders WHERE tenant_id = 1");
      expect(r.rows).toEqual([{ s: 132, c: 2 }]);
    });
    expect((await db.query("SELECT sum(total) s FROM orders WHERE tenant_id = 1")).rows).toEqual([{ s: 132 }]);
  });
  it("leaves nothing behind when the function throws", async () => {
    const { db } = await setup();
    await expect(db.transaction(async (tx) => {
      await tx.query("INSERT INTO users(tenant_id,id) VALUES (1,1)");
      throw new Error("boom");
    })).rejects.toThrow("boom");
    expect((await db.query("SELECT * FROM users WHERE tenant_id = 1")).rows).toEqual([]);
  });
  it("makes conflicting transactions retry, so no increment is lost", async () => {
    const { c, db } = await setup();
    const [a, b] = twoTenants(c);
    await db.query("INSERT INTO users(tenant_id,id,n) VALUES (?,1,0)", [a]);
    await db.query("INSERT INTO users(tenant_id,id,n) VALUES (?,1,0)", [b]);
    await Promise.all(Array.from({ length: 8 }, () => c.client().transaction(async (tx) => {
      await tx.query("UPDATE users SET n = n + 1 WHERE tenant_id = ? AND id = 1", [a]);
      await tx.query("UPDATE users SET n = n + 1 WHERE tenant_id = ? AND id = 1", [b]);
    })));
    await c.settle();
    expect((await db.query("SELECT n FROM users WHERE tenant_id = ? AND id = 1", [a])).rows).toEqual([{ n: 8 }]);
    expect((await db.query("SELECT n FROM users WHERE tenant_id = ? AND id = 1", [b])).rows).toEqual([{ n: 8 }]);
  });
});

describe("global index", () => {
  const ACC = `CREATE TABLE acct(tenant_id INTEGER NOT NULL, id INTEGER NOT NULL, email TEXT UNIQUE, PRIMARY KEY (tenant_id,id)) SHARD KEY (tenant_id)`;
  it("finds a row by a non shard key column without scatter", async () => {
    const { c, db } = await setup();
    await db.ddl(ACC);
    await db.query("INSERT INTO acct VALUES (7,1,'a@x')");
    await c.settle();
    expect((await db.query("SELECT tenant_id, id FROM acct WHERE email = ?", ["a@x"])).rows).toEqual([{ tenant_id: 7, id: 1 }]);
    await db.query("UPDATE acct SET email = 'b@x' WHERE email = 'a@x'");
    await c.settle();
    expect((await db.query("SELECT id FROM acct WHERE email = 'a@x'")).rows).toEqual([]);
    expect((await db.query("SELECT id FROM acct WHERE email = 'b@x'")).rows).toEqual([{ id: 1 }]);
  });
  it("enforces UNIQUE across shards", async () => {
    const { c, db } = await setup();
    await db.ddl(ACC);
    await db.query("INSERT INTO acct VALUES (1,1,'dup@x')");
    await c.settle();
    await expect(db.query("INSERT INTO acct VALUES (2,1,'dup@x')")).rejects.toThrow(/UNIQUE/);
  });
});
