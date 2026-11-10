import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runSlt, type Engine, type Report } from "./slt/runner";
import { SimCluster } from "./sim";
import { Db } from "../src/client/db";

const FILES = ["select1", "select2", "select3", "select4", "select5"];
const LIMIT = process.env.SLT_LIMIT ? Number(process.env.SLT_LIMIT) : 150;
const have = existsSync("test/slt/select1.test");

const oracle = (): Engine => {
  const db = new DatabaseSync(":memory:");
  return {
    async run(sql) {
      const st = db.prepare(sql);
      if (st.columns().length === 0) {
        st.run();
        return { values: [] };
      }
      st.setReturnArrays(true);
      return { values: st.all() as unknown as unknown[][] };
    },
  };
};

const ours = (shards: number): Engine => {
  const db = new Db(new SimCluster({ shards }), { idBlock: 1000 });
  return { run: (sql) => db.query(sql) };
};

const summary = (name: string, r: Report) => {
  const top = [...r.errors.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  console.log(`${name}: queries ${r.passed}/${r.queries}, statements ${r.statements - r.statementFailures}/${r.statements}`);
  for (const [k, v] of top) console.log(`   ${v} x ${k}`);
  if (process.env.SLT_VERBOSE) for (const s of r.samples.slice(0, 5)) console.log(`   ! ${s.why}\n     ${s.sql}`);
};

describe.skipIf(!have)("sqllogictest", () => {
  for (const f of FILES) {
    it(`${f} on real SQLite (checks the runner itself)`, async () => {
      const r = await runSlt(`test/slt/${f}.test`, oracle(), { limit: LIMIT });
      summary(`oracle ${f}`, r);
      expect(r.failed).toBe(0);
    }, 600000);
    it(`${f} on 4 shards`, async () => {
      const r = await runSlt(`test/slt/${f}.test`, ours(4), { limit: LIMIT });
      summary(`shards ${f}`, r);
      expect(r.failed).toBe(0);
      expect(r.statementFailures).toBe(0);
    }, 600000);
  }
});
