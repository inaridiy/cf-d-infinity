// 取引は、書き込みを計画した表定義の版を、確定まで使う。
//
// 取引は、文を計画したときの表定義で、書き込む行と index の項目を決めて、手元に溜める。確定のとき、シャードには
// 「この版で計画した」と伝える。シャードは、自分より古い版の計画を断る。新しい index を保守しない計画を通さないためである。
// 2026-11 までは、取引が持つ版が、次の 2 つの場所で、溜めた書き込みを計画し直さずに、新しい版へ取り替えられていた。
//
//   接続をまたぐ取引 (Hrana の baton): 取引の状態を書き出すとき、版を書き出さなかった。次の要求は、そのときの最新の版で
//                                       取引を組み立て直した。
//   知らない表を読んだ後:              「no such table」で表定義を取り直し、取引の版も取り替えた。
//
// どちらも、index を知らずに計画した書き込みが、index を知っている版の番号で確定した。項目のない行ができた。
// いまは、読むか書くかした取引は版を取り替えない。表定義が変わっていたら、取引は競合として失敗する。
//
// 見つけたのは、index を書き込みを止めて作る設計のモデルを、実装と突き合わせたときである (2026-11-11)。不変条件 7。
// モデルは specs/m13_txn_schema_boundary.qnt の m13_green と m13_red_repin。
import { describe, expect, it } from "vitest";
import { Db, type ClientFaults } from "../src/client/db";
import { rawRows, tenantOn } from "./ddl-harness";
import { clientOf } from "./libsql";
import { SimCluster } from "./sim";

describe("a transaction that planned a write before a UNIQUE index existed", () => {
  const setup = async () => {
    const c = new SimCluster({ shards: 2 });
    await new Db(c).ddl("CREATE TABLE t(tenant_id INTEGER NOT NULL, id INTEGER NOT NULL, v INTEGER, PRIMARY KEY (tenant_id, id)) SHARD KEY (tenant_id)");
    const A = await tenantOn(c, "s0");
    const B = await tenantOn(c, "s1");
    await new Db(c).query("INSERT INTO t VALUES (?, 1, 7)", [B]);
    return { c, A, B };
  };
  // index が出来た後は、同じ v を持つ行は 1 つしかない。取引が失敗しても成功しても、それは変わらない。
  const holders = async (c: SimCluster) => (await rawRows(c, "t")).filter(({ row }) => row.v === 7).length;
  /** 取引が 1 行を書いた後で index が作られ、取引が別の接続で続く。 */
  const continued = async (faults?: ClientFaults) => {
    const { c, A } = await setup();
    const first = new Db(c);
    await first.query("BEGIN");
    await first.query("INSERT INTO t VALUES (?, 1, 7)", [A]);
    const baton = first.dump();
    await new Db(c).ddl("CREATE UNIQUE INDEX u ON t(v)");
    const second = new Db(c, { faults });
    await second.restore(baton);
    const commit = await second.query("COMMIT").then(() => "committed", (e: Error) => e.message);
    return { commit, holders: await holders(c) };
  };

  it("does not commit the write under the new version when it continues on another connection", async () => {
    const r = await continued();
    expect(r.commit).toMatch(/^conflict: the schema changed while the transaction was open/);
    expect(r.holders).toBe(1);
  });

  it("put back: a transaction that takes the new version commits a row that the index does not know", async () => {
    expect(await continued({ repinOnRestore: true })).toEqual({ commit: "committed", holders: 2 });
  });

  it("does not commit the write under the new version after it reloads the schema for an unknown table", async () => {
    const { c, A } = await setup();
    const db = new Db(c);
    await db.query("BEGIN");
    await db.query("INSERT INTO t VALUES (?, 1, 7)", [A]);
    const other = new Db(c);
    await other.ddl("CREATE TABLE extra(tenant_id INTEGER NOT NULL, id INTEGER NOT NULL, PRIMARY KEY (tenant_id, id)) SHARD KEY (tenant_id)");
    await other.ddl("CREATE UNIQUE INDEX u ON t(v)");
    await db.query("SELECT count(*) FROM extra").catch(() => undefined);
    await db.query("COMMIT").catch(() => undefined);
    expect(await holders(c)).toBe(1);
  });

  // 接続をまたぐ取引は、要求ごとに組み立て直し、書き出し直す。失敗させた取引を書き出し直すとき、版を新しくしてはならない。
  // 新しくすると、次の要求では版が合い、古い計画の書き込みが確定する。SQLite では、文の誤りを受け取った後に COMMIT してよい。
  it("keeps failing after a statement failed, on the requests that follow", async () => {
    const { c, A } = await setup();
    const client = clientOf(c);
    const tx = await client.transaction("write");
    await tx.execute({ sql: "INSERT INTO t VALUES (?, 1, 7)", args: [A] });
    await new Db(c).ddl("CREATE UNIQUE INDEX u ON t(v)");
    const failed = await tx.execute("SELECT 1").then(() => "ok", (e: Error) => e.message);
    const commit = await tx.commit().then(() => "committed", (e: Error) => e.message);
    expect({ failed, commit }).toEqual({
      failed: expect.stringMatching(/the schema changed while the transaction was open/),
      commit: expect.stringMatching(/the schema changed while the transaction was open/),
    });
    expect(await holders(c)).toBe(1);
  });
});
