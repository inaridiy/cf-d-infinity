// 範囲の移動の前に T を決めた読みが、移動と ADD COLUMN の後に届く形の乱択 (test/ddl-concurrent.test.ts の 7)。
//
// 移動の後、前の持ち主は、渡した行 (と残した版) を、古い読みに答えるために、しばらく持ち続けることがある (未併合のブランチは約 10 分)。
// M21 の、表定義の変更と移動の排他は move-end で終わるので、その間に ADD COLUMN が確定し得る。古い読み (T が移動より前) が、その後に
// 前の持ち主の行で答えられると、その行は ADD COLUMN の前の形かもしれない。ここでは、その形を作り、答えを T の時点の表と比べる。
//
// 古い読みは、何も読んでいない BEGIN の取引の最初の文で作る。文は、複数のシャードの時計で T を決めてから (ReadScope.pickT)、要求を送る。
// 試験はその要求を止め、その間に移動 (1 回から 3 回。前の持ち主へ戻すこともある) と ADD COLUMN を進める。止めた要求は、古い表定義か
// 古い範囲表で断られ、取引はまだ何も読んでいないので、新しい表定義と範囲表へ移って、同じ T で文をやり直す (Db.query の rebase と reroute)。
// 確定を自分の変更ログに持つシャードは、ADD COLUMN で表定義の変更の床を上げ、T を断る。確定を持たないシャード (行を受け取っただけの子)
// は床を上げないので、行を 1 つのシャードの範囲にだけ入れる実行と、どのシャードにも入れる実行を混ぜる。
// 2 回目からの移動は、前の移動で受け取った区間の中の区間を動かす。一部だけを動かすと、渡した子は範囲表に残って ADD COLUMN を適用し、
// 渡した行の形を直す (未併合のブランチの reshapeKept。欠陥のスイッチ keptOldShape は直さない)。全体を動かすと、子は範囲表から外れ、
// 表定義の変更の参加者でなくなる。どちらの形も作る。
//
// 合格の条件。読みは、T の時点の表 (各行の、T 以下で最後に確定した値と、足した列の既定の値) をそのまま返すか、断るか (read too old、
// conflict、not owner、migrating、stale schema) のどちらかである。行イメージの形は、test/setup.ts の行イメージの検査が別に確かめる。
// 結果は、決めた T のまま答えた、T を進めて答えた、断った、の 3 つに分けて返す。T を進めた読みは古い読みではないが、答えはその T の表と
// 比べる。いまのコードは、移動の後の古い読みを、範囲の床で断る (何も読んでいない取引は、T を進めて読み直す)。
import { Db } from "../src/client/db";
import { keyString } from "../src/keys";
import { regionsOf, SUBSLOTS, tokenOf, type Interval } from "../src/routing";
import { decode, imageColumns } from "../src/shard/rows";
import type { Change, Faults } from "../src/types";
import { decodeElem } from "../src/value";
import { prng } from "./ddl-harness";
import { logRows, SimCluster } from "./sim";

export interface OldReadRun {
  /**
   * 古い読みが、決めた T のまま答えたか、T を進めて答えたか (何も読んでいない取引は、`moved at` で T を進めて読み直せる。Txn.call)、
   * 断られたか。断られたなら、その誤りの文。
   */
  outcome: "answered at its T" | "answered at a later T" | `refused: ${string}`;
  /** 答えと T の時点の表の違い。空なら一致した。 */
  wrong: string[];
  /** 実行の形 (失敗したときに読む)。 */
  shape: string;
}

const REFUSED = /^(read too old|conflict|not owner|migrating|the schema changed)/;
const key = (id: number) => keyString([BigInt(id)]);
const token = (id: number) => tokenOf(key(id), key(id));

/**
 * 区間 x の中の、slot の境目に揃った部分区間を選ぶ。strict なら x より狭くする (渡す側は、残りの区間を持ち続けるので、範囲表に残り、
 * 後の表定義の変更を適用する)。strict でなければ、x の全体のこともある (渡す側は範囲表から外れ、表定義の変更の参加者でなくなる)。
 * 狭い区間には行が入らないので、MIN_SLOTS より狭くはしない。
 */
const MIN_SLOTS = 256;
function subRange(rnd: () => number, x: Interval, strict: boolean): Interval {
  const lo = Math.ceil(x.start / SUBSLOTS);
  const hi = Math.floor(x.end / SUBSLOTS);
  const n = hi - lo;
  if (n < 2 * MIN_SLOTS || (!strict && rnd() < 0.5)) return x;
  const len = MIN_SLOTS + Math.floor(rnd() * (n - MIN_SLOTS));
  const a = lo + Math.floor(rnd() * (n - len + 1));
  return { start: a * SUBSLOTS, end: (a + len) * SUBSLOTS };
}
const within = (x: Interval) => (id: number) => token(id) >= x.start && token(id) < x.end;

/**
 * 表定義の変更の種類 (生成器 7。docs/design-refresh-across-move.md の「乱択の検査に足す生成器」)。
 *   add column: ALTER TABLE t ADD COLUMN (前からある形)。
 *   rename:     ALTER TABLE t RENAME TO u。読み手は、後の名前 u を、移動の前の T で読む。答えは、T の時点の t の行の全部である。
 *   recreate:   DROP TABLE t の後に、同じ名前で、列の違う CREATE TABLE t。読み手は、作り直した t を、移動の前の T で読む。作り直した表は T に
 *               まだなかったので、前の表の行を 1 つも返してはならない (作り直した後に入れた行も、T より後の確定である)。
 * rename と recreate では、読み手は、まず別の表 o を全表で読む (T を決めてから要求を送る文。止めるのは、この文の要求である)。止めた要求は、
 * 古い表定義で断られ、取引はまだ何も読んでいないので、新しい表定義へ移って、同じ T で o を読み直す。次の文が、DDL の後の計画で、
 * 移動の前の T のまま、t の行を読む (M23j の「まだ何も読んでいない取引」の道)。o には行を入れない (行のないシャードに確定を作らない)。
 */
export type OldReadDdl = "add column" | "rename" | "recreate";

export async function oldReadAfterDdl(seed: number, o: { faults?: Faults; noImageCheck?: boolean; kind?: OldReadDdl } = {}): Promise<OldReadRun> {
  const kind = o.kind ?? "add column";
  const rnd = prng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const shards = 2 + Math.floor(rnd() * 2);
  const c = new SimCluster({ shards, seed, faults: o.faults, noImageCheck: o.noImageCheck });
  const db = new Db(c);
  await db.ddl("CREATE TABLE t(id INTEGER PRIMARY KEY, v INTEGER NOT NULL)");
  if (kind !== "add column") await db.ddl("CREATE TABLE o(id INTEGER PRIMARY KEY)");
  /** 書き手が書く表の、いまの名前。 */
  let table = "t";
  const routing0 = (await c.catalog()).routing;
  const home = pick(c.shardIds);
  const [region] = regionsOf(routing0, home);

  // 移動の列。1 回目は home の範囲の中の区間を、2 回目からは、前の移動で受け取った区間の中の区間を動かす。受け取った区間の一部だけを
  // 動かすと、渡した側は残りを持ち続け、範囲表に残る。全体を動かすと、範囲表から外れる。前の持ち主へ戻すこともある。
  const moves = 1 + Math.floor(rnd() * 3);
  const ranges: Interval[] = [];
  for (let i = 0; i < moves; i++) ranges.push(subRange(rnd, ranges[i - 1] ?? region!, rnd() < 0.7));
  // 行は、最後に動く区間、最初に動く区間の残り、(home にだけ入れないなら) ほかのシャードの範囲に置く。home にだけ入れる実行では、
  // ほかのシャードは確定を持たない。
  const homeOnly = rnd() < 0.6;
  const candidates = Array.from({ length: 20000 }, (_v, i) => i + 1);
  const inner = candidates.filter(within(ranges[moves - 1]!)).slice(0, 5 + Math.floor(rnd() * 15));
  const outer = candidates.filter((id) => within(region!)(id) && !within(ranges[moves - 1]!)(id)).slice(0, Math.floor(rnd() * 10));
  const elsewhere = homeOnly ? [] : candidates.filter((id) => !within(region!)(id)).slice(0, Math.floor(rnd() * 10));
  const ids = [...inner, ...outer, ...elsewhere];
  await db.query(`INSERT INTO t VALUES ${ids.map((i) => `(${i}, ${i})`).join(", ")}`);
  const shape: string[] = [`shards ${shards}, home ${home}, ${homeOnly ? "rows on home only" : "rows everywhere"}, rows ${inner.length}+${outer.length}+${elsewhere.length}`];

  let next = shards;
  const owners = [home];
  let moved = 0;
  const move = async () => {
    const range = ranges[moved++]!;
    const from = owners[owners.length - 1]!;
    // 前の持ち主へ戻せるのは、その持ち主が、ほかの範囲を持っていないときだけである (Meta の child-owns)。
    const former = owners.length >= 2 ? owners[owners.length - 2]! : null;
    const free = former !== null && regionsOf((await c.catalog()).routing, former).length === 0;
    const back = free && rnd() < 0.5 ? former : null;
    const to = back ?? `s${next++}`;
    await c.moveAt(from, to, range, [from, to]);
    for (let i = 0; i < 400 && (await c.moves()).length > 0; i++) await c.sleep(50);
    owners.push(to);
    shape.push(`move ${from}->${to} [${range.start}, ${range.end})`);
  };
  const write = async () => {
    const id = pick(ids);
    await db.query(`UPDATE ${table} SET v = v + 1000 WHERE id = ?`, [id]).catch(() => undefined);
    shape.push(`write ${id}`);
  };
  // 読み手が T を決める前に、何回移動するか。T を決めた後に、少なくとも 1 回は動かす。
  const before = Math.floor(rnd() * moves);
  for (let i = 0; i < before; i++) {
    if (rnd() < 0.3) await write();
    await move();
  }
  await c.sleep(Math.floor(rnd() * 30));

  // 古い読み手。T を決めた後の要求を止める。
  const conn = new Db(c);
  await conn.query("BEGIN");
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let holding = true;
  let caught = 0;
  let T0: number | undefined;
  c.net.gate = (m) => {
    if (holding && m.from === "client" && m.method === "exec") {
      caught++;
      T0 ??= (m.req as { T?: number }).T;
      return held;
    }
    return undefined;
  };
  // rename と recreate では、o の読みの要求を止め、DDL の後に、後の表を同じ T で読む。
  const later = kind === "rename" ? "u" : "t";
  const read = kind === "add column"
    ? conn.query("SELECT * FROM t ORDER BY id")
    : conn.query("SELECT id FROM o ORDER BY id").then(() => conn.query(`SELECT * FROM ${later} ORDER BY id`));
  for (let i = 0; i < 400 && caught === 0; i++) await c.sleep(1);
  await c.sleep(2);
  holding = false;
  shape.push(`reader holds ${caught} requests at T ${T0}`);
  for (let i = before; i < moves; i++) {
    if (rnd() < 0.3) await write();
    await move();
  }
  let dflt = "NULL";
  let ddl = false;
  if (kind === "add column") {
    dflt = pick(["NULL", "7", "'d'", "-1"]);
    ddl = rnd() < 0.85;
    if (ddl) {
      await db.ddl(`ALTER TABLE t ADD COLUMN x INTEGER DEFAULT ${dflt}`);
      shape.push(`ADD COLUMN x DEFAULT ${dflt}`);
    }
  } else if (kind === "rename") {
    await db.ddl("ALTER TABLE t RENAME TO u");
    table = "u";
    shape.push("RENAME TO u");
  } else {
    await db.ddl("DROP TABLE t");
    await db.ddl("CREATE TABLE t(id INTEGER PRIMARY KEY, v INTEGER NOT NULL, w TEXT)");
    // 作り直した表へ、前の表と同じ主キーの行を、ときどき入れる (T より後の確定)。
    const again = ids.filter(() => rnd() < 0.3);
    if (again.length > 0) await db.query(`INSERT INTO t VALUES ${again.map((i) => `(${i}, ${-i}, 'new')`).join(", ")}`);
    shape.push(`DROP TABLE t, CREATE TABLE t, ${again.length} new rows`);
  }
  if (rnd() < 0.3) await write();
  // 表定義の変更を適用していないシャード (範囲表から外れて、参加者でなくなった前の持ち主) と、そこに残る渡した行の数 (__handed のある版だけ)。
  const epoch = (await c.catalog()).epoch;
  const behind = [...c.backends].flatMap(([id, b]) => {
    const count = (sql: string) => (b.db.prepare(sql).get() as { n: number | null }).n ?? -1;
    const at = count("SELECT max(epoch) AS n FROM __epoch");
    const handed = count("SELECT count(*) AS n FROM sqlite_master WHERE name = '__handed'") > 0 ? count("SELECT count(*) AS n FROM __handed") : 0;
    return at < epoch ? [`${id}@${at}${handed > 0 ? ` with ${handed} handed rows` : ""}`] : [];
  });
  if (behind.length > 0) shape.push(`behind epoch ${epoch}: ${behind.join(", ")}`);
  release();
  const r = await read.then((q) => q, (e: Error) => e);
  await conn.query("ROLLBACK").catch(() => undefined);
  c.net.gate = () => undefined;
  await c.settle();
  if (r instanceof Error) {
    if (!REFUSED.test(r.message)) return { outcome: `refused: ${r.message}`, wrong: [`unexpected error: ${r.message}`], shape: shape.join(" | ") };
    return { outcome: `refused: ${r.message.replace(/\d+/g, "#").slice(0, 60)}`, wrong: [], shape: shape.join(" | ") };
  }

  // T の時点の表。各行の、T 以下で最後に確定した値を、全部のシャードの変更ログから引く。
  const T = r.ts!;
  const outcome = T === T0 ? "answered at its T" : "answered at a later T";
  if (kind === "recreate") {
    // 作り直した表は、T にはまだなかった (T は DROP より前)。T を進めて読んだなら、作り直した後の T の行は、作り直した表に入れた行だけである。
    const old = r.rows.filter((row) => row.w !== "new");
    const wrong = old.length > 0 ? [`the recreated table read ${old.length} rows of the dropped table at T ${T}: ${JSON.stringify(old.slice(0, 3))}`] : [];
    if (T === T0 && r.rows.length > 0) wrong.push(`the recreated table read ${r.rows.length} rows at T ${T}, before it was created`);
    return { outcome, wrong, shape: `${shape.join(" | ")} | answered at T ${T}` };
  }
  const def = (await c.catalog()).tables[later]!;
  const vAt = imageColumns(def).indexOf("v");
  const versions = new Map<string, { ts: number; v: number | null }>();
  for (const b of c.backends.values()) {
    for (const row of logRows(b)) {
      const ts = row.commit_ts as number;
      if (ts > T) continue;
      for (const ch of decode<Change[]>(row.blob as string)) {
        if (ch.table !== "t" && ch.table !== later) continue;
        const prior = versions.get(ch.pk);
        if (prior && prior.ts > ts) continue;
        const v = ch.after ? decodeElem(ch.after[vAt] ?? null) : null;
        versions.set(ch.pk, { ts, v: typeof v === "bigint" ? Number(v) : (v as number | null) });
      }
    }
  }
  const x = !ddl ? undefined : dflt === "NULL" ? null : dflt === "'d'" ? "d" : Number(dflt);
  const expected = ids.filter((id) => versions.get(key(id))?.v != null).sort((a, b) => a - b).map((id) => ({ id, v: versions.get(key(id))!.v, ...(ddl ? { x } : {}) }));
  const got = r.rows.map((row) => ({ ...row }));
  const wrong: string[] = [];
  const text = (o: unknown) => JSON.stringify(o);
  if (got.length !== expected.length) wrong.push(`read ${got.length} rows at T ${T}, the table had ${expected.length}`);
  const want = new Map(expected.map((e) => [e.id, text(e)]));
  for (const row of got) {
    const w = want.get(row.id as number);
    if (w !== text(row)) wrong.push(`row ${text(row)} at T ${T}, expected ${w ?? "no row"}`);
  }
  return { outcome, wrong: wrong.slice(0, 5), shape: `${shape.join(" | ")} | answered at T ${T}` };
}
