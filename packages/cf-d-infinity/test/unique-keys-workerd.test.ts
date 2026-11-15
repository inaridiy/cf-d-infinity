// 照合順序のキーの検査 (docs/design-unique-keys.md の段 0 の (a)) を、手元の workerd (Miniflare) の DO の SQLite で流す。
// node:sqlite と sql.js では test/unique-keys.test.ts が流す。部品と比べ方は test/unique-keys.ts にある。
//
// D∞ の Worker は使わない。DO の SQLite に文をそのまま流す小さな Worker (test/workerd-probe.ts) を使う。手元の workerd の結果で、
// 本番の Cloudflare の結果ではない。キーの形は公開の後に変えられないので、本番の DO の SQLite でも、承認された Cloudflare での計測で
// 流す (設計書の「決めたこと」の 7)。
import type { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BROKEN, collect, corpus, engineDifferences, judgeAll, nodeEngine, referenceKey, setups, type Engine } from "./unique-keys";
import { probe, type Cell } from "./workerd-probe";

const instances: Miniflare[] = [];
afterAll(async () => {
  for (const mf of instances) await mf.dispose();
});

/** DO の SQLite。全部の呼び出しを同じ DO に送る (object を渡さないと、呼び出しごとに空の DO になる)。 */
function workerdEngine(): Engine {
  const p = probe();
  instances.push(p.mf);
  const text = (c: Cell): string | null => (c[0] === "null" ? null : c[0] === "blob" ? `x'${c[1]}'` : String(c[1]));
  return {
    name: "workerd",
    run: async (sqls) => {
      const out = await p.run(sqls.map((sql) => ({ sql })), "unique-keys");
      return out.map((r, k) => {
        if (r.error !== undefined) throw new Error(`workerd: ${sqls[k]!.slice(0, 200)}: ${r.error}`);
        return r.rows.map((row) => row.map(text));
      });
    },
  };
}

describe("the collation key oracle, on the Durable Object SQLite of local workerd", () => {
  const values = corpus();
  let workerd: Awaited<ReturnType<typeof collect>>;
  let node: Awaited<ReturnType<typeof collect>>;
  beforeAll(async () => {
    workerd = await collect(workerdEngine(), values);
    node = await collect(nodeEngine(), values);
  }, 60_000);

  it("stores every value as it was written", () => {
    expect(workerd.loaded).toEqual([]);
  });

  it("sees the UNIQUE index and = agree", () => {
    expect(workerd.self).toEqual([]);
  });

  it("sees the same classes as node:sqlite", () => {
    expect(setups(values).flatMap((s) => engineDifferences("workerd", workerd.classes.get(s.name)!, "node:sqlite", node.classes.get(s.name)!, s))).toEqual([]);
  });

  it("passes the reference key function", () => {
    expect(judgeAll(referenceKey, "workerd", workerd.classes, values)).toEqual([]);
  });

  for (const [how, key] of Object.entries(BROKEN)) {
    it(`rejects a key function broken by ${how}`, () => {
      const problems = judgeAll(key, "workerd", workerd.classes, values);
      console.log(`UNIQUE-KEYS workerd rejects "${how}": ${problems.length} findings, first: ${problems[0]}`);
      expect(problems.length, how).toBeGreaterThan(0);
    });
  }
});
