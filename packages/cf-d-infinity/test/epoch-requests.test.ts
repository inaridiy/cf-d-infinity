// 要求が運ぶ epoch と表定義の epoch を、シャードがどう確かめるか (docs/design-catalog-epoch.md の段 2 の「要求ごとの確かめ」)。
// M21 (specs/m21_catalog_epoch.qnt) の、段 2 が届く赤の再生である (docs/model-coverage.md の M21 の行)。
//
//   m21_red_stale            シャードが古い表定義の計画を断らない。スイッチはない (守りだけを再生する)。
//   m21_red_owner_unchecked  シャードが所有を自分のスナップショットで引かない。スイッチは ignoreFence (段 2 で意味を広げた)。
//   m21_red_strict_epoch     シャードが epoch が等しいことを求める。安全性の欠陥ではなく、動いていない行の取引を巻き込む。
//                            test/transaction-on-unmoved-rows-across-split.test.ts が守る。ここでは、シャードへ直に送る形で確かめる。
//   m21_red_no_recheck       待ちの後で表定義を確かめ直さない。スイッチは noSchemaRecheck。test/stale-plan-after-wait.test.ts が再生する。
//
// 要求は、シャードへ直に送る (Worker の計画を通さない)。宛先と、要求が名乗る 2 つの数を、試験が選ぶためである。
import { afterEach, describe, expect, it } from "vitest";
import { split } from "../src/autoscaler";
import { Db } from "../src/client/db";
import { keyString } from "../src/keys";
import { ownerOf, planSplit, tokenOf } from "../src/routing";
import type { ExecReq, Faults, Span } from "../src/types";
import { rawRows } from "./ddl-harness";
import type { Catalog } from "../src/meta";
import { allWriteEscapes, depsFor, SimCluster } from "./sim";

afterEach(() => {
  allWriteEscapes.length = 0; // 持ち主でないシャードへの書き込みは、ここで数えて確かめる。全体の検査には渡さない
});

const key = (id: number) => keyString([BigInt(id)]);
const pkSpan = (id: number): Span => ({ kind: "pk", table: "t", pk: key(id), sk: key(id) });
const outcome = (p: Promise<unknown>) => p.then(() => "ok", (e: Error) => e.message);
/** シャードの写し (__epoch) の最後の epoch。 */
const applied = (c: SimCluster, id: string) => (c.backends.get(id)!.exec(`SELECT max(epoch) AS e FROM __epoch`)[0]?.e as number | null) ?? -1;

/** 2 シャードと表 t。どちらのシャードにも行を 1 つずつ入れる。 */
async function scene(faults: Faults = {}) {
  const c = new SimCluster({ shards: 2, faults });
  const db = new Db(c);
  await db.ddl("CREATE TABLE t(id INTEGER PRIMARY KEY, v INTEGER NOT NULL)");
  const { routing } = await c.catalog();
  const on = (shard: string) => { for (let i = 1; ; i++) if (ownerOf(routing, key(i)) === shard) return i; };
  const [a, b] = [on("s0"), on("s1")];
  await db.query("INSERT INTO t VALUES (?, 1), (?, 1)", [a, b]);
  // s1 のもので、まだ行のない主キー。
  let fresh = b + 1;
  while (ownerOf(routing, key(fresh)) !== "s1") fresh++;
  return { c, a, b, fresh };
}
/** 行 id を入れる autocommit の要求。cat の表 t の epoch と、cat の epoch を運ぶ。 */
const insert = (id: number, cat: Catalog): ExecReq => ({
  sql: "INSERT INTO t VALUES (?, 1)", params: [BigInt(id)], columns: [], spans: [pkSpan(id)],
  write: { sk: key(id), capture: "insert" }, deps: depsFor(cat, [], ["t"]), epoch: cat.epoch,
});
/** 行 id を書く autocommit の要求。cat の表 t の epoch と、cat の epoch を運ぶ。 */
const write = (id: number, v: number, cat: Catalog): ExecReq => ({
  sql: "UPDATE t SET v = ? WHERE id = ?", params: [BigInt(v), BigInt(id)], columns: [], spans: [pkSpan(id)],
  write: { sk: key(id), capture: "update" }, deps: depsFor(cat, [], ["t"]), epoch: cat.epoch,
});

describe("the shard checks the epochs of the tables a request depends on (m21_red_stale, guard-only)", () => {
  it("refuses a request planned before a DDL on its table committed, whatever epoch it carries", async () => {
    const { c, a } = await scene();
    const before = await c.catalog();
    await new Db(c).ddl("ALTER TABLE t ADD COLUMN note TEXT");
    const after = await c.catalog();
    expect(after.schema).toBeGreaterThan(before.schema);
    expect(after.objects.t!.read).toBeGreaterThan(before.objects.t!.read);
    // 古い表定義で計画した書き込みは、新しい epoch を名乗っても、表 t の epoch で断る。
    expect(await outcome(c.shard("s0").execAuto(write(a, 2, before)))).toMatch(/^not owner: stale schema: t /);
    expect(await outcome(c.shard("s0").execAuto(write(a, 2, { ...before, epoch: after.epoch })))).toMatch(/^not owner: stale schema: t /);
    expect(await outcome(c.shard("s0").execAuto(write(a, 2, after)))).toBe("ok");
  });

  // 表ごとの epoch (docs/design-catalog-epoch.md の「表ごとの epoch」、M24 の noRefusalUnrelated)。別の表の DDL は、要求を古くしない。
  it("serves a request planned before a DDL on another table committed", async () => {
    const { c, a } = await scene();
    const before = await c.catalog();
    await new Db(c).ddl("CREATE TABLE u(id INTEGER PRIMARY KEY)");
    await new Db(c).ddl("ALTER TABLE u ADD COLUMN note TEXT");
    const after = await c.catalog();
    expect(after.schema).toBeGreaterThan(before.schema);
    expect(after.objects.t).toEqual(before.objects.t);
    expect(await outcome(c.shard("s0").execAuto(write(a, 2, before)))).toBe("ok");
  });

  // 読みの epoch と書き込みの epoch。index を作るだけの DDL は、表の書き込みの epoch だけを進める。
  it("after a plain CREATE INDEX, refuses a write planned before it and serves a read planned before it", async () => {
    const { c, a } = await scene();
    const before = await c.catalog();
    await new Db(c).ddl("CREATE INDEX tv ON t(v)");
    const after = await c.catalog();
    expect([after.objects.t!.read, after.objects.t!.write > before.objects.t!.write]).toEqual([before.objects.t!.read, true]);
    const read: ExecReq = { sql: "SELECT v FROM t WHERE id = ?", params: [BigInt(a)], columns: ["v"], spans: [pkSpan(a)], deps: depsFor(before, ["t"]), epoch: before.epoch };
    expect(await outcome(c.shard("s0").exec(read))).toBe("ok");
    expect(await outcome(c.shard("s0").execAuto(write(a, 2, before)))).toMatch(/^not owner: stale schema: t is at write epoch/);
    expect(await outcome(c.shard("s0").execAuto(write(a, 2, after)))).toBe("ok");
  });

  it("put back with writeComparesRead: a write planned before a CREATE INDEX is accepted (m24_red_write_epoch)", async () => {
    const { c, a } = await scene({ writeComparesRead: true });
    const before = await c.catalog();
    await new Db(c).ddl("CREATE INDEX tv ON t(v)");
    expect(await outcome(c.shard("s0").execAuto(write(a, 2, before)))).toBe("ok");
  });

  it("applies the log first when the request's schema epoch is newer than its own", async () => {
    const { c, a } = await scene();
    // Meta にだけ記録する。どのシャードにも適用させない。
    const cat = await c.applyDdl("ALTER TABLE t ADD COLUMN note TEXT");
    expect(applied(c, "s0")).toBeLessThan(cat.epoch);
    expect(await outcome(c.shard("s0").execAuto({ ...write(a, 2, cat), sql: "UPDATE t SET note = 'x' WHERE id = ?", params: [BigInt(a)] }))).toBe("ok");
    expect(applied(c, "s0")).toBe(cat.epoch);
  });
});

describe("the shard looks ownership up in its own snapshot (m21_red_owner_unchecked)", () => {
  // 範囲表で s1 のものである行の書き込みを、s0 へ直に送る。s0 は、その範囲を一度も持たず、手放した記録 (__fenced) もない。
  // 段 2 より前のシャードは、手放した範囲だけを断ったので、これを受けた (書き込みの守り claimed も、宣言の中の行なので通した)。
  it("refuses a row that its snapshot gives to another shard, though it never handed that row over", async () => {
    const { c, b, fresh } = await scene();
    const cat = await c.catalog();
    expect(await outcome(c.shard("s0").execAuto(write(b, 2, cat)))).toBe("not owner: s1");
    expect(await outcome(c.shard("s0").execAuto(insert(fresh, cat)))).toBe("not owner: s1");
    expect(await outcome(c.shard("s0").exec({ ...write(b, 2, cat), write: undefined, sql: "SELECT v FROM t WHERE id = ?", params: [BigInt(b)], columns: ["v"] }))).toBe("not owner: s1");
    expect((await rawRows(c, "t")).filter((r) => Number(r.row.id) === b).map((r) => `${r.shard} ${Number(r.row.v)}`)).toEqual(["s1 1"]);
    expect(c.writeEscapes).toEqual([]);
  });

  it("put back with ignoreFence: the shard stores the row, though the range table gives it to another shard", async () => {
    const { c, fresh } = await scene({ ignoreFence: true });
    const cat = await c.catalog();
    expect(await outcome(c.shard("s0").execAuto(insert(fresh, cat)))).toBe("ok");
    expect(c.writeEscapes.map((e) => `${e.shard} ${e.problem}`)).toEqual([expect.stringMatching(/^s0 the row would stay on s0, which does not own token/)]);
  });

  it("refuses a whole-table read whose claim its snapshot does not give it", async () => {
    const { c } = await scene();
    const cat = await c.catalog();
    const claim = cat.routing.ranges.map((r) => ({ start: r.start, end: r.end }));
    const req: ExecReq = { sql: "SELECT id FROM t", params: [], columns: ["id"], spans: [{ kind: "table", table: "t", claim }], deps: depsFor(cat, ["t"]), epoch: cat.epoch };
    expect(await outcome(c.shard("s0").exec(req))).toBe("not owner: s1");
  });
});

describe("the shard does not require the request's epoch to equal its own (m21_red_strict_epoch)", () => {
  it("serves an unmoved row to a request planned before a split that the shard has applied", async () => {
    const { c } = await scene();
    const old = await c.catalog();
    const range = planSplit(old.routing, "s0")!;
    const unmoved = (() => { for (let i = 1; ; i++) { const t = tokenOf(key(i), key(i)); if (ownerOf(old.routing, key(i)) === "s0" && (t < range.start || t >= range.end)) return i; } })();
    await new Db(c).query("INSERT OR REPLACE INTO t VALUES (?, 1)", [unmoved]);
    await split(c, "s0", "s2", { range });
    // 親に、分割の記録を適用させる (表定義の変更を全シャードへ適用させると、親は列の続きを全部適用する)。
    await new Db(c).ddl("CREATE TABLE u(id INTEGER PRIMARY KEY)");
    const now = await c.catalog();
    expect(applied(c, "s0")).toBe(now.epoch);
    // 分割の前のスナップショットで計画した、動いていない行の書き込み。その後に確定したのは別の表の DDL なので、表 t の epoch は古くない。
    expect(await outcome(c.shard("s0").execAuto(write(unmoved, 5, old)))).toBe("ok");
    expect(await outcome(c.shard("s0").execAuto(write(unmoved, 6, { ...now, epoch: 0 })))).toBe("ok");
  });

  it("serves a request with a newer epoch for a row it owns without fetching the log", async () => {
    const { c, b } = await scene();
    const range = planSplit((await c.catalog()).routing, "s0")!;
    const before = applied(c, "s1");
    await split(c, "s0", "s2", { range });
    const cat = await c.catalog();
    // s1 は分割に関わらない。分割の記録を知らないまま、新しい epoch の要求に答える。
    expect(await outcome(c.shard("s1").execAuto(write(b, 3, cat)))).toBe("ok");
    expect(applied(c, "s1")).toBe(before);
  });
});
