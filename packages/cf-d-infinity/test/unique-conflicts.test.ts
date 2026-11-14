// シャード内の UNIQUE がある表への書き込みが、検証する範囲。
// 範囲は「名指しした行と、同じ UNIQUE の値を持つ行」である (src/client/spans.ts の規則 3)。同じ shard key の値の全行にすると、
// 同じテナントに並行して書く取引が、無関係な行でも commit で競合する。狭すぎないことは、どの試験にも掛かる範囲の検査が確かめる。
import { describe, expect, it } from "vitest";
import { Db } from "../src/client/db";
import { quiescentProblems } from "./invariants";
import { SimCluster } from "./sim";

const P = `CREATE TABLE p(tenant_id INTEGER NOT NULL, id INTEGER NOT NULL, code TEXT, gone INTEGER, n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, id), UNIQUE (tenant_id, code))`;

async function setup(extra: string[] = []) {
  const c = new SimCluster({ shards: 2 });
  const db = c.client();
  await db.ddl(P);
  for (const s of extra) await db.ddl(s);
  for (let i = 1; i <= 4; i++) await db.query("INSERT INTO p(tenant_id, id, code) VALUES (1, ?, ?)", [i, `c${i}`]);
  return { c, db };
}
/** 2 つの取引を、互いの commit の前に文を実行させてから、順に commit する。やり直しはさせない。 */
async function interleave(c: SimCluster, a: [string, unknown[]][], b: [string, unknown[]][]): Promise<string[]> {
  const [x, y] = [await new Db(c, { retries: 0 }).begin(), await new Db(c, { retries: 0 }).begin()];
  const out: string[] = [];
  try {
    for (const [sql, params] of a) await x.query(sql, params as never);
    for (const [sql, params] of b) await y.query(sql, params as never);
  } catch (e) {
    out.push(`statement: ${(e as Error).message}`);
  }
  for (const tx of [x, y]) out.push(await tx.commit().then(() => "committed", (e: Error) => e.message));
  return out;
}

describe("transactions on one tenant of a table with a local UNIQUE", () => {
  it("both commit when they write different rows with different UNIQUE values", async () => {
    const { c } = await setup();
    expect(await interleave(c,
      [["INSERT INTO p(tenant_id, id, code) VALUES (1, 10, 'x')", []]],
      [["INSERT INTO p(tenant_id, id, code) VALUES (1, 11, 'y')", []]],
    )).toEqual(["committed", "committed"]);
    expect(await interleave(c,
      [["UPDATE p SET n = n + 1 WHERE tenant_id = 1 AND id = 1", []]],
      [["UPDATE p SET n = n + 1 WHERE tenant_id = 1 AND id = 2", []], ["DELETE FROM p WHERE tenant_id = 1 AND id = 3", []]],
    )).toEqual(["committed", "committed"]);
    expect(await quiescentProblems(c)).toEqual([]);
    expect(c.spanEscapes).toEqual([]);
  });

  it("do not both commit when they insert the same UNIQUE value", async () => {
    const { c } = await setup();
    const out = await interleave(c,
      [["INSERT INTO p(tenant_id, id, code) VALUES (1, 10, 'x')", []]],
      [["INSERT INTO p(tenant_id, id, code) VALUES (1, 11, 'x')", []]],
    );
    expect(out.filter((o) => o === "committed").length).toBe(1);
    expect((await new Db(c).query("SELECT count(*) AS n FROM p WHERE code = 'x'")).rows).toEqual([{ n: 1 }]);
    expect(await quiescentProblems(c)).toEqual([]);
  });

  it("an insert conflicts with a concurrent delete of the row that held its UNIQUE value", async () => {
    // 片方が 'c1' の行を消し、もう片方が 'c1' を入れ直す。入れる側は、消える前の行を読んで UNIQUE 違反になるか、
    // 消した後で通るかのどちらかで、両方が「何も起きなかった」ことにはならない。
    const { c } = await setup();
    const out = await interleave(c,
      [["DELETE FROM p WHERE tenant_id = 1 AND id = 1", []]],
      [["INSERT OR IGNORE INTO p(tenant_id, id, code) VALUES (1, 12, 'c1')", []]],
    );
    const rows = (await new Db(c).query("SELECT id FROM p WHERE code = 'c1'")).rows;
    // 順に並べた実行は 2 通り。消してから入れる (12 が残る)。入れようとして無視されてから消す (どちらも残らない)。
    if (out[0] === "committed" && out[1] === "committed") expect(rows).toEqual([]);
    else expect(rows.length).toBeLessThanOrEqual(1);
    expect(await quiescentProblems(c)).toEqual([]);
    expect(c.spanEscapes).toEqual([]);
  });

  it("covers the shapes whose UNIQUE reads are not known from the statement", async () => {
    const { c, db } = await setup();
    await db.query("UPDATE p SET n = id WHERE tenant_id = 1");
    await db.ddl("CREATE UNIQUE INDEX p_live ON p(tenant_id, n) WHERE gone IS NULL");
    // 値が式で決まる INSERT、UNIQUE の列を書く UPDATE、条件付きの UNIQUE に行を入れる UPDATE、UPSERT、REPLACE。
    await db.query("INSERT INTO p(tenant_id, id, code, n) VALUES (1, 20, 'c' || '9', 20)");
    await expect(db.query("INSERT INTO p(tenant_id, id, code, n) VALUES (1, 21, 'c' || '1', 21)")).rejects.toThrow(/UNIQUE/);
    await expect(db.query("UPDATE p SET code = 'c2' WHERE tenant_id = 1 AND id = 1")).rejects.toThrow(/UNIQUE/);
    // 1 を index から外し、2 に同じ n を持たせる。1 を index へ戻す UPDATE は、UNIQUE の列に触らないのに、2 の行と衝突する。
    await db.query("UPDATE p SET gone = 1 WHERE tenant_id = 1 AND id = 1");
    await db.query("UPDATE p SET n = 1 WHERE tenant_id = 1 AND id = 2");
    await expect(db.query("UPDATE p SET gone = NULL WHERE tenant_id = 1 AND id = 1")).rejects.toThrow(/UNIQUE/);
    await db.query("INSERT INTO p(tenant_id, id, code, n) VALUES (1, 22, 'c2', 22) ON CONFLICT (tenant_id, code) DO UPDATE SET n = 99");
    await db.query("INSERT OR REPLACE INTO p(tenant_id, id, code, n) VALUES (1, 23, 'c3', 23)");
    await db.transaction(async (tx) => {
      await tx.query("INSERT OR IGNORE INTO p(tenant_id, id, code, n) VALUES (1, 24, 'c4', 24)");
      await tx.query("UPDATE p SET code = 'zz' WHERE tenant_id = 1 AND id = 4");
    });
    expect(c.spanEscapes).toEqual([]);
    expect((await db.query("SELECT id, code, n, gone FROM p WHERE tenant_id = 1 ORDER BY id")).rows).toEqual([
      { id: 1, code: "c1", n: 1, gone: 1 }, { id: 2, code: "c2", n: 99, gone: null }, { id: 4, code: "zz", n: 4, gone: null },
      { id: 20, code: "c9", n: 20, gone: null }, { id: 23, code: "c3", n: 23, gone: null },
    ]);
  });
});
