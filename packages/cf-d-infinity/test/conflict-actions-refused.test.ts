// 衝突の処理のうち、文の形と表定義で断るもの (計画書の不変条件 14: 衝突の処理は SQLite だけが決め、D∞ はその結果を運ぶ)。
// 2026-11-15 に、UNIQUE の文の差分の検査 (test/unique-diff.ts) が、どれも SQLite と違う答えを見つけた。
// - 文の OR FAIL: 衝突した行より前の行の変更を、D∞ は文ごと取り消していた (SQLite は残す)。
// - 文の OR ROLLBACK: DO の SQLite では DO の savepoint を壊し、内部の誤りになった。取引の中では取引が終わらなかった。
// - 制約に書いた ON CONFLICT (ABORT 以外): D∞ は記録せず、文の既定として効かせていなかった。
// 断るのは形で決まり、行の置き場所には依らない (AGENTS.md の規則 4)。文に書く OR IGNORE、OR REPLACE、REPLACE、ON CONFLICT DO は使える。
import { describe, expect, it } from "vitest";
import { Db } from "../src/client/db";
import { SimCluster } from "./sim";

const outcome = (p: Promise<unknown>) => p.then(() => "ok", (e: Error) => e.message);

describe("conflict actions that D∞ refuses by shape", () => {
  it("refuses OR FAIL and OR ROLLBACK in INSERT and UPDATE, on any number of shards, and leaves the rows as they were", async () => {
    for (const shards of [1, 2, 4]) {
      const c = new SimCluster({ shards });
      const db = new Db(c);
      await db.ddl("CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)");
      await db.query("INSERT INTO t VALUES (1, 'a'), (2, 'b')");
      for (const sql of [
        "INSERT OR FAIL INTO t VALUES (3, 'c'), (1, 'x')",
        "INSERT OR ROLLBACK INTO t VALUES (3, 'c'), (1, 'x')",
        "UPDATE OR FAIL t SET id = 2 WHERE id = 1",
        "UPDATE OR ROLLBACK t SET v = 'z'",
      ]) {
        expect({ shards, sql, got: await outcome(db.query(sql)) }).toEqual({ shards, sql, got: expect.stringMatching(/^unsupported: (INSERT|UPDATE) OR (FAIL|ROLLBACK); /) });
      }
      // 断った文は何も書かない。OR ABORT と OR IGNORE は使える。
      expect(await outcome(db.query("INSERT OR ABORT INTO t VALUES (1, 'x')"))).toMatch(/UNIQUE constraint failed/);
      await db.query("INSERT OR IGNORE INTO t VALUES (1, 'x'), (3, 'c')");
      expect((await db.query("SELECT id, v FROM t ORDER BY id")).rows).toEqual([{ id: 1, v: "a" }, { id: 2, v: "b" }, { id: 3, v: "c" }]);
    }
  });

  it("refuses OR FAIL inside a transaction without ending the transaction", async () => {
    const c = new SimCluster({ shards: 2 });
    const db = new Db(c);
    await db.ddl("CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)");
    const tx = await db.begin();
    await tx.query("INSERT INTO t VALUES (1, 'a')");
    expect(await outcome(tx.query("INSERT OR ROLLBACK INTO t VALUES (2, 'b')"))).toMatch(/^unsupported: INSERT OR ROLLBACK; /);
    await tx.query("INSERT INTO t VALUES (3, 'c')");
    await tx.commit();
    expect((await db.query("SELECT id FROM t ORDER BY id")).rows).toEqual([{ id: 1 }, { id: 3 }]);
  });

  it("refuses an ON CONFLICT clause other than ABORT on a constraint, from both entry points", async () => {
    const c = new SimCluster({ shards: 2 });
    const db = new Db(c);
    for (const sql of [
      "CREATE TABLE a(id INTEGER PRIMARY KEY, email TEXT, UNIQUE (email) ON CONFLICT REPLACE)",
      "CREATE TABLE b(id INTEGER PRIMARY KEY, email TEXT UNIQUE ON CONFLICT IGNORE)",
      "CREATE TABLE c(id INTEGER PRIMARY KEY ON CONFLICT REPLACE, v TEXT)",
      "CREATE TABLE d(id INTEGER PRIMARY KEY, v TEXT NOT NULL ON CONFLICT FAIL)",
    ]) {
      expect(await outcome(db.ddl(sql))).toMatch(/^unsupported: ON CONFLICT (REPLACE|IGNORE|FAIL) on a constraint; /);
      expect(await outcome(db.query(sql))).toMatch(/^unsupported: ON CONFLICT (REPLACE|IGNORE|FAIL) on a constraint; /);
    }
    // ABORT は既定と同じなので、書いても受け付ける。
    await db.ddl("CREATE TABLE e(id INTEGER PRIMARY KEY, email TEXT UNIQUE ON CONFLICT ABORT)");
    await db.ddl("CREATE TABLE f(id INTEGER PRIMARY KEY)");
    expect(await outcome(db.ddl("ALTER TABLE f ADD COLUMN v TEXT NOT NULL ON CONFLICT REPLACE DEFAULT 'x'"))).toMatch(/^unsupported: ON CONFLICT REPLACE on a constraint; /);
    expect(Object.keys((await c.catalog()).tables).filter((t) => !t.startsWith("__")).sort()).toEqual(["e", "f"]);
  });
});
