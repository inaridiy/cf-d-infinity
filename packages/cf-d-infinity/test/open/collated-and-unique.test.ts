// Review of f2224ce, fixes 2, 4 and 5. Each test asserts the correct behaviour (what SQLite does) and fails today.
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { Db } from "../../src/client/db";
import { ownerOf } from "../../src/routing";
import { quiescentProblems } from "../invariants";
import { SimCluster } from "../sim";

const outcome = async <T>(p: Promise<T>) => p.then((v) => ({ ok: v as unknown }), (e: Error) => ({ err: e.message }));

function sqlite(stmts: string[], final: string): unknown {
  const db = new DatabaseSync(":memory:");
  for (const s of stmts) db.exec(s);
  return db.prepare(final).all().map((r) => ({ ...r }));
}

describe("NOCASE primary key: statements that change only the letter case of the key", () => {
  const DDL = "CREATE TABLE acct(name TEXT COLLATE NOCASE PRIMARY KEY, n INTEGER)";
  const SEED = "INSERT INTO acct VALUES ('abc', 1)";
  const READ = "SELECT name, n FROM acct ORDER BY name";
  for (const [label, stmt] of [
    ["UPDATE of the key to another case", "UPDATE acct SET name = 'ABC' WHERE name = 'abc'"],
    ["UPDATE of the key and a column", "UPDATE acct SET name = 'ABC', n = 2 WHERE name = 'abc'"],
    ["INSERT OR REPLACE with another case", "INSERT OR REPLACE INTO acct VALUES ('ABC', 2)"],
    ["REPLACE with another case", "REPLACE INTO acct VALUES ('ABC', 2)"],
    ["UPSERT that rewrites the key", "INSERT INTO acct VALUES ('ABC', 2) ON CONFLICT(name) DO UPDATE SET name = excluded.name, n = excluded.n"],
  ] as const) {
    for (const mode of ["autocommit", "transaction"] as const) {
      it(`${label} (${mode}) gives SQLite's result`, async () => {
        const want = sqlite([DDL, SEED, stmt], READ);
        const c = new SimCluster({ shards: 2 });
        const db = c.client();
        await db.ddl(DDL);
        await db.query(SEED);
        let run: unknown;
        if (mode === "autocommit") run = await outcome(db.query(stmt));
        else {
          run = await outcome((async () => {
            await db.query("BEGIN");
            try {
              await db.query(stmt);
              await db.query("COMMIT");
            } catch (e) {
              if (db.inTransaction) await db.query("ROLLBACK");
              throw e;
            }
          })());
        }
        const got = await outcome(new Db(c).query(READ).then((r) => r.rows));
        const problems = await quiescentProblems(c);
        console.log(JSON.stringify({ label, mode, run: (run as { err?: string }).err ?? "ok", got, want }));
        expect(got).toEqual({ ok: want });
        expect(problems).toEqual([]);
      });
    }
  }
});

describe("a statement that reads another row through a local UNIQUE index", () => {
  // The span of a single-row INSERT / pk UPDATE is that primary key. The UNIQUE check reads the row that holds the
  // value, which has another primary key, so a committed-but-unapplied change of that row is not settled first.
  const setup = async () => {
    const c = new SimCluster({ shards: 2 });
    const db = c.client();
    await db.ddl(`CREATE TABLE p(tenant_id INTEGER NOT NULL, id INTEGER NOT NULL, code TEXT, PRIMARY KEY (tenant_id, id), UNIQUE (tenant_id, code)) SHARD KEY (tenant_id)`);
    const { routing } = await c.catalog();
    const on = (s: string) => { for (let t = 1; ; t++) if (ownerOf(routing, JSON.stringify([t])) === s) return t; };
    const [A, B] = [on("s1"), on("s0")];
    for (const t of [A, B]) await db.query("INSERT INTO p VALUES (?, 1, 'x')", [t]);
    await db.query("INSERT INTO p VALUES (?, 2, 'y')", [A]);
    // X deletes the holder of 'x' on both shards; s0 is the anchor; the finalize to s1 is delayed. X is acknowledged.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    c.net.gate = (m) => (m.method === "finalize" && m.to === "s1" ? held : undefined);
    const x = await new Db(c).begin();
    await x.query("SELECT code FROM p WHERE tenant_id = ?", [B]);
    for (const t of [A, B]) await x.query("DELETE FROM p WHERE tenant_id = ? AND id = 1", [t]);
    await x.commit();
    expect(c.net.log.some((m) => m.method === "prepare" && m.from === "s0" && m.to === "s1")).toBe(true);
    const done = async () => {
      c.net.gate = () => undefined;
      release();
      await c.settle();
    };
    return { c, A, done };
  };

  it("INSERT of a value freed by an acknowledged DELETE succeeds", async () => {
    const { c, A, done } = await setup();
    const ins = await outcome(new Db(c, { retries: 3 }).query("INSERT INTO p VALUES (?, 3, 'x')", [A]));
    await done();
    console.log(JSON.stringify({ ins }));
    expect(ins).toHaveProperty("ok");
  });

  it("UPDATE to a value freed by an acknowledged DELETE succeeds", async () => {
    const { c, A, done } = await setup();
    const upd = await outcome(new Db(c, { retries: 3 }).query("UPDATE p SET code = 'x' WHERE tenant_id = ? AND id = 2", [A]));
    await done();
    console.log(JSON.stringify({ upd }));
    expect(upd).toHaveProperty("ok");
  });

  it("INSERT OR IGNORE of a value freed by an acknowledged DELETE inserts the row", async () => {
    const { c, A, done } = await setup();
    const ins = await outcome(new Db(c, { retries: 3 }).query("INSERT OR IGNORE INTO p VALUES (?, 3, 'x')", [A]).then((r) => r.changes));
    await done();
    const rows = await new Db(c).query("SELECT id, code FROM p WHERE tenant_id = ? ORDER BY id", [A]).then((r) => r.rows);
    console.log(JSON.stringify({ ins, rows }));
    expect(ins).toEqual({ ok: 1 });
    expect(rows).toEqual([{ id: 2, code: "y" }, { id: 3, code: "x" }]);
  });

  it("the same inside a transaction", async () => {
    const { c, A, done } = await setup();
    const db = new Db(c, { retries: 3 });
    const ins = await outcome(db.transaction((tx) => tx.query("INSERT OR IGNORE INTO p VALUES (?, 3, 'x')", [A]).then((r) => r.changes)));
    await done();
    console.log(JSON.stringify({ ins }));
    expect(ins).toEqual({ ok: 1 });
  });
});

describe("INSERT ... VALUES with `x IN table`", () => {
  it("reads the whole table, not only the rows on the shard that receives the row", async () => {
    const c = new SimCluster({ shards: 2 });
    const db = c.client();
    await db.ddl("CREATE TABLE allowed(id INTEGER PRIMARY KEY)");
    await db.ddl("CREATE TABLE t(id INTEGER PRIMARY KEY, ok INTEGER)");
    const { routing } = await c.catalog();
    const on = (s: string) => { for (let t = 1; ; t++) if (ownerOf(routing, JSON.stringify([t])) === s) return t; };
    const [a, b] = [on("s0"), on("s1")];
    await db.query("INSERT INTO allowed VALUES (?)", [a]); // lives on s0
    await db.query("INSERT INTO t VALUES (?, ? IN allowed)", [b, a]); // row goes to s1
    const got = await db.query("SELECT ok FROM t WHERE id = ?", [b]).then((r) => r.rows);
    console.log(JSON.stringify({ got }));
    expect(got).toEqual([{ ok: 1 }]);
  });
});
