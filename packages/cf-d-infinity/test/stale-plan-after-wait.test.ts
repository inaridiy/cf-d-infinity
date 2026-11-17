// 文は、計画したときの表定義の版で実行する。シャードは、入口で版を確かめる (古い版の要求は NotOwner で断る)。
// 入口を通った後で、intent の決着か行ロックを待っている間に、そのシャードに新しい版が適用されることがある。待ちの後で版を
// 確かめ直さないと、古い計画の文が、新しい表定義の上で実行される (計画書の未解決の問題 27)。
//
// 取引の書き込みは、確定のときに版を確かめるので通らない。読みは、そのまま答えになる。読むだけの取引は、確定で検証を受けない。
// 1 つ目の場面では、読むだけの取引が、表を消して作り直す前の時刻 T で読み始め、作り直した後の空の表を、同じ T で読む。
// T の時点では行があったので、正しい答えは、T の時点の行か、やり直せる誤りである。2026-11-14 までは「行なし」と答えた。
// 待ちが 2 つの版をまたぐのは、決着の問い合わせ (queryTxn) の応答が遅れたときである。DDL の適用は、同じ intent を別の
// 問い合わせで決着させて先へ進む。
//
// 2 つ目の場面は、行ロックの待ちである。悲観的な取引の文が行を待っている間に版が進む。以前は、起こされた文が古い計画のまま
// 実行され、取引は COMMIT で断られた。いまは、文の時点で断る。
// 待っている行の表の DDL は、その行ロックを持つ取引を待つので (docs/design-catalog-epoch.md の「触った表の DDL と SQLite」)、待ちの間に
// 進む版は、文が読む別の表のものである。文は、表 t の行を書き、表 u を読む。t の行を待つ間に、u に列が足される。
//
// 核 (src/shard/kernel.ts) の 1 歩は、待ちの後で先頭から呼び直され、文を実行する同期区間に入るたびに版を確かめる (enter)。
// 欠陥のスイッチ noSchemaRecheck は、その確かめを外す。
import { describe, expect, it } from "vitest";
import { Db } from "../src/client/db";
import type { Faults } from "../src/types";
import { tenantOn } from "./ddl-harness";
import { SimCluster } from "./sim";

const T = `CREATE TABLE t(tenant_id INTEGER NOT NULL, id INTEGER NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (tenant_id, id))`;
const outcome = <R>(p: Promise<{ rows: R[] }>) => p.then((r) => r.rows as unknown, (e: Error) => e.message);

/**
 * s0 の行 A/1 に、確定済みで未適用の intent を残す。読むだけの取引が、s1 で読んで T を決め、次に s0 の A/1 を読む。
 * s0 は intent の決着を anchor (s1) に尋ねる。その応答を止めている間に、別の接続が表を消して作り直す。応答を通す。
 */
async function readAcrossRecreate(faults?: Faults) {
  const c = new SimCluster({ shards: 2, faults });
  const db = new Db(c);
  await db.ddl(T);
  const A = await tenantOn(c, "s0");
  const B = await tenantOn(c, "s1");
  await db.query("INSERT INTO t VALUES (?, 1, 1)", [A]);
  await db.query("INSERT INTO t VALUES (?, 1, 1)", [B]);

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

  // 2 つのシャードに書く取引。s1 で 1 行余分に読むので、anchor は s1 になる。確定の後、s0 には intent が残る。
  await db.transaction(async (tx) => {
    await tx.query("SELECT n FROM t WHERE tenant_id = ? AND id = 2", [B]);
    await tx.query("UPDATE t SET n = 2 WHERE tenant_id = ? AND id = 1", [A]);
    await tx.query("UPDATE t SET n = 2 WHERE tenant_id = ? AND id = 1", [B]);
  });

  const reader = new Db(c, { retries: 0 });
  await reader.query("BEGIN");
  // T が決まる。s1 では、取引の書き込みが見える。
  const first = await outcome(reader.query("SELECT n FROM t WHERE tenant_id = ? AND id = 1", [B]));
  const second = outcome(reader.query("SELECT n FROM t WHERE tenant_id = ? AND id = 1", [A]));
  await askReached;
  // 読みが決着を待っている間に、表を消して作り直す。s0 は、自分の問い合わせで intent を決着させてから適用する。
  const ddl = new Db(c);
  await ddl.ddl("DROP TABLE t");
  await ddl.ddl(T);
  releaseAsk();
  const answer = await second;
  releaseFinalize();
  await c.settle();
  return { first, answer };
}

/**
 * 取引 H が表 t の行 A/1 のロックを持つ。悲観的な取引 X の UPDATE (t の行を書き、表 u を読む) が、その行を待つ。待っている間に、
 * 別の接続が u に列を足す。H が ROLLBACK して、X の文が起こされる。
 */
async function lockWaitAcrossAddColumn(faults?: Faults) {
  const c = new SimCluster({ shards: 2, faults });
  const db = new Db(c);
  await db.ddl(T);
  await db.ddl("CREATE TABLE u(tenant_id INTEGER NOT NULL, id INTEGER NOT NULL, PRIMARY KEY (tenant_id, id))");
  const A = await tenantOn(c, "s0");
  await db.query("INSERT INTO t VALUES (?, 1, 1)", [A]);
  await db.query("INSERT INTO u VALUES (?, 1)", [A]);
  const holder = new Db(c);
  await holder.query("BEGIN");
  await holder.query("UPDATE t SET n = 10 WHERE tenant_id = ? AND id = 1", [A]);
  const waiter = new Db(c, { retries: 0 });
  await waiter.query("BEGIN");
  await waiter.query("SELECT n FROM t WHERE tenant_id = ? AND id = 2", [A]); // 読んだ取引は、表定義を取り替えない
  const update = outcome(waiter.query("UPDATE t SET n = n + (SELECT count(*) FROM u WHERE tenant_id = ?) WHERE tenant_id = ? AND id = 1", [A, A]));
  await c.sleep(20); // 行を待ち始める
  await new Db(c).ddl("ALTER TABLE u ADD COLUMN extra INTEGER DEFAULT 5");
  await holder.query("ROLLBACK");
  const statement = await update;
  const commit = await waiter.query("COMMIT").then(() => "committed", (e: Error) => e.message);
  await c.settle();
  const row = (await new Db(c).query("SELECT n FROM t WHERE tenant_id = ? AND id = 1", [A])).rows[0];
  return { statement, commit, row };
}

describe("a statement that waited inside the shard while the shard applied a newer schema", () => {
  it("a read that waited for an intent while its table was dropped and created again is refused, not answered from the new table", async () => {
    const r = await readAcrossRecreate();
    expect(r.first).toEqual([{ n: 2 }]);
    // T の時点では、A/1 は n = 2 である。作り直した後の空の表を答えてはならない。
    expect(r.answer).toMatch(/^not owner: stale schema/);
  });

  it("put back: without the re-check after the wait, the read is answered from the empty table that was created after its read time", async () => {
    const r = await readAcrossRecreate({ noSchemaRecheck: true });
    expect(r).toEqual({ first: [{ n: 2 }], answer: [] });
  });

  it("a statement of a transaction that waited for a row lock while a column was added to a table it reads is refused at the statement", async () => {
    const r = await lockWaitAcrossAddColumn();
    expect(r.statement).toMatch(/^not owner: stale schema: u /);
    // 断られた文は、何も書いていない。取引に残っているのは読みだけなので、COMMIT は通り、行はもとのままである。
    expect({ commit: r.commit, row: r.row }).toEqual({ commit: "committed", row: { n: 1 } });
  });
});
