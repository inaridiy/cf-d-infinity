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

  it("CREATE UNIQUE INDEX that runs out of calls says so, and the index is not used", async () => {
    const c = await seeded(1200);
    const first = capped(c, 150);
    expect(await outcome(new Db(first.cluster).query("CREATE UNIQUE INDEX people_email ON people(email)"))).toMatch(/too many rows to index within one request/);
    expect((await c.catalog()).tables.people!.globalIndexes.find((g) => g.name === "people_email")?.state).toBe("writeOnly");
    await new Db(c).query("DROP INDEX people_email");
    expect((await c.catalog()).tables.people!.globalIndexes).toEqual([]);
  }, 120_000);
});
