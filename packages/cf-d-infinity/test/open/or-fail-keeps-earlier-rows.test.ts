// 未解決: OR FAIL の複数行の文が制約に当たると、当たった行より前の行の変更まで取り消す (OR ABORT と同じになる)。
//
// SQLite の OR FAIL は、制約に当たった行で文を止めて誤りを返すが、それまでの行の変更は残す (取り消さない)。D∞ は、文の変更を全部
// 取り消す。UNIQUE のない表の主キーの衝突でも起き、シャードの数に依らない (1 シャードでも同じ)。
//
// 見つけたのは、UNIQUE の文の差分の検査 (test/unique-diff.ts、docs/design-unique-keys.md の段 0 の (c)、2026-11-15。seed 15)。
// 差分の検査は、誤りで終わった書き込みの後の表の中身も比べる (OR FAIL があるので)。
// 不変条件は、計画書の規則 4 (SQLite と同じ答えか、文の形で断るか)、持ち主は文の計画と実行 (src/sql/plan.ts と、文の原子性を作る
// 所。シャードの SAVEPOINT と Worker の SQLite の src/sql/scratch.ts) である。直し方は 2 通りある。OR FAIL を文の形で断るか、
// 衝突したら基準経路で SQLite に決めさせ、残った変更を書く。
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { SimCluster } from "../sim";

async function same(ddl: string, statements: string[], read: string, shards: number) {
  const db = new SimCluster({ shards }).client();
  const lite = new DatabaseSync(":memory:");
  await db.ddl(ddl);
  lite.exec(ddl);
  for (const sql of [...statements, read]) {
    const sqlite = (() => {
      try {
        const st = lite.prepare(sql);
        return st.columns().length ? JSON.stringify(st.all().map((r) => Object.values(r))) : `changes ${st.run().changes}`;
      } catch (e) {
        return `ERROR ${(e as Error).message}`;
      }
    })();
    const ours = await db.query(sql).then((r) => (r.columns.length ? JSON.stringify(r.values.map((v) => v.map((x) => (typeof x === "bigint" ? Number(x) : x)))) : `changes ${r.changes}`), (e: Error) => `ERROR ${e.message}`);
    expect({ sql, shards, ours }).toEqual({ sql, shards, ours: sqlite });
  }
}

describe("a multi-row statement with OR FAIL that meets a conflict", () => {
  it("keeps the rows it inserted before the conflict", async () => {
    for (const shards of [1, 3]) {
      await same("CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)", [
        "INSERT INTO t VALUES (1, 'a'), (2, 'b')",
        "INSERT OR FAIL INTO t VALUES (10, 'x'), (11, 'y'), (1, 'z'), (12, 'w')",
      ], "SELECT id, v FROM t ORDER BY id", shards);
    }
  });

  it("keeps the rows it inserted before a UNIQUE conflict", async () => {
    for (const shards of [1, 3]) {
      await same("CREATE TABLE p(tenant INTEGER NOT NULL, id INTEGER NOT NULL, u INTEGER, PRIMARY KEY (tenant, id), UNIQUE (tenant, u))", [
        "INSERT INTO p VALUES (1, 1, 1), (1, 2, 2)",
        "INSERT OR FAIL INTO p VALUES (1, 10, 10), (1, 11, 2), (1, 12, 12)",
      ], "SELECT tenant, id, u FROM p ORDER BY tenant, id", shards);
    }
  });
});
