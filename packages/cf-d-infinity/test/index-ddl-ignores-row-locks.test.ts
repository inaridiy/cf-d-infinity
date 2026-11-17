// 一意でない CREATE INDEX と DROP INDEX も、表の行ロックを持つ取引を待つ (直った。2026-11-17 までは test/open/ にあった。計画書の
// 不変条件 16 の D2)。
//
// 不変条件: M24 の holderSurvives (行を書いた取引は、DDL のために断られない) と asSqlite (DDL は、ロックを持つ取引の終わりを待つ)、
// M24c (specs/m24c_lock_holders.qnt) の FENCE_COVERS。docs/sql-language.md の「取引の中の DDL」は「取引が表の行を書いて行ロックを
// 持っている間は、その表の DDL のほうが待つ」と約束する。SQLite でも、書いた取引が書き込みのロックを持つ間、DDL は busy_timeout まで待つ。
// 持ち主: DDL が待つ表の集合を導く所 (src/catalog.ts の fenceOf)。DDL が確定で書き込みの epoch を進める表のうち、いまある利用者の表が、
// fence になる。畳み込みが epoch を進めるのと同じ一覧から作り、DDL の種類ごとには並べない。
// index を作るか消すだけの DDL は、表の書き込みの epoch を進める (docs/design-catalog-epoch.md の「表ごとの epoch」の規則)。2026-11-17
// までは、その fence が空で、prepare はロックを待たずに適用され、DDL はすぐに確定し、取引の次の書き込みと COMMIT が `stale schema` で
// 断られた。
//
// 場面。表 x の行 x1 (s0) と x2 (s1)。取引 (SQL の BEGIN) が x1 を書く。別の接続が、x の index の DDL を始める。1 秒後に取引が x2 を書き、
// 2 秒後に COMMIT する。DDL は取引の COMMIT を待って確定し、取引はどの文も通る (ALTER TABLE x ADD COLUMN と同じ。
// test/ddl-waits-for-row-locks.test.ts の commitsInTime)。
// 3 つ目の場面 (シャードをまたぐ UNIQUE の DROP INDEX) では、取引の COMMIT が、index の表 (__gidx_xu0) の項目も書く。項目のシャードは、
// x の行ロックがなければ、もう prepare を適用している。fence は x だけで、index の表は入らないので、COMMIT は断られない。
// 乱択の検査 test/ddl-concurrent.test.ts の 9 (test/ddl-lock-holders.ts) が、同じ欠陥を見つける。
import { describe, expect, it } from "vitest";
import { Db } from "../src/client/db";
import type { Faults } from "../src/types";
import { tenantOn } from "./ddl-harness";
import { REFERENCE_ONLY, SimCluster } from "./sim";

const outcome = (p: Promise<unknown>) => p.then(() => "ok", (e: Error) => e.message);
const UPDATE = "UPDATE x SET v = v + 1 WHERE tenant_id = ? AND id = 1";

async function holderAcross(ddlSql: string, setup: string[], faults: Faults = {}) {
  const c = new SimCluster({ shards: 2, faults });
  const admin = new Db(c);
  await admin.ddl("CREATE TABLE x(tenant_id INTEGER NOT NULL, id INTEGER NOT NULL, v INTEGER, PRIMARY KEY (tenant_id, id))");
  for (const sql of setup) await admin.ddl(sql);
  const A = await tenantOn(c, "s0");
  const B = await tenantOn(c, "s1");
  // v は離しておく。取引は v を 1 つ増やすので、隣の値だと、UNIQUE の index のある場面で、取引の書き込みが UNIQUE 違反になる
  // (2026-11-17 まで 1 と 2 で、3 つ目の場面は DDL に届く前に、その違反で落ちていた)。
  await admin.query("INSERT INTO x VALUES (?, 1, 1), (?, 1, 10)", [A, B]);
  const tx = new Db(c, { retries: 0 });
  await tx.query("BEGIN");
  await tx.query(UPDATE, [A]);
  const t0 = c.runtime.now();
  let ddlMs = -1;
  const ddl = outcome(admin.ddl(ddlSql)).then((r) => ((ddlMs = c.runtime.now() - t0), r));
  await c.sleep(1_000);
  const second = await outcome(tx.query(UPDATE, [B]));
  await c.sleep(1_000);
  const commit = await outcome(tx.query("COMMIT"));
  return { second, commit, ddl: await ddl, ddlAfterCommit: ddlMs >= 1_900 };
}

const SQLITE = { second: "ok", commit: "ok", ddl: "ok", ddlAfterCommit: true };
const SCENES: [string, string, string[]][] = [
  ["CREATE INDEX (not UNIQUE)", "CREATE INDEX xi ON x(v)", []],
  ["DROP INDEX of an index on every shard", "DROP INDEX xi0", ["CREATE INDEX xi0 ON x(v)"]],
  ["DROP INDEX of a UNIQUE index across shards", "DROP INDEX xu0", ["CREATE UNIQUE INDEX xu0 ON x(v)"]],
];

describe("an index DDL on a table whose rows an open transaction wrote", () => {
  for (const [title, sql, setup] of SCENES) {
    it(`${title} waits for the transaction, which commits`, async () => {
      expect(await holderAcross(sql, setup)).toEqual(SQLITE);
    });

    // m24c_red_fence。書き込みの epoch を進める表が、fence にない。DDL は取引を待たずに確定し、取引の次の書き込みが、古い計画として
    // 断られる。
    it.skipIf(REFERENCE_ONLY)(`put back (indexDdlUnfenced): ${title} commits at once, and the transaction's next write is refused`, async () => {
      const r = await holderAcross(sql, setup, { indexDdlUnfenced: true });
      expect({ ddl: r.ddl, ddlAfterCommit: r.ddlAfterCommit }).toEqual({ ddl: "ok", ddlAfterCommit: false });
      expect(r.second).toMatch(/stale schema/);
    });
  }
});
