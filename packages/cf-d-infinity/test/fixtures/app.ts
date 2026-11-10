// 同じ Worker に DB を入れる配置の見本。DO のクラスと Database を export し、自分自身への binding で使う。
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { integer, sqliteTable } from "drizzle-orm/sqlite-core";
import { connect, type Connection } from "../../src/binding";

export { DinfAutoscaler, DinfDatabase, DinfMeta, DinfShard } from "../../src/cloudflare";

const acc = sqliteTable("acc", { id: integer("id").primaryKey(), balance: integer("balance").notNull() });
const total = async (db: Connection) => db.prepare("SELECT sum(balance) AS s FROM acc").first<number>("s");

const scenarios: Record<string, (db: Connection) => Promise<unknown>> = {
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
  async afterAbandon(db) {
    const t0 = Date.now();
    await db.transaction((t) => t.execute("UPDATE acc SET balance = balance + 0 WHERE id = 1"));
    return { ms: Date.now() - t0, balance: await db.prepare("SELECT balance FROM acc WHERE id = 1").first("balance") };
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
  async session(db) {
    const s = db.withSession();
    const zero = s.getBookmark();
    await s.prepare("UPDATE acc SET balance = balance + 0 WHERE id = 1").run();
    const bookmark = s.getBookmark();
    const later = db.withSession(bookmark);
    return { zero, advanced: Number(bookmark) > 0, carried: later.getBookmark() === bookmark, read: await later.prepare("SELECT balance FROM acc WHERE id = 1").first("balance") };
  },
};

export default {
  async fetch(request: Request, env: { DINF_DB: unknown }): Promise<Response> {
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
      return Response.json(await scenarios[name]!(connect(env.DINF_DB)));
    } catch (e) {
      return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
    }
  },
};
