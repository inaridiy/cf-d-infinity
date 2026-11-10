// DB を別の Worker に置く配置の見本。こちらは binding とクライアントだけを持つ。
import { connect } from "../../src/binding";

export default {
  async fetch(_request: Request, env: { DINF_DB: unknown }): Promise<Response> {
    const db = connect(env.DINF_DB);
    await db.prepare("CREATE TABLE IF NOT EXISTS notes(id INTEGER PRIMARY KEY, body TEXT NOT NULL)").run();
    await db.batch([
      db.prepare("INSERT OR REPLACE INTO notes(id, body) VALUES (?, ?)").bind(1, "a"),
      db.prepare("INSERT OR REPLACE INTO notes(id, body) VALUES (?, ?)").bind(2, "b"),
    ]);
    await db.transaction(async (tx) => {
      await tx.execute("UPDATE notes SET body = body || '!' WHERE id = 1");
      await tx.execute("UPDATE notes SET body = body || '?' WHERE id = 2");
    });
    return Response.json((await db.prepare("SELECT id, body FROM notes ORDER BY id").all()).results);
  },
};
