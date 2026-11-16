// UNIQUE の文の差分の検査の部品 (docs/design-unique-keys.md の段 0 の (c))。test/unique-diff.test.ts が使う。
//
// seed から、UNIQUE のある表の形 (FAMILIES) を 2 つ選び、表を作る文、初めの行、UNIQUE に触れる文の台本を作る。同じ台本を、
// シャード 1、2、4 と、1 シャードを slot の境目で 3 回分割した 4 シャードで流し、文ごとに node:sqlite と比べる。
// 基準経路だけの 2 つの実行 (vitest.config.ts の reference-scans と reference-full) でも、同じ比べ方で流す。
//
// 何を比べるか:
// - 文ごとの答え。書き込みは変更した行の数、読みは行、誤りは文言。`unsupported:` で断った文は、REFUSED の一覧にあれば、断った形として
//   数え、SQLite でも実行しない (test/diff.ts と同じ約束。SQLite と同じ答えを返すか、文の形と表定義で断るか)。一覧にない拒否は違いである。
// - 表の中身。取引の外の書き込みの後 (誤りで終わったものも)、取引の終わり、台本の終わりに、
//   全部の表を読んで比べる。値は typeof() と hex() と quote() で読む (NOCASE や RTRIM の表で、どの綴りの行が残ったかまで比べる。
//   ドライバは TEXT を NUL で切るので、hex() で読む)。
// - 断った形は、どの置き場所でも同じである。
// - 台本の終わりに、intent と未適用の確定が残らず、グローバル index が行と一致する (test/invariants.ts の quiescentProblems)。
//   範囲の検査 (test/setup.ts) は、どの文にも掛かる。
//
// 行を訪ねる順で答えが変わる文 (設計の「シャードの中」の節の仮定): 2 行だけに触れる UPDATE の一部の形で、台本は印 (order) を付ける。
// その文は、SQLite で 2 通り (ふつうの順と、PRAGMA reverse_unordered_selects で逆にした順) に実行し、D∞ の答えと表の中身が
// どちらかに一致すれば合格にする。一致した方を、その後の基準にする。印のない文は、ふつうの順の答えと一致しなければならない。
// 2 行の文なので、2 つの順で全部の答えが出る。取引の中では、この形を作らない (表の中身を取引の外から読めない)。
import { DatabaseSync } from "node:sqlite";
import { split } from "../src/autoscaler";
import { Db } from "../src/client/db";
import { shardsOf, SUBSLOTS } from "../src/routing";
import { quiescentProblems } from "./invariants";
import { asNumbers, prng, SimCluster } from "./sim";

type Rnd = () => number;

// ---- 表の形 ----

/** UNIQUE の列 1 つの見方。1 つの表に、UNIQUE ごとに 1 つある。 */
interface Spec {
  table: string;
  /** shard key の列と、値の literal。ない表は、主キーが id 1 列である。 */
  tenant?: { col: string; values: string[] };
  /** UNIQUE の列と、値の literal (NULL を含む)。int なら、値の足し引きで入れ替えられる。 */
  uniq: { col: string; values: string[]; int?: boolean };
  /** 衝突の対象 (ON CONFLICT の列の並びと、部分 index の条件)。 */
  target: string;
  /** 部分 index の条件の列。値を 0 と 1 で入れ替えると、行が index に出入りする。 */
  partial?: string;
  /** 行の列。 */
  columns: string[];
  /** 行の値の literal。 */
  row: (r: Rnd, o: { tenant: string; id: number; uniq: string }) => string;
}

export interface Family {
  name: string;
  /** 表を作る文。最初の文が表で、それが断られたら、この形の文は流さない。 */
  ddl: string[];
  /** 初めの行。 */
  rows: string[];
  specs: Spec[];
  /** 全行を読む文。 */
  dumps: string[];
}

/** 列を型と値の文字で読む式。TEXT と BLOB は 16 進で読む。 */
const cell = (c: string) => `typeof(${c}) || ':' || CASE typeof(${c}) WHEN 'text' THEN hex(${c}) WHEN 'blob' THEN hex(${c}) ELSE quote(${c}) END`;
const dumpOf = (table: string, columns: string[], order: string) => `SELECT ${columns.map(cell).join(", ")} FROM ${table} ORDER BY ${order}`;

const pickOf = (r: Rnd) => <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
const INTS = ["1", "2", "3", "4", "NULL"];
const CODES = ["'a'", "'b'", "'c'", "'d'", "NULL"];
const NOCASE_CODES = ["'a'", "'A'", "'b'", "'B'", "'ab'", "'Ab'", "'a '", "'a' || char(0) || 'x'", "'A' || char(0) || 'y'", "'é'", "'É'", "NULL"];
const RTRIM_CODES = ["'a'", "'a '", "'a  '", "'b'", "'b '", "' a'", "'a' || char(9)", "'a' || char(0)", "'a' || char(0) || ' '", "'ab'", "NULL"];
const EMAILS = ["'a@x'", "'b@x'", "'c@x'", "'d@x'", "NULL"];
const NOCASE_EMAILS = ["'a@x'", "'A@x'", "'b@x'", "'B@X'", "'a@x '", "'a' || char(0) || '1'", "'A' || char(0) || '2'", "NULL"];
const RTRIM_EMAILS = ["'a@x'", "'a@x '", "'a@x  '", "'b@x'", "' a@x'", "'a@x' || char(9)", "NULL"];

/** shard key を持つ表 (tenant, id, uniq, n)。 */
function tenantSpec(table: string, tenants: string[], uniq: Spec["uniq"], extra: Partial<Spec> = {}): Spec {
  return {
    table, tenant: { col: "tenant", values: tenants }, uniq, target: `tenant, ${uniq.col}`,
    columns: ["tenant", "id", uniq.col, "n"],
    row: (r, o) => `(${o.tenant}, ${o.id}, ${o.uniq}, ${Math.floor(r() * 3)})`,
    ...extra,
  };
}
/** 主キーが id の表 (id, uniq, n)。 */
function flatSpec(table: string, uniq: Spec["uniq"], extra: Partial<Spec> = {}): Spec {
  return {
    table, uniq, target: uniq.col, columns: ["id", uniq.col, "n"],
    row: (r, o) => `(${o.id}, ${o.uniq}, ${Math.floor(r() * 3)})`,
    ...extra,
  };
}

const TENANTS = ["1", "2", "3"];
/** 初めの行。テナントごとに id 1 から 4。 */
const tenantRows = (table: string, cols: string, values: (t: number, id: number) => string, tenants = [1, 2, 3]) =>
  [`INSERT INTO ${table}(${cols}) VALUES ${tenants.flatMap((t) => [1, 2, 3, 4].map((id) => `(${values(t, id)})`)).join(", ")}`];

export const FAMILIES: Family[] = [
  {
    // シャードの中の UNIQUE (shard key を含む) と、shard key を含む部分 index の UNIQUE。
    name: "local UNIQUE and a partial UNIQUE",
    ddl: [
      "CREATE TABLE p(tenant INTEGER NOT NULL, id INTEGER NOT NULL, u INTEGER, code TEXT, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (tenant, id), UNIQUE (tenant, u))",
      "CREATE UNIQUE INDEX p_code ON p(tenant, code) WHERE n > 0",
    ],
    rows: tenantRows("p", "tenant, id, u, code, n", (t, id) => `${t}, ${id}, ${id}, '${"abcd"[id - 1]}', ${id % 2}`),
    specs: [
      tenantSpec("p", TENANTS, { col: "u", values: INTS, int: true }, { columns: ["tenant", "id", "u", "code", "n"], row: (r, o) => `(${o.tenant}, ${o.id}, ${o.uniq}, ${pickOf(r)(CODES)}, ${Math.floor(r() * 2)})` }),
      tenantSpec("p", TENANTS, { col: "code", values: CODES }, { target: "tenant, code) WHERE (n > 0", partial: "n", columns: ["tenant", "id", "u", "code", "n"], row: (r, o) => `(${o.tenant}, ${o.id}, ${pickOf(r)(INTS)}, ${o.uniq}, ${Math.floor(r() * 2)})` }),
    ],
    dumps: [dumpOf("p", ["tenant", "id", "u", "code", "n"], "tenant, id")],
  },
  {
    // シャードをまたぐ UNIQUE 2 つ。
    name: "UNIQUE without the shard key",
    ddl: ["CREATE TABLE g(id INTEGER PRIMARY KEY, u INTEGER UNIQUE, email TEXT, n INTEGER NOT NULL DEFAULT 0, UNIQUE (email))"],
    rows: [`INSERT INTO g(id, u, email, n) VALUES ${[1, 2, 3, 4, 5, 6].map((id) => `(${id}, ${id}, '${"abcdef"[id - 1]}@x', 0)`).join(", ")}`],
    specs: [
      flatSpec("g", { col: "u", values: [...INTS, "5", "6"], int: true }, { columns: ["id", "u", "email", "n"], row: (r, o) => `(${o.id}, ${o.uniq}, ${pickOf(r)(EMAILS)}, 0)` }),
      flatSpec("g", { col: "email", values: EMAILS }, { columns: ["id", "u", "email", "n"], row: (r, o) => `(${o.id}, ${pickOf(r)(INTS)}, ${o.uniq}, 0)` }),
    ],
    dumps: [dumpOf("g", ["id", "u", "email", "n"], "id")],
  },
  {
    // NOCASE の列の UNIQUE。shard key を含むものは受け付けている。
    name: "NOCASE UNIQUE with the shard key",
    ddl: ["CREATE TABLE cn(tenant INTEGER NOT NULL, id INTEGER NOT NULL, code TEXT COLLATE NOCASE, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (tenant, id), UNIQUE (tenant, code))"],
    rows: tenantRows("cn", "tenant, id, code", (t, id) => `${t}, ${id}, ${["'a'", "'B'", "'a' || char(0) || 'x'", "'é'"][id - 1]}`),
    specs: [tenantSpec("cn", TENANTS, { col: "code", values: NOCASE_CODES })],
    dumps: [dumpOf("cn", ["tenant", "id", "code", "n"], "tenant, id")],
  },
  {
    name: "RTRIM UNIQUE with the shard key",
    ddl: ["CREATE TABLE cr(tenant INTEGER NOT NULL, id INTEGER NOT NULL, code TEXT COLLATE RTRIM, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (tenant, id), UNIQUE (tenant, code))"],
    rows: tenantRows("cr", "tenant, id, code", (t, id) => `${t}, ${id}, ${["'a'", "'b '", "' a'", "'a' || char(0)"][id - 1]}`),
    specs: [tenantSpec("cr", TENANTS, { col: "code", values: RTRIM_CODES })],
    dumps: [dumpOf("cr", ["tenant", "id", "code", "n"], "tenant, id")],
  },
  {
    // shard key を含まない NOCASE の UNIQUE。いまは表定義で断る (段 2 で受け付ける)。
    name: "NOCASE UNIQUE without the shard key",
    ddl: ["CREATE TABLE gn(id INTEGER PRIMARY KEY, email TEXT COLLATE NOCASE UNIQUE, n INTEGER NOT NULL DEFAULT 0)"],
    rows: [`INSERT INTO gn(id, email) VALUES (1, 'a@x'), (2, 'B@x'), (3, 'a' || char(0) || '1'), (4, 'c@x')`],
    specs: [flatSpec("gn", { col: "email", values: NOCASE_EMAILS })],
    dumps: [dumpOf("gn", ["id", "email", "n"], "id")],
  },
  {
    name: "RTRIM UNIQUE without the shard key",
    ddl: ["CREATE TABLE gr(id INTEGER PRIMARY KEY, email TEXT, n INTEGER NOT NULL DEFAULT 0)", "CREATE UNIQUE INDEX gr_email ON gr(email COLLATE RTRIM)"],
    rows: [`INSERT INTO gr(id, email) VALUES (1, 'a@x'), (2, 'b@x '), (3, ' a@x'), (4, 'c@x')`],
    specs: [flatSpec("gr", { col: "email", values: RTRIM_EMAILS })],
    dumps: [dumpOf("gr", ["id", "email", "n"], "id")],
  },
  {
    // shard key を含まない部分 index の UNIQUE。いまは index を断る。表はある。
    name: "partial UNIQUE without the shard key",
    ddl: ["CREATE TABLE gp(id INTEGER PRIMARY KEY, email TEXT, live INTEGER NOT NULL DEFAULT 1)", "CREATE UNIQUE INDEX gp_live ON gp(email) WHERE live = 1"],
    rows: [`INSERT INTO gp(id, email, live) VALUES (1, 'a@x', 1), (2, 'a@x', 0), (3, 'b@x', 1), (4, 'c@x', 0)`],
    specs: [flatSpec("gp", { col: "email", values: EMAILS }, { target: "email) WHERE (live = 1", partial: "live", columns: ["id", "email", "live"], row: (r, o) => `(${o.id}, ${o.uniq}, ${Math.floor(r() * 2)})` })],
    dumps: [dumpOf("gp", ["id", "email", "live"], "id")],
  },
  {
    // 式の UNIQUE index。shard key を含んでも含まなくても、いまは断る。表はある。
    name: "expression UNIQUE",
    ddl: [
      "CREATE TABLE e(tenant INTEGER NOT NULL, id INTEGER NOT NULL, code TEXT, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (tenant, id))",
      "CREATE UNIQUE INDEX e_lower ON e(tenant, lower(code))",
      "CREATE TABLE ex(id INTEGER PRIMARY KEY, email TEXT, n INTEGER NOT NULL DEFAULT 0)",
      "CREATE UNIQUE INDEX ex_lower ON ex(lower(email))",
    ],
    rows: [
      ...tenantRows("e", "tenant, id, code", (t, id) => `${t}, ${id}, '${"aBcD"[id - 1]}'`),
      `INSERT INTO ex(id, email) VALUES (1, 'a@x'), (2, 'B@x'), (3, 'c@x'), (4, 'D@x')`,
    ],
    specs: [
      tenantSpec("e", TENANTS, { col: "code", values: ["'a'", "'A'", "'b'", "'B'", "'c'", "NULL"] }, { target: "tenant, lower(code)" }),
      flatSpec("ex", { col: "email", values: ["'a@x'", "'A@x'", "'b@x'", "'B@X'", "NULL"] }, { target: "lower(email)" }),
    ],
    dumps: [dumpOf("e", ["tenant", "id", "code", "n"], "tenant, id"), dumpOf("ex", ["id", "email", "n"], "id")],
  },
  {
    // shard key の列を NOCASE で比べる UNIQUE (設計の「刷新案からのずれ」の 3)。'A' と 'a' のテナントの行がぶつかる。
    // 表の制約の形はパーサが断り、CREATE INDEX の形は表定義で断る。
    name: "UNIQUE that compares the shard key with NOCASE",
    ddl: [
      "CREATE TABLE tn(tenant TEXT NOT NULL, id INTEGER NOT NULL, code TEXT, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (tenant, id), UNIQUE (tenant COLLATE NOCASE, code))",
      "CREATE TABLE ti(tenant TEXT NOT NULL, id INTEGER NOT NULL, code TEXT, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (tenant, id))",
      "CREATE UNIQUE INDEX ti_code ON ti(tenant COLLATE NOCASE, code)",
    ],
    rows: [
      ...tenantRows("tn", "tenant, id, code", (t, id) => `'${"aAbB"[t]}', ${id}, '${"abcd"[id - 1]}'`, [0, 2]),
      ...tenantRows("ti", "tenant, id, code", (t, id) => `'${"aAbB"[t]}', ${id}, '${"abcd"[id - 1]}'`, [0, 2]),
    ],
    specs: [
      tenantSpec("tn", ["'a'", "'A'", "'b'", "'B'"], { col: "code", values: CODES }, { target: "tenant COLLATE NOCASE, code" }),
      tenantSpec("ti", ["'a'", "'A'", "'b'", "'B'"], { col: "code", values: CODES }, { target: "tenant COLLATE NOCASE, code" }),
    ],
    dumps: [dumpOf("tn", ["tenant", "id", "code", "n"], "tenant, id"), dumpOf("ti", ["tenant", "id", "code", "n"], "tenant, id")],
  },
  {
    // 表の制約の UNIQUE に衝突の処理を書くと (`UNIQUE (...) ON CONFLICT IGNORE`)、衝突の処理を書かない文がそれに従う。
    name: "UNIQUE constraints with their own ON CONFLICT",
    ddl: [
      "CREATE TABLE oc(tenant INTEGER NOT NULL, id INTEGER NOT NULL, code TEXT, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (tenant, id), UNIQUE (tenant, code) ON CONFLICT REPLACE)",
      "CREATE TABLE og(id INTEGER PRIMARY KEY, email TEXT, n INTEGER NOT NULL DEFAULT 0, UNIQUE (email) ON CONFLICT IGNORE)",
    ],
    rows: [
      ...tenantRows("oc", "tenant, id, code", (t, id) => `${t}, ${id}, '${"abcd"[id - 1]}'`),
      `INSERT INTO og(id, email) VALUES (1, 'a@x'), (2, 'b@x'), (3, 'c@x'), (4, 'd@x')`,
    ],
    specs: [tenantSpec("oc", TENANTS, { col: "code", values: CODES }), flatSpec("og", { col: "email", values: EMAILS })],
    dumps: [dumpOf("oc", ["tenant", "id", "code", "n"], "tenant, id"), dumpOf("og", ["id", "email", "n"], "id")],
  },
];

// ---- 台本 ----

export interface Step {
  i: number;
  shape: string;
  family: string;
  table: string | null;
  sql: string;
  /** 行を訪ねる順で答えが変わり得る。 */
  order?: boolean;
  /** 取引の中か。 */
  inTxn?: boolean;
}

export interface Script {
  seed: number;
  families: Family[];
  steps: Step[];
}

// OR FAIL と OR ROLLBACK は、文の形で断る (src/sql/plan.ts。計画書の不変条件 14)。断ることは test/conflict-actions-refused.test.ts が確かめる。
const CONFLICTS = ["", "OR IGNORE ", "OR REPLACE ", "OR ABORT "];

/** 文の形。名前は、最後の数え上げに使う。 */
export const SHAPES = [
  "insert", "insert two rows that conflict with each other", "insert three rows", "swap two values", "set two rows",
  "set one row", "upsert on the UNIQUE", "upsert on the primary key that writes the UNIQUE", "upsert without a target",
  "delete by the UNIQUE value", "insert select", "move a row into or out of the partial index", "read", "transaction",
] as const;

export function makeScript(seed: number, length = 30): Script {
  const r = prng(seed * 6007 + 11);
  const pick = pickOf(r);
  const int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
  const first = FAMILIES[seed % FAMILIES.length]!;
  let second = pick(FAMILIES);
  while (second === first) second = pick(FAMILIES);
  const families = [first, second];
  const steps: Step[] = [];
  let fresh = 100;
  let offset = 1000;
  const push = (s: Omit<Step, "i">) => steps.push({ i: steps.length, ...s });
  /** 1 つの文。inTxn では、行を訪ねる順で答えが変わる形を作らない。 */
  const statement = (inTxn: boolean): Omit<Step, "i"> => {
    const family = pick(families);
    const s = pick(family.specs);
    const t = s.tenant;
    const where = (tenant: string) => (t ? `${t.col} = ${tenant} AND ` : "");
    const tenant = () => (t ? pick(t.values) : "");
    const id = () => (r() < 0.15 ? int(1, 4) : fresh++);
    const existing = () => int(1, 4);
    const v = () => pick(s.uniq.values);
    const nonNull = () => pick(s.uniq.values.filter((x) => x !== "NULL"));
    const c = pick(CONFLICTS);
    const cols = s.columns.join(", ");
    const pkOf = (tn: string, i: number) => `${where(tn)}id = ${i}`;
    const base = { family: family.name, table: s.table };
    const shapes: (() => Omit<Step, "i">)[] = [
      () => ({ ...base, shape: "insert", sql: `INSERT ${c}INTO ${s.table}(${cols}) VALUES ${s.row(r, { tenant: tenant(), id: id(), uniq: v() })}` }),
      () => {
        const [tn, u] = [tenant(), nonNull()];
        return { ...base, shape: "insert two rows that conflict with each other", sql: `INSERT ${c}INTO ${s.table}(${cols}) VALUES ${s.row(r, { tenant: tn, id: fresh++, uniq: u })}, ${s.row(r, { tenant: tn, id: fresh++, uniq: u })}` };
      },
      () => ({ ...base, shape: "insert three rows", sql: `INSERT ${c}INTO ${s.table}(${cols}) VALUES ${[0, 1, 2].map(() => s.row(r, { tenant: tenant(), id: id(), uniq: v() })).join(", ")}` }),
      () => {
        // 2 つの値を入れ替える。UPDATE t SET u = 3 - u は、どちらの順で訪ねても、1 行目で UNIQUE に当たる。OR REPLACE だけは、
        // どちらの行が残るかが順で決まる。部分 index の UNIQUE (partial) では、index の外の行が同じ値を持てるので、3 行以上に当たる。
        // そのときの OR FAIL は、最初の衝突の前に訪ねた index の外の行の変更を残すので、順で答えが変わり、2 つの順では覆えない。作らない。
        const [a, b] = [nonNull(), nonNull()];
        const how = s.partial && c === "OR FAIL " ? "OR ABORT " : c;
        const set = s.uniq.int ? `${s.uniq.col} = (${a} + ${b}) - ${s.uniq.col}` : `${s.uniq.col} = CASE WHEN ${s.uniq.col} = ${a} THEN ${b} ELSE ${a} END`;
        return { ...base, shape: "swap two values", sql: `UPDATE ${how}${s.table} SET ${set} WHERE ${where(tenant())}${s.uniq.col} IN (${a}, ${b})`, order: how === "OR REPLACE " };
      },
      () => {
        const [i, j] = [existing(), existing()];
        const tn = tenant();
        return { ...base, shape: "set two rows", sql: `UPDATE ${c}${s.table} SET ${s.uniq.col} = CASE id WHEN ${i} THEN ${v()} ELSE ${v()} END WHERE ${where(tn)}id IN (${i}, ${j})`, order: true };
      },
      () => ({ ...base, shape: "set one row", sql: `UPDATE ${c}${s.table} SET ${s.uniq.col} = ${v()} WHERE ${pkOf(tenant(), existing())}` }),
      () => {
        const action = pick(["DO UPDATE SET n = n + 1", "DO NOTHING", `DO UPDATE SET n = n + 10 WHERE excluded.${s.uniq.col} IS NOT NULL`]);
        return { ...base, shape: "upsert on the UNIQUE", sql: `INSERT INTO ${s.table}(${cols}) VALUES ${s.row(r, { tenant: tenant(), id: id(), uniq: v() })} ON CONFLICT (${s.target}) ${action}` };
      },
      () => ({ ...base, shape: "upsert on the primary key that writes the UNIQUE", sql: `INSERT INTO ${s.table}(${cols}) VALUES ${s.row(r, { tenant: tenant(), id: id(), uniq: v() })} ON CONFLICT (${t ? `${t.col}, ` : ""}id) DO UPDATE SET ${s.uniq.col} = excluded.${s.uniq.col}` }),
      () => ({ ...base, shape: "upsert without a target", sql: `INSERT INTO ${s.table}(${cols}) VALUES ${s.row(r, { tenant: tenant(), id: id(), uniq: v() })} ON CONFLICT DO NOTHING` }),
      () => ({ ...base, shape: "delete by the UNIQUE value", sql: `DELETE FROM ${s.table} WHERE ${where(tenant())}${s.uniq.col} = ${nonNull()}` }),
      () => {
        const how = pick(["", "OR IGNORE ", "OR REPLACE "]);
        const at = (offset += 100);
        const sel = s.columns.map((col) => (col === "id" ? `id + ${at}` : col === t?.col ? tenant() : col)).join(", ");
        return { ...base, shape: "insert select", sql: `INSERT ${how}INTO ${s.table}(${cols}) SELECT ${sel} FROM ${s.table} WHERE ${t ? `${t.col} = ${tenant()}` : "id <= 3"}` };
      },
      () => {
        if (!s.partial) return { ...base, shape: "set one row", sql: `UPDATE ${c}${s.table} SET ${s.uniq.col} = ${v()} WHERE ${pkOf(tenant(), existing())}` };
        return { ...base, shape: "move a row into or out of the partial index", sql: `UPDATE ${c}${s.table} SET ${s.partial} = ${int(0, 1)} WHERE ${pkOf(tenant(), existing())}` };
      },
      () => {
        // TEXT の列は、型と 16 進で読む。node:sqlite のドライバは結果の TEXT を NUL で切る (seed 28 は、そのまま読んで基準の側が切れた、
        // 検査の誤りだった)。
        const sql = pick([
          `SELECT ${s.columns.map(cell).join(", ")} FROM ${s.table} WHERE ${t ? `${t.col} = ${tenant()}` : "id <= 4"} ORDER BY ${t ? `${t.col}, ` : ""}id`,
          `SELECT count(*), count(DISTINCT ${s.uniq.col}), count(${s.uniq.col}) FROM ${s.table}`,
          `SELECT ${t ? `${t.col}, ` : ""}id FROM ${s.table} WHERE ${s.uniq.col} = ${nonNull()} ORDER BY ${t ? `${t.col}, ` : ""}id`,
        ]);
        return { ...base, shape: "read", sql };
      },
    ];
    for (;;) {
      const st = pick(shapes)();
      if (!(inTxn && st.order)) return { ...st, inTxn };
    }
  };
  for (let k = 0; k < length; k++) {
    if (r() < 0.12) {
      push({ shape: "transaction", family: "", table: null, sql: "BEGIN", inTxn: true });
      for (let j = int(1, 3); j > 0; j--) push(statement(true));
      push({ shape: "transaction", family: "", table: null, sql: r() < 0.7 ? "COMMIT" : "ROLLBACK", inTxn: true });
    } else push(statement(false));
  }
  return { seed, families, steps };
}

// ---- 断る形 ----

/** D∞ が、文の形か表定義で断る UNIQUE の形。段 2 と段 3 で減る。 */
export interface Refusal {
  id: string;
  /** 断ってよい文。 */
  sql: RegExp;
  message: RegExp;
  /** 受け付けるようになる段 (docs/design-unique-keys.md の「段」)。null は UNIQUE の段の外 (計画書の不変条件 14 の作業で受け付ける)。 */
  stage: number | null;
}

export const REFUSED: Refusal[] = [
  {
    // 制約に書いた衝突の処理は、形で断る (src/sql/ddl.ts の assertNoConstraintConflictAction。計画書の不変条件 14)。
    id: "ON CONFLICT on a UNIQUE constraint",
    sql: /^CREATE TABLE (oc|og)\(/, message: /^unsupported: ON CONFLICT (REPLACE|IGNORE) on a constraint; /, stage: null,
  },
  {
    id: "NOCASE on a column of a UNIQUE without the shard key (column definition)",
    sql: /^CREATE TABLE gn\(/, message: /^unsupported: COLLATE NOCASE on column email of a UNIQUE constraint that does not include the shard key$/, stage: 2,
  },
  {
    // CREATE UNIQUE INDEX の列の COLLATE は、式と同じに扱われる (ddl.ts の createIndex)。
    id: "COLLATE on a column of a CREATE UNIQUE INDEX without the shard key",
    sql: /^CREATE UNIQUE INDEX gr_email /, message: /^unsupported: a UNIQUE partial or expression index that does not include the shard key$/, stage: 2,
  },
  {
    id: "partial UNIQUE index without the shard key",
    sql: /^CREATE UNIQUE INDEX gp_live /, message: /^unsupported: a UNIQUE partial or expression index that does not include the shard key$/, stage: 2,
  },
  {
    // shard key を含む式の UNIQUE index も断る (ddl.ts の createIndex は、列が名前だけの index だけを shard key を含むと見る)。
    // 設計の「部分 index と式の index」は「shard key を含むものは、シャードの SQLite が守っている」と書いているが、式の index は違う。
    id: "expression UNIQUE index, with or without the shard key",
    sql: /^CREATE UNIQUE INDEX (e_lower|ex_lower) /, message: /^unsupported: a UNIQUE partial or expression index that does not include the shard key$/, stage: 2,
  },
  {
    // パーサは、表の UNIQUE の列を名前だけで読み、COLLATE の付いた列を構文の誤りで断る (src/sql/parser.ts の constraint)。
    // unsupported: ではない。段 1 の resolveConstraints だけでは受け付けない。パーサも変える。
    id: "COLLATE on a column of a table UNIQUE (the parser's syntax error)",
    sql: /^CREATE TABLE tn\(/, message: /^near "COLLATE": syntax error$/, stage: 2,
  },
  {
    id: "COLLATE on the shard key column of a CREATE UNIQUE INDEX",
    sql: /^CREATE UNIQUE INDEX ti_code /, message: /^unsupported: a UNIQUE partial or expression index that does not include the shard key$/, stage: 2,
  },
];

// ---- 置き場所 ----

export interface Placement {
  name: string;
  shards: number;
  /** 1 シャードから、seed で選んだ slot の境目で、この回数だけ分割する。 */
  cuts?: number;
}

export const PLACEMENTS: Placement[] = [
  { name: "1 shard", shards: 1 },
  { name: "2 shards", shards: 2 },
  { name: "4 shards", shards: 4 },
  { name: "4 shards, cut by splits", shards: 4, cuts: 3 },
];

/** 一番広い範囲を、slot の境目で切る (test/placement-oracle.ts の splitAt と同じ)。いまの分割は slot の境目でしか切れない。 */
async function splitAt(c: SimCluster, r: Rnd, child: string): Promise<void> {
  const { routing } = await c.catalog();
  const parents = shardsOf(routing);
  const parent = parents[Math.floor(r() * parents.length)]!;
  const widest = routing.ranges.filter((x) => x.shard === parent).sort((x, y) => y.end - y.start - (x.end - x.start))[0]!;
  const first = Math.ceil(widest.start / SUBSLOTS) + 1;
  const last = Math.floor(widest.end / SUBSLOTS) - 1;
  const cut = (first + Math.floor(r() * (last - first + 1))) * SUBSLOTS;
  await split(c, parent, child, { range: { start: cut, end: widest.end } });
}

// ---- 実行と比べ方 ----

export type Outcome =
  | { kind: "ok"; changes: number; rows: unknown[][] | null }
  | { kind: "error"; message: string }
  | { kind: "refused"; message: string };

/**
 * 書き込みの文でなければ、変更した行の数を比べない。node:sqlite の changes は、最後の INSERT、UPDATE、DELETE の数を返し続けるので、
 * BEGIN や CREATE の後にも前の文の数が出る (検査の誤りだった)。
 */
const writes = (sql: string) => /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql);
const forSql = (sql: string, o: Outcome): Outcome => (o.kind === "ok" && !writes(sql) && o.rows === null ? { ...o, changes: 0 } : o);
const shownOutcome = (o: Outcome) => (o.kind === "ok" ? (o.rows ? `rows ${JSON.stringify(o.rows).slice(0, 200)}` : `changes ${o.changes}`) : `${o.kind} ${o.message}`);
const sameOutcome = (a: Outcome, b: Outcome) => shownOutcome(a) === shownOutcome(b) && JSON.stringify(a) === JSON.stringify(b);

/** node:sqlite の基準。実行した文を覚えておき、行を訪ねる順を変えた答えは、覚えた文を新しいデータベースで再生して作る。 */
class Reference {
  private history: { sql: string; reverse: boolean }[] = [];
  db = new DatabaseSync(":memory:");

  private static exec(db: DatabaseSync, sql: string, reverse: boolean): Outcome {
    db.exec(`PRAGMA reverse_unordered_selects = ${reverse ? 1 : 0}`);
    try {
      const st = db.prepare(sql);
      if (st.columns().length) return { kind: "ok", changes: 0, rows: asNumbers(st.all().map((row) => Object.values(row))) };
      return { kind: "ok", changes: Number(st.run().changes), rows: null };
    } catch (e) {
      return { kind: "error", message: (e as Error).message };
    } finally {
      db.exec("PRAGMA reverse_unordered_selects = 0");
    }
  }

  run(sql: string): Outcome {
    this.history.push({ sql, reverse: false });
    return Reference.exec(this.db, sql, false);
  }

  /** 2 つの順の答え。choose で選んだ方を、この後の基準にする。 */
  both(sql: string, dumps: string[]): { reverse: boolean; outcome: Outcome; dump: string[][][]; db: DatabaseSync }[] {
    return [false, true].map((reverse) => {
      const db = new DatabaseSync(":memory:");
      for (const h of this.history) Reference.exec(db, h.sql, h.reverse);
      const outcome = Reference.exec(db, sql, reverse);
      return { reverse, outcome, dump: dumps.map((d) => referenceDump(db, d)), db };
    });
  }

  choose(sql: string, c: { reverse: boolean; db: DatabaseSync }): void {
    this.history.push({ sql, reverse: c.reverse });
    this.db = c.db;
  }
}

const referenceDump = (db: DatabaseSync, sql: string): string[][] => {
  const st = db.prepare(sql);
  st.setReturnArrays(true);
  return st.all() as unknown as string[][];
};

async function dinf(db: Db, sql: string): Promise<Outcome> {
  try {
    const r = await db.query(sql);
    return r.columns.length ? { kind: "ok", changes: 0, rows: asNumbers(r.values) } : { kind: "ok", changes: r.changes, rows: null };
  } catch (e) {
    const message = (e as Error).message;
    return /^unsupported:/.test(message) || /^near "[^"]*": syntax error$/.test(message) ? { kind: "refused", message } : { kind: "error", message };
  }
}

async function dinfDump(db: Db, sql: string): Promise<string[][] | string> {
  try {
    return (await db.query(sql)).values as string[][];
  } catch (e) {
    return `ERROR ${(e as Error).message}`;
  }
}

/**
 * 既知の未解決の欠陥。既定の実行では伏せる。OPEN=1 では伏せない。
 * answer は文の答えの違い、tables は文の後の表の中身の違いが、この欠陥のものかを決める。当たったら、その置き場所の比較を打ち切る
 * (表の中身が分かれる)。keepGoing の欠陥は、答えだけが違って表の中身は同じなので、比べ続ける (表の中身は、続く比較が確かめる)。
 */
export interface Known {
  id: string;
  repro: string;
  answer?(step: Step, ours: Outcome, sqlite: Outcome, steps: Step[]): boolean;
  tables?(step: Step, ours: Outcome, sqlite: Outcome, steps: Step[]): boolean;
  keepGoing?: boolean;
  /**
   * 既定の実行では、この手順を流さない (avoided)。欠陥が、文の答えや表の中身ではなく、どの試験にも掛かる検査 (test/setup.ts の
   * 行イメージの検査など) に出るので、伏せられないものに使う。OPEN=1 では流す。
   */
  skip?(step: Step): boolean;
}

/** UNIQUE の誤りの表の名前。UNIQUE の誤りでなければ null。 */
const uniqueTable = (o: Outcome) => (o.kind === "error" ? /^UNIQUE constraint failed(?: \(unique: UNIQUE constraint failed)?: (?:index '\w+'|(\w+)\.)/.exec(o.message)?.[1] ?? null : null);
/** 2 行以上を書き得る文 (複数行の VALUES、INSERT ... SELECT、2 行を名指しする UPDATE)。 */
const multiRow = (step: Step) => /\), \(|\bSELECT\b|\bIN \(/.test(step.sql);

export const KNOWN_OPEN: Known[] = [
  {
    // 1 つの文の中で、UNIQUE に当たる行や制約が 2 つ以上あると、SQLite と違うものを誤りの文言に書く。SQLite は行ごとに、後で作った
    // index から確かめる (`u INTEGER UNIQUE, ..., UNIQUE (email)` なら email が先)。D∞ は、主キーを全部の行で先に確かめ、シャードを
    // またぐ UNIQUE は表定義の順に確かめる。文はどちらも失敗し、表の中身は同じである。
    id: "the UNIQUE error names another conflict",
    repro: "test/open/unique-error-first-conflict.test.ts",
    answer: (_step, ours, sqlite) => uniqueTable(ours) !== null && uniqueTable(ours) === uniqueTable(sqlite),
    keepGoing: true,
  },
  {
    // 複数行の OR REPLACE を基準経路で実行すると、文の後の行に消される行が消した行が、消えずに残る。シャードをまたぐ UNIQUE の表 (g) は
    // いつも基準経路で、シャードの中の UNIQUE の表 (p など) は、基準経路だけの実行 (REFERENCE=scans、full) で当たる (reference-full の seed 300)。
    id: "OR REPLACE that displaces a row it inserted",
    repro: "test/open/global-unique-replace-chain.test.ts",
    tables: (step, ours, sqlite) => /\bOR REPLACE\b/.test(step.sql) && multiRow(step) && ours.kind === "ok" && sqlite.kind === "ok",
  },
  {
    // ある行が UNIQUE の値を、OR REPLACE で消す行から受け取る変更の集まりを、UNIQUE の誤りで断る。シャードの中の UNIQUE の表 (p、cn、cr)
    // の文 (sim の seed 152、378) と、取引の COMMIT (`UNIQUE constraint failed (unique: ...)`、sim の seed 533) に出る。変更を 1 行ずつ
    // 物理の UNIQUE index に当てると、一時的な重複ができる (見立て)。2026-11-15 に表 p だけから広げた (seed 378 は cn の NOCASE の UNIQUE)。
    id: "a row that takes the UNIQUE value of a row OR REPLACE deletes is refused",
    repro: "test/open/local-unique-replace-trial.test.ts",
    answer: (step, ours, sqlite, steps) => sqlite.kind === "ok" && uniqueTable(ours) !== null &&
      [step, ...inBlock(steps, step)].some((x) => /\bOR REPLACE\b/.test(x.sql)) &&
      ((ours.kind === "error" && /^UNIQUE constraint failed \(unique: /.test(ours.message)) || ["p", "cn", "cr"].includes(step.table ?? "")),
  },
];

/** 取引の中の手順なら、その取引の BEGIN からこの手順の前までの手順。 */
function inBlock(steps: Step[], step: Step): Step[] {
  let k = step.i - 1;
  while (k >= 0 && steps[k]!.sql !== "BEGIN") k--;
  return k < 0 ? [] : steps.slice(k + 1, step.i);
}

export interface Trace {
  placement: Placement;
  /** 文ごとの答え。断った文は refused。 */
  outcomes: (Outcome | undefined)[];
  /** 文ごとの SQLite の答え。 */
  wants: (Outcome | undefined)[];
  problems: string[];
  refused: Record<string, number>;
  /** 流した文の形 (shape) ごとの数。 */
  shapes: Record<string, number>;
  /** 伏せた既知の欠陥ごとの数。 */
  masked: Record<string, number>;
}

const STALL_MS = 600_000;
const STALL_STEPS = 5_000_000;

export async function runPlacement(s: Script, p: Placement, o: { mask: boolean; debug?: (line: string) => void }): Promise<Trace> {
  const c = new SimCluster({ shards: p.cuts ? 1 : p.shards, seed: s.seed });
  const trace: Trace = { placement: p, outcomes: [], wants: [], problems: [], refused: {}, shapes: {}, masked: {} };
  const mask = (k: Known) => void (trace.masked[k.id] = (trace.masked[k.id] ?? 0) + 1);
  const work = (async () => {
    const ref = new Reference();
    const admin = new Db(c);
    /** 表が断られた形。その表の文は流さない。 */
    const missing = new Set<string>();
    for (const f of s.families) {
      for (const [k, sql] of f.ddl.entries()) {
        const ours = await admin.ddl(sql).then((): Outcome => ({ kind: "ok", changes: 0, rows: null }), (e: Error): Outcome => (/^unsupported:|^near "[^"]*": syntax error$/.test(e.message) ? { kind: "refused", message: e.message } : { kind: "error", message: e.message }));
        if (ours.kind === "refused") {
          const known = REFUSED.find((x) => x.sql.test(sql) && x.message.test(ours.message));
          if (known) trace.refused[known.id] = (trace.refused[known.id] ?? 0) + 1;
          else trace.problems.push(`${p.name}: ${sql}\n  refused: ${ours.message}`);
          // 断った CREATE TABLE の表は作られない (同じ場面の 2 つ目の表でも)。その表の文は流さない。
          const created = /^CREATE TABLE (\w+)/.exec(sql);
          if (created) missing.add(created[1]!);
          continue;
        }
        const want = forSql(sql, ref.run(sql));
        if (!sameOutcome(want, ours)) trace.problems.push(`${p.name}: ${sql}\n  sqlite: ${shownOutcome(want)}\n  ours:   ${shownOutcome(ours)}`);
      }
    }
    const cuts = prng(s.seed * 977 + 3);
    for (let j = 1; j <= (p.cuts ?? 0); j++) await splitAt(c, cuts, `s${j}`);
    // 行は、表定義を作った Db (分割の前の範囲表を覚えている) で入れる。古い範囲表で計画した複数行の INSERT は、断られて、新しい
    // 範囲表で計画し直される (未解決の問題 35。Epoch の段 2 で直した。test/multi-row-insert-after-split.test.ts)。
    const db = admin;
    for (const f of s.families) {
      for (const sql of f.rows) {
        if (missing.has(/^INSERT INTO (\w+)/.exec(sql)![1]!)) continue;
        const [want, ours] = [ref.run(sql), await dinf(db, sql)];
        if (!sameOutcome(want, ours)) trace.problems.push(`${p.name}: ${sql}\n  sqlite: ${shownOutcome(want)}\n  ours:   ${shownOutcome(ours)}`);
      }
    }
    const dumps = s.families.flatMap((f) => f.dumps).filter((d) => !missing.has(/ FROM (\w+) /.exec(d)![1]!));
    /** 表の中身を比べる。違えば、違いの説明を返す。 */
    const tablesDiffer = async (want: string[][][]): Promise<string | null> => {
      for (const [k, d] of dumps.entries()) {
        const got = await dinfDump(db, d);
        if (JSON.stringify(got) !== JSON.stringify(want[k])) return `  ${d}\n  sqlite: ${JSON.stringify(want[k]).slice(0, 1500)}\n  ours:   ${JSON.stringify(got).slice(0, 1500)}`;
      }
      return null;
    };
    for (const step of s.steps) {
      if (step.table && missing.has(step.table)) continue;
      const avoided = o.mask ? KNOWN_OPEN.find((k) => k.skip?.(step)) : undefined;
      if (avoided) {
        mask(avoided);
        continue;
      }
      trace.shapes[step.shape] = (trace.shapes[step.shape] ?? 0) + 1;
      const ours = forSql(step.sql, await dinf(db, step.sql));
      trace.outcomes[step.i] = ours;
      if (ours.kind === "refused") {
        trace.problems.push(`${p.name}: step ${step.i} ${step.sql}\n  refused: ${ours.message}`);
        return;
      }
      if (step.order) {
        const options = ref.both(step.sql, dumps).map((x) => ({ ...x, outcome: forSql(step.sql, x.outcome) }));
        const got = await Promise.all(dumps.map((d) => dinfDump(db, d)));
        const hit = options.find((x) => sameOutcome(x.outcome, ours) && JSON.stringify(x.dump) === JSON.stringify(got));
        if (!hit) {
          const known = o.mask ? KNOWN_OPEN.find((k) => options.some((x) => k.answer?.(step, ours, x.outcome, s.steps) || (sameOutcome(x.outcome, ours) && k.tables?.(step, ours, x.outcome, s.steps)))) : undefined;
          if (known) return mask(known);
          trace.problems.push(`${p.name}: step ${step.i} (${step.shape}, either order) ${step.sql}\n  sqlite: ${options.map((x) => `${shownOutcome(x.outcome)} ${JSON.stringify(x.dump).slice(0, 600)}`).join("\n       or ")}\n  ours:   ${shownOutcome(ours)} ${JSON.stringify(got).slice(0, 600)}`);
          return;
        }
        o.debug?.(`${step.i} ${step.sql} => ${shownOutcome(ours)} (${hit.reverse ? "reverse" : "forward"} order)`);
        ref.choose(step.sql, hit);
        continue;
      }
      const want = forSql(step.sql, ref.run(step.sql));
      trace.wants[step.i] = want;
      o.debug?.(`${step.i} ${step.sql} => sqlite ${shownOutcome(want)}, ours ${shownOutcome(ours)}`);
      if (!sameOutcome(want, ours)) {
        const known = o.mask ? KNOWN_OPEN.find((k) => k.answer?.(step, ours, want, s.steps)) : undefined;
        if (!known) {
          trace.problems.push(`${p.name}: step ${step.i} (${step.shape}) ${step.sql}\n  sqlite: ${shownOutcome(want)}\n  ours:   ${shownOutcome(ours)}`);
          return;
        }
        mask(known);
        if (!known.keepGoing) return;
      }
      // 書き込みの後と取引の終わりに、表の中身を比べる。誤りで終わった書き込みも比べる (誤りの前の行の変更が残っていないかを見る)。
      const ends = step.sql === "COMMIT" || step.sql === "ROLLBACK";
      if ((!step.inTxn && writes(step.sql)) || ends) {
        const differ = await tablesDiffer(dumps.map((d) => referenceDump(ref.db, d)));
        if (differ) {
          // 取引の終わりで違ったら、取引の中の手順のどれかが、欠陥の形に当たったかを見る。
          const suspects = ends ? [step, ...inBlock(s.steps, step)] : [step];
          const known = o.mask ? KNOWN_OPEN.find((k) => suspects.some((x) => trace.outcomes[x.i] && trace.wants[x.i] && k.tables?.(x, trace.outcomes[x.i]!, trace.wants[x.i]!, s.steps))) : undefined;
          if (known) return mask(known);
          trace.problems.push(`${p.name}: the tables differ after step ${step.i} (${step.shape}) ${step.sql}\n${differ}`);
          return;
        }
      }
    }
    const differ = await tablesDiffer(dumps.map((d) => referenceDump(ref.db, d)));
    if (differ) trace.problems.push(`${p.name}: the tables differ at the end of the script\n${differ}`);
    await c.settle();
    trace.problems.push(...(await quiescentProblems(c)).map((q) => `${p.name}: ${q}`));
  })();
  await Promise.race([work, c.stalled(STALL_MS, STALL_STEPS)]);
  return trace;
}

export interface SeedResult {
  divergences: string[];
  refused: Record<string, number>;
  shapes: Record<string, number>;
  masked: Record<string, number>;
}

/** 1 つの seed の台本を、全部の置き場所で流して比べる。 */
export async function checkSeed(seed: number, o: { mask: boolean; length?: number }): Promise<SeedResult> {
  const s = makeScript(seed, o.length);
  const traces: Trace[] = [];
  for (const p of PLACEMENTS) traces.push(await runPlacement(s, p, o));
  const out: SeedResult = { divergences: [], refused: {}, shapes: {}, masked: {} };
  for (const t of traces) {
    out.divergences.push(...t.problems);
    for (const [k, n] of Object.entries(t.masked)) out.masked[k] = (out.masked[k] ?? 0) + n;
  }
  // 断った形と、流した文の形は、どの置き場所でも同じである (断るかどうかは、文の形と表定義だけで決まる)。
  const first = traces[0]!;
  for (const t of traces.slice(1)) {
    if (JSON.stringify(t.refused) !== JSON.stringify(first.refused)) out.divergences.push(`refusals differ: ${first.placement.name} ${JSON.stringify(first.refused)}, ${t.placement.name} ${JSON.stringify(t.refused)}`);
  }
  for (const [id, n] of Object.entries(first.refused)) out.refused[id] = n;
  for (const t of traces) for (const [k, n] of Object.entries(t.shapes)) out.shapes[k] = Math.max(out.shapes[k] ?? 0, n);
  return out;
}
