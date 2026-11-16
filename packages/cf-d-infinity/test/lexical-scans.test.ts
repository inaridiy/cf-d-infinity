// 字句の手書きの走査 3 つを、字句解析 (src/sql/lexer.ts の Scanner) に置き換えた (計画書の未解決の問題 48)。
//
// 前の関数は test/lexical-scans-old.ts に凍らせてある。ここでは、同じ文の集まりで前と今の答えを比べ、違いを 1 つずつ、前の走査の
// 誤りの型に分ける。どの型にも入らない違いは、今の関数の誤りなので、試験を落とす。型ごとに、SQLite (node:sqlite と sql.js) で
// 確かめた例を添える。今の関数の答えそのものも、SQLite と突き合わせる (引数の位置と番号、複合 SELECT の項の数)。
//
// 文の集まりは、test/parser-statements.ts の文 (パーサの試験が SQLite の文法を一通り踏む一覧)、その字句の境目に注釈と空白を
// 差し込んだもの、乱数で作る字句の並び (注釈、引用した識別子、文字列、引数、閉じていない引用を、空白なしでも隣り合わせる)、
// SQLite が受け付ける形に作った引数つきの文である。乱数は種で決まる。
import { DatabaseSync } from "node:sqlite";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { beforeAll, describe, expect, it } from "vitest";
import { D1Compatible } from "../src/client/d1";
import { Db } from "../src/client/db";
import { compoundTerms } from "../src/shard-limits";
import { Scanner, tokenize } from "../src/sql/lexer";
import { namesPragmaFunction } from "../src/sql/scratch";
import { bindTyped, placeholders } from "../src/value";
import * as old from "./lexical-scans-old";
import { withTrivia } from "./parser-oracle";
import { STATEMENTS } from "./parser-statements";
import { SimCluster } from "./sim";

const rng = (seed: number) => {
  let a = seed >>> 0;
  return (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
};

// ---- 文の集まり ----

const TRIVIA = ["", "", "", " ", "\n", "/* x */", "/* ' \" ] ? :a */", "-- ' UNION ?\n", "/**/", "--\n", "/* pragma_x */", "\t"];

function withComments(seed: number): string[] {
  const r = rng(seed);
  const out: string[] = [];
  for (const s of STATEMENTS) {
    const t = withTrivia(s, () => TRIVIA[Math.floor(r() * TRIVIA.length)]!);
    if (t !== null) out.push(t);
  }
  return out;
}

/** 乱数で作る字句の並び。多くは SQL として正しくないが、字句の読み方の違いを見るには足りる。 */
const PIECES = [
  // 語
  "SELECT", "FROM", "WHERE", "UNION", "union", "Union", "INTERSECT", "EXCEPT", "ALL", "THEN", "ELSE", "AND", "CASE", "WHEN", "END",
  "x", "t", "a$b", "abc", "é", "ü", "_", "UNION$", "éUNION", "pragma_table_info", "PRAGMA_index_list", "xpragma_", "a$pragma_x", "pragma_",
  // 引用した識別子
  '"a"', '"un""ion"', '"UNION"', '"x pragma_y"', '"pragma_table_info"', '"$pragma_"', "`UNION`", "`a``b`", "`pragma_x`", "[UNION]", "[pragma_x]",
  '[a"b]', '"a]b"', "[x pragma_y]", '"?"', '":a"', "`--`",
  // 文字列と BLOB
  "'UNION'", "'it''s'", "'--'", "'/*'", "'?'", "':a'", "''", "'pragma_x'", "'\"'", "'*/'", "x'00'", "X'AB'", "x'zz'", "x'abc'",
  // 数
  "1", "1.5", "1e5", "0x1F", ".5", "12", "1_000", "1e", "0x",
  // 引数
  "?", "?1", "?12", ":a", "@b", "$c", ":pragma_x", "$union", ":UNION", "@1", "$", ":",
  // 注釈
  "-- UNION\n", "/* UNION */", "/* ' */", "-- '\n", '/* " */', "/*/", "/**/", "--\n",
  // 記号
  "(", ")", ",", "=", "||", "-", "/", "*", ".", ";", "::", "#", "!", "^", "->>", "<>",
];
const UNCLOSED = ["'abc", '"abc', "[abc", "/* abc", "-- abc", "`abc", "x'ab"];
const SEPARATORS = ["", "", " ", " ", "\n", "\t"];

function soup(seed: number): string {
  const r = rng(seed);
  const pick = <T,>(xs: T[]): T => xs[Math.floor(r() * xs.length)]!;
  const n = 1 + Math.floor(r() * 25);
  let s = "";
  for (let i = 0; i < n; i++) s += pick(PIECES) + pick(SEPARATORS);
  if (r() < 0.1) s += pick(UNCLOSED);
  return s;
}

/**
 * SQLite が受け付ける、引数つきの文。結果の列の 1 つずつに引数が 1 つずつあり、列の値はその引数の値である。引数は、語の直後に
 * 空白なしで置くこと (`THEN:a`) も、注釈と別名の中に引数に見える文面を置くこともある。compound は UNION でつないだ SELECT の数。
 */
function parameterStatement(seed: number): { sql: string; columns: number; compound: number } {
  const r = rng(seed);
  const pick = <T,>(xs: T[]): T => xs[Math.floor(r() * xs.length)]!;
  const params = ["?", "?", "?2", "?7", ":a", ":a", "@b", "$c", "$d1", "@pragma_x", "$union", ":é", "?12"];
  const column = (): string => {
    const p = pick(params);
    // 語の直後に空白なしで置けるのは、識別子の文字で始まらない引数だけである (`THEN$c` は 1 つの語になる)。
    const glue = p[0] === "$" ? " " : pick(["", " "]);
    const forms = [
      p, `(${p})`, `+${p}`, `CASE WHEN 1 THEN${glue}${p} END`, `CASE WHEN 0 THEN 0 ELSE${glue}${p} END`, `ifnull(NULL,${p})`,
      `${p}/* ? :x */`, `-- :y ?\n${p}`, `${p} AS "c:z?"`, `${p} AS [?]`, `${p} AS 'p:q'`, `/* $union */${p}`, `${p}--?\n`,
    ];
    return pick(forms);
  };
  const columns = 1 + Math.floor(r() * 4);
  const compound = 1 + Math.floor(r() * 3);
  const select = () => `SELECT ${Array.from({ length: columns }, column).join(pick([",", ", ", " ,"]))}`;
  return { sql: Array.from({ length: compound }, select).join(pick([" UNION ALL ", "\nUNION ALL\n", " UNION ALL/* x */"])), columns, compound };
}

const CORPUS: { name: string; statements: string[] }[] = [
  { name: "parser statements", statements: STATEMENTS },
  { name: "parser statements with comments", statements: [...withComments(1), ...withComments(2), ...withComments(3)] },
  { name: "random token sequences", statements: Array.from({ length: 30_000 }, (_v, i) => soup(i + 1)) },
  { name: "statements with parameters", statements: Array.from({ length: 3_000 }, (_v, i) => parameterStatement(i + 1).sql) },
];

// ---- 前の走査の誤りの型 ----
//
// 前の走査は文字を見て判断した。違いが出るのは、識別子の文字 (`$`、ASCII の外の文字、数字) と `\b` の扱いが SQLite の字句と
// 違うところだけである。違いの型は次の 4 つ。
//   P1  名前つきの引数が識別子の文字の直後にある (`THEN:a`、`1 AND@b`)。前の placeholders は見落とした。SQLite は引数として読む。
//   C1  UNION、INTERSECT、EXCEPT が、`$`、`:`、`@`、ASCII の外の文字に続くか、`$` か ASCII の外の文字が続く (`UNION$`、`éUNION`、
//       `$union`)。前の compoundTerms は数えた (多め)。SQLite では、識別子の一部か引数の名前である。
//   C2  UNION、INTERSECT、EXCEPT が、番号つきの引数の直後にある (`?1UNION`)。前の compoundTerms は数えなかった (少なめ)。SQLite は
//       複合 SELECT として読む。
//   R1  `pragma_` が、名前の途中 (`"x pragma_y"`、`a$pragma_x`) か引数の名前 (`:pragma_x`) にある。前の判定は当たった。SQLite では、
//       PRAGMA の関数の名前ではない。R2 は逆で、`pragma_` で始まる名前が番号つきの引数の直後にある (`?1pragma_x`)。前の判定は
//       見落とした。

const isNameOld = (c: string | undefined) => c !== undefined && (/[A-Za-z0-9_$]/.test(c) || c.charCodeAt(0) > 127);

/** 引数の並びに、SQLite の番号の付け方で番号を付ける (placeholders とは別に書いた)。 */
function numbered(texts: string[]): number[] {
  const names = new Map<string, number>();
  let max = 0;
  return texts.map((t) => {
    if (t[0] === "?") {
      const n = t.length > 1 ? Number(t.slice(1)) : max + 1;
      max = Math.max(max, n);
      return n;
    }
    if (!names.has(t)) names.set(t, ++max);
    return names.get(t)!;
  });
}

function placeholderDifference(sql: string): string | null {
  const a = old.placeholders(sql);
  const b = placeholders(sql);
  if (JSON.stringify(a) === JSON.stringify(b)) return null;
  const had = new Set(a.map((p) => `${p.start}:${p.end}`));
  const extra = b.filter((p) => !had.has(`${p.start}:${p.end}`));
  if (!extra.every((p) => ":@$".includes(sql[p.start]!) && isNameOld(sql[p.start - 1]))) return "unexplained: a parameter found only by the new scan";
  // 前の走査が見つけて今の走査にない引数は、今の走査が語の直後に見つけた引数の後ろの部分だけである (`AND:$c` の `:` を飛ばして、
  // `$c` を読んだ。SQLite は `:$c` を 1 つの引数として読む)。
  const at = new Set(b.map((p) => `${p.start}:${p.end}`));
  const inside = (p: { start: number; end: number }) => extra.some((q) => q.start < p.start && q.end === p.end);
  if (!a.every((p) => at.has(`${p.start}:${p.end}`) || inside(p))) return "unexplained: the old scan found a parameter the new one does not";
  const text = (p: { start: number; end: number }) => sql.slice(p.start, p.end);
  if (JSON.stringify(numbered(b.map(text))) !== JSON.stringify(b.map((p) => p.index))) return "unexplained: the new numbering";
  return "P1";
}

/** 前の compoundTerms が正規表現を掛けた文面 (文字列、引用、注釈を空白 1 つにしたもの)。凍らせた関数の中身と同じ。 */
function oldCode(sql: string): string {
  let code = "";
  for (let i = 0; i < sql.length; ) {
    const c = sql[i]!;
    const close = c === "'" ? "'" : c === '"' ? '"' : c === "`" ? "`" : c === "[" ? "]" : null;
    if (close) {
      for (i++; i < sql.length; i++) {
        if (sql[i] === close) {
          if (close !== "]" && sql[i + 1] === close) i++;
          else break;
        }
      }
      i++;
      code += " ";
    } else if (c === "-" && sql[i + 1] === "-") {
      const j = sql.indexOf("\n", i + 2);
      i = j < 0 ? sql.length : j + 1;
      code += " ";
    } else if (c === "/" && sql[i + 1] === "*") {
      const j = sql.indexOf("*/", i + 2);
      i = j < 0 ? sql.length : j + 2;
      code += " ";
    } else {
      code += c;
      i++;
    }
  }
  return code;
}

function compoundDifference(sql: string): string | null {
  const a = old.compoundTerms(sql);
  const b = compoundTerms(sql);
  if (a === b) return null;
  const code = oldCode(sql);
  const wide = (c: string | undefined) => c !== undefined && (c === "$" || c.charCodeAt(0) > 127);
  let glued = 0;
  for (const m of code.matchAll(/\b(UNION|INTERSECT|EXCEPT)\b/gi)) {
    const before = code[m.index - 1];
    if (wide(before) || before === ":" || before === "@" || wide(code[m.index + m[0].length])) glued++;
  }
  const afterNumbered = [...code.matchAll(/\?[0-9]+(UNION|INTERSECT|EXCEPT)(?![A-Za-z0-9_$\u0080-￿])/gi)].length;
  if (b !== a - glued + afterNumbered) return `unexplained: old ${a}, new ${b}, glued ${glued}, after a numbered parameter ${afterNumbered}`;
  return afterNumbered > 0 ? (glued > 0 ? "C1+C2" : "C2") : "C1";
}

function pragmaDifference(sql: string): string | null {
  const a = old.readsPragmaFunctionOld(sql);
  const b = namesPragmaFunction(sql);
  if (a === b) return null;
  // 前の判定が当たった場所が、どれも、名前の字句の先頭ではない (R1)。字句の境目は Scanner で見る。
  const s = new Scanner(sql);
  if (a) {
    while (s.next()) {
      const from = s.kind === "quoted" ? s.start + 1 : s.start;
      if ((s.kind === "word" || s.kind === "quoted") && sql.slice(from, from + 7).toLowerCase() === "pragma_") return "unexplained: the new check misses a name";
    }
    return "R1";
  }
  // 今の判定だけが当たる (R2)。その名前の前は番号つきの引数の数字である。
  while (s.next()) {
    if (s.kind === "word" && sql.slice(s.start, s.start + 7).toLowerCase() === "pragma_") return /[0-9]/.test(sql[s.start - 1] ?? "") ? "R2" : "unexplained: a name the old check missed";
  }
  return "unexplained: the new check found no name";
}

/** 前と今の tokenize が、同じ字句を返すか、同じ文面の誤りで投げるか。 */
function tokenizeDifference(sql: string): string | null {
  const run = (f: (s: string) => unknown) => {
    try {
      return JSON.stringify(f(sql));
    } catch (e) {
      return `error ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`;
    }
  };
  return run(old.tokenize) === run(tokenize) ? null : "unexplained: tokenize";
}

describe("the lexical scans now read statements with the lexer", () => {
  for (const { name, statements } of CORPUS) {
    it(`agree with the old scans on ${name}, except where the old scan misread a statement`, () => {
      const classes = new Map<string, number>();
      const examples = new Map<string, string>();
      const unexplained: string[] = [];
      let refused = 0;
      for (const sql of statements) {
        try {
          tokenize(sql);
        } catch {
          // 字句解析が断る文 (構文解析も SQLite も断る)。今の走査は、誤った字句を飛ばして読み進める。数だけを数える。
          refused++;
        }
        for (const [what, d] of [["placeholders", placeholderDifference(sql)], ["compoundTerms", compoundDifference(sql)], ["pragma", pragmaDifference(sql)], ["tokenize", tokenizeDifference(sql)]] as const) {
          if (d === null) continue;
          if (d.startsWith("unexplained")) unexplained.push(`${what}: ${d}: ${JSON.stringify(sql)}`);
          const key = `${what} ${d}`;
          classes.set(key, (classes.get(key) ?? 0) + 1);
          if (!examples.has(key)) examples.set(key, sql);
        }
      }
      // 型ごとの数と例を残す (報告に使う)。
      console.log(`${name}: ${statements.length} statements, ${refused} refused by the lexer`, Object.fromEntries(classes), Object.fromEntries([...examples].map(([k, v]) => [k, v.slice(0, 80)])));
      expect(unexplained.slice(0, 5)).toEqual([]);
    });
  }

  it("finds every parameter where SQLite finds it, numbers it as SQLite does, and counts the compound terms SQLite reads", async () => {
    // 位置: node:sqlite の expandedSQL は、束縛していない引数を NULL に置き換えた文面を返す。今の placeholders の位置を NULL に
    // 置き換えた文面と同じになる。番号: sql.js は配列の i 番目の値を i + 1 番の引数に束縛する。列の値が、その列の引数の番号になる。
    const SQL: SqlJsStatic = await initSqlJs();
    const sqljs = new SQL.Database();
    const sqlite = new DatabaseSync(":memory:");
    let checked = 0;
    let oldWrong = 0;
    for (let seed = 1; seed <= 3_000; seed++) {
      const { sql, columns, compound } = parameterStatement(seed);
      const ps = placeholders(sql);
      let expanded = "";
      let at = 0;
      for (const p of ps) {
        expanded += `${sql.slice(at, p.start)}NULL`;
        at = p.end;
      }
      expanded += sql.slice(at);
      expect(sqlite.prepare(sql).expandedSQL, sql).toBe(expanded);
      const max = Math.max(...ps.map((p) => p.index));
      const st = sqljs.prepare(sql);
      st.bind(Array.from({ length: max }, (_v, i) => (i + 1) * 10));
      const rows: number[][] = [];
      while (st.step()) rows.push(st.get() as number[]);
      st.free();
      expect(rows.flat().map((v) => v / 10), sql).toEqual(ps.map((p) => p.index));
      expect(rows.length * columns, sql).toBe(ps.length);
      expect(compoundTerms(sql), sql).toBe(compound);
      if (JSON.stringify(old.placeholders(sql)) !== JSON.stringify(ps)) oldWrong++;
      checked++;
    }
    expect(checked).toBe(3_000);
    // 前の placeholders は、語の直後の引数 (P1) を見落とした。この集まりでも、見落とす文がある。
    expect(oldWrong).toBeGreaterThan(0);
  });
});

describe("each kind of difference, checked with SQLite", () => {
  const sqlite = new DatabaseSync(":memory:");

  it("P1: SQLite reads a named parameter right after a word as a parameter; the old scan missed it", () => {
    const sql = "SELECT CASE WHEN 1 THEN:b END, 1 AND@c";
    expect(sqlite.prepare(sql).expandedSQL).toBe("SELECT CASE WHEN 1 THENNULL END, 1 ANDNULL");
    expect(placeholders(sql).map((p) => sql.slice(p.start, p.end))).toEqual([":b", "@c"]);
    expect(old.placeholders(sql)).toEqual([]);
    // `:` の後ろが `$` で始まる名前のときは、前の走査は `:` を飛ばし、`$c` を別の引数として読んだ。
    const dollar = "SELECT 1 AND:$c";
    expect(sqlite.prepare(dollar).expandedSQL).toBe("SELECT 1 ANDNULL");
    expect(placeholders(dollar).map((p) => dollar.slice(p.start, p.end))).toEqual([":$c"]);
    expect(old.placeholders(dollar).map((p) => dollar.slice(p.start, p.end))).toEqual(["$c"]);
  });

  it("C1: a compound word joined to `$`, a letter outside ASCII or a parameter sign is not a compound operator", () => {
    for (const sql of ["SELECT 1 AS UNION$", "SELECT 1 AS éUNION", "SELECT $union", "SELECT :union, @except"]) {
      expect(sqlite.prepare(sql).columns().length, sql).toBeGreaterThan(0);
      expect(compoundTerms(sql), sql).toBe(1);
      expect(old.compoundTerms(sql), sql).toBeGreaterThan(1);
    }
  });

  it("C2: a compound word right after a numbered parameter is a compound operator; the old count missed it", () => {
    const sql = "SELECT ?1UNION SELECT ?2EXCEPT SELECT 3";
    // (1 UNION 2) EXCEPT 3。SQLite は 3 つの項の複合 SELECT として読む。
    expect(sqlite.prepare(sql).all(1, 2).map((r) => Object.values(r)[0])).toEqual([1, 2]);
    expect(compoundTerms(sql)).toBe(3);
    expect(old.compoundTerms(sql)).toBe(1);
  });

  it("R1 and R2: only a name that begins with pragma_ names a PRAGMA function", () => {
    sqlite.exec("CREATE TABLE IF NOT EXISTS r(\"x pragma_y\" INTEGER)");
    // 名前の途中と引数の名前の pragma_ は、関数の名前ではない。
    expect(sqlite.prepare("SELECT \"x pragma_y\", :pragma_x FROM r").columns().map((c) => c.name)).toEqual(["x pragma_y", ":pragma_x"]);
    for (const sql of ['SELECT "x pragma_y" FROM r', "SELECT :pragma_x", "SELECT 1 AS a$pragma_x"]) {
      expect(namesPragmaFunction(sql), sql).toBe(false);
      expect(old.readsPragmaFunctionOld(sql), sql).toBe(true);
    }
    for (const sql of ["SELECT * FROM pragma_table_info('r')", 'SELECT * FROM "PRAGMA_TABLE_INFO"(?)', "SELECT * FROM main.[pragma_index_list]('r')", "SELECT * FROM `pragma_table_list`"]) {
      expect(() => sqlite.prepare(sql), sql).not.toThrow();
      expect(namesPragmaFunction(sql), sql).toBe(true);
    }
    // R2: 番号つきの引数の直後の名前。前の判定の `\b` は、数字と名前の間を境目と見なかった。
    expect(namesPragmaFunction("SELECT ?1pragma_table_info")).toBe(true);
    expect(old.readsPragmaFunctionOld("SELECT ?1pragma_table_info")).toBe(false);
  });
});

describe("what the old scans' misreadings did to a statement", () => {
  it("R1: an UPDATE or DELETE that reads json_each and names a column holding pragma_ is not refused as reading the schema", async () => {
    // 前の判定は、列名の途中の pragma_ (`"x pragma_y"`、`a$pragma_z`) に当たった。仮想表 (json_each) を読む書き込みの文は、
    // 表定義を読む文として断られた (`unsupported: a statement that writes cannot read sqlite_master or a PRAGMA function`)。
    // 前のコードでこの試験が落ちることを確かめた (2026-11-16)。INSERT ... SELECT は、前のコードでも通った。
    for (const shards of [1, 2]) {
      const db = new Db(new SimCluster({ shards }));
      await db.ddl('CREATE TABLE q(id INTEGER PRIMARY KEY, "x pragma_y" INTEGER, a$pragma_z INTEGER)');
      await db.query('INSERT INTO q(id, "x pragma_y", a$pragma_z) VALUES (1, 1, 1), (2, 2, 2), (3, 3, 3)', []);
      await db.query(`UPDATE q SET "x pragma_y" = 20 WHERE id IN (SELECT value FROM json_each('[2]'))`, []);
      await db.query("UPDATE q SET a$pragma_z = (SELECT count(*) FROM json_each('[1,2,3]')) WHERE id = 1", []);
      await db.query(`DELETE FROM q WHERE "x pragma_y" IN (SELECT value FROM json_each('[3]'))`, []);
      expect((await db.query('SELECT id, "x pragma_y", a$pragma_z FROM q ORDER BY id', [])).values, `${shards} shards`).toEqual([[1n, 1n, 3n], [2n, 20n, 2n]]);
    }
  });

  it("P1 and C2 did not reach a user statement: the planner renames every parameter to `?` before binding", async () => {
    // 前の placeholders は `THEN:b` を見落とし、前の compoundTerms は `?1UNION` を数えなかった。どちらも、その形の文面が束縛か
    // シャードに届いたときだけ効く。利用者の文は、計画の前に引数を `?` に書き換える (src/sql/cst.ts の bindParams) ので、`THEN?` と
    // `?UNION` になり、前の走査でも読めた (前のコードでも、下の Db の場面は通ることを確かめた)。D∞ が作る文は `?` だけを使う。
    // ここでは、束縛の書き換え (bindTyped) が今は語の直後の引数も包むことと、利用者の文の型が置き場所で変わらないことを見る。
    expect(bindTyped("SELECT CASE WHEN 1 THEN:b END", [5n], "real").sql).toBe("SELECT CASE WHEN 1 THEN(CAST(:b AS INTEGER)+0) END");
    expect(bindTyped("SELECT ?1UNION SELECT 2", [5n], "real").sql).toBe("SELECT (CAST(?1 AS INTEGER)+0)UNION SELECT 2");
    for (const shards of [1, 2]) {
      const d1 = new D1Compatible(new Db(new SimCluster({ shards })), { intMode: "bigint" });
      await d1.prepare("CREATE TABLE p(id INTEGER PRIMARY KEY, v)").run();
      expect(await d1.prepare("SELECT typeof(CASE WHEN 1 THEN:b END) AS t, CASE WHEN 1 THEN:b END AS v").bind(5).first(), `${shards} shards`).toEqual({ t: "integer", v: 5n });
      await d1.prepare("INSERT INTO p(id, v) VALUES (1, CASE WHEN 1 THEN:b END)").bind(5).run();
      expect(await d1.prepare("SELECT typeof(v) AS t, v FROM p WHERE id = 1").first(), `${shards} shards`).toEqual({ t: "integer", v: 5n });
    }
  });

  it("a PRAGMA function named by a string literal, which SQLite accepts, is refused by the parser before it is planned", async () => {
    // namesPragmaFunction は文字列の字句を見ない。SQLite は FROM の文字列を表の名前として読むが、D∞ のパーサはそれを構文の誤りとして
    // 断るので、表定義を読む文がシャードへ送られることはない。パーサが受け付けるようになったら、namesPragmaFunction も文字列を見る。
    const db = new Db(new SimCluster({ shards: 2 }));
    await db.ddl("CREATE TABLE s(id INTEGER PRIMARY KEY)");
    for (const sql of ["SELECT * FROM 'pragma_table_info'('s')", "SELECT * FROM main.'pragma_table_list'", "SELECT * FROM s, 'pragma_table_list' AS p", "SELECT * FROM s JOIN 'pragma_index_list'('s')"]) {
      await expect(db.query(sql, []), sql).rejects.toThrow(/syntax error/);
    }
  });
});
