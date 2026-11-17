// 開いている取引と、ほかの接続の DDL (計画書の未解決の問題 53、docs/design-catalog-epoch.md の「表ごとの epoch」、モデル M24)。
//
// 約束 (docs/sql-language.md の「取引の中の DDL」と「DDL」)。
//   - 別の接続の DDL が取引を古くするのは、その DDL が、取引の文が頼る表 (読む表、書く表、view の元の表) を変えて確定したときだけである。
//     別の表の DDL、新しい表を作る DDL、失敗した DDL は、取引を古くしない (M24 の noRefusalUnrelated、noRefusalWithoutChange)。
//   - 頼る表を変えた DDL が確定した後は、その表を読む文と書く文、その表を読んだか書いた取引の COMMIT が SQLITE_BUSY で断られる。
//   - index を作るか消すだけの DDL の後は、その表を読む文と、その表を読んだだけの取引の COMMIT は通る (読みの epoch と書き込みの epoch)。
// 段 3 までは、表定義全体の epoch を 1 つ名乗り、その epoch が prepare、commit、abort のどれでも進んだので、どの DDL も、開いている
// 取引を全部古くした。
//
// 取引の形は 3 つである。SQL の BEGIN (悲観)、Worker の中の Db.begin() (楽観)、接続をまたぐ取引 (Hrana の baton。文ごとに書き出して
// 組み立て直す)。欠陥のスイッチを渡すと、同じ場面が、モデルの赤の再生になる。
import { describe, expect, it } from "vitest";
import { split } from "../../src/autoscaler";
import { Db, type ClientFaults, type QueryResult, type Txn } from "../../src/client/db";
import { ownerOf, planSplit, tokenOf } from "../../src/routing";
import type { Faults } from "../../src/types";
import { tenantOn } from "../ddl-harness";
import { SimCluster } from "../sim";

/** Hrana が SQLITE_BUSY にする誤り (src/client/hrana.ts)。 */
export const BUSY = /^(conflict|read too old|not owner|migrating|upgrading)/;
const outcome = (p: Promise<unknown>) => p.then(() => "ok", (e: Error) => (BUSY.test(e.message) ? "busy" : e.message));
const table = (name: string) => `CREATE TABLE ${name}(tenant_id INTEGER NOT NULL, id INTEGER NOT NULL, v INTEGER, PRIMARY KEY (tenant_id, id))`;

export type Kind = "BEGIN" | "Db.begin()" | "baton";
export const KINDS: Kind[] = ["BEGIN", "Db.begin()", "baton"];

/** 取引 1 件。形によらず、同じ手で使う。 */
export interface Session {
  run(sql: string, params?: (number | string | null)[]): Promise<QueryResult>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

export async function open(c: SimCluster, kind: Kind, faults?: ClientFaults): Promise<Session> {
  if (kind === "Db.begin()") {
    const tx: Txn = await new Db(c, { retries: 0, faults }).begin();
    return { run: (sql, params) => tx.query(sql, params), commit: () => tx.commit(), rollback: () => tx.unlockAll() };
  }
  let db = new Db(c, { retries: 0, faults });
  await db.query("BEGIN");
  // 接続をまたぐ取引は、文ごとに、状態を書き出して、新しい接続で組み立て直す (Hrana の baton と同じ)。
  const hop = async () => {
    if (kind !== "baton") return;
    const d = structuredClone(db.dump());
    db = new Db(c, { retries: 0, faults });
    await db.restore(d);
  };
  return {
    run: async (sql, params) => {
      await hop();
      return db.query(sql, params);
    },
    commit: async () => {
      await hop();
      await db.query("COMMIT");
    },
    rollback: async () => {
      await hop();
      await db.query("ROLLBACK");
    },
  };
}

export interface Scene {
  c: SimCluster;
  /** s0 の tenant と s1 の tenant。 */
  A: number;
  B: number;
  ddl(sql: string): Promise<string>;
  value(tableName: string, tenant: number, id?: number): Promise<unknown>;
}

/** 2 シャード。表 a と b に、s0 の tenant A と s1 の tenant B の行を 2 つずつ置く。v は、どの行も 1 である。 */
export async function scene(faults?: Faults, clientFaults?: ClientFaults): Promise<Scene> {
  const c = new SimCluster({ shards: 2, faults, clientFaults });
  const db = new Db(c);
  await db.ddl(table("a"));
  await db.ddl(table("b"));
  const A = await tenantOn(c, "s0");
  const B = await tenantOn(c, "s1");
  for (const t of ["a", "b"]) for (const tenant of [A, B]) await db.query(`INSERT INTO ${t} VALUES (?, 1, 1), (?, 2, 1)`, [tenant, tenant]);
  return {
    c, A, B,
    ddl: (sql) => outcome(new Db(c).ddl(sql)),
    value: async (tableName, tenant, id = 1) => (await new Db(c).query(`SELECT v FROM ${tableName} WHERE tenant_id = ? AND id = ?`, [tenant, id])).rows[0]?.v,
  };
}

/**
 * 取引が a を読んで書いた後で、別の接続が、関係のない表を作り、関係のない表 b の DDL に失敗する。取引は a の読み書きを続けて確定する。
 * 悲観の取引は、書いた行のロックを持つ。b の DDL は b の行ロックだけを待つので、取引を待たない。
 */
export async function acrossUnrelated(kind: Kind, faults?: Faults, clientFaults?: ClientFaults) {
  const s = await scene(faults, clientFaults);
  const tx = await open(s.c, kind, clientFaults);
  const steps: Record<string, unknown> = {};
  steps.read = (await tx.run("SELECT v FROM a WHERE tenant_id = ? AND id = 1", [s.A])).rows[0]?.v;
  steps.write = await outcome(tx.run("UPDATE a SET v = v + 1 WHERE tenant_id = ? AND id = 1", [s.B]));
  steps.created = await s.ddl("CREATE TABLE n(id INTEGER PRIMARY KEY, v INTEGER)");
  // b の s0 の 2 行は同じ v を持つので、(tenant_id, v) の UNIQUE index は、s0 の試しで失敗する (prepare の後の abort)。
  steps.failed = await s.ddl("CREATE UNIQUE INDEX bu ON b(tenant_id, v)");
  steps.readAfter = await outcome(tx.run("SELECT v FROM a WHERE tenant_id = ? AND id = 1", [s.B]));
  steps.writeAfter = await outcome(tx.run("UPDATE a SET v = v + 10 WHERE tenant_id = ? AND id = 1", [s.A]));
  // 取引のスナップショットに、後から作られた表はない。SQLite で、読み始めた取引から、後で作られた表が見えないのと同じである。
  steps.newTable = await outcome(tx.run("SELECT count(*) FROM n"));
  steps.commit = await outcome(tx.commit());
  return { ...steps, A: await s.value("a", s.A), B: await s.value("a", s.B) };
}
export const UNRELATED_OK = {
  read: 1, write: "ok", created: "ok", failed: expect.stringMatching(/UNIQUE constraint failed/), readAfter: "ok", writeAfter: "ok",
  newTable: expect.stringMatching(/no such table: n/), commit: "ok", A: 11, B: 2,
};

/**
 * 取引が読んだ表 a の DDL が失敗する (a の s0 の 2 行は同じ v)。失敗した DDL は何も変えないので、a を読んだ取引は続けられる。
 * 悲観の取引は、DDL の前には a を読むだけにする (書くと行ロックを持ち、DDL のほうが待つ。test/ddl-waits-for-row-locks)。
 */
export async function acrossFailedOnTouched(kind: Kind, faults?: Faults, clientFaults?: ClientFaults) {
  const s = await scene(faults, clientFaults);
  const tx = await open(s.c, kind, clientFaults);
  const steps: Record<string, unknown> = {};
  steps.read = (await tx.run("SELECT v FROM a WHERE tenant_id = ? AND id = 1", [s.A])).rows[0]?.v;
  if (kind === "Db.begin()") steps.write = await outcome(tx.run("UPDATE a SET v = v + 1 WHERE tenant_id = ? AND id = 1", [s.B]));
  steps.failed = await s.ddl("CREATE UNIQUE INDEX au ON a(tenant_id, v)");
  steps.readAfter = await outcome(tx.run("SELECT v FROM a WHERE tenant_id = ? AND id = 2", [s.A]));
  steps.writeAfter = await outcome(tx.run("UPDATE a SET v = v + 10 WHERE tenant_id = ? AND id = 1", [s.A]));
  steps.commit = await outcome(tx.commit());
  return { ...steps, A: await s.value("a", s.A) };
}

/** 取引が a を読んだ後で、a の DDL が確定する。ddl は、a を変える文である。その後の、a の読み、a の書き込み、b の読みと、COMMIT の成否。 */
export async function afterCommitted(kind: Kind, ddl: string, o: { wroteA?: boolean; faults?: Faults; clientFaults?: ClientFaults } = {}) {
  const s = await scene(o.faults, o.clientFaults);
  const tx = await open(s.c, kind, o.clientFaults);
  const steps: Record<string, unknown> = {};
  await tx.run("SELECT v FROM a WHERE tenant_id = ? AND id = 1", [s.A]);
  // 別の表への書き込み。COMMIT が、a の読みを検証する取引になる。
  await tx.run("UPDATE b SET v = v + 1 WHERE tenant_id = ? AND id = 1", [s.B]);
  if (o.wroteA) await tx.run("UPDATE a SET v = v + 1 WHERE tenant_id = ? AND id = 2", [s.B]);
  steps.ddl = await s.ddl(ddl);
  steps.readB = await outcome(tx.run("SELECT v FROM b WHERE tenant_id = ? AND id = 2", [s.A]));
  steps.readA = await outcome(tx.run("SELECT v FROM a WHERE tenant_id = ? AND id = 2", [s.A]));
  return { s, tx, steps };
}

describe("an open transaction and another connection's schema change", () => {
  for (const kind of KINDS) {
    it(`${kind}: crosses an unrelated CREATE TABLE and an unrelated failed DDL, and commits`, async () => {
      expect(await acrossUnrelated(kind)).toEqual(UNRELATED_OK);
    });

    it(`${kind}: continues after a DDL on a table it read failed`, async () => {
      expect(await acrossFailedOnTouched(kind)).toEqual({
        read: 1, ...(kind === "Db.begin()" ? { write: "ok" } : {}), failed: expect.stringMatching(/UNIQUE constraint failed/),
        readAfter: "ok", writeAfter: "ok", commit: "ok", A: 11,
      });
    });

    it(`${kind}: after ADD COLUMN on a table it read commits, reads of that table and the COMMIT are busy, other tables still answer`, async () => {
      const { tx, steps } = await afterCommitted(kind, "ALTER TABLE a ADD COLUMN x INTEGER");
      expect(steps).toEqual({ ddl: "ok", readB: "ok", readA: "busy" });
      expect(await outcome(tx.commit())).toBe("busy");
    });

    it(`${kind}: after a plain CREATE INDEX on a table it only read, reads of that table and the COMMIT pass, writes to it are busy`, async () => {
      const { s, tx, steps } = await afterCommitted(kind, "CREATE INDEX ai ON a(v)");
      expect(steps).toEqual({ ddl: "ok", readB: "ok", readA: "ok" });
      expect(await outcome(tx.run("UPDATE a SET v = v + 10 WHERE tenant_id = ? AND id = 1", [s.A]))).toBe("busy");
      expect(await outcome(tx.commit())).toBe("ok");
      expect(await s.value("b", s.B)).toBe(2);
    });

    it(`${kind}: after DROP INDEX on a table it only read, reads of that table and the COMMIT pass`, async () => {
      const s0 = await scene();
      await s0.ddl("CREATE INDEX ai ON a(v)");
      const tx = await open(s0.c, kind);
      await tx.run("SELECT v FROM a WHERE tenant_id = ? AND id = 1", [s0.A]);
      await tx.run("UPDATE b SET v = v + 1 WHERE tenant_id = ? AND id = 1", [s0.B]);
      expect(await s0.ddl("DROP INDEX ai")).toBe("ok");
      expect(await outcome(tx.run("SELECT v FROM a WHERE tenant_id = ? AND id = 2", [s0.A]))).toBe("ok");
      expect(await outcome(tx.commit())).toBe("ok");
    });

    it(`${kind}: a table it first touches after that table's ADD COLUMN committed is busy, and the transaction goes on`, async () => {
      const s = await scene();
      const tx = await open(s.c, kind);
      await tx.run("UPDATE a SET v = v + 1 WHERE tenant_id = ? AND id = 1", [s.A]);
      expect(await s.ddl("ALTER TABLE b ADD COLUMN x INTEGER")).toBe("ok");
      expect(await outcome(tx.run("SELECT v FROM b WHERE tenant_id = ? AND id = 1", [s.A]))).toBe("busy");
      expect(await outcome(tx.run("UPDATE a SET v = v + 10 WHERE tenant_id = ? AND id = 1", [s.A]))).toBe("ok");
      expect(await outcome(tx.commit())).toBe("ok");
      expect(await s.value("a", s.A)).toBe(12);
    });
  }

  // 楽観の取引は、COMMIT まで行ロックを持たないので、書いた表の DDL を待たせない。COMMIT が断られる。
  it("Db.begin(): a transaction that wrote a table cannot commit after a plain CREATE INDEX on it committed", async () => {
    const { tx, steps } = await afterCommitted("Db.begin()", "CREATE INDEX ai ON a(v)", { wroteA: true });
    expect(steps).toEqual({ ddl: "ok", readB: "ok", readA: "ok" });
    expect(await outcome(tx.commit())).toBe("busy");
  });

  // view を通る読みは、view の元の表にも頼る (M24 の EXPAND_VIEW)。
  for (const kind of KINDS) {
    it(`${kind}: a read through a view is busy after the view's base table changed, and passes after an unrelated change`, async () => {
      const s = await scene();
      await s.ddl("CREATE VIEW va AS SELECT tenant_id, id, v FROM a");
      const tx = await open(s.c, kind);
      expect((await tx.run("SELECT count(*) AS n FROM va")).rows[0]?.n).toBe(4);
      expect(await s.ddl("ALTER TABLE b ADD COLUMN x INTEGER")).toBe("ok");
      expect(await outcome(tx.run("SELECT count(*) AS n FROM va"))).toBe("ok");
      expect(await s.ddl("ALTER TABLE a ADD COLUMN x INTEGER")).toBe("ok");
      expect(await outcome(tx.run("SELECT count(*) AS n FROM va"))).toBe("busy");
    });
  }

  // 取引が触らない行の範囲が動き、関係のない DDL が確定する。取引は、範囲表だけを取り替えて続く (Txn.reroute、Txn.load)。
  for (const kind of ["Db.begin()", "baton"] as Kind[]) {
    it(`${kind}: crosses an unrelated DDL and a split that moves none of its rows, and commits`, async () => {
      const s = await scene();
      const { routing } = await s.c.catalog();
      const range = planSplit(routing, "s0")!;
      const key = (t: number) => JSON.stringify([t]);
      const inside = (t: number) => {
        const token = tokenOf(key(t), key(t));
        return token >= range.start && token < range.end;
      };
      // s0 に残る tenant と、s2 へ動く tenant。
      const tenants = Array.from({ length: 200 }, (_v, i) => i + 1).filter((t) => ownerOf(routing, key(t)) === "s0");
      const stay = tenants.find((t) => !inside(t))!;
      const moved = tenants.find(inside)!;
      const db = new Db(s.c);
      await db.query("INSERT OR IGNORE INTO a VALUES (?, 1, 1), (?, 1, 1)", [stay, moved]);
      const tx = await open(s.c, kind);
      expect((await tx.run("SELECT v FROM a WHERE tenant_id = ? AND id = 1", [stay])).rows[0]?.v).toBe(1);
      await tx.run("UPDATE a SET v = v + 1 WHERE tenant_id = ? AND id = 1", [s.B]);
      expect(await s.ddl("CREATE TABLE n(id INTEGER PRIMARY KEY, v INTEGER)")).toBe("ok");
      await split(s.c, "s0", "s2", { range });
      expect(ownerOf((await s.c.catalog()).routing, key(moved))).toBe("s2");
      // 動いた行への、取引の最初の文。古い範囲表の宛先 (s0) が断り、取引は範囲表を取り替えて s2 へ送る。表定義は取引のスナップショットの
      // ままである。悲観の取引が動いた行を書いて確定する形は、未解決の問題 37 (test/open/locking-transaction-commit-after-split) なので、
      // ここでは楽観の取引だけが書く。
      const writesMoved = kind === "Db.begin()";
      if (writesMoved) expect(await outcome(tx.run("UPDATE a SET v = v + 5 WHERE tenant_id = ? AND id = 1", [moved]))).toBe("ok");
      expect(await outcome(tx.run("UPDATE a SET v = v + 10 WHERE tenant_id = ? AND id = 1", [stay]))).toBe("ok");
      expect(await outcome(tx.commit())).toBe("ok");
      expect([await s.value("a", stay), await s.value("a", moved), await s.value("a", s.B)]).toEqual([11, writesMoved ? 6 : 1, 2]);
    });
  }
});
