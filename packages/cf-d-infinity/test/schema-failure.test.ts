// SQLite が拒否する DDL を記録すると、全シャードが適用に失敗し続け、直すための DDL も通らなくなる。
// Meta は自分の SQLite の空の表で実行してから記録する。行があるシャードでだけ失敗する文は、そのシャードが取り消しを求める。
import { describe, expect, it } from "vitest";
import { Db } from "../src/client/db";
import { ownerOf, shardsOf } from "../src/routing";
import { SimCluster } from "./sim";

const outcome = async <T>(p: Promise<T>) => p.then((v) => ({ ok: v as unknown }), (e: Error) => ({ err: e.message }));

const CASES: [string, string[], string][] = [
  ["ADD COLUMN ... NOT NULL without a default", [], "ALTER TABLE ok ADD COLUMN z INTEGER NOT NULL"],
  ["a STRICT table with a non-STRICT type", [], "CREATE TABLE s(id INTEGER PRIMARY KEY, name VARCHAR(20)) STRICT"],
  ["a duplicate column name", [], "CREATE TABLE d(id INTEGER PRIMARY KEY, a, a)"],
  ["DROP COLUMN of a column used by a local index",
    ["CREATE TABLE x(tenant_id INTEGER NOT NULL, id INTEGER NOT NULL, v INTEGER, PRIMARY KEY (tenant_id, id))", "CREATE INDEX x_v ON x(tenant_id, v)"],
    "ALTER TABLE x DROP COLUMN v"],
  ["a table name SQLite reserves", [], "CREATE TABLE sqlite_things(id INTEGER PRIMARY KEY)"],
];

describe("a schema change that SQLite rejects on the shard", () => {
  for (const [name, setup, bad] of CASES) {
    it(`${name}: is refused and leaves the cluster usable`, async () => {
      const c = new SimCluster({ shards: 2 });
      const db = c.client();
      await db.ddl("CREATE TABLE ok(id INTEGER PRIMARY KEY, n INTEGER)");
      for (const s of setup) await db.ddl(s);
      await db.query("INSERT INTO ok VALUES (1, 1)");
      const ddl = await outcome(db.ddl(bad));
      const read = await outcome(new Db(c, { retries: 2 }).query("SELECT n FROM ok WHERE id = 1").then((r) => r.rows));
      const fix = await outcome(new Db(c, { retries: 2 }).ddl("CREATE TABLE later(id INTEGER PRIMARY KEY)"));
      expect(ddl).toHaveProperty("err"); // refusing the statement is right
      expect(read).toEqual({ ok: [{ n: 1 }] }); // ...but nothing else may break
      expect(fix).toEqual({ ok: undefined });
    });
  }

  it("CREATE UNIQUE INDEX IF NOT EXISTS over existing duplicates: is refused and leaves the shard usable", async () => {
    const c = new SimCluster({ shards: 2 });
    const db = c.client();
    await db.ddl(`CREATE TABLE p(tenant_id INTEGER NOT NULL, id INTEGER NOT NULL, code TEXT, PRIMARY KEY (tenant_id, id))`);
    await db.query("INSERT INTO p VALUES (1, 1, 'x')");
    await db.query("INSERT INTO p VALUES (1, 2, 'x')");
        await expect(db.ddl("CREATE UNIQUE INDEX ux0 ON p(tenant_id, code)")).rejects.toThrow(/duplicate values/);
    const ddl = await outcome(db.ddl("CREATE UNIQUE INDEX IF NOT EXISTS ux ON p(tenant_id, code)"));
    const read = await outcome(new Db(c, { retries: 2 }).query("SELECT id FROM p WHERE tenant_id = 1 ORDER BY id").then((r) => r.rows));
    expect(ddl).toHaveProperty("err");
    expect(read).toEqual({ ok: [{ id: 1 }, { id: 2 }] });
  });

  // ここから下は、空の表では通るので Meta の検証では見つからない文。行を持つシャードが適用に失敗して、取り消しを求める。
  const twoShards = async () => {
    const c = new SimCluster({ shards: 2 });
    const db = c.client();
    await db.ddl(`CREATE TABLE p(tenant_id INTEGER NOT NULL, id INTEGER NOT NULL, code TEXT, gone INTEGER, PRIMARY KEY (tenant_id, id))`);
    // 片方のシャードにだけ、文に反する行を置く。
    const { routing } = await c.catalog();
    const tenants = [1, 2, 3, 4, 5, 6, 7, 8];
    const on = (shard: string) => tenants.find((t) => ownerOf(routing, JSON.stringify([t])) === shard)!;
    const [bad, good] = [on("s0"), on("s1")];
    await db.query("INSERT INTO p VALUES (?, 1, 'x', 1)", [bad]);
    await db.query("INSERT INTO p VALUES (?, 2, 'x', 1)", [bad]);
    await db.query("INSERT INTO p VALUES (?, 1, 'y', NULL)", [good]);
    return { c, db, bad, good };
  };
  const settled = async (c: SimCluster) => {
    const cat = await c.catalog();
    const health = await Promise.all(shardsOf(cat.routing).map((id) => c.shard(id).health({})));
    expect(health.map((h) => h.schema)).toEqual(health.map(() => cat.version));
    expect(health.map((h) => h.schemaError ?? null)).toEqual(health.map(() => null));
    return cat;
  };

  it("a partial UNIQUE index that one shard's rows violate: is withdrawn everywhere and reported", async () => {
    const { c, db, bad, good } = await twoShards();
    await expect(db.ddl("CREATE UNIQUE INDEX ux ON p(tenant_id, code) WHERE gone IS NOT NULL")).rejects.toThrow(/UNIQUE constraint failed/);
    const cat = await settled(c);
    expect(cat.indexes.ux).toBeUndefined();
    expect(cat.ddl.join("\n")).not.toMatch(/ux/);
    // どちらのシャードも読み書きできる。index は残っていないので、重複する値も入る。
    const other = new Db(c, { retries: 2 });
    await other.query("INSERT INTO p VALUES (?, 3, 'x', 1)", [bad]);
    await other.query("INSERT INTO p VALUES (?, 2, 'y', 1)", [good]);
    await other.query("INSERT INTO p VALUES (?, 3, 'y', 1)", [good]);
    expect((await other.query("SELECT count(*) n FROM p")).rows).toEqual([{ n: 6 }]);
    // 直してから出し直せば通る。
    await other.query("DELETE FROM p WHERE code = 'x' AND id > 1");
    await other.query("DELETE FROM p WHERE code = 'y' AND id > 2");
    await other.ddl("CREATE UNIQUE INDEX ux ON p(tenant_id, code) WHERE gone IS NOT NULL");
    await settled(c);
    await expect(other.query("INSERT INTO p VALUES (?, 9, 'x', 1)", [bad])).rejects.toThrow(/UNIQUE/);
  });

  it("ADD COLUMN with a CHECK that one shard's rows violate: is withdrawn everywhere and reported", async () => {
    const { c, db, bad, good } = await twoShards();
    await expect(db.ddl("ALTER TABLE p ADD COLUMN extra INTEGER CHECK (gone IS NULL)")).rejects.toThrow(/CHECK constraint failed/);
    const cat = await settled(c);
    expect(cat.tables.p!.columns).not.toContain("extra");
    const other = new Db(c, { retries: 2 });
    await expect(other.query("SELECT extra FROM p")).rejects.toThrow(/no such column/);
    // 列を足す前の形のまま書ける。取引の中の書き込みは、行イメージを捕捉する trigger を通る。
    await other.transaction(async (tx) => {
      await tx.query("UPDATE p SET code = 'z' WHERE tenant_id = ? AND id = 1", [bad]);
      await tx.query("UPDATE p SET code = 'z' WHERE tenant_id = ? AND id = 1", [good]);
    });
    expect((await other.query("SELECT count(*) n FROM p WHERE code = 'z'")).rows).toEqual([{ n: 2 }]);
    await other.ddl("ALTER TABLE p ADD COLUMN extra INTEGER");
    await settled(c);
    expect((await other.query("SELECT extra FROM p WHERE tenant_id = ? AND id = 1", [bad])).rows).toEqual([{ extra: null }]);
  });

  it("names that start with __ are refused: internal tables live under that prefix", async () => {
    const db = new SimCluster({ shards: 2 }).client();
    await expect(db.ddl("CREATE TABLE __intents(id INTEGER PRIMARY KEY)")).rejects.toThrow(/reserved/);
    await expect(db.ddl("CREATE TABLE __gidx_x(k TEXT PRIMARY KEY)")).rejects.toThrow(/reserved/);
    await db.ddl("CREATE TABLE t(id INTEGER PRIMARY KEY, v INTEGER)");
    await expect(db.ddl("ALTER TABLE t RENAME TO __meta")).rejects.toThrow(/reserved/);
    await expect(db.ddl("CREATE INDEX __cap ON t(id, v)")).rejects.toThrow(/reserved/);
  });
});
