// Worker の 1 回の呼び出しは、限られた数の要求 (subrequest) しか出せない。Durable Object の呼び出しもそれに数えられる。
// 行数に比例して往復する文は、表が育つと必ずその上限に当たる。ここでは、Db が使う Cluster の呼び出しを数えて、
// 上限を超えたら失敗させ、長い文がどう振る舞うかを確かめる。
import { describe, expect, it } from "vitest";
import { Db, type Cluster } from "../src/client/db";
import type { ShardApi } from "../src/types";
import { indexAgreement, touchAll } from "./ddl-harness";
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
    publishIndex: async (t, name, version, at) => (hit(), c.publishIndex(t, name, version, at)),
    revokeDdl: async (version, reason) => (hit(), c.revokeDdl(version, reason)),
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
    // 一意でない index は各シャードの中の index なので、埋める作業がない。
    expect((await c.catalog()).indexes.people_city).toEqual({ table: "people", global: false });
    const ix = await indexAgreement(c, "people", "people_email");
    expect({ state: ix.state, missing: ix.missing, dangling: ix.dangling }).toEqual({ state: "public", missing: [], dangling: [] });
  }, 120_000);

  it("CREATE UNIQUE INDEX that runs out of calls says so, and the table is left as it was", async () => {
    const c = await seeded(1200);
    const first = capped(c, 30);
    expect(await outcome(new Db(first.cluster).query("CREATE UNIQUE INDEX people_email ON people(email)"))).toMatch(/too many rows to index within one request/);
    // 取り消しの要求も出せなかった。期限が来るまで、表は書き込み禁止のままである。
    expect((await c.catalog()).tables.people!.building?.name).toBe("people_email");
    // 書き込みは待つ。期限が来れば Meta が取り消し、待っていた書き込みが通る。
    await new Db(c).query("INSERT INTO people(id, email, city) VALUES (5000, 'u1@example.com', 'c1')");
    const cat = await c.catalog();
    expect({ building: cat.tables.people!.building, built: cat.tables.people!.globalIndexes, listed: cat.indexes.people_email })
      .toEqual({ building: undefined, built: [], listed: undefined });
    // 取り消しを適用したシャードには、index の表が残らない。同じ email の行が 2 つ入った。
    await touchAll(c);
    expect((await indexAgreement(c, "people", "people_email")).leftover).toEqual([]);
    expect((await new Db(c).query("SELECT count(*) AS n FROM people WHERE email = 'u1@example.com'")).rows).toEqual([{ n: 2 }]);
  }, 120_000);
});
