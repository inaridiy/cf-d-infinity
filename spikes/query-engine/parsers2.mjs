import { parse, show } from "sql-parser-cst";
const opts = { dialect: "sqlite", paramTypes: ["?", "?nr", ":name", "@name", "$name"], includeRange: true };
for (const s of [`SELECT * FROM t WHERE id = ? AND n > ?2 AND g = :g`, `SELECT * FROM (VALUES (1, 'a'), (2, 'b')) AS v(id, name)`, `SELECT * FROM (VALUES (1, 'a'), (2, 'b')) v`, `INSERT INTO t(id, n) VALUES (1, 2) ON CONFLICT(id) DO UPDATE SET n = n + excluded.n RETURNING id`]) {
  try { const c = parse(s, opts); console.log("ok  ", show(c) === s ? "roundtrip=same" : "roundtrip=diff", "|", s.slice(0, 60)); } catch (e) { console.log("FAIL", s.slice(0, 60), "->", String(e.message).split("\n")[0].slice(0, 80)); }
}
// 解析時間
const sql = `WITH a AS (SELECT id, sum(n) s FROM t WHERE g = ? GROUP BY id HAVING s > 1) SELECT a.id, row_number() OVER (ORDER BY a.s DESC) rn FROM a JOIN u ON u.id = a.id WHERE u.s LIKE 'x%' ORDER BY rn LIMIT 10`;
let t0 = performance.now(); for (let i = 0; i < 2000; i++) parse(sql, opts); console.log("sql-parser-cst parse avg us:", ((performance.now() - t0) / 2000 * 1000).toFixed(0));
import nspPkg from "node-sql-parser"; const nsp = new nspPkg.Parser();
t0 = performance.now(); for (let i = 0; i < 2000; i++) nsp.astify(`SELECT a.id, count(*) c FROM a JOIN u ON u.id = a.id WHERE u.s LIKE 'x%' GROUP BY a.id ORDER BY c LIMIT 10`, { database: "sqlite" }); console.log("node-sql-parser parse avg us:", ((performance.now() - t0) / 2000 * 1000).toFixed(0));
