// 取引の中で表を作り直すとき、別の接続が古い表へ書いた行を失わない (specs/m14_rebuild_guard.qnt)。
//
// 表を作り直す移行は、新しい表を作り、古い表の行を写し、古い表を消し、名前を変える。DDL の前に取引を確定するので
// (specs/m13_txn_schema_boundary.qnt)、行を写した区切りの確定と、古い表の DROP の間に、古い表を守るものがない。
// いまは、取引が読んだ表を DROP するとき、その表を書き込み禁止にしてから、読んだ後に変更がないかを全シャードで確かめる。
// 変更があれば、DROP せずに競合として失敗する。行は失われず、移行が失敗する。
//
// どの試験も、DROP の前の書き込み禁止 (または、守りを外したときは DROP そのもの) の版がシャードへ届くのを止め、
// その間に別の接続が古い表へ 1 行書く。
import { drizzle as drizzleD1 } from "drizzle-orm/d1";
import { migrate as migrateD1 } from "drizzle-orm/d1/migrator";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { describe, expect, it } from "vitest";
import { drizzleMigrationsTable } from "../src/binding";
import { D1Compatible } from "../src/client/d1";
import { Db, type ClientFaults } from "../src/client/db";
import type { Catalog } from "../src/meta";
import { ADD, INIT, REBUILD, migrations } from "./drizzle-fixtures";
import { clientOf } from "./libsql";
import { SimCluster } from "./sim";

const outcome = (p: Promise<unknown>) => p.then(() => "ok", (e: Error) => e.message);

/**
 * 版 version がシャードへ届くのを止める。止めている間に write を流し、それから届ける。
 * capture を渡すと、その版がシャードへ届くときの表定義を取っておき、write に渡す。書き込む側が、書き込み禁止の 1 つ前の版を持つためである。
 * 新しい表定義を取りに行くと、その要求が、書き込み禁止の版をシャードに適用させてしまう。
 */
function writeWhileHeld(c: SimCluster, version: number, write: (cat?: Catalog) => Promise<unknown>, capture?: number): Promise<string> {
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let reached!: () => void;
  const hit = new Promise<void>((r) => (reached = r));
  let snapshot: Promise<Catalog> | undefined;
  c.net.gate = (m) => {
    if (m.method !== "syncSchema") return undefined;
    const v = (m.req as { version: number }).version;
    if (v === capture) snapshot ??= c.catalog();
    if (v !== version) return undefined;
    reached();
    return held;
  };
  return hit.then(async () => {
    const r = await outcome(write(await snapshot));
    release();
    c.net.gate = () => undefined;
    return r;
  });
}

const RESULT = (c: SimCluster, sql: string) => new Db(c).query(sql).then((r) => r.rows, (e: Error) => e.message);

describe("a transaction that rebuilds a table another connection writes to", () => {
  const rebuild = async (faults?: ClientFaults) => {
    const c = new SimCluster({ shards: 2 });
    await new Db(c).ddl("CREATE TABLE t(id INTEGER PRIMARY KEY, v INTEGER)");
    await new Db(c).query("INSERT INTO t VALUES (1, 1), (2, 2), (3, 3)");
    const db = new Db(c, { faults });
    await db.query("BEGIN");
    await db.query("CREATE TABLE __new_t(id INTEGER PRIMARY KEY, v INTEGER, w INTEGER)");
    await db.query("INSERT INTO __new_t(id, v) SELECT id, v FROM t");
    // 別の接続は、DROP の前の、いまの表定義を持っている。
    const other = new Db(c);
    await other.query("SELECT count(*) FROM t");
    const next = (await c.catalog()).version + 1;
    const written = writeWhileHeld(c, next, () => other.query("INSERT INTO t VALUES (4, 4)"));
    const drop = await outcome(db.query("DROP TABLE t"));
    const rename = drop === "ok" ? await outcome(db.query("ALTER TABLE __new_t RENAME TO t")) : "skipped";
    await outcome(db.query(drop === "ok" ? "COMMIT" : "ROLLBACK"));
    return { written: await written, drop, rename, rows: await RESULT(c, "SELECT id FROM t ORDER BY id") };
  };

  it("does not drop the table, and keeps the row the other connection wrote", async () => {
    const r = await rebuild();
    expect(r.written).toBe("ok");
    expect(r.drop).toMatch(/^conflict: another connection wrote to t after this transaction read it/);
    expect(r.rows).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }]);
  });

  it("put back: without the guard, the table is dropped and the row is lost", async () => {
    const r = await rebuild({ dropWithoutGuard: true });
    expect({ written: r.written, drop: r.drop, rename: r.rename }).toEqual({ written: "ok", drop: "ok", rename: "ok" });
    expect(r.rows).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
  });

  it("drops the table when nobody wrote to it", async () => {
    const c = new SimCluster({ shards: 2 });
    await new Db(c).ddl("CREATE TABLE t(id INTEGER PRIMARY KEY, v INTEGER)");
    await new Db(c).query("INSERT INTO t VALUES (1, 1), (2, 2)");
    const db = new Db(c);
    for (const s of ["BEGIN", "CREATE TABLE __new_t(id INTEGER PRIMARY KEY, v INTEGER, w INTEGER)", "INSERT INTO __new_t(id, v) SELECT id, v FROM t",
      "DROP TABLE t", "ALTER TABLE __new_t RENAME TO t", "COMMIT"]) {
      expect(await outcome(db.query(s))).toBe("ok");
    }
    expect(await RESULT(c, "SELECT id, v, w FROM t ORDER BY id")).toEqual([{ id: 1, v: 1, w: null }, { id: 2, v: 2, w: null }]);
    // 書き込み禁止を掛けた版と、それを終えた DROP の版がある。
    expect((await c.meta.ddlSince(0)).ddl.filter((e) => e.guard).map((e) => e.guard!.tables)).toEqual([["t"]]);
  });
});

describe("the guard, through other ways of running the same statements", () => {
  const setup = async () => {
    const c = new SimCluster({ shards: 2 });
    await new Db(c).ddl("CREATE TABLE t(id INTEGER PRIMARY KEY, v INTEGER)");
    await new Db(c).query("INSERT INTO t VALUES (1, 1), (2, 2), (3, 3)");
    const other = new Db(c);
    await other.query("SELECT count(*) FROM t");
    return { c, other };
  };

  it("holds for a D1 batch", async () => {
    const { c } = await setup();
    const d1 = new D1Compatible(new Db(c));
    await d1.prepare("CREATE TABLE __new_t(id INTEGER PRIMARY KEY, v INTEGER)").run();
    // 別の接続は、いまの表定義を持っている。新しい表定義を取りに行くと、その要求が書き込み禁止の版をシャードに適用させてしまう。
    const other = new Db(c);
    await other.query("SELECT count(*) FROM t");
    const next = (await c.catalog()).version + 1;
    const written = writeWhileHeld(c, next, () => other.query("INSERT INTO t VALUES (4, 4)"));
    const r = await outcome(d1.batch([
      d1.prepare("INSERT INTO __new_t SELECT id, v FROM t"), d1.prepare("DROP TABLE t"), d1.prepare("ALTER TABLE __new_t RENAME TO t"),
    ]));
    expect(await written).toBe("ok");
    expect(r).toMatch(/^conflict: another connection wrote to t/);
    expect(await RESULT(c, "SELECT id FROM t ORDER BY id")).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }]);
  });

  it("holds for an interactive libSQL transaction that read the table in an earlier part", async () => {
    const { c, other } = await setup();
    const client = clientOf(c);
    const tx = await client.transaction("write");
    await tx.execute("CREATE TABLE __new_t(id INTEGER PRIMARY KEY, v INTEGER)");
    await tx.execute("INSERT INTO __new_t SELECT id, v FROM t");
    // DDL がもう 1 つ挟まる。行を写した区切りは、ここで確定する。読んだ範囲は、要求をまたいで運ばれる。
    await tx.execute("CREATE INDEX __new_t_v ON __new_t(v)");
    await other.query("INSERT INTO t VALUES (4, 4)");
    const drop = await outcome(tx.execute("DROP TABLE t"));
    await tx.rollback();
    expect(drop).toMatch(/another connection wrote to t/);
    expect(await RESULT(c, "SELECT id FROM t ORDER BY id")).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }]);
  });
});

describe("a Drizzle migration that rebuilds a table while the application writes to it", () => {
  const seeded = async () => {
    const c = new SimCluster({ shards: 2 });
    const client = clientOf(c);
    await client.execute(drizzleMigrationsTable());
    expect(await outcome(migrate(drizzle(client), { migrationsFolder: migrations([INIT, ADD]) }))).toBe("ok");
    await client.execute("INSERT INTO users(id, email, name, age) VALUES (1, 'a@x', 'A', 30), (2, 'b@x', NULL, 40)");
    // 作り直しの移行は、PRAGMA、新しい表の作成 (+1)、行を写す、古い表の DROP の前の書き込み禁止 (+2) の順に進む。
    // アプリは、新しい表を作った版の表定義を持って書く (capture)。
    const v = (await c.catalog()).version;
    const app = (cat?: Catalog) => new Db(c, { catalog: cat }).query("INSERT INTO users(id, email, name) VALUES (3, 'c@x', 'C')");
    return { c, client, app, lock: v + 2, capture: v + 1 };
  };
  const users = (c: SimCluster) => RESULT(c, "SELECT id, email FROM users ORDER BY id");

  it("fails instead of losing the row, through the libSQL driver", async () => {
    const { c, client, app, lock, capture } = await seeded();
    const written = writeWhileHeld(c, lock, app, capture);
    const r = await outcome(migrate(drizzle(client), { migrationsFolder: migrations([INIT, ADD, REBUILD]) }));
    expect(await written).toBe("ok");
    expect(r).toMatch(/another connection wrote to users/);
    expect(await users(c)).toEqual([{ id: 1, email: "a@x" }, { id: 2, email: "b@x" }, { id: 3, email: "c@x" }]);
  });

  it("fails instead of losing the row, through the D1 driver", async () => {
    const { c, app, lock, capture } = await seeded();
    const d1 = new D1Compatible(new Db(c));
    const written = writeWhileHeld(c, lock, app, capture);
    const r = await outcome(migrateD1(drizzleD1(d1 as never), { migrationsFolder: migrations([INIT, ADD, REBUILD]) }));
    expect(await written).toBe("ok");
    expect(r).toMatch(/another connection wrote to users/);
    expect(await users(c)).toEqual([{ id: 1, email: "a@x" }, { id: 2, email: "b@x" }, { id: 3, email: "c@x" }]);
  });
});

describe("a write to a table locked by a schema change", () => {
  it("waits once for the lock, and then returns the retryable error", async () => {
    // 禁止を掛けた側は延長しないので、期限を長くしておく。
    const c = new SimCluster({ shards: 2, leaseMs: 120_000 });
    await new Db(c).ddl("CREATE TABLE t(id INTEGER PRIMARY KEY, v INTEGER)");
    await c.lockTables(["t"]);
    const t0 = c.time;
    const r = await outcome(new Db(c).query("INSERT INTO t VALUES (1, 1)"));
    expect(r).toMatch(/^conflict: locked: table t is being changed by a schema change/);
    // 待つのは 1 度だけである。やり直すたびに待つと、文がいつまでも返らない。
    expect(c.time - t0).toBeGreaterThanOrEqual(30_000);
    expect(c.time - t0).toBeLessThan(40_000);
  });
});
