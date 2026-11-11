// 本番の黒箱検査と同じ負荷 (src/listappend.ts) と検査器 (bench/elle.mjs) を、シミュレータの上で回す。
// 欠陥スイッチを入れた実装で異常を検出できることで、本番での合格に意味があることを確かめる。
import { expectQuiescent } from "./invariants";
import { describe, expect, it } from "vitest";
// @ts-expect-error -- JavaScript のモジュール
import { check } from "../bench/elle.mjs";
import { split } from "../src/autoscaler";
import { runListAppend } from "../src/listappend";
import { planSplit, shardsOf } from "../src/routing";
import type { Faults } from "../src/types";
import { REFERENCE_ONLY, seedsOr, SimCluster } from "./sim";

function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

async function run(seed: number, o: { faults?: Faults; restarts?: boolean; splits?: boolean; skewMs?: number; ops?: number } = {}) {
  const rnd = prng(seed);
  const skew = new Map<string, number>();
  const c = new SimCluster({
    shards: 4, faults: o.faults, seed,
    skewMs: (id) => {
      if (!skew.has(id)) skew.set(id, Math.floor(rnd() * (o.skewMs ?? 0)));
      return skew.get(id)!;
    },
  });
  c.net.jitter = () => (rnd() < 0.5 ? 0 : rnd() * 3);
  await c.client().ddl("CREATE TABLE jep(k INTEGER NOT NULL, id INTEGER NOT NULL, v TEXT NOT NULL, PRIMARY KEY (k, id)) SHARD KEY (k)");
  let stop = false;
  const chaos = (async () => {
    while (!stop && o.restarts) {
      await c.sleep(15);
      c.restart(c.shardIds[Math.floor(rnd() * c.shardIds.length)]!);
      await Promise.all([...c.cores.values()].map((core) => core.redrive().catch(() => {})));
    }
  })();
  const grower = (async () => {
    let next = c.shardIds.length;
    while (!stop && o.splits) {
      await c.sleep(30);
      const { routing } = await c.catalog();
      const list = shardsOf(routing);
      const parent = list[Math.floor(rnd() * list.length)]!;
      const range = planSplit(routing, parent);
      if (!range) continue;
      const child = `s${next++}`;
      for (let attempt = 0; attempt < 50; attempt++) {
        try {
          await split(c, parent, child, { range });
          break;
        } catch (e) {
          if (!/fenced|dropped/.test(String(e))) throw e;
          await c.sleep(2);
        }
      }
    }
  })();
  const out = await runListAppend(() => c.client(), {
    lanes: 6, ops: o.ops ?? 25, rnd, now: () => c.time, epochMs: 3_600_000, keysPerEpoch: 6, tag: `s${seed}`,
  });
  stop = true;
  await chaos;
  await grower;
  await c.settle();
  for (const core of c.cores.values()) await core.redrive();
  await c.settle();
  if (!o.faults) await expectQuiescent(c);
  const keys = [...new Set(out.history.flatMap((t) => t.ops.map((op) => op[1])))];
  const finalReads: Record<string, string[]> = {};
  for (const k of keys) {
    const v = (await c.client().query("SELECT v FROM jep WHERE k = ? AND id = 1", [k])).rows[0]?.v as string | undefined;
    finalReads[String(k)] = v ? v.split(",") : [];
  }
  return check(out.history, { finalReads }) as { valid: boolean; anomalies: Record<string, unknown>; stats: Record<string, number> };
}

describe("black-box list-append check on the simulator", () => {
  for (const seed of seedsOr([1, 2, 3])) {
    it(`passes with clock skew, restarts and splits (seed ${seed})`, async () => {
      const r = await run(seed, { restarts: true, splits: true, skewMs: 40 });
      expect(r.anomalies).toEqual({});
      expect(r.stats.ok).toBeGreaterThan(60);
    }, 60000);
  }
});

// 欠陥を戻して、検査が気付くことを確かめる。欠陥は最適化の経路の上で現れるものなので、基準経路だけの実行では流さない。
describe.skipIf(REFERENCE_ONLY)("the black-box check is not vacuous", () => {
  // 実行は実時間のタイマーで進むので、同じ seed でも毎回同じ履歴にはならない。
  // 12 個では約 1 割の実行でどの seed にも異常が出ず、テストが落ちた。見つかった時点で打ち切る。
  const detects = async (faults: Faults) => {
    for (let seed = 100; seed < 148; seed++) {
      const r = await run(seed, { faults, skewMs: 40, ops: 30 });
      if (!r.valid) return Object.keys(r.anomalies);
    }
    return [];
  };
  it("detects a reader that passes pending intents", async () => {
    expect((await detects({ readerTimeoutPass: true })).length).toBeGreaterThan(0);
  }, 120000);
  it("detects validation that ignores intents", async () => {
    expect((await detects({ ignoreIntentsInValidation: true })).length).toBeGreaterThan(0);
  }, 120000);
  it("detects a refresh that does not advance the clock", async () => {
    expect((await detects({ refreshNoBump: true })).length).toBeGreaterThan(0);
  }, 120000);
});
