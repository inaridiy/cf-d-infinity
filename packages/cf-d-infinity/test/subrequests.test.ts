// Worker の 1 回の呼び出しは、限られた数の要求 (subrequest) しか出せない。Durable Object の呼び出しもそれに数えられる。
// 行数に比例して往復する文は、表が育つと必ずその上限に当たる。ここでは、Db が使う Cluster の呼び出しを数えて、
// 上限を超えたら失敗させ、長い文がどう振る舞うかを確かめる。
import { describe, expect, it } from "vitest";
import { Db, type Cluster } from "../src/client/db";
import type { ShardApi } from "../src/types";
import { indexAgreement } from "./ddl-harness";
import { SimCluster } from "./sim";

function capped(c: SimCluster, limit: number): { cluster: Cluster; used: () => number } {
  let n = 0;
  const hit = () => {
    if (++n > limit) throw new Error("Too many subrequests.");
  };
  const cluster: Cluster = {
    shard: (id) => new Proxy({} as ShardApi, {
      get: (_t, method: keyof ShardApi) => async (req: never) => {
        hit();
        return (c.shard(id)[method] as (r: never) => Promise<unknown>)(req);
      },
    }),
    catalog: async () => (hit(), c.catalog()),
    applyDdl: async (sql, basedOn) => (hit(), c.applyDdl(sql, basedOn)),
    publishIndex: async (t, name, basedOn) => (hit(), c.publishIndex(t, name, basedOn)),
    backfillProgress: async (index, value) => (hit(), c.backfillProgress(index, value)),
    allocate: async (t, k, min) => (hit(), c.allocate(t, k, min)),
    switchRange: async (m) => (hit(), c.switchRange(m)),
  };
  return { cluster, used: () => n };
}

async function seeded(rows: number): Promise<SimCluster> {
  const c = new SimCluster({ shards: 4 });
  await c.client().ddl("CREATE TABLE people(id INTEGER PRIMARY KEY, email TEXT NOT NULL, city TEXT)");
  for (let i = 1; i <= rows; i += 50) {
    const n = Math.min(50, rows - i + 1);
    await new Db(c).query(`INSERT INTO people(id, email, city) VALUES ${Array.from({ length: n }, (_, k) => `(${i + k}, 'u${i + k}@example.com', 'c${(i + k) % 7}')`).join(", ")}`);
  }
  return c;
}
const outcome = (p: Promise<unknown>) => p.then(() => "ok", (e: Error) => e.message);

describe("statements that loop over rows, within one Worker invocation", () => {
  it("CREATE INDEX on a table with rows costs far fewer calls than it has rows", async () => {
    const c = await seeded(600);
    const plain = capped(c, Infinity);
    await new Db(plain.cluster).query("CREATE INDEX people_city ON people(city)");
    const unique = capped(c, Infinity);
    await new Db(unique.cluster).query("CREATE UNIQUE INDEX people_email ON people(email)");
    expect(plain.used()).toBeLessThan(300);
    expect(unique.used()).toBeLessThan(300);
    for (const name of ["people_city", "people_email"]) {
      const ix = await indexAgreement(c, "people", name);
      expect({ state: ix.state, missing: ix.missing, dangling: ix.dangling }).toEqual({ state: "public", missing: [], dangling: [] });
    }
  }, 120_000);

  it("CREATE INDEX that runs out of calls says so, and the same statement run again continues where it stopped", async () => {
    const c = await seeded(1200);
    const first = capped(c, 150);
    expect(await outcome(new Db(first.cluster).query("CREATE INDEX people_city ON people(city)"))).toMatch(/Run the same statement again/);
    expect((await c.catalog()).tables.people!.globalIndexes.find((g) => g.name === "people_city")?.state).toBe("writeOnly");
    // 出し直すたびに先へ進む。先頭からやり直すなら、同じ上限では何度やっても終わらない。
    let runs = 1;
    for (; runs < 20; runs++) {
      if ((await outcome(new Db(capped(c, 150).cluster).query("CREATE INDEX people_city ON people(city)"))) === "ok") break;
    }
    expect(runs).toBeLessThan(10);
    const ix = await indexAgreement(c, "people", "people_city");
    expect({ state: ix.state, missing: ix.missing, dangling: ix.dangling }).toEqual({ state: "public", missing: [], dangling: [] });
    expect((await new Db(c).query("SELECT count(*) AS n FROM people WHERE city = 'c3'")).rows).toEqual([{ n: Math.floor((1200 + 4) / 7) }]);
    expect(await c.backfillProgress("people_city")).toBeNull();
  }, 120_000);

  it("CREATE TABLE ... AS SELECT inserts in batches, and leaves no table behind when it fails", async () => {
    const c = await seeded(1200);
    const w = capped(c, 400);
    expect(await outcome(new Db(w.cluster).query("CREATE TABLE copy AS SELECT id, email FROM people"))).toBe("ok");
    expect((await new Db(c).query("SELECT count(*) AS n FROM copy")).rows).toEqual([{ n: 1200 }]);
    // 行を入れている途中で失敗させる。表ごと消えていること。
    const drop = c.net.drop;
    let inserts = 0;
    c.net.drop = (m) => m.method === "prepare" && ++inserts > 3;
    const failed = await outcome(new Db(c, { retries: 0 }).query("CREATE TABLE copy2 AS SELECT id, email FROM people"));
    c.net.drop = drop;
    expect(failed).not.toBe("ok");
    expect((await c.catalog()).tables.copy2).toBeUndefined();
  }, 120_000);
});
