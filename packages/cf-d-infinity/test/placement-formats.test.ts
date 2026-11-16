// 配置を token の区間にした後の形式 (docs/design-subslots.md の段 1)。
//
// Meta の範囲表と分割の枠、シャードの移動の記録、範囲の移動の要求が、token の区間と piece を運ぶ形になった。
// この段では、slot が細かくなったほかに挙動は変えていない。どの区間の境目も slot の境目にあり、どの piece もグループの全体である。
// ここで確かめるのは、
//   - 記録と要求が、決めた形で書かれること (docs/storage-format.md)。
//   - まだ扱えない形 (ブロックを途中で切る移動、グループの一部の piece) を、黙って受けずに断ること。
import { describe, expect, it } from "vitest";
import { split } from "../src/autoscaler";
import { fold } from "../src/catalog";
import { Db } from "../src/client/db";
import { readEpochs } from "../src/meta";
import { REGION_TOKENS, SUBSLOTS, TOKENS, blockOf, ownerOf, planSplit, slotAligned, slotOf } from "../src/routing";
import type { PiecePayload } from "../src/types";
import { quiescentProblems } from "./invariants";
import { SimCluster, USERS } from "./sim";

const outcome = (p: Promise<unknown>) => p.then(() => "ok", (e: Error) => e.message);

async function seeded(shards = 2) {
  const c = new SimCluster({ shards });
  await new Db(c).ddl(USERS);
  for (let t = 1; t <= 40; t++) await new Db(c).query("INSERT INTO users(tenant_id,id,n) VALUES (?,1,?)", [t, t]);
  const range = planSplit((await c.catalog()).routing, "s0")!;
  const inRange = (t: number) => slotOf(JSON.stringify([t])) >= range.start && slotOf(JSON.stringify([t])) < range.end;
  const moving = Array.from({ length: 40 }, (_, i) => i + 1).filter(inRange);
  return { c, range, moving };
}

describe("Meta", () => {
  it("writes the range table as token ranges that start and end at slot boundaries", async () => {
    const { c, range } = await seeded();
    expect(range).toEqual({ start: REGION_TOKENS / 4, end: REGION_TOKENS / 2 });
    await split(c, "s0", "s2");
    // 範囲表の版ごとの中身。Meta の epoch の列の、最初の範囲表と切り替えの記録の位置で畳む。
    const log = readEpochs(c.metaBackend);
    const bodies = log.filter((x) => x.rec.kind === "genesis" || x.rec.kind === "move-start").map((x) => fold(log, x.epoch).routing);
    expect(bodies).toEqual([
      { version: 1, ranges: [{ start: 0, end: REGION_TOKENS / 2, shard: "s0" }, { start: REGION_TOKENS / 2, end: REGION_TOKENS, shard: "s1" }] },
      {
        version: 2,
        ranges: [
          { start: 0, end: REGION_TOKENS / 4, shard: "s0" }, { start: REGION_TOKENS / 4, end: REGION_TOKENS / 2, shard: "s2" },
          { start: REGION_TOKENS / 2, end: REGION_TOKENS, shard: "s1" },
        ],
      },
    ]);
    expect(bodies[1]!.ranges.every(slotAligned)).toBe(true);
  });

  it("switches any token range, and checks the owner by the ranges it overlaps", async () => {
    const c = new SimCluster({ shards: 2 });
    const before = (await c.catalog()).routing;
    const sk = JSON.stringify([7]);
    const block = blockOf(sk);
    const owner = ownerOf(before, sk);
    const other = owner === "s0" ? "s1" : "s0";
    // ブロックの後ろ半分。範囲表は、ブロックの中の境目も持てる。
    const half = { start: block.start + SUBSLOTS / 2, end: block.end };
    // 持ち主でないシャードからの切り替えは断る。
    expect(await outcome(c.switchRange({ ...half, to: "s9", from: other }))).toBe(`tokens [${half.start}, ${half.end}) are owned by ${owner}, not by ${other}`);
    expect(await outcome(c.switchRange({ ...block, to: "s9", from: other }))).toBe(`slots [${block.start / SUBSLOTS}, ${block.end / SUBSLOTS}) are owned by ${owner}, not by ${other}`);
    for (const bad of [{ start: 9, end: 3 }, { start: 0, end: TOKENS + 1 }, { start: 0.5, end: 3 }]) {
      expect(await outcome(c.switchRange({ ...bad, to: "s9", from: owner }))).toMatch(/invalid token range/);
    }
    expect((await c.catalog()).routing).toEqual(before);
    const after = await c.switchRange({ ...half, to: "s9", from: owner });
    expect(after.version).toBe(before.version + 1);
    expect(after.ranges.filter((r) => r.shard === "s9")).toEqual([{ ...half, shard: "s9" }]);
    expect(after.ranges.length).toBe(before.ranges.length + (block.end === before.ranges.find((r) => r.shard === owner)!.end ? 1 : 2));
    // やり直しても同じ範囲表が返る。
    expect(await c.switchRange({ ...half, to: "s9", from: owner })).toEqual(after);
    // 分かれたブロックの全体を、片方の持ち主から動かすことはできない。
    expect(await outcome(c.switchRange({ ...block, to: "s8", from: owner }))).toMatch(/are owned by .*, not by/);
    // 残った半分は、元の持ち主から動かせる。
    const rest = await c.switchRange({ start: block.start, end: half.start, to: "s8", from: owner });
    expect(rest.ranges.filter((r) => r.start >= block.start && r.end <= block.end)).toEqual([
      { start: block.start, end: half.start, shard: "s8" }, { ...half, shard: "s9" },
    ]);
  });

  it("identifies a split by the token range it moves", async () => {
    const c = new SimCluster({ shards: 1 });
    const { version } = await c.catalog();
    const range = { start: REGION_TOKENS / 2, end: REGION_TOKENS };
    const slot = await c.beginSplit({ parent: "s0", child: "s1", ...range }, version);
    expect(slot).toEqual({ id: `split:s0:s1:${range.start}:${range.end}`, parent: "s0", child: "s1", ...range, version, started: false, until: slot.until });
    expect(Object.keys(slot)).toEqual(["id", "parent", "child", "start", "end", "version", "started", "until"]);
    expect(await c.beginSplit({ parent: "s0", child: "s1", ...range }, version)).toEqual(slot);
    // 範囲が 1 token でも違えば、別の分割である。枠は、名指しされた範囲のものでなければ使えない。
    const cut = { start: 7 * SUBSLOTS, end: 7 * SUBSLOTS + 100 };
    const part = await c.beginSplit({ parent: "s0", child: "s2", ...cut }, version);
    expect(part.id).toBe(`split:s0:s2:${cut.start}:${cut.end}`);
    expect(await outcome(c.meta.startSplit(part.id, { parent: "s0", child: "s2", start: cut.start, end: cut.end + 1 }))).toMatch(/no such split slot/);
    expect(await c.meta.startSplit(part.id, { parent: "s0", child: "s2", ...cut })).toEqual({ version });
    expect(await outcome(c.meta.checkSplit(part.id, { parent: "s0", child: "s2", start: cut.start, end: cut.end + 1 }))).toMatch(/split slot is not held/);
    expect(await outcome(c.meta.checkSplit(part.id, { parent: "s0", child: "s2", ...cut }))).toBe("ok");
    expect(await outcome(c.beginSplit({ parent: "s0", child: "s3", start: 5, end: 5 }, version))).toMatch(/invalid token range/);
  });
});

describe("a shard", () => {
  it("records a finished move as token ranges and whole-group pieces, and keeps the range it received", async () => {
    const { c, range, moving } = await seeded();
    await split(c, "s0", "s2");
    await c.settle();
    const parent = c.backends.get("s0")!;
    const child = c.backends.get("s2")!;
    expect(parent.exec(`SELECT lo, hi, "to", done FROM __fenced`)).toEqual([{ lo: range.start, hi: range.end, to: "s2", done: 1 }]);
    const groups = moving.map((t) => JSON.stringify([t])).sort();
    expect(groups.length).toBeGreaterThan(3);
    const moved = parent.exec(`SELECT g, lo, hi, "after", up_to, dest, acked FROM __moved ORDER BY g`);
    expect(moved).toEqual(groups.map((g) => ({ g, lo: range.start, hi: range.end, after: "null", up_to: "null", dest: "s2", acked: 1 })));
    const arrived = child.exec(`SELECT g, lo, hi, "after", up_to, m FROM __arrived ORDER BY g`);
    expect(arrived.map(({ m: _m, ...r }) => r)).toEqual(groups.map((g) => ({ g, lo: range.start, hi: range.end, after: "null", up_to: "null" })));
    // piece は、渡した側が手放した時刻を運ぶ。
    const sent = new Map(parent.exec(`SELECT g, m FROM __moved`).map((r) => [r.g, r.m]));
    for (const r of arrived) expect(r.m).toBe(sent.get(r.g));
    // 受け取り終えた範囲の記録は消さない。終えた印と、渡した側から受け取った時刻が残る。
    const incoming = child.exec(`SELECT lo, hi, from_id, done, m FROM __incoming`);
    expect(incoming.map(({ m: _m, ...r }) => r)).toEqual([{ lo: range.start, hi: range.end, from_id: "s0", done: 1 }]);
    expect(incoming[0]!.m as number).toBeGreaterThan(Math.max(...arrived.map((r) => r.m as number)));
    // 残した記録は、移動の途中としては扱わない。再起動の後も同じである。
    for (const restart of [false, true]) {
      if (restart) c.restart("s2");
      expect(await c.shard("s2").moves({})).toEqual({ outgoing: [], incoming: [] });
      const health = await c.shard("s2").health({});
      expect([health.incoming, health.outgoing]).toEqual([0, 0]);
      expect((await c.shard("s2").metrics({})).migrating).toBe(false);
    }
    expect((await new Db(c).query("SELECT count(*) AS n FROM users")).rows).toEqual([{ n: 40 }]);
    expect(await quiescentProblems(c)).toEqual([]);
  });

  it("reports an unfinished move by its token range, and the same split finishes it", async () => {
    const { c, range, moving } = await seeded();
    const slot = await c.reserveSplit("s0", "s2", range);
    await c.shard("s2").beginIncoming({ ...range, from: "s0", slot: slot.id });
    await c.shard("s0").fence({ ...range, to: "s2", slot: slot.id });
    // 同じ要求のやり直しは、何もしない。
    await c.shard("s2").beginIncoming({ ...range, from: "s0", slot: slot.id });
    await c.shard("s0").fence({ ...range, to: "s2", slot: slot.id });
    expect(await c.shard("s0").moves({})).toEqual({ outgoing: [{ ...range, to: "s2" }], incoming: [] });
    expect(await c.shard("s2").moves({})).toEqual({ outgoing: [], incoming: [{ ...range, from: "s0" }] });
    expect(c.backends.get("s2")!.exec("SELECT count(*) AS n FROM __incoming")[0]!.n).toBe(1);
    expect(c.backends.get("s0")!.exec("SELECT count(*) AS n FROM __fenced")[0]!.n).toBe(1);
    // 再起動の後も、同じ範囲を返す。
    c.restart("s0");
    c.restart("s2");
    expect(await c.shard("s0").moves({})).toEqual({ outgoing: [{ ...range, to: "s2" }], incoming: [] });
    expect(await c.shard("s2").moves({})).toEqual({ outgoing: [], incoming: [{ ...range, from: "s0" }] });
    // 途中で止まった分割を、Autoscaler が同じ範囲で終える。
    const done = await split(c, "s0", "s2");
    expect(done).toMatchObject({ ...range, groups: moving.length });
    expect(await c.splits()).toEqual([]);
    expect((await new Db(c).query("SELECT count(*) AS n FROM users")).rows).toEqual([{ n: 40 }]);
    expect(await quiescentProblems(c)).toEqual([]);
  });

  it("refuses to move a range that cuts a block, until the shard can keep the rest of the group", async () => {
    const { c, moving } = await seeded();
    const before = (await c.catalog()).routing;
    const block = blockOf(JSON.stringify([moving[0]!]));
    const part = { start: block.start + SUBSLOTS / 2, end: block.end };
    const refused = `moving a part of a slot is not supported yet: tokens [${part.start}, ${part.end})`;
    // Autoscaler の手順は、範囲表を切り替える前に、子の受け入れで止まる。
    expect(await outcome(split(c, "s0", "s2", { range: part }))).toBe(refused);
    const slot = (await c.splits())[0]!;
    expect([slot.start, slot.end]).toEqual([part.start, part.end]);
    expect(await outcome(c.shard("s2").beginIncoming({ ...part, from: "s0", slot: slot.id }))).toBe(refused);
    expect(await outcome(c.shard("s0").fence({ ...part, to: "s2", slot: slot.id }))).toBe(refused);
    expect(await outcome(c.shard("s0").listGroups({ ...part, limit: 10 }))).toBe(refused);
    // 始まりだけ、終わりだけがブロックの中にある範囲も同じである。
    for (const cut of [{ start: block.start + 1, end: block.end + SUBSLOTS }, { start: block.start, end: block.end - 1 }]) {
      expect(await outcome(c.shard("s0").fence({ ...cut, to: "s2", slot: slot.id }))).toMatch(/moving a part of a slot is not supported yet/);
    }
    expect(await outcome(c.shard("s0").fence({ start: block.end, end: block.start, to: "s2", slot: slot.id }))).toMatch(/invalid token range/);
    expect((await c.catalog()).routing).toEqual(before);
    for (const id of ["s0", "s2"]) expect(await c.shard(id).moves({})).toEqual({ outgoing: [], incoming: [] });
    // 受け取り始めていない枠は、期限で消える。その後は、slot の境目で切る分割が通る。
    await c.sleep(6000);
    expect(await c.splits()).toEqual([]);
    expect((await split(c, "s0", "s2"))!.groups).toBe(moving.length);
    expect((await new Db(c).query("SELECT count(*) AS n FROM users")).rows).toEqual([{ n: 40 }]);
  });

  it("moves a group as one piece, and refuses a piece that is a part of a group", async () => {
    const { c, range, moving } = await seeded();
    const g = JSON.stringify([moving[0]!]);
    const slot = await c.reserveSplit("s0", "s2", range);
    await c.shard("s2").beginIncoming({ ...range, from: "s0", slot: slot.id });
    await c.shard("s0").fence({ ...range, to: "s2", slot: slot.id });
    await c.switchRange({ ...range, to: "s2", from: "s0" });
    // 続きの位置からの要求は、グループを分けて運ぶ段で足す。
    const from: [string, string] = ["users", JSON.stringify([moving[0]!, 1])];
    expect(await outcome(c.shard("s0").pull({ ...range, want: [{ g, from }], to: "s2", maxBytes: 1_000_000 }))).toMatch(/still moved as one piece/);
    // fence を名指ししない要求は、fence のないグループの要求と同じに断る。
    expect(await outcome(c.shard("s0").pull({ start: range.start, end: range.end - SUBSLOTS, want: [{ g, from: null }], to: "s2", maxBytes: 1_000_000 }))).toMatch(/unfenced/);
    const [piece] = await c.shard("s0").pull({ ...range, want: [{ g, from: null }], to: "s2", maxBytes: 1_000_000 });
    expect({ ...piece, m: 0, rows: piece!.rows.length, intents: piece!.intents.length }).toEqual({
      g, range, after: null, upTo: null, m: 0, rows: 1, intents: 0, schema: (await c.catalog()).version,
    });
    // グループの一部だけの piece を受け取ると、届いていない行のあるグループを「到着した」と記録してしまう。
    const receive = (p: PiecePayload) => (c.cores.get("s2") as unknown as { receive(p: PiecePayload[]): Promise<void> }).receive([p]);
    expect(await outcome(receive({ ...piece!, upTo: from }))).toMatch(/received a part of group/);
    expect(c.backends.get("s2")!.exec("SELECT count(*) AS n FROM __arrived")[0]!.n).toBe(0);
    // グループの一部を指す ack は、渡した piece のものではないので、何も消さない。
    await c.shard("s0").ack({ pieces: [{ g, range, after: from }] });
    expect(c.backends.get("s0")!.exec("SELECT acked FROM __moved WHERE g = ?", g)).toEqual([{ acked: 0 }]);
    expect(c.backends.get("s0")!.exec("SELECT count(*) AS n FROM users WHERE tenant_id = ?", moving[0]!)[0]!.n).toBe(1);
    await split(c, "s0", "s2");
    expect((await new Db(c).query("SELECT count(*) AS n FROM users")).rows).toEqual([{ n: 40 }]);
    expect(await quiescentProblems(c)).toEqual([]);
  });
});
