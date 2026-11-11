// 取引の中で失敗した文も、状態を読んでいる。「同じ主キーの行があるので INSERT できない」は、その行があったという観測である。
// その観測を commit で検証しないと、別の取引が行を消して先に確定しても、行があったことにしたまま確定できる。
// 文の再生の検査 (test/replay.test.ts) が、文の形と並行の掛け合わせから見つけた。ここは、その最小の台本である。
import { describe, expect, it } from "vitest";
import { Db } from "../src/client/db";
import { quiescentProblems } from "./invariants";
import { SimCluster } from "./sim";

const T = `CREATE TABLE t(tenant_id INTEGER NOT NULL, id INTEGER NOT NULL, code TEXT, n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, id), UNIQUE (tenant_id, code)) SHARD KEY (tenant_id)`;

describe("a statement that failed inside a transaction", () => {
  for (const [name, failing, undo] of [
    ["a primary-key conflict", "INSERT INTO t(tenant_id, id, code) VALUES (1, 1, 'new')", "DELETE FROM t WHERE tenant_id = 1 AND id = 1"],
    ["a UNIQUE conflict", "INSERT INTO t(tenant_id, id, code) VALUES (1, 9, 'a')", "UPDATE t SET code = 'other' WHERE tenant_id = 1 AND id = 1"],
  ] as const) {
    for (const mode of ["BEGIN", "BEGIN IMMEDIATE"]) {
      it(`${name} (${mode}): the transaction does not commit after another one removed what made the statement fail`, async () => {
        const c = new SimCluster({ shards: 2 });
        const db = c.client();
        await db.ddl(T);
        await db.query("INSERT INTO t(tenant_id, id, code) VALUES (1, 1, 'a'), (1, 2, 'b')");
        const a = new Db(c, { retries: 0 });
        await a.query(mode);
        await expect(a.query(failing)).rejects.toThrow(/UNIQUE constraint failed/);
        // 失敗の原因だった行を、別の接続が消す (または値を変える)。
        await new Db(c).query(undo);
        await a.query("UPDATE t SET n = n + 1 WHERE tenant_id = 1 AND id = 2");
        // a が確定するなら、「原因の行があった」時点と「別の接続が消した後」の両方を見たことになり、どの順序にも並べられない。
        await expect(a.query("COMMIT")).rejects.toThrow(/conflict/);
        expect((await new Db(c).query("SELECT n FROM t WHERE tenant_id = 1 AND id = 2")).rows).toEqual([{ n: 0 }]);
        expect(await quiescentProblems(c)).toEqual([]);
      });
    }
  }

  it("still commits when nothing it read has changed", async () => {
    const c = new SimCluster({ shards: 2 });
    const db = c.client();
    await db.ddl(T);
    await db.query("INSERT INTO t(tenant_id, id, code) VALUES (1, 1, 'a'), (1, 2, 'b')");
    const a = new Db(c, { retries: 0 });
    await a.query("BEGIN");
    await expect(a.query("INSERT INTO t(tenant_id, id, code) VALUES (1, 1, 'new')")).rejects.toThrow(/UNIQUE constraint failed/);
    await a.query("UPDATE t SET n = n + 1 WHERE tenant_id = 1 AND id = 2");
    // 関係のない行への書き込みは、競合にならない。
    await new Db(c).query("INSERT INTO t(tenant_id, id, code) VALUES (2, 1, 'a')");
    await a.query("COMMIT");
    expect((await new Db(c).query("SELECT n FROM t WHERE tenant_id = 1 AND id = 2")).rows).toEqual([{ n: 1 }]);
  });
});
