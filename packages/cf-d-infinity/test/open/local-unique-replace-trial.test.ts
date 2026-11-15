// 未解決: ある行が UNIQUE の値を、OR REPLACE で消す行から受け取る変更の集まりを、UNIQUE の誤りで断る。
//
// 2 つの形がある。どちらも SQLite は通し、1 シャードでも起きる。
// - 部分 index の UNIQUE もある表への `INSERT OR REPLACE INTO p VALUES (2, 3, 1, 'c', 1)`。主キーで行 (2, 3) と、u = 1 で行 (2, 1) と
//   衝突し、SQLite は 2 つを消して新しい行を入れる。D∞ は、通常の実行では `UNIQUE constraint failed: p.tenant, p.u` (文の時点)、
//   基準経路だけの実行 (REFERENCE=scans、full) では `UNIQUE constraint failed (unique: ...)` で断る。部分 index の UNIQUE のない表では、
//   1 シャードの autocommit でシャードの SQLite が文をそのまま実行するので、起きない。
// - 取引の中で、行 (2, 4) に触れてから、`UPDATE OR REPLACE p SET u = 3 WHERE ... id = 4` で行 (2, 3) の値を取る。COMMIT が
//   `UNIQUE constraint failed (unique: ...)` で断られる (差分の検査の seed 533 の形)。先に (2, 4) に触れなければ通る。2 つの UPDATE で
//   値を受け渡す取引 (REPLACE なし) は、触れる順に依らず通る。
// `(unique: ...)` の誤りは、取引の確定の確かめ (src/client/db.ts の Txn.commit が、シャードの答えの reason から作る) のものである。
// 見立て (確かめていない): シャードは、取引の変更を、取引が溜めた順に 1 行ずつ本体に当てて確かめる (src/shard/kernel.ts の checkUnique
// などの試適用)。値を受け取る行の変更が、REPLACE で消える行の変更より先に当たると、物理の UNIQUE index が一時的な重複を断る。
//
// 見つけたのは、UNIQUE の文の差分の検査 (test/unique-diff.ts、docs/design-unique-keys.md の段 0 の (c)、2026-11-15。sim の掃引の
// seed 430 と 533)。不変条件は 2 (確定した取引は必ず適用できる) の手前で、SQLite が通す取引を、変更の当て方が断る形である。持ち主は、
// シャードが変更の集まりを物理の UNIQUE index のある表に当てる所である。設計の「刷新案からのずれ」の 6 (物理の index は一意であっては
// ならない、M22 の m22_red_physical_unique) と同じ種類で、piece の移動がなくても、1 つの取引で起きる。段 3 で物理の index を一意で
// なくし、試適用を消すと、起きなくなる見込みである。
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { SimCluster } from "../sim";

const P = "CREATE TABLE p(tenant INTEGER NOT NULL, id INTEGER NOT NULL, u INTEGER, code TEXT, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (tenant, id), UNIQUE (tenant, u))";
const PARTIAL = "CREATE UNIQUE INDEX p_code ON p(tenant, code) WHERE n > 0";

async function same(ddl: string[], statements: string[]) {
  for (const shards of [1, 3]) {
    const db = new SimCluster({ shards }).client();
    const lite = new DatabaseSync(":memory:");
    for (const d of ddl) {
      await db.ddl(d);
      lite.exec(d);
    }
    for (const sql of [...statements, "SELECT tenant, id, u, code, n FROM p ORDER BY tenant, id"]) {
      const sqlite = (() => {
        try {
          const st = lite.prepare(sql);
          return st.columns().length ? JSON.stringify(st.all().map((r) => Object.values(r))) : `changes ${st.run().changes}`;
        } catch (e) {
          return `ERROR ${(e as Error).message}`;
        }
      })();
      const ours = await db.query(sql).then((r) => (r.columns.length ? JSON.stringify(r.values.map((v) => v.map((x) => (typeof x === "bigint" ? Number(x) : x)))) : `changes ${r.changes}`), (e: Error) => `ERROR ${e.message}`);
      // BEGIN と COMMIT の changes は、node:sqlite では前の文の数が残る。比べない。
      const plain = (x: string) => (/^(BEGIN|COMMIT)$/.test(sql) && x.startsWith("changes") ? "ok" : x);
      expect({ sql, shards, ours: plain(ours) }).toEqual({ sql, shards, ours: plain(sqlite) });
    }
  }
}

describe("a change set in which a row takes the UNIQUE value of a row that OR REPLACE deletes", () => {
  it("OR REPLACE on a table with a partial UNIQUE replaces the rows it conflicts with", async () => {
    await same([P, PARTIAL], [
      "INSERT INTO p VALUES (2, 1, 1, 'a', 1), (2, 3, 3, 'c', 1)",
      "INSERT OR REPLACE INTO p VALUES (2, 3, 1, 'c', 1)",
    ]);
  });

  it("UPDATE OR REPLACE in a transaction commits", async () => {
    // 差分の検査の seed 533 の形 (RTRIM の UNIQUE の表) を、照合順序のない表にしたもの。部分 index は要らない。
    await same([P], [
      "INSERT INTO p VALUES (2, 3, 3, 'c', 0), (2, 4, 4, 'd', 0)",
      "BEGIN",
      "UPDATE p SET n = 1 WHERE tenant = 2 AND id = 4",
      "UPDATE OR REPLACE p SET u = 3 WHERE tenant = 2 AND id = 4",
      "COMMIT",
    ]);
  });
});
