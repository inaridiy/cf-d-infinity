// 更新の試験 (計画書の公開の条件 2、docs/storage-format.md)。
//
// 公開した版が書いた保存データを、今のコードで開けることを確かめる。材料 (test/fixtures/storage/format-<版>.json) は、決まった
// 作業負荷をシミュレータで流し、Meta と全シャードの SQLite を quote() で SQL の文に写したものである。今のコードは、その写しから
// 起動し、同じ答えを返し、書き込み、分割、表定義の変更が通らなければならない。
//
// 材料を足すのは、保存の形式の版 (STORAGE_FORMAT) を上げたときだけである。新しい版の材料を書くには:
//   WRITE_STORAGE_FIXTURE=1 npx vitest run test/upgrade.test.ts --project sim
// 公開した版の材料は書き換えない。書き換えると、利用者のデータを開けることを確かめられなくなる。
// 最初の公開 (npm への本物のリリース) の前は、版 1 の保存形式も自由に変えてよい (持ち主の決定、2026-11-13)。形式を変えたら、
// 材料を作り直す:
//   REWRITE_STORAGE_FIXTURE=1 WRITE_STORAGE_FIXTURE=1 npx vitest run test/upgrade.test.ts --project sim
// 最初の公開の後は、REWRITE_STORAGE_FIXTURE を使わず、版を上げて移行を書く。
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { split } from "../src/autoscaler";
import { STORAGE_FORMAT, type Value } from "../src/types";
import { quiescentProblems } from "./invariants";
import { SimCluster } from "./sim";

const DIR = join(import.meta.dirname, "fixtures", "storage");

interface Fixture {
  format: number;
  /** 材料を書いたときのクラスタの時計 (ms)。開く側は、時計をこれより後に置く。 */
  clock: number;
  meta: string[];
  shards: Record<string, string[]>;
  expected: Record<string, string>;
}

/** 利用者に見える答え。BLOB、無限大、整数の値の REAL を、比べられる形にする。 */
const show = (rows: unknown) => JSON.stringify(rows, (_k, x) =>
  x instanceof Uint8Array ? { blob: [...x] } : typeof x === "number" && !Number.isFinite(x) ? `${x}` : x);

const QUERIES: Record<string, string> = {
  acct: "SELECT tenant_id, id, email, n FROM acct ORDER BY tenant_id, id",
  kv: "SELECT k, typeof(v) AS tv, v, typeof(r) AS tr, r, extra FROM kv ORDER BY k",
  logs: "SELECT rowid, msg, at FROM logs ORDER BY rowid",
  big: "SELECT tenant_id, id, n FROM big ORDER BY tenant_id, id",
  byEmail: "SELECT tenant_id, id FROM acct WHERE email = 'u7@example.test'",
};

/** SQLite のデータベースを、同じ中身を作る SQL の文の並びにする。表、行、index、view、trigger の順。 */
function dumpSql(db: DatabaseSync): string[] {
  const q = (id: string) => `"${id.replaceAll('"', '""')}"`;
  const objects = db.prepare(
    "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid",
  ).all() as { type: string; name: string; sql: string }[];
  const out: string[] = [];
  for (const o of objects.filter((x) => x.type === "table")) {
    out.push(`${o.sql};`);
    const cols = (db.prepare(`SELECT name, type, pk FROM pragma_table_info(?)`).all(o.name) as { name: string; type: string; pk: number }[]);
    const withoutRowid = /\bWITHOUT\s+ROWID\b/i.test(o.sql);
    const pks = cols.filter((c) => c.pk > 0);
    const rowidAlias = pks.length === 1 && /^INTEGER$/i.test(pks[0]!.type);
    const names = [...(withoutRowid || rowidAlias ? [] : ["rowid"]), ...cols.map((c) => c.name)];
    const select = names.map((n) => (n === "rowid" ? "quote(rowid)" : `quote(${q(n)})`)).join(" || ', ' || ");
    const list = names.map((n) => (n === "rowid" ? "rowid" : q(n))).join(", ");
    for (const r of db.prepare(`SELECT ${select} AS v FROM ${q(o.name)}`).all() as { v: string }[]) {
      out.push(`INSERT INTO ${q(o.name)}(${list}) VALUES (${r.v});`);
    }
  }
  for (const o of objects.filter((x) => x.type !== "table")) out.push(`${o.sql};`);
  return out;
}

function loadSql(statements: string[]): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  for (const s of statements) db.exec(s);
  return db;
}

async function answers(c: SimCluster): Promise<Record<string, string>> {
  const db = c.client();
  const out: Record<string, string> = {};
  for (const [name, sql] of Object.entries(QUERIES)) out[name] = show((await db.query(sql)).rows);
  return out;
}

/** 材料を作る作業負荷。表定義の変更の履歴、シャードをまたぐ UNIQUE の index、型のない列の値、分割を含む。 */
async function workload(): Promise<SimCluster> {
  const c = new SimCluster({ shards: 3, seed: 1 });
  const db = c.client();
  await db.ddl("CREATE TABLE acct(tenant_id INTEGER NOT NULL, id INTEGER NOT NULL, email TEXT UNIQUE, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (tenant_id, id))");
  await db.ddl("CREATE TABLE kv(k TEXT PRIMARY KEY, v, r REAL)");
  await db.ddl("CREATE TABLE logs(msg TEXT, at INTEGER)");
  await db.ddl("CREATE TABLE gone(id INTEGER PRIMARY KEY, x TEXT)");
  await db.query("INSERT INTO gone VALUES (1, 'a')");
  await db.ddl("DROP TABLE gone");
  for (let t = 1; t <= 12; t++) {
    await db.query("INSERT INTO acct(tenant_id, id, email, n) VALUES (?, 1, ?, ?), (?, 2, NULL, 0)", [t, `u${t}@example.test`, t * 3, t]);
  }
  const values: Value[] = [5, { real: 2 }, 2.5, "5", new Uint8Array([0, 255]), null, -3, { real: -0.0 + 7 }];
  for (const [i, v] of values.entries()) await db.query("INSERT INTO kv(k, v, r) VALUES (?, ?, ?)", [`k${i}`, v, i % 2 ? "1e400" : i / 4]);
  await db.ddl("CREATE INDEX kv_r ON kv(r)");
  await db.ddl("ALTER TABLE kv ADD COLUMN extra TEXT DEFAULT 'x'");
  await db.ddl("CREATE VIEW big AS SELECT * FROM acct WHERE n > 10");
  for (let i = 0; i < 10; i++) await db.query("INSERT INTO logs(msg, at) VALUES (?, ?)", [`m${i}`, i]);
  await db.ddl("CREATE UNIQUE INDEX logs_msg ON logs(msg)");
  await db.batch([
    { sql: "UPDATE acct SET n = n - 1 WHERE tenant_id = 1 AND id = 1" },
    { sql: "UPDATE acct SET n = n + 1 WHERE tenant_id = 2 AND id = 1" },
  ]);
  await split(c, "s0", "s3");
  await db.query("UPDATE kv SET v = ? WHERE k = 'k0'", [{ real: 9 }]);
  await db.query("DELETE FROM logs WHERE msg = 'm3'");
  await c.settle();
  return c;
}

function fixtures(): Fixture[] {
  if (!existsSync(DIR)) return [];
  return readdirSync(DIR).filter((f) => /^format-\d+\.json$/.test(f)).map((f) => JSON.parse(readFileSync(join(DIR, f), "utf8")) as Fixture);
}

describe("data written by a released version", () => {
  if (process.env.WRITE_STORAGE_FIXTURE) {
    it(`writes the fixture for storage format ${STORAGE_FORMAT}`, async () => {
      const file = join(DIR, `format-${STORAGE_FORMAT}.json`);
      if (existsSync(file) && !process.env.REWRITE_STORAGE_FIXTURE) {
        throw new Error(`${file} exists; a released format's fixture is never rewritten (before the first release, set REWRITE_STORAGE_FIXTURE=1)`);
      }
      const c = await workload();
      const fixture: Fixture = {
        format: STORAGE_FORMAT,
        clock: c.runtime.now(),
        meta: dumpSql(c.metaBackend.db),
        shards: Object.fromEntries([...c.backends].map(([id, b]) => [id, dumpSql(b.db)])),
        expected: await answers(c),
      };
      mkdirSync(DIR, { recursive: true });
      writeFileSync(file, `${JSON.stringify(fixture, null, 1)}\n`);
    });
    return;
  }

  it("has a fixture for the current storage format", () => {
    expect(fixtures().map((f) => f.format)).toContain(STORAGE_FORMAT);
  });

  for (const f of fixtures()) {
    describe(`storage format ${f.format}`, () => {
      const open = () => {
        const c = new SimCluster({
          seed: 2,
          stored: { meta: loadSql(f.meta), shards: new Map(Object.entries(f.shards).map(([id, s]) => [id, loadSql(s)])) },
        });
        // 書いた後に時間が経ってから開く。
        c.ahead = f.clock + 3_600_000;
        return c;
      };

      it("boots every Durable Object and answers as before", async () => {
        const c = open();
        expect(await answers(c)).toEqual(f.expected);
        const problems = await quiescentProblems(c);
        if (problems.length) console.log(problems.join("\n").slice(0, 2000));
        expect(problems).toEqual([]);
      });

      it("keeps writing, enforcing UNIQUE across shards, splitting and changing the schema", async () => {
        const c = open();
        const db = c.client();
        await db.query("INSERT INTO acct(tenant_id, id, email) VALUES (13, 1, 'new@example.test')");
        await expect(db.query("INSERT INTO acct(tenant_id, id, email) VALUES (14, 1, 'u7@example.test')")).rejects.toThrow(/UNIQUE/);
        await db.query("UPDATE kv SET v = v + 1 WHERE k = 'k0'");
        expect((await db.query("SELECT typeof(v) AS t, v FROM kv WHERE k = 'k0'")).rows).toEqual([{ t: "real", v: 10 }]);
        const shards = (await c.catalog()).routing.ranges.map((r) => r.shard);
        await split(c, shards[0]!, "s9");
        await db.ddl("ALTER TABLE acct ADD COLUMN note TEXT");
        await db.ddl("CREATE UNIQUE INDEX acct_n ON acct(tenant_id, n)");
        expect((await db.query("SELECT count(*) AS c FROM acct")).rows).toEqual([{ c: 25 }]);
        await c.settle();
        expect(await quiescentProblems(c)).toEqual([]);
      });
    });
  }
});
