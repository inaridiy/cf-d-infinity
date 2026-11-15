// 未解決: OR ROLLBACK の文が衝突したときの答えが、SQLite と違う。
//
// SQLite では、`INSERT OR ROLLBACK` と `UPDATE OR ROLLBACK` が制約に当たると、取引を丸ごと巻き戻し、文は誤りになる。autocommit では
// OR ABORT と同じで、取引の中では、取引が終わる (後の COMMIT は `cannot commit - no transaction is active` になる)。
// - autocommit: シャードは文を自分の SAVEPOINT の中で実行する (シミュレータの SqliteBackend.tx、DO の transactionSync)。OR ROLLBACK が
//   SQLite の取引を丸ごと巻き戻すので、SAVEPOINT が消え、`no such savepoint: sp0` で落ちる (1 シャードでも、シャードをまたぐ UNIQUE でも)。
//   手元の workerd の DO でも同じで、transactionSync の SAVEPOINT (`_cf_sync_savepoint_0`) が消え、利用者には `internal error` が返る
//   (2026-11-15 に、D∞ の Worker の bundle を Miniflare で動かして確かめた。DO はその後も動き、/admin/status は問題を報告しない)。
//   基準経路だけの実行 (REFERENCE=scans、full) では、Worker の SQLite が文を実行するので、SQLite と同じ誤りになる。
// - 取引の中 (SQL の BEGIN): 文は SQLite と同じ誤りを返すか (シャードをまたぐ UNIQUE)、`no such savepoint` で落ちる (シャードの中の
//   UNIQUE)。どちらでも取引は終わらず、前の文の書き込みは残り、COMMIT で確定する。基準経路だけの実行でも同じである。
//
// 見つけたのは、UNIQUE の文の差分の検査 (test/unique-diff.ts、docs/design-unique-keys.md の段 0 の (c)、2026-11-15。seed 2、3、6、8、31 ほか)。
// 計画書の番号のついた不変条件には当たらない (どの置き場所でも同じに起きる。取引の中の形は 9 の「書いた順に効く」に近い)。衝突の処理の
// 欠陥のまとまり (設計書の「段 0 の結果」) の 1 つで、持ち主は文の原子性を作る所 (シャードの Backend.tx、DO の transactionSync) と
// Txn (取引を終わらせない) である。直し方は 2 通りある。OR ROLLBACK を文の形で断る (`unsupported:`) か、衝突したら基準経路で
// SQLite に決めさせ、取引を終わらせる。
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { SimCluster } from "../sim";

const DDL = [
  "CREATE TABLE p(tenant INTEGER NOT NULL, id INTEGER NOT NULL, u INTEGER, PRIMARY KEY (tenant, id), UNIQUE (tenant, u))",
  "CREATE TABLE g(id INTEGER PRIMARY KEY, email TEXT UNIQUE)",
];

async function answers(statements: string[], shards: number) {
  const db = new SimCluster({ shards }).client();
  const lite = new DatabaseSync(":memory:");
  for (const s of DDL) {
    await db.ddl(s);
    lite.exec(s);
  }
  const out: { sql: string; sqlite: string; ours: string }[] = [];
  const all = "SELECT 'p', tenant, id, u FROM p UNION ALL SELECT 'g', id, email, NULL FROM g ORDER BY 1, 2, 3";
  for (const sql of [...statements, all]) {
    const sqlite = (() => {
      try {
        const st = lite.prepare(sql);
        return st.columns().length ? JSON.stringify(st.all().map((r) => Object.values(r))) : (st.run(), "ok");
      } catch (e) {
        return `ERROR ${(e as Error).message}`;
      }
    })();
    const ours = await db.query(sql).then((r) => (r.columns.length ? JSON.stringify(r.values.map((v) => v.map((x) => (typeof x === "bigint" ? Number(x) : x)))) : "ok"), (e: Error) => `ERROR ${e.message}`);
    out.push({ sql, sqlite, ours });
  }
  return out;
}

describe("a statement with OR ROLLBACK that meets a UNIQUE conflict", () => {
  it("fails with SQLite's error in autocommit", async () => {
    for (const shards of [1, 3]) {
      const out = await answers([
        "INSERT INTO p VALUES (1, 1, 1), (1, 2, 2)",
        "INSERT INTO g VALUES (1, 'a@x'), (2, 'b@x')",
        "INSERT OR ROLLBACK INTO p VALUES (1, 3, 1)",
        "UPDATE OR ROLLBACK g SET email = 'a@x' WHERE id = 2",
      ], shards);
      for (const o of out) expect({ ...o, shards }).toEqual({ ...o, ours: o.sqlite, shards });
    }
  });

  it("ends the transaction it runs in", async () => {
    for (const shards of [1, 3]) {
      const out = await answers([
        "INSERT INTO p VALUES (1, 1, 1), (1, 2, 2)",
        "BEGIN",
        "INSERT INTO p VALUES (2, 1, 1)",
        "UPDATE OR ROLLBACK p SET u = 2 WHERE tenant = 1 AND id = 1",
        "COMMIT",
      ], shards);
      for (const o of out) expect({ ...o, shards }).toEqual({ ...o, ours: o.sqlite, shards });
    }
  });
});
