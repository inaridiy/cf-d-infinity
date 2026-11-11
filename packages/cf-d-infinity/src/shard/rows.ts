import type { Backend, Change, Row, TableDef, Value } from "../types";
import { SqlError } from "../types";

export const q = (id: string) => `"${id.replaceAll('"', '""')}"`;

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (h) => parseInt(h, 16));

/** 行イメージを JSON にする。BLOB は JSON で表せないので印を付ける。 */
export const encode = (v: unknown): string =>
  JSON.stringify(v, (_k, x) => (x instanceof Uint8Array ? { $b: hex(x) } : x));

export const decode = <T>(s: string): T =>
  JSON.parse(s, (_k, x) => (x && typeof x === "object" && typeof x.$b === "string" ? unhex(x.$b) : x)) as T;

const pkWhere = (def: TableDef) => def.pk.map((c) => `${q(c)} IS ?`).join(" AND ");
export const pkValues = (pkJson: string) => decode<Value[]>(pkJson);

/** PRIMARY KEY のない表は rowid も行イメージに含める。行の所在を決める値だからである。 */
export const selectList = (def: TableDef) => (def.implicitRowid ? "rowid, *" : "*");

/** 照合順序で等しい値を同じ値に揃える。'Abc' と 'ABC' が別のシャードへ行くと一意性が破れる。 */
export function fold(v: Value, collation: string | undefined): Value {
  if (typeof v !== "string" || !collation) return v;
  if (collation === "NOCASE") return v.replace(/[A-Z]/g, (c) => c.toLowerCase());
  if (collation === "RTRIM") return v.replace(/ +$/, "");
  return v;
}

/**
 * 行の同一性を表す文字列を作る。主キーも shard key も、照合順序で等しい値は同じ文字列にする。
 * 揃えないと、'abc' と 'ABC' が SQLite では同じ行なのに、intent、ロック、検証では別の行として扱われる。
 * 揃えた値で行を引いても、列の照合順序で比べるので当たる。
 */
export function encodeKey(def: TableDef, row: Row): { pk: string; sk: string } {
  return {
    pk: encode(def.pk.map((c) => fold(row[c] ?? null, def.collation[c]))),
    sk: encode(def.shardKey.map((c) => fold(row[c] ?? null, def.collation[c]))),
  };
}

/**
 * 書き込まれた行の主キーに NULL がないことを確かめる。
 *
 * SQLite は、INTEGER でない主キーの列に NULL を、いくつでも入れられる。主キーの値で行を名指しする仕組み (行イメージの適用、
 * intent、行ロック、検証) は、そういう行を互いに区別できず、別の行を書き換えてしまう。だから、主キーに NULL のある行は
 * 作らせない。断るかどうかは文と値だけで決まり、行がどのシャードにあるかには依らない。
 */
export function assertKeyed(def: TableDef, row: Row): void {
  if (def.implicitRowid) return;
  const col = def.pk.find((c) => (row[c] ?? null) === null);
  if (col !== undefined) {
    throw new SqlError(`unsupported: NULL in the primary key column ${col} of ${def.name}; rows are identified by their primary key, so every primary key column needs a value`);
  }
}

/** shard key が g のグループの行を全部読む。 */
export function selectGroup(b: Backend, def: TableDef, g: string): Row[] {
  const vals = decode<Value[]>(g);
  if (vals.length !== def.shardKey.length) return [];
  const where = def.shardKey.map((c) => `${q(c)} IS ?`).join(" AND ");
  return b.exec(`SELECT ${selectList(def)} FROM ${q(def.name)} WHERE ${where}`, ...vals);
}

export function selectRow(b: Backend, def: TableDef, pk: string): Row | null {
  return b.exec(`SELECT ${selectList(def)} FROM ${q(def.name)} WHERE ${pkWhere(def)}`, ...pkValues(pk))[0] ?? null;
}

/** 行イメージのうち、書き込める列。生成列は SQLite が計算するので、値を指定すると拒否される。 */
export const writable = (def: Pick<TableDef, "generated">, cols: string[]): string[] =>
  def.generated?.length ? cols.filter((c) => !def.generated!.includes(c)) : cols;

export function insertRow(b: Backend, def: TableDef, row: Row): void {
  const cols = writable(def, Object.keys(row));
  b.exec(
    `INSERT INTO ${q(def.name)} (${cols.map(q).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
    ...cols.map((c) => row[c] ?? null),
  );
}

export function deleteRow(b: Backend, def: TableDef, pk: string): void {
  b.exec(`DELETE FROM ${q(def.name)} WHERE ${pkWhere(def)}`, ...pkValues(pk));
}

function updateRow(b: Backend, def: TableDef, pk: string, row: Row): void {
  const cols = writable(def, Object.keys(row)).filter((c) => !def.pk.includes(c));
  if (cols.length === 0) return;
  b.exec(
    `UPDATE ${q(def.name)} SET ${cols.map((c) => `${q(c)} = ?`).join(", ")} WHERE ${pkWhere(def)}`,
    ...cols.map((c) => row[c] ?? null),
    ...pkValues(pk),
  );
}

/**
 * 差分行を全部消してから入れ直す。途中の状態は常に目標状態の部分集合なので、
 * 目標状態が UNIQUE を満たす限り違反しない (UNIQUE swap でも成立する)。
 */
export function setBasedRestore(
  b: Backend,
  catalog: (t: string) => TableDef,
  targets: { table: string; pk: string; image: Row | null }[],
): void {
  b.exec("PRAGMA defer_foreign_keys = ON");
  for (const t of targets) deleteRow(b, catalog(t.table), t.pk);
  for (const t of targets) if (t.image) insertRow(b, catalog(t.table), t.image);
}

/** 行ごとに戻す素朴な実装。UNIQUE swap で失敗する。反例の再現テストだけが使う。 */
export function rowwiseRestore(
  b: Backend,
  catalog: (t: string) => TableDef,
  targets: { table: string; pk: string; image: Row | null }[],
): void {
  for (const t of targets) {
    const def = catalog(t.table);
    const current = selectRow(b, def, t.pk);
    if (!t.image) deleteRow(b, def, t.pk);
    else if (current) updateRow(b, def, t.pk, t.image);
    else insertRow(b, def, t.image);
  }
}

function touchesUniqueOnManyRows(def: TableDef, changes: Change[]): boolean {
  if (def.uniques.length === 0) return false;
  const cols = new Set(def.uniques.flat());
  const touched = changes.filter(
    (c) => c.before && c.after && [...cols].some((k) => c.before?.[k] !== c.after?.[k]),
  );
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

/**
 * 文を解析せずに行の変更を捕捉する trigger とミラー表を作る。
 * 値はミラー表に元の型のまま退避する。JSON を通すと BLOB と 1.0 の型が保てないからである。
 * __cap_on に行があるときだけ記録するので、dry-run の外では書き込まない。
 */
export function captureDdl(def: Pick<TableDef, "name" | "columns" | "pk" | "implicitRowid">): string[] {
  const t = def.name;
  const all = def.implicitRowid ? ["rowid", ...def.columns] : def.columns;
  const key = (row: "old" | "new") => `json_array(${def.pk.map((c) => `${row}.${q(c)}`).join(", ")})`;
  const mirror = q(`__capv_${t}`);
  const when = `WHEN EXISTS (SELECT 1 FROM __cap_on)`;
  const name = (op: string) => q(`__cap_${t}_${op}`);
  const save = `INSERT INTO ${mirror}(__seq, ${all.map(q).join(", ")}) VALUES ((SELECT max(seq) FROM __cap), ${all.map((c) => `old.${q(c)}`).join(", ")});`;
  const tn = `'${t.replaceAll("'", "''")}'`;
  return [
    `CREATE TABLE ${mirror}(__seq INTEGER PRIMARY KEY, ${all.map(q).join(", ")})`,
    `CREATE TRIGGER ${name("I")} AFTER INSERT ON ${q(t)} ${when} BEGIN INSERT INTO __cap(tbl, oldk, newk) VALUES (${tn}, NULL, ${key("new")}); END`,
    `CREATE TRIGGER ${name("U")} AFTER UPDATE ON ${q(t)} ${when} BEGIN INSERT INTO __cap(tbl, oldk, newk) VALUES (${tn}, ${key("old")}, ${key("new")}); ${save} END`,
    `CREATE TRIGGER ${name("D")} AFTER DELETE ON ${q(t)} ${when} BEGIN INSERT INTO __cap(tbl, oldk, newk) VALUES (${tn}, ${key("old")}, NULL); ${save} END`,
  ];
}

export function dropCaptureDdl(t: string): string[] {
  return [
    `DROP TRIGGER IF EXISTS ${q(`__cap_${t}_I`)}`,
    `DROP TRIGGER IF EXISTS ${q(`__cap_${t}_U`)}`,
    `DROP TRIGGER IF EXISTS ${q(`__cap_${t}_D`)}`,
    `DROP TABLE IF EXISTS ${q(`__capv_${t}`)}`,
  ];
}

export const CAPTURE_TABLES = [
  `CREATE TABLE IF NOT EXISTS __cap(seq INTEGER PRIMARY KEY, tbl TEXT NOT NULL, oldk TEXT, newk TEXT)`,
  `CREATE TABLE IF NOT EXISTS __cap_on(x INTEGER)`,
];

/** 捕捉した記録を pk ごとの正味の変更にまとめる。変更後の値は文の実行後の本体から読む。 */
export function capturedChanges(b: Backend, catalog: (t: string) => TableDef): Change[] {
  const net = new Map<string, { table: string; pk: string; before: Row | null }>();
  for (const r of b.exec(`SELECT seq, tbl, oldk, newk FROM __cap ORDER BY seq`)) {
    const table = r.tbl as string;
    const def = catalog(table);
    const norm = (k: Value | undefined) => encode(JSON.parse(k as string));
    const old = (r.oldk ?? null) === null ? null : norm(r.oldk);
    const fresh = (r.newk ?? null) === null ? null : norm(r.newk);
    if (old !== null && !net.has(`${table}\0${old}`)) {
      const row = b.exec(`SELECT * FROM ${q(`__capv_${table}`)} WHERE __seq = ?`, r.seq as number)[0]!;
      const { __seq: _drop, ...before } = row;
      net.set(`${table}\0${old}`, { table, pk: old, before });
    }
    if (fresh !== null && !net.has(`${table}\0${fresh}`)) {
      net.set(`${table}\0${fresh}`, { table, pk: fresh, before: null });
    }
    void def;
  }
  const out: Change[] = [];
  for (const n of net.values()) {
    const def = catalog(n.table);
    const after = selectRow(b, def, n.pk);
    const image = after ?? n.before;
    if (!image) continue; // 同じ文の中で挿入して消した行
    if (after) assertKeyed(def, after);
    out.push({ table: n.table, ...encodeKey(def, image), before: n.before, after });
  }
  return out;
}

export function asSqlError(e: unknown): SqlError {
  return new SqlError(e instanceof Error ? e.message : String(e));
}
