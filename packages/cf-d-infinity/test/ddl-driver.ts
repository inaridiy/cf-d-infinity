// 表定義の変更を進める側 (DDL を出した Worker の 1 回の呼び出し) を、どの手の前でも止められるようにする仕掛け
// (test/ddl-driver-stops.test.ts)。分割の test/split-slot.test.ts と同じ形である。
//
// 手は、止めずに 1 回流したときに、進める側が Meta とシャードへ送った呼び出しの列から取る。手の名前と数は実装で変わる (段 3 で DDL が
// 2 相になった) ので、名前ではなく、列の番号で止める。表定義を読む呼び出し (catalog) は手に数えない。止めた後は、その呼び出しも、
// それより後の呼び出しも (期限を延ばすタイマーの呼び出しも)、全部が失敗する。
import { expect } from "vitest";
import { Db, type Cluster } from "../src/client/db";
import { ownerOf, shardsOf } from "../src/routing";
import type { ShardApi } from "../src/types";
import { SimCluster } from "./sim";

export const outcome = (p: Promise<unknown>) => p.then(() => "ok", (e: Error) => e.message);

/** 進める側の Cluster。呼び出しを順に記録し、stopAt 番目の手 (catalog を除いた呼び出しの番号、0 から) で止まる。 */
export function driver(c: SimCluster, stopAt: number | null): { cluster: Cluster; calls: string[] } {
  const calls: string[] = [];
  let stopped = false;
  const step = (name: string): boolean => {
    if (stopped) return false;
    if (name === "catalog") return true;
    if (stopAt !== null && calls.length === stopAt) {
      stopped = true;
      return false;
    }
    calls.push(name);
    return true;
  };
  const refuse = (name: string) => Promise.reject(new Error(`driver stopped before ${name}`));
  const cluster = new Proxy(c as unknown as Cluster, {
    get(target, prop, receiver) {
      if (prop === "shard") {
        return (id: string) => new Proxy({} as ShardApi, {
          get: (_t, method: keyof ShardApi) => (req: never) => {
            const name = `${id}.${String(method)}`;
            return step(name) ? (c.shard(id)[method] as (r: never) => Promise<unknown>)(req) : refuse(name);
          },
        });
      }
      const v = Reflect.get(target, prop, receiver) as unknown;
      if (typeof v !== "function") return v;
      return (...args: unknown[]) => (step(String(prop)) ? (v as (...a: unknown[]) => unknown).apply(target, args) : refuse(String(prop)));
    },
  });
  return { cluster, calls };
}

/** 2 シャードの表 p。tenant_id が shard key で、bad は s0 の、good は s1 の tenant である。 */
export async function twoShards(): Promise<{ c: SimCluster; db: Db; bad: number; good: number }> {
  const c = new SimCluster({ shards: 2 });
  const db = new Db(c);
  await db.ddl("CREATE TABLE p(tenant_id INTEGER NOT NULL, id INTEGER NOT NULL, code TEXT, gone INTEGER, PRIMARY KEY (tenant_id, id))");
  const { routing } = await c.catalog();
  const tenants = Array.from({ length: 40 }, (_, i) => i + 1);
  const on = (shard: string) => tenants.find((t) => ownerOf(routing, JSON.stringify([t])) === shard)!;
  return { c, db, bad: on("s0"), good: on("s1") };
}

/** 全シャードに最新の表定義を適用させ、適用できたかと、適用の失敗の報告 (health の schemaError) を返す。 */
export async function settled(c: SimCluster): Promise<{ applied: string[]; errors: (string | null)[] }> {
  const cat = await c.catalog();
  const ids = shardsOf(cat.routing);
  const applied = await Promise.all(ids.map((id) => outcome(c.shard(id).syncSchema({ schema: cat.schema }))));
  const health = await Promise.all(ids.map((id) => c.shard(id).health({})));
  return { applied, errors: health.map((h) => h.schemaError ?? null) };
}

export interface Scenario {
  name: string;
  /** 場面を作る。run は、進める側が出す文である。check は、止まった後に別の接続から確かめ、expected に渡す答えを返す。 */
  setup(): Promise<{ c: SimCluster; run(db: Db): Promise<unknown>; check(c: SimCluster): Promise<Record<string, unknown>> }>;
  /** check の答えが正しいことを確かめる。 */
  expected(r: Record<string, unknown>): Record<string, unknown>;
}

/**
 * 場面を、進める側の手ごとに、その手の前で止めて流す。止まった後で、
 *   1. 文は、効いたか、効かなかったかのどちらかである (場面の expected)。
 *   2. 対象の表へ書ける。書き込みの禁止は、期限 (5 秒) と待つ側の間隔のうちに解ける。
 *   3. 別の表定義の変更が通る。
 *   4. 全シャードが最新の表定義を適用でき、どのシャードも適用の失敗を報告していない。
 * 手ごとの食い違いは、全部を集めてから落とす (expect.soft)。
 */
export async function stopsEverywhere(s: Scenario): Promise<string[]> {
  const dry = await s.setup();
  const free = driver(dry.c, null);
  const whole = await outcome(dry.run(new Db(free.cluster)));
  const steps = free.calls;
  if (process.env.SHOW_STEPS) console.log(`${s.name}: ${whole}\n  ${steps.join(" ")}`);
  expect(steps.length).toBeGreaterThan(1);
  for (let i = 0; i < steps.length; i++) {
    const at = { i, step: steps[i] };
    const { c, run, check } = await s.setup();
    const d = driver(c, i);
    const ran = await outcome(run(new Db(d.cluster)));
    // 止めた手まで、止めずに流したときと同じ列である (シミュレータは決定的)。
    expect({ ...at, calls: d.calls }).toEqual({ ...at, calls: steps.slice(0, i) });
    // 止めた手の失敗が、文の答えになる。答えに効かない手 (書き込みの禁止を早く解くための、最後の適用の依頼) なら、止めずに流したときの
    // 答えのままである。
    expect({ ...at, ran: /driver stopped before/.test(ran) ? "stopped" : ran }).toEqual({ ...at, ran: expect.toBeOneOf(["stopped", whole]) });
    const t0 = c.time;
    const r = await check(c);
    expect.soft({ ...at, ...r }).toEqual({ ...at, ...s.expected(r) });
    expect.soft({ ...at, waited: c.time - t0 < 15_000 }).toEqual({ ...at, waited: true });
    expect.soft({ ...at, other: await outcome(new Db(c).ddl("CREATE TABLE other(id INTEGER PRIMARY KEY)")) }).toEqual({ ...at, other: "ok" });
    const st = await settled(c);
    expect.soft({ ...at, ...st }).toEqual({ ...at, applied: st.applied.map(() => "ok"), errors: st.errors.map(() => null) });
  }
  return steps;
}
