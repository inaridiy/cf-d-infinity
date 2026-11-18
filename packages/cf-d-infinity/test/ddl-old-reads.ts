// 範囲の移動の前に T を決めた読みが、移動と ADD COLUMN の後に届く形の乱択 (test/ddl-concurrent.test.ts の 7)。
//
// 移動の後、前の持ち主は、渡した行 (と残した版) を、古い読みに答えるために、しばらく持ち続けることがある (未併合のブランチは約 10 分)。
// M21 の、表定義の変更と移動の排他は move-end で終わるので、その間に ADD COLUMN が確定し得る。古い読み (T が移動より前) が、その後に
// 前の持ち主の行で答えられると、その行は ADD COLUMN の前の形かもしれない。ここでは、その形を作り、答えを T の時点の表と比べる。
//
// 古い読みは、何も読んでいない BEGIN の取引の最初の文で作る。文は、複数のシャードの時計で T を決めてから (ReadScope.pickT)、要求を送る。
// 試験はその要求を止め、その間に移動 (1 回から 3 回。前の持ち主へ戻すこともある。T の後には移動しない実行もある) と ADD COLUMN を進める。
// 止めた要求は、古い表定義か古い範囲表で断られ、取引はまだ何も読んでいないので、新しい表定義と範囲表へ移って、同じ T で文をやり直す
// (Db.query の rebase と reroute)。読み手の形は、下の OldReadDdl の「読み手の形」に書いた。
// 確定を自分の変更ログに持つシャードは、ADD COLUMN で表定義の変更の床を上げ、T を断る。確定を持たないシャード (行を受け取っただけの子)
// は床を上げないので、行を 1 つのシャードの範囲にだけ入れる実行と、どのシャードにも入れる実行を混ぜる。
// 2 回目からの移動は、前の移動で受け取った区間の中の区間を動かす。一部だけを動かすと、渡した子は範囲表に残って ADD COLUMN を適用し、
// 渡した行の形を直す (未併合のブランチの reshapeKept。欠陥のスイッチ keptOldShape は直さない)。全体を動かすと、子は範囲表から外れ、
// 表定義の変更の参加者でなくなる。どちらの形も作る。
//
// 合格の条件。読みは、T の時点の表 (各行の、T 以下で最後に確定した値と、足した列の既定の値) をそのまま返すか、断るか (read too old、
// conflict、not owner、migrating、stale schema) のどちらかである。行イメージの形は、test/setup.ts の行イメージの検査が別に確かめる。
// 結果は、決めた T のまま答えた、T を進めて答えた、断った、スナップショットのまま続いた、の 4 つに分けて返す。T を進めた読みは古い読み
// ではないが、答えはその T の表と比べる。いまのコードは、移動の後の古い読みを、範囲の床で断る (何も読んでいない取引は、T を進めて読み
// 直す)。T の後に移動しなければ、DDL の後の表定義で計画した読みを、DDL の前の T のまま、表の床で答えるか断る (M23j)。
import { Db } from "../src/client/db";
import { keyString } from "../src/keys";
import type { Catalog } from "../src/meta";
import { regionsOf, SUBSLOTS, tokenOf, type Interval } from "../src/routing";
import { decode, imageColumns } from "../src/shard/rows";
import type { Change, Faults } from "../src/types";
import { decodeElem } from "../src/value";
import { prng } from "./ddl-harness";
import { logRows, SimCluster } from "./sim";

export interface OldReadRun {
  /**
   * 古い読みが、決めた T のまま答えたか、T を進めて答えたか (何も読んでいない取引は、`moved at` で T を進めて読み直せる。Txn.call)、
   * 断られたか。断られたなら、その誤りの文。kept its snapshot は、取引が DDL の前のスナップショットのまま続き、後の名前の表を
   * 知らなかった (`no such table`) ことである (docs/sql-language.md の「取引の中の DDL」。SQLite の WAL でも同じ)。
   */
  outcome: "answered at its T" | "answered at a later T" | `refused: ${string}` | `kept its snapshot: ${string}`;
  /** 答えと T の時点の表の違い。空なら一致した。 */
  wrong: string[];
  /** 実行の形 (失敗したときに読む)。 */
  shape: string;
  /**
   * 読み手が、DDL の後の表定義で計画した後の表の読みを、DDL の前に決めた T のまま送ったか。T の後に移動があれば、シャードは、その読みを
   * 範囲の床で先に断る。移動がなければ、表の床 (M23j の m23j_exact_*。表の、変更ログにある確定の時刻の最大) で答えるか断るかを決める。
   * DDL がなかった実行では false である。
   */
  plannedAfterDdl: boolean;
  /** 実行の形のうち、数えるもの (test/ddl-concurrent.test.ts の 7 と 7b が、既定の seed で、どの形も起きることを確かめる)。 */
  counts: {
    /** T を決めた後に移動しなかった。 */
    quiet: boolean;
    /** 読み手の最初の文が断られ、DDL の後の表定義へ移って、同じ T で答えた (o の DDL か、t そのものの DDL で)。 */
    rebased: boolean;
    /** rebased のうえ、最初の文の後に o が書かれ、取引は T を進められない。後の表の読みは、表の床だけで決まる (下の pinned)。 */
    pinned: boolean;
    /** pinned で、後の表の読みを、表の床が断った (T と DDL の間に、その表の確定があった)。 */
    floorRefused: boolean;
  };
}

const REFUSED = /^(read too old|conflict|not owner|migrating|the schema changed)/;

/** 読み手の Db が開いている取引の表定義 (取引が最初に読むか書くかしたときのスナップショット。Txn.catalog)。試験だけが覗く。 */
const openSnapshot = (conn: Db): Catalog | undefined => (conn as unknown as { current: { catalog: Catalog } | null }).current?.catalog;
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
 *
 * 読み手の形。
 *   直接 (add column の半分): 最初の文が t を読む。止めた要求は、t の古い表定義で断られ、取引はまだ何も読んでいないので、新しい表定義へ
 *       移って、同じ T で t を読み直す (Db.query の rebase。M23j の「まだ何も読んでいない取引」の道)。
 *   o の後 (ほかの全部): まず別の表 o を全表で読み (T を決めてから要求を送る文。止めるのは、この文の要求である)、次の文で後の表を読む。
 *       表ごとの epoch (5808b08) からは、t の DDL は、o だけを読む要求を断らない。o の要求が DDL の前のスナップショットで答えれば、取引は
 *       そのスナップショットのまま続き、後の表は、古い計画で断られるか (stale schema)、まだない (RENAME の後の u。kept its snapshot)。
 *       T を決めた後の DDL の間に、o にも列を足す実行 (oDdl) を混ぜる。o の要求は、o の古い表定義で断られ、取引はまだ何も読んでいないので、
 *       DDL の後の表定義へ移り、同じ T で o を読み直す。T は DDL の前に決まったまま、取引はまだ後の表を使っていない。次の文が、DDL の
 *       後の表定義で、DDL の前の T のまま後の表を読む (M23j の床の道)。
 *   pinned (oDdl の一部): o の読みが答えた後、別の接続が o に 1 行入れる。取引は、読んだ o が変わったので T を進められず
 *       (Txn.refreshTo が断られる)、後の表の読みを、新しい確定を知らせてもらわずに T のまま送る。答えは表の床だけで決まる。T と DDL の間に
 *       その表の確定がなければ、T の時点の表を答え (RENAME の後の名前は、T の時点の t の行の全部、作り直した表は空)、あれば `read too old`
 *       で断る。T を決めた後に移動した実行では、範囲の床が先に断るので、最初の文が T を進める。
 * T を決めた後に移動しない実行 (quiet) を、半分ほど混ぜる。移動があれば、範囲の床が T を断るので、表の床に届かない (5808b08 の生成器は、
 * いつも T の後に移動したので、seed 1 から 600 のどの実行も、決めた T のまま答えなかった)。
 * o は、読み手の最初の文の対象である。行は、pinned の 1 行のほかは入れない (行のないシャードに確定を作らない)。
 */
export type OldReadDdl = "add column" | "rename" | "recreate";

export async function oldReadAfterDdl(seed: number, o: { faults?: Faults; noImageCheck?: boolean; kind?: OldReadDdl } = {}): Promise<OldReadRun> {
  const kind = o.kind ?? "add column";
  const rnd = prng(seed);
  // 読み手の形と、T の後の移動の有無は、別の乱数の列から引く。移動と行の置き方の列は、前のままである。
  const alt = prng(seed * 7919 + 101);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const shards = 2 + Math.floor(rnd() * 2);
  const c = new SimCluster({ shards, seed, faults: o.faults, noImageCheck: o.noImageCheck });
  const db = new Db(c);
  await db.ddl("CREATE TABLE t(id INTEGER PRIMARY KEY, v INTEGER NOT NULL)");
  await db.ddl("CREATE TABLE o(id INTEGER PRIMARY KEY)");
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
  // 読み手の形 (上の「読み手の形」)。
  const quiet = alt() < 0.5;
  const direct = kind === "add column" && alt() < 0.5;
  const oDdl = !direct && alt() < 0.75;
  const pin = oDdl && alt() < 0.6;
  // 読み手が T を決める前に、何回移動するか。quiet でなければ、T を決めた後に、少なくとも 1 回は動かす。
  const drawn = Math.floor(rnd() * moves);
  const before = quiet ? moves : drawn;
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
  /** 止めるのをやめた後に Worker が送った exec の、時刻と頼るもの (plannedAfterDdl を決める)。 */
  const sent: { T?: number; deps: { name: string; epoch: number }[] }[] = [];
  c.net.gate = (m) => {
    if (m.from === "client" && m.method === "exec") {
      const req = m.req as { T?: number; deps?: { name: string; epoch: number }[] };
      if (holding) {
        caught++;
        T0 ??= req.T;
        return held;
      }
      sent.push({ T: req.T, deps: req.deps ?? [] });
    }
    return undefined;
  };
  const later = kind === "rename" ? "u" : "t";
  const first = direct ? conn.query("SELECT * FROM t ORDER BY id") : conn.query("SELECT id FROM o ORDER BY id");
  for (let i = 0; i < 400 && caught === 0; i++) await c.sleep(1);
  await c.sleep(2);
  holding = false;
  shape.push(`reader ${direct ? "reads t first" : `reads o first${oDdl ? ", o changes" : ""}${pin ? ", pinned" : ""}`}, holds ${caught} requests at T ${T0}`);
  for (let i = before; i < moves; i++) {
    if (rnd() < 0.3) await write();
    await move();
  }
  // T を決めた後に移動しない実行では、T と DDL の間に、ときどき t を書く (その表の床が T より上に来る)。
  if (quiet && alt() < 0.5) await write();
  /** DDL の前の、最後の確定の時刻。T より後で、これ以下の t の確定が、表の床を T より上に置く。 */
  const lastBeforeDdl = Math.max(0, ...[...c.backends.values()].flatMap((b) => logRows(b).map((row) => row.commit_ts as number)));
  // o の DDL は、t の DDL の前か後に置く (2 つの表を変える移行)。
  const oFirst = alt() < 0.5;
  const changeO = async () => {
    await db.ddl("ALTER TABLE o ADD COLUMN z INTEGER");
    shape.push("o ADD COLUMN z");
  };
  if (oDdl && oFirst) await changeO();
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
    // 作り直した表へ、前の表と同じ主キーの行を、半分の実行で入れる (T より後の確定)。
    const refill = alt() < 0.5;
    const again = ids.filter(() => rnd() < 0.3 && refill);
    if (again.length > 0) await db.query(`INSERT INTO t VALUES ${again.map((i) => `(${i}, ${-i}, 'new')`).join(", ")}`);
    shape.push(`DROP TABLE t, CREATE TABLE t, ${again.length} new rows`);
  }
  if (oDdl && !oFirst) await changeO();
  const tChanged = kind !== "add column" || ddl;
  // 後の表の、DDL の後の読みの epoch。読み手の要求が、これ以上の epoch で後の表に頼れば、DDL の後の表定義で計画した文である。
  const laterEpoch = tChanged ? (await c.catalog()).objects[later]?.read : undefined;
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
  let r: Awaited<typeof first> | Error = await first.then((q) => q, (e: Error) => e);
  /** 最初の文が答えた時刻。o の後の読み手は、これが T0 なら、T を DDL の前のまま、DDL の後の表定義へ移った。 */
  const firstAt = r instanceof Error ? undefined : r.ts;
  const rebased = firstAt === T0 && (direct ? tChanged : oDdl);
  let pinned = false;
  if (!direct && !(r instanceof Error)) {
    if (pin) {
      await db.query("INSERT INTO o(id) VALUES (1)");
      pinned = rebased;
      shape.push("o written after the first read");
    }
    r = await conn.query(`SELECT * FROM ${later} ORDER BY id`).then((q) => q, (e: Error) => e);
  }
  const snapshot = openSnapshot(conn);
  await conn.query("ROLLBACK").catch(() => undefined);
  c.net.gate = () => undefined;
  await c.settle();
  const plannedAfterDdl = laterEpoch !== undefined && sent.some((s) => s.T === T0 && s.deps.some((d) => d.name === later && d.epoch >= laterEpoch));
  // pinned の実行では、後の表の読みは、表の床だけで決まる。T と DDL の間に、DDL の前の名前 t の確定があれば、床が T より上にあり、
  // 断らなければならない。なければ、T のまま答えなければならない。
  const tWritten = [...c.backends.values()].some((b) => logRows(b).some((row) => {
    const ts = row.commit_ts as number;
    return T0 !== undefined && ts > T0 && ts <= lastBeforeDdl && decode<Change[]>(row.blob as string).some((ch) => ch.table === "t");
  }));
  const mustRefuse = pinned && tChanged && tWritten;
  const counts = { quiet, rebased, pinned, floorRefused: false };
  const done = (run: Omit<OldReadRun, "counts" | "plannedAfterDdl" | "shape">, more = ""): OldReadRun => {
    const wrong = [...run.wrong];
    if (pinned && mustRefuse && !/^refused: read too old/.test(run.outcome)) {
      wrong.push(`the reader could not move T past a write to o, and t had a commit between T ${T0} and the DDL; the table's floor must refuse T, but the read ${run.outcome}`);
    }
    if (pinned && !mustRefuse && run.outcome !== "answered at its T") {
      wrong.push(`the reader could not move T past a write to o, and t had no commit between T ${T0} and the DDL; the table's floor must let the read answer at T, but it ${run.outcome}`);
    }
    counts.floorRefused = pinned && /^refused: read too old/.test(run.outcome);
    return { ...run, wrong, shape: `${shape.join(" | ")}${more}`, plannedAfterDdl, counts };
  };
  if (r instanceof Error) {
    // 読み手の最初の文 (o の読み) が、RENAME の前のスナップショットで答えた。取引は、そのスナップショットのまま続くので、後の名前 u は
    // ない (docs/sql-language.md の「取引の中の DDL」の「後から作られた表は見えない」。SQLite の WAL でも、読み始めた取引から、後の
    // RENAME の名前は見えない)。o の DDL があった実行では、最初の文は DDL の後の表定義へ移るので、この誤りは誤りである。取引の
    // スナップショットに u があるのに、この誤りになったときも、誤りである。
    if (kind === "rename" && !oDdl && /^no such table: u$/.test(r.message) && snapshot && !snapshot.tables.u) {
      return done({ outcome: "kept its snapshot: no such table: u", wrong: [] }, " | the transaction's snapshot has no table u");
    }
    if (!REFUSED.test(r.message)) return done({ outcome: `refused: ${r.message}`, wrong: [`unexpected error: ${r.message}`] });
    return done({ outcome: `refused: ${r.message.replace(/\d+/g, "#").slice(0, 60)}`, wrong: [] });
  }

  // T の時点の表。各行の、T 以下で最後に確定した値を、全部のシャードの変更ログから引く。
  const T = r.ts!;
  const outcome = T === T0 ? "answered at its T" : "answered at a later T";
  if (kind === "recreate") {
    // 作り直した表は、T にはまだなかった (T は DROP より前)。T を進めて読んだなら、作り直した後の T の行は、作り直した表に入れた行だけである。
    const old = r.rows.filter((row) => row.w !== "new");
    const wrong = old.length > 0 ? [`the recreated table read ${old.length} rows of the dropped table at T ${T}: ${JSON.stringify(old.slice(0, 3))}`] : [];
    if (T === T0 && r.rows.length > 0) wrong.push(`the recreated table read ${r.rows.length} rows at T ${T}, before it was created`);
    return done({ outcome, wrong }, ` | answered at T ${T}`);
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
  return done({ outcome, wrong: wrong.slice(0, 5) }, ` | answered at T ${T}`);
}
