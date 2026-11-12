import type { Backend, Change, Row, TableDef, Value } from "../types";
import { SqlError } from "../types";
import { keySql, keyString } from "../keys";
import { realOf } from "../value";

export const q = (id: string) => `"${id.replaceAll('"', '""')}"`;

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (h) => parseInt(h, 16));

/**
 * 行イメージを JSON にする。BLOB と、JSON で表せない数 (無限大) は印を付ける。整数の値の REAL (src/value.ts) は
 * `{"real": 5}` のまま入る。
 */
export const encode = (v: unknown): string =>
  JSON.stringify(v, (_k, x) =>
    x instanceof Uint8Array ? { $b: hex(x) } : typeof x === "number" && !Number.isFinite(x) ? { $f: String(x) } : x);

export const decode = <T>(s: string): T =>
  JSON.parse(s, (_k, x) =>
    x && typeof x === "object" && typeof x.$b === "string" ? unhex(x.$b)
      : x && typeof x === "object" && typeof x.$f === "string" ? Number(x.$f)
        : x) as T;

const pkWhere = (def: TableDef) => def.pk.map((c) => `${q(c)} IS ?`).join(" AND ");
export const pkValues = (pkJson: string) => decode<Value[]>(pkJson);

/** PRIMARY KEY のない表は rowid も行イメージに含める。行の所在を決める値だからである。 */
export const selectList = (def: TableDef) => (def.implicitRowid ? "rowid, *" : "*");

/**
 * 型のない列 (BLOB の親和性)。INTEGER の 5 と REAL の 5.0 を両方持てるが、DO の SQLite は読み出しで区別しない (src/value.ts)。
 * ほかの列は、入れ直すときに列の型の親和性が同じ型に戻す。
 */
const untypedColumns = (def: Pick<TableDef, "columns" | "affinity">) => def.columns.filter((c) => (def.affinity[c] ?? "BLOB") === "BLOB");
const typeTag = (i: number) => `__dinf_typeof_${i}`;

/** 行イメージを読む SELECT の列の並び。型のない列には、型を一緒に読む列を足す (`typedRow` が戻す)。 */
export const imageList = (def: TableDef) =>
  [selectList(def), ...untypedColumns(def).map((c, i) => `typeof(${q(c)}) AS ${q(typeTag(i))}`)].join(", ");

/** imageList で読んだ行から、型を読んだ列を除き、整数の値の REAL に印を付ける。 */
export function typedRow(def: Pick<TableDef, "columns" | "affinity">, row: Row): Row {
  const cols = untypedColumns(def);
  if (cols.length === 0) return row;
  const out: Row = { ...row };
  cols.forEach((c, i) => {
    const t = out[typeTag(i)];
    delete out[typeTag(i)];
    const v = out[c];
    if (t === "real" && typeof v === "number" && Number.isInteger(v)) out[c] = realOf(v);
  });
  return out;
}

/** 列名と値の配列で読んだときの typedRow。 */
export function typedValues(def: Pick<TableDef, "columns" | "affinity">, columns: string[], rows: Value[][]): { columns: string[]; rows: Value[][] } {
  const cols = untypedColumns(def);
  if (cols.length === 0) return { columns, rows };
  const tagAt = cols.map((_c, i) => columns.indexOf(typeTag(i)));
  const valAt = cols.map((c) => columns.indexOf(c));
  if (tagAt.some((i) => i < 0)) return { columns, rows };
  const keep = columns.map((_c, i) => !tagAt.includes(i));
  return {
    columns: columns.filter((_c, i) => keep[i]),
    rows: rows.map((r) => {
      const v = [...r];
      tagAt.forEach((t, k) => {
        const at = valAt[k]!;
        const x = v[at];
        if (at >= 0 && r[t] === "real" && typeof x === "number" && Number.isInteger(x)) v[at] = realOf(x);
      });
      return v.filter((_x, i) => keep[i]);
    }),
  };
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
    // Drizzle の移行の記録の表は、Drizzle が作ると、こうなる。直し方を添える。
    const drizzle = def.name === "__drizzle_migrations"
      ? `. Drizzle creates this table with a SERIAL key that it leaves NULL; create the table first with drizzleMigrationsTable() from cf-d-infinity/client`
      : "";
    throw new SqlError(`unsupported: NULL in the primary key column ${col} of ${def.name}; rows are identified by their primary key, so every primary key column needs a value (declare it INTEGER PRIMARY KEY to have one assigned)${drizzle}`);
  }
}

/** shard key が g のグループの行を全部読む。 */
export function selectGroup(b: Backend, def: TableDef, g: string): Row[] {
  const vals = decode<Value[]>(g);
  if (vals.length !== def.shardKey.length) return [];
  const where = def.shardKey.map((c) => `${q(c)} IS ?`).join(" AND ");
  return b.exec(`SELECT ${imageList(def)} FROM ${q(def.name)} WHERE ${where}`, ...vals).map((r) => typedRow(def, r));
}

export function selectRow(b: Backend, def: TableDef, pk: string): Row | null {
  const row = b.exec(`SELECT ${imageList(def)} FROM ${q(def.name)} WHERE ${pkWhere(def)}`, ...pkValues(pk))[0];
  return row ? typedRow(def, row) : null;
}

export function insertRow(b: Backend, def: TableDef, row: Row): void {
  const cols = Object.keys(row);
  b.exec(
    `INSERT INTO ${q(def.name)} (${cols.map(q).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
    ...cols.map((c) => row[c] ?? null),
  );
}

export function deleteRow(b: Backend, def: TableDef, pk: string): void {
  b.exec(`DELETE FROM ${q(def.name)} WHERE ${pkWhere(def)}`, ...pkValues(pk));
}

function updateRow(b: Backend, def: TableDef, pk: string, row: Row): void {
  const cols = Object.keys(row).filter((c) => !def.pk.includes(c));
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
  const key = (row: "old" | "new") => keySql(def.pk.map((c) => `${row}.${q(c)}`));
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
    const norm = (k: Value | undefined) => keyString(JSON.parse(k as string) as Value[]);
    const old = (r.oldk ?? null) === null ? null : norm(r.oldk);
    const fresh = (r.newk ?? null) === null ? null : norm(r.newk);
    if (old !== null && !net.has(`${table}\0${old}`)) {
      // 写しの表は型のない列だけなので、型は保たれている。読み出しで失わないよう、元の表の型のない列の型を一緒に読む。
      const mirror = { columns: def.columns, affinity: def.affinity };
      const tags = def.columns.filter((c) => (def.affinity[c] ?? "BLOB") === "BLOB").map((c, i) => `, typeof(${q(c)}) AS ${q(typeTag(i))}`).join("");
      const row = typedRow(mirror, b.exec(`SELECT *${tags} FROM ${q(`__capv_${table}`)} WHERE __seq = ?`, r.seq as number)[0]!);
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
