// 列の解決の検査の部品 (docs/design-unique-keys.md の段 0 の (b)、未解決の問題 31)。
//
// DDL の解釈 (src/sql/ddl.ts の parseDdl) が表の制約と CREATE INDEX から読む列の名前と照合順序を、同じ DDL を使い捨ての SQLite
// (node:sqlite) で実行して PRAGMA で読んだ答えと比べる。設計 (「未解決の問題 31: 列の名前の解決」) は、段 1 で、名前と照合順序を
// PRAGMA から読むように変える。そのときは、構文木の読みと PRAGMA の答えを突き合わせる検査として、これが残る。
//
// DDL は seed から作る。列の定義の綴り (大文字と小文字、引用の仕方)、表の制約と CREATE INDEX での列の書き方、列と制約の COLLATE、
// 主キーの書き方、WITHOUT ROWID、部分 index を変える。列を定義と違う大文字と小文字で書く形 (caseVariants) は、問題 31 の形である。
// 既定の実行 (test/unique-columns.test.ts) では作らず、test/open/unique-columns-case.test.ts が作る。
//
// 1 つの DDL の結果は 3 つに分ける。
// - 両方が受け付けた: 読んだものを比べる。
// - SQLite は受け付け、D∞ は REFUSALS の文言で断った: 断った形として数える (表定義の形で決まる拒否。設計の段 2 で減る)。
// - SQLite が受け付けたのに、D∞ がほかの誤りで断ったか、例外で落ちた: 違いとして報告する。
// SQLite が断った DDL は比べない。D∞ の DDL の経路 (Db.ddl) は、記録の前に、利用者の文を Worker の SQLite で実行して確かめる
// (Db.assertReplays、計画書の不変条件 3) ので、構文木の解釈が受け付けても、SQLite の誤りで断る。seed 4986 (同じ UNIQUE に食い違う
// ON CONFLICT) は、この区別がなかったときの検査の誤りである。
import { DatabaseSync } from "node:sqlite";
import { parseDdl, type ParsedDdl, type SchemaView } from "../src/sql/ddl";
import type { TableDef } from "../src/types";
import { prng } from "./sim";

/** D∞ が、表定義の形で断る DDL。id は報告と、最後の数え上げに使う。 */
export interface Refusal {
  id: string;
  message: RegExp;
  /** 生成した DDL がこの形を含むときだけ、この拒否と見なす。 */
  applies?: (g: Generated) => boolean;
}

export const REFUSALS: Refusal[] = [
  // 制約に書いた衝突の処理は、ABORT のほかは形で断る (src/sql/ddl.ts の assertNoConstraintConflictAction。計画書の不変条件 14)。
  { id: "ON CONFLICT other than ABORT on a constraint", message: /^unsupported: ON CONFLICT (IGNORE|REPLACE) on a constraint; / },
  { id: "COLLATE other than BINARY on a primary key column", message: /^unsupported: COLLATE \w+ on the primary key or shard key column / },
  { id: "COLLATE other than BINARY on a column of a table UNIQUE without the shard key", message: /^unsupported: COLLATE \w+ on column \S+ of a UNIQUE constraint that does not include the shard key$/ },
  { id: "COLLATE other than BINARY on a column of a UNIQUE index without the shard key", message: /^unsupported: COLLATE \w+ on column \S+ of a UNIQUE index that does not include the shard key$/ },
  // CREATE UNIQUE INDEX の列に COLLATE を書くと、式の index と同じに扱われる (ddl.ts の createIndex の plain)。shard key を含んでいても断る。
  { id: "a UNIQUE index with a WHERE, an expression or a COLLATE on a column", message: /^unsupported: a UNIQUE partial or expression index that does not include the shard key$/ },
  // パーサは、表の UNIQUE の列を名前だけで読む (src/sql/parser.ts の constraint)。照合順序、方向、文字列の literal の付いた列は、
  // unsupported ではなく構文の誤りで断る。段 1 の resolveConstraints を入れても、パーサを変えないと受け付けない。
  { id: "COLLATE, ASC, DESC or a string literal on a column of a table UNIQUE (refused by the parser)", message: /^near "(COLLATE|ASC|DESC|'[^']*')": syntax error$/, applies: (g) => g.decoratedUnique },
];

export interface Generated {
  table: string;
  index: string[];
  /** 表の UNIQUE に、照合順序、方向、文字列の literal の付いた列がある。 */
  decoratedUnique: boolean;
}

export interface GenOptions {
  /** 表の制約と CREATE INDEX で、列を定義と違う大文字と小文字で書く (問題 31 の形)。 */
  caseVariants?: boolean;
  /** CREATE INDEX の ON の表の名前を、定義と違う大文字と小文字で書く。 */
  tableCase?: boolean;
  /** 列の定義の `INTEGER PRIMARY KEY DESC` を作る。 */
  primaryKeyDesc?: boolean;
}

const BASES = ["id", "tenant", "email", "code", "n", "mixed", "a", "b"];
const caseOf = (r: () => number, s: string) => {
  const k = Math.floor(r() * 4);
  return k === 0 ? s : k === 1 ? s.toUpperCase() : k === 2 ? s[0]!.toUpperCase() + s.slice(1) : [...s].map((ch, i) => (i % 2 ? ch.toUpperCase() : ch)).join("");
};
/** 名前を引用する。引用は大文字と小文字を変えない。 */
const quoteOf = (r: () => number, s: string, literal = false) => {
  const k = Math.floor(r() * (literal ? 5 : 4));
  return k === 0 ? s : k === 1 ? `"${s}"` : k === 2 ? `[${s}]` : k === 3 ? `\`${s}\`` : `'${s}'`;
};

/** seed から、CREATE TABLE 1 つと、その表の CREATE INDEX 0 から 2 個を作る。 */
export function generate(seed: number, o: GenOptions = {}): Generated {
  const r = prng(seed * 7121 + 3);
  const int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
  const shuffled = <T,>(xs: readonly T[]): T[] => {
    const out = [...xs];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
  };
  const names = shuffled(BASES).slice(0, int(2, 5)).map((b) => caseOf(r, b));
  // 列の参照。既定では定義と同じ綴り (引用は変える)。caseVariants のときは、半分を別の大文字と小文字にする。
  const ref = (name: string, literal = false) => quoteOf(r, o.caseVariants && r() < 0.5 ? caseOf(r, name.toLowerCase()) : name, literal);
  const collate = () => (r() < 0.6 ? "" : pick([" COLLATE NOCASE", " COLLATE RTRIM", " COLLATE BINARY", " collate nocase", ' COLLATE "rtrim"']));
  const types = names.map(() => pick(["INTEGER", "TEXT", "", "INT", "BLOB", "VARCHAR(10)", "integer"]));
  const defs = names.map((n, i) => `${quoteOf(r, n)}${types[i] ? ` ${types[i]}` : ""}${/TEXT|VARCHAR|^$/i.test(types[i]!) ? collate() : ""}`);
  const constraints: string[] = [];
  let decoratedUnique = false;
  let pk: string[] = [];
  const pkKind = int(0, 3);
  if (pkKind === 1) {
    const i = int(0, names.length - 1);
    const dir = o.primaryKeyDesc ? pick(["", " DESC", " DESC"]) : pick(["", " ASC"]);
    defs[i] += ` PRIMARY KEY${dir}`;
    pk = [names[i]!];
  } else if (pkKind >= 2) {
    const cols = shuffled(names).slice(0, int(1, Math.min(2, names.length)));
    pk = cols;
    constraints.push(`PRIMARY KEY (${cols.map((c) => `${ref(c, true)}${pick(["", "", "", " ASC", " DESC", " COLLATE BINARY", " COLLATE NOCASE"])}`).join(", ")})`);
  }
  for (let k = int(0, 2); k > 0; k--) {
    if (r() < 0.35) {
      const i = int(0, names.length - 1);
      defs[i] += " UNIQUE";
      continue;
    }
    const cols = shuffled(names).slice(0, int(1, Math.min(3, names.length)));
    const parts = cols.map((c) => {
      const decor = r() < 0.06 ? pick([" COLLATE NOCASE", " DESC", " ASC"]) : "";
      const literal = r() < 0.03;
      if (decor || literal) decoratedUnique = true;
      return `${literal ? `'${c}'` : ref(c)}${decor}`;
    });
    const name = r() < 0.3 ? `CONSTRAINT u${k} ` : "";
    const conflict = r() < 0.2 ? pick([" ON CONFLICT IGNORE", " ON CONFLICT REPLACE", " ON CONFLICT ABORT"]) : "";
    constraints.push(`${name}UNIQUE (${parts.join(", ")})${conflict}`);
  }
  const withoutRowid = pk.length > 0 && r() < 0.25;
  const table = `CREATE TABLE t (${[...defs, ...constraints].join(", ")})${withoutRowid ? " WITHOUT ROWID" : ""}`;
  const index: string[] = [];
  for (let k = int(0, 2); k > 0; k--) {
    const cols = shuffled(names).slice(0, int(1, Math.min(3, names.length)));
    const unique = r() < 0.6 ? "UNIQUE " : "";
    const parts = cols.map((c) => `${ref(c)}${r() < 0.15 ? pick([" COLLATE NOCASE", " DESC", " COLLATE RTRIM"]) : ""}`);
    const where = r() < 0.15 ? ` WHERE ${ref(pick(names))} IS NOT NULL` : "";
    const on = o.tableCase && r() < 0.5 ? "T" : "t";
    index.push(`CREATE ${unique}INDEX ix${k} ON ${on} (${parts.join(", ")})${where}`);
  }
  return { table, index, decoratedUnique };
}

// ---- 読んだものの形 ----

/** UNIQUE の 1 つ (主キーを含む)。列は定義の綴り、照合順序は大文字。 */
const keyOf = (cols: string[], colls: string[]) => `(${cols.join(", ")}) ${colls.join(", ")}`;

interface TableShape {
  columns: string[];
  pk: string[];
  rowidAlias: string | null;
  shardKey: string[];
  /** 主キーと UNIQUE の全部。重複は 1 つにする (SQLite は同じ UNIQUE を 2 度作らない)。 */
  keys: string[];
}

function dinfShape(def: TableDef): TableShape {
  // 制約の列の照合順序は、列の定義の照合順序を、制約に書いてある綴りで引いたもの (ddl.ts の createTable が使う引き方)。
  const coll = (c: string) => (def.collation[c] ?? "BINARY").toUpperCase();
  const keys = new Set<string>();
  if (!def.implicitRowid) keys.add(keyOf(def.pk, def.pk.map(coll)));
  for (const u of def.uniques) keys.add(keyOf(u, u.map(coll)));
  for (const g of def.globalIndexes) keys.add(keyOf(g.columns, g.columns.map(coll)));
  return { columns: def.columns, pk: def.pk, rowidAlias: def.rowidAlias, shardKey: def.shardKey, keys: [...keys].sort() };
}

interface IndexRow { name: string; unique: number; origin: string; partial: number }
interface XinfoRow { cid: number; name: string | null; coll: string; key: number }

function sqliteShape(lite: DatabaseSync, table: string): TableShape {
  const cols = lite.prepare("SELECT name, pk FROM pragma_table_xinfo(?) ORDER BY cid").all(table) as { name: string; pk: number }[];
  const pkCols = cols.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
  const list = lite.prepare("SELECT name, \"unique\", origin, partial FROM pragma_index_list(?)").all(table) as unknown as IndexRow[];
  const withoutRowid = (lite.prepare("SELECT wr FROM pragma_table_list WHERE name = ?").get(table) as { wr: number }).wr === 1;
  const parts = (index: string) => (lite.prepare("SELECT cid, name, coll, key FROM pragma_index_xinfo(?) ORDER BY seqno").all(index) as unknown as XinfoRow[]).filter((x) => x.key === 1);
  const keys = new Set<string>();
  const pkIndex = list.find((i) => i.origin === "pk");
  // 主キーの index がない rowid の表の主キーは、rowid の別名 (INTEGER PRIMARY KEY) である。
  const rowidAlias = !withoutRowid && pkCols.length === 1 && !pkIndex ? pkCols[0]! : null;
  if (rowidAlias) keys.add(keyOf([rowidAlias], ["BINARY"]));
  for (const i of list) {
    if (!i.unique) continue;
    const p = parts(i.name);
    keys.add(keyOf(p.map((x) => x.name ?? "<expr>"), p.map((x) => x.coll.toUpperCase())));
  }
  return { columns: cols.map((c) => c.name), pk: pkCols.length ? pkCols : ["rowid"], rowidAlias, shardKey: [pkCols[0] ?? "rowid"], keys: [...keys].sort() };
}

// ---- 1 つの seed ----

export interface ColumnsRun {
  problems: string[];
  /** 断った形の id ごとの数。 */
  refused: Record<string, number>;
  /** 両方が受け付けて比べた DDL の数。 */
  compared: number;
}

type Outcome = { ok: true; value: ParsedDdl } | { ok: false; message: string; crash: boolean };

function dinf(sql: string, schema: SchemaView): Outcome {
  try {
    return { ok: true, value: parseDdl(sql, schema) };
  } catch (e) {
    return { ok: false, message: (e as Error).message, crash: (e as Error).name !== "SqlError" };
  }
}

function sqlite(lite: DatabaseSync, sql: string): string | null {
  try {
    lite.exec(sql);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

/** 1 つの DDL の結果を分ける。両方が受け付けたら true を返す。 */
function classify(sql: string, g: Generated, d: Outcome, s: string | null, out: ColumnsRun): d is { ok: true; value: ParsedDdl } {
  if (d.ok && s === null) return true;
  if (s !== null) return false;
  if (d.ok) return false;
  const refusal = REFUSALS.find((x) => x.message.test(d.message) && (x.applies?.(g) ?? true));
  if (refusal && !d.crash) out.refused[refusal.id] = (out.refused[refusal.id] ?? 0) + 1;
  else out.problems.push(`${sql}\n  sqlite accepted it, D∞ refused it: ${d.crash ? "crash " : ""}${d.message}`);
  return false;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** seed の DDL を、D∞ の DDL の解釈と SQLite に流して比べる。 */
export function checkColumns(seed: number, o: GenOptions = {}): ColumnsRun & { generated: Generated } {
  const g = generate(seed, o);
  const out: ColumnsRun = { problems: [], refused: {}, compared: 0 };
  const lite = new DatabaseSync(":memory:");
  const schema: SchemaView = { tables: {}, views: {}, indexes: {} };
  const t = dinf(g.table, schema);
  if (!classify(g.table, g, t, sqlite(lite, g.table), out)) return { ...out, generated: g };
  out.compared++;
  for (const def of t.value.defs) schema.tables[def.name] = def;
  Object.assign(schema.indexes, t.value.indexes ?? {});
  const def = t.value.defs[0]!;
  const want = sqliteShape(lite, "t");
  const got = dinfShape(def);
  for (const k of ["columns", "pk", "rowidAlias", "shardKey", "keys"] as const) {
    if (!same(got[k], want[k])) out.problems.push(`${g.table}\n  ${k}: sqlite ${JSON.stringify(want[k])}, D∞ ${JSON.stringify(got[k])}`);
  }
  for (const sql of g.index) {
    const x = dinf(sql, schema);
    if (!classify(sql, g, x, sqlite(lite, sql), out)) continue;
    out.compared++;
    const name = /INDEX (\w+)/.exec(sql)![1]!;
    const next = x.value.defs[0]!;
    for (const d of x.value.defs) schema.tables[d.name] = d;
    Object.assign(schema.indexes, x.value.indexes ?? {});
    if (!/^CREATE UNIQUE/.test(sql)) continue;
    // D∞ が記録した UNIQUE の列。シャードの中の UNIQUE は uniques の最後に足され、シャードをまたぐものは、作っている最中の index
    // (building) になる。
    const cols = next.building?.name === name ? next.building.columns : next.uniques[next.uniques.length - 1] ?? [];
    const coll = (c: string) => (next.collation[c] ?? "BINARY").toUpperCase();
    const parts = (lite.prepare("SELECT cid, name, coll, key FROM pragma_index_xinfo(?) ORDER BY seqno").all(name) as unknown as XinfoRow[]).filter((p) => p.key === 1);
    const wantKey = keyOf(parts.map((p) => p.name ?? "<expr>"), parts.map((p) => p.coll.toUpperCase()));
    const gotKey = keyOf(cols, cols.map(coll));
    if (wantKey !== gotKey) out.problems.push(`${g.table};\n${sql}\n  index columns: sqlite ${wantKey}, D∞ ${gotKey}`);
    // 部分 index の UNIQUE は、書き込みが別の行を読み得る印 (partialUnique) を付ける (ddl.ts の createIndex)。
    const partial = (lite.prepare("SELECT partial FROM pragma_index_list('t') WHERE name = ?").get(name) as { partial: number }).partial === 1;
    if (partial && !next.partialUnique) out.problems.push(`${g.table};\n${sql}\n  a partial UNIQUE index without partialUnique`);
  }
  return { ...out, generated: g };
}
