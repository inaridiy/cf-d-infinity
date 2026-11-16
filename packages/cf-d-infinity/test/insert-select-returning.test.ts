// 直した (計画書の未解決の問題 40): INSERT … SELECT … RETURNING が、行を返さない。
//
// Worker は INSERT … SELECT を、SELECT を読んでから、読んだ行を引数にした INSERT … VALUES に分けて実行する (src/client/db.ts の
// Txn.insertSelect)。分けた文は RETURNING を持って実行されるが、その結果を捨て、行のない結果を返す。SQLite は、入れた行を返す。
// 答えが SQLite と違う (計画書の不変条件 11 の、文の答えが SQLite と同じであること)。行の置き場所には依らない。
// 見つけたのは、値の作り直しの段 3 で、利用者の RETURNING を書き換える経路を読んでいたとき (2026-11-15)。段 3 より前からある。
//
// 直し方 (2026-11-16): 分けた文の結果を 1 つの文の結果にまとめる (Txn.insertSelect)。RETURNING の行をつなぎ、列名は元の文から取る。
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { Db } from "../src/client/db";
import { SimCluster } from "./sim";

describe("INSERT … SELECT … RETURNING", () => {
  for (const shards of [1, 2]) {
    it(`returns the inserted rows, as SQLite does, on ${shards} shard(s)`, async () => {
      const db = new Db(new SimCluster({ shards }));
      const lite = new DatabaseSync(":memory:");
      for (const s of ["CREATE TABLE a(id INTEGER PRIMARY KEY, v TEXT)", "CREATE TABLE b(id INTEGER PRIMARY KEY, v TEXT)"]) {
        await db.ddl(s);
        lite.exec(s);
      }
      await db.query("INSERT INTO a VALUES (1, 'x'), (2, 'y')");
      lite.exec("INSERT INTO a VALUES (1, 'x'), (2, 'y')");
      const sql = "INSERT INTO b(id, v) SELECT id + 10, v FROM a ORDER BY id RETURNING id, v";
      const want = lite.prepare(sql).all().map((r) => ({ ...r }));
      expect(want).toEqual([{ id: 11, v: "x" }, { id: 12, v: "y" }]);
      expect((await db.query(sql)).rows).toEqual(want);
    });
  }
});
