// シャードの資源の上限が、行の置き場所で文の成否を変えない (計画書の不変条件 13、2026-11-13 の README の確認の指摘 1 と 2)。
//
// DO の SQLite には、文の長さ (100 KB)、束縛の変数 (100 個)、複合 SELECT の項 (5 つ) の上限がある (test/sim.ts が模す)。
// Worker は文をシャードへ送る前に行をシャードごとに分けるので、同じ文でも、シャードが 1 つなら 1 つの長い文、2 つなら短い文 2 つ
// になる。上限に当たった文を断れば、成否が置き場所で決まる。集める結果の大きさの予算も同じで、予算をシャードの数で等分すると、
// 同じ行が 1 つのシャードに偏っているときだけ失敗する。ここでは、上限の前後の大きさの文と置き場所を seed から作り、
// シャードの数と置き場所を変えても、SQLite と同じ答えか、同じ上限の誤りになることを確かめる。
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { Db } from "../src/client/db";
import type { Value } from "../src/types";
import { prng, seedsOr, SimCluster } from "./sim";

interface Step { sql: string; params: Value[] }

const show = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? Number(x) : x));

function sqlite(lite: DatabaseSync, s: Step): string {
  try {
    const st = lite.prepare(s.sql);
    st.setReadBigInts(true);
    const p = s.params.map((x) => (typeof x === "number" && Number.isInteger(x) ? BigInt(x) : x)) as never[];
    return st.columns().length ? show(st.all(...p).map((r) => Object.values(r))) : (st.run(...p), "ok");
  } catch (e) {
    return `error ${(e as Error).message}`;
  }
}

async function ours(db: Db, s: Step): Promise<string> {
  return db.query(s.sql, s.params).then((r) => (r.columns.length ? show(r.values) : "ok"), (e: Error) => `error ${e.message}`);
}

/** 上限の前後の大きさの文。行数、行の大きさ、変数の数を seed で変える。 */
function script(seed: number): Step[] {
  const r = prng(seed);
  const n = (m: number) => Math.floor(r() * m);
  const rows = 60 + n(140);
  const size = 400 + n(1200);
  const body = (i: number) => `${String(i).padStart(6, "0")}${"x".repeat(size)}`;
  const steps: Step[] = [];
  // 1. 文字の値を並べた INSERT。全部で 100 KB を超えることが多い。
  steps.push({ sql: `INSERT INTO t(id, g, body) VALUES ${Array.from({ length: rows }, (_v, i) => `(${i + 1}, ${i % 7}, '${body(i + 1)}')`).join(", ")}`, params: [] });
  // 2. 変数の多い読み、書き換え、消去。
  const k = 80 + n(200);
  const ids = Array.from({ length: k }, (_v, i) => 1 + ((i * 7) % rows));
  steps.push({ sql: `SELECT id FROM t WHERE id IN (${ids.map(() => "?").join(", ")}) ORDER BY id`, params: ids });
  steps.push({ sql: `SELECT count(*) FROM t WHERE body IN (${ids.map(() => "?").join(", ")})`, params: ids.map(body) });
  steps.push({ sql: `UPDATE t SET g = g + 1 WHERE id IN (${ids.map(() => "?").join(", ")})`, params: ids });
  steps.push({ sql: "SELECT g, count(*) FROM t GROUP BY g ORDER BY g", params: [] });
  // 3. 長い文字の literal を含む読み。
  steps.push({ sql: `SELECT count(*) FROM t WHERE body <> '${"y".repeat(60_000 + n(60_000))}'`, params: [] });
  // 4. 項の多い複合 SELECT。
  const terms = 3 + n(6);
  steps.push({ sql: `${Array.from({ length: terms }, (_v, i) => `SELECT id FROM t WHERE id = ${i + 1}`).join(" UNION ALL ")} ORDER BY 1`, params: [] });
  // 5. 変数の多い INSERT (行ごとに 3 つ)。
  const more = 30 + n(60);
  steps.push({
    sql: `INSERT INTO t(id, g, body) VALUES ${Array.from({ length: more }, () => "(?, ?, ?)").join(", ")}`,
    params: Array.from({ length: more }, (_v, i) => [1000 + i, i % 3, body(1000 + i)]).flat(),
  });
  steps.push({ sql: `DELETE FROM t WHERE id IN (${ids.map(() => "?").join(", ")})`, params: ids });
  steps.push({ sql: "SELECT count(*), sum(length(body)) FROM t", params: [] });
  return steps;
}

describe("shard SQL limits do not make a statement's outcome depend on placement", () => {
  for (const seed of seedsOr([1, 2, 3, 4, 5, 6])) {
    it(`seed ${seed}`, async () => {
      const lite = new DatabaseSync(":memory:");
      const ddl = "CREATE TABLE t(id INTEGER PRIMARY KEY, g INTEGER, body TEXT)";
      lite.exec(ddl);
      const steps = script(seed);
      const want = steps.map((s) => sqlite(lite, s));
      const bad: string[] = [];
      for (const shards of [1, 2, 4]) {
        const db = new Db(new SimCluster({ shards }));
        await db.ddl(ddl);
        for (const [i, s] of steps.entries()) {
          const got = await ours(db, s);
          if (got !== want[i]) bad.push(`${shards} shards, step ${i + 1} (${s.sql.slice(0, 50)}..., ${s.params.length} params): ${got.slice(0, 120)} (SQLite ${want[i]!.slice(0, 80)})`);
        }
      }
      expect(bad.slice(0, 6)).toEqual([]);
    }, 120000);
  }
});

// 基準経路だけの実行 (vitest.config.ts の reference-scans、reference-full) では、集約もシャードで計算せずに行を集めるので、
// 結果の小さい集約でも予算に当たる。予算の試験は計画どおりの実行でだけ流す。
describe.skipIf(!!process.env.REFERENCE)("the gather budget is a total that does not depend on placement", () => {
  // 予算の単位は src/shard/core.ts の sizeOf (文字列は 2 バイト/文字)。行は 1,000 文字なので、1 行はおよそ 2,000 バイトである。
  const BUDGET = 4_000_000;
  const cases = [
    { rows: 800, ok: true }, // 約 1.6 MB。予算の内側
    { rows: 1900, ok: true }, // 約 3.8 MB。予算の内側
    { rows: 2300, ok: false }, // 約 4.6 MB。予算の外側
  ];
  for (const { rows, ok } of cases) {
    it(`${rows} rows: ${ok ? "succeeds" : "fails"} on every placement`, async () => {
      const outcomes: string[] = [];
      for (const shards of [1, 2, 4, 8]) {
        for (const skewed of [true, false]) {
          const c = new SimCluster({ shards });
          const db = new Db(c, { limits: { bytes: BUDGET } });
          await db.ddl("CREATE TABLE g(g INTEGER NOT NULL, id INTEGER NOT NULL, body TEXT, PRIMARY KEY (g, id)) SHARD KEY (g)");
          for (let at = 0; at < rows; at += 50) {
            const chunk = Array.from({ length: Math.min(50, rows - at) }, (_v, i) => at + i);
            await db.query(`INSERT INTO g VALUES ${chunk.map(() => "(?, ?, ?)").join(", ")}`, chunk.flatMap((i) => [skewed ? 1 : i, i, "z".repeat(1000)]));
          }
          // 3 つ目は集約で、結果の大きさは群の数で決まる。偏らせた行 (g がみな 1) は 1 群なので、どの大きさでも成功する。
          // 散らした行 (g が行ごとに違う) は行と同じ数の群になるので、予算の外側では失敗する。どちらもシャードの数には依らない。
          for (const [sql, big] of [["SELECT id, body FROM g ORDER BY id", true], ["SELECT * FROM g", true], ["SELECT g, count(*), max(body) FROM g GROUP BY g ORDER BY g LIMIT 1", false]] as const) {
            const got = await db.query(sql).then((r) => `ok ${r.rows.length}`, (e: Error) => `error ${e.message.slice(0, 40)}`);
            const want = ok || (!big && skewed) ? "ok" : "fails";
            outcomes.push(`${shards} shards ${skewed ? "skewed" : "spread"} ${sql.slice(0, 30)}: ${got.startsWith("ok") ? "ok" : got} (want ${want})`);
          }
        }
      }
      const unexpected = outcomes.filter((o) => (o.endsWith("(want ok)") ? !/: ok \(want/.test(o) : /: ok \(want/.test(o)));
      expect(unexpected.slice(0, 8)).toEqual([]);
    }, 300000);
  }
});

describe("the size of a transaction is a total that does not depend on placement", () => {
  // 取引が変える行の大きさの上限 (MAX_WRITE_SET_BYTES、1 MB)。シャードごとに数えると、同じ取引でも行が分かれていれば通り、
  // 1 つのシャードに集まれば断られる。取引全体で数える (Txn の writeBytes)。
  const cases = [
    { rows: 16, ok: true }, // 約 0.8 MB
    { rows: 24, ok: false }, // 約 1.2 MB
  ];
  for (const { rows, ok } of cases) {
    it(`${rows} rows of 50 KB: ${ok ? "commits" : "is refused"} on every placement`, async () => {
      const outcomes: string[] = [];
      for (const shards of [1, 2, 4]) {
        for (const skewed of [true, false]) {
          const db = new Db(new SimCluster({ shards }));
          await db.ddl("CREATE TABLE w(g INTEGER NOT NULL, id INTEGER NOT NULL, body TEXT, PRIMARY KEY (g, id)) SHARD KEY (g)");
          const got = await db.transaction(async (tx) => {
            for (let i = 0; i < rows; i++) await tx.query("INSERT INTO w VALUES (?, ?, ?)", [skewed ? 1 : i, i, "w".repeat(50_000)]);
          }).then(() => "ok", (e: Error) => `error ${e.message.slice(0, 40)}`);
          if ((got === "ok") !== ok) outcomes.push(`${shards} shards ${skewed ? "skewed" : "spread"}: ${got}`);
        }
      }
      expect(outcomes).toEqual([]);
    }, 120000);
  }
});
