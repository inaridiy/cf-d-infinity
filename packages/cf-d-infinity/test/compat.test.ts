// 本物の SQLite と同じ文を流して 1 文ずつ突き合わせる差分テスト。
// 置き換えの判定基準であり、結果の値、列名、エラーになるかどうかを比べる。
import { describe, expect, it } from "vitest";
import { diff } from "./diff";

const SCRIPTS: Record<string, string> = {
  "compound SELECT beyond the Durable Object limit of 5 terms": `
CREATE TABLE cs(tenant_id INTEGER NOT NULL, id INTEGER NOT NULL, n INTEGER, PRIMARY KEY (tenant_id, id));
INSERT INTO cs VALUES (1, 1, 10), (1, 2, 20), (2, 1, 30);
SELECT n FROM cs WHERE tenant_id = 1 AND id = 1 UNION ALL SELECT n FROM cs WHERE tenant_id = 1 AND id = 2 UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3;
SELECT n FROM cs WHERE tenant_id = 1 AND id = 1 UNION ALL SELECT n FROM cs WHERE tenant_id = 1 AND id = 2 UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5;
SELECT n FROM cs WHERE tenant_id = 1 UNION SELECT n + 1 FROM cs WHERE tenant_id = 1 UNION SELECT 7 UNION SELECT 8 UNION SELECT 9 UNION SELECT 10 EXCEPT SELECT 9 ORDER BY 1;
SELECT * FROM (VALUES (1), (2), (3), (4), (5), (6), (7), (8)) ORDER BY 1;
INSERT INTO cs VALUES (1, 3, 1), (1, 4, 1), (1, 5, 1), (1, 6, 1), (1, 7, 1), (1, 8, 1), (1, 9, 1);
SELECT count(*) FROM cs WHERE tenant_id = 1;
`,
  "rowid tables and generated ids": `
CREATE TABLE t(a, b);
INSERT INTO t VALUES (1, 'x');
INSERT INTO t(b) VALUES ('y');
INSERT INTO t VALUES (3, 'z'), (4, 'w');
SELECT rowid, a, b FROM t ORDER BY rowid;
SELECT * FROM t ORDER BY rowid;
UPDATE t SET a = 10 WHERE b = 'y';
DELETE FROM t WHERE a = 3;
SELECT rowid, * FROM t ORDER BY rowid;
SELECT count(*) FROM t;
SELECT last_insert_rowid() IS NOT NULL;
`,
  "INTEGER PRIMARY KEY and AUTOINCREMENT": `
CREATE TABLE u(id INTEGER PRIMARY KEY, name TEXT);
INSERT INTO u(name) VALUES ('a');
INSERT INTO u(name) VALUES ('b');
INSERT INTO u(id, name) VALUES (10, 'c');
INSERT INTO u(name) VALUES ('d');
INSERT INTO u VALUES (NULL, 'e');
SELECT * FROM u ORDER BY id;
INSERT INTO u(id, name) VALUES (1, 'dup');
SELECT * FROM u WHERE id = 1;
SELECT * FROM u WHERE id = '1';
SELECT * FROM u WHERE id IN (1, 2, 10) ORDER BY id;
SELECT * FROM u WHERE rowid = 2;
CREATE TABLE a(id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT);
INSERT INTO a(v) VALUES ('x'), ('y');
SELECT * FROM a ORDER BY id;
DELETE FROM a WHERE id = 2;
INSERT INTO a(v) VALUES ('z');
SELECT * FROM a ORDER BY id;
`,
  "text, composite and WITHOUT ROWID keys": `
CREATE TABLE k(id TEXT PRIMARY KEY, v);
INSERT INTO k VALUES ('a', 1), ('b', 2);
SELECT * FROM k WHERE id = 'a';
INSERT INTO k VALUES ('a', 3);
INSERT OR IGNORE INTO k VALUES ('a', 3);
INSERT OR REPLACE INTO k VALUES ('a', 4);
SELECT * FROM k ORDER BY id;
CREATE TABLE c(x INTEGER, y TEXT, z, PRIMARY KEY (x, y));
INSERT INTO c VALUES (1, 'a', 10), (1, 'b', 20), (2, 'a', 30);
SELECT * FROM c WHERE x = 1 ORDER BY y;
SELECT * FROM c WHERE x = 1 AND y = 'b';
UPDATE c SET z = z + 1 WHERE x = 1;
SELECT sum(z) FROM c;
DELETE FROM c WHERE y = 'a';
SELECT * FROM c ORDER BY x, y;
CREATE TABLE w(a TEXT PRIMARY KEY, b) WITHOUT ROWID;
INSERT INTO w VALUES ('p', 1);
SELECT * FROM w;
`,
  "constraints and errors": `
CREATE TABLE e(id INTEGER PRIMARY KEY, n INTEGER NOT NULL, s TEXT UNIQUE, c INTEGER CHECK (c > 0), d TEXT DEFAULT 'def');
INSERT INTO e(n, s, c) VALUES (1, 'a', 1);
INSERT INTO e(n, s, c) VALUES (NULL, 'b', 1);
INSERT INTO e(n, s, c) VALUES (1, 'a', 1);
INSERT INTO e(n, s, c) VALUES (1, 'c', -1);
INSERT INTO e(n, s, c) VALUES (2, 'c', 2);
SELECT * FROM e ORDER BY id;
UPDATE e SET s = 'c' WHERE id = 1;
UPDATE e SET n = NULL WHERE id = 1;
SELECT nosuch FROM e;
SELECT * FROM nosuch;
INSERT INTO e(nosuch) VALUES (1);
INSERT INTO e VALUES (1, 2);
SELECT s FROM e WHERE s = 'c';
`,
  "upsert and returning": `
CREATE TABLE p(id INTEGER PRIMARY KEY, n INTEGER DEFAULT 0, s TEXT);
INSERT INTO p(id, n) VALUES (1, 1) ON CONFLICT(id) DO UPDATE SET n = n + 1;
INSERT INTO p(id, n) VALUES (1, 1) ON CONFLICT(id) DO UPDATE SET n = n + 1;
INSERT INTO p(id, n) VALUES (1, 5) ON CONFLICT(id) DO UPDATE SET n = excluded.n * 2;
INSERT INTO p(id, n) VALUES (1, 9) ON CONFLICT DO NOTHING;
SELECT * FROM p;
INSERT INTO p(id, n) VALUES (2, 2) RETURNING id, n;
INSERT INTO p(n) VALUES (3) RETURNING *;
UPDATE p SET n = n + 10 WHERE id = 2 RETURNING n;
UPDATE p SET s = 'all' RETURNING id;
DELETE FROM p WHERE id = 2 RETURNING id, n, s;
SELECT * FROM p ORDER BY id;
`,
  "multi-shard writes": `
CREATE TABLE m(id INTEGER PRIMARY KEY, g INTEGER, v INTEGER);
INSERT INTO m VALUES (1,1,1),(2,1,2),(3,2,3),(4,2,4),(5,3,5),(6,3,6),(7,4,7),(8,4,8);
UPDATE m SET v = v * 2 WHERE g = 2;
SELECT * FROM m ORDER BY id;
UPDATE m SET v = 0 WHERE v > 12;
DELETE FROM m WHERE g = 1;
SELECT count(*), sum(v) FROM m;
UPDATE m SET v = (SELECT max(v) FROM m) WHERE id = 3;
UPDATE m SET id = id + 100 WHERE id = 5;
SELECT * FROM m ORDER BY id;
DELETE FROM m WHERE id IN (SELECT id FROM m WHERE g = 4);
SELECT * FROM m ORDER BY id;
UPDATE m SET v = 1;
DELETE FROM m;
SELECT count(*) FROM m;
`,
  "joins, subqueries, CTE, views": `
CREATE TABLE a(id INTEGER PRIMARY KEY, x);
CREATE TABLE b(id INTEGER PRIMARY KEY, a_id INTEGER, y);
INSERT INTO a VALUES (1,'p'),(2,'q'),(3,'r');
INSERT INTO b VALUES (1,1,10),(2,1,20),(3,2,30),(4,NULL,40);
SELECT a.x, b.y FROM a JOIN b ON b.a_id = a.id ORDER BY b.y;
SELECT a.x, b.y FROM a LEFT JOIN b ON b.a_id = a.id ORDER BY a.id, b.y;
SELECT a.x, b.y FROM a LEFT JOIN b ON b.a_id = a.id WHERE b.y IS NULL;
SELECT a.x FROM a LEFT JOIN b ON b.a_id = a.id AND b.y > 15 WHERE a.id < 3 ORDER BY a.x, b.y;
SELECT a.id, b.id FROM a, b WHERE a.id = b.a_id ORDER BY 1, 2;
SELECT x, (SELECT count(*) FROM b WHERE b.a_id = a.id) c FROM a ORDER BY x;
SELECT x FROM a WHERE id IN (SELECT a_id FROM b WHERE y > 15) ORDER BY x;
SELECT x FROM a WHERE NOT EXISTS (SELECT 1 FROM b WHERE b.a_id = a.id);
WITH t AS (SELECT a_id, sum(y) s FROM b GROUP BY a_id) SELECT x, s FROM a JOIN t ON t.a_id = a.id ORDER BY s;
WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 5) SELECT sum(i) FROM n;
SELECT id FROM a UNION SELECT a_id FROM b ORDER BY 1;
SELECT id FROM a EXCEPT SELECT a_id FROM b;
SELECT id FROM a INTERSECT SELECT a_id FROM b;
SELECT s.c FROM (SELECT count(*) c FROM b) s;
CREATE VIEW v AS SELECT a.x, b.y FROM a JOIN b ON b.a_id = a.id;
SELECT * FROM v ORDER BY y;
SELECT x, sum(y) FROM v GROUP BY x ORDER BY x;
DROP VIEW v;
SELECT * FROM v;
`,
  "aggregates and window functions": `
CREATE TABLE s(id INTEGER PRIMARY KEY, g TEXT, n REAL);
INSERT INTO s VALUES (1,'a',1.5),(2,'a',2.5),(3,'b',NULL),(4,'b',4),(5,NULL,5);
SELECT count(*), count(n), sum(n), avg(n), min(n), max(n), total(n) FROM s;
SELECT g, count(*), sum(n), avg(n) FROM s GROUP BY g ORDER BY g;
SELECT g, sum(n) x FROM s GROUP BY g HAVING x > 3 ORDER BY g;
SELECT group_concat(id) FROM (SELECT id FROM s ORDER BY id);
SELECT DISTINCT g FROM s ORDER BY g;
SELECT count(DISTINCT g) FROM s;
SELECT id, sum(n) OVER (ORDER BY id) FROM s ORDER BY id;
SELECT id, rank() OVER (PARTITION BY g ORDER BY n DESC) FROM s ORDER BY id;
SELECT id FROM s ORDER BY n DESC, id LIMIT 2;
SELECT id FROM s ORDER BY id LIMIT 2 OFFSET 1;
SELECT g, n FROM s ORDER BY n IS NULL, n;
SELECT sum(n) FROM s WHERE id > 100;
SELECT count(*) FROM s WHERE id > 100;
SELECT max(n) FROM s WHERE id > 100;
SELECT g, count(*) FROM s WHERE id > 100 GROUP BY g;
`,
  "types and expressions": `
CREATE TABLE y(a INTEGER, b REAL, c TEXT, d BLOB, e);
INSERT INTO y VALUES (1, 2, 3, x'0102', 'x');
INSERT INTO y VALUES ('4', '5.5', 6.5, 'str', 7);
INSERT INTO y VALUES (NULL, NULL, NULL, NULL, NULL);
SELECT typeof(a), typeof(b), typeof(c), typeof(d), typeof(e) FROM y ORDER BY rowid;
SELECT * FROM y ORDER BY rowid;
SELECT hex(d) FROM y WHERE d IS NOT NULL ORDER BY rowid;
SELECT 1 + 1, 'a' || 'b', 5 / 2, 5.0 / 2, 7 % 3, NULL + 1, -3;
SELECT abs(-1), upper('a'), length('abc'), substr('abcdef', 2, 3), replace('aXb', 'X', 'Y');
SELECT coalesce(NULL, 2), ifnull(NULL, 3), nullif(1, 1), iif(1, 'y', 'n');
SELECT CASE WHEN 1 > 2 THEN 'a' ELSE 'b' END, CAST('12' AS INTEGER), CAST(1 AS TEXT);
SELECT json_extract('{"a":[1,2]}', '$.a[1]'), json_array(1, 'x');
SELECT 'a' LIKE 'A', 'a' GLOB 'A', 1 IN (1, 2), 3 BETWEEN 1 AND 5;
SELECT date('2026-01-02', '+1 day'), strftime('%Y', '2026-01-02');
CREATE TABLE n(id TEXT PRIMARY KEY COLLATE NOCASE, v);
INSERT INTO n VALUES ('Abc', 1);
SELECT * FROM n WHERE id = 'abc';
INSERT INTO n VALUES ('ABC', 2);
SELECT v FROM n ORDER BY id;
`,
  "transactions": `
CREATE TABLE x(id INTEGER PRIMARY KEY, v);
INSERT INTO x VALUES (1, 'a');
BEGIN;
INSERT INTO x VALUES (2, 'b');
UPDATE x SET v = 'c' WHERE id = 1;
SELECT * FROM x ORDER BY id;
ROLLBACK;
SELECT * FROM x ORDER BY id;
BEGIN;
INSERT INTO x VALUES (3, 'd');
INSERT INTO x VALUES (4, 'e');
COMMIT;
SELECT * FROM x ORDER BY id;
BEGIN;
INSERT INTO x VALUES (5, 'f');
SAVEPOINT s1;
INSERT INTO x VALUES (6, 'g');
ROLLBACK TO s1;
INSERT INTO x VALUES (7, 'h');
RELEASE s1;
COMMIT;
SELECT * FROM x ORDER BY id;
COMMIT;
ROLLBACK;
`,
  "schema changes": `
CREATE TABLE IF NOT EXISTS d(id INTEGER PRIMARY KEY, a TEXT);
CREATE TABLE IF NOT EXISTS d(id INTEGER PRIMARY KEY, a TEXT);
CREATE TABLE d(x);
INSERT INTO d VALUES (1, 'p'), (2, 'q');
ALTER TABLE d ADD COLUMN b INTEGER DEFAULT 7;
SELECT * FROM d ORDER BY id;
INSERT INTO d(a, b) VALUES ('r', 8);
ALTER TABLE d RENAME COLUMN a TO aa;
SELECT aa, b FROM d ORDER BY id;
UPDATE d SET aa = 'z' WHERE id = 1;
ALTER TABLE d DROP COLUMN b;
SELECT * FROM d ORDER BY id;
ALTER TABLE d RENAME TO d2;
SELECT * FROM d;
SELECT * FROM d2 ORDER BY id;
CREATE INDEX i1 ON d2(aa);
CREATE INDEX IF NOT EXISTS i1 ON d2(aa);
CREATE INDEX i1 ON d2(aa);
SELECT id FROM d2 WHERE aa = 'q';
DROP INDEX i1;
DROP INDEX i1;
DROP INDEX IF EXISTS i1;
CREATE UNIQUE INDEX i2 ON d2(aa);
INSERT INTO d2(aa) VALUES ('q');
DROP TABLE d2;
DROP TABLE d2;
DROP TABLE IF EXISTS d2;
SELECT * FROM d2;
CREATE TABLE d3 AS SELECT 1 a, 'x' b;
SELECT * FROM d3;
`,
  "schema introspection": `
CREATE TABLE q(id INTEGER PRIMARY KEY, a TEXT NOT NULL, b REAL DEFAULT 1.5);
CREATE INDEX qi ON q(a);
CREATE VIEW qv AS SELECT id FROM q;
SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY name;
SELECT name FROM sqlite_schema WHERE type = 'table';
PRAGMA table_info(q);
PRAGMA index_list(q);
SELECT name FROM pragma_table_info('q') ORDER BY cid;
`,
  "triggers": `
CREATE TABLE ta(id INTEGER PRIMARY KEY, n INTEGER);
CREATE TABLE au(id INTEGER PRIMARY KEY, msg TEXT);
CREATE TRIGGER tr1 AFTER INSERT ON ta BEGIN INSERT INTO au(msg) VALUES ('ins ' || new.id); END;
CREATE TRIGGER tr2 AFTER UPDATE ON ta WHEN new.n > 5 BEGIN INSERT INTO au(msg) VALUES ('big ' || new.n); UPDATE ta SET n = 0 WHERE id = old.id + 100; END;
CREATE TRIGGER tr3 BEFORE DELETE ON ta BEGIN DELETE FROM au WHERE msg = 'ins ' || old.id; END;
INSERT INTO ta VALUES (1, 1), (2, 2);
INSERT INTO ta(n) VALUES (3);
SELECT * FROM au ORDER BY msg;
UPDATE ta SET n = 9 WHERE id = 2;
UPDATE ta SET n = 1 WHERE id = 1;
SELECT * FROM ta ORDER BY id;
SELECT msg FROM au ORDER BY msg;
DELETE FROM ta WHERE id = 1;
SELECT msg FROM au ORDER BY msg;
SELECT name, tbl_name FROM sqlite_master WHERE type = 'trigger' ORDER BY name;
DROP TRIGGER tr1;
INSERT INTO ta VALUES (50, 1);
SELECT count(*) FROM au;
DROP TRIGGER nosuch;
DROP TABLE ta;
SELECT name FROM sqlite_master WHERE type = 'trigger';
`,
  "conditions that do not name a column": `
CREATE TABLE c1(id INTEGER PRIMARY KEY, a INTEGER);
INSERT INTO c1 VALUES (1, 5), (2, 6), (3, 7), (4, 8);
SELECT count(*) FROM c1 WHERE NULL < NULL;
SELECT count(*), sum(a) FROM c1 WHERE 1 = 2;
SELECT a, count(*) FROM c1 WHERE 90 IS NULL GROUP BY a;
SELECT id FROM c1 WHERE NOT NULL IS NULL ORDER BY id LIMIT 2;
SELECT id FROM c1 WHERE id > 1 AND random() IS NOT NULL ORDER BY id LIMIT 2;
SELECT max(a) FROM c1 WHERE id IN (SELECT id FROM c1 WHERE a > 6);
SELECT id FROM c1 WHERE a IN (SELECT a FROM c1 WHERE a > 6) ORDER BY a DESC LIMIT 1;
`,
  "statements that do nothing": `
CREATE TABLE r(a);
REINDEX;
ANALYZE;
VACUUM;
PRAGMA foreign_keys = ON;
SELECT 1 IN () x;
SELECT 1 NOT IN () x;
`,
  "group and pinned edge cases": `
CREATE TABLE z(id INTEGER PRIMARY KEY, v TEXT);
INSERT INTO z VALUES (1, 'a'), (2, 'b'), (3, 'c');
SELECT v FROM z WHERE id = 1 OR id = 2 ORDER BY v;
SELECT v FROM z WHERE id = 1 AND id = 2;
SELECT v FROM z WHERE id IS 1;
SELECT v FROM z WHERE id = NULL;
SELECT v FROM z WHERE id IS NULL;
SELECT v FROM z WHERE id = 1.0;
SELECT v FROM z WHERE id = '1';
SELECT v FROM z WHERE +id = 1;
SELECT v FROM z WHERE 1 = id;
SELECT a.v, b.v FROM z a, z b WHERE a.id = 1 AND b.id = 2;
SELECT count(*) FROM z a, z b;
DELETE FROM z WHERE id = 99;
UPDATE z SET v = 'x' WHERE id = 99;
SELECT * FROM z ORDER BY id;
`,
};

describe("differential test against real SQLite", () => {
  for (const [name, script] of Object.entries(SCRIPTS)) {
    it(name, async () => {
      const problems = await diff(script);
      expect(problems.join("\n\n")).toBe("");
    });
  }
});
