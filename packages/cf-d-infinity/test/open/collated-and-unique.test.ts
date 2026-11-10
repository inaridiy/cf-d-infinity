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
