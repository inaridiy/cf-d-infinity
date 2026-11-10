// 照合順序 (NOCASE など) のある列を主キーや shard key にした表。値の同一性を、経路、分割、検証で同じ規則にする。
import { describe, expect, it } from "vitest";
import { split } from "../src/autoscaler";
import { Db } from "../src/client/db";
import { ownerOf } from "../src/routing";
import { quiescentProblems } from "./invariants";
import { SimCluster } from "./sim";

describe("NOCASE key columns", () => {
  it("(a) every row is still found by its key after a split", async () => {
    const c = new SimCluster({ shards: 1 });
    const db = c.client();
    await db.ddl(`CREATE TABLE acct(name TEXT COLLATE NOCASE PRIMARY KEY, n INTEGER)`);
    const names = Array.from({ length: 40 }, (_, i) => `User${i}`);
    for (const n of names) await db.query("INSERT INTO acct VALUES (?, 1)", [n]);
    const found = async () => {
      const r = new Db(c);
      let hit = 0;
      for (const n of names) hit += (await r.query("SELECT n FROM acct WHERE name = ?", [n])).rows.length;
      return hit;
    };
    expect(await found()).toBe(40);
    await split(c, "s0", "s1");
    const after = await found();
    expect(after).toBe(40);
  });

  it("(b) a read by primary key in another letter case sees a write acknowledged before it started", async () => {
    const c = new SimCluster({ shards: 2 });
    const db = c.client();
    await db.ddl(`CREATE TABLE k(tenant_id INTEGER NOT NULL, code TEXT COLLATE NOCASE NOT NULL, n INTEGER, PRIMARY KEY (tenant_id, code)) SHARD KEY (tenant_id)`);
    const { routing } = await c.catalog();
    const on = (s: string) => { for (let t = 1; ; t++) if (ownerOf(routing, JSON.stringify([t])) === s) return t; };
    const [A, B] = [on("s1"), on("s0")];
    for (const t of [A, B]) await db.query("INSERT INTO k VALUES (?, 'abc', 0)", [t]);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    c.net.gate = (m) => (m.method === "finalize" && m.to === "s1" ? held : undefined);
    const x = await new Db(c).begin();
    await x.query("SELECT n FROM k WHERE tenant_id = ?", [B]); // makes s0 the anchor
    for (const t of [A, B]) await x.query("UPDATE k SET n = 1 WHERE tenant_id = ? AND code = 'abc'", [t]);
    await x.commit(); // acknowledged; s1 still holds only the intent
    expect(c.net.log.some((m) => m.method === "prepare" && m.from === "s0" && m.to === "s1")).toBe(true);
    const sameCase = (await new Db(c).query("SELECT n FROM k WHERE tenant_id = ? AND code = 'abc'", [A])).rows;
    c.net.gate = () => undefined;
    release();
    await c.settle();
    expect(sameCase).toEqual([{ n: 1 }]);
  });

  it("(b') ...and the same read written as 'ABC' does too", async () => {
    const c = new SimCluster({ shards: 2 });
    const db = c.client();
    await db.ddl(`CREATE TABLE k(tenant_id INTEGER NOT NULL, code TEXT COLLATE NOCASE NOT NULL, n INTEGER, PRIMARY KEY (tenant_id, code)) SHARD KEY (tenant_id)`);
    const { routing } = await c.catalog();
    const on = (s: string) => { for (let t = 1; ; t++) if (ownerOf(routing, JSON.stringify([t])) === s) return t; };
    const [A, B] = [on("s1"), on("s0")];
    for (const t of [A, B]) await db.query("INSERT INTO k VALUES (?, 'abc', 0)", [t]);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    c.net.gate = (m) => (m.method === "finalize" && m.to === "s1" ? held : undefined);
    const x = await new Db(c).begin();
    await x.query("SELECT n FROM k WHERE tenant_id = ?", [B]);
    for (const t of [A, B]) await x.query("UPDATE k SET n = 1 WHERE tenant_id = ? AND code = 'abc'", [t]);
    await x.commit();
    expect(c.net.log.some((m) => m.method === "prepare" && m.from === "s0" && m.to === "s1")).toBe(true);
    const otherCase = (await new Db(c).query("SELECT n FROM k WHERE tenant_id = ? AND code = 'ABC'", [A])).rows;
    c.net.gate = () => undefined;
    release();
    await c.settle();
    expect(otherCase).toEqual([{ n: 1 }]);
  });

  it("(c) two transactions inserting keys that differ only in case cannot both commit", async () => {
    const c = new SimCluster({ shards: 2 });
    const db = c.client();
    await db.ddl(`CREATE TABLE k(tenant_id INTEGER NOT NULL, code TEXT COLLATE NOCASE NOT NULL, n INTEGER, PRIMARY KEY (tenant_id, code)) SHARD KEY (tenant_id)`);
    const { routing } = await c.catalog();
    const on = (s: string) => { for (let t = 1; ; t++) if (ownerOf(routing, JSON.stringify([t])) === s) return t; };
    const [A, B] = [on("s1"), on("s0")];
    // phase 2 を止めて、1 つ目の取引の書き込みを intent のままにしておく。
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    c.net.gate = (m) => (m.method === "finalize" ? held : undefined);
    const first = await new Db(c).begin();
    await first.query("INSERT INTO k VALUES (?, 'abc', 1)", [A]);
    await first.query("INSERT INTO k VALUES (?, 'x', 1)", [B]);
    await first.commit();
    const second = await new Db(c, { retries: 0 }).begin();
    const outcome = await (async () => {
      await second.query("INSERT INTO k VALUES (?, 'ABC', 2)", [A]);
      await second.query("INSERT INTO k VALUES (?, 'y', 2)", [B]);
      await second.commit();
      return "committed";
    })().catch((e: Error) => e.message);
    c.net.gate = () => undefined;
    release();
    await c.settle();
    expect(outcome).not.toBe("committed");
    expect(await quiescentProblems(c)).toEqual([]);
    expect((await new Db(c).query("SELECT code, n FROM k WHERE tenant_id = ?", [A])).rows).toEqual([{ code: "abc", n: 1 }]);
  });
});
