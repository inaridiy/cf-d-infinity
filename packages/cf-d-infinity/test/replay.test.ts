// 文の形と並行を掛け合わせる検査。
// いくつかの接続が、文のひな形から乱択で文を作り、取引の中と外で並行に流す。phase 2 の配送は乱択で遅らせる。
// 終わったら、確定した取引を確定の時刻の順に並べ、同じ文を 1 つの SQLite で再生して、結果を 1 文ずつ比べる (test/replay.ts)。
// どの試験にも掛かる範囲の検査 (test/setup.ts) も、ここで流した文のすべてに掛かる。
//
// 実行は seed で決まる。待ちは仮想の時計で測り、乱数は seed から作る。失敗した seed は、同じ seed で再現する。
import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Db, Txn, type ClientFaults, type Cluster } from "../src/client/db";
import type { Faults, Value } from "../src/types";
import { quiescentProblems } from "./invariants";
import { replay, type ReplayReport, type StatementRecord, type TxnRecord } from "./replay";
import { prng, seedsOr, SimCluster } from "./sim";

const DDL = [
  `CREATE TABLE acct(tenant_id INTEGER NOT NULL, id INTEGER NOT NULL, email TEXT, code TEXT, v INTEGER NOT NULL DEFAULT 0, n INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (tenant_id, id), UNIQUE (tenant_id, code), UNIQUE (email)) SHARD KEY (tenant_id)`,
  `CREATE INDEX acct_v ON acct(v)`,
  `CREATE TABLE item(tenant_id INTEGER NOT NULL, id INTEGER NOT NULL, acct_id INTEGER, qty INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (tenant_id, id)) SHARD KEY (tenant_id)`,
  `CREATE TABLE flat(id INTEGER PRIMARY KEY, v INTEGER, tag TEXT)`,
  `CREATE TABLE one(id INTEGER PRIMARY KEY)`,
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
  // 1 シャードへ送った文が、別のシャードの行と衝突する。衝突を自分で解決する文は、基準経路で実行し直される。
  "W update or replace a UNIQUE column that spans shards": (r) => ["UPDATE OR REPLACE acct SET email = ? WHERE tenant_id = ? AND id = ?", [email(r), tenant(r), id(r)]],
  "W update or ignore a UNIQUE column that spans shards": (r) => ["UPDATE OR IGNORE acct SET email = ?, n = n + 1 WHERE tenant_id = ? AND id = ?", [email(r), tenant(r), id(r)]],
  "W update or replace a UNIQUE column inside one shard key": (r) => ["UPDATE OR REPLACE acct SET code = ? WHERE tenant_id = ? AND id = ?", [code(r), tenant(r), id(r)]],
  // FROM に現れない表を読む文 (`x IN 表名`)。その表の行は、どのシャードにもある。
  "W insert one": (r) => ["INSERT OR IGNORE INTO one VALUES (?)", [flatId(r)]],
  "W delete one": (r) => ["DELETE FROM one WHERE id = ?", [flatId(r)]],
  "W insert with a table operand": (r) => ["INSERT OR IGNORE INTO flat(id, v, tag) VALUES (?, ? IN one, ?)", [flatId(r), flatId(r), tag(r)]],
  "W update with a table operand": (r) => ["UPDATE flat SET v = v + 1 WHERE id = ? AND ? IN one", [flatId(r), flatId(r)]],
  "R with a table operand": (r) => ["SELECT id, ? IN one FROM flat WHERE id = ?", [flatId(r), flatId(r)]],
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

// 実行の途中で、シャードをまたぐ UNIQUE の index を作る場合の表と文。a は値の種類が多く、index はたいてい作れる。
// b は重複だらけで、作れない。index があるかないかで結果が変わる文を並べる。
const TOK = `CREATE TABLE tok(id INTEGER PRIMARY KEY, a INTEGER, b INTEGER)`;
const tokId = (r: Rnd) => int(r, 10);
const tokA = (r: Rnd) => (r() < 0.1 ? null : int(r, 16));
const tokB = (r: Rnd) => int(r, 3);
const TOK_SHAPES: Record<string, (r: Rnd) => [string, Value[]]> = {
  "R tok by the column being indexed": (r) => ["SELECT id, b FROM tok WHERE a = ? ORDER BY id", [int(r, 16)]],
  "R tok rows that share a value": () => ["SELECT count(*) FROM tok x JOIN tok y ON x.a = y.a AND x.id < y.id", []],
  "R every tok": () => ["SELECT id, a, b FROM tok ORDER BY id", []],
  "W insert tok": (r) => ["INSERT INTO tok(id, a, b) VALUES (?, ?, ?)", [tokId(r), tokA(r), tokB(r)]],
  "W insert or ignore tok": (r) => ["INSERT OR IGNORE INTO tok(id, a, b) VALUES (?, ?, ?)", [tokId(r), tokA(r), tokB(r)]],
  "W insert or replace tok": (r) => ["INSERT OR REPLACE INTO tok(id, a, b) VALUES (?, ?, ?)", [tokId(r), tokA(r), tokB(r)]],
  "W update the column being indexed": (r) => ["UPDATE tok SET a = ? WHERE id = ?", [tokA(r), tokId(r)]],
  "W update or replace the column being indexed": (r) => ["UPDATE OR REPLACE tok SET a = ? WHERE id = ?", [tokA(r), tokId(r)]],
  "W update or ignore the column being indexed": (r) => ["UPDATE OR IGNORE tok SET a = ?, b = b + 1 WHERE id = ?", [tokA(r), tokId(r)]],
  "W update tok across shards": (r) => ["UPDATE tok SET b = ? WHERE a > ?", [tokB(r), int(r, 16)]],
  "W delete tok": (r) => ["DELETE FROM tok WHERE id = ?", [tokId(r)]],
};
const TOK_NAMES = Object.keys(TOK_SHAPES);

interface RunOptions {
  clients?: number;
  rounds?: number;
  /** 実行の途中で、tok にシャードをまたぐ UNIQUE の index を作る。文の半分を tok に向ける。 */
  ddl?: boolean;
  faults?: Faults;
  clientFaults?: ClientFaults;
}
interface RunResult {
  report: ReplayReport;
  quiescent: string[];
  escapes: number;
  fingerprint: string;
  /** 実行の途中の DDL と、その結果。 */
  ddl: string[];
}
const RETRYABLE = /^(conflict|read too old|not owner|migrating|upgrading):/;
/** 再起動で捨てられたシャードの実体が返す誤り。要求は何も書いていない。文の結果ではないので、取引ごと捨てる。 */
const RESTARTED = /^fenced instance/;

async function run(seed: number, o: RunOptions = {}): Promise<RunResult> {
  const rnd = prng(seed);
  // index を作る場合は、シャードの時計をずらす。時計の遅いシャードで index を使う文が、時計の進んだシャードの古い書き込みより
  // 前に並ばないことを確かめるためである。
  const skew: Record<string, number> = { s0: 0, s1: 200, s2: -200 };
  const c = new SimCluster({ shards: 3, seed, faults: o.faults, ...(o.ddl ? { skewMs: (id: string) => skew[id] ?? 0 } : {}) });
  const ddl = o.ddl ? [...DDL, TOK] : DDL;
  c.net.jitter = () => (rnd() < 0.5 ? 0 : rnd() * 3);
  // phase 2 の配送を乱択で遅らせる。確定を返した後、適用が届くまでの間の読み書きを作る。
  c.net.gate = (m) => (m.method === "finalize" && rnd() < 0.4 ? c.sleep(rnd() * 25) : undefined);
  const admin = c.client();
  for (const s of ddl) await admin.ddl(s);
  const history: TxnRecord[] = [];
  let tick = 0;
  let next = 0;
  const statement = (): StatementRecord => {
    if (o.ddl && rnd() < 0.5) {
      const shape = TOK_NAMES[Math.floor(rnd() * TOK_NAMES.length)]!;
      const [sql, params] = TOK_SHAPES[shape]!(rnd);
      return { shape, sql, params };
    }
    const shape = NAMES[Math.floor(rnd() * NAMES.length)]!;
    const [sql, params] = SHAPES[shape]!(rnd);
    return { shape, sql, params };
  };

  // 実行の途中の DDL。成功した DDL は、公開の時刻の位置で再生する。index を使わずに確定した書き込みは、その時刻以下で、
  // index を使う文は、その時刻より後である。失敗した DDL は、何も変えていないはずなので、再生しない。
  const ddlLog: string[] = [];
  let working = 0;
  const schemaChanges = async () => {
    const made = new Set<string>();
    for (let i = 0; i < 5 && working > 0; i++) {
      await c.sleep(10 + rnd() * 60);
      const col = !made.has("a") && rnd() < 0.7 ? "a" : "b";
      if (made.has(col)) continue;
      // シャードを 1 つ再起動する。再起動したシャードの時計は、保存してある上限まで進む (約 1 秒)。その後の書き込みは、
      // ほかのシャードより大きい時刻で確定する。index を作る直前の書き込みと、作った直後の文の時刻が、離れやすくなる。
      if (rnd() < 0.5) c.restart(c.shardIds[Math.floor(rnd() * c.shardIds.length)]!);
      const sql = `CREATE UNIQUE INDEX tok_${col} ON tok(${col})`;
      const rec: TxnRecord = {
        id: next++, statements: [{ shape: `D create a UNIQUE index on ${col}`, sql, params: [] }], outcome: "aborted", readOnly: false,
        start: ++tick, end: 0, shards: new Set(c.shardIds),
      };
      history.push(rec);
      try {
        await new Db(c).ddl(sql);
        const at = (await c.meta.ddlSince(0)).ddl.findLast((e) => e.at !== undefined && e.indexes?.[`tok_${col}`] !== undefined)?.at;
        if (at === undefined) throw new Error(`the version that published tok_${col} carries no timestamp`);
        rec.statements[0]!.values = [];
        rec.outcome = "committed";
        rec.at = at + 0.5;
        made.add(col);
        ddlLog.push(`${col}: ok`);
      } catch (e) {
        rec.statements[0]!.error = (e as Error).message;
        ddlLog.push(`${col}: ${(e as Error).message}`);
      }
      rec.end = ++tick;
    }
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
        runtime: c.runtime, reference: c.reference, catalog: () => c.catalog(), applyDdl: (q, b) => c.applyDdl(q, b),
        publishIndex: (t, n, v, at) => c.publishIndex(t, n, v, at), revokeDdl: (v, r) => c.revokeDdl(v, r), renewLock: (v) => c.renewLock(v), lockTables: (t, b) => c.lockTables(t, b), finishLock: (v, q) => c.finishLock(v, q), allocate: (t, n, m) => c.allocate(t, n, m), switchRange: (m) => c.switchRange(m),
      };
      if (rnd() < 0.4) {
        // 取引の外の 1 文。
        const s = statement();
        rec.statements.push(s);
        try {
          const r = await new Db(seen).query(s.sql, s.params);
          s.values = r.values;
          if (s.shape.startsWith("W")) s.changes = r.changes;
          rec.outcome = "committed";
          rec.at = r.ts;
          // 何も書かなかった文 (無視された INSERT OR IGNORE、該当する行のない UPDATE など) は、読んだだけである。
          // 返る時刻は確定の時刻ではなく、読んだ時刻である。同じ時刻の書き込みを見ているので、読みとして、その後に並べる。
          rec.readOnly = s.shape.startsWith("R") || r.changes === 0;
        } catch (e) {
          s.error = (e as Error).message;
        }
      } else {
        let tx = await new Db(seen, { retries: 0 }).begin();
        try {
          for (let k = 1 + Math.floor(rnd() * 4); k > 0; k--) {
            // 接続をまたぐ取引。状態を書き出し、別の接続で組み立て直して続ける。その接続は、そのときの最新の表定義を持つ。
            if (o.ddl && rec.statements.length > 0 && rnd() < 0.3) {
              const other = new Db(seen, { retries: 0, faults: o.clientFaults });
              tx = Txn.load(other, await other.catalog(), tx.dump());
            }
            // 取引を長くして、index を作る作業をまたぎやすくする。
            if (o.ddl && rnd() < 0.3) await c.sleep(rnd() * 40);
            const s = statement();
            rec.statements.push(s);
            const from = ++tick;
            try {
              const r = await tx.query(s.sql, s.params);
              s.values = r.values;
              if (s.shape.startsWith("W")) s.changes = r.changes;
            } catch (e) {
              s.error = (e as Error).message;
              if (RETRYABLE.test(s.error) || RESTARTED.test(s.error)) throw e;
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
  working = o.clients ?? 5;
  const clients = Array.from({ length: working }, () => client().finally(() => working--));
  await Promise.all([...clients, ...(o.ddl ? [schemaChanges()] : [])]);
  c.net.gate = () => undefined;
  await c.settle();
  const quiescent = await quiescentProblems(c);
  // 失敗した seed を調べるための書き出し。REPLAY_DUMP=<ファイル> で、取引の記録と RPC の記録を JSON で残す。
  if (process.env.REPLAY_DUMP) {
    const plain = (_k: string, x: unknown) => (x instanceof Set ? [...x] : x instanceof Uint8Array ? [...x] : x);
    writeFileSync(process.env.REPLAY_DUMP, JSON.stringify({ seed, history, rpc: c.net.log }, plain));
  }
  return { report: replay(ddl, history), quiescent, escapes: c.spanEscapes.length, fingerprint: c.fingerprint(), ddl: ddlLog };
}

describe("the simulator is deterministic", () => {
  // これが落ちたら、実行のどこかに、本物のタイマー、本物の時計、seed から作っていない乱数が混ざっている。
  // そうなると、検査が見つけた失敗を seed から再現できない。
  it("the same seed gives the same run, down to every RPC", async () => {
    const a = await run(3);
    const b = await run(3);
    expect(b.fingerprint).toBe(a.fingerprint);
    expect(b.report.coverage).toEqual(a.report.coverage);
    // 別のクラスタと同時に流しても変わらない。クラスタは、時計も、乱数も、覚え書きも、ほかと共有しない。
    const [c, other] = await Promise.all([run(3), run(4)]);
    expect(c.fingerprint).toBe(a.fingerprint);
    expect(other.fingerprint).not.toBe(a.fingerprint);
  }, 120_000);
});

describe("statement replay against one SQLite, under concurrency", () => {
  const total: ReplayReport["coverage"] = {};
  for (const seed of seedsOr([1, 2, 3, 4, 5, 6, 7, 8])) {
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

// 行のある表に、シャードをまたぐ UNIQUE の index を、文が流れている最中に作る (specs/m12_unique_index_build.qnt)。
// index があるかないかで、文の結果は変わる (UNIQUE 違反で失敗する、衝突する行を消す、無視する)。成功した DDL を、公開の時刻の
// 位置に置いて SQLite で再生し、どの文の結果も同じであることを確かめる。失敗した DDL は、どの文の結果も変えていないはずである。
describe("statement replay with a UNIQUE index that spans shards built during the run", () => {
  const total: ReplayReport["coverage"] = {};
  const outcomes: string[] = [];
  for (const seed of seedsOr([1, 2, 3, 4, 5, 6, 7, 8])) {
    it(`seed ${seed}: every committed statement gives the result of a serial execution that includes the schema change`, async () => {
      const { report, quiescent, ddl } = await run(seed, { ddl: true });
      for (const [k, x] of Object.entries(report.coverage)) {
        const t = (total[k] ??= { ok: 0, error: 0, unsupported: 0 });
        t.ok += x.ok;
        t.error += x.error;
        t.unsupported += x.unsupported;
      }
      outcomes.push(...ddl);
      expect(report.problems.slice(0, 5).join("\n\n")).toBe("");
      expect(quiescent).toEqual([]);
      expect(report.committed).toBeGreaterThan(40);
    }, 120_000);
  }

  it("builds the index in some runs and fails on duplicate values in others, and statements hit the new constraint", () => {
    expect(outcomes.filter((x) => x.endsWith(": ok")).length).toBeGreaterThan(2);
    expect(outcomes.filter((x) => /UNIQUE constraint failed/.test(x)).length).toBeGreaterThan(2);
    // 表への書き込みを止めている間に、ほかの失敗は起きない。
    expect(outcomes.filter((x) => !x.endsWith(": ok") && !/UNIQUE constraint failed/.test(x))).toEqual([]);
    expect(TOK_NAMES.filter((k) => (total[k]?.ok ?? 0) < 5)).toEqual([]);
    expect(TOK_NAMES.filter((k) => (total[k]?.unsupported ?? 0) > 0)).toEqual([]);
    // index が出来た後の文が、UNIQUE 違反で失敗している (取引の中の文。SQLite でも同じ位置で失敗する)。
    const failed = ["W insert tok", "W update the column being indexed"].reduce((n, k) => n + (total[k]?.error ?? 0), 0);
    expect(failed).toBeGreaterThan(0);
  });

});

// 守りを外した実行が食い違いを起こす seed を探すための入口。MUTATE=lock|repin|clock を付けて scripts/sweep.mjs で流すと、
// 落ちた seed が、その守りの欠落を見つける seed である。見つかる seed はコードが変わるとずれるので、試験には固定しない。
// 守りごとの決定的な再現は、test/unique-index-build.test.ts と test/txn-across-schema-change.test.ts にある。
// 2026-11-11 の測定 (seed 1 から 300): 書き込み禁止を外すと 123 本、版の取り替えを許すと 1 本、公開の時刻を運ばないと 5 本が食い違った。
describe.skipIf(!process.env.MUTATE)("search: seeds on which a removed guard is caught", () => {
  const o: RunOptions = process.env.MUTATE === "lock" ? { faults: { ignoreTableLock: true } }
    : process.env.MUTATE === "repin" ? { clientFaults: { repinOnRestore: true } }
    : { faults: { publishWithoutClock: true } };
  for (const seed of seedsOr([1])) {
    it(`mutation seed ${seed}`, async () => {
      const r = await run(seed, { ddl: true, ...o });
      expect([...r.report.problems.slice(0, 2), ...r.quiescent].join("\n\n")).toBe("");
    }, 120_000);
  }
});
