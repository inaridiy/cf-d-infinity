// 乱数で文を生成して本物の SQLite と比べる。手書きのスクリプトが踏まない組み合わせを探す。
import { describe, expect, it } from "vitest";
import { diff } from "./diff";

function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

const SCHEMA = `
CREATE TABLE t1(id INTEGER PRIMARY KEY, a INTEGER, b TEXT);
CREATE TABLE t2(k TEXT PRIMARY KEY, a INTEGER, c REAL);
CREATE TABLE t3(x INTEGER, y INTEGER, v TEXT, PRIMARY KEY (x, y));
CREATE TABLE t4(id INTEGER PRIMARY KEY, u TEXT UNIQUE, n INTEGER NOT NULL DEFAULT 0);
CREATE INDEX i1 ON t1(a);
CREATE INDEX i3 ON t3(x, v);
`;

function script(seed: number, length: number): string {
  const r = prng(seed);
  const n = (m: number) => Math.floor(r() * m);
  const pick = <T,>(xs: T[]) => xs[n(xs.length)]!;
  const num = () => (r() < 0.1 ? "NULL" : String(n(12)));
  const str = () => (r() < 0.1 ? "NULL" : `'${pick(["a", "b", "c", "d", "e"])}'`);
  const key = () => `'k${n(8)}'`;
  const cmp = () => pick(["=", "<", ">", "<=", ">=", "<>"]);
  const cond1 = () => pick([
    `id ${cmp()} ${n(12)}`, `a ${cmp()} ${n(12)}`, `b = ${str()}`, `a IS NULL`, `b IS NOT NULL`,
    `id IN (${n(12)}, ${n(12)})`, `a BETWEEN ${n(6)} AND ${n(12)}`, `b LIKE 'a%'`,
    `id = ${n(12)} OR a = ${n(12)}`, `NOT a = ${n(12)}`, `a IN (SELECT a FROM t2 WHERE c > ${n(10)})`,
    `id IN (SELECT x FROM t3)`, `EXISTS (SELECT 1 FROM t2 WHERE t2.a = t1.a)`,
  ]);
  const stmts: (() => string)[] = [
    () => `INSERT INTO t1 VALUES (${n(12)}, ${num()}, ${str()})`,
    () => `INSERT OR IGNORE INTO t1 VALUES (${n(12)}, ${num()}, ${str()})`,
    () => `INSERT OR REPLACE INTO t1 VALUES (${n(12)}, ${num()}, ${str()})`,
    () => `INSERT INTO t1 VALUES (${n(12)}, ${num()}, ${str()}) ON CONFLICT(id) DO UPDATE SET a = coalesce(a, 0) + 1`,
    () => `INSERT INTO t2 VALUES (${key()}, ${num()}, ${n(10)}.5)`,
    () => `INSERT OR REPLACE INTO t2 VALUES (${key()}, ${num()}, ${n(10)}.25)`,
    () => `INSERT INTO t3 VALUES (${n(4)}, ${n(4)}, ${str()})`,
    () => `INSERT INTO t3 VALUES (${n(4)}, ${n(4)}, ${str()}), (${n(4)}, ${n(4)}, ${str()})`,
    () => `INSERT INTO t4(id, u, n) VALUES (${n(10)}, ${str()}, ${n(5)})`,
    () => `UPDATE t1 SET a = ${num()} WHERE ${cond1()}`,
    () => `UPDATE t1 SET b = ${str()} WHERE id = ${n(12)}`,
    () => `UPDATE t1 SET a = (SELECT count(*) FROM t3) WHERE id = ${n(12)}`,
    () => `UPDATE t1 SET id = id + 20 WHERE id = ${n(12)}`,
    () => `UPDATE t2 SET a = coalesce(a, 0) + 1 WHERE k = ${key()}`,
    () => `UPDATE t3 SET v = ${str()} WHERE x = ${n(4)}`,
    () => `UPDATE t4 SET u = ${str()} WHERE id = ${n(10)}`,
    () => `DELETE FROM t1 WHERE ${cond1()}`,
    () => `DELETE FROM t2 WHERE a ${cmp()} ${n(12)}`,
    () => `DELETE FROM t3 WHERE x = ${n(4)} AND y = ${n(4)}`,
    () => `DELETE FROM t4 WHERE id = ${n(10)}`,
    () => `SELECT * FROM t1 WHERE ${cond1()} ORDER BY id`,
    () => `SELECT * FROM t1 ORDER BY id`,
    () => `SELECT * FROM t2 ORDER BY k`,
    () => `SELECT * FROM t3 ORDER BY x, y`,
    () => `SELECT id, u, n FROM t4 ORDER BY id`,
    () => `SELECT id FROM t4 WHERE u = ${str()}`,
    () => `SELECT count(*), sum(a), min(a), max(a), avg(a) FROM t1`,
    () => `SELECT a, count(*) FROM t1 GROUP BY a ORDER BY a`,
    () => `SELECT b, sum(a) s FROM t1 GROUP BY b HAVING s > ${n(5)} ORDER BY b`,
    () => `SELECT t1.id, t3.v FROM t1 JOIN t3 ON t3.x = t1.id ORDER BY 1, 2`,
    () => `SELECT t1.id, t2.k FROM t1 LEFT JOIN t2 ON t2.a = t1.a WHERE ${pick(["t2.k IS NULL", "t2.a > 1", "t1.a > 1"])} ORDER BY 1, 2`,
    () => `SELECT t1.id, t2.k FROM t1 LEFT JOIN t2 ON t2.a = t1.a AND t2.c > ${n(5)} ORDER BY 1, 2`,
    () => `SELECT x, count(*) FROM t3 GROUP BY x ORDER BY x`,
    () => `SELECT DISTINCT a FROM t1 ORDER BY a`,
    () => `SELECT id, a FROM t1 ORDER BY a DESC, id LIMIT ${1 + n(4)} OFFSET ${n(3)}`,
    () => `SELECT id, row_number() OVER (ORDER BY id) r FROM t1 ORDER BY id`,
    () => `SELECT id FROM t1 UNION SELECT x FROM t3 ORDER BY 1`,
    () => `WITH c AS (SELECT a, count(*) n FROM t1 GROUP BY a) SELECT * FROM c ORDER BY a`,
    () => `BEGIN`,
    () => `COMMIT`,
    () => `ROLLBACK`,
  ];
  const out = [SCHEMA.trim()];
  for (let i = 0; i < length; i++) out.push(`${pick(stmts)()};`);
  return out.join("\n");
}

const SEEDS = Number(process.env.FUZZ_SEEDS ?? 12);
const LENGTH = Number(process.env.FUZZ_LENGTH ?? 60);

describe("random statements against real SQLite", () => {
  for (let seed = 1; seed <= SEEDS; seed++) {
    it(`seed ${seed}`, async () => {
      const problems = await diff(script(seed, LENGTH), 1 + (seed % 6), [
        "SELECT * FROM t1 ORDER BY id", "SELECT * FROM t2 ORDER BY k", "SELECT * FROM t3 ORDER BY x, y", "SELECT id, u, n FROM t4 ORDER BY id",
      ]);
      expect(problems.slice(0, 3).join("\n\n")).toBe("");
    }, 120000);
  }
});
