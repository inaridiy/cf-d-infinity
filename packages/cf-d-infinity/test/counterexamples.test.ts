// 設計レビューと形式モデルで見つけた反例を、本物のシャードコードで再現する。
// 各テストは「欠陥スイッチを入れると壊れ、外すと直る」の両方を確かめる。
import { describe, expect, it } from "vitest";
import { ORDERS, SimCluster, USERS, type SimOptions } from "./sim";
import { Db } from "../src/client/db";
import { ownerOf } from "../src/routing";
import type { Faults } from "../src/types";

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
    await db.ddl(`CREATE TABLE a(tenant_id INTEGER NOT NULL, id INTEGER NOT NULL, code TEXT NOT NULL, PRIMARY KEY (tenant_id,id)) SHARD KEY (tenant_id)`);
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
    await db.ddl(`CREATE TABLE a(tenant INTEGER, id INTEGER, n INTEGER, PRIMARY KEY (tenant, id)) SHARD KEY (tenant)`);
    await db.ddl(`CREATE TABLE b(tenant INTEGER, id INTEGER, n INTEGER, PRIMARY KEY (tenant, id)) SHARD KEY (tenant)`);
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
    await db.ddl("CREATE TABLE g(t INTEGER, id INTEGER, n INTEGER, PRIMARY KEY (t, id)) SHARD KEY (t)");
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
