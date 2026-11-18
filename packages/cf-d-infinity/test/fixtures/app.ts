// 同じ Worker に DB を入れる配置の見本。DO のクラスと Database を export し、自分自身への binding で使う。
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { integer, sqliteTable } from "drizzle-orm/sqlite-core";
import { connect, drizzleMigrationsTable, type Connection } from "../../src/binding";
import { D1Compatible } from "../../src/client/d1";
import { dbFor, type Env as WorkerEnv } from "../../src/worker";
import { BY_KEY, HTTP_LITERALS, INSERT, JS_VALUES, SELECT, TABLE, shownRow } from "../entry-values";

export { DinfAutoscaler, DinfDatabase, DinfMeta, DinfShard } from "../../src/cloudflare";

const acc = sqliteTable("acc", { id: integer("id").primaryKey(), balance: integer("balance").notNull() });
const total = async (db: Connection) => db.prepare("SELECT sum(balance) AS s FROM acc").first<number>("s");

interface Env { DINF_DB: unknown }
const WIDE = [2n ** 63n - 1n, -(2n ** 63n), 2n ** 53n + 1n];
const NUL = "a\u0000b";
/** 失敗の文面。投げなければ "no error"。 */
const failure = (f: () => PromiseLike<unknown>) => Promise.resolve().then(f).then(() => "no error", (e: Error) => e.message);
/** Response.json は bigint を書けないので、`<数字>n` の文字列にする。 */
const shown = (x: unknown) => JSON.parse(JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? `${v}n` : v)));

const scenarios: Record<string, (db: Connection, env: Env) => Promise<unknown>> = {
  async d1(db) {
    await db.prepare("CREATE TABLE IF NOT EXISTS acc(id INTEGER PRIMARY KEY, balance INTEGER NOT NULL)").run();
    const ins = db.prepare("INSERT OR REPLACE INTO acc(id, balance) VALUES (?, ?)");
    const batch = await db.batch([ins.bind(1, 100), ins.bind(2, 100), ins.bind(3, 100)]);
    const one = db.prepare("SELECT id, balance FROM acc WHERE id = ?");
    const list = db.prepare("SELECT id, balance FROM acc ORDER BY id");
    return {
      batch: batch.map((r) => r.meta.changes),
      column: await one.bind(1).first("balance"),
      row: await one.bind(2).first(),
      missing: await one.bind(99).first(),
      all: (await list.all()).results,
      raw: await list.raw(),
      rawNames: (await list.raw({ columnNames: true }))[0],
      changes: (await db.prepare("UPDATE acc SET balance = balance + 0 WHERE id >= ?").bind(2).run()).meta.changes,
    };
  },
  async tx(db) {
    const tx = await db.begin();
    const { rows } = await tx.execute("SELECT balance FROM acc WHERE id = ?", [1]);
    await tx.execute("UPDATE acc SET balance = balance - 30 WHERE id = 1");
    await tx.execute("UPDATE acc SET balance = balance + 30 WHERE id = 2");
    await tx.commit();
    await tx.rollback();

    const undone = await db.begin();
    await undone.execute("UPDATE acc SET balance = 0 WHERE id = 1");
    await undone.rollback();

    const thrown = await db.transaction(async (t) => {
      await t.execute("UPDATE acc SET balance = 0 WHERE id = 2");
      throw new Error("changed my mind");
    }).catch((e: Error) => e.message);
    const helper = await db.transaction(async (t) => (await t.execute("UPDATE acc SET balance = balance + 1 WHERE id = 3")).changes);

    return { read: rows, thrown, helper, all: (await db.prepare("SELECT id, balance FROM acc ORDER BY id").all()).results, total: await total(db) };
  },
  /** commit も rollback もしないまま要求を終える。 */
  async abandon(db) {
    const tx = await db.begin();
    await tx.execute("UPDATE acc SET balance = 0 WHERE id = 1");
    return { left: "open" };
  },
  /** スコープを抜けるときの後始末 (await using が呼ぶもの) で rollback する。 */
  async scoped(db) {
    const tx = await db.begin();
    await tx.execute("UPDATE acc SET balance = 0 WHERE id = 2");
    await tx[Symbol.asyncDispose]();
    const t0 = Date.now();
    await db.transaction((t) => t.execute("UPDATE acc SET balance = balance + 0 WHERE id = 2"));
    return { ms: Date.now() - t0, balance: await db.prepare("SELECT balance FROM acc WHERE id = 2").first("balance") };
  },
  /**
   * 放っておかれた取引の行ロックは、取引の最後の文から 7.5 秒までに切れる (docs/design-lock-lease.md)。行ロックの待ちは 5 秒が上限
   * なので、すぐ後に同じ行を書く取引は、1 度 SQLITE_BUSY になり得る。アプリと同じに、やり直す。
   */
  async afterAbandon(db) {
    const t0 = Date.now();
    const failed: string[] = [];
    for (;;) {
      try {
        await db.transaction((t) => t.execute("UPDATE acc SET balance = balance + 0 WHERE id = 1"));
        break;
      } catch (e) {
        failed.push((e as Error).message);
        if (failed.length >= 3) throw e;
      }
    }
    return { ms: Date.now() - t0, failed, balance: await db.prepare("SELECT balance FROM acc WHERE id = 1").first("balance") };
  },
  async conflict(db) {
    const tx = await db.begin("deferred");
    await tx.execute("SELECT balance FROM acc WHERE id = 1");
    await db.prepare("UPDATE acc SET balance = balance + 0 WHERE id = 1").run();
    await tx.execute("UPDATE acc SET balance = balance + 5 WHERE id = 1");
    const error = await tx.commit().then(() => null, (e: Error) => e.message);
    return { error, total: await total(db) };
  },
  async drizzle(db) {
    const orm = drizzle(db as never);
    const before = await orm.select().from(acc).where(eq(acc.id, 2));
    await orm.update(acc).set({ balance: 500 }).where(eq(acc.id, 2));
    const batch = await orm.batch([
      orm.update(acc).set({ balance: 130 }).where(eq(acc.id, 2)),
      orm.select().from(acc).orderBy(acc.id),
    ]);
    return { before, after: batch[1] };
  },
  // Drizzle の D1 のドライバの移行が送るのと同じ形の batch。移行のファイルは node:fs で読むので、workerd の中では
  // Drizzle の migrate を呼べない。文の並びを、そのまま batch で送る (DDL の位置で区切られる)。
  async migrate(db) {
    await db.prepare(drizzleMigrationsTable()).run();
    const run = (sql: string[], tag: string) => db.batch([
      ...sql.map((s) => db.prepare(s)),
      db.prepare(`INSERT INTO "__drizzle_migrations" ("hash", "created_at") VALUES ('${tag}', ${tag.length})`),
    ]);
    await run([
      "CREATE TABLE `m_users` (`id` integer PRIMARY KEY NOT NULL, `email` text NOT NULL, `name` text)",
      "CREATE UNIQUE INDEX `m_users_email_unique` ON `m_users` (`email`)",
    ], "0000");
    await db.prepare("INSERT INTO m_users(id, email, name) VALUES (1, 'a@x', 'A'), (2, 'b@x', NULL), (3, 'c@x', 'C')").run();
    // 表の作り直し。DROP は、取引が読んだ表を消すので、書き込みを止めて確かめてから消す。index は、行のある表に作り直す。
    await run([
      "PRAGMA foreign_keys=OFF",
      "CREATE TABLE `__new_m_users` (`id` integer PRIMARY KEY NOT NULL, `email` text NOT NULL, `name` text DEFAULT '' NOT NULL)",
      "INSERT INTO `__new_m_users`(\"id\", \"email\", \"name\") SELECT \"id\", \"email\", coalesce(\"name\", '') FROM `m_users`",
      "DROP TABLE `m_users`",
      "ALTER TABLE `__new_m_users` RENAME TO `m_users`",
      "PRAGMA foreign_keys=ON",
      "CREATE UNIQUE INDEX `m_users_email_unique` ON `m_users` (`email`)",
    ], "0001");
    const duplicate = await db.prepare("INSERT INTO m_users(id, email, name) VALUES (9, 'a@x', 'Z')").run().then(() => "ok", (e: Error) => e.message);
    return {
      rows: (await db.prepare("SELECT id, email, name FROM m_users ORDER BY id").all()).results,
      journal: await db.prepare('SELECT count(*) AS n FROM "__drizzle_migrations"').first("n"),
      duplicate,
    };
  },
  async session(db) {
    const s = db.withSession();
    const zero = s.getBookmark();
    await s.prepare("UPDATE acc SET balance = balance + 0 WHERE id = 1").run();
    const bookmark = s.getBookmark();
    const later = db.withSession(bookmark);
    return { zero, advanced: Number(bookmark) > 0, carried: later.getBookmark() === bookmark, read: await later.prepare("SELECT balance FROM acc WHERE id = 1").first("balance") };
  },
  /** 64 ビットの整数と NUL を含む文字列を、binding の 3 つの intMode で読む。 */
  async wide(db, env) {
    const big = connect(env.DINF_DB, { intMode: "bigint" });
    const str = connect(env.DINF_DB, { intMode: "string" });
    await db.prepare("CREATE TABLE IF NOT EXISTS w(id INTEGER PRIMARY KEY, n INTEGER, v, s TEXT)").run();
    await db.batch(WIDE.map((n, i) => db.prepare("INSERT OR REPLACE INTO w(id, n, v, s) VALUES (?, ?, ?, ?)").bind(i + 1, n, n, NUL)));
    const scan = "SELECT id, n, v, s FROM w WHERE id <= 3 ORDER BY id";
    const tx = await big.begin();
    const inTx = (await tx.execute("SELECT n FROM w WHERE id = ?", [2])).rows;
    await tx.execute("UPDATE w SET v = ? WHERE id = 3", [2n ** 62n + 1n]);
    await tx.commit();
    return shown({
      plainScan: await failure(() => db.prepare(scan).all()),
      plainKey: await failure(() => db.prepare("SELECT n FROM w WHERE id = ?").bind(1).first()),
      plainRaw: await failure(() => db.prepare(scan).raw()),
      safe: await db.prepare("SELECT id, s FROM w WHERE id = ?").bind(1).first(),
      bigScan: (await big.prepare(scan).all()).results,
      bigRaw: await big.prepare(scan).raw(),
      strScan: (await str.prepare(scan).all()).results,
      session: await big.withSession().prepare("SELECT n FROM w WHERE id = 1").first("n"),
      batch: (await big.batch([big.prepare("SELECT n FROM w WHERE id = ?").bind(2)]))[0]!.results,
      inTx,
      afterTx: await big.prepare("SELECT v FROM w WHERE id = 3").first("v"),
      lastRowPlain: (await db.prepare("INSERT OR REPLACE INTO w(id, n) VALUES (?, 0)").bind(2n ** 60n).run()).meta.last_row_id,
      returningPlain: await failure(() => db.prepare("INSERT OR REPLACE INTO w(id, n) VALUES (?, 0) RETURNING id").bind(2n ** 60n + 3n).all()),
      lastRowBig: (await big.prepare("INSERT OR REPLACE INTO w(id, n) VALUES (?, 0)").bind(2n ** 60n + 1n).run()).meta.last_row_id,
      lastRowStr: (await str.prepare("INSERT OR REPLACE INTO w(id, n) VALUES (?, 0)").bind(2n ** 60n + 2n).run()).meta.last_row_id,
      unsafe: await big.prepare("SELECT typeof(?) AS t, ? AS x").bind(2 ** 60, 2 ** 60).first(),
      unsafeStored: await (async () => {
        await big.prepare("INSERT OR REPLACE INTO w(id, n, v) VALUES (9, ?, ?)").bind(2 ** 60, 2 ** 60).run();
        return big.prepare("SELECT typeof(n) AS tn, n, typeof(v) AS tv, v FROM w WHERE id = 9").first();
      })(),
      tooWide: await failure(() => big.prepare("SELECT ? AS x").bind(2n ** 63n).all()),
      badMode: await failure(() => connect(env.DINF_DB, { intMode: "double" } as never).prepare("SELECT 1").all()),
    });
  },
  /** binding の fetch で HTTP の /sql と /batch を呼ぶ。JSON の本文は、文面のまま送る (JS の数では書けない literal がある)。 */
  async httpWide(_db, env) {
    const post = async (path: string, body: string) => {
      const r = await (env.DINF_DB as { fetch: typeof fetch }).fetch(`http://dinf.internal${path}`, { method: "POST", body, headers: { authorization: "Bearer data-token" } });
      return { status: r.status, ...((await r.json()) as object) };
    };
    const scan = "SELECT id, n, s FROM w WHERE id <= 3 ORDER BY id";
    return {
      plain: await post("/sql", JSON.stringify({ sql: scan })),
      str: await post("/sql", JSON.stringify({ sql: scan, intMode: "string" })),
      num: await post("/sql", JSON.stringify({ sql: "SELECT id, s FROM w WHERE id = 1", intMode: "number" })),
      bigint: await post("/sql", JSON.stringify({ sql: "SELECT 1", intMode: "bigint" })),
      bad: await post("/sql", JSON.stringify({ sql: "SELECT 1", intMode: "double" })),
      literals: await post("/sql", `{"sql":"SELECT typeof(?) AS a, ? AS b, typeof(?) AS c, typeof(?) AS d, ? AS e, typeof(?) AS f","params":[9223372036854775807,-9223372036854775808,9007199254740993.0,99999999999999999999,9007199254740993,7],"intMode":"string"}`),
      lastRow: await post("/sql", `{"sql":"INSERT OR REPLACE INTO w(id, n) VALUES (?, 0)","params":[1152921504606846981],"intMode":"string"}`),
      lastRowPlain: await post("/sql", `{"sql":"INSERT OR REPLACE INTO w(id, n) VALUES (?, 0)","params":[1152921504606846982]}`),
      batch: await post("/batch", JSON.stringify({ statements: [{ sql: "SELECT n FROM w WHERE id = 2" }, { sql: "SELECT ? AS s", params: [NUL] }], intMode: "string" })),
      batchPlain: await post("/batch", JSON.stringify({ statements: [{ sql: "SELECT n FROM w WHERE id = 2" }] })),
      nul: await post("/sql", JSON.stringify({ sql: "SELECT ? AS s, hex(?) AS h", params: [NUL, NUL] })),
    };
  },
  /**
   * 入口の値 (test/entry-values.ts)。HTTP の /sql と /batch には JSON の literal を文面のまま送り、Service Binding (query、batch、
   * 取引の execute) と、この Worker の中の D1 互換の API には JS の値を渡す。どれも、表を読まない文と、主キーで読み書きする文で流す。
   */
  async entryValues(_db, env) {
    const post = async (path: string, body: string) => {
      const r = await (env.DINF_DB as { fetch: typeof fetch }).fetch(`http://dinf.internal${path}`, { method: "POST", body, headers: { authorization: "Bearer data-token" } });
      const out = (await r.json()) as { rows?: Record<string, unknown>[]; results?: { rows: Record<string, unknown>[] }[]; error?: string };
      return { status: r.status, row: out.rows?.[0] ?? out.results?.[0]?.rows[0], error: out.error };
    };
    const q = (s: string) => JSON.stringify(s);
    const tried = async (f: () => PromiseLike<Record<string, unknown> | null | undefined>) =>
      Promise.resolve().then(f).then((row) => ({ row: shownRow(row) }), (e: Error) => ({ error: e.message, name: e.name }));
    const big = connect(env.DINF_DB, { intMode: "bigint" });
    await big.prepare(TABLE).run();
    const http = [];
    for (const [i, [literal]] of HTTP_LITERALS.entries()) {
      http.push({
        select: await post("/sql", `{"sql":${q(SELECT)},"params":[${literal}],"intMode":"string"}`),
        batch: await post("/batch", `{"statements":[{"sql":${q(SELECT)},"params":[${literal}]}],"intMode":"string"}`),
        insert: await post("/sql", `{"sql":${q(INSERT)},"params":[${i},${literal}]}`),
        key: await post("/sql", `{"sql":${q(BY_KEY)},"params":[${i},${literal}],"intMode":"string"}`),
      });
    }
    const binding = [];
    for (const [i, c] of JS_VALUES.entries()) {
      if (c.rpc === false) {
        binding.push(null);
        continue;
      }
      const tx = await big.begin("deferred");
      const inTx = await tried(async () => (await tx.execute(SELECT, [c.value()])).rows[0]);
      await tx.rollback();
      binding.push({
        select: await tried(() => big.prepare(SELECT).bind(c.value()).first()),
        batch: await tried(async () => (await big.batch([big.prepare(SELECT).bind(c.value())]))[0]!.results[0] as Record<string, unknown>),
        tx: inTx,
        insert: await tried(async () => (await big.prepare(INSERT).bind(100 + i, c.value()).run(), null)),
        key: await tried(() => big.prepare(BY_KEY).bind(100 + i, c.value()).first()),
      });
    }
    // この Worker の中で、Db を D1 互換の API で包む (src/client/d1.ts)。
    const d1 = new D1Compatible(await dbFor(env as unknown as WorkerEnv, 0), { intMode: "bigint" });
    const local = [];
    for (const [i, c] of JS_VALUES.entries()) {
      local.push({
        select: await tried(() => d1.prepare(SELECT).bind(c.value()).first()),
        insert: await tried(async () => (await d1.prepare(INSERT).bind(200 + i, c.value()).run(), null)),
        key: await tried(() => d1.prepare(BY_KEY).bind(200 + i, c.value()).first()),
      });
    }
    return { http, binding, local, rows: await big.prepare("SELECT count(*) AS c FROM ev").first("c").then(String) };
  },
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const name = new URL(request.url).pathname.slice(1);
    if (name === "http") {
      // binding の fetch は HTTP の入口へ届く。こちらは binding だけでは通らず、トークンが要る。
      const viaHttp = (token: string | null) => (env.DINF_DB as { fetch: typeof fetch }).fetch("http://dinf.internal/sql", {
        method: "POST", body: JSON.stringify({ sql: "SELECT count(*) AS n FROM acc" }),
        headers: token ? { authorization: `Bearer ${token}` } : {},
      });
      const ok = await viaHttp("data-token");
      return Response.json({ none: (await viaHttp(null)).status, wrong: (await viaHttp("x")).status, ok: ok.status, rows: ((await ok.json()) as { rows: unknown }).rows });
    }
    try {
      return Response.json(await scenarios[name]!(connect(env.DINF_DB), env));
    } catch (e) {
      return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
    }
  },
};
