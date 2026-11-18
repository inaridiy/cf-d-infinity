// 生成器 3 (docs/design-refresh-across-move.md の「乱択の検査に足す生成器」)。変更ログの切り詰めと、移動の前の T の古い読み。
//
// 範囲の移動の後に、pull に乗った intent の phase 2 を遅らせ、持ち主 (子) が、受け持ち始める前の c で確定を適用する (残した版。M23d)。
// それから子の変更ログの世代を切り詰め (保持の時間 logRetainMs と世代の長さ logGenMs を短くし、子の範囲へ書く)、移動の前の T で読む。
// 古い読みができる間 (T が子の logLowWater 以上の間) に切り詰めが起きる実行と、起きない実行と、T が保持の窓から外れる実行を混ぜる。
//
// 1 つの実行の形は、seed で決まる。
//   - 2 つか 3 つのシャード。s0 の範囲の全体か一部を、新しいシャードへ動かす。
//   - 取引 Y (1 つから 3 つ) が、動く行と、ほかのシャードの行を書いて確定する。s0 への phase 2 は、移動が終わるまで止める。Y の anchor は
//     ほかのシャードにする (書かずに読んだ範囲の多い参加者)。intent は範囲と一緒に子へ行き、phase 2 は親から子へ転送される。
//   - 読む取引 X は、Y の確定の後の T を、別の表を読んで決める。
//   - 移動と phase 2 の後に、時計を進め、子の範囲の別の行を書いて、子の変更ログの世代を切り替える。
//   - X は、T のまま、Y の書いた行を主キーで読むか、全表を読む。
// 判定は、T の時点の表である (各行の、T 以下で最後に確定した値)。書き込みはどれも取引で行い、確定の時刻を覚えて、期待する値を作る
// (変更ログは切り詰められるので、ログからは作らない)。答えたなら一致しなければならない。断るのは許す (read too old、conflict、
// not owner、migrating)。foundation-4 (517b674) のコードは、子が、範囲の床より前の T を断る。
//
// 危険な形 (reached) は、X の T が子の到着の m より前で、子が、m より小さい c の Y を、移動の後に適用し、子の logLowWater がその c を
// 超え、なお T 以下である実行である。答えたか断ったかを数え、最後の試験が 1 行で出す。
import { afterAll, describe, expect, it } from "vitest";
import { split } from "../src/autoscaler";
import { Db } from "../src/client/db";
import { keyString } from "../src/keys";
import { hashKey, ownerOf, regionsOf, SUBSLOTS, tokenOf, type Interval } from "../src/routing";
import type { Faults, Ts } from "../src/types";
import { prng, seedsOr, SimCluster } from "./sim";

const REFUSED = /^(read too old|conflict|not owner|migrating)/;
const key = (id: number) => keyString([BigInt(id)]);
const token = (id: number) => tokenOf(key(id), key(id));

export interface TruncationRun {
  /**
   * 読みが、決めた T のまま答えたか、T を進めて答えたか (X の読んだ u が変わっていなければ、取引は `moved at` で T を進めて読める。
   * Txn.call)、断られたか。
   */
  outcome: "answered at its T" | "answered at a later T" | `refused: ${string}`;
  /** 答えと T の時点の表の違い。空なら一致した。 */
  wrong: string[];
  /** 危険な形に届いたか (上の説明)。決めた T のまま答えた読みだけを数える。 */
  reached: boolean;
  shape: string;
}

/** 区間 x の、slot の境目に揃った後ろ半分か、全体。 */
function movingRange(rnd: () => number, x: Interval): Interval {
  if (rnd() < 0.5) return x;
  const cut = Math.floor((x.start + x.end) / 2 / SUBSLOTS) * SUBSLOTS;
  return { start: cut, end: x.end };
}

export async function oldReadAfterTruncation(seed: number, faults?: Faults): Promise<TruncationRun> {
  const rnd = prng(seed * 7919 + 101);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const shards = 2 + Math.floor(rnd() * 2);
  const logGenMs = 10 + Math.floor(rnd() * 30);
  const logRetainMs = logGenMs * (3 + Math.floor(rnd() * 4));
  const c = new SimCluster({ shards, seed, faults, logGenMs, logRetainMs });
  const admin = new Db(c);
  await admin.ddl("CREATE TABLE items(id INTEGER PRIMARY KEY, n INTEGER NOT NULL)");
  await admin.ddl("CREATE TABLE u(id INTEGER PRIMARY KEY)");
  await admin.query("INSERT INTO u VALUES (1)");
  const { routing } = await c.catalog();
  const P = "s0";
  const range = movingRange(rnd, regionsOf(routing, P)[0]!);
  const inRange = (id: number) => token(id) >= range.start && token(id) < range.end;
  const ids = Array.from({ length: 4000 }, (_v, i) => i + 1);
  const moving = ids.filter(inRange).slice(0, 8);
  const others = ids.filter((id) => ownerOf(routing, key(id)) !== P).slice(0, 8);
  const all = [...moving, ...others];
  await admin.query(`INSERT INTO items VALUES ${all.map((id) => `(${id}, 1)`).join(", ")}`);
  /** 行ごとの、確定した版 (確定の時刻と値)。初めの行は、どの T よりも前である。 */
  const versions = new Map<number, { ts: Ts; v: number }[]>(all.map((id) => [id, [{ ts: 0, v: 1 }]]));
  const shape: string[] = [`shards ${shards}, gen ${logGenMs} ms, retain ${logRetainMs} ms, move [${range.start}, ${range.end})`];

  // s0 への phase 2 を止める。
  let releasePhase2!: () => void;
  const phase2 = new Promise<void>((r) => (releasePhase2 = r));
  let holding = true;
  c.net.gate = (m) => (holding && m.method === "finalize" && m.to === P ? phase2 : undefined);
  const writer = new Db(c);
  const ys: { txn: string; c: Ts }[] = [];
  const count = 1 + Math.floor(rnd() * 3);
  for (let j = 0; j < count; j++) {
    const z = pick(moving);
    const y = pick(others);
    const w = pick(others.filter((x) => x !== y));
    const q = ownerOf(routing, key(y));
    // anchor を q にする。取引の ID の指紋で決まる並びも q が勝つまで始め直す (未保護の範囲の数は q が 1、s0 が 0)。
    let ty = await writer.begin();
    const id = (t: unknown) => (t as { id: string }).id;
    for (let k = 0; k < 20 && hashKey(id(ty) + q) > hashKey(id(ty) + P); k++) ty = await writer.begin();
    const v = 10 * (j + 1) + Math.floor(rnd() * 9);
    try {
      if (ownerOf(routing, key(w)) === q) await ty.query("SELECT n FROM items WHERE id = ?", [BigInt(w)]);
      await ty.query("UPDATE items SET n = ? WHERE id = ?", [BigInt(v), BigInt(z)]);
      await ty.query("UPDATE items SET n = ? WHERE id = ?", [BigInt(v), BigInt(y)]);
      await ty.commit();
    } catch (e) {
      shape.push(`Y${j} failed: ${(e as Error).message.slice(0, 40)}`);
      continue;
    }
    ys.push({ txn: id(ty), c: ty.commitTs! });
    for (const x of [z, y]) versions.get(x)!.push({ ts: ty.commitTs!, v });
    shape.push(`Y${j} writes ${z} and ${y} = ${v} at ${ty.commitTs}`);
  }

  // X: Y の確定の後の T を、別の表を読んで決める。
  c.time += Math.floor(rnd() * 30);
  const x = new Db(c, { retries: 0 });
  await x.query("BEGIN");
  await x.query("SELECT id FROM u");
  const T = x.dump().tx!.T!;
  // 半分の実行では、別の接続が u を書く。X は、読んだ u が変わったので T を進められず、T のまま読み続ける (古い読み)。
  const pinned = rnd() < 0.5;
  if (pinned) await writer.query("INSERT INTO u VALUES (2)");
  c.time += Math.floor(rnd() * 30);
  const child = `s${shards}`;
  await split(c, P, child, { range });
  const carried = ys.filter((y) => c.backends.get(child)!.exec("SELECT 1 FROM __intents WHERE txn LIKE ?", `${y.txn}%`).length > 0);
  // phase 2 を通し、子が Y を適用するのを待つ。
  holding = false;
  releasePhase2();
  for (let i = 0; i < 400 && c.backends.get(child)!.exec("SELECT txn FROM __intents").length > 0; i++) await c.sleep(5);
  // 子の変更ログの世代を切り替える。子の範囲の、X が読まない行を、時計を進めながら書く。
  const filler = ids.filter((id) => inRange(id) && !moving.includes(id)).slice(0, 3);
  const steps = Math.floor(rnd() * 5);
  for (let i = 0; i < steps; i++) {
    c.time += Math.floor(rnd() * logGenMs * 2);
    const id = pick(filler);
    const t = await writer.begin();
    try {
      await t.query("INSERT INTO items VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET n = excluded.n", [BigInt(id), BigInt(100 + i)]);
      await t.commit();
      versions.set(id, [...(versions.get(id) ?? []), { ts: t.commitTs!, v: 100 + i }]);
    } catch (e) {
      shape.push(`filler failed: ${(e as Error).message.slice(0, 40)}`);
    }
  }
  for (let i = 0; i < 400 && c.backends.get(child)!.exec("SELECT txn FROM __intents").length > 0; i++) await c.sleep(1);
  const low = (c.backends.get(child)!.exec("SELECT v FROM __meta WHERE k = 'log_low_water'")[0]?.v as number | undefined) ?? 0;
  const m = (c.backends.get(child)!.exec("SELECT m FROM __incoming ORDER BY epoch DESC LIMIT 1")[0]?.m as number | undefined) ?? 0;
  const shapeReached = T < m && T >= low && carried.some((y) => y.c < m && low > y.c);
  shape.push(`T ${T}${pinned ? " (pinned)" : ""}, child ${child} m ${m}, logLowWater ${low}, carried ${carried.length} of ${ys.length}`);

  // X は T のまま読む。主キーで Y の行を読むか、全表を読む。
  const wide = rnd() < 0.4;
  const asked = wide ? [...versions.keys()].sort((a, b) => a - b) : [...new Set([...moving, ...others].filter(() => rnd() < 0.5))].sort((a, b) => a - b);
  // 行の、時刻 t の値。答えは、その答えが運ぶ時刻 (QueryResult.ts。T を進めたなら進めた T) の表と比べる。
  const at = (id: number, t: Ts) => [...(versions.get(id) ?? [])].filter((v) => v.ts <= t).sort((a, b) => a.ts - b.ts).at(-1)?.v;
  const wrong: string[] = [];
  let outcome: TruncationRun["outcome"] = "answered at its T";
  const answeredAt = (q: { ts?: Ts }) => {
    const t = q.ts ?? T;
    if (t !== T) outcome = "answered at a later T";
    return t;
  };
  try {
    if (wide) {
      const q = await x.query("SELECT id, n FROM items ORDER BY id");
      const t = answeredAt(q);
      const rows = new Map(q.rows.map((r) => [Number(r.id), Number(r.n)]));
      for (const id of new Set([...asked, ...rows.keys()])) {
        if (rows.get(id) !== at(id, t)) wrong.push(`read row ${id} = ${rows.get(id) ?? "no row"} at T ${t} in the whole-table read, the table had ${at(id, t) ?? "no row"}`);
      }
    } else {
      for (const id of asked) {
        const q = await x.query("SELECT n FROM items WHERE id = ?", [BigInt(id)]);
        const t = answeredAt(q);
        const got = q.rows[0]?.n;
        if (Number(got) !== at(id, t)) wrong.push(`read row ${id} = ${got} at T ${t}, the table had ${at(id, t)}`);
      }
    }
    await x.query("COMMIT");
  } catch (e) {
    const msg = (e as Error).message;
    if (!REFUSED.test(msg)) wrong.push(`unexpected error: ${msg}`);
    outcome = `refused: ${msg.replace(/\d+/g, "#").slice(0, 40)}`;
    await x.query("ROLLBACK").catch(() => undefined);
  }
  c.net.gate = () => undefined;
  await c.settle();
  return { outcome, wrong: wrong.slice(0, 5), reached: shapeReached && (outcome as string) !== "answered at a later T", shape: shape.join(" | ") };
}

describe("an old read across a move, after the new owner applied a carried intent below its start and truncated its log (generator 3)", () => {
  const tally = new Map<string, number>();
  afterAll(() => {
    if (tally.size > 0) console.info(`generator 3: ${[...tally].map(([k, n]) => `${k} x${n}`).join(", ")}`);
  });
  const defaults = Array.from({ length: 16 }, (_v, i) => i + 1);
  const runs = new Map<number, Promise<TruncationRun>>();
  const once = (seed: number) => {
    if (!runs.has(seed)) runs.set(seed, oldReadAfterTruncation(seed));
    return runs.get(seed)!;
  };
  for (const seed of seedsOr(defaults)) {
    it(`answers the table at its T or refuses (seed ${seed})`, async () => {
      const r = await once(seed);
      const k = `${r.reached ? "reached" : "not reached"}, ${r.outcome}`;
      tally.set(k, (tally.get(k) ?? 0) + 1);
      expect(r.wrong, r.shape).toEqual([]);
    });
  }
  // 検査が何も確かめていない実行にならないこと。既定の seed のうち、危険な形に届く実行がある。
  it("reaches a read below the new owner's start, after it truncated a version it applied below its start", async () => {
    const all = await Promise.all(defaults.map(once));
    expect(all.filter((r) => r.reached).length).toBeGreaterThan(0);
  });
});
