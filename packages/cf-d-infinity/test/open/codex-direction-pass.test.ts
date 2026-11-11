// Codex による計画への反論 (2026-11-10) が挙げた例のうち、再現したもの。正しい挙動を期待して書いてあるので、いまは落ちる。
// どちらも個別には直さない。不変条件の持ち主を作るときに、その仕組みで通るようにする。
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { SimCluster } from "../sim";

describe("invariant 6 (one identity per row): NULL in a declared primary key", () => {
  // SQLite は、INTEGER でない主キーの列に NULL を複数入れられる。主キーの値の文字列では、それらの行を区別できない。
  // 行イメージの適用は主キーで行を名指しするので、別の行を書き換える。受け付けるなら rowid で区別する。受け付けないなら断る。
  it("gives SQLite's result, or refuses the write", async () => {
    const db = new SimCluster({ shards: 2 }).client();
    const lite = new DatabaseSync(":memory:");
    const statements = ["CREATE TABLE k(id TEXT PRIMARY KEY, v)", "INSERT INTO k VALUES (NULL, 1)", "INSERT INTO k VALUES (NULL, 2)",
      "UPDATE k SET v = v + 10 WHERE v = 2", "DELETE FROM k WHERE v = 1"];
    let refused = false;
    for (const s of statements) {
      const ours = await db.query(s).then(() => "ok", (e: Error) => e.message);
      if (/^unsupported:/.test(ours)) {
        refused = true;
        break;
      }
      lite.exec(s);
    }
    if (!refused) {
      expect((await db.query("SELECT id, v FROM k ORDER BY v")).rows).toEqual(lite.prepare("SELECT id, v FROM k ORDER BY v").all().map((r) => ({ ...r })));
    }
  });
});

describe("invariant 5 (internal tables are not addressable): metadata inside a statement sent to a shard", () => {
  // Worker の SQLite には利用者の表しかないが、`pragma_table_info('名前')` や `sqlite_master` は、表がなくてもコンパイルできる。
  // その文をシャードへ送ると、同じ式がシャードの内部の表について答える。
  const setup = async () => {
    const db = new SimCluster({ shards: 2 }).client();
    await db.ddl("CREATE TABLE t(tenant_id INTEGER NOT NULL, id INTEGER NOT NULL, n INTEGER, PRIMARY KEY (tenant_id, id)) SHARD KEY (tenant_id)");
    await db.query("INSERT INTO t VALUES (1, 1, 0)");
    return db;
  };
  it("a read does not see the columns of an internal table", async () => {
    const db = await setup();
    const got = await db.query("SELECT n, (SELECT count(*) FROM pragma_table_info('__txn')) AS cols FROM t WHERE tenant_id = 1 AND id = 1")
      .then((r) => r.rows, (e: Error) => e.message);
    expect(got === undefined || typeof got === "string" || (got as { cols: number }[])[0]!.cols === 0).toBe(true);
  });
  it("a write does not store the number of internal tables", async () => {
    const db = await setup();
    await db.query("UPDATE t SET n = (SELECT count(*) FROM sqlite_master WHERE name LIKE '\\_\\_%' ESCAPE '\\') WHERE tenant_id = 1 AND id = 1").catch(() => undefined);
    expect((await db.query("SELECT n FROM t WHERE tenant_id = 1 AND id = 1")).rows).toEqual([{ n: 0 }]);
  });
});
