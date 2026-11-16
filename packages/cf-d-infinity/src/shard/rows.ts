// 行イメージ (docs/design-values.md の「行イメージ」と「捕捉」)。
//
// 行は、表定義の列の順に並べた要素のタプル (src/value.ts) で運ぶ。PRIMARY KEY のない表は、先頭に rowid を置く。
// 変更 (Change)、intent、変更ログ、移動のペイロード、取引が溜める変更が、この形で行を運ぶ。タプルは SQL の中で作り (tupleSql)、
// JS では値に戻すだけである。値に戻すのは、どれも valuesOf か imageAt を通す。
// 書き戻すときは、値を束縛する (Backend.query)。SQL の中で要素を値に戻すことはしない。REAL の文字列を SQLite の CAST に読ませると、
// 版ごとの解釈の違いが入るからである。
import type { Backend, Change, Plain, Row, TableDef, Value } from "../types";
import { SqlError } from "../types";
import { keyString, keyValues } from "../keys";
import { decodeElem, encodeElem, parseTuple, tupleSql, type Elem, type Tuple } from "../value";

export const q = (id: string) => `"${id.replaceAll('"', '""')}"`;

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (h) => parseInt(h, 16));

/**
 * 値を JSON にする (変更の並び、intent、baton、2PC の ID の指紋、範囲の検査)。JSON で表せない値は印を付ける。INTEGER (bigint) は
 * `{"$i":"数字"}`、BLOB は `{"$b":"16 進"}`、無限大は `{"$f":"Infinity"}` である。行イメージはタプル (文字列と null の配列) なので、
 * 印には当たらない。JSON の数は、ここではいつも REAL である。
 */
export const encode = (v: unknown): string =>
  JSON.stringify(v, (_k, x) =>
    typeof x === "bigint" ? { $i: String(x) }
      : x instanceof Uint8Array ? { $b: hex(x) }
        : typeof x === "number" && !Number.isFinite(x) ? { $f: String(x) } : x);

export const decode = <T>(s: string): T =>
  JSON.parse(s, (_k, x) =>
    x && typeof x === "object" && typeof x.$i === "string" ? BigInt(x.$i)
      : x && typeof x === "object" && typeof x.$b === "string" ? unhex(x.$b)
        : x && typeof x === "object" && typeof x.$f === "string" ? Number(x.$f)
          : x) as T;

/**
 * 項を op でつなぐ。2 項の演算子で n 個の項をつなぐと、式の木の深さが n になる。DO の SQLite は深さを 100 までに制限しているので
 * (src/shard-limits.ts の SHARD_LIMITS.exprDepth)、16 個を超えたら、釣り合った木に組む。深さは項の数の対数で増える。
 * 括弧は SQLite の式の節を作らないので、括弧で組んだ形がそのまま木になる。
 */
export function joinTerms(terms: string[], op: "AND" | "OR"): string {
  if (terms.length <= 16) return terms.join(` ${op} `);
  const mid = Math.ceil(terms.length / 2);
  return `(${joinTerms(terms.slice(0, mid), op)}) ${op} (${joinTerms(terms.slice(mid), op)})`;
}

/** 主キーの列が、束縛した値と等しい条件。prefix は列の修飾である (`"t".`)。 */
export const keyWhere = (cols: string[], prefix = "") => joinTerms(cols.map((c) => `${prefix}${q(c)} IS ?`), "AND");

/**
 * UNIQUE の列が、束縛した値と等しい条件 (書き込みが UNIQUE の検査で読む行の範囲。src/client/spans.ts)。`=` は列の照合順序で比べる。
 * 列が多いと、つないだ条件の深さが列の数だけ増えるので、釣り合った木に組む (joinTerms)。
 */
export const uniqueWhere = (table: string, cols: string[]) => joinTerms(cols.map((c) => `${q(table)}.${q(c)} = ?`), "AND");

/**
 * 行イメージが条件の範囲 (pred の span) を満たすかを、本物の表で判定する文 (ShardKernel.rowMatches)。主キーで 1 行に絞る。
 * 条件と主キーの条件の深さを足した深さになるので、プランナは走査の条件をこの形でも上限に収める (src/sql/plan.ts の scanFits)。
 */
export const predicateRowSql = (def: Pick<TableDef, "name" | "pk">, alias: string, where: string): string =>
  `SELECT NULL FROM ${q(def.name)} AS ${q(alias)} WHERE (${where}) AND ${keyWhere(def.pk, `${q(alias)}.`)} LIMIT 1`;
const pkWhere = (def: TableDef) => keyWhere(def.pk);
/** 主キーのキー文字列を、束縛する値に戻す (src/keys.ts の keyValues)。 */
export const pkValues = (pkJson: string): Value[] => keyValues(pkJson);

/** PRIMARY KEY のない表は rowid も行イメージに含める。行の所在を決める値だからである。 */
export const selectList = (def: TableDef) => (def.implicitRowid ? "rowid, *" : "*");

/**
 * Worker が組み立てる走査の列の並び。列を、計画した表定義から名指しする。`*` だと、計画より新しい版を適用したシャードが
 * 増えた列も返し、シャードによって行の形が違って混ざる (ADD COLUMN の途中。計画書の未解決の問題 11)。
 */
export const scanList = (def: TableDef) => [...(def.implicitRowid ? ["rowid"] : []), ...def.columns.map(q)].join(", ");

// ---- タプル ----

/** 行イメージの列の並び。PRIMARY KEY のない表は rowid を先に置く (今の selectList と同じ順)。 */
export const imageColumns = (def: Pick<TableDef, "columns" | "implicitRowid">): string[] =>
  def.implicitRowid ? ["rowid", ...def.columns] : def.columns;

/** 列の参照。rowid は引用しない。引用すると、rowid という名前の利用者の列を指す。 */
const ref = (prefix: string, c: string) => (c === "rowid" ? `${prefix}rowid` : `${prefix}${q(c)}`);

/** 行イメージのタプルを作る式。prefix は trigger の `new.` や `old.` である。 */
export const imageSql = (def: Pick<TableDef, "columns" | "implicitRowid">, prefix = ""): string =>
  tupleSql(imageColumns(def).map((c) => ref(prefix, c)));

/**
 * 試験の検査 (docs/design-values.md の「足す検査」の 5)。report を入れると、次の食い違いを報告する。
 *   - 捕捉でまとめた変更後の行が、文を実行した後の本体の行と違う (読み直しをやめたので、まとめ方の誤りは黙って通る)。
 *   - タプルの長さが、読む表定義の列の数と違う (行イメージを作った版と読む版が同じになる 5 つの守りの、どれかが破れた)。
 * 本番では入れない。test/setup.ts が入れて、試験ごとに確かめる。報告するだけで、処理は変えない。
 */
export const imageChecks: { report?: (problem: string) => void } = {};

/**
 * 試験用の切り替え。欠陥を戻して、検査がそれを見つけることを確かめるのに使う。本番のコードは触らない。
 * roundedImages: 行イメージのタプルの INTEGER を、bigint ではなく JS の数 (Number) で値に戻す。2^53 を超える INTEGER は、隣の値に
 * 丸まって書き戻される (確定した取引の適用、移動で運んだ行、過去の時点への巻き戻し)。段 2 まで、DO の SQLite が INTEGER を丸めて
 * 返していたのと同じ形の欠陥である。
 */
export const imageFaults = { roundedImages: false };

/**
 * タプルが表定義のどの列の値かを決める。タプルが短ければ、先頭の列のイメージとして扱う (ADD COLUMN は列を末尾にだけ足すので、
 * 列名つきのイメージを新しい表に入れていたときと同じ結果になる。確定した取引の適用を止めない)。長ければ誤りにする。
 */
function columnsOf(def: TableDef, t: Tuple, strict = true): string[] {
  const cols = imageColumns(def);
  if (t.length === cols.length) return cols;
  if (!strict) return cols.slice(0, t.length);
  imageChecks.report?.(`a row image of ${def.name} has ${t.length} values, but the table has ${cols.length} columns`);
  if (t.length > cols.length) throw new SqlError(`a row image of ${def.name} has ${t.length} values, more than the ${cols.length} columns of the table`);
  return cols.slice(0, t.length);
}

/** 要素を値に戻す。 */
function valueAt(e: Elem | undefined): Value {
  const v = decodeElem(e ?? null);
  return imageFaults.roundedImages && typeof v === "bigint" ? Number(v) : v;
}

/** タプルを、表定義の列の順の値に戻す。 */
export function valuesOf(def: TableDef, t: Tuple): { columns: string[]; values: Value[] } {
  const columns = columnsOf(def, t);
  return { columns, values: columns.map((_c, i) => valueAt(t[i])) };
}

/** タプルの、名前で指した列の値。タプルが短くて値がなければ null。 */
export function imageAt(def: TableDef, t: Tuple, column: string): Value {
  const i = imageColumns(def).indexOf(column);
  if (i < 0) throw new SqlError(`no such column in a row image of ${def.name}: ${column}`);
  columnsOf(def, t);
  return i < t.length ? valueAt(t[i]) : null;
}

/** 列名から値への行を、タプルにする。JS で作るのは、index の表の項目 (`__gidx_*`) だけである。 */
export function tupleOfRow(def: TableDef, row: Row): Tuple {
  return imageColumns(def).map((c) => encodeElem(row[c] ?? null));
}

/**
 * 行の同一性を表す文字列を作る。主キーと shard key の値を、そのまま並べたものである。
 * 主キー、shard key、シャードをまたぐ UNIQUE の列には、BINARY 以外の照合順序を付けられない (sql/ddl.ts が断る)。
 * だから、値が等しいことと、この文字列が等しいことは同じである。
 */
export function encodeKey(def: TableDef, row: Row): { pk: string; sk: string } {
  return {
    pk: keyString(def.pk.map((c) => row[c] ?? null)),
    sk: keyString(def.shardKey.map((c) => row[c] ?? null)),
  };
}

/** タプルの行のキー。encodeKey と同じ文字列になる。 */
export function tupleKey(def: TableDef, t: Tuple): { pk: string; sk: string } {
  return {
    pk: keyString(def.pk.map((c) => imageAt(def, t, c))),
    sk: keyString(def.shardKey.map((c) => imageAt(def, t, c))),
  };
}

/**
 * 書き込まれた行の主キーに NULL がないことを確かめる。
 *
 * SQLite は、INTEGER でない主キーの列に NULL を、いくつでも入れられる。主キーの値で行を名指しする仕組み (行イメージの適用、
 * intent、行ロック、検証) は、そういう行を互いに区別できず、別の行を書き換えてしまう。だから、主キーに NULL のある行は
 * 作らせない。断るかどうかは文と値だけで決まり、行がどのシャードにあるかには依らない。
 */
export function assertKeyed(def: TableDef, t: Tuple): void {
  if (def.implicitRowid) return;
  const col = def.pk.find((c) => imageAt(def, t, c) === null);
  if (col !== undefined) {
    // Drizzle の移行の記録の表は、Drizzle が作ると、こうなる。直し方を添える。
    const drizzle = def.name === "__drizzle_migrations"
      ? `. Drizzle creates this table with a SERIAL key that it leaves NULL; create the table first with drizzleMigrationsTable() from cf-d-infinity/client`
      : "";
    throw new SqlError(`unsupported: NULL in the primary key column ${col} of ${def.name}; rows are identified by their primary key, so every primary key column needs a value (declare it INTEGER PRIMARY KEY to have one assigned)${drizzle}`);
  }
}

/** タプルの SQL の結果を読む。結果は 1 列の JSON の文字列である。 */
const tupleIn = (v: Plain | undefined): Tuple => parseTuple(v as string);

/** 利用者の表に触る文の結果を、全部の行で読む。 */
export const queryAll = (b: Backend, sql: string, params: readonly Value[], label?: string): Plain[][] => [...b.query(sql, params, label).rows];

const selectGroupSql = (def: TableDef) => `SELECT ${imageSql(def)} FROM ${q(def.name)} WHERE ${keyWhere(def.shardKey)}`;
const selectRowSql = (def: TableDef) => `SELECT ${imageSql(def)} FROM ${q(def.name)} WHERE ${pkWhere(def)}`;
const insertRowSql = (def: TableDef, columns: string[]) =>
  `INSERT INTO ${q(def.name)} (${columns.map((c) => ref("", c)).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`;

/**
 * 行イメージを読み書きするために、シャードがこの表に対して実行する文 (引数は形だけの値)。表を作るときに、どれも DO の SQLite の
 * 上限に収まることを確かめる (Db.assertReplays)。収まらない表は、行を捕捉できないか、移動で運べない。
 */
export function imageStatements(def: TableDef): { sql: string; params: Value[] }[] {
  const zeros = (n: number) => Array.from({ length: n }, () => 0n);
  return [
    ...captureDdl(def).map((sql) => ({ sql, params: [] })),
    { sql: selectRowSql(def), params: zeros(def.pk.length) },
    { sql: selectGroupSql(def), params: zeros(def.shardKey.length) },
    { sql: insertRowSql(def, imageColumns(def)), params: zeros(imageColumns(def).length) },
    // 書き込みが UNIQUE の検査で読む行の範囲を、行イメージで判定する文 (src/client/spans.ts の規則 3、ShardKernel.rowMatches)。
    ...def.uniques.map((cols) => ({ sql: predicateRowSql(def, def.name, uniqueWhere(def.name, cols)), params: zeros(cols.length + def.pk.length) })),
  ];
}

/** shard key が g のグループの行を全部読む。 */
export function selectGroup(b: Backend, def: TableDef, g: string): Tuple[] {
  const vals = keyValues(g);
  if (vals.length !== def.shardKey.length) return [];
  return queryAll(b, selectGroupSql(def), vals).map((r) => tupleIn(r[0]));
}

export function selectRow(b: Backend, def: TableDef, pk: string): Tuple | null {
  const r = queryAll(b, selectRowSql(def), pkValues(pk))[0];
  return r ? tupleIn(r[0]) : null;
}

/** 行を入れる。束縛する値は列ごとに 1 つで、表を作るときに DO の上限 (100) に収まることを確かめている (imageStatements)。 */
export function insertRow(b: Backend, def: TableDef, t: Tuple): void {
  const { columns, values } = valuesOf(def, t);
  queryAll(b, insertRowSql(def, columns), values);
}

export function deleteRow(b: Backend, def: TableDef, pk: string): void {
  queryAll(b, `DELETE FROM ${q(def.name)} WHERE ${pkWhere(def)}`, pkValues(pk));
}

function updateRow(b: Backend, def: TableDef, pk: string, t: Tuple): void {
  const { columns, values } = valuesOf(def, t);
  const set = columns.map((c, i) => [c, values[i]!] as const).filter(([c]) => !def.pk.includes(c));
  if (set.length === 0) return;
  queryAll(
    b,
    `UPDATE ${q(def.name)} SET ${set.map(([c]) => `${ref("", c)} = ?`).join(", ")} WHERE ${pkWhere(def)}`,
    [...set.map(([, v]) => v), ...pkValues(pk)],
  );
}

/**
 * 差分行を全部消してから入れ直す。途中の状態は常に目標状態の部分集合なので、
 * 目標状態が UNIQUE を満たす限り違反しない (UNIQUE swap でも成立する)。
 */
export function setBasedRestore(
  b: Backend,
  catalog: (t: string) => TableDef,
  targets: { table: string; pk: string; image: Tuple | null }[],
): void {
  b.exec("PRAGMA defer_foreign_keys = ON");
  for (const t of targets) deleteRow(b, catalog(t.table), t.pk);
  for (const t of targets) if (t.image) insertRow(b, catalog(t.table), t.image);
}

/** 行ごとに戻す素朴な実装。UNIQUE swap で失敗する。反例の再現テストだけが使う。 */
export function rowwiseRestore(
  b: Backend,
  catalog: (t: string) => TableDef,
  targets: { table: string; pk: string; image: Tuple | null }[],
): void {
  for (const t of targets) {
    const def = catalog(t.table);
    const current = selectRow(b, def, t.pk);
    if (!t.image) deleteRow(b, def, t.pk);
    else if (current) updateRow(b, def, t.pk, t.image);
    else insertRow(b, def, t.image);
  }
}

/** 2 つの要素が同じ値か。要素を文字で比べない。SQL が作った REAL と JS が作った REAL は、同じ値でも文字が違うことがある。 */
function sameValue(a: Elem | undefined, b: Elem | undefined): boolean {
  const x: Value = decodeElem(a ?? null);
  const y: Value = decodeElem(b ?? null);
  if (x instanceof Uint8Array || y instanceof Uint8Array) {
    return x instanceof Uint8Array && y instanceof Uint8Array && x.length === y.length && x.every((v, i) => v === y[i]);
  }
  return x === y;
}

function touchesUniqueOnManyRows(def: TableDef, changes: Change[]): boolean {
  if (def.uniques.length === 0) return false;
  const cols = imageColumns(def);
  const at = [...new Set(def.uniques.flat())].map((c) => cols.indexOf(c));
  const touched = changes.filter((c) => c.before && c.after && at.some((i) => !sameValue(c.before![i], c.after![i])));
  return touched.length >= 2;
}

/**
 * commit 確定後の本体への適用。呼び出し側のトランザクション内で実行する。
 * 既定は行単位で、UNIQUE 列を複数行で変える取引だけ set-based にする。
 * 行単位の swap は SQLITE_CONSTRAINT になり、確定後に適用不能のまま詰まるからである。
 */
export function applyChanges(b: Backend, catalog: (t: string) => TableDef, changes: Change[]): void {
  const byTable = new Map<string, Change[]>();
  for (const c of changes) byTable.set(c.table, [...(byTable.get(c.table) ?? []), c]);
  for (const [table, list] of byTable) {
    const def = catalog(table);
    if (touchesUniqueOnManyRows(def, list)) {
      setBasedRestore(b, catalog, list.map((c) => ({ table, pk: c.pk, image: c.after })));
      continue;
    }
    for (const c of list) {
      const exists = selectRow(b, def, c.pk) !== null;
      if (!c.after) deleteRow(b, def, c.pk);
      else if (exists) updateRow(b, def, c.pk, c.after);
      else insertRow(b, def, c.after);
    }
  }
}

// ---- 捕捉 ----

/**
 * 文を解析せずに行の変更を捕捉する trigger を作る。変更前と変更後の行を、タプルにして共有の __cap に書く。
 * __cap に書くのは TEXT だけなので、DO でも型を落とさない。__cap_on に行があるときだけ記録するので、dry-run の外では書き込まない。
 * 表定義の版を適用するたびに作り直すのは、この trigger だけである。
 */
export function captureDdl(def: Pick<TableDef, "name" | "columns" | "implicitRowid">): string[] {
  const t = def.name;
  const when = `WHEN EXISTS (SELECT 1 FROM __cap_on)`;
  const name = (op: string) => q(`__cap_${t}_${op}`);
  const tn = `'${t.replaceAll("'", "''")}'`;
  const cap = (old: string, fresh: string) => `INSERT INTO __cap(tbl, old, new) VALUES (${tn}, ${old}, ${fresh});`;
  return [
    `CREATE TRIGGER ${name("I")} AFTER INSERT ON ${q(t)} ${when} BEGIN ${cap("NULL", imageSql(def, "new."))} END`,
    `CREATE TRIGGER ${name("U")} AFTER UPDATE ON ${q(t)} ${when} BEGIN ${cap(imageSql(def, "old."), imageSql(def, "new."))} END`,
    `CREATE TRIGGER ${name("D")} AFTER DELETE ON ${q(t)} ${when} BEGIN ${cap(imageSql(def, "old."), "NULL")} END`,
  ];
}

export function dropCaptureDdl(t: string): string[] {
  return [
    `DROP TRIGGER IF EXISTS ${q(`__cap_${t}_I`)}`,
    `DROP TRIGGER IF EXISTS ${q(`__cap_${t}_U`)}`,
    `DROP TRIGGER IF EXISTS ${q(`__cap_${t}_D`)}`,
  ];
}

export const CAPTURE_TABLES = [
  `CREATE TABLE IF NOT EXISTS __cap(seq INTEGER PRIMARY KEY, tbl TEXT NOT NULL, old TEXT, new TEXT)`,
  `CREATE TABLE IF NOT EXISTS __cap_on(x INTEGER)`,
];

/**
 * 捕捉した記録を pk ごとの正味の変更にまとめる。変更後の行は trigger の `new` から取り、本体から読み直さない。
 * `new` は型の親和性を掛けた後の値で、採番した rowid を持っている。記録を seq の順に見て、キーごとに次のようにまとめる。
 *   1. old があれば、old のキーの項目を取る (なければ before = old で作る)。after を null にする。
 *   2. new があれば、new のキーの項目を取る (なければ before = null で作る)。after を new にする。
 *   3. 最後に、before も after も null の項目 (同じ文の中で挿入して消した行) を捨てる。
 * 主キーを書き換える UPDATE は、古いキーの削除と新しいキーの挿入になる。REPLACE が消す行は、recursive_triggers で DELETE の
 * trigger が先に走るので、同じ規則に載る。利用者の trigger は作れず (sql/ddl.ts)、外部キーは強制しないので、行を書き換えるのは
 * 文そのものと、それが発火する捕捉の trigger だけである。最後の new が、文の後の本体の行である。
 *
 * inserted は、文が入れた行を、SQLite が入れた順に並べたものである。INSERT の trigger の記録 (old がなく new がある) だけを数える。
 * REPLACE が消してから入れた行は入り、UPSERT の DO UPDATE (UPDATE の trigger)、OR IGNORE が入れなかった行 (記録がない) は入らない。
 * 正味の変更からは、これを作れない (REPLACE で入れ直した行も、DO UPDATE で更新した行も、before と after のある変更になる)。
 * 文の結果の lastInsertRowid は、これだけから決める (ExecRes.inserted、src/client/db.ts の lastInsertRowid)。
 */
export function capturedChanges(b: Backend, catalog: (t: string) => TableDef): { changes: Change[]; inserted: Pick<Change, "table" | "pk">[] } {
  const net = new Map<string, { table: string; before: Tuple | null; after: Tuple | null }>();
  const inserted: Pick<Change, "table" | "pk">[] = [];
  for (const r of b.raw(`SELECT tbl, old, new FROM __cap ORDER BY seq`).values) {
    const table = r[0] as string;
    const def = catalog(table);
    const old = r[1] === null ? null : tupleIn(r[1]);
    const fresh = r[2] === null ? null : tupleIn(r[2]);
    if (fresh && !old) inserted.push({ table, pk: tupleKey(def, fresh).pk });
    if (old) {
      const at = `${table}\0${tupleKey(def, old).pk}`;
      const e = net.get(at);
      if (e) e.after = null;
      else net.set(at, { table, before: old, after: null });
    }
    if (fresh) {
      const at = `${table}\0${tupleKey(def, fresh).pk}`;
      const e = net.get(at);
      if (e) e.after = fresh;
      else net.set(at, { table, before: null, after: fresh });
    }
  }
  const out: Change[] = [];
  for (const n of net.values()) {
    const image = n.after ?? n.before;
    if (!image) continue; // 同じ文の中で挿入して消した行
    const def = catalog(n.table);
    if (n.after) assertKeyed(def, n.after);
    out.push({ table: n.table, ...tupleKey(def, image), before: n.before, after: n.after });
  }
  if (imageChecks.report) for (const c of out) checkAfter(b, catalog(c.table), c.pk, c.after, "the trigger capture");
  return { changes: out, inserted };
}

/** 試験の検査。捕捉でまとめた変更後の行が、本体の行と同じであること。 */
export function checkAfter(b: Backend, def: TableDef, pk: string, after: Tuple | null, how: string): void {
  const report = imageChecks.report;
  if (!report) return;
  const body = selectRow(b, def, pk);
  if (JSON.stringify(body) !== JSON.stringify(after)) {
    report(`${how} of ${def.name} ${pk} gives ${JSON.stringify(after)?.slice(0, 200)}, but the table holds ${JSON.stringify(body)?.slice(0, 200)}`);
  }
}

/** RETURNING で読んだ行を、捕捉と同じく確かめる (主キーの NULL)。 */
export function returnedRows(def: TableDef, values: Plain[][], keyed: boolean): Tuple[] {
  const rows = values.map((r) => tupleIn(r[0]));
  if (keyed) for (const t of rows) assertKeyed(def, t);
  return rows;
}

export function asSqlError(e: unknown): SqlError {
  return new SqlError(e instanceof Error ? e.message : String(e));
}
