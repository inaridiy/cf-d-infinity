// 文の形と並行を掛け合わせる検査。
// いくつかの接続が、文のひな形から乱択で文を作り、取引の中と外で並行に流す。phase 2 の配送は乱択で遅らせる。
// 終わったら、確定した取引を確定の時刻の順に並べ、同じ文を 1 つの SQLite で再生して、結果を 1 文ずつ比べる (test/replay.ts)。
// どの試験にも掛かる範囲の検査 (test/setup.ts) も、ここで流した文のすべてに掛かる。
import { describe, expect, it } from "vitest";
import { Db, type Cluster } from "../src/client/db";
import type { Value } from "../src/types";
import { quiescentProblems } from "./invariants";
import { replay, type ReplayReport, type StatementRecord, type TxnRecord } from "./replay";
import { SimCluster } from "./sim";

function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

const DDL = [
  `CREATE TABLE acct(tenant_id INTEGER NOT NULL, id INTEGER NOT NULL, email TEXT, code TEXT, v INTEGER NOT NULL DEFAULT 0, n INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (tenant_id, id), UNIQUE (tenant_id, code), UNIQUE (email)) SHARD KEY (tenant_id)`,
  `CREATE INDEX acct_v ON acct(v)`,
  `CREATE TABLE item(tenant_id INTEGER NOT NULL, id INTEGER NOT NULL, acct_id INTEGER, qty INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (tenant_id, id)) SHARD KEY (tenant_id)`,
  `CREATE TABLE flat(id INTEGER PRIMARY KEY, v INTEGER, tag TEXT)`,
];

type Rnd = () => number;
const int = (r: Rnd, n: number) => 1 + Math.floor(r() * n);
const tenant = (r: Rnd) => int(r, 4);
const id = (r: Rnd) => int(r, 5);
const email = (r: Rnd) => (r() < 0.15 ? null : `e${int(r, 6)}`);
const code = (r: Rnd) => (r() < 0.15 ? null : `c${int(r, 4)}`);
const v = (r: Rnd) => int(r, 4) - 1;
const flatId = (r: Rnd) => int(r, 12);
const tag = (r: Rnd) => `t${int(r, 3)}`;

/** 文のひな形。名前が R で始まるものは読み、W で始まるものは書き込みである。 */
const SHAPES: Record<string, (r: Rnd) => [string, Value[]]> = {
  "R point by primary key": (r) => ["SELECT id, email, code, v, n FROM acct WHERE tenant_id = ? AND id = ?", [tenant(r), id(r)]],
  "R one shard key": (r) => ["SELECT id, v, n FROM acct WHERE tenant_id = ? ORDER BY id", [tenant(r)]],
  "R by a UNIQUE column that spans shards": (r) => ["SELECT tenant_id, id FROM acct WHERE email = ?", [`e${int(r, 6)}`]],
  "R by an indexed column": (r) => ["SELECT tenant_id, id, n FROM acct WHERE v = ? ORDER BY tenant_id, id", [v(r)]],
  "R aggregate over every shard": () => ["SELECT count(*), coalesce(sum(n), 0), coalesce(max(v), -1) FROM acct", []],
  "R every row": () => ["SELECT tenant_id, id, n FROM acct ORDER BY tenant_id, id", []],
  "R join inside one shard key": (r) => [
    `SELECT a.id, count(i.id), coalesce(sum(i.qty), 0) FROM acct a LEFT JOIN item i ON i.tenant_id = a.tenant_id AND i.acct_id = a.id
       WHERE a.tenant_id = ? GROUP BY a.id ORDER BY a.id`, [tenant(r)]],
  "R correlated subquery inside one shard key": (r) => {
    const t = tenant(r);
    return ["SELECT id, (SELECT count(*) FROM item WHERE tenant_id = ? AND acct_id = acct.id) FROM acct WHERE tenant_id = ? ORDER BY id", [t, t]];
  },
  "R join across shard keys": () => [
    "SELECT a.tenant_id, count(*) FROM acct a JOIN item i ON i.tenant_id = a.tenant_id AND i.acct_id = a.id GROUP BY a.tenant_id ORDER BY a.tenant_id", []],
  "R IN list of keys": (r) => ["SELECT id, v FROM flat WHERE id IN (?, ?, ?) ORDER BY id", [flatId(r), flatId(r), flatId(r)]],
  "R group by": () => ["SELECT tag, count(*), coalesce(sum(v), 0) FROM flat GROUP BY tag ORDER BY tag", []],
  "R subquery over every shard": (r) => ["SELECT id FROM flat WHERE v >= (SELECT coalesce(avg(v), 0) FROM flat) AND tag = ? ORDER BY id", [tag(r)]],

  "W insert": (r) => ["INSERT INTO acct(tenant_id, id, email, code, v) VALUES (?, ?, ?, ?, ?)", [tenant(r), id(r), email(r), code(r), v(r)]],
  "W insert or ignore": (r) => ["INSERT OR IGNORE INTO acct(tenant_id, id, email, code, v) VALUES (?, ?, ?, ?, ?)", [tenant(r), id(r), email(r), code(r), v(r)]],
  "W insert or replace": (r) => ["INSERT OR REPLACE INTO acct(tenant_id, id, email, code, v) VALUES (?, ?, ?, ?, ?)", [tenant(r), id(r), email(r), code(r), v(r)]],
  "W upsert on the primary key": (r) => [
    "INSERT INTO acct(tenant_id, id, code, v) VALUES (?, ?, ?, ?) ON CONFLICT (tenant_id, id) DO UPDATE SET n = n + 1", [tenant(r), id(r), code(r), v(r)]],
  "W update by primary key": (r) => ["UPDATE acct SET n = n + 1 WHERE tenant_id = ? AND id = ?", [tenant(r), id(r)]],
  "W update a local UNIQUE column": (r) => ["UPDATE acct SET code = ? WHERE tenant_id = ? AND id = ?", [code(r), tenant(r), id(r)]],
  "W update a UNIQUE column that spans shards": (r) => ["UPDATE acct SET email = ? WHERE tenant_id = ? AND id = ?", [email(r), tenant(r), id(r)]],
  "W update one shard key": (r) => ["UPDATE acct SET v = (v + 1) % 4 WHERE tenant_id = ?", [tenant(r)]],
  "W update across shards": (r) => ["UPDATE acct SET n = n + 1 WHERE v = ?", [v(r)]],
  "W delete by primary key": (r) => ["DELETE FROM acct WHERE tenant_id = ? AND id = ?", [tenant(r), id(r)]],
  "W delete by condition inside one shard key": (r) => ["DELETE FROM item WHERE tenant_id = ? AND qty < ?", [tenant(r), int(r, 3)]],
  "W insert item": (r) => ["INSERT INTO item(tenant_id, id, acct_id, qty) VALUES (?, ?, ?, ?)", [tenant(r), int(r, 8), id(r), int(r, 5)]],
  "W insert ... select inside one shard key": (r) => {
    const t = tenant(r);
    return ["INSERT OR IGNORE INTO item(tenant_id, id, acct_id, qty) SELECT tenant_id, 10 + id, id, v FROM acct WHERE tenant_id = ? AND v = ?", [t, v(r)]];
  },
  "W insert flat": (r) => ["INSERT INTO flat(id, v, tag) VALUES (?, ?, ?)", [flatId(r), int(r, 9), tag(r)]],
  "W insert with a subquery over every shard": (r) => ["INSERT OR IGNORE INTO flat(id, v, tag) VALUES (?, (SELECT coalesce(max(v), 0) + 1 FROM flat), ?)", [flatId(r), tag(r)]],
  "W update with a subquery over every shard": (r) => ["UPDATE flat SET v = (SELECT count(*) FROM flat) WHERE id = ?", [flatId(r)]],
  "W update by a non-key column": (r) => ["UPDATE flat SET v = v + 1 WHERE tag = ?", [tag(r)]],
  "W delete flat": (r) => ["DELETE FROM flat WHERE id = ?", [flatId(r)]],
};
const NAMES = Object.keys(SHAPES);
const RETRYABLE = /^(conflict|read too old|not owner|migrating|upgrading):/;

async function run(seed: number, o: { clients?: number; rounds?: number } = {}): Promise<{ report: ReplayReport; quiescent: string[]; escapes: number }> {
  const rnd = prng(seed);
  const c = new SimCluster({ shards: 3 });
  c.net.jitter = () => (rnd() < 0.5 ? 0 : rnd() * 3);
  // phase 2 の配送を乱択で遅らせる。確定を返した後、適用が届くまでの間の読み書きを作る。
  c.net.gate = (m) => (m.method === "finalize" && rnd() < 0.4 ? new Promise<void>((r) => setTimeout(r, rnd() * 25)) : undefined);
  const admin = c.client();
  for (const s of DDL) await admin.ddl(s);
  const history: TxnRecord[] = [];
  let tick = 0;
  let next = 0;
  const statement = (): StatementRecord => {
    const shape = NAMES[Math.floor(rnd() * NAMES.length)]!;
    const [sql, params] = SHAPES[shape]!(rnd);
    return { shape, sql, params };
  };

  const client = async () => {
    for (let round = 0; round < (o.rounds ?? 25); round++) {
      const rec: TxnRecord = { id: next++, statements: [], outcome: "aborted", readOnly: true, start: ++tick, end: 0, shards: new Set() };
      history.push(rec);
      // この取引が触ったシャードを記録する。読む時点は、最初に触ったシャードで決まる。
      let first: string | undefined;
      const seen: Cluster = {
        shard: (shard) => {
          rec.shards.add(shard);
          first ??= shard;
          return c.shard(shard);
        },
        catalog: () => c.catalog(), applyDdl: (q, b) => c.applyDdl(q, b),
        publishIndex: (t, n, b) => c.publishIndex(t, n, b), allocate: (t, n, m) => c.allocate(t, n, m), switchRange: (m) => c.switchRange(m),
      };
      if (rnd() < 0.4) {
        // 取引の外の 1 文。
        const s = statement();
        rec.statements.push(s);
        try {
          const r = await new Db(seen).query(s.sql, s.params);
          s.values = r.values;
          rec.outcome = "committed";
          rec.at = r.ts;
          rec.readOnly = s.shape.startsWith("R");
        } catch (e) {
          s.error = (e as Error).message;
        }
      } else {
        const tx = await new Db(seen, { retries: 0 }).begin();
        try {
          for (let k = 1 + Math.floor(rnd() * 4); k > 0; k--) {
            const s = statement();
            rec.statements.push(s);
            const from = ++tick;
            try {
              s.values = (await tx.query(s.sql, s.params)).values;
            } catch (e) {
              s.error = (e as Error).message;
              if (RETRYABLE.test(s.error)) throw e;
            } finally {
              s.readAt = tx.T;
              s.span = [from, ++tick];
            }
          }
          await tx.commit();
          // 取引の読む時点は、最初に触ったシャードの時計で決まる。実時間の約束が掛かるのは、そのシャードである。
          // (最初の文が複数シャードの読みなら、対象の全部に掛かるが、ここでは確かめる範囲を狭いほうに取る。)
          if (first !== undefined) rec.firstShards = new Set([first]);
          rec.at = tx.commitTs ?? tx.T;
          rec.readOnly = tx.commitTs === undefined;
          // どの文もエラーで、シャードの状態を何も読み書きしなかった取引は、直列の順序に置く場所がない。再生しない。
          if (rec.at !== undefined || rec.statements.some((x) => x.error === undefined)) rec.outcome = "committed";
        } catch {
          await tx.unlockAll().catch(() => undefined);
        }
      }
      rec.end = ++tick;
    }
  };
  await Promise.all(Array.from({ length: o.clients ?? 5 }, client));
  c.net.gate = () => undefined;
  await c.settle();
  return { report: replay(DDL, history), quiescent: await quiescentProblems(c), escapes: c.spanEscapes.length };
}

describe("statement replay against one SQLite, under concurrency", () => {
  const total: ReplayReport["coverage"] = {};
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    it(`seed ${seed}: every committed statement gives the result of a serial execution in commit order`, async () => {
      const { report, quiescent } = await run(seed);
      for (const [k, x] of Object.entries(report.coverage)) {
        const t = (total[k] ??= { ok: 0, error: 0, unsupported: 0 });
        t.ok += x.ok;
        t.error += x.error;
        t.unsupported += x.unsupported;
      }
      expect(report.problems.slice(0, 5).join("\n\n")).toBe("");
      expect(quiescent).toEqual([]);
      expect(report.committed).toBeGreaterThan(40);
    }, 120_000);
  }

  it("exercises every statement shape: each one succeeded in committed transactions, and none was refused", () => {
    // 断れば合格、で検査が空にならないようにする。対応している形は、確定した取引の中で成功した実行が要る。
    const thin = NAMES.filter((k) => (total[k]?.ok ?? 0) < 5);
    expect(thin).toEqual([]);
    // この表定義と文のひな形には、断る理由のあるものがない。断った文があれば、対応が抜けている。
    expect(NAMES.filter((k) => (total[k]?.unsupported ?? 0) > 0)).toEqual([]);
  });
});
