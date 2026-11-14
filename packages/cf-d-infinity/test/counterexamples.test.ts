// 設計レビューと形式モデルで見つけた反例を、本物のシャードコードで再現する。
// 各テストは「欠陥スイッチを入れると壊れ、外すと直る」の両方を確かめる。
import { describe, expect, it } from "vitest";
import { ORDERS, SimCluster, USERS, logRows, type SimOptions } from "./sim";
import { Db, type ClientFaults } from "../src/client/db";
import { ownerOf } from "../src/routing";
import type { ExecReq, Faults } from "../src/types";

/** 指定シャードに載る tenant を返す。 */
async function tenantOn(c: SimCluster, shard: string, skip = 0): Promise<number> {
  const { routing } = await c.catalog();
  for (let t = 1; ; t++) {
    if (ownerOf(routing, JSON.stringify([t])) === shard && skip-- === 0) return t;
  }
}

async function cluster(faults: Faults = {}, extra: SimOptions = {}) {
  // 時計のずれは初期データを入れた後に与える。先にずらすと、遅い時計の T からは
  // 進んだ時計のシャードの初期データが見えず、シナリオが成り立たない。
  const drift = new Map<string, number>();
  const c = new SimCluster({ shards: 3, faults, skewMs: (id) => drift.get(id) ?? 0, ...extra });
  const db = c.client();
  await db.ddl(USERS);
  await db.ddl(ORDERS);
  const [A, B, C] = (await Promise.all(["s0", "s1", "s2"].map((s) => tenantOn(c, s)))) as [number, number, number];
  return { c, db, A, B, C, drift };
}
// 初期データは別セッションで入れる。同じセッションの因果トークンが時計のずれを吸収してしまうからである。
async function seed(db: Db, t: number, id = 1, n = 0) {
  await new Db(db.cluster).query("INSERT INTO users(tenant_id,id,n) VALUES (?,?,?)", [t, id, n]);
  (db.cluster as SimCluster).time += 1; // 論理カウンタの差が時計のずれに見えないよう物理時刻を進める
}
const getN = async (tx: { query: Db["query"] }, t: number, id = 1) =>
  (await tx.query("SELECT n FROM users WHERE tenant_id = ? AND id = ?", [t, id])).rows[0]?.n ?? null;
const setN = (tx: { query: Db["query"] }, t: number, n: number, id = 1) =>
  tx.query("UPDATE users SET n = ? WHERE tenant_id = ? AND id = ?", [n, t, id]);

/** RPC で届く finalize だけを止める。anchor 自身の適用は RPC を通らないので先に進む。 */
function holdFinalize(c: SimCluster, shard?: string) {
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  c.net.gate = (m) => (m.method === "finalize" && (!shard || m.to === shard) ? held : undefined);
  return () => {
    c.net.gate = () => {};
    release();
  };
}

describe("atomic visibility: a reader must not pass a pending intent", () => {
  const scenario = async (faults: Faults) => {
    const { c, db, A, B } = await cluster(faults);
    await seed(db, A);
    await seed(db, B);
    const release = holdFinalize(c);
    const w = await db.begin();
    await setN(w, A, 1);
    await setN(w, B, 1);
    await w.commit();
    // ここで一方のシャードには commit が適用済み、もう一方には intent だけがある。
    const r = await db.begin();
    const seen = [await getN(r, A), await getN(r, B)];
    release();
    await c.settle();
    return seen;
  };
  it("is broken when the reader passes on timeout", async () => {
    const seen = await scenario({ readerTimeoutPass: true });
    expect(new Set(seen).size).toBe(2);
  });
  it("sees all or nothing with push and helper apply", async () => {
    const seen = await scenario({});
    expect(new Set(seen).size).toBe(1);
  });
});

describe("write skew across shards", () => {
  const scenario = async (faults: Faults) => {
    const { c, db, A, B } = await cluster(faults);
    await seed(db, A, 1, 1);
    await seed(db, B, 1, 1);
    const release = holdFinalize(c);
    const w1 = await db.begin();
    const w2 = await c.client().begin();
    await getN(w1, A);
    await getN(w2, B);
    await setN(w1, B, 0);
    await setN(w2, A, 0);
    const results = await Promise.allSettled([w1.commit()]);
    results.push(...(await Promise.allSettled([w2.commit()])));
    release();
    await c.settle();
    return results.filter((r) => r.status === "fulfilled").length;
  };
  it("lets both commit when validation looks only at the log", async () => {
    expect(await scenario({ ignoreIntentsInValidation: true })).toBe(2);
  });
  it("commits at most one when intents are checked", async () => {
    expect(await scenario({})).toBe(1);
  });
});

describe("anchor must absorb prepare timestamps", () => {
  // anchor の A が r を読み、C の時計だけが進んでいる。refresh の間に別の取引が r へ書く。
  const scenario = async (faults: Faults) => {
    const { c, db, A, B, C, drift } = await cluster(faults);
    await seed(db, A);
    await seed(db, B);
    await seed(db, C);
    const w = await db.begin();
    await w.query("SELECT count(*) FROM users WHERE tenant_id = ?", [A]);
    await w.query("SELECT sum(n) FROM users WHERE tenant_id = ?", [A]); // A が anchor になる
    await w.query("SELECT sum(n) FROM users WHERE tenant_id = ?", [B]); // B は refresh の対象
    await setN(w, C, 1);
    drift.set("s2", 100);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    c.net.gate = (m) => (m.method === "refresh" ? held : undefined);
    const commit = w.commit();
    while (!c.net.log.some((m) => m.method === "refresh")) await new Promise((r) => setImmediate(r));
    const later = await new Db(c).query("UPDATE users SET n = 9 WHERE tenant_id = ? AND id = 1", [A]);
    c.net.gate = () => {};
    release();
    await commit;
    await c.settle();
    return { c: w.commitTs!, later: later.ts! };
  };
  it("is broken without absorption: a write to the read span lands before c", async () => {
    const r = await scenario({ anchorNoAbsorb: true });
    expect(r.later).toBeLessThan(r.c);
  });
  it("orders that write after c", async () => {
    const r = await scenario({});
    expect(r.later).toBeGreaterThan(r.c);
  });
});

describe("read-only participants must be prepared", () => {
  const scenario = async (faults: Faults) => {
    const { c, db, A, B, C } = await cluster(faults);
    await seed(db, A);
    await seed(db, B);
    await seed(db, C);
    const w = await db.begin();
    await w.query("SELECT count(*) FROM users WHERE tenant_id = ?", [A]);
    await w.query("SELECT sum(n) FROM users WHERE tenant_id = ?", [A]); // A を anchor に固定する
    const stale = await getN(w, B); // B は読み取りだけの参加者
    await db.query("UPDATE users SET n = 7 WHERE tenant_id = ? AND id = 1", [B]);
    await setN(w, C, 1);
    const out = await w.commit().then(() => "committed", () => "aborted");
    await c.settle();
    return { stale, out };
  };
  it("commits on a stale read when they are skipped", async () => {
    expect((await scenario({ skipReadOnlyPrepare: true })).out).toBe("committed");
  });
  it("aborts when they are prepared", async () => {
    expect((await scenario({})).out).toBe("aborted");
  });
});

describe("phantom: a predicate read is not protected by intents", () => {
  const scenario = async (faults: Faults) => {
    const { c, db, A, B, C, drift } = await cluster(faults);
    await seed(db, A);
    await seed(db, B);
    await seed(db, B, 2);
    await seed(db, C);
    const w = await db.begin();
    await w.query("SELECT count(*) FROM users WHERE tenant_id = ?", [A]); // 述語読み
    await w.query("SELECT count(*) FROM users WHERE tenant_id = ?", [B]);
    await w.query("SELECT sum(n) FROM users WHERE tenant_id = ?", [B]);
    await setN(w, A, 1); // 読んだ表に書くが phantom は防げない
    await setN(w, C, 1);
    drift.set("s2", 100);
    // C への prepare を止めて、その間に A へ行を挿入する。
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    c.net.gate = (m) => (m.method === "prepare" && m.to === "s2" ? held : undefined);
    const commit = w.commit().then(() => "committed", () => "aborted");
    while (!c.net.log.some((m) => m.method === "prepare" && m.to === "s0")) await new Promise((r) => setImmediate(r));
    await c.sleep(2);
    await c.client().query("INSERT INTO users(tenant_id,id,n) VALUES (?,99,1)", [A]);
    c.net.gate = () => {};
    release();
    const out = await commit;
    await c.settle();
    return out;
  };
  it("commits past a phantom when predicate spans count as protected", async () => {
    expect(await scenario({ predicateProtected: true })).toBe("committed");
  });
  it("aborts because the refresh sees the insert", async () => {
    expect(await scenario({})).toBe("aborted");
  });
});

describe("refresh must advance the participant clock", () => {
  const scenario = async (faults: Faults) => {
    const { c, db, A, B, C, drift } = await cluster(faults);
    await seed(db, A);
    await seed(db, B);
    await seed(db, B, 2);
    await seed(db, C);
    const w = await db.begin();
    await w.query("SELECT count(*) FROM users WHERE tenant_id = ?", [A]); // refresh の対象
    await w.query("SELECT count(*) FROM users WHERE tenant_id = ?", [B]);
    await w.query("SELECT sum(n) FROM users WHERE tenant_id = ?", [B]); // B が anchor
    await setN(w, C, 1);
    drift.set("s2", 100);
    const release = holdFinalize(c, "s0"); // A には finalize が届かない
    await w.commit();
    const later = await new Db(c).query("UPDATE users SET n = 5 WHERE tenant_id = ? AND id = 1", [A]);
    release();
    await c.settle();
    return { c: w.commitTs!, later: later.ts! };
  };
  it("is broken without the bump: a later write lands before c", async () => {
    const r = await scenario({ refreshNoBump: true });
    expect(r.later).toBeLessThan(r.c);
  });
  it("orders the later write after c", async () => {
    const r = await scenario({});
    expect(r.later).toBeGreaterThan(r.c);
  });
});

// specs/m1b_read_refresh.qnt の m1b_red_ra。取引の読みが「moved at m」で断られ、取引の時刻を m へ進める (read-time refresh) とき、
// 確かめた各シャードの時計も m まで進めなければならない。進めないと、確かめたシャードが、その後の書き込みを m 以下で確定し、
// 時刻 m の読みが、時刻 m より前に確定した書き込みを見ていないことになる。モデルの反例と同じ順で流す:
// R が A を読む。B のシャード (時計が進んでいる) が、R の時刻を含む変更ログの世代を消す。R の B の読みが moved at m で断られ、
// R は A のシャードを確かめて m へ進む。別の接続が A に書く。
// モデルでは、範囲の移動が moved at を返す。実装の取引は、範囲表が変わると not owner で取引ごと失敗させるので、
// 取引の中で moved at を返すのは、変更ログを消した後の古い読み (と表定義の変更) である。
describe("a read-time refresh advances the clock of the shards it validated (m1b_red_ra)", () => {
  const scenario = async (faults: Faults) => {
    const { c, db, A, B, drift } = await cluster(faults, { logRetainMs: 100, logGenMs: 20 });
    const other = await tenantOn(c, "s1", 1);
    await seed(db, A);
    await seed(db, B);
    await seed(db, other);
    const r = await db.begin();
    await getN(r, A); // s0 が T を発行する
    const T0 = r.T!;
    drift.set("s1", 1000); // B のシャードの時計を進める。消した世代の上限 m は T0 より大きい
    for (let i = 0; i < 20; i++) {
      c.time += 50;
      await new Db(c).query("UPDATE users SET n = ? WHERE tenant_id = ? AND id = 1", [i, other]);
    }
    const low = c.backends.get("s1")!.exec("SELECT v FROM __meta WHERE k = 'log_low_water'")[0]?.v as number;
    expect(low).toBeGreaterThan(T0);
    await getN(r, B); // s1 は T0 の読みを moved at m で断り、R は s0 を確かめて m へ進む
    expect(r.T!).toBeGreaterThan(T0);
    const w = await new Db(c).query("UPDATE users SET n = 5 WHERE tenant_id = ? AND id = 1", [A]);
    return { T: r.T!, write: w.ts! };
  };
  it("put back: without the bump, a later write on the validated shard commits below the refreshed read", async () => {
    const r = await scenario({ refreshNoBump: true });
    expect(r.write).toBeLessThan(r.T);
  });
  it("orders the later write after the refreshed read", async () => {
    const r = await scenario({});
    expect(r.write).toBeGreaterThan(r.T);
  });
});

describe("HLC must not fall behind a served read after a restart", () => {
  const scenario = async (faults: Faults) => {
    const { c, db, A, B, drift } = await cluster(faults);
    await seed(db, A);
    await seed(db, B);
    drift.set("s0", 1000);
    const r = await db.begin();
    await getN(r, A); // 時計の進んだ s0 が T を発行する
    await getN(r, B); // s1 の HLC が T まで進む
    const T = r.T!;
    c.restart("s1");
    const client = c.client(); // 新しいセッションなのでトークンを持たない
    const w = await client.query("UPDATE users SET n = 1 WHERE tenant_id = ? AND id = 1", [B]);
    return { T, c: w.ts! };
  };
  it("is broken when only commit timestamps are persisted", async () => {
    const r = await scenario({ hlcNoCeiling: true });
    expect(r.c).toBeLessThanOrEqual(r.T);
  });
  it("resumes from the saved ceiling", async () => {
    const r = await scenario({});
    expect(r.c).toBeGreaterThan(r.T);
  });
});

describe("rollback-read and UNIQUE swap", () => {
  const scenario = async (faults: Faults) => {
    const { c, db } = await cluster(faults);
    await db.ddl(`CREATE TABLE a(tenant_id INTEGER NOT NULL, id INTEGER NOT NULL, code TEXT NOT NULL, PRIMARY KEY (tenant_id,id))`);
    await db.ddl(`CREATE UNIQUE INDEX a_code ON a(tenant_id, code)`);
    await db.query("INSERT INTO a VALUES (1,1,'x'),(1,2,'y')");
    const snap = await db.begin();
    await snap.query("SELECT code FROM a WHERE tenant_id = 1 ORDER BY id");
    const swap = await c.client().begin();
    await swap.query("UPDATE a SET code = 'tmp' WHERE tenant_id = 1 AND id = 1");
    await swap.query("UPDATE a SET code = 'x' WHERE tenant_id = 1 AND id = 2");
    await swap.query("UPDATE a SET code = 'y' WHERE tenant_id = 1 AND id = 1");
    await swap.commit();
    const before = (await snap.query("SELECT id, code FROM a WHERE tenant_id = 1 ORDER BY id")).rows;
    const after = (await c.client().query("SELECT id, code FROM a WHERE tenant_id = 1 ORDER BY id")).rows;
    return { before, after };
  };
  it("fails with row-by-row undo", async () => {
    await expect(scenario({ rowwiseUndo: true })).rejects.toThrow(/UNIQUE/);
  });
  it("reconstructs the snapshot with set-based undo, and phase 1 applies the swap", async () => {
    const r = await scenario({});
    expect(r.before).toEqual([{ id: 1, code: "x" }, { id: 2, code: "y" }]);
    expect(r.after).toEqual([{ id: 1, code: "y" }, { id: 2, code: "x" }]);
  });
});

describe("RED_G from the Quint model: push inside the refresh window", () => {
  // anchor が c を決めた後、refresh の完了前に読み手が intent に当たる。
  const scenario = async (faults: Faults) => {
    const { c, db, A, B } = await cluster(faults);
    await seed(db, A);
    await seed(db, B);
    const w = await db.begin();
    await w.query("SELECT count(*) FROM users WHERE tenant_id = ?", [A]);
    await w.query("SELECT sum(n) FROM users WHERE tenant_id = ?", [A]); // A が anchor になる
    await w.query("SELECT sum(n) FROM users WHERE tenant_id = ?", [B]); // B は refresh の対象
    await setN(w, A, 1);
    await setN(w, B, 1);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    c.net.gate = (m) => (m.method === "refresh" ? held : undefined);
    const commit = w.commit();
    while (!c.net.log.some((m) => m.method === "refresh")) await new Promise((r) => setImmediate(r));
    c.time += 1; // 読み手の T が c より後になる
    const r = await new Db(c).begin();
    const read = (async () => [await getN(r, A), await getN(r, B)])();
    await c.sleep(5);
    c.net.gate = () => {};
    release();
    const seen = await read;
    await commit;
    await c.settle();
    return { seen, T: r.T!, c: w.commitTs! };
  };
  it("is broken when push is accepted after c is decided: T >= c, yet the write is invisible", async () => {
    const r = await scenario({ pushAfterDecide: true });
    expect(r.T).toBeGreaterThanOrEqual(r.c);
    expect(r.seen).toEqual([0, 0]);
  });
  it("makes the reader wait for the outcome and see the write", async () => {
    const r = await scenario({});
    expect(r.T).toBeGreaterThanOrEqual(r.c);
    expect(r.seen).toEqual([1, 1]);
  });
});

describe("freshReadPicked from the Quint model: a one-shot read sees what was committed before it", () => {
  it("does not read below a transaction it finalized itself", async () => {
    // anchor の時計が進んでいると c が読み手のシャードの時計より大きくなる。
    const { c, db, A, B, drift } = await cluster();
    await seed(db, A);
    await seed(db, B);
    const w = await db.begin();
    await w.query("SELECT count(*) FROM users WHERE tenant_id = ?", [A]); // A が anchor になる
    await setN(w, A, 1);
    await setN(w, B, 1);
    drift.set("s0", 100);
    const release = holdFinalize(c, "s1"); // B には phase 2 が届いていない
    await w.commit();
    c.net.gate = () => {};
    const seen = await getN(new Db(c), B); // commit の応答の後に始めた読み
    release();
    await c.settle();
    expect(seen).toBe(1);
  });
});

describe("predicate read spans", () => {
  const setup = async () => {
    const c = new SimCluster({ shards: 3 });
    const db = new Db(c);
    await db.query("CREATE TABLE p(id INTEGER PRIMARY KEY, grp INTEGER, tag TEXT, n INTEGER)");
    for (let i = 1; i <= 12; i++) await db.query("INSERT INTO p VALUES (?, ?, ?, 0)", [i, i % 3, `t${i % 3}`]);
    c.time += 10;
    return { c, db };
  };
  const tryCommit = (w: { commit(): Promise<void> }) => w.commit().then(() => "committed", (e) => (e as Error).message.slice(0, 30));

  it("ignores a write that the predicate cannot see", async () => {
    const { c, db } = await setup();
    const w = await db.begin();
    await w.query("SELECT count(*) FROM p WHERE grp = 1");
    await w.query("UPDATE p SET n = 1 WHERE id = 1");
    await new Db(c).query("UPDATE p SET n = 5 WHERE id = 3"); // grp 0 の行
    expect(await tryCommit(w)).toBe("committed");
  });
  it("conflicts with a write the predicate can see", async () => {
    const { c, db } = await setup();
    const w = await db.begin();
    await w.query("SELECT count(*) FROM p WHERE grp = 1");
    await w.query("UPDATE p SET n = 1 WHERE id = 1");
    await new Db(c).query("INSERT INTO p VALUES (100, 1, 'x', 0)");
    expect(await tryCommit(w)).toMatch(/conflict/);
  });
  it("conflicts when a row leaves the predicate", async () => {
    const { c, db } = await setup();
    const w = await db.begin();
    await w.query("SELECT count(*) FROM p WHERE grp = 1");
    await w.query("UPDATE p SET n = 1 WHERE id = 3");
    await new Db(c).query("UPDATE p SET grp = 9 WHERE id = 4"); // grp 1 から出る
    expect(await tryCommit(w)).toMatch(/conflict/);
  });
  it("sees an update chain whose ends both miss the predicate", async () => {
    const { c, db } = await setup();
    const w = await db.begin();
    await w.query("SELECT count(*) FROM p WHERE grp = 1");
    await w.query("UPDATE p SET n = 1 WHERE id = 1");
    const o = new Db(c);
    await o.query("UPDATE p SET grp = 1 WHERE id = 3"); // 途中の版だけ条件を満たす
    await o.query("UPDATE p SET grp = 0 WHERE id = 3");
    expect(await tryCommit(w)).toMatch(/conflict/);
  });
  it("uses column affinity, as the read did", async () => {
    const { c, db } = await setup();
    const w = await db.begin();
    await w.query("SELECT count(*) FROM p WHERE grp = '1'");
    await w.query("UPDATE p SET n = 1 WHERE id = 1");
    await new Db(c).query("INSERT INTO p VALUES (101, 1, 'x', 0)");
    expect(await tryCommit(w)).toMatch(/conflict/);
  });
  it("treats a pending intent the same way", async () => {
    const { c, db } = await setup();
    const w = await db.begin();
    await w.query("SELECT count(*) FROM p WHERE grp = 1");
    await w.query("UPDATE p SET n = 1 WHERE id = 1");
    const release = (() => {
      let done!: () => void;
      const held = new Promise<void>((r) => (done = r));
      c.net.gate = (m) => (m.method === "finalize" ? held : undefined);
      return () => {
        c.net.gate = () => {};
        done();
      };
    })();
    const other = await new Db(c).begin();
    await other.query("UPDATE p SET grp = 1 WHERE id = 3");
    await other.query("UPDATE p SET n = 2 WHERE id = 5");
    await other.commit();
    const out = await tryCommit(w);
    release();
    await c.settle();
    expect(out).toMatch(/conflict/);
  });
});

describe("every table a statement reads is validated", () => {
  it("catches a change to a table read only through a subquery", async () => {
    const c = new SimCluster({ shards: 3 });
    const db = new Db(c);
    await db.ddl(`CREATE TABLE a(tenant INTEGER, id INTEGER, n INTEGER, PRIMARY KEY (tenant, id))`);
    await db.ddl(`CREATE TABLE b(tenant INTEGER, id INTEGER, n INTEGER, PRIMARY KEY (tenant, id))`);
    await db.query("INSERT INTO a VALUES (1, 1, 0)");
    await db.query("INSERT INTO b VALUES (1, 1, 5)");
    c.time += 10;
    const w = await db.begin();
    await w.query("UPDATE a SET n = (SELECT n FROM b WHERE tenant = 1 AND id = 1) WHERE tenant = 1 AND id = 1");
    await new Db(c).query("UPDATE b SET n = 9 WHERE tenant = 1 AND id = 1");
    await expect(w.commit()).rejects.toThrow(/conflict/);
  });
});

describe("pessimistic transactions", () => {
  const hot = async () => {
    const c = new SimCluster({ shards: 3 });
    const db = new Db(c);
    await db.query("CREATE TABLE h(id INTEGER PRIMARY KEY, n INTEGER)");
    await db.query("INSERT INTO h VALUES (1, 0), (2, 0)");
    return { c, db };
  };
  const inc = async (d: Db) => {
    await d.query("BEGIN IMMEDIATE");
    const n = (await d.query("SELECT n FROM h WHERE id = 1")).rows[0]!.n as number;
    await d.query("UPDATE h SET n = ? WHERE id = 1", [n + 1]);
    await d.query("COMMIT");
  };
  it("serializes writers on one row without failing them", async () => {
    const { c, db } = await hot();
    c.net.jitter = () => 1;
    await Promise.all(Array.from({ length: 10 }, () => inc(new Db(c))));
    expect((await db.query("SELECT n FROM h WHERE id = 1")).rows).toEqual([{ n: 10 }]);
  });
  it("releases locks when COMMIT fails, so others do not wait for the TTL", async () => {
    const { c, db } = await hot();
    const a = new Db(c);
    await a.query("BEGIN");
    await a.query("SELECT n FROM h WHERE id = 2");
    await a.query("UPDATE h SET n = 1 WHERE id = 1");
    await new Db(c).query("UPDATE h SET n = 5 WHERE id = 2"); // a の読みを壊す
    await expect(a.query("COMMIT")).rejects.toThrow(/conflict/);
    const t0 = c.time;
    await new Db(c).query("UPDATE h SET n = 9 WHERE id = 1");
    expect(c.time - t0).toBeLessThan(1000);
    expect((await db.query("SELECT n FROM h WHERE id = 1")).rows).toEqual([{ n: 9 }]);
  });
  it("releases locks on ROLLBACK", async () => {
    const { c } = await hot();
    const a = new Db(c);
    await a.query("BEGIN IMMEDIATE");
    await a.query("UPDATE h SET n = 1 WHERE id = 1");
    await a.query("ROLLBACK");
    const t0 = c.time;
    await new Db(c).query("UPDATE h SET n = 2 WHERE id = 1");
    expect(c.time - t0).toBeLessThan(1000);
  });
  const lost = async (faults: Faults) => {
    // ロックが再起動で消えても、検証が F 以降の変更を見るので更新は失われない。
    const c = new SimCluster({ shards: 1, faults });
    const db = new Db(c);
    await db.query("CREATE TABLE h(id INTEGER PRIMARY KEY, n INTEGER)");
    await db.query("INSERT INTO h VALUES (1, 0)");
    const a = new Db(c);
    await a.query("BEGIN IMMEDIATE");
    await a.query("UPDATE h SET n = n + 1 WHERE id = 1");
    c.restart("s0");
    c.time += 1;
    await new Db(c).query("UPDATE h SET n = n + 100 WHERE id = 1");
    const out = await a.query("COMMIT").then(() => "committed", () => "aborted");
    return { out, n: (await db.query("SELECT n FROM h")).rows[0]!.n };
  };
  it("red 1: trusting a lost lock loses an update", async () => {
    expect(await lost({ trustLocks: true })).toEqual({ out: "committed", n: 1 });
  });
  it("detects the lost lock from F", async () => {
    expect(await lost({})).toEqual({ out: "aborted", n: 100 });
  });
  it("m9_impl_wake: wakes a waiter when the holder's lock expires", async () => {
    const c = new SimCluster({ shards: 1, lockTtlMs: 150 });
    const db = new Db(c);
    await db.query("CREATE TABLE h(id INTEGER PRIMARY KEY, n INTEGER)");
    await db.query("INSERT INTO h VALUES (1, 0)");
    const dead = new Db(c);
    await dead.query("BEGIN IMMEDIATE");
    await dead.query("UPDATE h SET n = 1 WHERE id = 1"); // Worker が死んだまま戻らない
    const t0 = c.time;
    await new Db(c).query("UPDATE h SET n = 2 WHERE id = 1");
    expect(c.time - t0).toBeLessThan(1500);
  });
  it("m9_red_leave_silent: a woken waiter that cannot take the lock wakes the next one", async () => {
    const c = new SimCluster({ shards: 1 });
    const db = new Db(c);
    await db.ddl("CREATE TABLE g(t INTEGER, id INTEGER, n INTEGER, PRIMARY KEY (t, id))");
    await db.query("INSERT INTO g VALUES (1, 1, 0), (1, 2, 0)");
    const holder = new Db(c);
    await holder.query("BEGIN IMMEDIATE");
    await holder.query("UPDATE g SET n = 1 WHERE t = 1 AND id = 1");
    const other = new Db(c);
    await other.query("BEGIN IMMEDIATE");
    await other.query("UPDATE g SET n = 1 WHERE t = 1 AND id = 2"); // W1 が次に当たる行
    const w1 = new Db(c);
    await w1.query("BEGIN IMMEDIATE");
    const first = w1.query("UPDATE g SET n = 2 WHERE t = 1"); // 行 1 で待ち、次に行 2 で止まる
    await c.sleep(20);
    const w2 = new Db(c);
    await w2.query("BEGIN IMMEDIATE");
    const t0 = c.time;
    const second = w2.query("UPDATE g SET n = 3 WHERE t = 1 AND id = 1");
    await c.sleep(20);
    await holder.query("COMMIT"); // W1 が起きるが行 2 で止まるので、W2 を起こす必要がある
    await second;
    expect(c.time - t0).toBeLessThan(1500);
    await w2.query("COMMIT");
    await other.query("COMMIT");
    await first.catch(() => {});
    await w1.query("ROLLBACK").catch(() => {});
  });
  it("makes a younger transaction wait, and only then steals from a stuck holder", async () => {
    const { c } = await hot();
    const stuck = new Db(c);
    await stuck.query("BEGIN IMMEDIATE");
    await stuck.query("UPDATE h SET n = 1 WHERE id = 1");
    const old = new Db(c);
    (old as unknown as { startStamp(): number }).startStamp = () => 0; // より古い取引
    await old.query("BEGIN IMMEDIATE");
    const t0 = c.time;
    await old.query("UPDATE h SET n = 2 WHERE id = 1");
    expect(c.time - t0).toBeGreaterThanOrEqual(150);
    await old.query("COMMIT");
    await expect(stuck.query("COMMIT")).rejects.toThrow(/conflict/);
  });
});

// 以下は specs/m9_protocol.qnt の red の反例を、悲観の取引 (BEGIN、BEGIN IMMEDIATE) で流す。
/** 開始時刻を 0 にした接続。wound-wait で、ほかのどの取引よりも古い。 */
function oldest(c: SimCluster): Db {
  const d = new Db(c);
  (d as unknown as { startStamp(): number }).startStamp = () => 0;
  return d;
}
/** Promise が決着したかを、待たずに見る。 */
function watch(p: Promise<unknown>): { done: boolean } {
  const s = { done: false };
  void p.then(() => (s.done = true), () => (s.done = true));
  return s;
}
const lockedReads = (c: SimCluster) => c.net.log.filter((m) => m.method === "exec" && (m.req as ExecReq).lockRows).length;

// m9_red_ro_skip。BEGIN IMMEDIATE の主キーの読みは、ロックを取って最新の状態 (F) を読む。読みごとに時刻が違うので、書き込みのない
// 取引でも COMMIT で検証する (Txn.commit の latest)。モデルの反例と同じ順で流す:
// 1 が x を F でロック読みする (0)。x のロックが TTL で切れる。2 (悲観の取引) が x と y に書いて確定する。
// 1 が y を F でロック読みする (2 の値)。検証せずに終えると、1 は x を 2 の前の値、y を 2 の後の値で読んだまま確定する。
describe("m9_red_ro_skip: a read-only transaction that read under locks is validated at COMMIT", () => {
  const scenario = async (clientFaults: ClientFaults) => {
    const { c, db, A, B } = await cluster({}, { lockTtlMs: 150 });
    await seed(db, A);
    await seed(db, B);
    const r = new Db(c, { faults: clientFaults });
    await r.query("BEGIN IMMEDIATE");
    const x = await getN(r, A);
    c.time += 200; // x のロックが TTL で切れる
    const w = new Db(c);
    await w.query("BEGIN");
    await setN(w, A, 1);
    await setN(w, B, 1);
    await w.query("COMMIT");
    await c.settle();
    const y = await getN(r, B);
    const out = await r.query("COMMIT").then(() => "committed", (e: Error) => e.message);
    return { seen: [x, y], locked: lockedReads(c), out };
  };
  it("put back: without the validation, it commits x from before the writer and y from after it", async () => {
    expect(await scenario({ lockedReadsSkipValidation: true })).toEqual({ seen: [0, 1], locked: 2, out: "committed" });
  });
  it("aborts because x changed after the locked read", async () => {
    const r = await scenario({});
    expect(r.seen).toEqual([0, 1]);
    expect(r.locked).toBe(2);
    expect(r.out).toMatch(/conflict/);
  });
});

// m9_red_second_f。同じ行への 2 回目の DML は、自分の overlay を読むだけで、他者の変更を見ていない。だから検証の窓は最初の DML の F
// から取る。実装では窓の下限が 2 か所にある。書き込みの since (Txn.buffer の min) と、最初の DML が F で記録した範囲である。
// モデルの反例と同じ順で流す: 1 の DML1 が x を F1 で読んで書く。x のロックが TTL で切れる。2 (autocommit) が x に書いて確定する。
// 1 の DML2 が F2 でロックを取り直す。窓を F2 から取ると 2 の確定が窓に入らず、1 は 2 を見ずに上書きする (失われた更新)。
describe("m9_red_second_f: a second DML on a row keeps the window from the first F", () => {
  const scenario = async (clientFaults: ClientFaults) => {
    const c = new SimCluster({ shards: 1, lockTtlMs: 150 });
    const db = new Db(c);
    await db.query("CREATE TABLE h(id INTEGER PRIMARY KEY, n INTEGER)");
    await db.query("INSERT INTO h VALUES (1, 0)");
    const a = new Db(c, { faults: clientFaults });
    await a.query("BEGIN");
    await a.query("UPDATE h SET n = n + 1 WHERE id = 1"); // F1 で 0 を読む
    c.time += 200; // x のロックが TTL で切れる
    await new Db(c).query("UPDATE h SET n = n + 100 WHERE id = 1");
    await a.query("UPDATE h SET n = n + 1 WHERE id = 1"); // F2 でロックを取り直し、自分の overlay (1) を読む
    const out = await a.query("COMMIT").then(() => "committed", (e: Error) => e.message);
    return { out, n: (await db.query("SELECT n FROM h")).rows[0]!.n };
  };
  it("put back: with both bounds moved to the second F, the transaction overwrites the other commit", async () => {
    expect(await scenario({ secondDmlNewSince: true, secondDmlNewSpanSince: true })).toEqual({ out: "committed", n: 2 });
  });
  it("still aborts with only the write's since moved: the first DML's span is validated from the first F", async () => {
    const r = await scenario({ secondDmlNewSince: true });
    expect(r.n).toBe(100);
    expect(r.out).toMatch(/conflict: span changed/);
  });
  it("still aborts with only the first span dropped: the write keeps the first F", async () => {
    const r = await scenario({ secondDmlNewSpanSince: true });
    expect(r.n).toBe(100);
    expect(r.out).toMatch(/conflict: write after T/);
  });
  it("aborts because the other commit is after the first F", async () => {
    const r = await scenario({});
    expect(r.n).toBe(100);
    expect(r.out).toMatch(/conflict/);
  });
});

// m9_red_imm_read_t。BEGIN IMMEDIATE の主キーの読みはロックを取って F で読み、その範囲を F から検証する。T の snapshot で読んで
// F から検証すると、(T, F] の確定を読み落とし、検証もそれを見ない。モデルの反例と同じ順で流す:
// 1 が T を持つ (モデルでは開始時に決まる。実装の T は最初の文で決まるので、2 が触らない行 2 をロック読みして決める)。
// 2 (autocommit) が x に書いて確定する。1 が x をロック読みし、読んだ値から x を書いて確定する。
describe("m9_red_imm_read_t: a locked read in BEGIN IMMEDIATE reads at F, where its window starts", () => {
  const scenario = async (faults: Faults) => {
    const c = new SimCluster({ shards: 1, faults });
    const db = new Db(c);
    await db.query("CREATE TABLE h(id INTEGER PRIMARY KEY, n INTEGER)");
    await db.query("INSERT INTO h VALUES (1, 0), (2, 0)");
    const a = new Db(c);
    await a.query("BEGIN IMMEDIATE");
    await a.query("SELECT n FROM h WHERE id = 2"); // T が決まる
    c.time += 1;
    await new Db(c).query("UPDATE h SET n = 100 WHERE id = 1");
    const read = (await a.query("SELECT n FROM h WHERE id = 1")).rows[0]!.n as number;
    await a.query("UPDATE h SET n = ? WHERE id = 1", [read + 1]);
    const out = await a.query("COMMIT").then(() => "committed", () => "aborted");
    return { read, out, n: (await db.query("SELECT n FROM h WHERE id = 1")).rows[0]!.n, locked: lockedReads(c) };
  };
  it("put back: reading at T misses the commit before F, and the transaction overwrites it", async () => {
    expect(await scenario({ lockedReadAtT: true })).toEqual({ read: 0, out: "committed", n: 1, locked: 2 });
  });
  it("reads the commit and builds on it", async () => {
    expect(await scenario({})).toEqual({ read: 100, out: "committed", n: 101, locked: 2 });
  });
});

// m9_red_f_is_t。悲観の DML とロック読みは、このシャードが発行した F の状態で実行し、F から検証する。F は、要求の T と因果トークン
// まで時計を進めてから発行するので、その後このシャードで確定する書き込みは F より大きい。取引の T で実行して since = T にすると、
// T は別のシャードの時計から来ることがあり、このシャードの時計は T に届いていない。後から確定した書き込みが T 以下の時刻を持ち、
// T からの検証の窓に入らない。TLC の反例の順で流す:
// 1 (古い) と 2 (BEGIN IMMEDIATE) が始まる。2 の T は時計の進んだ y のシャードで決まる。2 が x を T でロック読みする (0)。
// 1 が x を待ち、wound で奪って書き、確定する (c ≤ T)。2 の検証の窓 (T, c] に 1 の確定は入らない。
// モデルの 2 は読むだけで、確定の順と読んだ値の食い違いが反例になる。ここでは読んだ x から x を書かせ、失われた更新として見る
// (書き込みを足したこの順も m9_red_f_is_t で反例になることを、モデルで確かめた)。
// 実装の守りは 2 つある。F を T にしないこと (dmlAtT) と、時計を T と因果トークンまで進めること (dmlSkipsClock) である。
// 時計を T まで進めていれば、T で読んで T から検証するのは楽観の読みと同じで正しい。validateFromT (F で読み T から検証する) は
// 窓を広げるだけで abort が増えるだけなので、この欠陥の代わりにはならない。
describe("m9_red_f_is_t: a pessimistic statement runs at F, a time this shard issued", () => {
  const scenario = async (faults: Faults) => {
    const { c, db, A, B, drift } = await cluster(faults);
    await seed(db, A);
    await seed(db, B);
    drift.set("s1", 1000); // y のシャードの時計が進んでいる
    const l = new Db(c);
    await l.query("BEGIN IMMEDIATE");
    await getN(l, B); // T は s1 の時計で決まる
    const x = (await getN(l, A)) as number; // x をロック読みする
    const T = (c.net.log.find((m) => m.method === "exec" && m.to === "s0" && (m.req as ExecReq).lockRows)!.req as ExecReq).T!;
    const d = oldest(c);
    await d.query("BEGIN");
    const t0 = c.time;
    await setN(d, A, 5); // 2 のロックを待ち、wound で奪う
    expect(c.time - t0).toBeGreaterThanOrEqual(200);
    await d.query("COMMIT");
    // 1 の確定は s0 だけの commitLocal である。その確定の時刻を s0 の変更ログから読む。
    const dTxn = (c.net.log.find((m) => m.method === "commitLocal" && m.to === "s0")!.req as { txn: string }).txn;
    const other = logRows(c.backends.get("s0")!).find((r) => r.txn === dTxn)!.commit_ts as number;
    await setN(l, A, x + 1);
    const out = await l.query("COMMIT").then(() => "committed", (e: Error) => e.message);
    await c.settle();
    return { x, out, n: await getN(db, A), otherAtOrBelowT: other <= T };
  };
  it("put back: running at T with the clock left behind lets the other commit land inside T and be overwritten", async () => {
    expect(await scenario({ dmlAtT: true, dmlSkipsClock: true })).toEqual({ x: 0, out: "committed", n: 1, otherAtOrBelowT: true });
  });
  it("still aborts with only F = T: the clock was moved to T, so the other commit is after T", async () => {
    const r = await scenario({ dmlAtT: true });
    expect(r).toMatchObject({ x: 0, n: 5, otherAtOrBelowT: false });
    expect(r.out).toMatch(/conflict: write after T/);
  });
  it("still aborts with only the clock left behind: F is still a time this shard issued", async () => {
    const r = await scenario({ dmlSkipsClock: true });
    expect(r).toMatchObject({ x: 0, n: 5 });
    expect(r.out).toMatch(/conflict: span changed/);
  });
  it("aborts because the other commit is after F", async () => {
    const r = await scenario({});
    expect(r).toMatchObject({ x: 0, n: 5, otherAtOrBelowT: false });
    expect(r.out).toMatch(/conflict/);
  });
});

// m9_red_wound_prepared。wound-wait で古い取引が若い保持者から奪ってよいのは、ロックだけである。prepare 済みの取引は行を intent で
// 守る (prepare がロックを intent に置き換える)。待ち手は intent を奪わず、決着を待つ。
// TLC の反例: 若い 2 が x をロックし、確定を始める。古い 1 が x を待つ。2 の prepare が x を intent にし、c が決まる (1 シャード)。
// 1 が wound で 2 の intent を捨てて x を取る。2 は確定したのに、x への書き込みが消える (atomicWrites)。
// 実装では、1 シャードの取引は intent を置かずに確定し (commitLocal)、確定済みの intent は待ち手が待つ前に適用する (settleIntents)。
// そこで 2 を 2 シャードの取引にし、x のシャードの prepare の応答を止めて、c が決まる前の intent を 1 に待たせる
// (prepare 済みで c が未定の相手も、モデルでは奪えない。この順もモデルで反例になることを確かめた)。
describe("m9_red_wound_prepared: a wound never takes a prepared transaction's intent", () => {
  const scenario = async (faults: Faults) => {
    const { c, db, A, B } = await cluster(faults);
    await seed(db, A);
    await seed(db, B);
    const young = new Db(c);
    await young.query("BEGIN");
    await young.query("SELECT count(*) FROM users WHERE tenant_id = ?", [B]); // y のシャード (s1) を anchor にする
    await setN(young, A, 1);
    await setN(young, B, 1);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let prepared = false;
    c.net.reply = (m) => {
      if (m.method !== "prepare" || m.to !== "s0") return;
      prepared = true; // x の intent は置かれた。anchor はまだ c を決めていない
      return held;
    };
    const commit = young.query("COMMIT").then(() => "committed", (e: Error) => e.message);
    while (!prepared) await new Promise((r) => setImmediate(r));
    const old = oldest(c);
    await old.query("BEGIN");
    const update = old.query("UPDATE users SET n = n + 10 WHERE tenant_id = ? AND id = 1", [A]);
    const done = watch(update);
    await c.sleep(300); // wound の遅延 (200 ms) を過ぎる
    const waited = !done.done;
    c.net.reply = () => {};
    release();
    const out = await commit;
    await update;
    await old.query("COMMIT");
    await c.settle();
    return { waited, out, x: await getN(db, A), y: await getN(db, B) };
  };
  it("put back: taking the intent drops the write of a transaction that then commits", async () => {
    // 2 は確定し、y の書き込みは残るが x の書き込みは消える。1 は 2 の前の x (0) から書いた。どちらの順に並べても x = 10 にはならない。
    expect(await scenario({ woundPrepared: true })).toEqual({ waited: false, out: "committed", x: 10, y: 1 });
  });
  it("waits for the outcome and builds on the write", async () => {
    expect(await scenario({})).toEqual({ waited: true, out: "committed", x: 11, y: 1 });
  });
});

// m9_red_prepare_waits。prepare は他の取引のロックを待たず、当たれば abort する (validate の row locked by)。待つと、prepare 済みの
// 取引を待つ DML との間に閉路ができる。specs/README.md の説明の順で流す (古い / 若いは入れ替えてある):
// 若い X が x と y をロックする。x のロックが TTL で切れる。古い Y が x をロックする。X の確定で、y のシャードの prepare が y を
// intent にし、anchor (x のシャード) の prepare が Y のロックに当たる。Y は y を書こうとして、X の intent (奪えない) を待つ。
// TLC の反例は、古い側が、確定を始めた若い側のロックを待つ順である。実装の wound は、相手が確定を始めたかを知らずにロックを奪うので、
// その順は閉路にならない。intent は誰も奪えないので、上の順は実装でも閉路になる (この順もモデルで反例になることを確かめた)。
// 実装の閉路は永久には続かず、Y のロックの TTL か待ちの期限 (どちらも 5 秒) で解ける。
describe("m9_red_prepare_waits: prepare aborts on another transaction's lock instead of waiting", () => {
  const scenario = async (faults: Faults) => {
    const { c, db, A, B } = await cluster(faults);
    await seed(db, A);
    await seed(db, B);
    const x = new Db(c);
    await x.query("BEGIN");
    await x.query("SELECT count(*) FROM users WHERE tenant_id = ?", [A]); // x のシャード (s0) を anchor にする
    await setN(x, A, 1);
    c.time += 6000; // x のロックが TTL (5 秒) で切れる
    await setN(x, B, 1); // y のロックは切れていない
    const y = oldest(c);
    await y.query("BEGIN");
    await setN(y, A, 2);
    const t0 = c.time;
    const commit = x.query("COMMIT").then(() => "committed", (e: Error) => e.message);
    while (!c.net.log.some((m) => m.method === "prepare" && m.to === "s1")) await new Promise((r) => setImmediate(r));
    await c.sleep(5); // y の intent が置かれる
    const update = setN(y, B, 2);
    const pending = [watch(commit), watch(update)];
    await c.sleep(1000);
    const stuck = pending.map((s) => !s.done);
    const intents = c.backends.get("s1")!.exec("SELECT count(*) c FROM __intents")[0]!.c; // X の y の intent
    const out = await commit;
    await update.catch(() => {});
    const elapsed = c.time - t0;
    await y.query("COMMIT").catch(() => {});
    await c.settle();
    return { stuck, intents, out, elapsed };
  };
  it("put back: a waiting prepare and a statement waiting for its intent wait for each other until a 5 s timeout", async () => {
    const r = await scenario({ prepareWaits: true });
    expect(r).toMatchObject({ stuck: [true, true], intents: 1 });
    expect(r.elapsed).toBeGreaterThanOrEqual(4000);
  });
  it("aborts the prepare at once, and the statement proceeds", async () => {
    const r = await scenario({});
    expect(r).toMatchObject({ stuck: [false, false], intents: 0 });
    expect(r.out).toMatch(/conflict: row locked/);
  });
});

describe("anchor crash", () => {
  it("presumes abort for a transaction the restarted anchor never decided", async () => {
    const { c, db, A, B } = await cluster();
    await seed(db, A);
    await seed(db, B);
    const w = await db.begin();
    await getN(w, A);
    await getN(w, A);
    await setN(w, A, 1);
    await setN(w, B, 1);
    // prepare が届いた時点で anchor を落とす。
    let crashed = false;
    c.net.gate = (m) => {
      if (m.method === "prepare" && !crashed) {
        crashed = true;
        queueMicrotask(() => c.restart(m.from));
      }
    };
    const out = await w.commit().then(() => "committed", (e) => String(e.message));
    await c.sleep(5);
    c.net.gate = () => {};
    expect(out).toMatch(/conflict/);
    // redrive は ORPHAN_AGE_MS を過ぎた intent だけを片付ける。
    c.time += 3000;
    for (const core of c.cores.values()) await core.redrive();
    await c.settle();
    for (const b of c.backends.values()) expect(b.exec("SELECT count(*) c FROM __intents")[0]!.c).toBe(0);
    expect(await getN(db, A)).toBe(0);
    expect(await getN(db, B)).toBe(0);
  });
  it("finishes phase 2 from the durable record after a crash", async () => {
    const { c, db, A, B } = await cluster();
    await seed(db, A);
    await seed(db, B);
    c.net.drop = (m) => m.method === "finalize";
    const w = await db.begin();
    await setN(w, A, 1);
    await setN(w, B, 1);
    await w.commit();
    await c.settle();
    c.net.drop = () => false;
    for (const id of c.shardIds) c.restart(id);
    for (const core of c.cores.values()) await core.redrive();
    await c.settle();
    expect([await getN(db, A), await getN(db, B)]).toEqual([1, 1]);
    for (const b of c.backends.values()) expect(b.exec("SELECT count(*) c FROM __intents")[0]!.c).toBe(0);
  });
});

// specs/m3_anchor_recovery.qnt の m3_red。anchor は、committed の記録の確定 (sync) を待ってから phase 2 と応答を送る。
// モデルの反例 (counterexampleTest) と同じ順で流す: 全参加者の ack を受けて、anchor が committed の記録を書く (未確定)。
// 参加者 1 へ phase 2 が届いて適用される。anchor が再起動し、確定していない記録を失う。参加者 2 の intent を見た読み手が照会する。
// 記録がなく in-flight でもないので tombstone が書かれ、参加者 2 は intent を捨てる。参加者 1 にだけ書き込みが残る。
// シミュレータの SQLite は既定では書き込みを失わないので、anchor のシャードで、確定していない書き込みを再起動で失わせる (loseUnsynced)。
// anchor (s0) は読むだけの参加者にして、モデルと同じく書き込みを持たせない。参加者 1 は s1、参加者 2 は s2 である。
describe("the anchor syncs its commit record before phase 2 (m3_red)", () => {
  const scenario = async (faults: Faults) => {
    const { c, db, A, B, C } = await cluster(faults);
    await seed(db, A);
    await seed(db, B);
    await seed(db, C);
    c.loseUnsynced("s0"); // ここまでの書き込みは確定済みとする
    const w = await db.begin();
    await getN(w, A); // 書き込みで守られていない読みなので、anchor は s0 になる
    await setN(w, B, 1);
    await setN(w, C, 1);
    // 参加者 2 への phase 2 は届かない。参加者 1 が phase 2 を適用した直後に anchor が再起動する。
    let restarted = false;
    let onRestart!: () => void;
    const restartDone = new Promise<void>((r) => (onRestart = r));
    c.net.drop = (m) => m.method === "finalize" && m.to === "s2";
    c.net.reply = (m) => {
      if (m.method === "finalize" && m.to === "s1" && !restarted) {
        restarted = true;
        c.restart("s0");
        onRestart();
      }
    };
    const out = await w.commit().then(() => "committed", (e: Error) => e.message);
    // s2 への phase 2 が落ちた時点で phase 2 の処理は終わるので、settle だけでは s1 の適用を待てない。
    await restartDone;
    await c.settle();
    c.net.drop = () => false;
    c.net.reply = () => {};
    const commit = c.net.log.find((m) => m.method === "commit" && m.from === "client")!;
    const txn = (commit.req as { txn: string }).txn;
    // 読み手が s2 の行を読み、intent を見つけて anchor に照会する。
    const n = { s1: await getN(new Db(c), B), s2: await getN(new Db(c), C) };
    const record = c.backends.get("s0")!.exec("SELECT status FROM __txn WHERE txn = ?", txn);
    return { anchor: commit.to, restarted, out, n, record };
  };

  it("put back: phase 2 before the sync splits the outcome when the anchor restarts", async () => {
    const s = await scenario({ phase2BeforeSync: true });
    expect(s.anchor).toBe("s0");
    expect(s.restarted).toBe(true);
    // 参加者 1 は適用済み、参加者 2 は intent を捨てた。記録は tombstone で、Worker は確定したと聞いている。
    expect(s.n).toEqual({ s1: 1, s2: 0 });
    expect(s.record).toEqual([{ status: "aborted" }]);
    expect(s.out).toBe("committed");
  });

  it("keeps the record across the restart, so the reader applies the write on the other participant", async () => {
    const s = await scenario({});
    expect(s.anchor).toBe("s0");
    expect(s.restarted).toBe(true);
    expect(s.n).toEqual({ s1: 1, s2: 1 });
    expect(s.record).toEqual([{ status: "committed" }]);
    expect(s.out).toBe("committed");
  });
});
