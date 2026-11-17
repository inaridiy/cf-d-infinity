// 生成器 6 (docs/design-refresh-across-move.md の「乱択の検査に足す生成器」)。表の作り直しと、範囲の分割 (test/ddl-concurrent.test.ts の 8)。
//
// 移行の道具 (drizzle-kit) は、表を作り直すときに、1 つの取引の中で、新しい表を作り、古い表の行を写し、古い表を DROP し、新しい表の
// 名前を変える。DROP は、取引が読んだ表を消すので、読んだ後に別の接続が書いていないかを確かめる (Db.changeSchema の mode guard、
// specs/m14_rebuild_guard.qnt)。ここでは、写す文が古い表を読んだ後、DROP の前に、読んだ範囲を分割する。別の接続は、分割の前か後に
// 古い表へ書くこともあり、書かないこともある。分割の後の書き込みは、DROP の前か、DROP の表定義の遷移の prepare がシャードへ届く前
// (写した区切りの確定の後で、書き込みの禁止の前。DROP の前の確かめだけが守る窓) に置く。DROP の前の確かめも、写した区切りの確定の
// 検証も、移動をまたいで通らなければならない (M23i、M23)。
//
// 合格の条件。
//   - 書き込みがあったなら、DROP は通らない (通ると、写した後の書き込みが失われる)。DROP が断られたら、取引を戻し、古い表に、書き込みが
//     全部残る。断るのは、競合か、範囲の移動による拒否である。
//   - DROP が通ったなら、作り直した表は、写した時点の古い表の行と同じである。
//   - 書き込みがなければ、DROP は通る (規則 4。分割がなければ通る)。foundation-4 (517b674) のコードは、写した区切りの確定の検証を、
//     読んだときのシャード (分割の親) へ送り、親は手放した区間を確かめないので、DROP が `not owner` か `conflict: not owner` で失敗する
//     (未解決の問題 37。test/open/rebuild-across-split.test.ts)。DROP の前の確かめも、読んだときのシャードへ送る (M23i の
//     m23i_red_no_rehome。docs/design-refresh-across-move.md の仮の名前は guardToReader)。既定の実行では、この断りを数えて許す
//     (refusedWithoutWrites)。OPEN=1 では許さない。
import { split } from "../src/autoscaler";
import { Db } from "../src/client/db";
import { keyString } from "../src/keys";
import { ownerOf, regionsOf, SUBSLOTS, tokenOf } from "../src/routing";
import type { Faults } from "../src/types";
import { prng, SimCluster } from "./sim";

export interface RebuildRun {
  /** DROP の結果。 */
  drop: "ok" | `refused: ${string}`;
  /** 写した後に、別の接続が古い表へ書いて確定した数 (分割の前と後)。 */
  writes: { before: number; after: number };
  /** 写す文が読んだ範囲の一部が、DROP の前に別のシャードへ動いたか (危険な形)。 */
  moved: boolean;
  /** 書き込みがないのに断られた (規則 4 に反する。foundation-4 では既知)。 */
  refusedWithoutWrites: boolean;
  wrong: string[];
  shape: string;
}

const key = (id: number) => keyString([BigInt(id)]);
const token = (id: number) => tokenOf(key(id), key(id));
const outcome = (p: Promise<unknown>) => p.then(() => "ok" as const, (e: Error) => `refused: ${e.message}` as const);

export async function rebuildAcrossSplit(seed: number, o: { faults?: Faults; strict?: boolean } = {}): Promise<RebuildRun> {
  const rnd = prng(seed * 104729 + 13);
  const shards = 1 + Math.floor(rnd() * 2);
  const c = new SimCluster({ shards, seed, faults: o.faults });
  const admin = new Db(c);
  await admin.ddl("CREATE TABLE t(id INTEGER PRIMARY KEY, v INTEGER NOT NULL)");
  const rows = 20 + Math.floor(rnd() * 20);
  const ids = Array.from({ length: rows }, (_v, i) => i + 1);
  await admin.query(`INSERT INTO t VALUES ${ids.map((i) => `(${i}, ${i})`).join(", ")}`);
  const { routing } = await c.catalog();
  // 分割する親と区間。親の区間の、slot の境目で切った後ろの部分を、新しいシャードへ動かす。
  const parent = `s${Math.floor(rnd() * shards)}`;
  const [region] = regionsOf(routing, parent);
  const first = Math.ceil(region!.start / SUBSLOTS) + 1;
  const last = Math.floor(region!.end / SUBSLOTS) - 1;
  const cut = (first + Math.floor(rnd() * (last - first + 1))) * SUBSLOTS;
  const range = { start: cut, end: region!.end };
  const moving = ids.filter((id) => token(id) >= range.start && token(id) < range.end);
  const staying = ids.filter((id) => !moving.includes(id));
  const shape: string[] = [`shards ${shards}, rows ${rows}, split ${parent} at ${cut}: ${moving.length} rows move`];

  // 作り直す取引。写す文 (INSERT … SELECT) が古い表を読む。
  const db = new Db(c, { retries: 0 });
  await db.query("BEGIN");
  await db.query("CREATE TABLE __new_t(id INTEGER PRIMARY KEY, v INTEGER NOT NULL, w INTEGER)");
  await db.query("INSERT INTO __new_t(id, v) SELECT id, v FROM t");
  const copied = new Map(ids.map((id) => [id, id]));

  // 別の接続の書き込み。分割の前と後に、動く行か残る行へ書く (書かないこともある)。
  let other = new Db(c);
  const expected = new Map(copied);
  const writes = { before: 0, after: 0 };
  const write = async (when: "before" | "after") => {
    const pool = rnd() < 0.6 && moving.length > 0 ? moving : staying.length > 0 ? staying : moving;
    const id = pool[Math.floor(rnd() * pool.length)]!;
    const insert = rnd() < 0.3;
    const sql = insert ? "INSERT INTO t VALUES (?, ?)" : "UPDATE t SET v = v + 1000 WHERE id = ?";
    const fresh = 1000 + Math.floor(rnd() * 1000) * 7 + (when === "before" ? 1 : 2);
    const r = await outcome(other.query(sql, insert ? [BigInt(fresh), BigInt(fresh)] : [BigInt(id)]));
    if (r !== "ok") {
      shape.push(`write ${when} failed: ${r.slice(0, 60)}`);
      return;
    }
    if (insert) expected.set(fresh, fresh);
    else expected.set(id, expected.get(id)! + 1000);
    writes[when]++;
    shape.push(`write ${when} ${insert ? `insert ${fresh}` : `update ${id}`} (${insert ? "" : moving.includes(id) ? "moving" : "staying"})`);
  };
  if (rnd() < 0.35) await write("before");
  await split(c, parent, `s${shards}`, { range });
  const moved = moving.length > 0 && ownerOf((await c.catalog()).routing, key(moving[0]!)) !== parent;
  // 分割の後の書き込みは、DROP の前か、DROP の表定義の遷移の prepare がシャードへ届く前 (DROP の前の確定の後で、書き込みの禁止の前。
  // DROP の前の確かめだけが守る窓。test/rebuild-guard.test.ts と同じ止め方)。後者の書き手は、prepare の前の表定義を持つ。
  const after = rnd();
  if (after < 0.25) await write("after");
  let releasePrepare!: () => void;
  const prepareHeld = new Promise<void>((r) => (releasePrepare = r));
  let holding = after >= 0.25 && after < 0.6;
  let reached = false;
  const snapshot = await c.catalog();
  c.net.gate = (m) => {
    if (!holding || m.method !== "prepared") return undefined;
    reached = true;
    return prepareHeld;
  };
  const dropping = outcome(db.query("DROP TABLE t"));
  let settled = false;
  void dropping.then(() => (settled = true));
  if (holding) {
    for (let i = 0; i < 400 && !reached && !settled; i++) await c.sleep(1);
    if (reached) {
      const late = new Db(c, { catalog: snapshot });
      const keep = other;
      other = late;
      await write("after");
      other = keep;
      shape.push("(the last write was made while the DROP's prepare was held)");
    }
    holding = false;
    releasePrepare();
  }
  const drop = await dropping;
  c.net.gate = () => undefined;
  shape.push(`DROP ${drop.slice(0, 80)}`);
  if (drop === "ok") {
    const rename = await outcome(db.query("ALTER TABLE __new_t RENAME TO t"));
    const commit = rename === "ok" ? await outcome(db.query("COMMIT")) : await outcome(db.query("ROLLBACK"));
    shape.push(`RENAME ${rename.slice(0, 60)}, COMMIT ${commit.slice(0, 60)}`);
  } else {
    await db.query("ROLLBACK").catch(() => undefined);
  }
  await c.settle();

  const wrong: string[] = [];
  const wrote = writes.before + writes.after > 0;
  if (wrote && drop === "ok") wrong.push(`DROP passed although another connection wrote the table after the copy read it (${writes.before} before the split, ${writes.after} after)`);
  // 断るのは、競合か、範囲の移動による拒否である (foundation-4 では、DROP の前の確定が `not owner` で断られることがある。未解決の問題 37)。
  if (drop !== "ok" && !/^refused: (conflict|not owner|read too old|migrating)/.test(drop)) wrong.push(`DROP failed with ${drop}, not with a refusal`);
  const refusedWithoutWrites = !wrote && drop !== "ok";
  if (refusedWithoutWrites && o.strict) wrong.push(`DROP was refused although nobody wrote the table after the copy read it (${drop.slice(0, 120)})`);
  // 表の中身。DROP が通れば、作り直した表は写した行と同じで、断られれば、古い表に書き込みが全部残る。
  const want = drop === "ok" ? copied : expected;
  const got = new Map((await new Db(c).query("SELECT id, v FROM t ORDER BY id")).rows.map((r) => [Number(r.id), Number(r.v)]));
  for (const id of new Set([...want.keys(), ...got.keys()])) {
    if (got.get(id) !== want.get(id)) wrong.push(`row ${id} is ${got.get(id) ?? "missing"} after the rebuild, expected ${want.get(id) ?? "no row"}`);
  }
  return { drop, writes, moved, refusedWithoutWrites, wrong: wrong.slice(0, 5), shape: shape.join(" | ") };
}
