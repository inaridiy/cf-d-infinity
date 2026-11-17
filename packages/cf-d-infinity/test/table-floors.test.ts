// 表定義の変更の床は、表ごとである (docs/design-catalog-epoch.md の「表ごとの epoch」の「シャード」の床、実装の一覧の 7、モデル M24 の
// m24_floor)。
//
// シャードは、表の形を変える DDL の commit を適用すると、その表に床を置く。変更ログの行イメージは、その commit より前の表の形なので、
// 床より古い時刻には、その表の行を読み戻せない。床より古い時刻の、その表の読み戻し、refresh、述語の検証を断る。
//   - ほかの表の DDL は、取引の古い時刻の読み、読み取り時刻の前進 (refresh)、COMMIT の述語の検証を断らない (m24_floor_red_global)。
//   - 古い時刻の読みが読み戻すのは、読む表の行だけである (m24_floor_red_restore_all)。
//   - 形を変えた表には床を置く (m24_floor_red_no_floor)。
// 段 3 までは、床がシャードに 1 つで、どの DDL の commit も、全部の表の古い時刻の読みを `read too old` で断った。
import { describe, expect, it } from "vitest";
import { Db } from "../src/client/db";
import type { Faults } from "../src/types";
import { tenantOn } from "./ddl-harness";
import { REFERENCE_ONLY, SimCluster } from "./sim";

const BUSY = /^(conflict|read too old|not owner|migrating|upgrading)/;
const rows = (p: Promise<{ rows: unknown[] }>) => p.then((r) => r.rows as unknown, (e: Error) => (BUSY.test(e.message) ? "busy" : e.message));
const outcome = (p: Promise<unknown>) => p.then(() => "ok", (e: Error) => (BUSY.test(e.message) ? "busy" : e.message));
const table = (name: string) => `CREATE TABLE ${name}(tenant_id INTEGER NOT NULL, id INTEGER NOT NULL, v INTEGER, PRIMARY KEY (tenant_id, id))`;

async function scene(faults?: Faults) {
  const c = new SimCluster({ shards: 2, faults });
  const db = new Db(c);
  await db.ddl(table("a"));
  await db.ddl(table("b"));
  const A = await tenantOn(c, "s0");
  const B = await tenantOn(c, "s1");
  for (const t of ["a", "b"]) for (const tenant of [A, B]) await db.query(`INSERT INTO ${t} VALUES (?, 1, 1), (?, 2, 1)`, [tenant, tenant]);
  await c.sleep(5);
  return { c, A, B };
}
const READ = "SELECT v FROM a WHERE tenant_id = ? AND id = 1";
const WRITE = "UPDATE a SET v = 50 WHERE tenant_id = ? AND id = 1";

/**
 * 取引が a の s0 の行を読んで T を決める。別の接続が、その行と、a の s1 の行を書き、表 b に列を足す。取引は、a の s1 の行を読む。
 * 取引は、読んだ行が変わったので T を進められず、決めた T のスナップショットで読む (s1 は、T より後の変更を読み戻す)。
 */
export async function snapshotReadAfterUnrelatedDdl(faults?: Faults) {
  const s = await scene(faults);
  const tx = await new Db(s.c, { retries: 0 }).begin();
  const first = await rows(tx.query(READ, [s.A]));
  await s.c.sleep(5);
  await new Db(s.c).query(WRITE, [s.A]);
  await new Db(s.c).query(WRITE, [s.B]);
  const ddl = await outcome(new Db(s.c).ddl("ALTER TABLE b ADD COLUMN x INTEGER"));
  return { first, ddl, other: await rows(tx.query(READ, [s.B])), again: await rows(tx.query(READ, [s.A])) };
}
export const SNAPSHOT_READ = { first: [{ v: 1 }], ddl: "ok", other: [{ v: 1 }], again: [{ v: 1 }] };

/**
 * 取引が a の s0 の行を読んで T を決める。別の接続が、a の s1 の行を書き、表 b に列を足す。取引は、a の s1 の行を読む。読んだ行は
 * 変わっていないので、取引は T を進めて (s0 が、読んだ範囲に変更がないことを確かめる。refresh)、新しい値を読む。
 */
export async function advanceAfterUnrelatedDdl(faults?: Faults) {
  const s = await scene(faults);
  const tx = await new Db(s.c, { retries: 0 }).begin();
  const first = await rows(tx.query(READ, [s.A]));
  await s.c.sleep(5);
  await new Db(s.c).query(WRITE, [s.B]);
  const ddl = await outcome(new Db(s.c).ddl("ALTER TABLE b ADD COLUMN x INTEGER"));
  return { first, ddl, other: await rows(tx.query(READ, [s.B])) };
}
export const ADVANCE = { first: [{ v: 1 }], ddl: "ok", other: [{ v: 50 }] };

/**
 * 取引が、a の行を条件で読み (どの行も条件に合わない)、b に書く。別の接続が、条件に合わない行を a に足し、関係のない表を作る。
 * 取引の COMMIT は、a の条件の範囲を、変更ログで検証する (述語の検証)。条件に合う変更はないので、通る。
 */
export async function predicateAfterUnrelatedDdl(faults?: Faults) {
  const s = await scene(faults);
  const tx = await new Db(s.c, { retries: 0 }).begin();
  const first = await rows(tx.query("SELECT count(*) AS n FROM a WHERE v > 100"));
  await tx.query("UPDATE b SET v = 2 WHERE tenant_id = ? AND id = 1", [s.A]);
  await s.c.sleep(5);
  await new Db(s.c).query("INSERT INTO a VALUES (?, 9, 1), (?, 9, 1)", [s.A, s.B]);
  const ddl = await outcome(new Db(s.c).ddl("CREATE TABLE n(id INTEGER PRIMARY KEY)"));
  return { first, ddl, commit: await outcome(tx.commit()) };
}
export const PREDICATE = { first: [{ n: 0 }], ddl: "ok", commit: "ok" };

/**
 * 形を変えた表の床。s0 の時計は s1 より 60 秒遅れている。別の接続が a の s1 の行を書き (s1 の時計の時刻で確定する)、a に列を足す。
 * その後で始まった取引 (新しい表定義で計画する) が、s0 で読んで T を決める。T は s0 の時計の時刻なので、s1 の確定より小さい。取引が
 * a の s1 の行を読むと、s1 は、T より後の変更があると知らせ、取引は T を進めて、新しい形の行を読む。
 * pinned なら、別の接続が、取引の読んだ行を書く。取引は T を進められず、決めた T で読む。s1 は、T が a の床より古いので断る。
 * 床がなければ、s1 は、T より後の変更を読み戻す。その変更前の行イメージは、列を足す前の形である。
 */
export async function oldTimeAfterAddColumn(pinned: boolean, faults?: Faults) {
  // 床を外すと、列の足りない行イメージを読み戻す。行イメージの検査 (test/setup.ts) は、この試験が自分で見るので、切る。
  const c = new SimCluster({ shards: 2, faults, skewMs: (id) => (id === "s0" ? -60_000 : 0), noImageCheck: faults?.noFloorOnChange === true });
  // 接続の因果トークンが s1 の時計を s0 へ運ばないように、文ごとに新しい接続を使う。
  await new Db(c).ddl(table("a"));
  await new Db(c).ddl(table("k"));
  const A = await tenantOn(c, "s0");
  const B = await tenantOn(c, "s1");
  await new Db(c).query("INSERT INTO k VALUES (?, 1, 1)", [A]);
  await new Db(c).query("INSERT INTO a VALUES (?, 1, 1)", [B]);
  await c.sleep(5);
  await new Db(c).query(WRITE, [B]);
  const ddl = await outcome(new Db(c).ddl("ALTER TABLE a ADD COLUMN x INTEGER DEFAULT 7"));
  const tx = await new Db(c, { retries: 0 }).begin();
  const first = await rows(tx.query("SELECT v FROM k WHERE tenant_id = ? AND id = 1", [A]));
  if (pinned) await new Db(c).query("UPDATE k SET v = 2 WHERE tenant_id = ? AND id = 1", [A]);
  const read = await rows(tx.query("SELECT v, x FROM a WHERE tenant_id = ? AND id = 1", [B]));
  return { ddl, first, read };
}

// 場面は、1 行の読みが 1 つのシャードへ行く経路で組んである (読み取り時刻を進められるか、条件の範囲で検証するか)。基準経路だけの
// 実行では、文が表の全行を集め、読んだ範囲が変わるので、流さない。関係のない DDL をまたぐ取引は、test/txn-across-ddl.test.ts が、
// 基準経路だけの実行でも確かめる。
describe.skipIf(REFERENCE_ONLY)("the floor that a schema change leaves is per table", () => {
  it("a transaction reads its snapshot of one table after another table's ADD COLUMN committed", async () => {
    expect(await snapshotReadAfterUnrelatedDdl()).toEqual(SNAPSHOT_READ);
  });

  it("a transaction advances its read time across another table's ADD COLUMN", async () => {
    expect(await advanceAfterUnrelatedDdl()).toEqual(ADVANCE);
  });

  it("a COMMIT validates a predicate read of one table across an unrelated CREATE TABLE", async () => {
    expect(await predicateAfterUnrelatedDdl()).toEqual(PREDICATE);
  });

  it("a read at a time before its table's ADD COLUMN reads at a later time when the transaction can advance, and is busy when it cannot", async () => {
    expect(await oldTimeAfterAddColumn(false)).toEqual({ ddl: "ok", first: [{ v: 1 }], read: [{ v: 50, x: 7 }] });
    expect(await oldTimeAfterAddColumn(true)).toEqual({ ddl: "ok", first: [{ v: 1 }], read: "busy" });
  });

  // 再生: M24 の床の赤。
  it("put back (globalDdlFloor, m24_floor_red_global): one floor for the shard refuses all three after an unrelated DDL", async () => {
    expect(await snapshotReadAfterUnrelatedDdl({ globalDdlFloor: true })).toMatchObject({ ddl: "ok", other: "busy" });
    expect(await advanceAfterUnrelatedDdl({ globalDdlFloor: true })).toMatchObject({ ddl: "ok", other: "busy" });
    expect(await predicateAfterUnrelatedDdl({ globalDdlFloor: true })).toMatchObject({ ddl: "ok", commit: "busy" });
  });

  it("put back (restoreAllTables, m24_floor_red_restore_all): restoring every table's rows makes the old read depend on the other table's floor", async () => {
    expect(await snapshotReadAfterUnrelatedDdl({ restoreAllTables: true })).toMatchObject({ ddl: "ok", other: "busy" });
  });

  it("put back (noFloorOnChange, m24_floor_red_no_floor): the old read restores a row image from before the ADD COLUMN", async () => {
    const r = await oldTimeAfterAddColumn(true, { noFloorOnChange: true });
    expect(r.ddl).toBe("ok");
    // 床があれば断る読みに、答える。答えは、列を足す前の行イメージから作ったもので、足した列の既定の値 (7) を持たない。
    expect(r.read).not.toBe("busy");
    expect(r.read).not.toEqual([{ v: 1, x: 7 }]);
  });
});
