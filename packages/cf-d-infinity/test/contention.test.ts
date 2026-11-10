// BEGIN で始めた取引の競合率を測る。CONTENTION=1 のときだけ動く。結果は docs/benchmarks.md にある。
import { describe, it } from "vitest";
import { SimCluster } from "./sim";
import { Db } from "../src/client/db";

const SHARDS = 8;
const MS = 4000;
type Tx = (db: Db, r: () => number) => Promise<void>;

async function scenario(name: string, setup: string[], clients: number, body: Tx, begin = "BEGIN") {
  const c = new SimCluster({ shards: SHARDS, now: () => Date.now() });
  const db = new Db(c, { idBlock: 1000 });
  for (const s of setup) await db.query(s);
  await c.settle();
  c.net.jitter = () => 12 + Math.random() * 4; // 本番の実測 RPC 約 14 ms
  let ok = 0;
  let busy = 0;
  const lat: number[] = [];
  const end = Date.now() + MS;
  await Promise.all(Array.from({ length: clients }, async () => {
    while (Date.now() < end) {
      const d = new Db(c, { idBlock: 1000 });
      const t0 = Date.now();
      try {
        await d.query(begin);
        await body(d, Math.random);
        await d.query("COMMIT");
        ok++;
        lat.push(Date.now() - t0);
      } catch (e) {
        const m = (e as Error).message;
        if (/^(conflict|read too old|not owner|migrating)/.test(m)) busy++;
        else throw e;
      }
    }
  }));
  const s = [...lat].sort((a, b) => a - b);
  console.log(`ABORT ${name.padEnd(46)} clients ${String(clients).padStart(3)}  ${(ok / (MS / 1000)).toFixed(0).padStart(5)} tx/s  busy ${((100 * busy) / (ok + busy)).toFixed(1).padStart(5)}%  p50 ${s[s.length >> 1]} ms`);
}

const seed = (n: number) => {
  const out = ["CREATE TABLE t(id INTEGER PRIMARY KEY, grp INTEGER, n INTEGER)"];
  for (let a = 0; a < n; a += 500) {
    out.push(`INSERT INTO t(id, grp, n) VALUES ${Array.from({ length: Math.min(500, n - a) }, (_, i) => `(${a + i + 1}, ${(a + i) % 100}, 0)`).join(",")}`);
  }
  return out;
};
const pick = (r: () => number, n: number) => 1 + Math.floor(r() * n);
const rmw = (n: number): Tx => async (d, r) => {
  const id = pick(r, n);
  await d.query("SELECT n FROM t WHERE id = ?", [id]);
  await d.query("UPDATE t SET n = n + 1 WHERE id = ?", [id]);
};

describe.skipIf(!process.env.CONTENTION)("contention", () => {
  it("abort rates", async () => {
    for (const clients of [10, 50]) {
      await scenario("BEGIN, 100 hot rows", seed(10000), clients, rmw(100));
      await scenario("BEGIN, 1 hot row", seed(10000), clients, rmw(1));
      await scenario("IMMEDIATE, 100 hot rows", seed(10000), clients, rmw(100), "BEGIN IMMEDIATE");
      await scenario("IMMEDIATE, 10 hot rows", seed(10000), clients, rmw(10), "BEGIN IMMEDIATE");
      await scenario("IMMEDIATE, 1 hot row", seed(10000), clients, rmw(1), "BEGIN IMMEDIATE");
      await scenario("IMMEDIATE, 10,000 rows, uniform", seed(10000), clients, rmw(10000), "BEGIN IMMEDIATE");
      await scenario("own row + read by a non-key column", seed(10000), clients, async (d, r) => {
        const id = pick(r, 10000);
        await d.query("SELECT count(*) FROM t WHERE grp = ?", [id % 100]);
        await d.query("UPDATE t SET n = n + 1 WHERE id = ?", [id]);
      });
    }
  }, 500000);
});
