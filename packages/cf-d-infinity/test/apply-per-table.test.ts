// シャードが表定義の記録を適用している間の、ほかの要求 (docs/design-catalog-epoch.md の「表ごとの epoch」の「シャード」、実装の一覧の 6、
// モデル M24 の APPLY_REFUSES)。
//
// シャードは、表定義の記録を適用する前に、その記録が変える表の intent を決着させる。決着を待つ間、
//   - ほかの表に頼る要求は通す (M24 の m24_red_apply_all、noRefusalUnrelated)。
//   - その表に頼る新しい文は、適用が終わるまで待つ。断らない。DDL が失敗すれば、待った文はそのまま通る
//     (m24_red_apply_touched、noRefusalWithoutChange)。
// 段 3 までは、適用の前に全部の表の intent を決着させ、その間、どの表の要求も `not owner: stale schema` で断った。
//
// 場面。表 b の、s0 の行に、確定済みで未適用の intent を残す (2 つのシャードに書く取引の、s0 への phase 2 を止める)。別の接続が b の
// UNIQUE index を作る。s0 は、prepare を適用する前に、b の intent の決着を anchor (s1) に尋ねる。その問い合わせを止めている間、s0 は
// 適用の途中である。その間に、読むか書くかした取引が、s0 の表 a の行と、表 b の行を読む。
import { describe, expect, it } from "vitest";
import { Db } from "../src/client/db";
import type { Faults } from "../src/types";
import { tenantOn } from "./ddl-harness";
import { REFERENCE_ONLY, SimCluster } from "./sim";

const BUSY = /^(conflict|read too old|not owner|migrating|upgrading)/;
const outcome = (p: Promise<unknown>) => p.then(() => "ok", (e: Error) => (BUSY.test(e.message) ? `busy (${e.message.slice(0, 60)})` : e.message));
const table = (name: string) => `CREATE TABLE ${name}(tenant_id INTEGER NOT NULL, id INTEGER NOT NULL, v INTEGER, PRIMARY KEY (tenant_id, id))`;

export async function duringApply(faults?: Faults) {
  const c = new SimCluster({ shards: 2, faults });
  const db = new Db(c);
  await db.ddl(table("a"));
  await db.ddl(table("b"));
  const A = await tenantOn(c, "s0");
  const B = await tenantOn(c, "s1");
  for (const t of ["a", "b"]) for (const tenant of [A, B]) await db.query(`INSERT INTO ${t} VALUES (?, 1, 1), (?, 2, 1)`, [tenant, tenant]);

  // s0 への finalize と、s0 から出る最初の queryTxn を止める。
  let releaseFinalize!: () => void;
  const finalizeHeld = new Promise<void>((r) => (releaseFinalize = r));
  let releaseAsk!: () => void;
  const askHeld = new Promise<void>((r) => (releaseAsk = r));
  let asked!: () => void;
  const askReached = new Promise<void>((r) => (asked = r));
  let asks = 0;
  c.net.gate = (m) => {
    if (m.method === "finalize" && m.to === "s0") return finalizeHeld;
    if (m.method === "queryTxn" && m.from === "s0" && asks++ === 0) {
      asked();
      return askHeld;
    }
    return undefined;
  };
  // 2 つのシャードの b に書く取引。s1 で 1 行余分に読むので、anchor は s1 になる。確定の後、s0 には b の intent が残る。
  await db.transaction(async (tx) => {
    await tx.query("SELECT v FROM b WHERE tenant_id = ? AND id = 2", [B]);
    await tx.query("UPDATE b SET v = 5 WHERE tenant_id = ? AND id = 1", [A]);
    await tx.query("UPDATE b SET v = 5 WHERE tenant_id = ? AND id = 1", [B]);
  });

  // 読むか書くかした取引。表定義は取り替えられない。
  const tx = new Db(c, { retries: 0 });
  await tx.query("BEGIN");
  await tx.query("SELECT v FROM a WHERE tenant_id = ? AND id = 1", [B]);

  // b の s0 の 2 行 (id 1 は 5、id 2 は 1) は違う v なので、UNIQUE index は s0 では作れる。s1 の tenant B の 2 行も違う。
  // 失敗させるために、tenant B に、同じ v の行を足しておく。
  await db.query("INSERT INTO b VALUES (?, 3, 1)", [B]);
  const ddl = outcome(new Db(c).ddl("CREATE UNIQUE INDEX bu ON b(tenant_id, v)"));
  await askReached;
  const t0 = c.runtime.now();
  // s0 が b の記録を適用している間の、a の読み。
  const other = await outcome(tx.query("SELECT v FROM a WHERE tenant_id = ? AND id = 1", [A]));
  const otherWaited = c.runtime.now() - t0 > 50;
  // 同じ間の、b の読み。適用が終わるまで待つ。
  let touchedDone = false;
  const touched = outcome(tx.query("SELECT v FROM b WHERE tenant_id = ? AND id = 2", [A])).then((r) => {
    touchedDone = true;
    return r;
  });
  await c.sleep(100);
  const touchedWaited = !touchedDone;
  releaseAsk();
  releaseFinalize();
  const result = { other, otherWaited, touched: await touched, touchedWaited, ddl: await ddl, commit: await outcome(tx.query("COMMIT")) };
  c.net.gate = () => undefined;
  await c.settle();
  return result;
}
export const DURING_APPLY = {
  other: "ok", otherWaited: false, touched: "ok", touchedWaited: true, ddl: expect.stringMatching(/UNIQUE constraint failed/), commit: "ok",
};

// 場面は、どの要求がどのシャードへ行くかで組んである (intent を s0 に残し、s0 から出る問い合わせを止める)。基準経路だけの実行では、
// 文が全部のシャードの行を集め、取引の anchor も変わるので、流さない。
describe.skipIf(REFERENCE_ONLY)("a shard that is applying a schema record", () => {
  it("answers statements on other tables, and makes statements on the record's table wait instead of refusing them", async () => {
    expect(await duringApply()).toEqual(DURING_APPLY);
  });

  it("put back (applyRefusesAll, m24_red_apply_all): the shard refuses a statement on another table while it applies", async () => {
    expect(await duringApply({ applyRefusesAll: true })).toMatchObject({ other: expect.stringMatching(/^busy \(not owner: stale schema: a schema change is being applied/) });
  });

  it("put back (applyRefusesTouched, m24_red_apply_touched): the shard refuses a statement on the table of a DDL that then fails", async () => {
    expect(await duringApply({ applyRefusesTouched: true })).toMatchObject({
      other: "ok", touched: expect.stringMatching(/^busy \(not owner: stale schema: a schema change is being applied/), touchedWaited: false,
      ddl: expect.stringMatching(/UNIQUE constraint failed/),
    });
  });
});
