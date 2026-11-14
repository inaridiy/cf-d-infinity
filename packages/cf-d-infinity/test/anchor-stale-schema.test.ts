// 複数のシャードに書く取引の確定では、anchor が、参加者の prepare の答えを待つ。待っている間に anchor に新しい表定義の版が
// 適用されることがある (anchor は、自分の prepare を最後にするので、待っている間は intent を持たず、DDL の適用を止めない)。
// 取引は古い版で計画されているので、anchor は、答えを受け取った後で版を確かめ直して、取引を中止する (核の driveStep)。
//
// この確かめ直しが効いていることを確かめる試験が、なかった (計画書の未解決の問題 29)。ふだんは、参加者の intent が DDL の適用を
// 待たせるので、index が出来上がる前に取引が決着する。その守りを欠陥のスイッチ ddlIgnoresIntents で外すと、DDL は intent を
// 残したまま最後まで進み、anchor の確かめ直しだけが、古い計画の確定を止める。そこで noSchemaRecheck も入れると、古い計画が
// 確定して、index に項目のない行ができる。
import { describe, expect, it } from "vitest";
import { Db } from "../src/client/db";
import type { Faults } from "../src/types";
import { hold, indexAgreement, rawRows, tenantOn } from "./ddl-harness";
import { SimCluster } from "./sim";

const T = `CREATE TABLE t(
  tenant_id INTEGER NOT NULL, id INTEGER NOT NULL, v INTEGER, n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, id))`;
const outcome = (p: Promise<unknown>) => p.then(() => "ok", (e) => (e instanceof Error ? e.message : String(e)));

/**
 * 行 A/1 (s0、v = 7) と B/1 (s1、v = 8)。index を知らない取引が、両方の v を書き換えて COMMIT する。参加者の prepare の応答を
 * 止めている間に、別の接続が CREATE UNIQUE INDEX ix ON t(v) を実行する。応答を通す。
 */
async function commitAcrossIndex(faults?: Faults) {
  const c = new SimCluster({ shards: 2, faults });
  const db = new Db(c);
  await db.ddl(T);
  const A = await tenantOn(c, "s0");
  const B = await tenantOn(c, "s1");
  await db.query("INSERT INTO t VALUES (?, 1, 7, 0)", [A]);
  await db.query("INSERT INTO t VALUES (?, 1, 8, 0)", [B]);
  const tx = await new Db(c, { retries: 0 }).begin();
  await tx.query("UPDATE t SET v = 70 WHERE tenant_id = ? AND id = 1", [A]);
  await tx.query("UPDATE t SET v = 80 WHERE tenant_id = ? AND id = 1", [B]);
  const ack = hold(c, "reply", (m) => m.method === "prepare");
  const commit = outcome(tx.commit());
  await ack.reached;
  const ddl = outcome(db.ddl("CREATE UNIQUE INDEX ix ON t(v)"));
  // 欠陥 ddlIgnoresIntents のときは、DDL が最後まで進む。そうでなければ、参加者の intent が DDL を待たせるので、少し待って応答を通す。
  if (faults?.ddlIgnoresIntents) await ddl;
  else await c.sleep(30);
  ack.release();
  const committed = await commit;
  const created = await ddl;
  await c.settle();
  const ix = await indexAgreement(c, "t", "ix");
  const rows = (await rawRows(c, "t")).map(({ row }) => `${row.tenant_id}/${row.id} v=${row.v}`).sort();
  return { committed, created, rows, state: ix.state, broken: [...ix.missing, ...ix.dangling, ...ix.wrongRead], A, B };
}

describe("a cross-shard commit whose anchor applied a newer schema while the participants prepared", () => {
  it("is aborted by the anchor as stale, and the rows stay as they were", async () => {
    const r = await commitAcrossIndex();
    expect(r.committed).toMatch(/stale schema/);
    expect({ created: r.created, rows: r.rows, state: r.state, broken: r.broken })
      .toEqual({ created: "ok", rows: [`${r.A}/1 v=7`, `${r.B}/1 v=8`].sort(), state: "public", broken: [] });
  });

  it("is still aborted by the anchor when the schema change did not wait for the participant's intent", async () => {
    const r = await commitAcrossIndex({ ddlIgnoresIntents: true });
    expect(r.committed).toMatch(/stale schema/);
    expect({ rows: r.rows, state: r.state, broken: r.broken })
      .toEqual({ rows: [`${r.A}/1 v=7`, `${r.B}/1 v=8`].sort(), state: "public", broken: [] });
  });

  it("put back: without the anchor's re-check, the old plan commits and the index does not know the new values", async () => {
    const r = await commitAcrossIndex({ ddlIgnoresIntents: true, noSchemaRecheck: true });
    expect(r.committed).toBe("ok");
    expect(r.rows).toEqual([`${r.A}/1 v=70`, `${r.B}/1 v=80`].sort());
    expect(r.broken.length).toBeGreaterThan(0);
  });
});
