// 配置を token の区間にした後の形式 (docs/design-subslots.md の段 1)。
//
// Meta の範囲表と移動の記録 (move-start)、シャードの移動の記録、範囲の移動の要求が、token の区間と piece を運ぶ形になった。
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

  it("moves whole slots only, and checks the owner by the ranges it overlaps", async () => {
    const c = new SimCluster({ shards: 2 });
    const before = (await c.catalog()).routing;
    const sk = JSON.stringify([7]);
    const block = blockOf(sk);
    const owner = ownerOf(before, sk);
    const other = owner === "s0" ? "s1" : "s0";
    // ブロックの後ろ半分。範囲表の形式はブロックの中の境目も持てるが、シャードの移動の手順は、まだグループの全体を運ぶことを
    // 前提にしている。記録すると、移動が終わらないまま開き続け、表定義の変更も止まるので、Meta が記録の前に断る (段 4)。
    const half = { start: block.start + SUBSLOTS / 2, end: block.end };
    expect(await outcome(c.startMove({ ...half, to: "s9", from: owner }))).toBe(`moving a part of a slot is not supported yet: tokens [${half.start}, ${half.end})`);
    // 持ち主でないシャードからの移動は断る。
    expect(await outcome(c.startMove({ ...block, to: "s9", from: other }))).toBe(`slots [${block.start / SUBSLOTS}, ${block.end / SUBSLOTS}) are owned by ${owner}, not by ${other}`);
    // 2 つの持ち主の区間にまたがる移動も断る。
    const both = { start: REGION_TOKENS / 2 - SUBSLOTS, end: REGION_TOKENS / 2 + SUBSLOTS };
    expect(await outcome(c.startMove({ ...both, to: "s9", from: "s0" }))).toBe(`slots [${both.start / SUBSLOTS}, ${both.end / SUBSLOTS}) are owned by s0, s1, not by s0`);
    for (const bad of [{ start: 9, end: 3 }, { start: 0, end: TOKENS + 1 }, { start: 0.5, end: 3 }]) {
      expect(await outcome(c.startMove({ ...bad, to: "s9", from: owner }))).toMatch(/invalid token range/);
    }
    expect((await c.catalog()).routing).toEqual(before);
    const { epoch, routing: after } = await c.startMove({ ...block, to: "s9", from: owner });
    expect(after.version).toBe(before.version + 1);
    expect(after.ranges.filter((r) => r.shard === "s9")).toEqual([{ ...block, shard: "s9" }]);
    // やり直しても、同じ移動の同じ epoch が返る。
    expect(await c.startMove({ ...block, to: "s9", from: owner })).toEqual({ epoch, routing: after });
    // 動いたブロックは、もう元の持ち主のものではない。
    expect(await outcome(c.startMove({ ...block, to: "s8", from: owner }))).toMatch(/are owned by s9, not by/);
  });

  it("identifies a move by its parent, its child and the token range it moves, and closes it once", async () => {
    const c = new SimCluster({ shards: 1 });
    const range = { start: REGION_TOKENS / 2, end: REGION_TOKENS };
    const a = await c.startMove({ from: "s0", to: "s1", ...range });
    expect(await c.moves()).toEqual([{ epoch: a.epoch, from: "s0", to: "s1", ...range }]);
    expect(Object.keys((await c.moves())[0]!)).toEqual(["epoch", "from", "to", "start", "end"]);
    expect(await c.startMove({ from: "s0", to: "s1", ...range })).toEqual(a);
    // 親が開いている移動の端なので、ほかの移動は開けない (区間が 1 slot でも違えば、別の移動である)。
    const cut = { start: 7 * SUBSLOTS, end: 8 * SUBSLOTS };
    expect(await outcome(c.startMove({ from: "s0", to: "s2", ...cut }))).toBe(`split busy: a move of slots [${range.start / SUBSLOTS}, ${range.end / SUBSLOTS}) from s0 to s1 is in progress`);
    expect(await outcome(c.startMove({ from: "s0", to: "s3", start: 5, end: 5 }))).toMatch(/invalid token range/);
    // 閉じるのは 1 度だけで、やり直しは同じ記録を返す。
    const end = await c.meta.endMove(a.epoch);
    expect(end.epoch).toBe(a.epoch + 1);
    expect(await c.meta.endMove(a.epoch)).toEqual(end);
    expect(await c.moves()).toEqual([]);
    expect(await outcome(c.meta.endMove(end.epoch))).toBe(`epoch ${end.epoch} is not a move`);
    expect(readEpochs(c.metaBackend).filter((x) => x.rec.kind === "move-start" || x.rec.kind === "move-end").map((x) => x.rec.kind)).toEqual(["move-start", "move-end"]);
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
    // 子が自分で進める受け取りを、最初の手 (親のグループの一覧) で止める。
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    c.net.gate = (m) => (m.from === "s2" && m.method === "listGroups" ? held : undefined);
    const { epoch } = await c.moveAt("s0", "s2", range, ["s0", "s2"]);
    // 同じ要求のやり直しは、何もしない。
    expect(await c.moveAt("s0", "s2", range, ["s0", "s2"])).toEqual({ epoch });
    expect(await c.shard("s0").moves({})).toEqual({ outgoing: [{ ...range, to: "s2" }], incoming: [] });
    expect(await c.shard("s2").moves({})).toEqual({ outgoing: [], incoming: [{ ...range, from: "s0" }] });
    expect(c.backends.get("s2")!.exec("SELECT lo, hi, from_id, done, epoch FROM __incoming")).toEqual([{ lo: range.start, hi: range.end, from_id: "s0", done: 0, epoch }]);
    expect(c.backends.get("s0")!.exec(`SELECT lo, hi, "to", done, epoch FROM __fenced`)).toEqual([{ lo: range.start, hi: range.end, to: "s2", done: 0, epoch }]);
    // 再起動の後も、同じ範囲を返す。
    c.restart("s0");
    c.restart("s2");
    expect(await c.shard("s0").moves({})).toEqual({ outgoing: [{ ...range, to: "s2" }], incoming: [] });
    expect(await c.shard("s2").moves({})).toEqual({ outgoing: [], incoming: [{ ...range, from: "s0" }] });
    // 途中で止まった分割を、Autoscaler が同じ範囲で終える。
    c.net.gate = () => undefined;
    release();
    const done = await split(c, "s0", "s2");
    expect(done).toMatchObject({ ...range, groups: moving.length });
    expect(await c.moves()).toEqual([]);
    expect((await new Db(c).query("SELECT count(*) AS n FROM users")).rows).toEqual([{ n: 40 }]);
    expect(await quiescentProblems(c)).toEqual([]);
  });

  it("refuses to move a range that cuts a block, until the shard can keep the rest of the group", async () => {
    const { c, moving } = await seeded();
    const before = (await c.catalog()).routing;
    const block = blockOf(JSON.stringify([moving[0]!]));
    const part = { start: block.start + SUBSLOTS / 2, end: block.end };
    const refused = `moving a part of a slot is not supported yet: tokens [${part.start}, ${part.end})`;
    // Meta が、移動を記録する前に断る。
    expect(await outcome(split(c, "s0", "s2", { range: part }))).toBe(refused);
    expect(await c.moves()).toEqual([]);
    expect(await outcome(c.shard("s0").listGroups({ ...part, limit: 10 }))).toBe(refused);
    // 始まりだけ、終わりだけがブロックの中にある範囲も同じである。
    for (const cut of [{ start: block.start + 1, end: block.end + SUBSLOTS }, { start: block.start, end: block.end - 1 }]) {
      expect(await outcome(c.startMove({ ...cut, to: "s2", from: "s0" }))).toMatch(/moving a part of a slot is not supported yet/);
      expect(await outcome(c.shard("s0").listGroups({ ...cut, limit: 10 }))).toMatch(/moving a part of a slot is not supported yet/);
    }
    expect(await outcome(c.shard("s0").listGroups({ start: block.end, end: block.start, limit: 10 }))).toMatch(/invalid token range/);
    expect((await c.catalog()).routing).toEqual(before);
    for (const id of ["s0", "s2"]) expect(await c.shard(id).moves({})).toEqual({ outgoing: [], incoming: [] });
    // slot の境目で切る分割は通る。
    expect((await split(c, "s0", "s2"))!.groups).toBe(moving.length);
    expect((await new Db(c).query("SELECT count(*) AS n FROM users")).rows).toEqual([{ n: 40 }]);
  });

  it("moves a group as one piece, and refuses a piece that is a part of a group", async () => {
    const { c, range, moving } = await seeded();
    const g = JSON.stringify([moving[0]!]);
    // 移動を開き、親にだけ適用させる (fence)。子は知らないので、自分では引き取らない。
    const { epoch } = await c.moveAt("s0", "s2", range, ["s0"]);
    // 続きの位置からの要求は、グループを分けて運ぶ段で足す。
    const from: [string, string] = ["users", JSON.stringify([moving[0]!, 1])];
    expect(await outcome(c.shard("s0").pull({ ...range, want: [{ g, from }], to: "s2", maxBytes: 1_000_000, epoch }))).toMatch(/still moved as one piece/);
    // fence を名指ししない要求 (区間が fence と違う) は、fence のないグループの要求と同じに断る。
    for (const e of [undefined, epoch]) {
      expect(await outcome(c.shard("s0").pull({ start: range.start, end: range.end - SUBSLOTS, want: [{ g, from: null }], to: "s2", maxBytes: 1_000_000, epoch: e }))).toMatch(/unfenced/);
    }
    const [piece] = await c.shard("s0").pull({ ...range, want: [{ g, from: null }], to: "s2", maxBytes: 1_000_000, epoch });
    expect({ ...piece, m: 0, rows: piece!.rows.length, intents: piece!.intents.length }).toEqual({
      g, range, after: null, epoch, upTo: null, m: 0, rows: 1, intents: 0, schema: (await c.catalog()).schema,
    });
    // グループの一部だけの piece を受け取ると、届いていない行のあるグループを「到着した」と記録してしまう。子の SQLite は、ここで作る。
    await c.shard("s2").moves({});
    const receive = (p: PiecePayload) => (c.cores.get("s2") as unknown as { receive(p: PiecePayload[]): Promise<void> }).receive([p]);
    expect(await outcome(receive({ ...piece!, upTo: from }))).toMatch(/received a part of group/);
    expect(c.backends.get("s2")!.exec("SELECT count(*) AS n FROM __arrived")[0]!.n).toBe(0);
    // グループの一部を指す ack は、渡した piece のものではないので、何も消さない。
    await c.shard("s0").ack({ pieces: [{ g, range, after: from, epoch }] });
    expect(c.backends.get("s0")!.exec("SELECT acked FROM __moved WHERE g = ?", g)).toEqual([{ acked: 0 }]);
    expect(c.backends.get("s0")!.exec("SELECT count(*) AS n FROM users WHERE tenant_id = ?", moving[0]!)[0]!.n).toBe(1);
    await split(c, "s0", "s2");
    expect((await new Db(c).query("SELECT count(*) AS n FROM users")).rows).toEqual([{ n: 40 }]);
    expect(await quiescentProblems(c)).toEqual([]);
  });
});
