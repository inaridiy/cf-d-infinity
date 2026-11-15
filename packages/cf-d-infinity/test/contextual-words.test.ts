// 場所によって読み方の変わる語を、SQLite と同じに読むことの確かめ。結合の語 (LEFT、RIGHT、FULL、INNER、OUTER、CROSS、NATURAL)、
// 関数の引数の ALL、空の並びの `IN ()`、空白としての CR である。
//
// 2026-11-14 までは、この 4 つを、解析の前の文面の書き換え (src/sql/cst.ts の preprocess) が受け持っていた。書き換えは字句を
// 知らないので、次の誤りがあった。今はパーサが読む (src/sql/parser.ts)。
//   - `p LEFT /* c */ JOIN q` の LEFT を表の別名にして、外部結合を内部結合として実行した (誤った答え)。
//   - 結合の語を識別子に使った式の列名が、引用符の付いた文面になった (`"left" + 1`。SQLite は `left + 1`)。
//   - `count(ALL x)` の列名から ALL が消え、`x IN ()` の列名が `x IN (SELECT 1 WHERE 0)` になった。
//   - 結合の語の名前の表の後ろに結合を書けなかった (`FROM left LEFT JOIN q`)。語の間に注釈のある `IN ( /* c */ )` と
//     `count( /* c */ ALL x)` を読めなかった。
//
// 文ごとに、結果と、結果の列名を、本物の SQLite と比べる。シャードの数を変えて流し、基準経路だけの実行 (vitest.config.ts の
// reference-scans と reference-full) でも流す。test/diff.ts は使わない: 断った文と、両方が誤りになった文を合格にするので、
// ここの文が 1 つ残らず SQLite で通り、D∞ でも通ることを確かめられない。
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { Db } from "../src/client/db";
import { parseStatements } from "../src/sql/cst";
import { planStatement, type Plan } from "../src/sql/plan";
import { asNumbers, SimCluster } from "./sim";

const SCHEMA = [
  // 結合の語を、引用符なしで、列、表、index の名前に使う。
  "CREATE TABLE p (id INTEGER PRIMARY KEY, v TEXT, left INTEGER, right INTEGER, full TEXT, natural INTEGER)",
  "CREATE TABLE q (qid INTEGER PRIMARY KEY, p_id INTEGER, w TEXT)",
  "CREATE TABLE left (id INTEGER PRIMARY KEY, inner INTEGER, outer TEXT)",
  "CREATE TABLE cross (id INTEGER PRIMARY KEY, natural INTEGER)",
  "CREATE TABLE r (a INTEGER PRIMARY KEY, b INTEGER REFERENCES p (id) MATCH FULL)",
  "CREATE INDEX inner ON p (left)",
  `INSERT INTO p VALUES (1, 'a', 10, 1, 'f1', 1), (2, 'b', 11, 2, 'f2', 1), (3, 'c', 12, 3, 'f3', 0), (4, 'd', 13, 4, 'f4', 1),
    (5, 'e', 10, 5, 'f5', 0), (6, 'f', 11, 6, 'f6', 1), (7, 'g', 12, 7, 'f7', 0), (8, 'h', 13, 8, 'f8', 1),
    (9, 'i', 10, 9, 'f9', 0), (10, 'j', 11, 10, 'f10', 1), (11, 'k', 12, 11, 'f11', 0), (12, 'l', 13, 12, 'f12', 1)`,
  "INSERT INTO q VALUES (101, 1, 'x'), (102, 1, 'y'), (103, 3, 'z'), (104, 7, 'x'), (105, 12, 'y'), (106, NULL, 'n')",
  "INSERT INTO left VALUES (1, 5, 'o1'), (2, 6, 'o2'), (4, 7, 'o4'), (9, 8, NULL)",
  "INSERT INTO cross VALUES (1, 100), (4, 400), (5, 500)",
  "INSERT INTO r VALUES (1, 1), (2, 5)",
];

/** 結合の語の間に、注釈と空白を挟む。大文字と小文字も混ぜる。 */
const JOINS = [
  "SELECT id, qid FROM p LEFT /* keep every p */ JOIN q ON p_id = id ORDER BY id, qid",
  "SELECT id, qid FROM p LEFT -- keep every p\n JOIN q ON p_id = id ORDER BY id, qid",
  "SELECT id, qid FROM p left\tOUTER\r\n  JOIN q ON p_id = id ORDER BY id, qid",
  "SELECT id, qid FROM p Left/**/Outer/**/Join q ON p_id = id ORDER BY id, qid",
  "SELECT p.id, q.qid FROM p LEFT /* a */ OUTER /* b */ JOIN q ON q.p_id = p.id ORDER BY 1, 2",
  "SELECT id, qid FROM p RIGHT /* c */ JOIN q ON p_id = id ORDER BY qid",
  "SELECT id, qid FROM p right -- a\n outer /* b */ join q ON p_id = id ORDER BY qid",
  "SELECT id, qid FROM p FULL /* c */ JOIN q ON p_id = id ORDER BY id, qid",
  "SELECT id, qid FROM p full /* a */ outer -- b\n join q ON p_id = id ORDER BY id, qid",
  "SELECT id, qid FROM p INNER /* c */ JOIN q ON p_id = id ORDER BY id, qid",
  "SELECT count(*) FROM p CROSS /* c */ JOIN q",
  "SELECT * FROM left NATURAL /* c */ JOIN cross ORDER BY id",
  "SELECT * FROM left NATURAL /* a */ LEFT /* b */ OUTER /* c */ JOIN cross ORDER BY id",
  "SELECT * FROM left natural -- a\n left -- b\n join cross ORDER BY id",
  "SELECT * FROM left LEFT /* c */ JOIN cross USING (id) ORDER BY id",
  // 1 シャードで答える文 (文をそのままシャードへ送る)。
  "SELECT p.id, left.inner FROM p LEFT /* c */ JOIN left ON left.id = p.id WHERE p.id = 3",
  "SELECT p.id, left.inner FROM p left -- c\n outer join left ON left.id = p.id WHERE p.id = 4",
  // サブクエリと CTE の中。
  "SELECT count(*), count(qid) FROM (SELECT id, qid FROM p LEFT /* c */ JOIN q ON p_id = id)",
  "WITH j AS (SELECT id, qid FROM p LEFT -- c\n JOIN q ON p_id = id) SELECT count(*), count(qid) FROM j",
  "SELECT id FROM p WHERE id IN (SELECT id FROM p LEFT /* c */ JOIN q ON p_id = id WHERE qid IS NULL) ORDER BY id",
  "SELECT id, (SELECT count(*) FROM left LEFT /* c */ JOIN cross ON cross.id = left.id WHERE left.id = p.id) FROM p WHERE id < 5 ORDER BY id",
  "SELECT id FROM p WHERE EXISTS (SELECT 1 FROM left LEFT /* c */ JOIN cross USING (id) WHERE left.id = p.id AND cross.natural IS NULL) ORDER BY id",
  // 書き込みの文と view の中。
  "INSERT INTO q SELECT id + 200, id, 'ins' FROM p LEFT /* c */ JOIN left USING (id) WHERE left.inner IS NULL AND id < 6",
  "UPDATE q SET w = 'upd' FROM p LEFT /* c */ JOIN left ON left.id = p.id WHERE q.p_id = p.id AND left.id IS NULL",
  "DELETE FROM q WHERE p_id IN (SELECT p.id FROM p LEFT /* c */ JOIN left ON left.id = p.id WHERE left.id IS NULL AND p.id > 10)",
  "CREATE VIEW pv AS SELECT id, qid FROM p LEFT /* c */ JOIN q ON p_id = id",
  "SELECT count(*), count(qid) FROM pv",
  "SELECT qid, p_id, w FROM q ORDER BY qid",
];

/** 結合の語を、名前として使う。 */
const NAMES = [
  "SELECT left, right, full, natural FROM p ORDER BY id",
  "SELECT LEFT, Right, FULL, Natural FROM p WHERE id = 2",
  "SELECT left + 1, left+1, LEFT * 2, p.left - 1, p . full || 'x', -right FROM p ORDER BY id",
  "SELECT left + 1 FROM p WHERE id = 2",
  "SELECT left + right FROM p WHERE v = 'c'",
  "SELECT count(left), sum(left + 1), max(full), min(right) FROM p",
  "SELECT natural, count(*), sum(left) FROM p GROUP BY natural ORDER BY natural",
  "SELECT id, left FROM p ORDER BY left DESC, id DESC LIMIT 3",
  "SELECT id FROM p WHERE left IN (10, 13) ORDER BY id",
  "SELECT id FROM p WHERE left BETWEEN 11 AND 12 AND full <> 'f2' ORDER BY id",
  "SELECT id FROM p WHERE natural AND right > 2 ORDER BY id",
  "SELECT left.id, left.inner, outer FROM left ORDER BY left.id",
  "SELECT inner + 1, upper(outer) FROM left WHERE id = 4",
  "SELECT * FROM left WHERE inner > 5 ORDER BY id",
  "SELECT * FROM main.left WHERE left.id = 1",
  // 結合の語の名前の表の後ろに、結合を書く。
  "SELECT left.id, cross.natural FROM left LEFT JOIN cross ON cross.id = left.id ORDER BY 1",
  "SELECT left.id, cross.natural FROM left left join cross ON cross.id = left.id ORDER BY 1",
  "SELECT left.id, cross.natural FROM left JOIN cross ON cross.id = left.id ORDER BY 1",
  "SELECT left.id, cross.id FROM left CROSS JOIN cross ORDER BY 1, 2",
  "SELECT count(*) FROM cross cross join left",
  "SELECT left.id, cross.natural FROM left, cross WHERE left.id = cross.id ORDER BY 1",
  // AS の後ろの別名、CTE、window の名前。
  "SELECT inner.id, outer.id FROM left AS inner JOIN cross AS outer ON outer.id = inner.id ORDER BY 1",
  "SELECT id AS left, v AS full, left AS natural FROM p ORDER BY id LIMIT 3",
  "SELECT x.left, x.right FROM (SELECT id AS left, v AS right FROM p) AS x ORDER BY 1",
  "WITH inner AS (SELECT id FROM p WHERE id <= 2), outer (full) AS (SELECT id FROM p WHERE id >= 2) SELECT inner.id, outer.full FROM inner LEFT JOIN outer ON outer.full = inner.id ORDER BY 1",
  "SELECT id, count(*) OVER left FROM p WINDOW left AS (ORDER BY id) ORDER BY id",
  "SELECT id, sum(left) OVER (full ORDER BY id) FROM p WINDOW full AS (PARTITION BY natural) ORDER BY id",
  // 書き込みと表定義。
  "INSERT INTO left (id, inner, outer) VALUES (20, 1, 'new')",
  "INSERT INTO p (id, v, left, right, full, natural) VALUES (13, 'm', 22, 13, 'f13', 0)",
  "UPDATE left SET inner = inner + 1, outer = 'changed' WHERE id = 20",
  "UPDATE p SET left = left + 100, full = upper(full) WHERE right = 3",
  "INSERT INTO p (id, left) VALUES (13, 1) ON CONFLICT (id) DO UPDATE SET left = excluded.left, natural = natural + 1",
  "DELETE FROM left WHERE inner = 6",
  "DELETE FROM cross WHERE natural = 500",
  "ALTER TABLE cross ADD COLUMN right INTEGER DEFAULT 7",
  "SELECT id, natural, right FROM cross ORDER BY id",
  "CREATE VIEW outer AS SELECT id AS left, v AS right FROM p WHERE natural = 1",
  "SELECT left, right FROM outer ORDER BY left",
  "DROP VIEW outer",
  "DROP INDEX inner",
  "SELECT id, v, left, right, full, natural FROM p ORDER BY id",
  "SELECT id, inner, outer FROM left ORDER BY id",
];

/** 関数の引数の ALL。既定と同じ意味で、結果の列名には文面のまま出る。 */
const ALL = [
  "SELECT count(ALL id) FROM p",
  "SELECT count( all v ), sum(ALL left), max(ALL\n full), min(/* a */ ALL /* b */ right) FROM p",
  "SELECT COUNT(ALL id), Count(All v) FROM p WHERE id = 3",
  "SELECT count(ALL id) FROM p WHERE v > 'c'",
  "SELECT natural, count(ALL id), total(ALL left) FROM p GROUP BY natural ORDER BY 1",
  "SELECT count(ALL) FROM p",
  "SELECT max(ALL id, 5), coalesce(ALL NULL, v), abs(all -right) FROM p ORDER BY id",
  "SELECT count(ALL id) FILTER (WHERE id > 3), sum(all left) FILTER (WHERE natural = 1) FROM p",
  "SELECT id, count(all id) OVER (), sum(ALL left) OVER (ORDER BY id) FROM p ORDER BY id",
  "SELECT natural FROM p GROUP BY natural HAVING count(ALL id) > 5 ORDER BY 1",
  "SELECT id, (SELECT count(ALL qid) FROM q WHERE p_id = p.id) FROM p ORDER BY id",
  "WITH c AS (SELECT count(ALL id) AS n, max(ALL left) AS m FROM p) SELECT n, m FROM c",
  "SELECT count(ALL id) FROM (SELECT id FROM p WHERE id > 6)",
  "SELECT ALL id FROM p WHERE id < 4 ORDER BY id",
  "SELECT id FROM p WHERE id < 3 UNION ALL SELECT qid FROM q WHERE qid < 103 ORDER BY 1",
  "UPDATE p SET right = (SELECT count(ALL qid) FROM q WHERE p_id = p.id) WHERE id IN (1, 2)",
  "SELECT id, right FROM p WHERE id < 4 ORDER BY id",
];

/** 空の並びの IN。`x IN ()` は常に偽、`x NOT IN ()` は常に真である (x が NULL でも)。 */
const EMPTY_IN = [
  "SELECT 1 IN (), 2 NOT IN (), NULL IN ( ), 'a' not in (/* nothing */)",
  "SELECT id IN (), id NOT IN (), v in ( ) FROM p ORDER BY id",
  "SELECT id FROM p WHERE id IN () ORDER BY id",
  "SELECT id FROM p WHERE id NOT IN () ORDER BY id",
  "SELECT id FROM p WHERE id IN () OR v = 'a'",
  "SELECT id, v FROM p WHERE v IN ( /* none */ ) AND id = 1",
  "SELECT id, v FROM p WHERE id = 2 AND left NOT IN ()",
  // 集約を分けて押し下げる文。どのシャードも読まなければ、count(*) は 0 ではなく NULL になってしまう。
  "SELECT count(*) FROM p WHERE id IN ()",
  "SELECT count(*), count(v), sum(left), max(v) FROM p WHERE id IN ()",
  "SELECT count(*) FROM p WHERE id NOT IN ()",
  "SELECT natural, count(*) FROM p WHERE id IN () GROUP BY natural",
  "SELECT natural, count(*) FROM p WHERE id NOT IN (\n) GROUP BY natural ORDER BY 1",
  // 上位 N 件を押し下げる文。
  "SELECT id FROM p WHERE id NOT IN () ORDER BY id DESC LIMIT 2",
  "SELECT id FROM p WHERE id IN () ORDER BY id LIMIT 2",
  "SELECT id FROM p WHERE (id, v) IN () ORDER BY id",
  // サブクエリ、CTE、結合の条件の中。
  "SELECT id FROM p WHERE id IN (SELECT p_id FROM q WHERE qid IN ()) ORDER BY id",
  "WITH e AS (SELECT id FROM p WHERE id IN ()) SELECT count(*) FROM e",
  "SELECT (SELECT count(*) FROM q WHERE p_id IN ()), id FROM p WHERE id = 1",
  "SELECT p.id, q.qid FROM p LEFT JOIN q ON q.p_id = p.id AND q.qid IN () WHERE p.id < 4 ORDER BY 1",
  // 書き込み。
  "UPDATE p SET v = 'none' WHERE id IN ()",
  "UPDATE p SET v = 'three' WHERE id NOT IN () AND id = 3",
  "DELETE FROM q WHERE qid IN ()",
  "DELETE FROM q WHERE qid IN () OR qid = 106",
  "INSERT INTO q VALUES (300, 5 IN (), 'in'), (301, 5 NOT IN (), 'not in')",
  "SELECT id, v FROM p ORDER BY id",
  "SELECT qid, p_id, w FROM q ORDER BY qid",
];

/** CR は空白である。結果の列名には、文面のまま出る。 */
const CARRIAGE_RETURNS = [
  "SELECT id,\rv\rFROM p\r\nWHERE id = 1",
  "SELECT 1\r+\r1, left\r+ 1 FROM p WHERE id = 1",
];

interface Out { columns: string[]; values: unknown[][]; error?: string }

function sqlite(db: DatabaseSync, sql: string): Out {
  try {
    const st = db.prepare(sql);
    const columns = st.columns().map((c) => c.name);
    if (columns.length === 0) {
      st.run();
      return { columns, values: [] };
    }
    st.setReturnArrays(true);
    return { columns, values: st.all() as unknown as unknown[][] };
  } catch (e) {
    return { columns: [], values: [], error: (e as Error).message };
  }
}

const dinf = (db: Db, sql: string): Promise<Out> =>
  db.query(sql).then((r) => ({ columns: r.columns, values: asNumbers(r.values) }), (e: Error) => ({ columns: [], values: [], error: e.message }));

/** 文を順に両方へ流し、違いを返す。ORDER BY のない文の行は、並べ替えて比べる。 */
async function compare(statements: string[], shards: number): Promise<string[]> {
  const lite = new DatabaseSync(":memory:");
  const c = new SimCluster({ shards });
  const db = new Db(c, { idBlock: 1000 });
  const problems: string[] = [];
  const rows = (o: Out, ordered: boolean): string[] => {
    const out = o.values.map((r) => JSON.stringify(r));
    return ordered ? out : out.sort();
  };
  for (const sql of [...SCHEMA, ...statements]) {
    const want = sqlite(lite, sql);
    const got = await dinf(db, sql);
    await c.settle();
    // ここの文は、どれも SQLite で通る。通らなければ、試験の文の誤りである。
    if (want.error !== undefined) problems.push(`${JSON.stringify(sql)}\n  SQLite refuses the statement: ${want.error}`);
    else if (got.error !== undefined) problems.push(`${JSON.stringify(sql)}\n  error: ${got.error}`);
    else if (JSON.stringify(got.columns) !== JSON.stringify(want.columns)) {
      problems.push(`${JSON.stringify(sql)}\n  columns in SQLite: ${JSON.stringify(want.columns)}\n  columns here:      ${JSON.stringify(got.columns)}`);
    } else {
      const ordered = /ORDER\s+BY/i.test(sql);
      const [x, y] = [rows(want, ordered), rows(got, ordered)];
      if (JSON.stringify(x) !== JSON.stringify(y)) problems.push(`${JSON.stringify(sql)}\n  rows in SQLite: ${x.join(" ").slice(0, 300)}\n  rows here:      ${y.join(" ").slice(0, 300)}`);
    }
  }
  return problems;
}

describe("words that SQLite reads by their place: results and column names against SQLite", () => {
  for (const shards of [1, 2, 4]) {
    it.each([
      ["join words with comments and whitespace between them", JOINS],
      ["join words used as names", NAMES],
      ["ALL in the arguments of a function", ALL],
      ["IN with an empty list", EMPTY_IN],
      ["carriage returns", CARRIAGE_RETURNS],
    ])(`%s, on ${shards} shard(s)`, async (_name, statements) => {
      expect(await compare(statements, shards)).toEqual([]);
    });
  }

  it("covers every kind of plan: one shard, gathered rows, partial aggregates, and ORDER BY with LIMIT pushed to the shards", async () => {
    // 上の文が、最適化の経路のそれぞれを通ることを確かめる。通らなければ、通常の実行での比較が、その経路を確かめていない。
    const c = new SimCluster({ shards: 2 });
    const db = new Db(c);
    for (const sql of SCHEMA) await db.query(sql);
    const cat = await c.catalog();
    const plan = (sql: string): Promise<Plan> =>
      planStatement(parseStatements(sql)[0], [], cat, { nextId: async () => 1n, sawId: () => undefined, evaluate: async () => null });
    const kinds = async (list: string[]): Promise<string[]> => {
      const out = new Set<string>();
      for (const sql of list) {
        // 一覧の途中で作る view を読む文は、最初の表定義では計画できない。飛ばす。
        const p = await plan(sql).catch(() => null);
        if (p) out.add(p.kind === "gather" && p.scans.some((s) => /ORDER BY .* LIMIT/.test(s.sql)) ? "top-n" : p.kind);
      }
      return [...out].sort();
    };
    expect(await kinds(JOINS)).toEqual(expect.arrayContaining(["shard", "gather", "wasmWrite", "insertSelect", "ddl"]));
    expect(await kinds(NAMES)).toEqual(expect.arrayContaining(["shard", "gather", "partial", "top-n", "write", "wasmWrite"]));
    expect(await kinds(ALL)).toEqual(expect.arrayContaining(["shard", "gather", "partial"]));
    expect(await kinds(EMPTY_IN)).toEqual(expect.arrayContaining(["shard", "gather", "partial", "top-n", "meta", "wasmWrite"]));
    // 空の並びは、shard key の値の集まりとして扱わない。扱うと、どのシャードも読まない走査になる (src/sql/plan.ts の equalities)。
    for (const sql of ["SELECT count(*) FROM p WHERE id IN ()", "SELECT id FROM p WHERE id IN () ORDER BY id", "DELETE FROM q WHERE qid IN ()"]) {
      const p = await plan(sql);
      const scans = p.kind === "partial" ? [p.scan] : p.kind === "gather" || p.kind === "wasmWrite" ? p.scans : [];
      expect(scans.map((s) => s.sks), sql).toEqual([null]);
    }
  });
});
