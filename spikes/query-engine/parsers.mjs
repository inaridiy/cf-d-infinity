// SQLite 構文のパーサ比較。各候補に同じ文を食わせ、成功/失敗を表にする。
import nspPkg from "node-sql-parser";
const NSP = nspPkg.Parser;
import { parse as cstParse } from "sql-parser-cst";
import { parse as pgParse } from "pgsql-ast-parser";
import sqliteParser from "sqlite-parser";

const stmts = {
  upsert: `INSERT INTO t(id, n) VALUES (1, 2) ON CONFLICT(id) DO UPDATE SET n = n + excluded.n`,
  insertOrReplace: `INSERT OR REPLACE INTO t(id, n) VALUES (1, 2)`,
  returning: `UPDATE t SET n = n + 1 WHERE id = 1 RETURNING id, n`,
  deleteReturning: `DELETE FROM t WHERE n < 0 RETURNING *`,
  updateFrom: `UPDATE t SET n = s.m FROM (SELECT id, max(n) m FROM t GROUP BY id) s WHERE t.id = s.id`,
  windowOrderOnly: `SELECT id, row_number() OVER (ORDER BY n DESC) rn FROM t`,
  windowPartition: `SELECT id, sum(n) OVER (PARTITION BY g ORDER BY id ROWS BETWEEN 1 PRECEDING AND CURRENT ROW) s FROM t`,
  cte: `WITH a AS (SELECT id FROM t WHERE n > 1) SELECT count(*) FROM a JOIN t USING (id)`,
  recursiveCte: `WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 10) SELECT sum(x) FROM c`,
  filterAgg: `SELECT g, count(*) FILTER (WHERE n > 0) c FROM t GROUP BY g HAVING c > 1`,
  jsonArrow: `SELECT j ->> '$.a' a, json_extract(j, '$.b') b FROM t WHERE j -> '$.c' IS NOT NULL`,
  collateNulls: `SELECT * FROM t ORDER BY name COLLATE NOCASE ASC NULLS LAST LIMIT 10 OFFSET 5`,
  isDistinct: `SELECT * FROM t WHERE a IS NOT b AND c GLOB 'x*' AND d LIKE 'y%' ESCAPE '\\'`,
  createStrict: `CREATE TABLE t2 (id INTEGER NOT NULL, n INTEGER, j TEXT, PRIMARY KEY (id)) STRICT, WITHOUT ROWID`,
  partialIndex: `CREATE INDEX ix ON t(n) WHERE n > 0`,
  exprIndex: `CREATE UNIQUE INDEX ux ON t(lower(name))`,
  insertSelect: `INSERT INTO t2(id, n) SELECT id, n FROM t WHERE n > 5`,
  subqueryFrom: `SELECT x.id FROM (SELECT id FROM t WHERE n > 1) x JOIN t ON t.id = x.id`,
  caseCast: `SELECT CASE WHEN n > 0 THEN 'p' ELSE 'n' END k, CAST(n AS TEXT) || '!' s FROM t`,
  values: `SELECT * FROM (VALUES (1, 'a'), (2, 'b')) AS v(id, name)`,
  exists: `SELECT id FROM t WHERE EXISTS (SELECT 1 FROM t2 WHERE t2.id = t.id) AND n IN (1, 2, 3)`,
  unionOrder: `SELECT id FROM t UNION SELECT id FROM t2 ORDER BY id LIMIT 3`,
  params: `SELECT * FROM t WHERE id = ? AND n > ?2 AND g = :g`,
};

const nsp = new NSP();
const candidates = {
  "node-sql-parser(sqlite)": (s) => nsp.astify(s, { database: "sqlite" }),
  "sql-parser-cst(sqlite)": (s) => cstParse(s, { dialect: "sqlite", includeSpaces: false }),
  "pgsql-ast-parser": (s) => pgParse(s),
  "sqlite-parser": (s) => sqliteParser(s),
};
const names = Object.keys(candidates);
const rows = [];
const score = Object.fromEntries(names.map((n) => [n, 0]));
for (const [k, sql] of Object.entries(stmts)) {
  const r = [k];
  for (const n of names) {
    try { candidates[n](sql); r.push("ok"); score[n]++; } catch (e) { r.push("x"); }
  }
  rows.push(r);
}
const w = Math.max(...Object.keys(stmts).map((k) => k.length));
console.log(["stmt".padEnd(w), ...names].join(" | "));
for (const r of rows) console.log([r[0].padEnd(w), ...r.slice(1).map((x, i) => x.padEnd(names[i].length))].join(" | "));
console.log("score:", score, "of", Object.keys(stmts).length);
// 軽量パーサの材料: sql-parser-cst の CST から表名と等値条件を抜く例
const cst = cstParse(stmts.subqueryFrom, { dialect: "sqlite" });
const tables = [];
(function walk(n) { if (!n || typeof n !== "object") return; if (Array.isArray(n)) return n.forEach(walk);
  if (n.type === "identifier" && n.name && n.__tbl) tables.push(n.name);
  if (n.type === "join_expr" || n.type === "from_clause") {}
  for (const k of Object.keys(n)) walk(n[k]); })(cst);
console.log("cst root type:", cst.type, "stmts:", cst.statements.map((s) => s.type));
