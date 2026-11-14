// DDL と取引を並行に流す乱択の実行と、その後の不変条件の検査。ddl-concurrent.test.ts が使う。
// スケジュールは実時間のタイマーに依存するので、seed は作業負荷と遅延の列を固定するだけである。
// 同じ seed でも割り込みの順序は完全には再現しない。失敗した seed は台本の再現テストへ落とす。
import { writeFileSync } from "node:fs";
import { SimCluster, logRows, type Rpc } from "./sim";
import { checkHistory, type Read, type TxRecord, type Violation } from "./history";
import { Db, type Txn } from "../src/client/db";
import { split } from "../src/autoscaler";
import { ownerOf, planSplit, shardsOf } from "../src/routing";
import { decode, encode } from "../src/shard/rows";
import type { Change, Faults, Row } from "../src/types";

export function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

export const ACCT = `CREATE TABLE acct(
  tenant_id INTEGER NOT NULL, id INTEGER NOT NULL, v INTEGER, n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, id)) SHARD KEY (tenant_id)`;
export const SIDE = `CREATE TABLE side(
  tenant_id INTEGER NOT NULL, id INTEGER NOT NULL, n INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, id)) SHARD KEY (tenant_id)`;
export const INDEX = "acct_v";

export const TENANTS = 6;
export const IDS = 3;

export async function tenantOn(c: SimCluster, shard: string, skip = 0): Promise<number> {
  const { routing } = await c.catalog();
  for (let t = 1; ; t++) {
    if (ownerOf(routing, JSON.stringify([t])) === shard && skip-- === 0) return t;
  }
}

/** 条件に合う最初の RPC を、要求の配送前 (gate) か応答の配送前 (reply) で止める。 */
export function hold(c: SimCluster, where: "gate" | "reply", pred: (m: Rpc) => boolean) {
  let release!: () => void;
  let hit!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const reached = new Promise<void>((r) => (hit = r));
  let once = false;
  c.net[where] = (m) => {
    if (once || !pred(m)) return undefined;
    once = true;
    hit();
    return held;
  };
  return { reached, release };
}

/** RPC で届く finalize をすべて止める。anchor 自身の適用は RPC を通らないので先に進む。 */
export function holdFinalize(c: SimCluster) {
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  c.net.gate = (m) => (m.method === "finalize" ? held : undefined);
  return () => {
    c.net.gate = () => {};
    release();
  };
}

// ---- 実行後の検査 ----

/** 範囲表に載っている全シャードの表の行を、SQLite から直接読む。 */
export async function rawRows(c: SimCluster, table: string): Promise<{ shard: string; row: Row }[]> {
  const { routing } = await c.catalog();
  return shardsOf(routing).flatMap((shard) => {
    const b = c.backends.get(shard);
    if (!b || b.exec(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`, table).length === 0) return [];
    return b.exec(`SELECT * FROM "${table}"`).map((row) => ({ shard, row }));
  });
}

export interface IndexReport {
  /** catalog 上の状態。出来上がっていれば public、作っている最中なら building、index がなければ null。 */
  state: string | null;
  /** UNIQUE の index である。 */
  unique: boolean;
  /** 表に行があるのに index に項目がない。index で引くと行が見えない。 */
  missing: string[];
  /** index に項目があるのに、表にその値の行がない。 */
  dangling: string[];
  /** index を使う問い合わせの結果が、全シャードの表を直接読んだ結果と違う値。 */
  wrongRead: string[];
  /** catalog に index がないのに __gidx の表が残っているシャード。 */
  leftover: string[];
}

/** グローバル index と表が一致するかを調べる。表と index は全シャードの SQLite から直接読む。 */
export async function indexAgreement(c: SimCluster, table = "acct", name = INDEX): Promise<IndexReport> {
  const cat = await c.catalog();
  const ix = cat.tables[table]?.globalIndexes.find((g) => g.name === name);
  const gidx = `__gidx_${name}`;
  const building = cat.tables[table]?.building?.name === name;
  const out: IndexReport = { state: ix ? "public" : building ? "building" : null, unique: ix !== undefined, missing: [], dangling: [], wrongRead: [], leftover: [] };
  // 作っている最中の index の表は、まだ埋まっていなくてよい。
  if (building) return out;
  if (!ix) {
    for (const shard of shardsOf(cat.routing)) {
      const b = c.backends.get(shard)!;
      if (b.exec(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`, gidx).length > 0) out.leftover.push(shard);
    }
    return out;
  }
  const def = cat.tables[table]!;
  const base = await rawRows(c, table);
  const expected = new Set<string>();
  for (const { row } of base) {
    const vals = ix.columns.map((col) => row[col] ?? null);
    if (vals.some((x) => x === null)) continue;
    expected.add(`${encode(vals)} -> ${encode(def.pk.map((k) => row[k] ?? null))}`);
  }
  const actual = new Set((await rawRows(c, gidx)).map(({ row }) => `${row.k} -> ${row.pk}`));
  out.missing = [...expected].filter((e) => !actual.has(e)).sort();
  out.dangling = [...actual].filter((e) => !expected.has(e)).sort();
  if (ix.columns.length === 1) {
    const col = ix.columns[0]!;
    const db = new Db(c);
    const values = [...new Set(base.map(({ row }) => row[col] ?? null))].filter((x) => x !== null);
    for (const value of values) {
      const want = base.filter(({ row }) => row[col] === value).map(({ row }) => encode(def.pk.map((k) => row[k] ?? null))).sort();
      const got = (await db.query(`SELECT ${def.pk.map((k) => `"${k}"`).join(", ")} FROM "${table}" WHERE "${col}" = ?`, [value]))
        .values.map((r) => encode(r)).sort();
      if (encode(want) !== encode(got)) out.wrongRead.push(`${col}=${encode(value)}: index read ${encode(got)}, table has ${encode(want)}`);
    }
  }
  return out;
}

/** 表のすべてのグローバル index について indexAgreement を取り、1 つにまとめる。index がなければ既定の名前の残骸を調べる。 */
export async function indexAgreementAll(c: SimCluster, table = "acct"): Promise<IndexReport> {
  const names = ((await c.catalog()).tables[table]?.globalIndexes ?? []).map((g) => g.name);
  if (names.length === 0) return indexAgreement(c, table);
  const out: IndexReport = { state: "public", unique: false, missing: [], dangling: [], wrongRead: [], leftover: [] };
  for (const name of names) {
    const r = await indexAgreement(c, table, name);
    if (r.state !== "public") out.state = r.state;
    out.unique ||= r.unique;
    for (const f of ["missing", "dangling", "wrongRead", "leftover"] as const) out[f].push(...r[f].map((x) => `${name}: ${x}`));
  }
  return out;
}

/** 表の中で col の値が重複している組。 */
export async function duplicates(c: SimCluster, table = "acct", col = "v"): Promise<string[]> {
  const seen = new Map<string, string[]>();
  for (const { row } of await rawRows(c, table)) {
    if ((row[col] ?? null) === null) continue;
    const k = encode(row[col]);
    seen.set(k, [...(seen.get(k) ?? []), `${row.tenant_id}/${row.id}`]);
  }
  return [...seen].filter(([, keys]) => keys.length > 1).map(([k, keys]) => `${col}=${k}: ${keys.join(",")}`).sort();
}

/**
 * 各シャードが適用した表定義の版。最新の版を持つ読み取りを全シャードへ送った後で呼ぶ。
 * 期限切れで取り消された index の版などは、シャードへ押し出されないので、送る前は遅れていてよい。
 */
export async function schemaVersions(c: SimCluster): Promise<{ meta: number; shards: Record<string, number> }> {
  const cat = await c.catalog();
  const shards: Record<string, number> = {};
  for (const id of shardsOf(cat.routing)) {
    shards[id] = (c.backends.get(id)!.exec(`SELECT max(version) v FROM __ddl`)[0]?.v as number | null) ?? 0;
  }
  return { meta: cat.version, shards };
}

/** 全シャードへ最新の版の要求を送る。 */
export async function touchAll(c: SimCluster): Promise<void> {
  const cat = await c.catalog();
  await Promise.all(shardsOf(cat.routing).map((id) => c.shard(id).syncSchema({ version: cat.version })));
}

/**
 * 後始末 (phase 2 の再駆動) を済ませた後に残る、確定済みの取引の intent と、redrive の失敗。
 * 確定した取引の intent が適用できないまま残ると、その書き込みは永久に見えない。
 */
export async function stuckWork(c: SimCluster): Promise<string[]> {
  await c.settle();
  const out: string[] = [];
  for (let round = 0; round < 3; round++) {
    for (const core of c.cores.values()) await core.redrive().catch(() => {});
    await c.settle();
  }
  for (const [id, core] of c.cores) {
    for (const e of core.lastRedriveErrors) out.push(`${id}: redrive failed: ${e}`);
    for (const r of c.backends.get(id)!.exec(`SELECT DISTINCT tbl, txn, anchor FROM __intents`)) {
      const st = c.backends.get(r.anchor as string)?.exec(`SELECT status FROM __txn WHERE txn = ?`, r.txn as string)[0]?.status;
      if (st === "committed") out.push(`${id}: intent on ${r.tbl} of committed txn ${r.txn} not applied`);
    }
  }
  return [...new Set(out)].sort();
}

/** 範囲表の持ち主でないシャードに載っている行。 */
export async function misplacedRows(c: SimCluster, table = "acct"): Promise<string[]> {
  const { routing } = await c.catalog();
  return (await rawRows(c, table))
    .filter(({ shard, row }) => ownerOf(routing, encode([row.tenant_id])) !== shard)
    .map(({ shard, row }) => `${row.tenant_id}/${row.id} on ${shard}`);
}

/**
 * ADD COLUMN extra DEFAULT 5 の後の行。extra は既定値か、その行に extra を書いたどれかの書き込みの値 (その書き込みの n) で
 * なければならない。extra を書かない UPDATE (表定義の変更の前に計画した書き込み) は extra を前の値のまま残すので、extra が
 * 最後の n と同じとは限らない。2026-11-13 までの確かめは extra と n が同じことを求め、extra を書いた書き込みの後に extra を
 * 書かない UPDATE が届く順序で、正しい行を違反と数えた (検査の誤り。一晩分の試験の seed 900541、901960)。
 */
export async function extraViolations(c: SimCluster, written?: Map<string, Set<number>>): Promise<string[]> {
  const cat = await c.catalog();
  if (!cat.tables.acct?.columns.includes("extra")) return [];
  return (await rawRows(c, "acct"))
    .filter(({ row }) => row.extra !== 5 && row.extra !== row.n && !written?.get(`${row.tenant_id}/${row.id}`)?.has(row.extra as number))
    .map(({ row }) => `${row.tenant_id}/${row.id} extra=${row.extra} n=${row.n}`);
}

/** v の値で引いた読み取り。keys は見えた行のキーである。 */
export interface VRead { v: number; keys: string[] }
export interface Rec extends TxRecord {
  vreads: VRead[];
  /** writes と同じ順の、書いた行の v。削除は null。 */
  wv: (number | null)[];
}

/**
 * history.ts の検査と同じ順序 (commit 時刻順、同時刻は書き込みが先) で履歴を再生し、
 * `WHERE v = ?` の読み取りが、その時刻に v を持つ行をちょうど返したかを調べる。
 * index が public なら index を使う読みで、そうでなければ全シャードの走査である。どちらでも結果は同じでなければならない。
 */
export function checkIndexReads(
  history: Rec[], initial: Map<string, { n: number; v: number | null }>,
): { missing: string[]; extra: string[] } {
  const order = [...history].sort((a, b) => a.ts - b.ts || Number(a.readOnly) - Number(b.readOnly));
  const state = new Map([...initial].map(([key, x]) => [key, x.v] as const));
  // missing は返すべき行が欠けた読み、extra は余計な行だけが混ざった読みである。原因が違うので分けて報告する。
  const out = { missing: [] as string[], extra: [] as string[] };
  for (const t of order) {
    for (const r of t.vreads) {
      const want = [...state].filter(([, v]) => v === r.v).map(([key]) => key).sort();
      const got = [...r.keys].sort();
      if (encode(want) === encode(got)) continue;
      const text = `${t.name} at ${t.ts}: WHERE v = ${r.v} returned ${encode(got)}, expected ${encode(want)}`;
      out[want.some((key) => !got.includes(key)) ? "missing" : "extra"].push(text);
    }
    t.writes.forEach((w, i) => {
      if (w.value === null) state.delete(w.key);
      else state.set(w.key, t.wv[i] ?? null);
    });
  }
  return out;
}

// ---- 乱択の作業負荷 ----

export interface Env {
  c: SimCluster;
  rnd: () => number;
  admin: Db;
  /** 終わった操作の割合が frac に達するまで待つ。 */
  at(frac: number): Promise<void>;
  /** DDL を 1 文実行する。失敗は記録して返す。 */
  ddl(sql: string): Promise<string>;
  /**
   * 作業負荷を一時停止し、実行中の操作と後始末が終わってから index と表を比べる。
   * 最後の状態だけを見ると、その後の書き込みが index を直してしまい、途中の欠落が見えない。
   */
  checkpoint(label: string): Promise<void>;
  /** 出来事の通し番号。確認応答と DDL の前後関係に使う。 */
  tick(): number;
  marks: Record<string, number>;
  /** ADD COLUMN の完了後に true にする。以後の INSERT は新しい列も書く。 */
  useExtra: boolean;
  /** side 表を使ってよい。DROP の完了で false、作り直しの完了で true にする。 */
  useSide: boolean;
  ddlLog: string[];
}

export interface Scenario {
  shards?: number;
  clients?: number;
  ops?: number;
  /** tenant の数。既定は TENANTS。多いほど取引どうしの競合が減る。 */
  tenants?: number;
  /**
   * v の選び方。small は少数の値から選ぶ (重複だらけ)。dup はほぼ一意で、ときどき全体で共有する値を選ぶ。
   * dupTenant はほぼ一意で、ときどき tenant ごとの値を選ぶ。重複は同じ tenant (同じシャード) の中にだけできる。
   */
  values?: "small" | "dup" | "dupTenant";
  /** 取引が side 表にも 1 行入れる。 */
  side?: boolean;
  /** 作業負荷の前に実行する DDL。 */
  before?: string[];
  /** 作業負荷と並行に走らせる DDL の台本。 */
  ddl(env: Env): Promise<void>;
  /** 実行中にシャードを増やす。 */
  splits?: boolean;
  /** 応答の配送にも遅延を入れる。 */
  replyJitter?: boolean;
  /** replyJitter に加えて、prepare の応答をしばしば数十 ms 遅らせる。2PC の途中で DDL が最後まで進む割り込みを作る。 */
  slowPrepare?: boolean;
  /** phase 2 (finalize) の配送を遅らせる。 */
  slowPhase2?: boolean;
  /** ロックを長く持つ取引を混ぜる。autocommit の書き込みがロック待ちの間に DDL をまたぐ。 */
  slowLocks?: boolean;
  faults?: Faults;
  /** 欠陥の注入。検査が失敗し得ることを確かめるためだけに使う。 */
  inject?(c: SimCluster): void;
}

export interface Report {
  history: Violation[];
  /** 実行中の `WHERE v = ?` の読み取りが、その時刻の表と合わない。 */
  indexReads: { missing: string[]; extra: string[] };
  /** 成功を返した書き込みが、どのシャードの変更ログにもない。 */
  ackedNotApplied: string[];
  /** 想定していない誤り。表定義の変更に伴う誤りは scenario ごとに想定を決めている。 */
  errors: string[];
  /**
   * 分割の途中だという理由で、シャードが DDL 以外の要求を断った回数の記録。やり直せる誤りなので、取引の誤りとしては数えない。
   * 分割の途中に新しい版が記録されたか、子が親より古い版で受け取り始めたときに起きる (不変条件 4、specs/m15_maintenance_slot.qnt)。
   */
  splitRefusals: string[];
  stuck: string[];
  schema: { meta: number; shards: Record<string, number> };
  index: IndexReport;
  /** DDL の直後に作業負荷を止めて調べた index の状態。 */
  checkpoints: (IndexReport & { label: string; duplicates: string[] })[];
  duplicates: string[];
  /** 表が別のシャードに載っている行。 */
  misplaced: string[];
  side: {
    exists: boolean;
    /** DROP の発行前に確定していたのに、作り直した表に現れた行。 */
    resurrected: string[];
    /** 作り直しの完了後に確定したのに、表にない行。 */
    lost: string[];
  };
  /** ADD COLUMN の後で extra が既定値でも書いた値でもない行。 */
  badExtra: string[];
  commits: number;
  splits: number;
  ddlLog: string[];
  /** 実行の指紋 (SimCluster.fingerprint)。同じ seed なら同じ値になる。 */
  fingerprint: string;
}

const EXPECTED = /^(conflict|read too old|not owner|migrating|upgrading)/;
/** 実行が終わらないと見なす上限。仮想の時刻で 10 分、出来事 60 万個。 */
const STALL_MS = 10 * 60_000;
const STALL_STEPS = 600_000;
const SCHEMA_ERR = /no such (table|column|index)|has no column/;

interface SideAck { t: number; id: number; n: number; begun: number; acked: number }

export async function runScenario(seed: number, s: Scenario): Promise<Report> {
  const rnd = prng(seed);
  const sched = prng(seed ^ 0x5bd1e995);
  // backoff と sync の乱数、txn id の乱数部分は、クラスタの実行環境が同じ seed から作る。
  const c = new SimCluster({ shards: s.shards ?? 3, faults: s.faults, seed });
  // 終わらない実行は、実時間の制限を待たずに、原因の分かる失敗にする。普通の実行は、仮想の時刻で 1 秒ほど、出来事は数万個で終わる。
  const report = await Promise.race([runSeeded(c, seed, s, rnd, sched), c.stalled(STALL_MS, STALL_STEPS)]);
  if (process.env.SIM_STATS) console.info(`seed ${seed}: ${c.runtime.now() - 1_000_000} ms simulated, ${c.net.log.length} RPCs`);
  return report;
}

async function runSeeded(c: SimCluster, seed: number, s: Scenario, rnd: () => number, sched: () => number): Promise<Report> {
  c.net.jitter = () => (sched() < 0.5 ? 0 : sched() * 3);
  // 応答の遅延。まれに長く遅らせて、2PC の途中で DDL が最後まで進む割り込みを作る。
  if (s.replyJitter || s.slowPrepare) {
    c.net.reply = (m) => {
      const x = sched();
      if (x < 0.6) return undefined;
      return c.sleep(m.method === "prepare" && x > (s.slowPrepare ? 0.75 : 0.95) ? 30 + sched() * 90 : sched() * 4);
    };
  }
  // phase 2 は応答の後に非同期で送られる。届くのが遅れても redrive が回収する前提なので、遅らせてよい。
  if (s.slowPhase2) c.net.gate = (m) => (m.method === "finalize" && sched() < 0.3 ? c.sleep(sched() * 40) : undefined);
  s.inject?.(c);
  let nextClient = 0;
  const client = () => new Db(c, { idPrefix: `s${seed}c${nextClient++}` });
  const admin = client();
  await admin.ddl(ACCT);
  if (s.side) await admin.ddl(SIDE);

  const clients = s.clients ?? 6;
  const ops = s.ops ?? 40;
  const total = clients * ops;
  let done = 0;
  let clock = 0;
  let paused = false;
  let active = 0;
  const checkpoints: Report["checkpoints"] = [];
  const snapshots: unknown[] = [];
  const env: Env = {
    c, rnd, admin,
    at: async (frac) => {
      while (done < frac * total) await c.sleep(1);
    },
    ddl: async (sql) => {
      let out = "ok";
      try {
        await admin.query(sql);
      } catch (e) {
        out = e instanceof Error ? e.message : String(e);
      }
      env.ddlLog.push(`${sql.replace(/\s+/g, " ").slice(0, 60)} => ${out}`);
      return out;
    },
    checkpoint: async (label) => {
      paused = true;
      // 途中で失敗しても、作業負荷を止めたままにしない。止めたままだと、失敗が記録されるだけで、実行が終わらなくなる。
      try {
        while (active > 0) await c.sleep(1);
        await c.settle();
        for (const core of c.cores.values()) await core.redrive().catch(() => {});
        await c.settle();
        // 調べるための書き出し用に、止めた時点の行と index の項目を取っておく (SIM_DUMP)。
        if (process.env.SIM_DUMP) {
          const names = ((await c.catalog()).tables.acct?.globalIndexes ?? []).map((g) => g.table);
          const index: unknown[] = [];
          for (const n of names) index.push(...(await rawRows(c, n)));
          snapshots.push({ label, at: c.net.log.length, rows: await rawRows(c, "acct"), index });
        }
        checkpoints.push({ label, ...(await indexAgreementAll(c)), duplicates: await duplicates(c) });
      } finally {
        paused = false;
      }
    },
    tick: () => ++clock,
    marks: {},
    useExtra: false,
    useSide: s.side === true,
    ddlLog: [],
  };

  const history: Rec[] = [];
  const errors: string[] = [];
  /** 成功を返した acct への書き込み。n は書き込みごとに一意である。 */
  const acked: { key: string; n: number; v: number | null; ts?: number; name: string }[] = [];
  const sideAcks: SideAck[] = [];
  let seq = 0;
  let sideId = 0;
  let commits = 0;
  let hot: { t: number; i: number } | null = null;
  let lastV: number | null = null;

  const tenants = s.tenants ?? TENANTS;
  const pick = (n: number) => 1 + Math.floor(rnd() * n);
  const key = () => ({ t: pick(tenants), i: pick(IDS) });
  const k = (x: { t: number; i: number }) => `${x.t}/${x.i}`;
  const value = (n: number, t: number): number | null => {
    if (s.values === "dup") return rnd() < 0.82 ? 1000 + n : pick(3);
    if (s.values === "dupTenant") return rnd() < 0.82 ? 1000 + n : t * 10 + pick(2);
    return rnd() < 0.05 ? null : pick(6);
  };

  // 初期データ。半分のキーに行を入れておく。
  for (let t = 1; t <= tenants; t++) {
    for (let i = 1; i <= IDS; i++) {
      if ((t + i) % 2) continue;
      const n = ++seq * 10;
      const v = s.values === "dup" || s.values === "dupTenant" ? 1000 + n : pick(6);
      const r = await admin.query("INSERT INTO acct(tenant_id, id, v, n) VALUES (?, ?, ?, ?)", [t, i, v, n]);
      // 初期データも、確定の時刻を持つ書き込みとして履歴に入れる。「どの取引よりも前にある状態」として扱うと、誤って違反を報告する。
      // シャードの時計は、同じ ms の中でも発行した数だけ先へ進んでいる。取引の読む時点が別のシャードの小さい時刻で決まると、
      // その取引の 2 文目以降は、応答まで返った初期データを見ないことがある。複数シャードの取引は serializable で、
      // 実時間の順序までは約束していないので、これは違反ではない。時刻の順に並べれば、読みは初期データの前に来る。
      if (r.ts === undefined) throw new Error("the initial INSERT returned no commit timestamp");
      history.push({ name: `init ${t}/${i}`, ts: r.ts, readOnly: false, reads: [], writes: [{ key: `${t}/${i}`, value: n }], vreads: [], wv: [v] });
    }
  }
  for (const sql of s.before ?? []) await admin.ddl(sql);

  type Q = { query: Txn["query"] };
  const readKey = async (tx: Q, x: { t: number; i: number }, reads: Read[]) => {
    const r = await tx.query("SELECT n FROM acct WHERE tenant_id = ? AND id = ?", [x.t, x.i]);
    reads.push({ key: k(x), value: (r.rows[0]?.n as number | undefined) ?? null });
  };
  const readTenant = async (tx: Q, t: number, reads: Read[]) => {
    const r = await tx.query("SELECT count(*) c, coalesce(sum(n), 0) s FROM acct WHERE tenant_id = ?", [t]);
    reads.push({ tenant: t, value: { count: r.rows[0]!.c, sum: r.rows[0]!.s } });
  };
  type Writes = TxRecord["writes"] & { v?: (number | null)[] };
  /** 確定した書き込みが extra に書いた値。行ごとに持つ (record が、extra を書く操作の成功のときに足す)。 */
  const extraWritten = new Map<string, Set<number>>();
  const noteV = (writes: Writes, v: number | null) => void (writes.v = [...(writes.v ?? []), v]);
  const put = async (tx: Q, x: { t: number; i: number }, n: number, v: number | null, extra: boolean, writes: Writes) => {
    await tx.query("DELETE FROM acct WHERE tenant_id = ? AND id = ?", [x.t, x.i]);
    if (extra) await tx.query("INSERT INTO acct(tenant_id, id, v, n, extra) VALUES (?, ?, ?, ?, ?)", [x.t, x.i, v, n, n]);
    else await tx.query("INSERT INTO acct(tenant_id, id, v, n) VALUES (?, ?, ?, ?)", [x.t, x.i, v, n]);
    writes.push({ key: k(x), value: n });
    noteV(writes, v);
  };

  interface Plan {
    name: string;
    body(tx: Q, reads: Read[], writes: Writes): Promise<void>;
    side?: { t: number; id: number; n: number };
  }
  const record = (p: Plan, ts: number | undefined, reads: Read[], writes: Writes, begun: number, vreads: VRead[] = [], extra = false) => {
    const acked_ = env.tick();
    if (extra) for (const w of writes) if (w.value !== null) extraWritten.set(w.key, (extraWritten.get(w.key) ?? new Set()).add(w.value));
    if (writes.length) commits++;
    const wv = writes.map((_w, i) => writes.v?.[i] ?? null);
    writes.forEach((w, i) => {
      if (w.value !== null) acked.push({ key: w.key, n: w.value, v: wv[i]!, ts, name: p.name });
    });
    if (p.side) sideAcks.push({ ...p.side, begun, acked: acked_ });
    if (ts !== undefined) history.push({ name: p.name, ts, readOnly: writes.length === 0, reads, writes: [...writes], vreads, wv });
  };

  /** 乱数はここで全部引く。取引の本体はリトライで再実行されるので、乱数を引かない。 */
  const plan = (): {
    mode: "txn" | "pess" | "slow" | "autoUpdate" | "autoInsert" | "vread"; p: Plan; x: { t: number; i: number }; n: number; v: number | null; extra: boolean;
    readOnly: boolean;
  } => {
    const name = `w${++seq}`;
    const n = seq * 10;
    const kind = rnd();
    const mode =
      kind < 0.65 ? (rnd() < 0.25 ? "pess" : "txn")
      : kind < 0.78 ? "autoUpdate"
      : kind < 0.84 ? "autoInsert"
      : kind < 0.93 ? "vread"
      : s.slowLocks ? "slow" : "pess";
    // ロックを長く持つ取引の行を、autocommit の UPDATE が狙う。ロック待ちの間に DDL が進む。
    const a = s.slowLocks && hot && mode === "autoUpdate" && rnd() < 0.7 ? hot : key();
    let b = key();
    while (b.t === a.t) b = key();
    const va = value(n, a.t);
    const vb = value(n + 1, b.t);
    const extra = env.useExtra;
    // side の行は b の tenant に置く。2 シャードの取引では anchor でない参加者に載りやすい。
    const side = env.useSide && rnd() < 0.7 ? { t: b.t, id: ++sideId, n } : undefined;
    const withSide = async (tx: Q) => {
      if (side) await tx.query("INSERT INTO side(tenant_id, id, n) VALUES (?, ?, ?)", [side.t, side.id, side.n]);
    };
    const bodies: Record<string, Plan["body"]> = {
      read: async (tx, reads) => {
        await readKey(tx, a, reads);
        await readTenant(tx, b.t, reads);
        await readKey(tx, b, reads);
      },
      one: async (tx, reads, writes) => {
        await readKey(tx, a, reads);
        await put(tx, a, n, va, extra, writes);
        await withSide(tx);
      },
      two: async (tx, reads, writes) => {
        await readTenant(tx, a.t, reads);
        await put(tx, a, n, va, extra, writes);
        await put(tx, b, n + 1, vb, extra, writes);
        await withSide(tx);
      },
      del: async (tx, reads, writes) => {
        await readKey(tx, a, reads);
        await tx.query("DELETE FROM acct WHERE tenant_id = ? AND id = ?", [a.t, a.i]);
        writes.push({ key: k(a), value: null });
        noteV(writes, null);
      },
    };
    const body = kind < 0.12 ? "read" : kind < 0.32 ? "one" : kind < 0.55 ? "two" : kind < 0.65 ? "del" : "one";
    const usesSide = side && (body === "one" || body === "two") && (mode === "txn" || mode === "pess" || mode === "slow");
    return { mode, p: { name, body: bodies[body]!, side: usesSide ? side : undefined }, x: a, n, v: va, extra, readOnly: mode === "vread" || body === "read" };
  };

  /** シャードをまたぐ UNIQUE の index が、一度でも公開されたか。 */
  let everUnique = false;
  /** note には、この操作が読むだけかを渡す。UNIQUE の誤りを分類するのに使う。 */
  const one = async (db: Db, note: (readOnly: boolean) => void) => {
    const { mode, p, x, n, v, extra, readOnly: ro } = plan();
    note(ro);
    const begun = env.tick();
    const w1 = (): Writes => Object.assign([{ key: k(x), value: n }], { v: [v] });
    if (mode === "vread") {
      // 直前に書かれた値を狙う。新しい行が index から見えるかを確かめるためである。
      const want = lastV ?? v ?? 1;
      const r = await db.query("SELECT tenant_id, id FROM acct WHERE v = ?", [want]);
      if (r.ts !== undefined) record(p, r.ts, [], [], begun, [{ v: want, keys: r.rows.map((row) => `${row.tenant_id}/${row.id}`) }]);
      return;
    }
    if (v !== null) lastV = v;
    if (mode === "autoUpdate") {
      const r = extra
        ? await db.query("UPDATE acct SET v = ?, n = ?, extra = ? WHERE tenant_id = ? AND id = ?", [v, n, n, x.t, x.i])
        : await db.query("UPDATE acct SET v = ?, n = ? WHERE tenant_id = ? AND id = ?", [v, n, x.t, x.i]);
      if (r.changes > 0) record(p, r.ts, [], w1(), begun, [], extra);
      return;
    }
    if (mode === "autoInsert") {
      const r = await db.query("INSERT INTO acct(tenant_id, id, v, n) VALUES (?, ?, ?, ?)", [x.t, x.i, v, n]);
      record(p, r.ts, [], w1(), begun);
      return;
    }
    if (mode === "txn") {
      let last: { tx: Txn; reads: Read[]; writes: Writes } | undefined;
      await db.transaction(async (tx) => {
        last = { tx, reads: [], writes: [] };
        await p.body(tx, last.reads, last.writes);
      });
      record(p, last!.tx.commitTs ?? last!.tx.T, last!.reads, last!.writes, begun, [], extra);
      return;
    }
    const tx = await db.begin();
    tx.pessimistic = true;
    tx.lockReads = rnd() < 0.5;
    const reads: Read[] = [];
    const writes: Writes = [];
    try {
      await p.body(tx, reads, writes);
      if (mode === "slow") {
        hot = x;
        await c.sleep(60 + rnd() * 200);
      }
      await tx.commit();
    } catch (e) {
      await tx.unlockAll();
      throw e;
    }
    record(p, tx.commitTs ?? tx.T, reads, writes, begun, [], extra);
  };

  const worker = async () => {
    let db = client();
    for (let i = 0; i < ops; i++) {
      if (rnd() < 0.1) db = client();
      while (paused) await c.sleep(1);
      active++;
      let readOnly = false;
      try {
        await one(db, (ro) => (readOnly = ro));
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        if (SCHEMA_ERR.test(m)) db = client(); // 古い表定義を捨てる。利用者のリトライに当たる。
        const sideGone = /no such table: (main\.)?(side|__gidx_)/.test(m);
        const extraUnknown = /extra/.test(m) && SCHEMA_ERR.test(m);
        // UNIQUE の誤りは、書き込みだけが受け取ってよい。主キーの衝突はいつでも起きる。v の衝突は、v の UNIQUE の index が
        // 公開された後だけである。作っている最中の index と、取り消された index は、どの文の結果も変えてはならない。
        // 読みが UNIQUE で失敗するのは、どの場合も誤りである。
        let uniqueOk = false;
        if (/UNIQUE constraint failed/.test(m) && !readOnly) {
          everUnique ||= ((await c.catalog()).tables.acct?.globalIndexes.length ?? 0) > 0;
          uniqueOk = /acct\.tenant_id, acct\.id/.test(m) || everUnique;
        }
        if (!(EXPECTED.test(m) || uniqueOk || sideGone || extraUnknown)) errors.push(readOnly && /UNIQUE/.test(m) ? `a read failed: ${m}` : m);
      } finally {
        active--;
        done++;
      }
    }
  };

  let stop = false;
  let splits = 0;
  const grower = (async () => {
    let next = c.shardIds.length;
    while (!stop && s.splits && next < c.shardIds.length + 5) {
      await c.sleep(40);
      const { routing } = await c.catalog();
      const list = shardsOf(routing);
      const parent = list[Math.floor(rnd() * list.length)]!;
      const range = planSplit(routing, parent);
      if (!range) continue;
      const child = `s${next++}`;
      for (let attempt = 0; attempt < 20; attempt++) {
        try {
          await split(c, parent, child, { range });
          splits++;
          break;
        } catch (e) {
          const m = e instanceof Error ? e.message : String(e);
          // 表定義の変更 (index の作成など) が、保守の操作の枠を持っている。終わるまで待つ。待つ回数には数えない。
          if (/^split busy:/.test(m) && !stop) {
            attempt--;
            await c.sleep(50);
            continue;
          }
          // 子が古い表定義のまま親の行を受け取ると drain が失敗する。要求が届けば子は追い付くので、やり直す。
          if (attempt === 19) errors.push(`split: ${m}`);
          await c.sleep(5);
        }
      }
    }
  })();
  const ddl = s.ddl(env).catch((e) => void errors.push(`ddl actor: ${e instanceof Error ? e.message : String(e)}`));
  await Promise.all(Array.from({ length: clients }, worker));
  stop = true;
  await ddl;
  await grower;

  // ---- 後始末と検査 ----
  const stuck = await stuckWork(c);
  await touchAll(c).catch((e) => void errors.push(`touchAll: ${e instanceof Error ? e.message : String(e)}`));
  const schema = await schemaVersions(c);
  const cat = await c.catalog();

  // 成功を返した書き込みの commit 時刻を、変更ログから引く。autocommit の一部は時刻を返さないからである。
  const logged = new Map<number, number>();
  for (const b of c.backends.values()) {
    for (const r of logRows(b)) {
      for (const ch of decode<Change[]>(r.blob as string)) {
        if (ch.table === "acct" && ch.after && typeof ch.after.n === "number") logged.set(ch.after.n, r.commit_ts as number);
      }
    }
  }
  const ackedNotApplied: string[] = [];
  for (const a of acked) {
    const ts = logged.get(a.n);
    if (ts === undefined) ackedNotApplied.push(`${a.name} ${a.key} n=${a.n}`);
    else if (a.ts === undefined) {
      history.push({ name: a.name, ts, readOnly: false, reads: [], writes: [{ key: a.key, value: a.n }], vreads: [], wv: [a.v] });
    }
  }

  // 最後の状態を、すべての書き込みより後の読み取りとして履歴に足す。失われた書き込みと半端な適用がここで見つかる。
  const final: Read[] = [];
  try {
    const rows = (await new Db(c).query("SELECT tenant_id, id, n FROM acct")).rows;
    for (let t = 1; t <= tenants; t++) {
      for (let i = 1; i <= IDS; i++) {
        const row = rows.find((r) => r.tenant_id === t && r.id === i);
        final.push({ key: `${t}/${i}`, value: (row?.n as number | undefined) ?? null });
      }
    }
    history.push({ name: "final", ts: Number.MAX_SAFE_INTEGER, readOnly: true, reads: final, writes: [], vreads: [], wv: [] });
  } catch (e) {
    errors.push(`final read: ${e instanceof Error ? e.message : String(e)}`);
  }

  const misplaced = await misplacedRows(c);
  const badExtra = await extraViolations(c, extraWritten);

  const sideExists = cat.tables.side !== undefined;
  const sideRows = sideExists ? (await rawRows(c, "side")).map(({ row }) => row.n as number) : [];
  const dropIssued = env.marks.dropIssued ?? Infinity;
  const recreated = env.marks.recreated ?? (s.side && env.marks.dropIssued === undefined ? 0 : Infinity);
  const side = {
    exists: sideExists,
    resurrected: sideExists ? sideAcks.filter((a) => a.acked < dropIssued && sideRows.includes(a.n)).map((a) => `side ${a.t}/${a.id}`) : [],
    lost: sideExists ? sideAcks.filter((a) => a.begun > recreated && !sideRows.includes(a.n)).map((a) => `side ${a.t}/${a.id}`) : [],
  };
  if (env.marks.dropIssued === undefined) side.resurrected = [];

  // 失敗した seed を調べるための書き出し。SIM_DUMP=<ファイル> で、取引の記録と RPC の記録を JSON で残す。
  if (process.env.SIM_DUMP) {
    const plain = (_k: string, x: unknown) => (x instanceof Map ? [...x] : x instanceof Uint8Array ? [...x] : x);
    writeFileSync(process.env.SIM_DUMP, JSON.stringify({ seed, history, snapshots, rpc: c.net.log }, plain));
  }
  return {
    history: checkHistory(history),
    indexReads: checkIndexReads(history, new Map()),
    ackedNotApplied,
    errors: [...new Set(errors)],
    splitRefusals: c.net.failed
      .filter((f) => f.m.method !== "syncSchema" && /waiting for a shard split/.test(f.message))
      .map((f) => `${f.m.from} -> ${f.m.to} ${f.m.method}: ${f.message}`),
    stuck,
    schema,
    index: await indexAgreementAll(c),
    checkpoints,
    duplicates: await duplicates(c),
    misplaced,
    side,
    badExtra,
    commits,
    splits,
    ddlLog: env.ddlLog,
    fingerprint: c.fingerprint(),
  };
}
