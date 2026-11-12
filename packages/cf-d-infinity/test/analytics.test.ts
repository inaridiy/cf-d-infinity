import { DuckDBInstance } from "@duckdb/node-api";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collect } from "../src/analytics";
import { keyString } from "../src/keys";
import { ownerOf } from "../src/routing";
import type { Faults } from "../src/types";
import { logRows, ORDERS, SimCluster, USERS } from "./sim";

describe("analytics path", () => {
  it("rebuilds the latest state in DuckDB and agrees with the OLTP tier", async () => {
    const c = new SimCluster();
    const db = c.client();
    await db.ddl(ORDERS);
    await db.ddl(`CREATE TABLE tenants(tenant_id INTEGER PRIMARY KEY, plan TEXT)`);
    for (let t = 1; t <= 10; t++) {
      await db.query("INSERT INTO tenants VALUES (?,?)", [t, t % 2 ? "pro" : "free"]);
      await db.query("INSERT INTO orders VALUES (?,1,1,'open',?)", [t, t * 10]);
    }
    await db.query("UPDATE orders SET status = 'paid' WHERE tenant_id = 1 AND id = 1");
    await db.query("DELETE FROM orders WHERE tenant_id = 2 AND id = 1");
    await c.settle();
    const oltp = await db.query("SELECT plan, sum(total) s FROM orders o JOIN tenants t ON t.tenant_id = o.tenant_id GROUP BY plan ORDER BY plan");

    c.time += 1000; // W は全シャードの flush 時刻の最小値なので、物理時刻が進んで初めて追いつく
    const snap = await collect(c);
    const dir = mkdtempSync(join(tmpdir(), "newsql-"));
    const file = join(dir, "changes.ndjson");
    writeFileSync(file, snap.changes.filter((x) => x.commit_ts <= snap.W).map((x) => JSON.stringify({ ...x, row: JSON.stringify(x.row) })).join("\n"));

    const duck = await (await DuckDBInstance.create(":memory:")).connect();
    await duck.run(`CREATE VIEW latest AS
      SELECT * FROM (SELECT *, row_number() OVER (PARTITION BY "table", pk ORDER BY commit_ts DESC) rn
                     FROM read_json('${file}', format='newline_delimited', columns={commit_ts:'BIGINT', "table":'VARCHAR', pk:'VARCHAR', deleted:'BOOLEAN', row:'VARCHAR'}))
      WHERE rn = 1 AND NOT deleted`);
    await duck.run(`CREATE VIEW orders AS SELECT (row->>'tenant_id')::INT tenant_id, row->>'status' status, (row->>'total')::INT total FROM latest WHERE "table" = 'orders'`);
    await duck.run(`CREATE VIEW tenants AS SELECT (row->>'tenant_id')::INT tenant_id, row->>'plan' plan FROM latest WHERE "table" = 'tenants'`);
    const r = await duck.runAndReadAll(`SELECT t.plan, sum(o.total)::INT s, count(*)::INT c FROM orders o JOIN tenants t USING (tenant_id) GROUP BY t.plan ORDER BY t.plan`);
    expect(r.getRowObjects()).toEqual([{ plan: "free", s: 280, c: 4 }, { plan: "pro", s: 250, c: 5 }]);
    // OLTP 層の同じ集計と一致する。
    expect(oltp.rows).toEqual([{ plan: "free", s: 280 }, { plan: "pro", s: 250 }]);
  });
});

// specs/m6_watermark.qnt の m6_red_resolved。シャードの flush 時刻は、未解決の intent の min(prepare_ts) − 1 で抑える (resolved ts)。
// intent は、anchor が決めた c で後から確定する。c は prepare_ts 以上だが、このシャードの時計より小さいことがある。
// モデルの反例の順で流す: シャード P に intent を置く (prepare)。P で単一シャードの commit がある。P が flush する。W が公開される。
// intent が c (P の flush 時刻以下) で適用される。W 以下なのに、どの flush にも入らない commit ができる。
// 実装では c を anchor (別のシャード) が決め、P への phase 2 を止めている間に、P の時計が c を越えて進む。
// 分析の経路は、配備した Worker からはまだ呼ばれない (docs/overview.md)。ここでは src/analytics.ts の collect で W を作る。
describe("the analytics flush stops below unresolved intents (m6_red_resolved)", () => {
  const scenario = async (faults: Faults) => {
    const c = new SimCluster({ shards: 2, faults });
    const db = c.client();
    await db.ddl(USERS);
    const { routing } = await c.catalog();
    const on = (shard: string) => { for (let t = 1; ; t++) if (ownerOf(routing, keyString([t])) === shard) return t; };
    const [a, p] = [on("s0"), on("s1")];
    await db.query("INSERT INTO users(tenant_id,id,n) VALUES (?,1,0)", [a]);
    await db.query("INSERT INTO users(tenant_id,id,n) VALUES (?,1,0),(?,2,0)", [p, p]);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    c.net.gate = (m) => (m.method === "finalize" && m.to === "s1" ? held : undefined);
    // a の読みは書き込みで守られていないので、anchor は s0 になる。s1 には intent だけが残る。
    const w = await db.begin();
    await w.query("SELECT n FROM users WHERE tenant_id = ? AND id = 1", [a]);
    await w.query("UPDATE users SET n = 1 WHERE tenant_id = ? AND id = 1", [p]);
    await w.commit();
    const commitTs = w.commitTs!;
    const pts = c.backends.get("s1")!.exec("SELECT prepare_ts v FROM __intents")[0]!.v as number;
    c.time += 10;
    await db.query("UPDATE users SET n = 5 WHERE tenant_id = ? AND id = 2", [p]); // モデルの commit(1)
    const first = await collect(c); // flush と W の公開
    c.net.gate = () => undefined;
    release(); // intent が c で適用される
    await c.settle();
    c.time += 10;
    const second = await collect(c);
    // 前提: intent は c で適用され、s1 の変更ログにある。flush に入らないのは、適用されなかったからではない。
    const logged = logRows(c.backends.get("s1")!).some((r) => r.commit_ts === commitTs);
    const seen = [...first.changes, ...second.changes].some((x) => x.commit_ts === commitTs && x.table === "users");
    return { c: commitTs, pts, W1: first.W, W2: second.W, logged, seen };
  };

  it("put back: flushing at the clock passes over the intent, and its commit never reaches the analytics path", async () => {
    const s = await scenario({ flushPastIntents: true });
    expect(s.c).toBeGreaterThanOrEqual(s.pts);
    expect(s.W1).toBeGreaterThanOrEqual(s.c);
    // W 以下の commit が、どの flush にも入らない (watermarkSafe の違反)。
    expect(s.W2).toBeGreaterThanOrEqual(s.c);
    expect(s.logged).toBe(true);
    expect(s.seen).toBe(false);
  });

  it("holds W below the intent until it is resolved, then flushes its commit", async () => {
    const s = await scenario({});
    expect(s.c).toBeGreaterThanOrEqual(s.pts);
    expect(s.W1).toBeLessThan(s.pts);
    expect(s.W2).toBeGreaterThanOrEqual(s.c);
    expect(s.logged).toBe(true);
    expect(s.seen).toBe(true);
  });
});
