// Meta の epoch の列 (src/catalog.ts) と、その上に載せた Meta (src/meta.ts) の試験。docs/design-catalog-epoch.md の段 1。
//
// 段 1 は挙動を変えない段である。検査 (b): 乱択の DDL と分割の並びを、段 1 より前の Meta (test/meta-old.ts) と段 1 の Meta に
// 同じ順で流し、どの入口の答えも (誤りの文まで) 同じであることを確かめる。並びは、期限 (leaseMs と buildMaxMs) をまたぐ時計、
// index の作成と公開と取り消し、DROP の前の書き込み禁止、古い basedOn、失敗する DDL と何もしない DDL、範囲表の切り替えと
// 分割の枠、Meta の作り直し (同じ保存データから開き直す)、欠陥のスイッチを含む。
// シミュレータ全体でも同じ比べ方ができる (META_SHADOW、test/sim.ts の shadowMeta)。
import { describe, expect, it } from "vitest";
import { split, splitsToResume } from "../src/autoscaler";
import { fold, refusal, type Logged } from "../src/catalog";
import { Db, type Cluster } from "../src/client/db";
import { MetaCore, readEpochs, type SplitMove } from "../src/meta";
import { planSplit, REGION_TOKENS, type Interval } from "../src/routing";
import type { Runtime } from "../src/runtime";
import type { Faults, ShardApi } from "../src/types";
import { MetaCore as OldMeta } from "./meta-old";
import { prng, seedsOr, SimCluster, SqliteBackend } from "./sim";

/** 答えを比べられる文字列にする。誤りは、型の名前、文、持っている値 (SchemaMoved の version など)。 */
async function outcome(f: () => unknown): Promise<string> {
  try {
    return `ok ${JSON.stringify(await f()) ?? "undefined"}`;
  } catch (e) {
    const err = e as Error;
    return `throws ${err.constructor.name}: ${err.message} ${JSON.stringify({ ...err })}`;
  }
}

/** 時計を試験が進める実行環境。uuid は呼んだ順の番号で、2 つの Meta に同じ列を返す。 */
function clock(): Runtime & { t: number } {
  let ids = 0;
  const rt = {
    t: 1_000_000,
    now: () => rt.t,
    after: () => null,
    cancel: () => undefined,
    random: () => 0,
    uuid: () => `id-${ids++}`,
  };
  return rt;
}

type Api = Pick<MetaCore, "catalog" | "applyDdl" | "revokeDdl" | "publishIndex" | "renewLock" | "lockTables" | "finishLock" | "switchRange"
  | "beginSplit" | "startSplit" | "checkSplit" | "endSplit" | "splits" | "ddlSince" | "allocate" | "batonSecret" | "setInitial">;

/** 2 つの Meta の組。同じ呼び出しを同じ順で流し、答えが違えば記録する。 */
class Pair {
  rtNew = clock();
  rtOld = clock();
  bNew = new SqliteBackend();
  bOld = new SqliteBackend();
  next!: Api;
  old!: Api;
  diffs: string[] = [];
  log: string[] = [];
  constructor(private shards: string[], private opts: { leaseMs?: number; buildMaxMs?: number; faults?: Faults }) {
    this.open();
  }
  /** 同じ保存データから開き直す (DO の再起動)。 */
  open(): void {
    this.next = new MetaCore(this.bNew, this.shards, { ...this.opts, runtime: this.rtNew });
    this.old = new OldMeta(this.bOld, this.shards, { ...this.opts, runtime: this.rtOld }) as unknown as Api;
  }
  advance(ms: number): void {
    this.rtNew.t += ms;
    this.rtOld.t += ms;
  }
  async call<K extends keyof Api>(k: K, ...args: Parameters<Api[K]>): Promise<string> {
    const what = `${String(k)} ${JSON.stringify(args)}`;
    const a = await outcome(() => (this.next[k] as (...x: unknown[]) => unknown)(...structuredClone(args)));
    const b = await outcome(() => (this.old[k] as (...x: unknown[]) => unknown)(...structuredClone(args)));
    this.log.push(`${what} -> ${a.slice(0, 160)}`);
    if (a !== b) this.diffs.push(`${what}\n  new: ${a.slice(0, 600)}\n  old: ${b.slice(0, 600)}\n  after: ${this.log.slice(-12, -1).join("\n    ")}`);
    return a;
  }
}

/** 返った Catalog (ok ... の JSON) を読む。誤りなら null。 */
const cat = (s: string): { version: number; tables: Record<string, { building?: { name: string } }>; routing: { ranges: { start: number; end: number; shard: string }[] } } | null =>
  s.startsWith("ok {") ? JSON.parse(s.slice(3)) : null;

const TABLES = ["t1", "t2", "k1"];
function ddlOf(r: () => number): string {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
  const t = pick(["t1", "t2"]);
  const i = Math.floor(r() * 3);
  // 表を作る文を多めに選ぶ。表がないと、ほかの文がどれも「no such table」で終わる。
  if (r() < 0.25) return pick([`CREATE TABLE ${t}(id INTEGER PRIMARY KEY, a TEXT, b INTEGER)`, `CREATE TABLE k1(tenant INTEGER NOT NULL, id INTEGER NOT NULL, email TEXT, PRIMARY KEY (tenant, id))`]);
  return pick([
    `CREATE TABLE ${t}(id INTEGER PRIMARY KEY, a TEXT, b INTEGER)`,
    `CREATE TABLE IF NOT EXISTS ${t}(id INTEGER PRIMARY KEY, a TEXT, b INTEGER)`,
    `CREATE TABLE k1(tenant INTEGER NOT NULL, id INTEGER NOT NULL, email TEXT, PRIMARY KEY (tenant, id))`,
    `CREATE INDEX ix${i} ON ${t}(a)`,
    `CREATE INDEX IF NOT EXISTS ix${i} ON ${t}(b)`,
    `CREATE UNIQUE INDEX ux${i} ON ${t}(a)`,
    `CREATE UNIQUE INDEX uk${i} ON k1(tenant, email)`,
    `ALTER TABLE ${t} ADD COLUMN c${i} TEXT`,
    `ALTER TABLE ${t} ADD COLUMN d${i} INTEGER NOT NULL DEFAULT 0 CHECK (d${i} >= 0)`,
    `ALTER TABLE ${t} ADD COLUMN e${i} INTEGER NOT NULL`,
    `DROP TABLE ${t}`,
    `DROP TABLE IF EXISTS ${t}`,
    `DROP INDEX ix${i}`,
    `CREATE VIEW v${i} AS SELECT id FROM ${t}`,
    `DROP VIEW v${i}`,
    `CREATE TABLE ${t}(`,
    `DROP TABLE nosuch`,
  ]);
}

/** 乱択の並びを 1 つ流す。 */
async function run(seed: number, steps: number): Promise<Pair> {
  const r = prng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
  const faults: Faults = { startWithoutSlot: r() < 0.2, fenceWithoutSlot: r() < 0.2, dropAfterExpiry: r() < 0.2 };
  const short = r() < 0.5;
  const p = new Pair(["s0", "s1"], { leaseMs: short ? 1_000 : undefined, buildMaxMs: short ? 4_000 : undefined, faults });
  const lease = short ? 1_000 : 5_000;
  const maxMs = short ? 4_000 : 300_000;
  let version = 0;
  let routing: { start: number; end: number; shard: string }[] = [];
  let child = 2;
  const ids: string[] = ["split:s0:s9:0:65536"];
  const moves: SplitMove[] = [];
  const builds: { table: string; name: string; version: number }[] = [];
  const locks: { table: string; version: number }[] = [];
  const note = (s: string) => {
    const c = cat(s);
    if (!c) return;
    version = c.version;
    routing = c.routing.ranges;
    for (const [table, def] of Object.entries(c.tables)) {
      if (def.building) builds.push({ table, name: def.building.name, version: c.version });
    }
  };
  const interval = (): Interval & { parent: string } => {
    const shards = [...new Set(routing.map((x) => x.shard))];
    const parent = pick(shards.length ? shards : ["s0"]);
    const planned = routing.length ? planSplit({ version: 0, ranges: routing }, parent) : null;
    if (planned && r() < 0.8) return { parent, ...planned };
    const start = Math.floor(r() * 64) * 65_536;
    return { parent, start, end: start + 65_536 * (1 + Math.floor(r() * 4)) };
  };
  if (r() < 0.3) await p.call("setInitial", ["s0", "s1", "s2"]);
  for (let step = 0; step < steps; step++) {
    const x = r();
    if (x < 0.22) {
      const basedOn = pick([undefined, version, version, version - 1, version + 1]);
      const before = builds.length;
      note(await p.call("applyDdl", ddlOf(r), basedOn));
      // index を作り始めたら、半分は進める側と同じく、すぐに公開する (残りは、期限切れや取り消しに任せる)。
      const b = builds.length > before ? builds.at(-1)! : null;
      if (b && r() < 0.5) note(await p.call("publishIndex", b.table, b.name, b.version, 5_000 + step));
    } else if (x < 0.27) {
      await p.call("revokeDdl", pick([version, version, version - 1, version + 3]), `failed at step ${step}`);
    } else if (x < 0.33) {
      const b = builds.length && r() < 0.8 ? pick(builds) : { table: pick(TABLES), name: "ux0", version };
      note(await p.call("publishIndex", b.table, b.name, pick([b.version, b.version, b.version + 1]), 5_000 + step));
    } else if (x < 0.37) {
      const v = pick([...builds.map((b) => b.version), ...locks.map((l) => l.version), version]);
      await p.call("renewLock", v);
    } else if (x < 0.42) {
      const t = pick(TABLES);
      const s = await p.call("lockTables", [t], pick([undefined, version, version - 1]));
      note(s);
      if (cat(s)) locks.push({ table: t, version: cat(s)!.version });
    } else if (x < 0.47) {
      const l = locks.length && r() < 0.8 ? pick(locks) : { table: pick(TABLES), version };
      note(await p.call("finishLock", pick([l.version, l.version, l.version + 1]), pick([`DROP TABLE ${l.table}`, `DROP TABLE ${l.table}`, `DROP TABLE nosuch`, `DROP TABLE IF EXISTS ${l.table}`])));
    } else if (x < 0.55) {
      const m = interval();
      const to = r() < 0.2 && routing.length ? pick(routing).shard : `s${child++}`;
      const from = pick([m.parent, m.parent, undefined, "s7"]);
      await p.call("switchRange", { start: m.start, end: m.end, to, ...(from === undefined ? {} : { from }) });
      moves.push({ parent: m.parent, child: to, start: m.start, end: m.end });
      ids.push(`split:${m.parent}:${to}:${m.start}:${m.end}`);
    } else if (x < 0.61) {
      const m = moves.length && r() < 0.5 ? pick(moves) : (() => {
        const i = interval();
        return { parent: i.parent, child: `s${child++}`, start: i.start, end: i.end };
      })();
      const s = await p.call("beginSplit", m, pick([version, version, version - 1]));
      if (s.startsWith("ok {")) {
        ids.push(JSON.parse(s.slice(3)).id);
        moves.push(m);
      }
    } else if (x < 0.65) {
      const m = moves.length ? pick(moves) : { parent: "s0", child: "s9", start: 0, end: 65_536 };
      await p.call("startSplit", pick(ids), r() < 0.8 ? m : { ...m, end: m.end + 1 });
    } else if (x < 0.68) {
      const m = moves.length ? pick(moves) : { parent: "s0", child: "s9", start: 0, end: 65_536 };
      await p.call("checkSplit", pick(ids), m);
    } else if (x < 0.74) {
      await p.call("endSplit", pick(ids));
    } else if (x < 0.77) {
      await p.call("splits");
    } else if (x < 0.82) {
      note(await p.call("catalog"));
    } else if (x < 0.85) {
      await p.call("ddlSince", pick([0, version, version - 2, version + 1]));
    } else if (x < 0.87) {
      await p.call("allocate", pick(TABLES), 1 + Math.floor(r() * 3), pick([0, 0, 100]));
    } else if (x < 0.88) {
      await p.call("batonSecret");
    } else if (x < 0.94) {
      // 時計を進める。期限 (leaseMs) と上限 (buildMaxMs) をまたぐ量を混ぜる。
      p.advance(pick([10, 500, lease + 1, lease + 1, maxMs + 1]));
    } else if (x < 0.97) {
      p.open();
    } else {
      // 期限を延ばし続ける進め方。延ばしながら時計を進め、上限を越える。
      const v = builds.at(-1)?.version ?? locks.at(-1)?.version ?? version;
      for (let i = 0; i < 6; i++) {
        p.advance(Math.floor(lease * 0.8));
        await p.call("renewLock", v);
      }
    }
  }
  note(await p.call("catalog"));
  await p.call("ddlSince", 0);
  await p.call("splits");
  return p;
}

describe("Meta on the epoch log answers exactly as the Meta before it (stage 1, check (b))", () => {
  for (const seed of seedsOr(Array.from({ length: 60 }, (_, i) => i + 1))) {
    it(`seed ${seed}`, async () => {
      const p = await run(seed, 120);
      expect(p.diffs.slice(0, 3)).toEqual([]);
      // 列の最後まで畳んだものは、Meta の答えと同じである。
      const log = readEpochs(p.bNew);
      const snap = fold(log);
      const answer = JSON.parse((await outcome(() => p.next.catalog())).slice(3));
      expect({ version: snap.version, tables: snap.tables, ddl: snap.ddl, routing: snap.routing }).toEqual(
        { version: answer.version, tables: answer.tables, ddl: answer.ddl, routing: answer.routing });
    });
  }

  it("exercises every entry point with both outcomes, and every kind of record", async () => {
    const seen = new Map<string, Set<string>>();
    const records = new Map<string, number>();
    const count = (k: string) => records.set(k, (records.get(k) ?? 0) + 1);
    for (let seed = 1; seed <= 60; seed++) {
      const p = await run(seed, 120);
      for (const line of p.log) {
        const [k] = line.split(" ", 1);
        // revokeDdl は、取り消せないときに投げずに null を返す。
        const kind = line.includes("-> ok null") ? "null" : line.includes("-> ok") ? "ok" : "throws";
        if (!seen.has(k!)) seen.set(k!, new Set());
        seen.get(k!)!.add(kind);
      }
      for (const { rec } of readEpochs(p.bNew)) {
        if (rec.kind !== "commit" || !("ddl" in rec)) count(rec.kind);
        else if (rec.ddl.build) count("commit: index build");
        else if (rec.ddl.at !== undefined) count("commit: index published");
        else if (rec.ddl.guard) count("commit: lock before DROP");
        else if (rec.ddl.reverts !== undefined) count("commit: revocation");
        else count("commit");
      }
    }
    const both = ["applyDdl", "publishIndex", "renewLock", "lockTables", "finishLock", "switchRange", "beginSplit", "startSplit", "checkSplit"];
    for (const k of both) expect([...(seen.get(k) ?? [])].sort(), k).toEqual(["ok", "throws"]);
    expect([...(seen.get("revokeDdl") ?? [])].sort(), "revokeDdl").toEqual(["null", "ok"]);
    console.log(JSON.stringify(Object.fromEntries(records)));
    for (const k of ["genesis", "commit", "commit: index build", "commit: index published", "commit: lock before DROP", "commit: revocation", "move-start", "move-end"]) {
      expect(records.get(k) ?? 0, k).toBeGreaterThan(0);
    }
  }, 120_000);
});

describe("the epoch log", () => {
  it("stores one record per epoch: the first range table at 0, then DDL versions, switches and returned split slots", async () => {
    const b = new SqliteBackend();
    const meta = new MetaCore(b, ["s0", "s1"]);
    await meta.applyDdl("CREATE TABLE t(id INTEGER PRIMARY KEY, a TEXT)");
    const range = planSplit((await meta.catalog()).routing, "s0")!;
    const slot = await meta.beginSplit({ parent: "s0", child: "s2", ...range }, 1);
    await meta.startSplit(slot.id, { parent: "s0", child: "s2", ...range });
    await meta.switchRange({ ...range, to: "s2", from: "s0" });
    // 同じ切り替えをもう一度呼んでも、記録は増えない。
    await meta.switchRange({ ...range, to: "s2", from: "s0" });
    await meta.applyDdl("CREATE INDEX ta ON t(a)").catch((e: Error) => e.message);
    await meta.endSplit(slot.id);
    await meta.endSplit(slot.id);
    await meta.applyDdl("CREATE INDEX ta ON t(a)");
    expect(readEpochs(b).map((x) => [x.epoch, x.rec.kind, x.rec.kind === "commit" && "ddl" in x.rec ? x.rec.ddl.version : null])).toEqual([
      [0, "genesis", null], [1, "commit", 1], [2, "move-start", null], [3, "move-end", null], [4, "commit", 2],
    ]);
    // 移動の途中の epoch の範囲表は、子を指し、移動が開いている。
    const during = fold(readEpochs(b), 2);
    expect(during.routing.version).toBe(2);
    expect(during.moves).toEqual([{ epoch: 2, from: "s0", to: "s2", ...range }]);
    expect(fold(readEpochs(b), 3).moves).toEqual([]);
    // 表定義の epoch は、表定義の記録でだけ進む。
    expect([1, 2, 3, 4].map((e) => fold(readEpochs(b), e).schema)).toEqual([1, 1, 1, 4]);
  });

  it("opens the table's transition at an index build or a lock, and closes it at the next version", async () => {
    const b = new SqliteBackend();
    const meta = new MetaCore(b, ["s0", "s1"]);
    await meta.applyDdl("CREATE TABLE t(id INTEGER PRIMARY KEY, a TEXT)");
    await meta.applyDdl("CREATE UNIQUE INDEX ta ON t(a)");
    expect(fold(readEpochs(b)).open).toMatchObject({ epoch: 2, mode: "build", fence: ["t"] });
    await meta.publishIndex("t", "ta", 2, 1);
    expect(fold(readEpochs(b)).open).toBeNull();
    await meta.lockTables(["t"]);
    expect(fold(readEpochs(b)).open).toMatchObject({ epoch: 4, mode: "guard", fence: ["t"] });
    expect(await meta.revokeDdl(4, "changed")).toBe(5);
    const s = fold(readEpochs(b));
    expect({ open: s.open, revoked: s.revoked }).toEqual({ open: null, revoked: { version: 4, reason: "changed" } });
  });

  it("refuses to fold a broken log", () => {
    const genesis: Logged = { epoch: 0, rec: { kind: "genesis", routing: { version: 1, ranges: [{ start: 0, end: REGION_TOKENS, shard: "s0" }] } } };
    expect(() => fold([genesis, { epoch: 2, rec: { kind: "move-end", of: 1 } }])).toThrow(/broken/);
    expect(() => fold([genesis, { epoch: 1, rec: { kind: "commit", of: 1 } }])).toThrow(/broken/);
    expect(() => fold([genesis, { epoch: 1, rec: { kind: "move-end", of: 1 } }])).toThrow(/broken/);
    expect(() => fold([{ epoch: 1, rec: genesis.rec }])).toThrow(/broken/);
  });

  it("refuses a move that overlaps an open move or names its shards, and a child that already owns a range", () => {
    // M21 は移動を 1 つしか持たないので、移動どうしの条件は、ここで確かめる (設計書の「同時に開ける遷移」)。
    const q = REGION_TOKENS / 4;
    const log: Logged[] = [
      { epoch: 0, rec: { kind: "genesis", routing: { version: 1, ranges: [{ start: 0, end: 2 * q, shard: "a" }, { start: 2 * q, end: 4 * q, shard: "b" }] } } },
      { epoch: 1, rec: { kind: "move-start", from: "a", to: "c", start: q, end: 2 * q } },
    ];
    const s = fold(log);
    expect(refusal(s, { kind: "move-start", from: "a", to: "d", start: 0, end: q / 2 })).toMatchObject({ rule: "moves-overlap" });
    expect(refusal(s, { kind: "move-start", from: "b", to: "c", start: 3 * q, end: 4 * q })).toMatchObject({ rule: "moves-overlap" });
    expect(refusal(s, { kind: "move-start", from: "b", to: "a", start: 3 * q, end: 4 * q })).toMatchObject({ rule: "moves-overlap" });
    expect(refusal(s, { kind: "move-start", from: "b", to: "d", start: 3 * q, end: 4 * q })).toBeNull();
    const ended = fold([...log, { epoch: 2, rec: { kind: "move-end", of: 1 } }]);
    expect(refusal(ended, { kind: "move-start", from: "b", to: "c", start: 3 * q, end: 4 * q })).toMatchObject({ rule: "child-owns" });
    expect(refusal(ended, { kind: "move-start", from: "a", to: "d", start: q / 2, end: 2 * q })).toMatchObject({ rule: "owner", owners: ["a", "c"] });
  });

  it("does not check a stage 1 version with the stage 3 conditions", () => {
    const s = fold([]);
    expect(refusal(s, { kind: "genesis", routing: { version: 1, ranges: [] } })).toBeNull();
    expect(() => refusal(s, { kind: "commit", ddl: { version: 1, sql: [], defs: [], drops: [], user: null } })).toThrow(/stage 1/);
  });

  // 段 1 で利用者に見える、ただ 1 つの変化。Meta は利用者の DDL を自分の SQLite でも実行するので、__epoch を名指す DDL を
  // 通すと、Meta の列そのものを作り変えるか消す (段 1 より前は、この名前の表を作れた)。
  it("refuses user DDL that names __epoch, and leaves the log as it was", async () => {
    const b = new SqliteBackend();
    const meta = new MetaCore(b, ["s0", "s1"]);
    await meta.applyDdl("CREATE TABLE t(id INTEGER PRIMARY KEY)");
    const before = JSON.stringify(readEpochs(b));
    for (const sql of [
      "CREATE TABLE __epoch(x)", "CREATE TABLE IF NOT EXISTS __epoch(epoch INTEGER PRIMARY KEY, rec TEXT NOT NULL)", `CREATE TABLE "__EPOCH"(x)`,
      "DROP TABLE __epoch", "ALTER TABLE __epoch ADD COLUMN y", "CREATE INDEX e ON __epoch(rec)", "ALTER TABLE t RENAME TO __epoch",
    ]) {
      expect(await outcome(() => meta.applyDdl(sql)), sql).toMatch(/^throws SqlError: .*(reserved for internal use|no such table)/);
    }
    expect(JSON.stringify(readEpochs(b))).toBe(before);
    expect(b.exec(`SELECT count(*) AS n FROM pragma_table_info('__epoch')`)).toEqual([{ n: 2 }]);
    expect((await meta.applyDdl("CREATE TABLE u(id INTEGER PRIMARY KEY)")).version).toBe(2);
  });

  it("refuses to open data of the previous storage format, instead of reading an empty log", () => {
    const b = new SqliteBackend();
    b.exec(`CREATE TABLE __meta(k TEXT PRIMARY KEY, v)`);
    b.exec(`INSERT INTO __meta VALUES ('format', 2)`);
    expect(() => new MetaCore(b)).toThrow("storage format 2 of this schema object has no migration to format 3");
  });
});

// 分割を進める側は、どの段の前でも止まり得る (test/split-slot.test.ts)。止まった分割を再開して終えたとき、列には、その移動の
// move-start と move-end が 1 つずつあり、開いている移動は残らない。段 1 より前の Meta には move-end に当たるものがないので、
// 検査 (b) の比べ合いでは確かめられない。
describe("the moves a split records", () => {
  const STEPS = ["beginIncoming", "fence", "switchRange", "drain", "finishMove", "finishIncoming", "endSplit"] as const;
  /** 段 step の前で止まる、分割を進める側。 */
  function stopsBefore(c: SimCluster, step: string): Cluster {
    const stopped = () => Promise.reject(new Error(`driver stopped before ${step}`));
    return new Proxy(c as unknown as Cluster, {
      get(target, prop, receiver) {
        if (prop === step) return stopped;
        if (prop === "shard") {
          return (id: string) => new Proxy({} as ShardApi, {
            get: (_t, method: keyof ShardApi) => (method === step ? stopped : (req: never) => (c.shard(id)[method] as (r: never) => Promise<unknown>)(req)),
          });
        }
        const v = Reflect.get(target, prop, receiver);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
  }

  for (const step of STEPS) {
    it(`a split stopped before ${step} and resumed records one move-start and one move-end`, async () => {
      const c = new SimCluster({ shards: 1 });
      await new Db(c).ddl("CREATE TABLE items(id INTEGER PRIMARY KEY, n INTEGER NOT NULL)");
      await new Db(c).query(`INSERT INTO items(id, n) VALUES ${Array.from({ length: 40 }, (_, i) => `(${i + 1}, ${i + 1})`).join(", ")}`);
      const range = planSplit((await c.catalog()).routing, "s0")!;
      expect(await outcome(() => split(stopsBefore(c, step), "s0", "s1", { range }))).toMatch(/driver stopped/);
      const jobs = splitsToResume(await c.splits(), () => false);
      // 子が受け取り始める前に止まった分割は、枠が期限で消えるので、最初からやり直す。
      if (jobs.length === 0) await c.sleep(6_000);
      for (const j of jobs.length ? jobs : [{ parent: "s0", child: "s1", range }]) expect(await outcome(() => split(c, j.parent, j.child, { range: j.range }))).toMatch(/^ok/);
      const log = readEpochs(c.metaBackend);
      const moves = log.filter((x) => x.rec.kind === "move-start" || x.rec.kind === "move-end").map((x) => x.rec);
      expect(moves).toEqual([{ kind: "move-start", from: "s0", to: "s1", ...range }, { kind: "move-end", of: log.find((x) => x.rec.kind === "move-start")!.epoch }]);
      expect(fold(log).moves).toEqual([]);
      expect(await c.splits()).toEqual([]);
    });
  }
});
