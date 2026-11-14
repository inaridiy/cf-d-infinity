// 範囲表の検査 (docs/design-subslots.md の段 1)。
//
// 行の置き場所は token (region、slot、subslot を並べた 40 ビットの整数) になり、範囲表は token の区間をシャードに対応させる。
// slot は 4,096 個から 65,536 個に細かくなった。確かめるのは 3 つである。
//   1. 細かくしただけで、行の置き場所は変わっていない。前の slot 1 つは、いまの slot 16 個 (token 2^20 個) にちょうど当たる。
//      前の実装をここに写してあり、前の slot の境目に置いた乱択の移動の並びで、範囲表、持ち主、分割の計画を突き合わせる。
//   2. 区間の移動を乱択で重ねても (境目をブロックの中に置いても)、どの token にも持ち主がちょうど 1 つある。
//   3. 行の置き場所 (slot、subslot、token) の計算。保存の形式なので、値を固定してある。
import { describe, expect, it } from "vitest";
import { keyStringExact } from "../src/keys";
import {
  REGION_TOKENS, SLOTS, SUBSLOTS, TOKENS, applyMove, blockOf, checkInterval, hashKey, initialRouting, overlaps, ownerOf, ownersOf, planSplit,
  rangeText, regionsOf, shardsOf, slotAligned, slotOf, subslotOf, tokenOf, type Interval, type Routing,
} from "../src/routing";
import { prng, seedsOr } from "./sim";

// ---- token にする前の実装 (f8f0f67 の src/routing.ts)。slot は 4,096 個で、hash の上位 12 ビットだった ----

const OLD_SLOTS = 4096;
/** 前の slot 1 つに当たる token の数。 */
const OLD = REGION_TOKENS / OLD_SLOTS;
interface OldRange { start: number; end: number; shard: string }
interface OldRouting { version: number; ranges: OldRange[] }
const oldSlotOf = (sk: string): number => Math.floor((hashKey(sk) / 2 ** 32) * OLD_SLOTS);
const oldInitialRouting = (shards: string[]): OldRouting => ({
  version: 1,
  ranges: shards.map((shard, i) => ({
    start: Math.floor((i * OLD_SLOTS) / shards.length), end: Math.floor(((i + 1) * OLD_SLOTS) / shards.length), shard,
  })),
});
const oldOwnerOf = (r: OldRouting, sk: string): string => {
  const slot = oldSlotOf(sk);
  const hit = r.ranges.find((x) => slot >= x.start && slot < x.end);
  if (!hit) throw new Error(`slot ${slot} has no owner`);
  return hit.shard;
};
const oldRangesOf = (r: OldRouting, shard: string): [number, number][] =>
  r.ranges.filter((x) => x.shard === shard).map((x) => [x.start, x.end]);
function oldPlanSplit(r: OldRouting, parent: string): { start: number; end: number } | null {
  const mine = r.ranges.filter((x) => x.shard === parent).sort((a, b) => b.end - b.start - (a.end - a.start));
  const widest = mine[0];
  if (!widest || widest.end - widest.start < 2) return null;
  return { start: Math.floor((widest.start + widest.end) / 2), end: widest.end };
}
function oldApplyMove(r: OldRouting, move: { start: number; end: number; to: string }): OldRouting {
  const ranges = r.ranges.flatMap((x) => {
    if (x.end <= move.start || x.start >= move.end) return [x];
    const parts: OldRange[] = [];
    if (x.start < move.start) parts.push({ ...x, end: move.start });
    if (x.end > move.end) parts.push({ ...x, start: move.end });
    return parts;
  });
  ranges.push({ start: move.start, end: move.end, shard: move.to });
  return { version: r.version + 1, ranges: ranges.sort((a, b) => a.start - b.start) };
}
/** 前の範囲表を、token の範囲表に写す。 */
const scaled = (r: OldRouting): Routing => ({
  version: r.version, ranges: r.ranges.map((x) => ({ start: x.start * OLD, end: x.end * OLD, shard: x.shard })),
});

const int = (rand: () => number, lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo));

/** 範囲表が region 0 を、重なりも隙間もなく覆っていること。項目は始まりの順に並んでいる。 */
function expectPartition(r: Routing): void {
  const bad: string[] = [];
  let at = 0;
  for (const x of r.ranges) {
    if (!(Number.isInteger(x.start) && Number.isInteger(x.end) && x.start < x.end)) bad.push(`empty or broken: [${x.start}, ${x.end})`);
    if (x.start !== at) bad.push(`${x.start > at ? "gap" : "overlap"} at ${at}: the next entry starts at ${x.start}`);
    at = x.end;
  }
  if (at !== REGION_TOKENS) bad.push(`the table ends at ${at}, not at ${REGION_TOKENS}`);
  expect(bad).toEqual([]);
}

describe("row placement", () => {
  it("lays out a token as region, slot and subslot: the top 16 bits of the shard key's hash, the low 16 bits of the primary key's", () => {
    expect([SLOTS, SUBSLOTS, REGION_TOKENS, TOKENS]).toEqual([2 ** 16, 2 ** 16, 2 ** 32, 2 ** 40]);
    expect(Number.isSafeInteger(TOKENS)).toBe(true);
    for (const [sk, pk] of [[keyStringExact([1]), keyStringExact([1])], [keyStringExact(["a"]), keyStringExact(["a", 2])], [keyStringExact([7]), keyStringExact([7, "x"])], [keyStringExact([null]), ""]] as const) {
      expect(slotOf(sk)).toBe((hashKey(sk) >>> 16) * SUBSLOTS);
      expect(subslotOf(pk)).toBe(hashKey(pk) & 0xffff);
      expect(tokenOf(sk, pk)).toBe(slotOf(sk) + subslotOf(pk));
      // いまの行は、どれも region 0 に載る。
      expect(tokenOf(sk, pk)).toBeLessThan(REGION_TOKENS);
      expect(blockOf(sk)).toEqual({ start: slotOf(sk), end: slotOf(sk) + SUBSLOTS });
      expect(tokenOf(sk, pk) >= blockOf(sk).start && tokenOf(sk, pk) < blockOf(sk).end).toBe(true);
    }
  });

  // 保存の形式である。値が変わると、置いてある行の持ち主が変わる (docs/storage-format.md の「行の置き場所」)。
  it("keeps placing the same key at the same slot and subslot", () => {
    const at = (key: string) => [slotOf(key) / SUBSLOTS, subslotOf(key)];
    expect(at(keyStringExact([1]))).toEqual([59297, 63422]);
    expect(at(keyStringExact([2]))).toEqual([43207, 35955]);
    expect(at(keyStringExact(["tenant-a"]))).toEqual([30591, 42834]);
    expect(at(keyStringExact([7, 1]))).toEqual([28802, 30195]);
    expect(at(keyStringExact([7, 2]))).toEqual([55991, 59924]);
    expect(tokenOf(keyStringExact([7]), keyStringExact([7, 1]))).toBe(slotOf(keyStringExact([7])) + 30195);
  });

  it("refines the 4,096 slots it replaces: an old slot is 16 of the new ones", () => {
    expect(OLD).toBe(16 * SUBSLOTS);
    for (let i = 0; i < 5000; i++) {
      const key = keyStringExact([i]);
      expect(Math.floor(slotOf(key) / OLD)).toBe(oldSlotOf(key));
    }
  });

  it("spreads the rows of one slot over the subslots", () => {
    // 主キーが 1 列の表では、slot と subslot を同じ hash から取る。slot を固定しても、subslot が片側に寄らないこと。
    const lower = new Map<number, number>();
    const total = new Map<number, number>();
    for (let i = 0; i < 200_000; i++) {
      const key = keyStringExact([i]);
      const bundle = Math.floor(slotOf(key) / (REGION_TOKENS / 16)); // slot を 16 個の束にまとめる
      total.set(bundle, (total.get(bundle) ?? 0) + 1);
      if (subslotOf(key) < SUBSLOTS / 2) lower.set(bundle, (lower.get(bundle) ?? 0) + 1);
    }
    expect(total.size).toBe(16);
    for (const [bundle, n] of total) expect(Math.abs((lower.get(bundle) ?? 0) / n - 0.5), `bundle ${bundle}`).toBeLessThan(0.02);
  });
});

describe("the range table with boundaries on the old slots", () => {
  it("starts from the old table when the number of shards divides the slots, and within one old slot of it otherwise", () => {
    for (const n of [1, 2, 4, 8, 16, 64]) {
      const shards = Array.from({ length: n }, (_, i) => `s${i}`);
      expect(initialRouting(shards)).toEqual(scaled(oldInitialRouting(shards)));
    }
    // 割り切れない数では、境目が前より細かい位置に来る。ずれは、前の slot 1 つより小さい。
    for (const n of [3, 5, 6, 7, 12]) {
      const shards = Array.from({ length: n }, (_, i) => `s${i}`);
      const [now, old] = [initialRouting(shards), scaled(oldInitialRouting(shards))];
      expectPartition(now);
      expect(now.ranges.map((x) => x.shard)).toEqual(old.ranges.map((x) => x.shard));
      for (const [i, x] of now.ranges.entries()) {
        expect(slotAligned(x)).toBe(true);
        expect(x.start - old.ranges[i]!.start >= 0 && x.start - old.ranges[i]!.start < OLD).toBe(true);
      }
    }
  });

  for (const seed of seedsOr([1, 2, 3, 4, 5, 6, 7, 8])) {
    it(`is the table the code before tokens built (seed ${seed})`, () => {
      const rand = prng(seed);
      const shards = Array.from({ length: int(rand, 1, 6) }, (_, i) => `s${i}`);
      let old = oldInitialRouting(shards);
      let now = scaled(old);
      const keys = Array.from({ length: 200 }, (_, i) => keyStringExact([i, seed]));
      for (let step = 0; step < 40; step++) {
        const all = shardsOf(now);
        const parent = all[int(rand, 0, all.length)]!;
        // 分割の計画は、前の計画と同じ区間か、それより前の slot の半分だけ後ろから始まる区間である (半端な幅を、細かい slot で
        // ちょうど半分にできるようになった)。前の計画が割れなかった幅 1 の slot も、いまは割れる。
        const planned = planSplit(now, parent);
        const oldPlanned = oldPlanSplit(old, parent);
        if (oldPlanned) {
          const widest = old.ranges.filter((x) => x.shard === parent).sort((a, b) => b.end - b.start - (a.end - a.start))[0]!;
          const odd = (widest.start + widest.end) % 2 === 1;
          expect(planned).toEqual({ start: oldPlanned.start * OLD + (odd ? OLD / 2 : 0), end: oldPlanned.end * OLD });
        } else if (old.ranges.some((x) => x.shard === parent)) {
          expect(planned !== null && slotAligned(planned)).toBe(true);
        }
        // 半分は前の分割の計画どおりに、残りは前の slot の境目に置いた好きな範囲を動かす。
        const start = int(rand, 0, OLD_SLOTS - 1);
        const range = oldPlanned && rand() < 0.5 ? oldPlanned : { start, end: int(rand, start + 1, OLD_SLOTS + 1) };
        const to = rand() < 0.7 ? `s${all.length + step}` : all[int(rand, 0, all.length)]!;
        old = oldApplyMove(old, { ...range, to });
        now = applyMove(now, { start: range.start * OLD, end: range.end * OLD, to });
        expect(now).toEqual(scaled(old));
        expect(JSON.stringify(now.ranges.map((x) => Object.keys(x)))).toBe(JSON.stringify(old.ranges.map((x) => Object.keys(x))));
        for (const sk of keys) {
          const owner = oldOwnerOf(old, sk);
          expect(ownerOf(now, sk)).toBe(owner);
          expect(ownerOf(now, sk, keyStringExact([sk, 1]))).toBe(owner);
          expect(ownersOf(now, sk)).toEqual([owner]);
        }
        for (const shard of shardsOf(now)) {
          expect(regionsOf(now, shard)).toEqual(oldRangesOf(old, shard).map(([a, b]) => ({ start: a * OLD, end: b * OLD })));
        }
      }
      expectPartition(now);
    });
  }
});

describe("the range table with boundaries anywhere", () => {
  for (const seed of seedsOr([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])) {
    it(`gives every token exactly one owner after any sequence of moves (seed ${seed})`, () => {
      const rand = prng(seed);
      const shards = Array.from({ length: int(rand, 1, 5) }, (_, i) => `s${i}`);
      const first = initialRouting(shards);
      let r = first;
      const moves: (Interval & { to: string })[] = [];
      const tokens: number[] = Array.from({ length: 300 }, () => int(rand, 0, REGION_TOKENS));
      for (let step = 0; step < 60; step++) {
        // ブロックの中に境目を置く短い移動、slot の境目に揃えた移動、広い移動を混ぜる。
        const kind = rand();
        const start = kind < 0.3 ? int(rand, 0, SLOTS) * SUBSLOTS : int(rand, 0, REGION_TOKENS - 1);
        const width = kind < 0.3 ? int(rand, 1, 400) * SUBSLOTS : kind < 0.7 ? int(rand, 1, 3 * SUBSLOTS) : int(rand, 1, REGION_TOKENS / 8);
        const move = { start, end: Math.min(REGION_TOKENS, start + width), to: `s${int(rand, 0, shards.length + step)}` };
        expect(() => checkInterval(move)).not.toThrow();
        moves.push(move);
        r = applyMove(r, move);
        expect(r.version).toBe(first.version + moves.length);
        // 境目の両側の token も見る。
        for (const t of [move.start - 1, move.start, move.end - 1, move.end]) if (t >= 0 && t < REGION_TOKENS) tokens.push(t);
      }
      expectPartition(r);
      // token の持ち主は、その token を含む最後の移動の宛先で、なければ最初の持ち主である。
      for (const t of tokens) {
        const holders = r.ranges.filter((x) => t >= x.start && t < x.end);
        expect(holders.length, `token ${t}`).toBe(1);
        const last = moves.findLast((m) => t >= m.start && t < m.end);
        const want = last?.to ?? first.ranges.find((x) => t >= x.start && t < x.end)!.shard;
        expect(holders[0]!.shard, `token ${t}`).toBe(want);
      }
      // シャードごとの区間を合わせると、region 0 の全部になる。
      const width = shardsOf(r).flatMap((s) => regionsOf(r, s)).reduce((n, x) => n + (x.end - x.start), 0);
      expect(width).toBe(REGION_TOKENS);
    });
  }

  it("finds the owner of a row by its primary key when a boundary falls inside the block of its shard key", () => {
    const sk = keyStringExact([7]);
    const block = blockOf(sk);
    const before = initialRouting(["s0", "s1"]);
    const parent = ownerOf(before, sk);
    // ブロックの後ろ半分と、その後ろの slot 3 つを s9 へ移す。
    const r = applyMove(before, { start: block.start + SUBSLOTS / 2, end: block.end + 3 * SUBSLOTS, to: "s9" });
    expectPartition(r);
    const pks = Array.from({ length: 400 }, (_, i) => keyStringExact([7, i]));
    const low = pks.filter((pk) => subslotOf(pk) < SUBSLOTS / 2);
    expect(low.length).toBeGreaterThan(100);
    expect(pks.length - low.length).toBeGreaterThan(100);
    for (const pk of pks) expect(ownerOf(r, sk, pk)).toBe(subslotOf(pk) < SUBSLOTS / 2 ? parent : "s9");
    expect(ownersOf(r, sk).sort()).toEqual([parent, "s9"].sort());
    // 主キーがなければ、行の持ち主は 1 つに決まらない。黙ってどちらかを返さない。
    expect(() => ownerOf(r, sk)).toThrow(/is split between/);
    // 境目の入っていないブロックは、今までどおりである。
    const others = Array.from({ length: 200 }, (_, i) => keyStringExact([100 + i])).filter((k) => slotOf(k) !== block.start);
    for (const k of others) {
      expect(ownersOf(r, k)).toEqual([ownerOf(r, k)]);
      expect(ownerOf(r, k, keyStringExact([k, 1]))).toBe(ownerOf(r, k));
    }
    expect(regionsOf(r, "s9")).toEqual([{ start: block.start + SUBSLOTS / 2, end: block.end + 3 * SUBSLOTS }]);
    // 分けたブロックを元のシャードへ戻すと、持ち主は 1 つに戻る。
    const back = applyMove(r, { start: block.start, end: block.end, to: parent });
    expectPartition(back);
    expect(ownerOf(back, sk)).toBe(parent);
  });

  it("refuses a range that is empty, not whole numbers, or outside the tokens", () => {
    for (const [start, end] of [[5, 5], [9, 3], [-1, 4], [0, TOKENS + 1], [0.5, 3]] as [number, number][]) {
      expect(() => checkInterval({ start, end })).toThrow(/invalid token range/);
    }
    expect(() => checkInterval({ start: 0, end: TOKENS })).not.toThrow();
  });

  it("names a range by slots when it starts and ends at slot boundaries, and by tokens otherwise", () => {
    expect(rangeText({ start: 3 * SUBSLOTS, end: 9 * SUBSLOTS })).toBe("slots [3, 9)");
    expect(rangeText({ start: 3 * SUBSLOTS + 1, end: 9 * SUBSLOTS })).toBe(`tokens [${3 * SUBSLOTS + 1}, ${9 * SUBSLOTS})`);
    expect(overlaps({ start: 0, end: 5 }, { start: 5, end: 9 })).toBe(false);
    expect(overlaps({ start: 0, end: 6 }, { start: 5, end: 9 })).toBe(true);
  });

  it("plans a split at slot boundaries only", () => {
    expect(planSplit(initialRouting(["s0"]), "s0")).toEqual({ start: REGION_TOKENS / 2, end: REGION_TOKENS });
    // slot が 1 つしか入らない区間は割らない (ブロックの中で割るのは後の段)。
    const one = applyMove(initialRouting(["s0"]), { start: 7 * SUBSLOTS, end: 8 * SUBSLOTS, to: "s1" });
    expect(planSplit(one, "s1")).toBeNull();
    const two = applyMove(initialRouting(["s0"]), { start: 7 * SUBSLOTS, end: 9 * SUBSLOTS, to: "s1" });
    expect(planSplit(two, "s1")).toEqual({ start: 8 * SUBSLOTS, end: 9 * SUBSLOTS });
    // 区間の端がブロックの中にあっても、割る位置は slot の境目である。
    const cut = applyMove(initialRouting(["s0"]), { start: 5 * SUBSLOTS + 100, end: 9 * SUBSLOTS, to: "s1" });
    expect(planSplit(cut, "s1")).toEqual({ start: 7 * SUBSLOTS, end: 9 * SUBSLOTS });
    const inside = applyMove(initialRouting(["s0"]), { start: 5 * SUBSLOTS + 100, end: 6 * SUBSLOTS + 50, to: "s1" });
    expect(planSplit(inside, "s1")).toBeNull();
    expect(planSplit(initialRouting(["s0"]), "nobody")).toBeNull();
  });
});
