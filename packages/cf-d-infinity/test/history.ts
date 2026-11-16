// 実行履歴が commit 時刻順の直列実行と一致するかを検査する (Elle の簡易版)。
// 後半は、その検査に掛ける乱択の作業負荷 (history.test.ts と move-returns.test.ts が使う)。
import { writeFileSync } from "node:fs";
import { split } from "../src/autoscaler";
import { fold, type EpochRecord } from "../src/catalog";
import type { Txn } from "../src/client/db";
import { keyString } from "../src/keys";
import { readEpochs } from "../src/meta";
import { initialRouting, overlaps, ownerOf, planSplit, regionsOf, shardsOf, slotOf, type Interval } from "../src/routing";
import { SqlError, type Faults } from "../src/types";
import { expectQuiescent } from "./invariants";
import { prng, SimCluster, USERS, type Rpc } from "./sim";

export type Key = string; // "tenant/id"
export interface Read {
  key?: Key;
  /** tenant 内の述語読み。行数と合計を比べる。 */
  tenant?: number;
  value: unknown;
}
export interface TxRecord {
  name: string;
  /** 書き込みなら commit 時刻、読み取りだけなら T。 */
  ts: number;
  readOnly: boolean;
  reads: Read[];
  writes: { key: Key; value: number | null }[];
}

export interface Violation {
  txn: string;
  read: Read;
  expected: unknown;
}

function evalRead(state: Map<Key, number>, r: Read): unknown {
  if (r.key !== undefined) return state.get(r.key) ?? null;
  let count = 0;
  let sum = 0;
  for (const [k, v] of state) {
    if (k.startsWith(`${r.tenant}/`)) {
      count++;
      sum += v;
    }
  }
  return { count, sum };
}

/** 書き込みは ts の順に適用する。読み取りだけの取引は ts 以下の commit を見る。 */
export function checkHistory(history: TxRecord[], initial: Map<Key, number> = new Map()): Violation[] {
  const order = [...history].sort((a, b) => a.ts - b.ts || Number(a.readOnly) - Number(b.readOnly));
  // 同じ ts の書き込みは互いに素なシャードの取引なので、先に全部適用してから読み取りを見る。
  const violations: Violation[] = [];
  const state = new Map(initial);
  for (const t of order) {
    for (const r of t.reads) {
      const expected = evalRead(state, r);
      if (JSON.stringify(expected) !== JSON.stringify(r.value)) violations.push({ txn: t.name, read: r, expected });
    }
    for (const w of t.writes) {
      if (w.value === null) state.delete(w.key);
      else state.set(w.key, w.value);
    }
  }
  return violations;
}

// ---- 乱択の作業負荷 ----

const IDS = 3;

/** 範囲の移動の乱択 (RunOpts.moves)。 */
export interface MoveChaos {
  /**
   * 移る範囲の選び方。split は Autoscaler と同じく、親の最も広い区間の半分を、まだ使っていない名前の子へ渡す。returns は、それに加えて、
   * 範囲表の 1 つの区間を丸ごと、範囲を持たないシャードへ渡す。宛先は、その区間を前に持っていたシャードを選びやすくする (前の持ち主へ戻る)。
   */
  kind: "split" | "returns";
  /** 移動の手順の要求 (MOVE_RPCS) の配送の前に、ときどき子か親を再起動する。 */
  restarts?: boolean;
  /**
   * 進める側 (Autoscaler) が、ときどき startMove の後で止まる (子に drain を送らない)。drain が再起動で失敗したときも、ときどき
   * やり直さずに離れる。どちらも、子が自分で (応答の後の仕事と alarm で) 移動を終える。Autoscaler の次の判断は、開いたままの移動を
   * ときどき再開する (movesToResume)。
   */
  stops?: boolean;
  /**
   * 未解決の問題 54 の時刻 (範囲が前の持ち主へ戻る途中に届く phase 2) を作らない。戻る移動を始める前に、どのシャードにも、宛先が前に
   * 渡した取引 (宛先の __moved_txn) の intent が残っていないことを求め、残っていれば、その移動を後回しにする。54 の窓より広く外す
   * (窓は、宛先が move-start を適用してから、その intent のグループを引き取るまでである)。
   */
  hide54?: boolean;
  /**
   * 終わった移動の遅れた pull が、範囲が戻ってきた前の親に届く時刻を作らない (test/open/stale-pull-after-return.test.ts。親は、終わった移動の
   * fence でグループを渡し直そうとし、内部の誤りで答える)。宛先へ向かう pull がまだ届いていない (応答も失敗も返っていない) 間は、その宛先への
   * 移動を後回しにする。宛先は範囲を持たないシャードなので、そこへ向かう pull は、どれも終わった移動のものである。
   */
  hideStalePull?: boolean;
  /** 移動の手順の要求の配送を、ときどき最大この ms だけ遅らせる。既定は 20。 */
  slowMoveRpcMs?: number;
  /** 移動と移動の間の待ちの上限 (ms)。既定は、thinkMs があればその 2 倍、なければ 60。 */
  paceMs?: number;
}

export interface RunOpts {
  seed: number;
  clients?: number;
  ops?: number;
  skewMs?: number;
  restarts?: boolean;
  /** 実行中にシャードを増やす。 */
  splits?: boolean;
  /** 悲観的な取引で流す。 */
  pessimistic?: boolean;
  faults?: Faults;
  /** 起動時のシャードの数。既定は 4。 */
  shards?: number;
  /**
   * 範囲を、作業負荷と並べて動かす (MoveChaos)。splits の分割とは別の進め方で、乱数も別の流れから引く。指定しない実行の乱数の列と
   * RPC の列は、この選択肢を足す前と同じである。
   */
  moves?: MoveChaos;
  /** 取引の前に置く待ちの上限 (ms)。作業負荷を、子の alarm (5 秒ごと) が何度か発火するまで続ける。 */
  thinkMs?: number;
  /** phase 2 (finalize) の配送を、ときどき最大この ms だけ遅らせる (moves の実行だけ)。 */
  slowPhase2Ms?: number;
  /** tenant の数。既定は 6。多いほど、取引の intent を読み手が決着させる前に、範囲が動く。 */
  tenants?: number;
}

/**
 * 実行が終わらないと見なす上限。仮想の時刻で 10 分、出来事 200 万個。欠陥を入れた実行は、要求を投げ合い続けて終わらないことがある。
 * 上限で、原因の分かる失敗にする (試験の制限時間は、出来事が途切れずに続くと効かないことがある)。
 */
const STALL_MS = 10 * 60_000;
const STALL_STEPS = 2_000_000;

/** moves の実行で始める移動の数の上限。 */
const MAX_MOVES = 12;

/** 範囲の移動の手順の要求。子が親へ送る (listGroups、pull、ack、finishMove) か、進める側が子へ送る (drain)。 */
const MOVE_RPCS = new Set(["listGroups", "pull", "ack", "finishMove", "drain"]);

export interface RunResult {
  history: TxRecord[];
  violations: Violation[];
  unknown: number;
  c: SimCluster;
  splits: number;
  /** moves の実行で見つけた、履歴の外の問題 (strandedIntents、移動の終わり方、行の置き場所)。空なら健全である。 */
  problems: string[];
  /** moves の実行の数え。検査が何かを確かめたかを、試験が確かめるのに使う。 */
  counts: MoveCounts;
}

export interface MoveCounts {
  /** 始めた移動 (move-start の記録)。 */
  moves: number;
  /** そのうち、範囲を前の持ち主へ戻した移動。 */
  returns: number;
  /** 進める側の drain が完了を返さないまま閉じた移動。子が自分で終えた。 */
  byChild: number;
  /** 移動の手順の要求の前に再起動した、子と親の数。 */
  restarts: number;
  /** hide54 と hideStalePull が後回しにした移動の数。 */
  deferred: number;
}

export async function runHistory(o: RunOpts): Promise<RunResult> {
  const rnd = prng(o.seed);
  const skew = new Map<string, number>();
  const c = new SimCluster({
    shards: o.shards ?? 4,
    faults: o.faults,
    seed: o.seed,
    skewMs: (id) => {
      if (!skew.has(id)) skew.set(id, Math.floor(rnd() * (o.skewMs ?? 0)));
      return skew.get(id)!;
    },
  });
  c.net.jitter = () => (rnd() < 0.5 ? 0 : rnd() * 3);
  return Promise.race([body(o, c, rnd), c.stalled(STALL_MS, STALL_STEPS)]);
}

async function body(o: RunOpts, c: SimCluster, rnd: () => number): Promise<RunResult> {
  const admin = c.client();
  await admin.ddl(USERS);

  const history: TxRecord[] = [];
  const TENANTS = o.tenants ?? 6;
  const pick = (n: number) => 1 + Math.floor(rnd() * n);
  const key = () => ({ t: pick(TENANTS), i: pick(IDS) });
  const k = (x: { t: number; i: number }) => `${x.t}/${x.i}`;
  let seq = 0;
  let unknown = 0;
  // moves と thinkMs の実行だけが引く乱数。作業負荷の乱数 (rnd) の列を変えない。
  const r2 = prng(o.seed ^ 0x6a09e667);
  const moves = o.moves ? startMoves(o, o.moves, c, r2) : null;

  const readKey = async (tx: Txn, x: { t: number; i: number }, reads: Read[]) => {
    // 整数の引数は INTEGER (bigint) で渡す。JS の数は REAL として束縛される (列の型の親和性が整数に戻すので、答えは同じである)。
    const r = await tx.query("SELECT n FROM users WHERE tenant_id = ? AND id = ?", [BigInt(x.t), BigInt(x.i)]);
    const value = (r.rows[0]?.n as number | undefined) ?? null;
    reads.push({ key: k(x), value });
    return value;
  };
  const readTenant = async (tx: Txn, t: number, reads: Read[]) => {
    const r = await tx.query("SELECT count(*) c, coalesce(sum(n), 0) s FROM users WHERE tenant_id = ?", [BigInt(t)]);
    reads.push({ tenant: t, value: { count: r.rows[0]!.c, sum: r.rows[0]!.s } });
  };
  const put = async (tx: Txn, x: { t: number; i: number }, v: number, writes: TxRecord["writes"]) => {
    await tx.query("DELETE FROM users WHERE tenant_id = ? AND id = ?", [BigInt(x.t), BigInt(x.i)]);
    await tx.query("INSERT INTO users(tenant_id, id, n) VALUES (?, ?, ?)", [BigInt(x.t), BigInt(x.i), BigInt(v)]);
    writes.push({ key: k(x), value: v });
  };

  const oneTxn = async (client: ReturnType<SimCluster["client"]>) => {
    const name = `w${seq++}`;
    const reads: Read[] = [];
    const writes: TxRecord["writes"] = [];
    const tx = await client.begin();
    if (o.pessimistic) {
      tx.pessimistic = true;
      tx.lockReads = true;
    }
    const kind = rnd();
    const v = seq * 10 + 1;
    if (kind < 0.25) {
      await readKey(tx, key(), reads);
      await readTenant(tx, pick(TENANTS), reads);
      await readKey(tx, key(), reads);
    } else if (kind < 0.5) {
      const x = key();
      await readKey(tx, x, reads);
      await put(tx, x, v, writes);
    } else if (kind < 0.75) {
      await readKey(tx, key(), reads);
      await readKey(tx, key(), reads);
      await put(tx, key(), v, writes);
    } else {
      const a = key();
      let b = key();
      while (k(b) === k(a)) b = key();
      await readTenant(tx, a.t, reads);
      await put(tx, a, v, writes);
      await put(tx, b, v + 1, writes);
    }
    try {
      await tx.commit();
    } catch (e) {
      await tx.unlockAll();
      throw e;
    }
    const ts = tx.commitTs ?? tx.T;
    if (ts === undefined) return;
    history.push({ name, ts, readOnly: writes.length === 0, reads, writes });
  };

  const worker = async () => {
    for (let i = 0; i < (o.ops ?? 40); i++) {
      if (o.thinkMs) await c.sleep(r2() * o.thinkMs);
      try {
        // 取引ごとに別セッションにする。因果トークンが時計のずれを隠さないようにするためである。
        await oneTxn(c.client());
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        if (/^(conflict|read too old|not owner|migrating)/.test(m) || e instanceof SqlError && /UNIQUE/.test(m)) continue;
        if (/fenced|rpc dropped/.test(m)) {
          unknown++;
          continue;
        }
        throw e;
      }
    }
  };

  let stop = false;
  const chaos = (async () => {
    while (!stop && o.restarts) {
      await c.sleep(15);
      c.restart(c.shardIds[Math.floor(rnd() * c.shardIds.length)]!);
      await Promise.all([...c.cores.values()].map((core) => core.redrive().catch(() => {})));
    }
  })();
  let splits = 0;
  // 割る回数に上限を置く。書き手が動いている間ずっと割ると、悲観的な取引の実行のように長く続く実行では数百回割り、分割ごとに
  // 全シャードへ版を適用させる費用がシャードの数に比例するので、全体で 2 乗に膨らむ (seed 207690027 で 581 回、RPC 17 万回。
  // 計画書の未解決の問題 13)。本物の Autoscaler は、負荷の閾値を超えたときにしか割らない。
  const MAX_SPLITS = 12;
  const grower = (async () => {
    let next = c.shardIds.length;
    while (!stop && o.splits && splits < MAX_SPLITS) {
      await c.sleep(25);
      const { routing } = await c.catalog();
      const list = shardsOf(routing);
      const parent = list[Math.floor(rnd() * list.length)]!;
      const range = planSplit(routing, parent);
      if (!range) continue;
      const child = `s${next++}`;
      // 再起動で途中で失敗しても、同じ範囲で最初からやり直せる。
      for (let attempt = 0; attempt < 50; attempt++) {
        try {
          await split(c, parent, child, { range });
          splits++;
          break;
        } catch (e) {
          if (!/fenced|dropped/.test(String(e))) throw e;
          await c.sleep(2);
        }
      }
    }
  })();
  await Promise.all(Array.from({ length: o.clients ?? 6 }, worker));
  stop = true;
  await chaos;
  await grower;
  const problems: string[] = [];
  if (moves) {
    problems.push(...(await moves.finish()));
    // 最後の状態を、すべての書き込みより後の読み取りとして履歴に足す。移動で失われた書き込みと、移動で戻ってきた古い行が、ここで見つかる。
    const rows = (await c.client().query("SELECT tenant_id, id, n FROM users")).rows;
    const reads: Read[] = [];
    for (let t = 1; t <= TENANTS; t++) {
      for (let i = 1; i <= IDS; i++) {
        const row = rows.find((r) => Number(r.tenant_id) === t && Number(r.id) === i);
        reads.push({ key: `${t}/${i}`, value: (row?.n as number | undefined) ?? null });
      }
    }
    history.push({ name: "final", ts: Number.MAX_SAFE_INTEGER, readOnly: true, reads, writes: [] });
    problems.push(...(await placement(c)));
  }
  await c.settle();
  for (const core of c.cores.values()) await core.redrive();
  await c.settle();
  // 欠陥を入れていない実行では、後始末が済んでいることも確かめる。
  if (!o.faults) await expectQuiescent(c);
  // 失敗した seed を調べるための書き出し。SIM_DUMP=<ファイル> で、取引の記録と RPC の記録を JSON で残す。
  if (process.env.SIM_DUMP) {
    const plain = (_k: string, x: unknown) => (x instanceof Uint8Array ? [...x] : x);
    writeFileSync(process.env.SIM_DUMP, JSON.stringify({ seed: o.seed, history, rpc: c.net.log }, plain));
  }
  const counts = moves?.counts ?? { moves: 0, returns: 0, byChild: 0, restarts: 0, deferred: 0 };
  return { history, violations: checkHistory(history), unknown, c, splits, problems, counts };
}

// ---- 範囲の移動の乱択 ----

/**
 * シャード shard が、shard key sk のグループを持っているか。シャードが保存した記録だけから決める (test/sim.ts の ownsToken と同じ規則)。
 * 写した epoch の列を畳んだ範囲表で、そのグループの token が自分のものであり、そのグループを渡したなら、その後に届き直したか、
 * そのグループを含む範囲を受け取り直したこと。渡して ack を待つ親は、行と intent の写しを持つが、持ち主ではない。
 */
function holdsGroup(c: SimCluster, shard: string, sk: string): boolean {
  const db = c.backends.get(shard)!.db;
  const rows = db.prepare(`SELECT epoch, rec FROM __epoch ORDER BY epoch`).all() as { epoch: number; rec: string }[];
  const routing = rows.length > 0 ? fold(rows.map((r) => ({ epoch: r.epoch, rec: JSON.parse(r.rec) as EpochRecord }))).routing : initialRouting(c.shardIds);
  const token = slotOf(sk);
  if (routing.ranges.find((x) => token >= x.start && token < x.end)?.shard !== shard) return false;
  const last = (table: string) => (db.prepare(`SELECT max(epoch) AS e FROM ${table} WHERE g = ?`).get(sk) as { e: number | null }).e;
  const out = last("__moved");
  if (out === null) return true;
  const received = (db.prepare(`SELECT max(epoch) AS e FROM __incoming WHERE lo <= ? AND ? < hi`).get(token, token) as { e: number | null }).e;
  return Math.max(last("__arrived") ?? -1, received ?? -1) > out;
}

/**
 * 確定して、anchor が全参加者へ phase 2 を届け終えた (anchor の __txn が committed で done = 1) 取引の intent を、そのグループの持ち主が
 * まだ持っている。参加者は、intent を適用したか、いまの持ち主へ転送した後でだけ phase 2 を受け取ったと答えるので、こうなってはならない
 * (未解決の問題 54 の不変条件の候補)。読み手か redrive が anchor に尋ねれば決着するが、anchor が記録を消した後 (TXN_RETAIN_MS) は、
 * presumed abort で捨てられる。だから、読み手と redrive が来る前に、直に SQLite を読んで確かめる。
 */
export function strandedIntents(c: SimCluster): string[] {
  const out: string[] = [];
  for (const [id, b] of c.backends) {
    for (const r of b.exec(`SELECT DISTINCT txn, anchor, sk FROM __intents`)) {
      const st = c.backends.get(r.anchor as string)?.exec(`SELECT status, done FROM __txn WHERE txn = ?`, r.txn as string)[0];
      if (st?.status !== "committed" || st.done !== 1) continue;
      if (holdsGroup(c, id, r.sk as string)) {
        out.push(`${id}: the intent of txn ${r.txn} (group ${r.sk}) is still there, but anchor ${r.anchor} delivered its phase 2 to every participant`);
      }
    }
  }
  return out;
}

/** 移動が全部閉じた後の、行の置き場所。どの行も、Meta の範囲表の持ち主にだけ、1 度だけある。 */
async function placement(c: SimCluster): Promise<string[]> {
  const { routing } = await c.catalog();
  const out: string[] = [];
  const seen = new Map<string, string[]>();
  for (const [id, b] of c.backends) {
    if (b.exec(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'users'`).length === 0) continue;
    for (const row of b.exec(`SELECT tenant_id, id FROM users`)) {
      const name = `${row.tenant_id}/${row.id}`;
      seen.set(name, [...(seen.get(name) ?? []), id]);
      const owner = ownerOf(routing, keyString([BigInt(row.tenant_id as number)]));
      if (owner !== id) out.push(`row ${name} is on ${id}, but the range table gives it to ${owner}`);
    }
  }
  for (const [name, on] of seen) if (on.length > 1) out.push(`row ${name} is on ${on.join(" and ")}`);
  return out;
}

/**
 * 範囲を作業負荷と並べて動かす。Autoscaler と同じく split (startMove と子の drain) で進め、途中で子と親を再起動し、進める側を止める。
 * finish は、作業負荷が終わった後で、開いた移動が閉じるのを待ち (子が自分で終える。子が移動を知らないままなら、Autoscaler が再開する)、
 * 見つけた問題を返す。
 */
function startMoves(o: RunOpts, m: MoveChaos, c: SimCluster, r2: () => number) {
  const counts: MoveCounts = { moves: 0, returns: 0, byChild: 0, restarts: 0, deferred: 0 };
  const problems: string[] = [];
  /** 進める側の split が完了を返した移動 (move-start の epoch)。 */
  const drained = new Set<number>();
  /** 区間を前に持っていたシャード。戻る移動の宛先を選ぶのに使う。 */
  const formerly: { shard: string; range: Interval }[] = [];
  // 子が移動を閉じさせる手 (Meta の endMove) を見張る。子は、受け取り終えた後でだけ呼ぶ (M21 の END_AFTER_DRAIN)。受け取り終えた印
  // (__incoming の done) は、その前に finishIncoming が付ける。
  const realEnd = c.meta.endMove.bind(c.meta);
  c.meta.endMove = async (epoch: number) => {
    const rec = readEpochs(c.metaBackend).find((x) => x.epoch === epoch)?.rec;
    if (rec?.kind === "move-start") {
      const row = c.backends.get(rec.to)?.exec(`SELECT done FROM __incoming WHERE epoch = ?`, epoch)[0];
      if (row?.done !== 1) problems.push(`${rec.to} asked to close the move of epoch ${epoch} before it finished receiving it`);
    }
    return realEnd(epoch);
  };
  // 移動の手順の要求の配送の前に、ときどき子か親を再起動する。要求は、新しい instance に届く (送り手を再起動したなら、応答は捨てられた
  // instance に返り、その手順は失敗する)。phase 2 と、移動の手順の要求の配送を、ときどき遅らせる。
  /** 配送したが、まだ応答も失敗も返っていない pull (hideStalePull)。 */
  const pulls = new Set<Rpc>();
  c.net.reply = (x) => void pulls.delete(x);
  c.net.gate = (x) => {
    if (x.method === "pull") pulls.add(x);
    if (m.restarts && MOVE_RPCS.has(x.method) && r2() < 0.12) {
      const who = x.from === "client" || r2() < 0.5 ? x.to : x.from;
      if (c.backends.has(who)) {
        c.restart(who);
        counts.restarts++;
      }
    }
    if (o.slowPhase2Ms && x.method === "finalize" && r2() < 0.4) return c.sleep(r2() * o.slowPhase2Ms);
    if (MOVE_RPCS.has(x.method) && r2() < 0.2) return c.sleep(r2() * (m.slowMoveRpcMs ?? 20));
    return undefined;
  };

  /** 区間 range を from から to へ動かす。止まる進め方なら、ときどき startMove だけで離れる。 */
  const drive = async (from: string, to: string, range: Interval): Promise<void> => {
    if (m.stops && r2() < 0.3) {
      // 進める側が startMove の後で止まる。子は、最新の範囲表の要求が届くか、Autoscaler が再開するまで移動を知らない。
      await c.startMove({ from, to, ...range }).catch(() => undefined);
      return;
    }
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        const r = await split(c, from, to, { range });
        const open = readEpochs(c.metaBackend).findLast((x) => x.rec.kind === "move-start" && x.rec.from === from && x.rec.to === to);
        if (r && open) drained.add(open.epoch);
        return;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // 子か親が再起動した。止まる進め方なら、ときどき、やり直さずに離れる (子の alarm が続きを進める)。
        if (/fenced|dropped|restarted/.test(msg)) {
          if (m.stops && r2() < 0.5) return;
          await c.sleep(2);
          continue;
        }
        // ほかの移動か表定義の遷移と重なった。次の判断に回す。
        if (/^split busy:|schema busy:|already handing|still receiving|unfinished move|already owns/.test(msg)) return;
        throw e;
      }
    }
  };

  /** 次に動かす区間と宛先。宛先は、範囲を持たず、開いた移動に関わらないシャードである。 */
  let next = c.shardIds.length;
  // 範囲が戻る実行では、シャードの数を抑えて、範囲を持たないシャード (前の持ち主) を宛先に選ぶ機会を作る。
  const MAX_SHARDS = c.shardIds.length + (m.kind === "returns" ? 3 : MAX_MOVES);
  const choose = async (): Promise<{ from: string; to: string; range: Interval } | null> => {
    const { routing } = await c.catalog();
    const open = await c.moves();
    const busy = new Set(open.flatMap((x) => [x.from, x.to]));
    const holding = shardsOf(routing);
    const owners = holding.filter((id) => !busy.has(id));
    if (owners.length === 0) return null;
    const from = owners[Math.floor(r2() * owners.length)]!;
    const regions = regionsOf(routing, from);
    const range = m.kind === "returns" && r2() < 0.6 ? (regions[Math.floor(r2() * regions.length)] ?? null) : planSplit(routing, from);
    if (!range) return null;
    if (m.kind === "split") return next < MAX_SHARDS ? { from, to: `s${next++}`, range } : null;
    // 範囲を持たず、移動に関わらないシャード。前の持ち主を、宛先に選びやすくする。いなければ、まだ使っていない名前にする (上限まで)。
    const empty = [...c.backends.keys()].filter((id) => !holding.includes(id) && !busy.has(id)).sort();
    const back = empty.filter((id) => formerly.some((f) => f.shard === id && overlaps(f.range, range)));
    const others = empty.filter((id) => !back.includes(id));
    let to: string | undefined;
    if (back.length > 0 && r2() < 0.8) to = back[Math.floor(r2() * back.length)];
    else if (others.length > 0 && (r2() < 0.5 || next >= MAX_SHARDS)) to = others[Math.floor(r2() * others.length)];
    else if (next < MAX_SHARDS) to = `s${next++}`;
    return to ? { from, to, range } : null;
  };

  /** 戻る移動を、未解決の問題 54 の時刻を作らないように後回しにするか (MoveChaos.hide54)。 */
  const defer54 = (to: string): boolean => {
    const b = c.backends.get(to);
    if (!m.hide54 || !b) return false;
    const handed = new Set(b.exec(`SELECT DISTINCT txn FROM __moved_txn`).map((r) => r.txn as string));
    if (handed.size === 0) return false;
    for (const other of c.backends.values()) {
      for (const r of other.exec(`SELECT DISTINCT txn FROM __intents`)) if (handed.has(r.txn as string)) return true;
    }
    return false;
  };

  /** 宛先へ向かう pull が、まだ届いていないか (MoveChaos.hideStalePull)。失敗した pull は、応答の hook を通らないので、失敗の記録で外す。 */
  const deferStalePull = (to: string): boolean => {
    if (!m.hideStalePull) return false;
    for (const x of pulls) if (c.net.failed.some((f) => f.m === x)) pulls.delete(x);
    return [...pulls].some((x) => x.to === to);
  };

  const started = (p: { from: string; to: string; range: Interval }) =>
    readEpochs(c.metaBackend).some((x) => x.rec.kind === "move-start" && x.rec.from === p.from && x.rec.to === p.to && x.rec.start === p.range.start && x.rec.end === p.range.end);
  let stop = false;
  const mover = (async () => {
    while (!stop && counts.moves < MAX_MOVES) {
      // 取引の間に待ちを置く実行では、移動も同じ速さに散らす。散らさないと、移動は作業負荷の最初の 1 秒ほどで上限に届く。
      await c.sleep(20 + r2() * (m.paceMs ?? (o.thinkMs ? 2 * o.thinkMs : 60)));
      // Autoscaler の次の判断は、開いたままの移動を再開する (movesToResume)。子が移動を知っていれば、子が自分で進めているので、
      // ときどきだけ再開する。
      for (const x of await c.moves()) if (r2() < 0.2) await drive(x.from, x.to, x);
      const plan = await choose();
      if (!plan) continue;
      const isReturn = formerly.some((f) => f.shard === plan.to && overlaps(f.range, plan.range));
      if ((isReturn && defer54(plan.to)) || deferStalePull(plan.to)) {
        counts.deferred++;
        continue;
      }
      await drive(plan.from, plan.to, plan.range);
      // move-start が記録されなかった (ほかの移動か遷移と重なった) なら、数えない。
      if (!started(plan)) continue;
      counts.moves++;
      if (isReturn) counts.returns++;
      formerly.push({ shard: plan.from, range: plan.range });
      // 移動の後で、読み手と redrive が来る前に確かめる (strandedIntents)。
      problems.push(...strandedIntents(c));
    }
  })();

  const finish = async (): Promise<string[]> => {
    stop = true;
    await mover;
    // 開いた移動が閉じるのを待つ。子は、移動を知っていれば自分で (alarm で) 終える。知らないままの子には、Autoscaler が drain を送る。
    for (let waited = 0; ; waited += 500) {
      const open = await c.moves();
      if (open.length === 0) break;
      if (waited >= 120_000) {
        problems.push(`moves stayed open: ${open.map((x) => `${x.from}->${x.to} (epoch ${x.epoch})`).join(", ")}`);
        break;
      }
      if (waited % 20_000 === 19_500) for (const x of open) await split(c, x.from, x.to, { range: x }).catch(() => undefined);
      await c.sleep(500);
    }
    await c.settle();
    problems.push(...strandedIntents(c));
    const log = readEpochs(c.metaBackend);
    const ended = new Set(log.flatMap((x) => (x.rec.kind === "move-end" ? [x.rec.of] : [])));
    counts.byChild = log.filter((x) => x.rec.kind === "move-start" && ended.has(x.epoch) && !drained.has(x.epoch)).length;
    return [...new Set(problems)];
  };
  return { counts, finish };
}
