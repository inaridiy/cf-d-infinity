// M21 (specs/m21_catalog_epoch.qnt) の段 3 の赤を、決まった順で再生する (docs/design-catalog-epoch.md の「モデルの赤と、欠陥のスイッチの
// 対応」、docs/model-coverage.md)。どの場面も、直したコードで正しく終わることと、欠陥のスイッチを入れると、モデルの反例と同じ不変条件が
// 破れることを確かめる。ほかのファイルにある再生は、表の行がそちらを指す (unique-index-build、rebuild-guard、ddl-concurrent)。
//
// 場面の表 p は 2 シャードにまたがる。tenant_id が shard key で、A は s0 の、B は s1 の tenant である。
import { describe, expect, it } from "vitest";
import { Db, type ClientFaults, type Cluster } from "../src/client/db";
import { shardsOf } from "../src/routing";
import type { Faults } from "../src/types";
import { indexAgreement } from "./ddl-harness";
import { outcome } from "./ddl-driver";
import { delivers, SimCluster, withOverrides } from "./sim";
import { ownerOf } from "../src/routing";

const P = "CREATE TABLE p(tenant_id INTEGER NOT NULL, id INTEGER NOT NULL, code TEXT, gone INTEGER, PRIMARY KEY (tenant_id, id))";
const CHECK = "ALTER TABLE p ADD COLUMN extra INTEGER CHECK (gone IS NULL)";

/**
 * 場面のクラスタ。欠陥のスイッチは、表 p を作った後で入る (arm)。作る DDL にもスイッチが掛かると、場面の前提 (どのシャードも p を持つ)
 * が崩れるからである。Meta とシャードは faults の、Worker は clientFaults の object を持ち続けるので、後から書き足せば効く。
 */
async function cluster(o: { faults?: Faults; clientFaults?: ClientFaults; noImageCheck?: boolean } = {}) {
  const faults: Faults = {};
  const clientFaults: ClientFaults = {};
  const c = new SimCluster({ shards: 2, faults, clientFaults, noImageCheck: o.noImageCheck });
  await new Db(c).ddl(P);
  const { routing } = await c.catalog();
  const on = (shard: string) => Array.from({ length: 40 }, (_, i) => i + 1).find((t) => ownerOf(routing, JSON.stringify([t])) === shard)!;
  const arm = () => {
    Object.assign(faults, o.faults);
    Object.assign(clientFaults, o.clientFaults);
  };
  return { c, A: on("s0"), B: on("s1"), arm };
}

/** 進める側の commit (Meta への記録) を、release まで止める。止まった時点で reached が解ける。止めるのは最初の 1 回だけである。 */
function holdCommit(c: SimCluster): { cluster: Cluster; reached: Promise<void>; release: () => void } {
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let hit!: () => void;
  const reached = new Promise<void>((r) => (hit = r));
  let once = false;
  const cluster = withOverrides(c, {
    commit: async (epoch, acks, at) => {
      if (!once) {
        once = true;
        hit();
        await held;
      }
      return c.commit(epoch, acks, at);
    },
  });
  return { cluster, reached, release };
}

/** 全シャードに最新の表定義を適用させ、適用の失敗を報告しているシャードを返す (M21 の commitApplies が破れたときの姿)。 */
async function stuck(c: SimCluster): Promise<string[]> {
  const cat = await c.catalog();
  const ids = shardsOf(cat.routing);
  await Promise.all(ids.map((id) => c.shard(id).syncSchema({ atLeast: cat.epoch }).catch(() => undefined)));
  const health = await Promise.all(ids.map((id) => c.shard(id).health({})));
  return health.filter((h) => h.schemaError).map((h) => h.id);
}

// m21_red_trial_no_fence (commitApplies)。試しの間、書き込みを止めない。モデルの反例と同じ順で流す: 行で失敗し得る DDL の prepare を
// 記録し、各シャードが適用して試しに通る。commit の前に、CHECK に反する行が書かれる。commit を適用するシャードが失敗する。
describe("a trial is not undone by a write before the commit (m21_red_trial_no_fence)", () => {
  const scenario = async (faults: Faults = {}) => {
    const { c, A, arm } = await cluster({ faults });
    arm();
    const d = holdCommit(c);
    const ddl = outcome(new Db(d.cluster).ddl(CHECK));
    await d.reached;
    const write = outcome(new Db(c).query("INSERT INTO p(tenant_id, id, code, gone) VALUES (?, 1, 'x', 1)", [A]));
    const early = await Promise.race([write, c.sleep(200).then(() => "waiting")]);
    d.release();
    return { ddl: await ddl, early, write: await write, stuck: await stuck(c) };
  };

  it("refuses the write while the table is fenced, so the commit applies on every shard", async () => {
    expect(await scenario()).toEqual({ ddl: "ok", early: "waiting", write: "CHECK constraint failed: gone IS NULL", stuck: [] });
  });

  it("put back (ignoreTableLock): the write lands after the trial, and the shard cannot apply the commit", async () => {
    expect(await scenario({ ignoreTableLock: true })).toEqual({ ddl: "ok", early: "ok", write: "ok", stuck: ["s0"] });
  });
});

// m21_red_trial_no_drain (commitApplies)。intent を決着させずに prepare を適用する。モデルの反例と同じ順で流す: 2 シャードの取引が、
// CHECK に反する行を s0 に書いて確定する (anchor は s1 で、s0 への phase 2 は届かず、s0 に intent が残る)。DDL の prepare を記録し、
// s0 が適用して試しに通る。intent が決着して行が表に入る。commit を適用する s0 が失敗する。
describe("the prepare settles the intents of the fenced table before the trial (m21_red_trial_no_drain)", () => {
  const scenario = async (faults: Faults = {}) => {
    const { c, A, B, arm } = await cluster({ faults, noImageCheck: faults.ddlIgnoresIntents === true });
    await new Db(c).query("INSERT INTO p VALUES (?, 8, 'a', NULL), (?, 9, 'b', NULL)", [B, B]);
    arm();
    let releaseFinalize!: () => void;
    const finalizeHeld = new Promise<void>((r) => (releaseFinalize = r));
    c.net.gate = (m) => (m.method === "finalize" && m.to === "s0" ? finalizeHeld : undefined);
    // 守られていない読みを s1 に持つので、anchor は s1 になる。s0 への phase 2 を止めて、s0 に intent を残す。
    const w = await new Db(c).begin();
    await w.query("SELECT code FROM p WHERE tenant_id = ? AND id = 9", [B]);
    await w.query("UPDATE p SET code = 'c' WHERE tenant_id = ? AND id = 8", [B]);
    await w.query("INSERT INTO p VALUES (?, 1, 'x', 1)", [A]);
    await w.commit();
    const pending = c.backends.get("s0")!.exec("SELECT count(*) AS n FROM __intents WHERE tbl = 'p'")[0]!.n;
    const d = holdCommit(c);
    const ddl = outcome(new Db(d.cluster).ddl(CHECK));
    // 直したコードでは、s0 は prepare を適用する前に intent を決着させ、試しが CHECK で落ちる。DDL は commit まで進まない。
    const first = await Promise.race([ddl, d.reached.then(() => "held")]);
    c.net.gate = () => undefined;
    releaseFinalize();
    await c.settle();
    d.release();
    return { pending, ddl: first === "held" ? `held, then ${await ddl}` : first, stuck: await stuck(c) };
  };

  it("refuses the change on the row of the settled intent", async () => {
    expect(await scenario()).toEqual({ pending: 1, ddl: "CHECK constraint failed", stuck: [] });
  });

  it("put back (ddlIgnoresIntents): the trial passes over the pending row, and the shard cannot apply the commit", async () => {
    expect(await scenario({ ddlIgnoresIntents: true })).toEqual({ pending: 1, ddl: "held, then ok", stuck: ["s0"] });
  });
});

// m21_red_trial_early (commitApplies)。prepare を適用する前のシャードが、試しに ok と答える。モデルの反例と同じ順で流す: prepare を記録する。
// s0 が、prepare を適用しないまま試して ok と答える。prepare を知らない Worker が、CHECK に反する行を s0 に書いて確定する。commit を
// 記録する。commit を適用する s0 が失敗する。
describe("a shard tries the change only after it applied the prepare (m21_red_trial_early)", () => {
  const scenario = async (clientFaults?: ClientFaults) => {
    const { c, A, arm } = await cluster({ clientFaults });
    arm();
    // 書く側は、prepare より前の表定義を持っている (記録をまだ知らない Worker)。
    const writer = new Db(c, { catalog: await c.catalog() });
    const d = holdCommit(c);
    const ddl = outcome(new Db(d.cluster).ddl(CHECK));
    await d.reached;
    const write = outcome(writer.query("INSERT INTO p(tenant_id, id, code, gone) VALUES (?, 1, 'x', 1)", [A]));
    const early = await Promise.race([write, c.sleep(200).then(() => "waiting")]);
    d.release();
    return { ddl: await ddl, early, write: await write, stuck: await stuck(c) };
  };

  it("makes the write wait for the change, so the commit applies on every shard", async () => {
    expect(await scenario()).toEqual({ ddl: "ok", early: "waiting", write: "CHECK constraint failed: gone IS NULL", stuck: [] });
  });

  it("put back (checkBeforePrepare): the shard tried before the fence, takes the write, and cannot apply the commit", async () => {
    expect(await scenario({ checkBeforePrepare: true })).toEqual({ ddl: "ok", early: "ok", write: "ok", stuck: ["s0"] });
  });
});

// m21_red_drop_check_early (guardHolds)。取引が読んだ表の DROP で、prepare を適用する前に、読んだ後の変更を確かめる。モデルの反例と同じ順で
// 流す: 作り直す取引が表を読んで写し、確定する。DROP の prepare を記録する。s0 が、prepare を適用しないまま「変更なし」と答える。
// 古い表定義の Worker が s0 の古い表へ書いて確定する。s0 が prepare を適用し、DROP が確定する。書いた行は失われる。
describe("the guard checks for changes only after the shard applied the prepare (m21_red_drop_check_early)", () => {
  const scenario = async (clientFaults?: ClientFaults) => {
    const { c, A, arm } = await cluster({ clientFaults });
    await new Db(c).query("INSERT INTO p VALUES (?, 1, 'x', NULL)", [A]);
    arm();
    const db = new Db(c);
    await db.query("BEGIN");
    await db.query("CREATE TABLE __new_p(tenant_id INTEGER NOT NULL, id INTEGER NOT NULL, code TEXT, gone INTEGER, PRIMARY KEY (tenant_id, id))");
    await db.query("INSERT INTO __new_p SELECT * FROM p");
    const writer = new Db(c, { catalog: await c.catalog() });
    // DROP の prepare が s0 へ届くのを止める。止めている間に、古い表定義の Worker が s0 の古い表へ書く。
    const lock = (await c.catalog()).epoch + 1;
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let reached!: () => void;
    const hit = new Promise<void>((r) => (reached = r));
    c.net.gate = (m) => {
      if (m.to !== "s0" || !delivers(m, lock)) return undefined;
      reached();
      return held;
    };
    const dropping = outcome(db.query("DROP TABLE p"));
    await hit;
    const write = await outcome(writer.query("INSERT INTO p VALUES (?, 2, 'y', NULL)", [A]));
    c.net.gate = () => undefined;
    release();
    const drop = await dropping;
    if (drop === "ok") await outcome(db.query("ALTER TABLE __new_p RENAME TO p"));
    await outcome(db.query(drop === "ok" ? "COMMIT" : "ROLLBACK"));
    const rows = (await new Db(c).query("SELECT id FROM p WHERE tenant_id = ? ORDER BY id", [A])).rows.map((r) => r.id);
    return { write, drop: drop === "ok" ? "ok" : drop.slice(0, 60), rows };
  };

  it("finds the write and fails the rebuild, so the row is kept", async () => {
    expect(await scenario()).toEqual({ write: "ok", drop: "conflict: another connection wrote to p after this transacti", rows: [1, 2] });
  });

  it("put back (checkBeforePrepare): the guard answered before the fence, the DROP goes through and the row is lost", async () => {
    expect(await scenario({ checkBeforePrepare: true })).toEqual({ write: "ok", drop: "ok", rows: [1] });
  });
});

// m21_red_drop_no_fence (guardHolds、M14 の m14_red_no_lock)。取引が読んだ表の DROP で、読んだ後の変更を確かめるが、書き込みを止めない。
// モデルの反例と同じ順で流す: 作り直す取引が表を読んで写し、確定する。DROP の prepare を記録し、全シャードが適用し、「変更なし」と
// 答える。commit の前に、別の接続が古い表へ書いて確定する。DROP が確定する。書いた行は失われる。
describe("the DROP of a table a transaction read stops writes until it commits (m21_red_drop_no_fence)", () => {
  const scenario = async (faults: Faults = {}) => {
    const { c, A, arm } = await cluster({ faults });
    await new Db(c).query("INSERT INTO p VALUES (?, 1, 'x', NULL)", [A]);
    arm();
    const d = holdCommit(c);
    const db = new Db(d.cluster);
    await db.query("BEGIN");
    // 新しい表を作る DDL の commit は、止めずに通す (holdCommit は最初の 1 回を止めるので、ここで使い切らないように別の Db で作る)。
    await new Db(c).ddl("CREATE TABLE __new_p(tenant_id INTEGER NOT NULL, id INTEGER NOT NULL, code TEXT, gone INTEGER, PRIMARY KEY (tenant_id, id))");
    await db.query("INSERT INTO __new_p SELECT * FROM p");
    const dropping = outcome(db.query("DROP TABLE p"));
    await d.reached;
    const write = outcome(new Db(c).query("INSERT INTO p VALUES (?, 2, 'y', NULL)", [A]));
    const early = await Promise.race([write, c.sleep(200).then(() => "waiting")]);
    d.release();
    const drop = await dropping;
    if (drop === "ok") await outcome(db.query("ALTER TABLE __new_p RENAME TO p"));
    await outcome(db.query(drop === "ok" ? "COMMIT" : "ROLLBACK"));
    const wrote = await write;
    const rows = (await new Db(c).query("SELECT id FROM p WHERE tenant_id = ? ORDER BY id", [A])).rows.map((r) => r.id);
    return { early, drop, lost: wrote === "ok" && !rows.includes(2) };
  };

  it("makes the write wait for the DROP, so no acknowledged row is lost", async () => {
    expect(await scenario()).toEqual({ early: "waiting", drop: "ok", lost: false });
  });

  it("put back (ignoreTableLock): the write lands after the check, and the DROP loses it", async () => {
    expect(await scenario({ ignoreTableLock: true })).toEqual({ early: "ok", drop: "ok", lost: true });
  });
});

// m21_red_trial_missing_ack (commitApplies)。全シャードの ok を待たずに commit を記録する。モデルの反例と同じ順で流す: s1 にだけ CHECK に
// 反する行がある。prepare を記録し、s0 だけが試して ok と答える。commit を記録する。commit を適用する s1 が失敗する。
describe("a change is committed only after every shard tried it (m21_red_trial_missing_ack)", () => {
  const scenario = async (both = false) => {
    const { c, B, arm } = await cluster(both ? { faults: { commitWithoutAcks: true }, clientFaults: { commitWithoutAcks: true } } : {});
    await new Db(c).query("INSERT INTO p VALUES (?, 1, 'x', 1)", [B]);
    arm();
    const ddl = await outcome(new Db(c).ddl(CHECK));
    return { ddl, extra: (await c.catalog()).tables.p!.columns.includes("extra"), stuck: await stuck(c) };
  };

  it("refuses the change that the rows of one shard violate", async () => {
    expect(await scenario()).toEqual({ ddl: "CHECK constraint failed", extra: false, stuck: [] });
  });

  it("put back (commitWithoutAcks): the change is committed without that shard's answer, and the shard cannot apply it", async () => {
    expect(await scenario(true)).toEqual({ ddl: "ok", extra: true, stuck: ["s1"] });
  });

  it("refuses a commit whose acknowledgements leave out a shard, even when the Worker sends it", async () => {
    // Meta の確かめだけを見る。Worker が 1 つのシャードを飛ばしても、Meta が ok の集合を確かめれば、commit は記録されない。
    const { c, B, arm } = await cluster({ clientFaults: { commitWithoutAcks: true } });
    await new Db(c).query("INSERT INTO p VALUES (?, 1, 'x', 1)", [B]);
    arm();
    const ddl = await outcome(new Db(c).ddl(CHECK));
    expect({ ddl, extra: (await c.catalog()).tables.p!.columns.includes("extra"), stuck: await stuck(c) }).toEqual({
      ddl: expect.stringMatching(/was not prepared on s1; it was not committed$/), extra: false, stuck: [],
    });
  });
});

// m21_red_drop_missing_ack (noLostAfterReturn、M11 の m11_red_no_sync)。全シャードが prepare を適用する前に、DDL が完了を返す。モデルの
// 反例と同じ順で流す: DROP TABLE の prepare を記録し、s0 だけが適用する。commit を記録して、DDL が完了を返す。古い表定義の Worker が
// s1 の古い表へ書いて確定する。同じ名前の表を作り直す。書いた行は、どこにもない。
describe("a DROP TABLE returns only after every shard applied its prepare (m21_red_drop_missing_ack)", () => {
  const scenario = async (both = false) => {
    const { c, B, arm } = await cluster(both ? { faults: { commitWithoutAcks: true }, clientFaults: { commitWithoutAcks: true } } : {});
    const writer = new Db(c, { catalog: await c.catalog(), retries: 0 });
    arm();
    const ddl = await outcome(new Db(c).ddl("DROP TABLE p"));
    const write = await outcome(writer.query("INSERT INTO p VALUES (?, 1, 'x', NULL)", [B]));
    // 表を作り直す。作り直す DDL は、Worker の側のスイッチなしで進める (全シャードが prepare を適用する)。
    await new Db(c, { faults: {} }).ddl(P);
    const rows = (await new Db(c).query("SELECT count(*) AS n FROM p")).rows;
    return { ddl, write: write === "ok" ? "ok" : "refused", lost: write === "ok" && rows[0]!.n === 0 };
  };

  it("refuses a write planned before the DROP once the DROP has returned", async () => {
    expect(await scenario()).toEqual({ ddl: "ok", write: "refused", lost: false });
  });

  it("put back (commitWithoutAcks): a shard that never applied the prepare takes the write, and the DROP loses it", async () => {
    expect(await scenario(true)).toEqual({ ddl: "ok", write: "ok", lost: true });
  });
});

// m21_red_two_exits (oneExit、indexMatches)。abort された遷移の遅れた commit が通る。モデルの反例と同じ順で流す: 行のある表に、シャードを
// またぐ UNIQUE の index を作り始め、進める側が項目を書いた後で止まる (期限を延ばさない)。期限で abort される。書き込みが通る。遅れた
// commit が届く。
describe("a late commit after the lease lapsed is refused (m21_red_two_exits)", () => {
  const scenario = async (faults: Faults = {}) => {
    const { c, A, B, arm } = await cluster({ faults });
    await new Db(c).query("INSERT INTO p VALUES (?, 1, 'a', NULL)", [A]);
    await new Db(c).query("INSERT INTO p VALUES (?, 1, 'b', NULL)", [B]);
    arm();
    const d = holdCommit(c);
    const stalled = withOverrides(c, { renew: () => new Promise<{ leaseMs: number }>(() => {}), commit: d.cluster.commit });
    const ddl = outcome(new Db(stalled).ddl("CREATE UNIQUE INDEX ux ON p(code)"));
    await d.reached;
    // 書き込みは、禁止に断られ、期限で abort されるのを待ってから通る。
    const write = await outcome(new Db(c).query("INSERT INTO p VALUES (?, 2, 'c', NULL)", [A]));
    const aborted = (await c.catalog()).aborted?.reason ?? null;
    d.release();
    const late = await ddl;
    await c.settle();
    const ix = await indexAgreement(c, "p", "ux");
    return { write, aborted: aborted !== null, late: late === "ok" ? "ok" : late.slice(0, 40), state: ix.state, missing: ix.missing.length };
  };

  it("refuses the late commit, so no index misses the row written after the abort", async () => {
    expect(await scenario()).toEqual({ write: "ok", aborted: true, late: "CREATE INDEX ux stopped before it finish", state: null, missing: 0 });
  });

  it("put back (commitAfterAbort): the late commit publishes an index that misses the rows", async () => {
    // abort を適用したシャードは index の表 (staging) を消すので、書いた項目も消えた。開き直した prepare が空の表を作り直し、遅れた
    // commit は、項目のない index を公開する。abort の後に書かれた行も、その前からの 2 行も、index から引けない。
    expect(await scenario({ commitAfterAbort: true })).toEqual({ write: "ok", aborted: true, late: "ok", state: "public", missing: 3 });
  });
});

// m21_red_two_open (commitApplies)。表定義の遷移を 2 つ開く。モデルの反例と同じ順で流す: 行のある表に、シャードをまたぐ UNIQUE の index を
// 作り始め、項目を書いた後で commit の前に止まる。同じ表の DROP が prepare から commit まで進む。index の commit を記録させる。
// 実装では、Meta が commit を記録するときに文を自分の SQLite でも実行する (MetaCore.commit) ので、消えた表に index を作る commit は、
// 記録されずに断られる (2 つ目の守り)。シャードが適用できない commit は記録されない。
// 同じ欠陥は、もう 1 つの順で表に出る: index を作っている間に、同じ表の ADD COLUMN が確定する。index の commit の表定義は、列を足す前の
// 形なので、それを畳んだ表定義から、足した列が消える (シャードの表には列がある)。Meta の SQLite の実行は、この形を断れない。
describe("one schema transition is open at a time (m21_red_two_open)", () => {
  const scenario = async (other: string, faults: Faults = {}) => {
    const { c, A, B, arm } = await cluster({ faults });
    await new Db(c).query("INSERT INTO p VALUES (?, 1, 'a', NULL)", [A]);
    await new Db(c).query("INSERT INTO p VALUES (?, 1, 'b', NULL)", [B]);
    arm();
    const d = holdCommit(c);
    const build = outcome(new Db(d.cluster).ddl("CREATE UNIQUE INDEX ux ON p(code)"));
    await d.reached;
    const second = outcome(new Db(c).ddl(other));
    const early = await Promise.race([second, c.sleep(500).then(() => "waiting")]);
    d.release();
    const r = { build: await build, early, second: await second, stuck: await stuck(c) };
    const cat = await c.catalog();
    return { ...r, tables: Object.keys(cat.tables).filter((t) => !t.startsWith("__")), columns: cat.tables.p?.columns ?? null, index: cat.indexes.ux !== undefined };
  };

  it("makes the DROP wait for the build, so both apply on every shard", async () => {
    expect(await scenario("DROP TABLE p")).toEqual({ build: "ok", early: "waiting", second: "ok", stuck: [], tables: [], columns: null, index: false });
  });

  it("put back (overlappingTransitions), the model's order: the DROP commits during the build, and Meta refuses the build's commit", async () => {
    expect(await scenario("DROP TABLE p", { overlappingTransitions: true })).toEqual({
      build: "no such table: main.p", early: "ok", second: "ok", stuck: [], tables: [], columns: null, index: false,
    });
  });

  it("makes the ADD COLUMN wait for the build, so the table has both the index and the column", async () => {
    expect(await scenario("ALTER TABLE p ADD COLUMN extra INTEGER DEFAULT 5")).toEqual({
      build: "ok", early: "waiting", second: "ok", stuck: [], tables: ["p"], columns: ["tenant_id", "id", "code", "gone", "extra"], index: true,
    });
  });

  it("put back (overlappingTransitions): the ADD COLUMN commits during the build, and the build's commit drops the column from the schema", async () => {
    expect(await scenario("ALTER TABLE p ADD COLUMN extra INTEGER DEFAULT 5", { overlappingTransitions: true })).toEqual({
      build: "ok", early: "ok", second: "ok", stuck: [], tables: ["p"], columns: ["tenant_id", "id", "code", "gone"], index: true,
    });
  });
});
