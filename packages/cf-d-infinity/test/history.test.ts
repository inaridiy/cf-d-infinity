import { writeFileSync } from "node:fs";
import { expectQuiescent } from "./invariants";
import { describe, expect, it } from "vitest";
import { REFERENCE_ONLY, seedsOr, SimCluster, USERS } from "./sim";
import { checkHistory, type Read, type TxRecord } from "./history";
import { SqlError, type Faults } from "../src/types";
import type { Txn } from "../src/client/db";
import { split } from "../src/autoscaler";
import { planSplit, shardsOf } from "../src/routing";

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

const TENANTS = 6;
const IDS = 3;

interface RunOpts {
  seed: number;
  clients?: number;
  ops?: number;
  skewMs?: number;
  restarts?: boolean;
  /** 実行中にシャードを増やす。 */
  splits?: boolean;
  /** 悲観的な取引で流す。 */
  pessimistic?: boolean;
  faults?: Faults;
}

/**
 * 範囲の移動で時計を渡さない欠陥 (finishWithoutClock) を、行ロック、分割、再起動の掛け合わせが見つける seed。
 * 見つける割合は低い。2026-11-11 に分割が保守の操作の枠を取るようにした後は、seed 1 から 1000 のうち 958 だけだった
 * (その前は 400 のうち 2 つ)。欠陥そのものの決定的な再現は test/move-timestamp.test.ts にある。
 */
const PUT_BACK_SEEDS = [958];

/**
 * 実行が終わらないと見なす上限。仮想の時刻で 10 分、出来事 200 万個。欠陥を入れた実行は、要求を投げ合い続けて終わらないことがある。
 * 上限で、原因の分かる失敗にする (試験の制限時間は、出来事が途切れずに続くと効かないことがある)。
 */
const STALL_MS = 10 * 60_000;
const STALL_STEPS = 2_000_000;

async function run(o: RunOpts) {
  const rnd = prng(o.seed);
  const skew = new Map<string, number>();
  const c = new SimCluster({
    shards: 4,
    faults: o.faults,
    seed: o.seed,
    skewMs: (id) => {
      if (!skew.has(id)) skew.set(id, Math.floor(rnd() * (o.skewMs ?? 0)));
      return skew.get(id)!;
    },
  });
  c.net.jitter = () => (rnd() < 0.5 ? 0 : rnd() * 3);
  return Promise.race([body(o, c, rnd), c.stalled(STALL_MS, STALL_STEPS)]);
}

async function body(o: RunOpts, c: SimCluster, rnd: () => number) {
  const admin = c.client();
  await admin.ddl(USERS);

  const history: TxRecord[] = [];
  const pick = (n: number) => 1 + Math.floor(rnd() * n);
  const key = () => ({ t: pick(TENANTS), i: pick(IDS) });
  const k = (x: { t: number; i: number }) => `${x.t}/${x.i}`;
  let seq = 0;
  let unknown = 0;

  const readKey = async (tx: Txn, x: { t: number; i: number }, reads: Read[]) => {
    const r = await tx.query("SELECT n FROM users WHERE tenant_id = ? AND id = ?", [x.t, x.i]);
    const value = (r.rows[0]?.n as number | undefined) ?? null;
    reads.push({ key: k(x), value });
    return value;
  };
  const readTenant = async (tx: Txn, t: number, reads: Read[]) => {
    const r = await tx.query("SELECT count(*) c, coalesce(sum(n), 0) s FROM users WHERE tenant_id = ?", [t]);
    reads.push({ tenant: t, value: { count: r.rows[0]!.c, sum: r.rows[0]!.s } });
  };
  const put = async (tx: Txn, x: { t: number; i: number }, v: number, writes: TxRecord["writes"]) => {
    await tx.query("DELETE FROM users WHERE tenant_id = ? AND id = ?", [x.t, x.i]);
    await tx.query("INSERT INTO users(tenant_id, id, n) VALUES (?, ?, ?)", [x.t, x.i, v]);
    writes.push({ key: k(x), value: v });
  };

  const oneTxn = async (client: ReturnType<SimCluster["client"]>) => {
    const name = `w${seq++}`;
    const reads: Read[] = [];
    const writes: TxRecord["writes"] = [];
    const tx = await client.begin();
    if (o.pessimistic) {
      tx.pessimistic = true;
      tx.lockReads = true;
    }
    const kind = rnd();
    const v = seq * 10 + 1;
    if (kind < 0.25) {
      await readKey(tx, key(), reads);
      await readTenant(tx, pick(TENANTS), reads);
      await readKey(tx, key(), reads);
    } else if (kind < 0.5) {
      const x = key();
      await readKey(tx, x, reads);
      await put(tx, x, v, writes);
    } else if (kind < 0.75) {
      await readKey(tx, key(), reads);
      await readKey(tx, key(), reads);
      await put(tx, key(), v, writes);
    } else {
      const a = key();
      let b = key();
      while (k(b) === k(a)) b = key();
      await readTenant(tx, a.t, reads);
      await put(tx, a, v, writes);
      await put(tx, b, v + 1, writes);
    }
    try {
      await tx.commit();
    } catch (e) {
      await tx.unlockAll();
      throw e;
    }
    const ts = tx.commitTs ?? tx.T;
    if (ts === undefined) return;
    history.push({ name, ts, readOnly: writes.length === 0, reads, writes });
  };

  const worker = async () => {
    for (let i = 0; i < (o.ops ?? 40); i++) {
      try {
        // 取引ごとに別セッションにする。因果トークンが時計のずれを隠さないようにするためである。
        await oneTxn(c.client());
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        if (/^(conflict|read too old|not owner|migrating)/.test(m) || e instanceof SqlError && /UNIQUE/.test(m)) continue;
        if (/fenced|rpc dropped/.test(m)) {
          unknown++;
          continue;
        }
        throw e;
      }
    }
  };

  let stop = false;
  const chaos = (async () => {
    while (!stop && o.restarts) {
      await c.sleep(15);
      c.restart(c.shardIds[Math.floor(rnd() * c.shardIds.length)]!);
      await Promise.all([...c.cores.values()].map((core) => core.redrive().catch(() => {})));
    }
  })();
  let splits = 0;
  const grower = (async () => {
    let next = c.shardIds.length;
    while (!stop && o.splits) {
      await c.sleep(25);
      const { routing } = await c.catalog();
      const list = shardsOf(routing);
      const parent = list[Math.floor(rnd() * list.length)]!;
      const range = planSplit(routing, parent);
      if (!range) continue;
      const child = `s${next++}`;
      // 再起動で途中で失敗しても、同じ範囲で最初からやり直せる。
      for (let attempt = 0; attempt < 50; attempt++) {
        try {
          await split(c, parent, child, { range });
          splits++;
          break;
        } catch (e) {
          if (!/fenced|dropped/.test(String(e))) throw e;
          await c.sleep(2);
        }
      }
    }
  })();
  await Promise.all(Array.from({ length: o.clients ?? 6 }, worker));
  stop = true;
  await chaos;
  await grower;
  await c.settle();
  for (const core of c.cores.values()) await core.redrive();
  await c.settle();
  // 欠陥を入れていない実行では、後始末が済んでいることも確かめる。
  if (!o.faults) await expectQuiescent(c);
  // 失敗した seed を調べるための書き出し。SIM_DUMP=<ファイル> で、取引の記録と RPC の記録を JSON で残す。
  if (process.env.SIM_DUMP) {
    const plain = (_k: string, x: unknown) => (x instanceof Uint8Array ? [...x] : x);
    writeFileSync(process.env.SIM_DUMP, JSON.stringify({ seed: o.seed, history, rpc: c.net.log }, plain));
  }
  return { history, violations: checkHistory(history), unknown, c, splits };
}

describe("history checker on the real shard code", () => {
  for (const seed of seedsOr([1, 2, 3, 4, 5, 6])) {
    it(`stays serializable with clock skew (seed ${seed})`, async () => {
      const { history, violations } = await run({ seed, skewMs: 40 });
      expect(history.filter((h) => !h.readOnly).length).toBeGreaterThan(20);
      expect(violations.slice(0, 3)).toEqual([]);
    });
  }
  for (const seed of seedsOr([11, 12, 13, 14])) {
    it(`stays serializable with restarts (seed ${seed})`, async () => {
      const { history, violations, unknown } = await run({ seed, skewMs: 20, restarts: true });
      expect(history.length).toBeGreaterThan(20);
      expect(unknown).toBeGreaterThanOrEqual(0);
      expect(violations.slice(0, 3)).toEqual([]);
    });
  }
});

describe("history checker across live splits", () => {
  for (const seed of seedsOr([21, 22, 23, 24, 25, 26])) {
    it(`stays serializable while shards are added (seed ${seed})`, async () => {
      const { history, violations, splits } = await run({ seed, skewMs: 20, splits: true, ops: 60 });
      expect(splits).toBeGreaterThan(0);
      expect(history.filter((h) => !h.readOnly).length).toBeGreaterThan(20);
      expect(violations.slice(0, 3)).toEqual([]);
    });
  }
  for (const seed of seedsOr([31, 32, 33, 34])) {
    it(`stays serializable with splits and restarts together (seed ${seed})`, async () => {
      const { history, violations, splits } = await run({ seed, skewMs: 20, splits: true, restarts: true, ops: 60 });
      expect(splits).toBeGreaterThan(0);
      expect(history.length).toBeGreaterThan(20);
      expect(violations.slice(0, 3)).toEqual([]);
    });
  }
});

describe("history checker with pessimistic transactions", () => {
  for (const seed of seedsOr([41, 42, 43, 44, 45, 46])) {
    it(`stays serializable (seed ${seed})`, async () => {
      const { history, violations } = await run({ seed, skewMs: 20, pessimistic: true, ops: 25 });
      expect(history.filter((h) => !h.readOnly).length).toBeGreaterThan(10);
      expect(violations.slice(0, 3)).toEqual([]);
    }, 60000);
  }
  for (const seed of seedsOr([51, 52, 53, 54])) {
    it(`stays serializable with splits and restarts (seed ${seed})`, async () => {
      const { history, violations } = await run({ seed, skewMs: 20, pessimistic: true, splits: true, restarts: true, ops: 25 });
      expect(history.length).toBeGreaterThan(10);
      expect(violations.slice(0, 3)).toEqual([]);
    }, 60000);
  }
});

// 過去の欠陥を戻して、この検査が見つけることを確かめる。個別の再現テストではなく、乱択の作業負荷が見つける。
// どの seed が見つけるかは、コードが変わると変わる。下の seed で見つからなくなったら、SEEDS=1..400 で流して、通る seed に替える。
describe.skipIf(REFERENCE_ONLY)("a defect put back is found by the random workload", () => {
  for (const seed of seedsOr(PUT_BACK_SEEDS)) {
    it(`finds a range handed over without the old owner's clock (seed ${seed})`, async () => {
      const o = { seed, skewMs: 20, pessimistic: true, splits: true, restarts: true, ops: 25 };
      expect((await run({ ...o, faults: { finishWithoutClock: true } })).violations.length).toBeGreaterThan(0);
      expect((await run(o)).violations).toEqual([]);
    }, 60000);
  }
});

describe("the simulator is deterministic for this workload", () => {
  it("the same seed gives the same run, with clock skew, restarts and splits", async () => {
    const o = { seed: 31, skewMs: 20, splits: true, restarts: true, ops: 60 };
    const a = await run(o);
    const b = await run(o);
    expect(b.c.fingerprint()).toBe(a.c.fingerprint());
    expect(b.history.length).toBe(a.history.length);
  });
});

// 欠陥を戻して、検査が気付くことを確かめる。欠陥は最適化の経路の上で現れるものなので、基準経路だけの実行では流さない。
describe.skipIf(REFERENCE_ONLY)("the checker is not vacuous", () => {
  // 欠陥を入れた実装で異常を検出できなければ、上の合格は意味を持たない。
  const detects = async (faults: Faults, skewMs = 40) => {
    for (let seed = 100; seed < 112; seed++) {
      const { violations } = await run({ seed, faults, skewMs, ops: 30 });
      if (violations.length > 0) return true;
    }
    return false;
  };
  it("detects a reader that passes pending intents", async () => {
    expect(await detects({ readerTimeoutPass: true })).toBe(true);
  });
  it("detects validation that ignores intents", async () => {
    expect(await detects({ ignoreIntentsInValidation: true })).toBe(true);
  });
});
