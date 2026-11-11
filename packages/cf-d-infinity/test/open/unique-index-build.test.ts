// 未解決: 行のある表にシャードをまたぐ UNIQUE の index を作っている最中に、まだ出来上がっていない index を、
// 読みと書き込みが、出来上がったものとして使う。
//
// index は「作っている最中」の版として記録され、その時点から、Worker の SQLite は利用者の表定義どおりに UNIQUE を持ち、
// 書き込みは index の表を引く。既存の行に重複があれば、DDL は失敗して取り消される。その前に実行された文は、存在しないことに
// なる index をもとに、結果を変えてしまう。
//
// 見つけたのは、計画への反論を頼んだ別のモデルである (2026-11-11)。未解決の問題 2 と同じ場所 (不変条件 7)。
// 直し方は、index を作っている間、その表への書き込みを止めること (計画書の Decision Log)。
import { describe, expect, it } from "vitest";
import { Db } from "../../src/client/db";
import { hold, tenantOn } from "../ddl-harness";
import { SimCluster } from "../sim";

describe("CREATE UNIQUE INDEX on a table that already has duplicate values, while it is being built", () => {
  const setup = async () => {
    const c = new SimCluster({ shards: 2 });
    const db = new Db(c);
    await db.ddl("CREATE TABLE t(tenant_id INTEGER NOT NULL, id INTEGER NOT NULL, v INTEGER, PRIMARY KEY (tenant_id, id)) SHARD KEY (tenant_id)");
    const A = await tenantOn(c, "s0");
    const B = await tenantOn(c, "s1");
    // 重複がある。A/1 と B/1 が v = 7、A/2 と B/2 が v = 8。この index は作れない。
    await db.query("INSERT INTO t VALUES (?, 1, 7), (?, 2, 8)", [A, A]);
    await db.query("INSERT INTO t VALUES (?, 1, 7), (?, 2, 8)", [B, B]);
    // 既存の行を埋める処理を、2 つ目のシャードを読むところで止める。1 つ目のシャードの行は、もう項目を持っている。
    let scans = 0;
    const paused = hold(c, "gate", (m) => m.from === "client" && m.method === "exec" && /FROM "t"\s+ORDER BY/.test((m.req as { sql: string }).sql) && ++scans === 2);
    const ddl = db.ddl("CREATE UNIQUE INDEX u ON t(v)").then(() => "ok", (e: Error) => e.message);
    await paused.reached;
    const original = [{ tenant_id: A, id: 1, v: 7 }, { tenant_id: A, id: 2, v: 8 }, { tenant_id: B, id: 1, v: 7 }, { tenant_id: B, id: 2, v: 8 }];
    return { c, A, B, paused, ddl, original };
  };
  const rows = async (c: SimCluster) => (await new Db(c).query("SELECT tenant_id, id, v FROM t ORDER BY tenant_id, id")).rows;

  it("a read that gathers the table does not fail because of the index", async () => {
    const { c, paused, ddl } = await setup();
    const read = await new Db(c).query("SELECT count(*) AS pairs FROM t a JOIN t b ON a.v = b.v AND a.tenant_id < b.tenant_id")
      .then((r) => r.rows, (e: Error) => e.message);
    paused.release();
    await ddl;
    // 値が同じ行の組は 2 つある。index があってもなくても、読みの答えは変わらない。
    expect(read).toEqual([{ pairs: 2 }]);
  });

  it("a write does not delete a row because of an index that is then withdrawn", async () => {
    const { c, A, paused, ddl, original } = await setup();
    // index がなければ、これは新しい行を足すだけである。作っている最中の index を信じると、v = 8 を持つ行を消してしまう。
    await new Db(c).query("INSERT OR REPLACE INTO t VALUES (?, 9, 8)", [A]).catch(() => undefined);
    paused.release();
    expect(await ddl).toMatch(/UNIQUE constraint failed/);
    // DDL は失敗したので、index は無かったことになる。元の 4 行は、どれも残っていなければならない。
    expect((await rows(c)).filter((r) => r.id !== 9)).toEqual([...original].sort((x, y) => x.tenant_id - y.tenant_id || x.id - y.id));
  });
});
