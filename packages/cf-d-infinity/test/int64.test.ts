// 64 ビットの整数を、どの経路でも SQLite と同じに扱う。docs/design-values.md の「足す検査」の 1。
//
// SQLite の INTEGER は 64 ビットである。段 2 までの D∞ は、2^53 を超える整数の保存を `unsupported:` で断り (計画書の K1)、Hrana の
// 引数で渡されたものも断り、SQL の中で計算しただけの値は丸めて `float` で返した。値の作り直しの段 3 で、値の JS の型が格納の型に
// なり (bigint は INTEGER)、シャードの結果を型つきで読むようになって、どれも SQLite と同じ答えになった。段 0 に test/open/ に置き、
// 段 3 で test/ へ移した。
//
// 場面ごとに、新しいクラスタと新しい基準の SQLite を使う。文を 1 つずつ両方で実行し、最初に食い違ったところで止めて、
// 食い違い方を分類する。1 つ断られた後は 2 つの状態が分かれるので、その後の食い違いには意味がないからである。
// シャードは 1、2、4。実行は 3 通り (普通と、基準経路だけの 2 通り。vitest.config.ts の一覧に頼らず、Db の指定で切り替える)。
// 基準は node:sqlite を BigInt で読み、結果の INTEGER (BigInt) と REAL (数) を区別して比べる。
//
// 同じ場面を、±(2^53 - 1) に収まる値でも流す。場面の台本そのものが SQLite と合っていることを示す (段 2 までは、64 ビットの値での
// 失敗が、値の大きさだけから来ていることを示していた)。
import type { Client } from "@libsql/client";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
// @ts-expect-error 型定義のない JS のモジュール
import { importBatches, insertLines, parseInsert } from "../bin/dump.js";
import { split } from "../src/autoscaler";
import { D1Compatible } from "../src/client/d1";
import { imageFaults } from "../src/shard/rows";
import { Db } from "../src/client/db";
import type { Reference } from "../src/sql/plan";
import { exportPage, importRows, type ExportCursor } from "../src/transfer";
import { clientOf } from "./libsql";
import { SimCluster } from "./sim";

type Arg = null | bigint | number | string;

/** 場面が使う値。wide は 64 ビットの端と 2^53 の前後、safe は同じ並びを ±(2^53 - 1) に収めたもの。 */
interface Values {
  MAX: bigint;
  MIN: bigint;
  /** JS の安全な整数のすぐ外 (wide)。 */
  ABOVE: bigint;
  EDGE: bigint;
  BELOW: bigint;
  /** Snowflake の形の ID。 */
  SNOW: bigint;
  /** `1 << SHIFT` と `id * FACTOR` で、SQL の中で大きな値を作る。 */
  SHIFT: number;
  FACTOR: bigint;
  /** REAL でも正確に表せる整数の値 (型のない主キーで、INTEGER と REAL が同じキーになることを見る)。 */
  POWER: number;
}
const WIDE: Values = {
  MAX: 2n ** 63n - 1n, MIN: -(2n ** 63n), ABOVE: 2n ** 53n + 1n, EDGE: 2n ** 53n, BELOW: -(2n ** 53n) - 1n,
  SNOW: 1541815603606036480n, SHIFT: 62, FACTOR: 1000000000000000000n, POWER: 60,
};
const SAFE: Values = {
  MAX: 2n ** 53n - 1n, MIN: -(2n ** 53n) + 1n, ABOVE: 2n ** 52n + 1n, EDGE: 2n ** 52n, BELOW: -(2n ** 52n) - 1n,
  SNOW: 1541815603606036n, SHIFT: 51, FACTOR: 1000000000000n, POWER: 50,
};

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
/** 値を、型ごと文字にする。INTEGER は i、REAL は r、TEXT は t、BLOB は b。 */
const cell = (x: unknown): string | null =>
  x === null || x === undefined ? null
    : typeof x === "bigint" ? `i${x}`
      : typeof x === "number" ? `r${x}`
        : typeof x === "string" ? `t${x}`
          : `b${hex(x instanceof ArrayBuffer ? new Uint8Array(x) : (x as Uint8Array))}`;
type Outcome = { rows: (string | null)[][] } | { ok: true } | { error: string };
const failure = (e: unknown): Outcome => {
  // @libsql/client は、誤りの文面の前に符号を付ける (`SQLITE_ERROR: `、`SQLITE_BUSY: SQLITE_BUSY: `)。外して比べる。
  const m = (e instanceof Error ? e.message : String(e)).replace(/^(SQLITE_[A-Z_]+: )+/, "");
  return { error: /UNIQUE constraint failed/.test(m) ? "UNIQUE constraint failed" : m };
};

/** 食い違い方。 */
type Kind =
  /** `unsupported:` で断った。いまの決まりである (K1 と、Hrana の入口)。 */
  | "refused"
  /** 断らずに答えたが、SQLite が返した 2^53 を超える INTEGER が、丸めた数になっている。食い違いはそれだけである。 */
  | "rounded"
  /** D1 互換の API が、引数の BigInt を受け取れない。 */
  | "bigint argument"
  /** それ以外。いまの決まりでは説明できないので、欠陥である。 */
  | "other";
class Divergence extends Error {
  constructor(readonly kind: Kind, readonly step: string, readonly ours: Outcome, readonly sqlite: Outcome) {
    super(`${kind}: ${step}`);
  }
}

const REFUSAL = /^unsupported: (an INTEGER beyond|the integer -?\d+ cannot be stored exactly)/;
function classify(via: "hrana" | "d1", args: Arg[], ours: Outcome, sqlite: Outcome): Kind {
  if ("error" in ours) {
    if (REFUSAL.test(ours.error)) return "refused";
    if (via === "d1" && args.some((a) => typeof a === "bigint")) return "bigint argument";
    return "other";
  }
  if (!("rows" in ours) || !("rows" in sqlite) || ours.rows.length !== sqlite.rows.length) return "other";
  // 丸めだけの違いか。SQLite の `i<数字>` が 2^53 を超えていて、こちらがその丸めた数 (INTEGER でも REAL でも) である。
  const rounded = (want: string | null, got: string | null) => {
    if (want === got) return true;
    if (want === null || got === null || want[0] !== "i" || !/^[ir]/.test(got)) return false;
    const big = BigInt(want.slice(1));
    return (big > 2n ** 53n || big < -(2n ** 53n)) && Number(got.slice(1)) === Number(big);
  };
  return ours.rows.every((row, i) => row.length === sqlite.rows[i]!.length && row.every((v, j) => rounded(sqlite.rows[i]![j]!, v))) ? "rounded" : "other";
}

/** 1 つの場面の実行。D∞ と SQLite に同じ文を流して比べる。 */
class Run {
  readonly lite = new DatabaseSync(":memory:");
  readonly c: SimCluster;
  readonly client: Client;
  readonly d1: D1Compatible;
  constructor(readonly v: Values, readonly shards: number, readonly reference: Reference | undefined) {
    this.c = new SimCluster({ shards });
    this.client = clientOf(this.c, { intMode: "bigint", reference });
    this.d1 = new D1Compatible(new Db(this.c, { reference }));
  }
  private onLite(sql: string, args: Arg[]): Outcome {
    try {
      const st = this.lite.prepare(sql);
      st.setReadBigInts(true);
      st.setReturnArrays(true);
      if (st.columns().length === 0) return (st.run(...args), { ok: true });
      return { rows: (st.all(...args) as unknown as unknown[][]).map((r) => r.map(cell)) };
    } catch (e) {
      return failure(e);
    }
  }
  private compare(via: "hrana" | "d1", sql: string, args: Arg[], ours: Outcome, sqlite: Outcome): void {
    if (JSON.stringify(ours) === JSON.stringify(sqlite)) return;
    const shown = args.length ? ` ${JSON.stringify(args.map(cell))}` : "";
    throw new Divergence(classify(via, args, ours, sqlite), `${via}: ${sql}${shown}`, ours, sqlite);
  }
  /** Hrana で 1 文。引数の BigInt は `integer`、数は `float` で届く。結果は型ごと比べる。 */
  async h(sql: string, args: Arg[] = []): Promise<void> {
    const sqlite = this.onLite(sql, args);
    const ours = await this.client.execute({ sql, args }).then(
      (r): Outcome => (r.columns.length ? { rows: r.rows.map((row) => r.columns.map((_c, i) => cell(row[i]))) } : { ok: true }), failure);
    this.compare("hrana", sql, args, ours, sqlite);
  }
  /** D1 互換の API で、結果を返さない 1 文。引数の BigInt は INTEGER である。書いた値は、後の Hrana の読みで確かめる。 */
  async d(sql: string, args: Arg[] = []): Promise<void> {
    const sqlite = this.onLite(sql, args);
    const ours = await this.d1.prepare(sql).bind(...args).run().then((): Outcome => ({ ok: true }), failure);
    this.compare("d1", sql, args, ours, sqlite);
  }
  /** 対話の取引で、文を順に流す。取引の中の読みは、同じ取引の書き込みを見る。 */
  async tx(steps: [string, Arg[]?][]): Promise<void> {
    const t = await this.client.transaction("write");
    this.lite.exec("BEGIN");
    try {
      for (const [sql, args = []] of steps) {
        const sqlite = this.onLite(sql, args);
        const ours = await t.execute({ sql, args }).then(
          (r): Outcome => (r.columns.length ? { rows: r.rows.map((row) => r.columns.map((_c, i) => cell(row[i]))) } : { ok: true }), failure);
        this.compare("hrana", `in a transaction: ${sql}`, args, ours, sqlite);
      }
      this.lite.exec("COMMIT");
      const committed = await t.commit().then((): Outcome => ({ ok: true }), failure);
      this.compare("hrana", "COMMIT", [], committed, { ok: true });
    } catch (e) {
      if (this.lite.isTransaction) this.lite.exec("ROLLBACK");
      t.close();
      throw e;
    }
  }
}

const T = "CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT, n INTEGER)";
const T2 = "CREATE TABLE t2(id INTEGER PRIMARY KEY, v TEXT, n INTEGER)";
const READ = "SELECT id, v, n, typeof(id), typeof(n) FROM t ORDER BY id";
const READ2 = "SELECT id, v, n, typeof(v), typeof(n) FROM t2 ORDER BY id";
const ids = (v: Values) => [v.MAX, v.MIN, v.ABOVE, v.EDGE, v.BELOW, v.SNOW, v.SNOW + 1n, 5n];
/** ids の行を Hrana の引数で入れる。n には、並びを逆にした値を入れる。 */
async function fill(r: Run, table = "t"): Promise<void> {
  const list = ids(r.v);
  for (const [i, id] of list.entries()) await r.h(`INSERT INTO ${table}(id, v, n) VALUES (?, ?, ?)`, [id, `row ${i}`, list[list.length - 1 - i]!]);
}

const SCENARIOS: Record<string, (r: Run) => Promise<void>> = {
  "INSERT with Hrana integer arguments, read by key and by scan": async (r) => {
    await r.h(T);
    await fill(r);
    await r.h(READ);
    for (const id of ids(r.v)) await r.h("SELECT id, n FROM t WHERE id = ?", [id]);
    await r.h("SELECT count(*), min(id), max(id), min(n), max(n) FROM t");
  },
  "INSERT with literals in the statement": async (r) => {
    await r.h(T);
    const list = ids(r.v);
    for (const [i, id] of list.entries()) await r.h(`INSERT INTO t(id, v, n) VALUES (${id}, 'row ${i}', ${list[list.length - 1 - i]})`);
    await r.h(READ);
    for (const id of list) await r.h(`SELECT id, n FROM t WHERE id = ${id}`);
  },
  "INSERT with BigInt arguments through the D1-compatible API": async (r) => {
    await r.h(T);
    const list = ids(r.v);
    for (const [i, id] of list.entries()) await r.d("INSERT INTO t(id, v, n) VALUES (?, ?, ?)", [id, `row ${i}`, list[list.length - 1 - i]!]);
    await r.h(READ);
    await r.d("UPDATE t SET v = 'hit' WHERE id = ?", [r.v.MAX]);
    await r.d("DELETE FROM t WHERE id = ?", [r.v.MIN]);
    await r.h(READ);
  },
  "UPDATE of a primary key": async (r) => {
    await r.h(T);
    await r.h("INSERT INTO t(id, v, n) VALUES (7, 'a', 1), (8, 'b', 2)");
    await r.h(`UPDATE t SET id = id * ${r.v.FACTOR} WHERE id = 7`);
    await r.h("UPDATE t SET id = ? WHERE id = ?", [r.v.MAX, 8n]);
    await r.h(READ);
    await r.h("SELECT v FROM t WHERE id = ?", [r.v.MAX]);
    await r.h("SELECT v FROM t WHERE id = ?", [7n * r.v.FACTOR]);
  },
  "values computed in SQL and stored": async (r) => {
    await r.h(T);
    await r.h(`INSERT INTO t(id, v, n) VALUES (1 << ${r.v.SHIFT}, 'shift', (1 << ${r.v.SHIFT}) + 1)`);
    await r.h(`INSERT INTO t(id, v, n) VALUES (${r.v.MAX}, 'max', ${r.v.MIN + 1n} - 1)`);
    await r.h(`UPDATE t SET n = n + 1 WHERE id = 1 << ${r.v.SHIFT}`);
    await r.h(READ);
    await r.h(`SELECT id FROM t WHERE n = (1 << ${r.v.SHIFT}) + 2`);
  },
  "values computed in SQL and returned without being stored": async (r) => {
    await r.h(`SELECT 1 << ${r.v.SHIFT} AS a, ${r.v.EDGE} + 1 AS b, ${r.v.MIN + 1n} - 1 AS c, typeof(1 << ${r.v.SHIFT}) AS t`);
    await r.h(T);
    await r.h("INSERT INTO t(id, v, n) VALUES (1, 'a', 1)");
    // 表を読む文は、シャードが答える。
    await r.h(`SELECT id, (1 << ${r.v.SHIFT}) + n AS x FROM t WHERE id = 1`);
    await r.h(`SELECT id, (1 << ${r.v.SHIFT}) + n AS x FROM t ORDER BY id`);
  },
  "INSERT … SELECT": async (r) => {
    await r.h(T);
    await r.h(T2);
    await fill(r);
    await r.h("INSERT INTO t2 SELECT id, v, n FROM t WHERE id <> ?", [r.v.MAX]);
    await r.h("INSERT INTO t2(id, v, n) SELECT id, v || '-', n FROM t WHERE id = ?", [r.v.MAX]);
    // TEXT の列に入る整数は、10 進の文字列になる。
    await r.h(`INSERT INTO t2(id, v) SELECT 20, ${r.v.ABOVE}`);
    await r.h(READ2);
  },
  "a subquery inside VALUES": async (r) => {
    await r.h(T);
    await r.h(T2);
    await fill(r);
    await r.h("INSERT INTO t2(id, v, n) VALUES ((SELECT max(id) FROM t), 'sub', (SELECT n FROM t WHERE id = ?))", [r.v.ABOVE]);
    await r.h(`INSERT INTO t2(id, v) VALUES (21, (SELECT ${r.v.ABOVE} + 2))`);
    await r.h(READ2);
  },
  "RETURNING": async (r) => {
    await r.h(T);
    await r.h("INSERT INTO t(id, v, n) VALUES (?, 'a', ?) RETURNING id, n, typeof(n), n + 1", [r.v.MAX, r.v.MIN]);
    await r.h("INSERT INTO t(id, v, n) VALUES (?, 'b', ?) RETURNING *", [r.v.ABOVE, r.v.SNOW]);
    await r.h("UPDATE t SET n = n + 1 WHERE id = ? RETURNING id, n", [r.v.MAX]);
    await r.h("DELETE FROM t WHERE id = ? RETURNING *", [r.v.ABOVE]);
    await r.h(READ);
  },
  "upsert, OR REPLACE and OR IGNORE": async (r) => {
    await r.h(T);
    await r.h("INSERT INTO t(id, v, n) VALUES (?, 'first', ?)", [r.v.MAX, r.v.ABOVE]);
    await r.h("INSERT INTO t(id, v, n) VALUES (?, 'second', 0) ON CONFLICT(id) DO UPDATE SET v = excluded.v, n = t.n + 1", [r.v.MAX]);
    await r.h(READ);
    await r.h("INSERT OR REPLACE INTO t(id, v, n) VALUES (?, 'third', ?)", [r.v.MAX, r.v.MIN]);
    await r.h("INSERT OR IGNORE INTO t(id, v, n) VALUES (?, 'fourth', 1)", [r.v.MAX]);
    await r.h("INSERT OR IGNORE INTO t(id, v, n) VALUES (?, 'fifth', ?)", [r.v.MAX - 1n, r.v.MAX]);
    await r.h(READ);
  },
  "DEFAULT": async (r) => {
    await r.h(`CREATE TABLE d(id INTEGER PRIMARY KEY, w INTEGER DEFAULT ${r.v.MAX}, x DEFAULT (1 << ${r.v.SHIFT}), s TEXT DEFAULT '${r.v.ABOVE}', i INTEGER DEFAULT '${r.v.ABOVE}')`);
    await r.h("INSERT INTO d(id) VALUES (1)");
    await r.h(`ALTER TABLE d ADD COLUMN z INTEGER DEFAULT ${r.v.BELOW}`);
    await r.h("INSERT INTO d(id) VALUES (2)");
    await r.h("SELECT id, w, x, s, i, z, typeof(i), typeof(x) FROM d ORDER BY id");
  },
  "rows written inside a transaction, read inside it": async (r) => {
    await r.h(T);
    await r.tx([
      ["INSERT INTO t(id, v, n) VALUES (?, 'e', ?)", [r.v.MAX, r.v.SNOW]],
      ["UPDATE t SET n = ?, v = 'f' WHERE id = ?", [r.v.MIN, r.v.MAX]],
      ["SELECT id, v, n FROM t WHERE id = ?", [r.v.MAX]],
      [READ],
    ]);
    await r.h(READ);
  },
  "a transaction across shards": async (r) => {
    await r.h(T);
    const list = [...ids(r.v), 1n, 2n, 3n, 4n, 6n, 7n];
    await r.tx([
      ...list.map((id, i): [string, Arg[]] => ["INSERT INTO t(id, v, n) VALUES (?, ?, ?)", [id, `row ${i}`, list[list.length - 1 - i]!]]),
      ["UPDATE t SET n = ? WHERE id = ?", [r.v.ABOVE, 1n]],
      ["UPDATE t SET n = n + 1 WHERE id = ?", [r.v.SNOW]],
      ["DELETE FROM t WHERE id = ?", [r.v.EDGE]],
      [READ],
    ]);
    await r.h(READ);
    for (const id of list) await r.h("SELECT id, n FROM t WHERE id = ?", [id]);
  },
  "UNIQUE across shards": async (r) => {
    await r.h("CREATE TABLE q(id INTEGER PRIMARY KEY, code INTEGER UNIQUE, v TEXT)");
    for (const [i, code] of [r.v.MAX, r.v.MAX - 1n, r.v.ABOVE, r.v.EDGE].entries()) await r.h("INSERT INTO q(id, code, v) VALUES (?, ?, 'x')", [BigInt(i + 1), code]);
    // 隣の値は別の値である。丸めて同じキーにすると、ここで UNIQUE の違反になる。同じ値は違反になる。
    await r.h("INSERT INTO q(id, code, v) VALUES (5, ?, 'same')", [r.v.MAX]);
    await r.h("UPDATE q SET code = ? WHERE id = 4", [r.v.ABOVE]);
    await r.h("UPDATE q SET code = ? WHERE id = 4", [r.v.ABOVE + 1n]);
    for (const code of [r.v.MAX, r.v.ABOVE, r.v.EDGE, r.v.ABOVE + 1n]) await r.h("SELECT id FROM q WHERE code = ?", [code]);
    await r.h("SELECT id, code, typeof(code) FROM q ORDER BY id");
  },
  "arguments of conditions": async (r) => {
    await r.h(T);
    await fill(r);
    await r.h("SELECT id FROM t WHERE id IN (?, ?) ORDER BY id", [r.v.MAX, r.v.BELOW]);
    await r.h("SELECT id FROM t WHERE id > ? ORDER BY id", [r.v.EDGE]);
    await r.h("SELECT id FROM t WHERE id BETWEEN ? AND ? ORDER BY id", [r.v.BELOW, r.v.ABOVE]);
    await r.h("SELECT id FROM t WHERE n = ?", [r.v.MAX]);
    await r.h("UPDATE t SET v = 'hit' WHERE id = ?", [r.v.ABOVE]);
    await r.h("DELETE FROM t WHERE id = ?", [r.v.SNOW]);
    await r.h(READ);
    await r.h("CREATE TABLE c(a INTEGER NOT NULL, b INTEGER NOT NULL, v TEXT, PRIMARY KEY (a, b))");
    for (const [a, b] of [[r.v.MAX, r.v.MIN], [r.v.MAX, 1n], [r.v.ABOVE, r.v.EDGE], [r.v.EDGE, r.v.ABOVE]]) await r.h("INSERT INTO c(a, b, v) VALUES (?, ?, 'x')", [a!, b!]);
    await r.h("SELECT a, b FROM c WHERE a = ? AND b = ?", [r.v.MAX, r.v.MIN]);
    await r.h("SELECT a, b FROM c WHERE a = ? ORDER BY b", [r.v.MAX]);
    await r.h("SELECT a, b FROM c ORDER BY a, b");
  },
  "a key column without a type that holds INTEGER and REAL neighbours": async (r) => {
    const power = 2n ** BigInt(r.v.POWER);
    await r.h("CREATE TABLE u(k PRIMARY KEY, v TEXT)");
    await r.h("INSERT INTO u(k, v) VALUES (?, 'integer')", [power]);
    // REAL の同じ値は、同じキーである (SQLite は INTEGER と REAL を正確に比べる)。
    await r.h("INSERT INTO u(k, v) VALUES (?, 'real, the same value')", [Number(power)]);
    await r.h("INSERT INTO u(k, v) VALUES (?, 'integer + 1')", [power + 1n]);
    await r.h("INSERT INTO u(k, v) VALUES (?, 'real')", [Number(power) * 2]);
    await r.h("INSERT INTO u(k, v) VALUES (?, 'integer, the same value')", [power * 2n]);
    await r.h("INSERT INTO u(k, v) VALUES (?, 'integer + 1')", [power * 2n + 1n]);
    await r.h("SELECT typeof(k), CAST(k AS TEXT), v FROM u ORDER BY k");
    for (const k of [power, power + 1n, power * 2n, power * 2n + 1n, Number(power), Number(power) * 2]) await r.h("SELECT v FROM u WHERE k = ?", [k]);
  },
  "a read at an older read time": async (r) => {
    await r.h(T);
    await fill(r);
    // 読むだけの取引が最初の文で読む時刻を決め、その後に別の接続が行を書き換える。取引の後の読みは、変更ログの行イメージから
    // 古い行を作って返す。読みは、どれも主キーで 1 行を引く (普通の実行では、1 つのシャードが答える)。複数のシャードを読む文は、
    // いまは 2 つ以上のシャードで行が変わっていると競合で失敗する (test/open/snapshot-read-after-two-shards-changed.test.ts)。
    const reader = await r.client.transaction("deferred");
    try {
      const point = "SELECT id, v, n FROM t WHERE id = ?";
      const read = async (id: bigint) =>
        JSON.stringify(await reader.execute({ sql: point, args: [id] }).then((x): Outcome => ({ rows: x.rows.map((row) => x.columns.map((_c, i) => cell(row[i]))) }), failure));
      const watched = [r.v.MAX, r.v.ABOVE, r.v.MIN, r.v.MAX - 1n];
      const before: string[] = [];
      for (const id of watched) before.push(await read(id));
      // 取引の読みは、いまの SQLite の答えと同じである。
      for (const [i, id] of watched.entries()) {
        const st = r.lite.prepare(point);
        st.setReadBigInts(true);
        st.setReturnArrays(true);
        const sqlite: Outcome = { rows: (st.all(id) as unknown as unknown[][]).map((row) => row.map(cell)) };
        if (before[i] !== JSON.stringify(sqlite)) throw new Divergence(classify("hrana", [id], JSON.parse(before[i]!) as Outcome, sqlite), `in a read transaction: ${point} ${JSON.stringify([cell(id)])}`, JSON.parse(before[i]!) as Outcome, sqlite);
      }
      await r.h("UPDATE t SET n = n + 1, v = 'later' WHERE id = ?", [r.v.MAX]);
      await r.h("DELETE FROM t WHERE id = ?", [r.v.ABOVE]);
      await r.h("UPDATE t SET n = ? WHERE id = ?", [r.v.ABOVE, r.v.MIN]);
      await r.h("INSERT INTO t(id, v, n) VALUES (?, 'new', ?)", [r.v.MAX - 1n, r.v.MIN]);
      for (const [i, id] of watched.entries()) {
        const again = await read(id);
        // 基準経路だけの実行は、主キーの読みでも全シャードから行を集める。2 つ以上のシャードで行が変わっているので、いまは
        // 競合で失敗する (上の未解決の欠陥)。競合は取引の正しい結末の 1 つなので、ここでは認める。答えたなら、古い行でなければならない。
        // 環境変数 REFERENCE で流すと、「普通」の実行もクラスタの指定で基準経路になる (SimCluster.reference)。
        if ((r.reference !== undefined || r.c.reference !== undefined) && /"error":"read too old/.test(again)) break;
        expect(again, `the transaction reads id ${id} as it was at its read time`).toBe(before[i]);
      }
    } finally {
      reader.close();
    }
    await r.h(READ);
  },
  "rows moved by a shard split": async (r) => {
    await r.h(T);
    await fill(r);
    for (let i = 10; i < 40; i++) await r.h("INSERT INTO t(id, v, n) VALUES (?, 'filler', ?)", [BigInt(i), r.v.MAX - BigInt(i)]);
    const moved = await split(r.c, "s0", `s${r.shards}`);
    expect(moved!.groups, "the split moves rows").toBeGreaterThan(0);
    await r.h(READ);
    for (const id of ids(r.v)) await r.h("SELECT id, n FROM t WHERE id = ?", [id]);
    await r.h("UPDATE t SET n = n - 1 WHERE id = ?", [r.v.MIN]);
    await r.h(READ);
  },
  "export, then import into another cluster": async (r) => {
    await r.h(T);
    await fill(r);
    // 書き出しの文面 (bin/dump.js) を取り込み、別の数のシャードのクラスタへ入れる。
    const lines: string[] = [];
    try {
      for (let cursor: ExportCursor | null = null, pages = 0; ; ) {
        const page = await exportPage(r.c, "t", cursor, 3);
        if (page.rows.length) lines.push(...(insertLines("t", page.columns, page.rows) as string[]));
        cursor = page.cursor;
        if (cursor === null) break;
        if (++pages > 100) throw new Error("export does not finish");
      }
    } catch (e) {
      const ours = failure(e);
      if (e instanceof Divergence || !("error" in ours) || !REFUSAL.test(ours.error)) throw e;
      throw new Divergence("refused", "export of table t", ours, { ok: true });
    }
    const other = new Run(r.v, r.shards + 1, r.reference);
    await other.h(T);
    for (const line of lines) {
      const insert = parseInsert(line) as { table: string; columns: string[]; rows: unknown[][] } | null;
      if (!insert) throw new Error(`not an exported INSERT: ${line.slice(0, 80)}`);
      for (const batch of importBatches(insert.rows) as unknown[][][]) await importRows(new Db(other.c, { reference: r.reference }), insert.table, insert.columns, batch);
    }
    // 取り込んだ先を、元の表を持つ基準の SQLite と比べる。
    const want = JSON.stringify((() => {
      const st = r.lite.prepare(READ);
      st.setReadBigInts(true);
      st.setReturnArrays(true);
      return { rows: (st.all() as unknown as unknown[][]).map((row) => row.map(cell)) };
    })());
    const got = await other.client.execute(READ).then((x): Outcome => ({ rows: x.rows.map((row) => x.columns.map((_c, i) => cell(row[i]))) }), failure);
    if (JSON.stringify(got) !== want) throw new Divergence(classify("hrana", [], got, JSON.parse(want) as Outcome), `after the import: ${READ}`, got, JSON.parse(want) as Outcome);
  },
};

const MODES: (Reference | undefined)[] = [undefined, "scans", "full"];
const SHARDS = [1, 2, 4];

interface Found { scenario: string; shards: number; mode: string; kind: Kind; step: string; ours: string; sqlite: string }

/** 全部の場面を、シャードの数と実行の仕方ごとに流し、最初の食い違いを集める。食い違い以外の失敗は、そのまま投げる。 */
async function runAll(v: Values): Promise<Found[]> {
  const found: Found[] = [];
  for (const [scenario, body] of Object.entries(SCENARIOS)) {
    for (const shards of SHARDS) {
      for (const reference of MODES) {
        try {
          await body(new Run(v, shards, reference));
        } catch (e) {
          if (!(e instanceof Divergence)) throw new Error(`${scenario} [${shards} shards, ${reference ?? "normal"}]: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
          found.push({ scenario, shards, mode: reference ?? "normal", kind: e.kind, step: e.step, ours: JSON.stringify(e.ours).slice(0, 300), sqlite: JSON.stringify(e.sqlite).slice(0, 300) });
        }
      }
    }
  }
  return found;
}
const show = (f: Found) => `${f.scenario} [${f.shards} shards, ${f.mode}] ${f.step}\n    ours:   ${f.ours}\n    sqlite: ${f.sqlite}`;

describe("the scenarios, with integers within ±(2^53 - 1)", () => {
  it("answer as SQLite does on 1, 2 and 4 shards, on the normal path and on both reference paths", async () => {
    const found = await runAll(SAFE);
    // D1 互換の API は、段 2 まで BigInt の引数を受け取れなかった (内部の誤り「Do not know how to serialize a BigInt」)。段 3 で
    // BigInt を INTEGER として受け取るようになった (src/client/d1.ts の toValue)。
    expect(found.map(show)).toEqual([]);
  }, 300_000);
});

describe("64-bit integers", () => {
  let memo: Promise<Found[]> | undefined;
  const all = () => (memo ??= runAll(WIDE));

  // 段 2 までの決まりで説明できた食い違いは、3 種類だった。断る (`unsupported:`)、保存していない値を丸めて返す、D1 互換の API が
  // BigInt を受け取れない。段 3 からは、どれも起きない (3 つ目の試験)。それ以外の食い違いは、いつでも欠陥である。
  it("never answer differently from SQLite in a way that today's documented limits do not explain", async () => {
    expect((await all()).filter((f) => f.kind === "other").map(show)).toEqual([]);
  }, 300_000);

  it("are treated the same way on 1, 2 and 4 shards and on every path", async () => {
    // 食い違うかどうかと、その種類と文が、置き場所と経路で変わらない (AGENTS.md の規則 4)。
    const found = await all();
    const byScenario: Record<string, Set<string>> = {};
    for (const scenario of Object.keys(SCENARIOS)) {
      byScenario[scenario] = new Set(SHARDS.flatMap((shards) => MODES.map((m) => {
        const f = found.find((x) => x.scenario === scenario && x.shards === shards && x.mode === (m ?? "normal"));
        return f ? `${f.kind}: ${f.step}` : "same as SQLite";
      })));
    }
    expect(Object.fromEntries(Object.entries(byScenario).filter(([, kinds]) => kinds.size > 1).map(([k, kinds]) => [k, [...kinds]]))).toEqual({});
  }, 300_000);

  it("are stored and returned exactly: no statement is refused and no value is rounded", async () => {
    const found = (await all()).filter((f) => f.kind !== "other" && f.shards === 1 && f.mode === "normal");
    expect(found.map((f) => `${f.kind} | ${f.scenario} | ${f.step} | ${f.ours}`)).toEqual([]);
  }, 300_000);
});

// 欠陥を戻して、この試験が気付くことを確かめる。行イメージのタプルの INTEGER を JS の数で値に戻すと (src/shard/rows.ts の
// imageFaults.roundedImages)、確定した取引の適用と、分割で運んだ行で、2^53 を超える整数が丸まる。どちらも、文の答えは
// シャードの本体から読むので、丸まった値が後の読みに現れる。値は主キーでない列に置く (主キーが丸まると、行が重なって適用が止まる)。
describe("a check that row images keep 64-bit integers", () => {
  const scenes: Record<string, (r: Run) => Promise<void>> = {
    "a transaction across shards": async (r) => {
      await r.h(T);
      await r.tx([1n, 2n, 3n, 4n].map((id): [string, Arg[]] => ["INSERT INTO t(id, v, n) VALUES (?, 'x', ?)", [id, r.v.ABOVE + id]]));
      await r.h(READ);
    },
    "rows moved by a shard split": async (r) => {
      await r.h(T);
      for (let i = 1n; i <= 30n; i++) await r.h("INSERT INTO t(id, v, n) VALUES (?, 'x', ?)", [i, r.v.MAX - i]);
      await split(r.c, "s0", `s${r.shards}`);
      await r.h(READ);
    },
  };
  for (const [name, scene] of Object.entries(scenes)) {
    it(`finds the rounding in ${name} (roundedImages), and passes the same scene without it`, async () => {
      await scene(new Run(WIDE, 2, undefined));
      imageFaults.roundedImages = true;
      try {
        // 丸まった値は、隣の整数か (rounded)、64 ビットの外へ丸まって REAL として入る (other。typeof が real になる)。どちらでも、
        // 上の試験が落ちる。
        const kind = await scene(new Run(WIDE, 2, undefined)).then(() => "same as SQLite", (e: unknown) => (e instanceof Divergence ? e.kind : `failed: ${(e as Error).message}`));
        expect(["rounded", "other"]).toContain(kind);
      } finally {
        imageFaults.roundedImages = false;
      }
    }, 120_000);
  }
});
