// pull 型のライブ移動。specs/m5b_live_migration.qnt の反例を実コードで再現する。
import { describe, expect, it } from "vitest";
import { decide, DEFAULTS, needsFollowUp, nextShardNumber, split, type AutoscalerState } from "../src/autoscaler";
import { Db, type Txn } from "../src/client/db";
import { ownerOf, planSplit, shardsOf, slotOf } from "../src/routing";
import type { Faults, ShardMetrics } from "../src/types";
import { SimCluster, USERS } from "./sim";

const row = (t: number, id = 1) => [t, id];
const setup = async (faults: Faults = {}, shards = 2) => {
  const c = new SimCluster({ shards, faults });
  await new Db(c).ddl(USERS);
  return c;
};
const insert = (c: SimCluster, t: number, n = 0, id = 1) =>
  new Db(c).query("INSERT INTO users(tenant_id,id,n) VALUES (?,?,?)", [t, id, n]);
const getN = async (db: { query: Db["query"] }, t: number) =>
  (await db.query("SELECT n FROM users WHERE tenant_id = ? AND id = 1", row(t))).rows[0]?.n ?? null;

/** s0 の中で、split で子へ移るスロットに載る tenant を返す。 */
async function movingTenant(c: SimCluster, parent = "s0", skip = 0) {
  const { routing } = await c.catalog();
  const range = planSplit(routing, parent)!;
  for (let t = 1; ; t++) {
    const s = slotOf(JSON.stringify([t]));
    if (s >= range.start && s < range.end && skip-- === 0) return { t, range };
  }
}

describe("live split", () => {
  it("moves every row, keeps it readable, and empties the parent", async () => {
    const c = await setup();
    for (let t = 1; t <= 40; t++) await insert(c, t, t);
    const before = (await new Db(c).query("SELECT count(*) c, sum(n) s FROM users")).rows;
    const r = await split(c, "s0", "s2");
    expect(r!.groups).toBeGreaterThan(0);
    const { routing } = await c.catalog();
    expect(shardsOf(routing)).toEqual(["s0", "s2", "s1"]);
    const db = new Db(c);
    for (let t = 1; t <= 40; t++) expect(await getN(db, t)).toBe(t);
    expect((await db.query("SELECT count(*) c, sum(n) s FROM users")).rows).toEqual(before);
    const left = c.backends.get("s0")!.exec("SELECT count(*) c FROM users")[0]!.c as number;
    const child = c.backends.get("s2")!.exec("SELECT count(*) c FROM users")[0]!.c as number;
    expect(child).toBe(r!.rows);
    expect(left + child + (c.backends.get("s1")!.exec("SELECT count(*) c FROM users")[0]!.c as number)).toBe(40);
  });

  it("serves a group on demand before the background drain reaches it", async () => {
    const c = await setup();
    const { t, range } = await movingTenant(c);
    await insert(c, t, 7);
    const slot = await c.reserveSplit("s0", "s2", range);
    await c.shard("s2").beginIncoming({ ...range, from: "s0", slot: slot.id });
    await c.shard("s0").fence({ ...range, to: "s2", slot: slot.id });
    await c.switchRange({ ...range, to: "s2" });
    const db = new Db(c);
    expect(await getN(db, t)).toBe(7); // 所有権の切替だけで読める
    await db.query("UPDATE users SET n = 8 WHERE tenant_id = ? AND id = 1", row(t));
    expect(await getN(db, t)).toBe(8);
    expect(c.backends.get("s2")!.exec("SELECT n FROM users")).toEqual([{ n: 8 }]);
  });

  it("redirects a worker that still holds the old routing", async () => {
    const c = await setup();
    const { t } = await movingTenant(c);
    await insert(c, t, 1);
    const stale = new Db(c);
    await getN(stale, t); // 古い範囲表をキャッシュする
    await split(c, "s0", "s2");
    expect(await getN(stale, t)).toBe(1);
    await stale.query("UPDATE users SET n = 2 WHERE tenant_id = ? AND id = 1", row(t));
    expect(await getN(new Db(c), t)).toBe(2);
    expect(c.net.log.length).toBeGreaterThan(0);
  });

  it("recovers a group whose pull response was lost", async () => {
    const c = await setup();
    const { t, range } = await movingTenant(c);
    await insert(c, t, 5);
    const slot = await c.reserveSplit("s0", "s2", range);
    await c.shard("s2").beginIncoming({ ...range, from: "s0", slot: slot.id });
    await c.shard("s0").fence({ ...range, to: "s2", slot: slot.id });
    await c.switchRange({ ...range, to: "s2" });
    // 親は m を確定したが、応答が子に届かなかった。
    await c.shard("s0").pull({ groups: [JSON.stringify([t])], to: "s2", maxBytes: 1_000_000 });
    await c.shard("s2").drain(range);
    const { m } = await c.shard("s0").finishMove(range);
    await c.shard("s2").finishIncoming({ ...range, m });
    expect(await getN(new Db(c), t)).toBe(5);
    expect(c.backends.get("s0")!.exec("SELECT count(*) c FROM users WHERE tenant_id = ?", t)[0]!.c).toBe(0);
  });

  it("survives a restart of either side in the middle of a move", async () => {
    const c = await setup();
    const { t, range } = await movingTenant(c);
    await insert(c, t, 5);
    const slot = await c.reserveSplit("s0", "s2", range);
    await c.shard("s2").beginIncoming({ ...range, from: "s0", slot: slot.id });
    await c.shard("s0").fence({ ...range, to: "s2", slot: slot.id });
    await c.switchRange({ ...range, to: "s2" });
    c.restart("s0");
    c.restart("s2");
    expect(await getN(new Db(c), t)).toBe(5);
    c.restart("s2");
    await split(c, "s0", "s2", { range });
    expect(await getN(new Db(c), t)).toBe(5);
  });

  it("receives a group once when an on-demand pull races the background drain", async () => {
    // 本番のオートスケールで増設が UNIQUE 違反で失敗した。到着の印が sync の待ちの後だったためである。
    const c = await setup();
    const { t, range } = await movingTenant(c);
    await insert(c, t, 5);
    const slot = await c.reserveSplit("s0", "s2", range);
    await c.shard("s2").beginIncoming({ ...range, from: "s0", slot: slot.id });
    await c.shard("s0").fence({ ...range, to: "s2", slot: slot.id });
    await c.switchRange({ ...range, to: "s2" });
    const db = new Db(c);
    const [n] = await Promise.all([getN(db, t), c.shard("s2").drain(range), getN(new Db(c), t)]);
    expect(n).toBe(5);
    await c.settle();
    expect(c.backends.get("s2")!.exec("SELECT count(*) c FROM users WHERE tenant_id = ?", t)).toEqual([{ c: 1 }]);
  });

  it("chains splits", async () => {
    const c = await setup();
    for (let t = 1; t <= 30; t++) await insert(c, t, t);
    await split(c, "s0", "s2");
    await split(c, "s2", "s3");
    await split(c, "s3", "s4");
    const db = new Db(c);
    for (let t = 1; t <= 30; t++) expect(await getN(db, t)).toBe(t);
    expect((await db.query("SELECT count(*) c FROM users")).rows).toEqual([{ c: 30 }]);
  });
});

describe("counterexamples from m5b_live_migration", () => {
  // 取引の intent が親にある状態で移動し、その後に phase 2 が親へ届く。
  const pendingIntent = async (faults: Faults, arrivedFirst = false) => {
    let reader: Txn | undefined;
    const c = await setup(faults);
    const { t, range } = await movingTenant(c);
    let other = 1;
    const { routing } = await c.catalog();
    while (ownerOf(routing, JSON.stringify([other])) !== "s1") other++;
    await insert(c, t, 0);
    await insert(c, other, 0);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    c.net.gate = (m) => (m.method === "finalize" ? held : undefined);
    const w = await new Db(c).begin();
    await w.query("SELECT count(*) FROM users WHERE tenant_id = ?", [other]); // s1 を anchor にする
    await w.query("UPDATE users SET n = 1 WHERE tenant_id = ? AND id = 1", row(t));
    await w.query("UPDATE users SET n = 1 WHERE tenant_id = ? AND id = 1", row(other));
    await w.commit(); // commit 済みで phase 2 が親に未達
    // 移す前に時点を取る読み手。時点は w の確定の後、移す時刻 m の前にある。範囲表は移す前のものを持ち続ける。
    reader = await new Db(c).begin();
    await getN(reader, other);
    const slot = await c.reserveSplit("s0", "s2", range);
    await c.shard("s2").beginIncoming({ ...range, from: "s0", slot: slot.id });
    await c.shard("s0").fence({ ...range, to: "s2", slot: slot.id });
    await c.switchRange({ ...range, to: "s2" });
    // 親は応答を返したが子の処理はまだで、グループは飛行中である。
    const inFlight = await c.shard("s0").pull({ groups: [JSON.stringify([t])], to: "s2", maxBytes: 1_000_000 });
    const receive = () => (c.cores.get("s2") as unknown as { receive(p: unknown): Promise<void> }).receive(inFlight);
    // arrivedFirst: グループが子に着き終わってから、親に phase 2 が届く (m5b_red_p2)。そうでなければ、飛行中に届く (m5b_red_p2_window)。
    if (arrivedFirst) await receive();
    c.net.gate = () => {};
    release();
    await c.settle();
    await c.sleep(5);
    // 飛行中だった応答がここで子へ届く。
    if (!arrivedFirst) await receive();
    return { c, t, range, reader: reader! };
  };

  it("m5b_red_p2_window: applying at the parent loses the write in the flying snapshot", async () => {
    const { c, t, range } = await pendingIntent({ applyAfterMoved: true });
    await c.shard("s2").drain(range);
    await c.settle();
    expect(c.backends.get("s2")!.exec("SELECT n FROM users WHERE tenant_id = ?", t)).toEqual([{ n: 0 }]);
  });
  it("m5b_red_p2: applying at the parent after the group arrived at the child loses the write", async () => {
    const { c, t, range } = await pendingIntent({ applyAfterMoved: true }, true);
    await c.shard("s2").drain(range);
    await c.settle();
    expect(c.backends.get("s2")!.exec("SELECT n FROM users WHERE tenant_id = ?", t)).toEqual([{ n: 0 }]);
  });
  it("forwards phase 2 to the child after the group arrived", async () => {
    const { c, t, range } = await pendingIntent({}, true);
    await c.shard("s2").drain(range);
    await c.settle();
    expect(await getN(new Db(c), t)).toBe(1);
  });
  it("forwards phase 2 through the moved table instead", async () => {
    const { c, t, range } = await pendingIntent({});
    await c.shard("s2").drain(range);
    await c.settle();
    expect(await getN(new Db(c), t)).toBe(1);
  });
  it("m5b_red_intents: a move without intents loses a committed write", async () => {
    const { c, t, range } = await pendingIntent({ dropIntentsOnMove: true });
    await c.shard("s2").drain(range);
    await c.settle();
    expect(c.backends.get("s2")!.exec("SELECT n FROM users WHERE tenant_id = ?", t)).toEqual([{ n: 0 }]);
  });

  const staleRead = async (faults: Faults) => {
    const c = await setup(faults);
    const { t } = await movingTenant(c);
    await insert(c, t, 1);
    c.time += 1;
    const r = await new Db(c).begin();
    await getN(r, t); // T を取る
    c.time += 1;
    await new Db(c).query("UPDATE users SET n = 2 WHERE tenant_id = ? AND id = 1", row(t));
    c.time += 1;
    await split(c, "s0", "s2");
    return { r, t, c };
  };
  it("m5b_red_s3: the child cannot answer T < m, it has no history before the move", async () => {
    const { r, t } = await staleRead({ servePastMove: true });
    (r as unknown as { cat: unknown }).cat = await (r as unknown as { db: Db }).db.cluster.catalog();
    expect(await getN(r, t)).toBe(2); // T の時点の真の値は 1 である
  });
  it("answers ReadTooOld instead", async () => {
    const { r, t } = await staleRead({});
    (r as unknown as { cat: unknown }).cat = await (r as unknown as { db: Db }).db.cluster.catalog();
    await expect(getN(r, t)).rejects.toThrow(/moved at/);
  });

  // specs/m5b_live_migration.qnt の m5b_red_s3_parent。親は、移ったグループの読みに、移す時刻 m より前の時点でも答えてはならない。
  // 取引 w の intent が親に置かれたまま確定し (c < m)、intent はグループと一緒に子へ運ばれ、子で適用される。親は w を知らない。
  // 時点 T (c <= T < m) の読みに親が答えると、w の書き込みを見落とす。モデルの反例と同じ順で流す。
  it("m5b_red_s3_parent: a parent that ignores the fence answers a read of a moved group without the moved write", async () => {
    const { c, t, range, reader } = await pendingIntent({ ignoreFence: true }, true);
    await c.shard("s2").drain(range);
    await c.settle();
    expect(await getN(reader, t).catch((e: Error) => e.message)).not.toBe(1); // T の時点の真の値は w が書いた 1 である
  });
  it("a fenced parent refuses the read of a moved group", async () => {
    const { c, t, range, reader } = await pendingIntent({}, true);
    await c.shard("s2").drain(range);
    await c.settle();
    await expect(getN(reader, t)).rejects.toThrow(/not owner|moved at/);
  });

  const fencedWrite = async (faults: Faults) => {
    const c = await setup(faults);
    const { t, range } = await movingTenant(c);
    await insert(c, t, 1);
    const stale = new Db(c);
    await getN(stale, t);
    await split(c, "s0", "s2", { range });
    const res = await stale.query("UPDATE users SET n = 2 WHERE tenant_id = ? AND id = 1", row(t)).catch((e) => e);
    return { c, t, res };
  };
  it("a parent that ignores the fence accepts a write the child never sees", async () => {
    const { c, t } = await fencedWrite({ ignoreFence: true });
    expect(await getN(new Db(c), t)).toBe(1);
  });
  it("a fenced parent redirects, so the write reaches the child", async () => {
    const { c, t } = await fencedWrite({});
    expect(await getN(new Db(c), t)).toBe(2);
  });
});

describe("DDL with several Workers holding different catalogs", () => {
  it("restarts the first statement of a transaction on a stale catalog", async () => {
    const c = await setup({}, 4);
    const fresh = new Db(c);
    await fresh.ddl("CREATE TABLE p(id INTEGER PRIMARY KEY, n INTEGER)");
    await fresh.query("INSERT INTO p VALUES (1, 0)");
    const stale = new Db(c);
    await stale.query("SELECT n FROM p WHERE id = 1");
    await fresh.query("CREATE TABLE other(a)");
    await stale.query("BEGIN IMMEDIATE");
    await stale.query("UPDATE p SET n = 1 WHERE id = 1");
    await stale.query("COMMIT");
    expect((await new Db(c).query("SELECT n FROM p")).rows).toEqual([{ n: 1 }]);
  });
  it("does not lose rows written through a stale catalog after DROP and CREATE", async () => {
    // 本番で起きた消失。古い表定義の Worker が、DDL を適用していないシャードへ書いていた。
    const c = await setup({}, 4);
    const fresh = new Db(c);
    await fresh.ddl("CREATE TABLE p(a, b)");
    const stale = new Db(c);
    await stale.query("SELECT count(*) FROM p"); // この Worker は古い表定義を持ち続ける
    await fresh.query("DROP TABLE p");
    await fresh.query("CREATE TABLE p(a, b)");
    for (let i = 0; i < 20; i++) await stale.query("INSERT INTO p VALUES (?, ?)", [i, i]);
    await fresh.query("SELECT count(*) FROM p"); // 全シャードに最新の DDL を適用させる
    expect((await new Db(c).query("SELECT count(*) c FROM p")).rows).toEqual([{ c: 20 }]);
  });
});

describe("shard numbering", () => {
  it("does not reuse a number when the autoscaler restarts with a stale count", async () => {
    const c = await setup({}, 2);
    await split(c, "s0", "s2");
    await split(c, "s1", "s3");
    const { routing } = await c.catalog();
    const named = { ...routing, ranges: routing.ranges.map((r) => ({ ...r, shard: `x-${r.shard.slice(1)}` })) };
    expect(nextShardNumber(named, "x", 2)).toBe(4);
    expect(nextShardNumber(named, "x", 9)).toBe(9);
  });

  it("refuses a child that already owns another range and leaves the routing as it was", async () => {
    const c = await setup({}, 3);
    const before = (await c.catalog()).routing;
    await expect(split(c, "s0", "s2")).rejects.toThrow(/already owns/);
    expect((await c.catalog()).routing).toEqual(before);
    await insert(c, 1);
    await insert(c, 2);
    expect(await getN(new Db(c), 1)).toBe(0);
  });

  it("still resumes a split whose child already took the range", async () => {
    const c = await setup({}, 2);
    const { routing } = await c.catalog();
    const range = planSplit(routing, "s0")!;
    await split(c, "s0", "s2", { range });
    await expect(split(c, "s0", "s2", { range })).resolves.toBeTruthy();
  });
});

describe("autoscaler decisions", () => {
  const m = (o: Partial<ShardMetrics>): ShardMetrics => ({
    id: "s0", size: 0, reads: 0, writes: 0, elapsedMs: 1000, topGroup: null, migrating: false, ...o,
  });
  const fresh = (): AutoscalerState => ({ over: {}, lastSplit: {} });

  it("waits until the load has been sustained", () => {
    const st = fresh();
    expect(decide([m({ writes: 500 })], st, 0, DEFAULTS)).toEqual([]);
    expect(decide([m({ writes: 500 })], st, 1, DEFAULTS).map((d) => d.kind)).toEqual(["split"]);
  });
  it("resets when the load drops", () => {
    const st = fresh();
    decide([m({ writes: 500 })], st, 0, DEFAULTS);
    decide([m({ writes: 10 })], st, 1, DEFAULTS);
    expect(decide([m({ writes: 500 })], st, 2, DEFAULTS)).toEqual([]);
  });
  it("splits on size immediately after the sustain window", () => {
    const st = fresh();
    decide([m({ size: 2e9 })], st, 0, DEFAULTS);
    expect(decide([m({ size: 2e9 })], st, 1, DEFAULTS)[0]!.reason).toMatch(/size/);
  });
  it("does not treat a slow probe as saturation when the shard is lightly loaded", () => {
    // 本番の追試: 33 シャードへの一斉の問い合わせで、1 シャードあたり約 100/s でも 173 ms になった。
    const st = fresh();
    for (let i = 0; i < 5; i++) expect(decide([m({ writes: 100, probeMs: 173 })], st, i, DEFAULTS)).toEqual([]);
  });
  it("still splits on an extreme probe whatever the measured rate", () => {
    const st = fresh();
    decide([m({ writes: 10, probeMs: 900 })], st, 0, DEFAULTS);
    expect(decide([m({ writes: 10, probeMs: 900 })], st, 1, DEFAULTS).map((d) => d.kind)).toEqual(["split"]);
  });
  it("detects saturation from the probe even when the write rate looks low", () => {
    // 本番で起きた失敗。飽和したシャードは 300/s 程度しか出さず、レートの閾値を超えない。
    const st = fresh();
    const saturated = m({ writes: 300, probeMs: 800 });
    decide([saturated], st, 0, DEFAULTS);
    expect(decide([saturated], st, 1, DEFAULTS).map((d) => d.kind)).toEqual(["split"]);
  });
  it("notifies instead of splitting when one group dominates", () => {
    const st = fresh();
    const hot = m({ writes: 600, topGroup: { g: "[1]", share: 0.9 } });
    decide([hot], st, 0, DEFAULTS);
    expect(decide([hot], st, 1, DEFAULTS).map((d) => d.kind)).toEqual(["notify"]);
  });
  it("respects the cooldown, concurrency limit, and running migrations", () => {
    const st = fresh();
    st.lastSplit.s0 = 0;
    const busy = m({ writes: 500 });
    decide([busy], st, 1, DEFAULTS);
    expect(decide([busy], st, 2, DEFAULTS)).toEqual([]);
    const many = Array.from({ length: 8 }, (_, i) => m({ id: `x${i}`, writes: 500 }));
    const st2 = fresh();
    decide(many, st2, 0, DEFAULTS);
    expect(decide(many, st2, 1, DEFAULTS)).toHaveLength(DEFAULTS.maxConcurrent);
    const st3 = fresh();
    const mig = m({ writes: 500, migrating: true });
    decide([mig], st3, 0, DEFAULTS);
    expect(decide([mig], st3, 1, DEFAULTS)).toEqual([]);
  });
  it("reports a usable window on the first probe after a shard starts", async () => {
    let t = 1_000_000;
    const c = new SimCluster({ shards: 1, now: () => t });
    await new Db(c).ddl(USERS);
    // 要求が 1 件もなければ、経過時間は 0 のままで判断の対象にならない。
    expect((await c.shard("s0").metrics({})).elapsedMs).toBe(0);
    const c2 = new SimCluster({ shards: 1, now: () => t });
    await new Db(c2).ddl(USERS);
    await insert(c2, 1);
    t += 500;
    const first = await c2.shard("s0").metrics({});
    expect(first.writes).toBeGreaterThan(0);
    expect(first.elapsedMs).toBe(500);
  });
  it("keeps ticking only while a shard is over a threshold, migrating, or a split is unfinished", () => {
    const st = fresh();
    decide([m({ writes: 10 })], st, 0, DEFAULTS);
    expect(needsFollowUp([m({ writes: 10 })], st, 0)).toBe(false);
    // 閾値を 1 回超えただけでも追いかける。次の判断を Cron まで待つと、増設が 1 分遅れる。
    decide([m({ writes: 500 })], st, 1, DEFAULTS);
    expect(needsFollowUp([m({ writes: 500 })], st, 0)).toBe(true);
    decide([m({ writes: 10 })], st, 2, DEFAULTS);
    expect(needsFollowUp([m({ writes: 10 })], st, 0)).toBe(false);
    expect(needsFollowUp([m({ migrating: true })], fresh(), 0)).toBe(true);
    expect(needsFollowUp([m({})], fresh(), 1)).toBe(true);
  });
});
