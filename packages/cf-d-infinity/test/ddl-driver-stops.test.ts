// 表定義の変更を進める側 (DDL を出した Worker の 1 回の呼び出し) が、どの手の前で止まっても、文は効いたか効かなかったかのどちらかで、
// クラスタは使えるままである (docs/design-catalog-epoch.md の段 3 の「落ちてから通る検査」。止め方は test/ddl-driver.ts)。
// 場面は、行のある表へのシャードをまたぐ UNIQUE の index と、取引が読んだ表の DROP である。行で失敗する DDL の場面は、
// test/open/ddl-driver-stops-failing-ddl.test.ts にある (段 3 より前のコードでは落ちる)。
import { describe, expect, it } from "vitest";
import { Db } from "../src/client/db";
import { indexAgreement } from "./ddl-harness";
import { outcome, settled, stopsEverywhere, twoShards, type Scenario } from "./ddl-driver";
import { SimCluster } from "./sim";

const SCENARIOS: Scenario[] = [
  {
    name: "a UNIQUE index across shards built from existing rows",
    async setup() {
      const { c, db, bad, good } = await twoShards();
      await db.query("INSERT INTO p VALUES (?, 1, 'a', NULL), (?, 2, 'b', NULL), (?, 1, 'c', NULL)", [bad, bad, good]);
      return {
        c,
        run: (d) => d.ddl("CREATE UNIQUE INDEX ux ON p(code)"),
        // index は、出来上がって全部の行を引けるか、どこにもないかのどちらかである。
        async check(c) {
          const other = new Db(c);
          const wrote = await outcome(other.query("INSERT INTO p VALUES (?, 5, 'e', NULL)", [good]));
          // 消した index の表は、そのシャードが表定義を適用するときに消える。まだ適用していないシャードに残る表は数えない。
          await settled(c);
          const listed = (await c.catalog()).indexes.ux !== undefined;
          const report = await indexAgreement(c, "p", "ux");
          const dup = await outcome(other.query("INSERT INTO p VALUES (?, 6, 'a', NULL)", [good]));
          const whole = listed
            ? report.state === "public" && report.missing.length === 0 && report.dangling.length === 0 && report.wrongRead.length === 0 && /UNIQUE constraint failed/.test(dup)
            : report.state === null && report.leftover.length === 0 && dup === "ok";
          return { wrote, whole, ...(whole ? {} : { listed, report, dup }) };
        },
      };
    },
    expected: () => ({ wrote: "ok", whole: true }),
  },
  {
    name: "a DROP TABLE of a table the same batch read",
    async setup() {
      const c = new SimCluster({ shards: 2 });
      const db = new Db(c);
      await db.ddl("CREATE TABLE t(id INTEGER PRIMARY KEY, n INTEGER)");
      await db.query("INSERT INTO t VALUES (1, 1), (2, 2), (3, 3), (4, 4)");
      return {
        c,
        run: (d) => d.batch([{ sql: "SELECT count(*) AS n FROM t" }, { sql: "DROP TABLE t" }]),
        // 表は、消えたか、全部の行を持ったまま書けるかのどちらかである。
        async check(c) {
          const other = new Db(c);
          if (!(await c.catalog()).tables.t) return { gone: true, read: /no such table/.test(await outcome(other.query("SELECT 1 FROM t"))) };
          const wrote = await outcome(other.query("INSERT INTO t VALUES (5, 5)"));
          const rows = (await other.query("SELECT id FROM t ORDER BY id")).rows.map((r) => r.id);
          return { gone: false, wrote, rows };
        },
      };
    },
    expected: (r) => (r.gone ? { gone: true, read: true } : { gone: false, wrote: "ok", rows: [1, 2, 3, 4, 5] }),
  },
];

describe("a schema change whose driver stops before one of its steps", () => {
  for (const s of SCENARIOS) {
    it(`${s.name}: takes effect whole or not at all, and the cluster stays usable, wherever the driver stops`, async () => {
      expect((await stopsEverywhere(s)).length).toBeGreaterThan(3);
    });
  }
});
