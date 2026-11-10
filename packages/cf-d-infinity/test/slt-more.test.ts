import { DatabaseSync } from "node:sqlite";
import { existsSync, readdirSync } from "node:fs";
import { describe, it } from "vitest";
import { runSlt, type Engine } from "./slt/runner";
import { SimCluster } from "./sim";
import { Db } from "../src/client/db";

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

const dirs = ["evidence", "random", "index"].filter((d) => existsSync(`test/slt/${d}`));
const LIMIT = process.env.SLT_LIMIT ? Number(process.env.SLT_LIMIT) : 100000;

describe.skipIf(!process.env.SLT_MORE)("sqllogictest, the rest", () => {
  for (const d of dirs) {
    for (const f of readdirSync(`test/slt/${d}`)) {
      it(`${d}/${f}`, async () => {
        const path = `test/slt/${d}/${f}`;
        const base = await runSlt(path, oracle(), { limit: LIMIT });
        const db = new Db(new SimCluster({ shards: 4 }), { idBlock: 1000 });
        const r = await runSlt(path, { run: (sql) => db.query(sql) }, { limit: LIMIT });
        const top = [...r.errors.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => `${v}x ${k}`);
        if (process.env.SLT_VERBOSE) for (const x of r.samples.slice(0, 6)) console.log(`SAMPLE ${x.why}\n  ${x.sql}`);
        console.log(`RES ${d}/${f} oracle ${base.passed}/${base.queries}+${base.statements - base.statementFailures}/${base.statements} ours ${r.passed}/${r.queries}+${r.statements - r.statementFailures}/${r.statements} ${top.join(" | ")}`);
      }, 560000);
    }
  }
});
