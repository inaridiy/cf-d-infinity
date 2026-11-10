// 計測用の入口。本番の Worker (src/worker.ts) に、ベンチマークと障害注入の経路を足す。
// wrangler.bench.jsonc でデプロイする。本番の構成には含めない。
import type { Thresholds } from "./autoscaler";
import { Db, type Cluster } from "./client/db";
import type { Catalog } from "./meta";
import { runListAppend } from "./listappend";
import { shardsOf } from "./routing";
import {
  DinfAutoscaler, DinfMeta, DinfShard as ProductionShard, authorized, clusterOf, handle, type Env,
} from "./worker";

export { DinfAutoscaler, DinfMeta };

/** プロトコルを通らない素の DO の性能を測るプローブと、障害注入を足したシャード。 */
export class DinfShard extends ProductionShard {
  ping(): number {
    return Date.now();
  }
  rawRead(id: number): number {
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS __raw(id INTEGER PRIMARY KEY, n INTEGER)`);
    return this.ctx.storage.sql.exec(`SELECT n FROM __raw WHERE id = ?`, id).toArray().length;
  }
  rawWrite(id: number): number {
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS __raw(id INTEGER PRIMARY KEY, n INTEGER)`);
    this.ctx.storage.sql.exec(
      `INSERT INTO __raw(id, n) VALUES (?, 1) ON CONFLICT(id) DO UPDATE SET n = n + 1`, id,
    );
    return 1;
  }
  /** write 1 回の quorum 確定にかかる時間を DO の中から測る。 */
  async syncProbe(times: number): Promise<number[]> {
    const out: number[] = [];
    for (let i = 0; i < times; i++) {
      const t0 = Date.now();
      this.rawWrite(0);
      await this.ctx.storage.sync();
      out.push(Date.now() - t0);
    }
    return out;
  }
  async peerProbe(target: string, times: number): Promise<number[]> {
    const stub = (this.env as unknown as BenchEnv).DINF_SHARD.getByName(target);
    const out: number[] = [];
    for (let i = 0; i < times; i++) {
      const t0 = Date.now();
      await stub.ping();
      out.push(Date.now() - t0);
    }
    return out;
  }
  /** 診断。変更ログの世代と未決着の intent を返す。 */
  info(): unknown {
    const q = (sql: string) => this.ctx.storage.sql.exec(sql).toArray();
    const gens = q(`SELECT v FROM __meta WHERE k = 'log_gens'`)[0]?.v as string | undefined;
    const tables = q(`SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB '__log_g*'`).map((r) => r.name);
    let view: unknown = null;
    try {
      view = q(`SELECT count(*) n FROM __log`)[0];
    } catch (e) {
      view = String(e);
    }
    return {
      gens: gens ? (JSON.parse(gens) as number[]).length : null, gensSample: gens?.slice(0, 200), tables: tables.length,
      tableSample: tables.slice(0, 5), view,
      lowWater: q(`SELECT v FROM __meta WHERE k = 'log_low_water'`)[0]?.v ?? null,
      intents: q(`SELECT count(*) n, min(prepare_ts) p FROM __intents`)[0],
      txn: q(`SELECT count(*) n FROM __txn`)[0],
    };
  }
  /** 診断。redrive をその場で走らせ、残った仕事と失敗の理由を返す。 */
  async redriveNow(): Promise<unknown> {
    const core = (this as unknown as { core: { redrive(): Promise<boolean>; lastRedriveErrors: string[] } }).core;
    const more = await core.redrive();
    const intents = this.ctx.storage.sql.exec(`SELECT txn, anchor, prepare_ts FROM __intents LIMIT 3`).toArray();
    return { more, errors: core.lastRedriveErrors, sample: intents, alarm: await this.ctx.storage.getAlarm() };
  }
  /** 診断。UNION ALL の項の数をいくつまで受け付けるか。 */
  compoundLimit(): Record<number, string> {
    const out: Record<number, string> = {};
    for (const n of [2, 3, 4, 5, 6, 7, 8, 10, 16, 50, 100, 500]) {
      try {
        this.ctx.storage.sql.exec(Array.from({ length: n }, (_, i) => `SELECT ${i} AS x`).join(" UNION ALL ")).toArray();
        out[n] = "ok";
      } catch (e) {
        out[n] = String(e).slice(0, 80);
      }
    }
    try {
      this.ctx.storage.sql.exec(`SELECT blob FROM __log WHERE commit_ts > 0 ORDER BY commit_ts ASC LIMIT 1`).toArray();
      out[-1] = "log view ordered: ok";
    } catch (e) {
      out[-1] = String(e).slice(0, 80);
    }
    return out;
  }
  /** 障害注入。DO を再起動させる。メモリ (ロック、in-flight の取引、索引) は失われ、SQLite だけが残る。 */
  crash(): void {
    this.ctx.abort("injected crash");
  }
}

type BenchEnv = Omit<Env, "DINF_SHARD"> & { DINF_SHARD: DurableObjectNamespace<DinfShard> };

interface BenchReq {
  keys?: number[];
  epochMs?: number;
  keysPerEpoch?: number;
  op: string;
  cluster?: string;
  /** シャード数。シャード名の接頭辞にも使い、構成ごとに別の DO を使う。 */
  shards: number;
  concurrency: number;
  durationMs: number;
  tenants: number;
  from?: number;
  to?: number;
  target?: string;
  times?: number;
  /**
   * 一定レートの負荷 (open loop)。指定するとこの invocation は毎秒この回数を、応答を待たずに発行する。
   * 応答が返ると次を送る負荷 (closed loop) は、台数が増えて速くなると負荷も増えるので、増設が止まるかを測れない。
   */
  ratePerSec?: number;
  /** open loop で同時に待てる要求の上限。超えた分は発行せずに数える (飽和の印)。 */
  maxInflight?: number;
}

const benchCache = new Map<string, { at: number; catalog: Catalog }>();
async function benchCatalog(cluster: Cluster, name: string): Promise<Catalog> {
  const hit = benchCache.get(name);
  if (hit && Date.now() - hit.at < 2000) return hit.catalog;
  const catalog = await cluster.catalog();
  benchCache.set(name, { at: Date.now(), catalog });
  return catalog;
}

async function runBench(env: BenchEnv, b: BenchReq, request: Request): Promise<unknown> {
  const prefix = b.cluster ?? `b${b.shards}`;
  const cluster = clusterOf(env as unknown as Env, b.shards, prefix);
  const catalog = await benchCatalog(cluster, prefix);
  const db = () => new Db(cluster, { catalog });
  const tenant = () => 1 + Math.floor(Math.random() * b.tenants);
  const shardIds = shardsOf(catalog.routing);
  const raw = () => env.DINF_SHARD.getByName(shardIds[Math.floor(Math.random() * shardIds.length)]!);
  const colo = (request as unknown as { cf?: { colo?: string } }).cf?.colo;

  if (b.op === "seed") {
    let done = 0;
    for (let t = b.from!; t <= b.to!; t++) {
      await db().query("INSERT INTO bench(tenant_id,id,n) VALUES (?,1,0)", [t]);
      done++;
    }
    return { done };
  }
  if (b.op === "verify") {
    const r = await new Db(cluster, { catalog: await cluster.catalog() }).query("/*+ SCATTER */ SELECT count(*) c, sum(n) s FROM bench");
    return { count: r.rows[0]!.c, sum: r.rows[0]!.s };
  }
  if (b.op === "seedBulk") {
    // グループあたり rows 行、1 行約 1 KB の表を作る。移動速度の計測に使う。
    const ids = JSON.stringify(Array.from({ length: b.times ?? 400 }, (_, i) => i));
    for (let t = b.from!; t <= b.to!; t++) {
      await db().query(
        "INSERT INTO bulk(tenant_id, id, v) SELECT ?, value, hex(randomblob(500)) FROM json_each(?)",
        [t, ids],
      );
    }
    return { done: true };
  }
  if (b.op === "sync") return { samples: await env.DINF_SHARD.getByName(`${prefix}-0`).syncProbe(b.times ?? 30), colo };
  if (b.op === "peer") {
    return { samples: await env.DINF_SHARD.getByName(`${prefix}-0`).peerProbe(`${prefix}-1`, b.times ?? 30), colo };
  }
  if (b.op === "fanout") {
    // 1 invocation から N 個の DO へ同時に投げて、全部返るまでの時間を測る。
    const samples: number[] = [];
    for (let i = 0; i < (b.times ?? 20); i++) {
      const t0 = Date.now();
      await Promise.all(shardIds.slice(0, b.concurrency).map((id) => env.DINF_SHARD.getByName(id).ping()));
      samples.push(Date.now() - t0);
    }
    return { samples, colo };
  }
  if (b.op === "jepsen") {
    return runListAppend(() => new Db(cluster, { catalog }), {
      lanes: b.concurrency, until: Date.now() + b.durationMs, epochMs: b.epochMs, keysPerEpoch: b.keysPerEpoch,
    });
  }
  if (b.op === "jepsenFinal") {
    // 障害を止めた後に全キーを読む。確定した追記の消失を検査するためである。
    const out: Record<string, string[]> = {};
    const fresh = new Db(cluster, { catalog: await cluster.catalog() });
    for (const k of b.keys ?? []) {
      const v = (await fresh.query("SELECT v FROM jep WHERE k = ? AND id = 1", [k])).rows[0]?.v as string | undefined;
      out[k] = v ? v.split(",") : [];
    }
    return { finalReads: out };
  }
  if (b.op === "compound") return env.DINF_SHARD.getByName(b.target!).compoundLimit();
  if (b.op === "redrive") return env.DINF_SHARD.getByName(b.target!).redriveNow();
  if (b.op === "info") {
    const out: Record<string, unknown> = {};
    for (const id of shardsOf((await cluster.catalog()).routing)) out[id] = await env.DINF_SHARD.getByName(id).info();
    return out;
  }
  if (b.op === "crash") {
    // 呼び出し自体は abort で失敗するので、失敗を成功として扱う。
    await env.DINF_SHARD.getByName(b.target!).crash().catch(() => {});
    return { crashed: b.target };
  }
  if (b.op === "clock") {
    const samples: { id: string; offset: number; rtt: number }[] = [];
    for (const id of shardIds) {
      const t0 = Date.now();
      const remote = await env.DINF_SHARD.getByName(id).ping();
      const t1 = Date.now();
      samples.push({ id, offset: remote - (t0 + t1) / 2, rtt: t1 - t0 });
    }
    return { samples, colo };
  }

  const ops: Record<string, () => Promise<unknown>> = {
    ping: () => raw().ping(),
    rawRead: () => raw().rawRead(Math.floor(Math.random() * 1000)),
    rawWrite: () => raw().rawWrite(Math.floor(Math.random() * 1000)),
    read: () => db().query("SELECT n FROM bench WHERE tenant_id = ? AND id = 1", [tenant()]),
    write: () => db().query("UPDATE bench SET n = n + 1 WHERE tenant_id = ? AND id = 1", [tenant()]),
    hot: () => db().query("UPDATE bench SET n = n + 1 WHERE tenant_id = 1 AND id = 1"),
    txn1: () => db().transaction(async (tx) => {
      const t = tenant();
      await tx.query("SELECT n FROM bench WHERE tenant_id = ? AND id = 1", [t]);
      await tx.query("UPDATE bench SET n = n + 1 WHERE tenant_id = ? AND id = 1", [t]);
    }),
    txn2: () => db().transaction(async (tx) => {
      const a = tenant();
      let c = tenant();
      while (c === a) c = tenant();
      await tx.query("UPDATE bench SET n = n - 1 WHERE tenant_id = ? AND id = 1", [a]);
      await tx.query("UPDATE bench SET n = n + 1 WHERE tenant_id = ? AND id = 1", [c]);
    }),
  };
  const op = ops[b.op];
  if (!op) throw new Error(`unknown op ${b.op}`);

  const buckets: Record<string, number> = {};
  const failures: Record<string, number> = {};
  let count = 0;
  const start = Date.now();
  const deadline = start + b.durationMs;
  const once = async () => {
    const t0 = Date.now();
    try {
      await op();
      const ms = Date.now() - t0;
      count++;
      buckets[ms] = (buckets[ms] ?? 0) + 1;
    } catch (e) {
      const m = (e instanceof Error ? e.message : String(e)).slice(0, 80);
      failures[m] = (failures[m] ?? 0) + 1;
    }
  };
  if (b.ratePerSec) {
    const interval = 1000 / b.ratePerSec;
    const cap = b.maxInflight ?? 64;
    const inflight = new Set<Promise<void>>();
    let skipped = 0;
    for (let i = 0; ; i++) {
      const at = start + i * interval;
      if (at >= deadline) break;
      const wait = at - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      if (inflight.size >= cap) {
        skipped++;
        continue;
      }
      const p: Promise<void> = once().finally(() => inflight.delete(p));
      inflight.add(p);
    }
    await Promise.all(inflight);
    return { count, buckets, failures, skipped, colo };
  }
  await Promise.all(Array.from({ length: b.concurrency }, async () => {
    while (Date.now() < deadline) await once();
  }));
  return { count, buckets, failures, colo };
}

export default {
  async fetch(request: Request, env: BenchEnv): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/bench") {
      const token = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? null;
      if (!authorized(env as unknown as Env, "admin", token)) return new Response("unauthorized", { status: 401 });
      try {
        return Response.json(await runBench(env, (await request.json()) as BenchReq, request));
      } catch (e) {
        return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
      }
    }
    // 負荷によらず一定の周期で判断させる入口。本番は Cron Trigger で動かすので、計測用の構成にだけ置く。
    if (path === "/admin/autoscale/start" || path === "/admin/autoscale/stop") {
      const token = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? null;
      if (!authorized(env as unknown as Env, "admin", token)) return new Response("unauthorized", { status: 401 });
      try {
        const b = (await request.json()) as { cluster?: string; shards?: number; tickMs?: number; thresholds?: Partial<Thresholds> };
        const cluster = b.cluster ?? "shard";
        const scaler = env.DINF_AUTOSCALER.getByName(cluster);
        if (path.endsWith("/start")) await scaler.start({ cluster, initial: b.shards ?? 8, tickMs: b.tickMs ?? 5000, thresholds: b.thresholds, mode: "split" });
        else await scaler.stop();
        return Response.json({ ok: true });
      } catch (e) {
        return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
      }
    }
    return handle(request, env as unknown as Env);
  },
};
