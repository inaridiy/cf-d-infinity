// 生成器 8 (docs/design-refresh-across-move.md の「乱択の検査に足す生成器」)。行ロックを持つ取引と分割と、別の接続の書き込み
// (test/placement-differential.test.ts の、行ロックの場面)。
//
// 悲観の取引 L (SQL の BEGIN か、Hrana の baton) が行 X を書いて行ロックを取り、X の範囲が分割で動き、L は別の行 Y で働き続ける。別の接続が、
// L の間に X を書き (W)、L が終わった後にもう一度 X を書く (W2)。同じ台本を、分割しない置き場所 (1 シャード、2 シャード) と、X の範囲を
// 分割する置き場所で流し、比べる。台本の形は 4 つある。
//   plain:    L が X を書いた後に分割する。
//   slowPull: 分割を始め、親が答えた pull の応答を止め、その間に L が文を出し (延長)、ときどき ROLLBACK する。それから応答を通す。
//   restart:  分割の後に、X を書いたときのシャード (分割の親) を再起動してから、L を終える。W は出さず、W2 だけを比べる
//             (再起動は故障で、ロックが消えてよい。M25 の locksSame は故障のない走りの性質である)。
//   idle:     L は X を書いた後、文を出さずに 3 秒待ち、分割の後、X のロックを取ってから 5 秒の少し後に W を出す (運んだロックの寿命)。
// 比べるもの (置き場所に依らないと約束していること。規則 4、不変条件 F、M23e と M25 の locksSame と outcomeSame):
//   - W が待たされたか (PATIENCE_MS を過ぎても終わらない。基準経路だけの実行では、待たずに `row locked by` で断られる)。W の結果の種類。
//   - L の文の結果と、COMMIT の成否。最後の表の中身。
// どの置き場所でも確かめること (伏せない):
//   - L が確定したなら、L の間に出した W は、L が終わるまで終わっていない (待たされた) か、失敗した。終わっていれば、L の X の書き込みが
//     W を上書きした (更新の消失)。
//   - W2 は待たされない (L のロックが残っていない)。
//   - 最後の表は、確定した書き込みを順に当てたものである。
// foundation-4 (517b674) のコードは、ロックを親に残し、分割の後の W は待たずに書き、L の COMMIT は、書いた行が動いたので競合で断られる
// (未解決の問題 37。test/open/locking-transaction-commit-after-split.test.ts)。分割の置き場所だけが分割しない置き場所と違う、という違いは、
// 既定の実行では数えて伏せ (masked)、OPEN=1 では伏せない。
import { split } from "../src/autoscaler";
import { Db } from "../src/client/db";
import { keyString } from "../src/keys";
import { ownerOf, regionsOf, SUBSLOTS, tokenOf } from "../src/routing";
import { errorOf, keyOf, PATIENCE_MS, show, txDriver, type Outcome } from "./placement-oracle";
import { asNumbers, prng, SimCluster } from "./sim";

const ROWS = 30;
const key = (id: number) => keyString([BigInt(id)]);
const token = (id: number) => tokenOf(key(id), key(id));
const GAP_MS = 5;

export type LockShape = "plain" | "slowPull" | "restart" | "idle";
type LStep =
  | { kind: "begin" }
  | { kind: "lockX" }
  | { kind: "splitStart" }
  | { kind: "splitEnd" }
  | { kind: "stmt"; sql: string; params: number[] }
  | { kind: "w"; name: "W" | "W2" }
  | { kind: "restart" }
  | { kind: "idle" }
  | { kind: "end"; commit: boolean };

export interface LockScript {
  seed: number;
  mode: "sql" | "baton";
  shape: LockShape;
  /** 分割しない置き場所のシャードの数。分割する置き場所は、同じ数から始めて、X の範囲を新しいシャードへ割る。 */
  shards: number;
  X: number;
  steps: LStep[];
}

export function makeLockScript(seed: number): LockScript {
  const r = prng(seed * 6007 + 29);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
  const shape = (["plain", "slowPull", "restart", "idle"] as const)[seed % 4]!;
  const mode = r() < 0.5 ? "sql" : "baton";
  const shards = 1 + Math.floor(r() * 2);
  const X = 1 + Math.floor(r() * ROWS);
  const ys = Array.from({ length: ROWS }, (_v, i) => i + 1).filter((id) => id !== X);
  const stmt = (): LStep => {
    const y = pick(ys);
    return r() < 0.5
      ? { kind: "stmt", sql: "SELECT v FROM a WHERE id = ?", params: [y] }
      : { kind: "stmt", sql: "UPDATE a SET v = v + 1 WHERE id = ?", params: [y] };
  };
  const steps: LStep[] = [{ kind: "begin" }];
  if (r() < 0.5) steps.push(stmt());
  steps.push({ kind: "lockX" });
  const end = (): LStep => ({ kind: "end", commit: r() < 0.6 });
  if (shape === "plain") {
    if (r() < 0.5) steps.push(stmt());
    steps.push({ kind: "splitStart" }, { kind: "splitEnd" });
    const n = 1 + Math.floor(r() * 3);
    const wAt = Math.floor(r() * (n + 1));
    for (let i = 0; i < n; i++) {
      if (i === wAt) steps.push({ kind: "w", name: "W" });
      steps.push(stmt());
    }
    if (wAt === n) steps.push({ kind: "w", name: "W" });
    steps.push(end());
  } else if (shape === "slowPull") {
    steps.push({ kind: "splitStart" });
    // 応答を止めている間に、文を出す (延長) か、ROLLBACK するか、両方。
    const during = r();
    if (during < 0.7) steps.push(stmt());
    const rollback = during >= 0.4;
    if (rollback) steps.push({ kind: "end", commit: false });
    steps.push({ kind: "splitEnd" });
    if (!rollback) {
      if (r() < 0.5) steps.push(stmt());
      steps.push({ kind: "w", name: "W" });
      if (r() < 0.5) steps.push(stmt());
      steps.push(end());
    } else {
      steps.push({ kind: "w", name: "W" });
    }
  } else if (shape === "restart") {
    if (r() < 0.5) steps.push(stmt());
    steps.push({ kind: "splitStart" }, { kind: "splitEnd" }, { kind: "restart" });
    if (r() < 0.5) steps.push(stmt());
    steps.push(end());
  } else {
    steps.push({ kind: "idle" }, { kind: "splitStart" }, { kind: "splitEnd" }, { kind: "w", name: "W" });
    if (r() < 0.5) steps.push(stmt());
    steps.push(end());
  }
  steps.push({ kind: "w", name: "W2" });
  return { seed, mode, shape, shards, X, steps };
}

export interface LockPlacement {
  name: string;
  shards: number;
  split: boolean;
}

export function lockPlacements(s: LockScript): LockPlacement[] {
  return [
    { name: "1 shard", shards: 1, split: false },
    { name: "2 shards", shards: 2, split: false },
    { name: `${s.shards} shard${s.shards > 1 ? "s" : ""}, X's range split`, shards: s.shards, split: true },
  ];
}

interface StepOut {
  outcome: Outcome;
  /** W と W2 が、PATIENCE_MS を過ぎても終わらなかった (基準経路だけの実行では、`row locked by` で断られた)。 */
  blocked?: boolean;
}

export interface LockTrace {
  placement: LockPlacement;
  results: (StepOut | undefined)[];
  final: number[][] | null;
  /** どの置き場所でも成り立たなければならないことの違反。 */
  problems: string[];
  /** 分割の置き場所で、L が X のロックを取ったシャードと、X の新しい持ち主。 */
  moved?: { from: string; to: string };
  /**
   * slowPull の台本で、pull の応答を止めている間の取引の文が、応答を待って終わらなかったので、応答を通してから終わるのを待った
   * (取引の文が、移動の終わりを待つ実装。止めたままにすると、どちらも進まない)。
   */
  waitedForPull?: boolean;
}

const lockedOut = (o: Outcome) => o.kind === "error" && /row locked by/.test(o.message);

export async function runLockPlacement(s: LockScript, p: LockPlacement): Promise<LockTrace> {
  const c = new SimCluster({ shards: p.shards, seed: s.seed });
  const trace: LockTrace = { placement: p, results: [], final: null, problems: [] };
  const work = (async () => {
    const admin = new Db(c);
    await admin.ddl("CREATE TABLE a(id INTEGER PRIMARY KEY, v INTEGER NOT NULL)");
    await admin.query(`INSERT INTO a VALUES ${Array.from({ length: ROWS }, (_v, i) => `(${i + 1}, ${(i + 1) * 10})`).join(", ")}`);
    await c.settle();
    await c.sleep(50);
    const L = txDriver(c, { mode: s.mode, immediate: false });
    const writer = new Db(c);
    const lockShard = ownerOf((await c.catalog()).routing, key(s.X));
    let lockedAt = 0;
    const pendings: { i: number; promise: Promise<Outcome> }[] = [];
    let splitting: Promise<unknown> | null = null;
    let releasePull: (() => void) | null = null;
    /** pull の応答を止めている間の文。PATIENCE_MS で終わらなければ、応答を通してから待つ。 */
    const duringHold = async (p: Promise<Outcome>): Promise<Outcome> => {
      if (!releasePull) return p;
      const raced = await Promise.race([p, c.sleep(PATIENCE_MS).then(() => null)]);
      if (raced !== null) return raced;
      releasePull();
      releasePull = null;
      trace.waitedForPull = true;
      return p;
    };
    for (const [i, step] of s.steps.entries()) {
      if (step.kind === "begin") trace.results[i] = { outcome: await L.begin() };
      else if (step.kind === "lockX") {
        trace.results[i] = { outcome: await L.exec("UPDATE a SET v = v + 1 WHERE id = ?", [s.X]) };
        lockedAt = c.time;
      } else if (step.kind === "stmt") trace.results[i] = { outcome: await duringHold(L.exec(step.sql, step.params)) };
      else if (step.kind === "end") {
        trace.results[i] = { outcome: await duringHold(step.commit ? L.commit() : L.rollback()) };
      } else if (step.kind === "idle") await c.sleep(3000);
      else if (step.kind === "restart") {
        if (p.split) c.restart(lockShard);
        else c.restart(ownerOf((await c.catalog()).routing, key(s.X)));
        await c.sleep(GAP_MS);
      } else if (step.kind === "splitStart") {
        if (!p.split) continue;
        const { routing } = await c.catalog();
        const parent = ownerOf(routing, key(s.X));
        const [region] = regionsOf(routing, parent).filter((x) => token(s.X) >= x.start && token(s.X) < x.end);
        // X の slot の境目で切り、X を含む後ろを新しいシャードへ動かす。X が区間の最初の slot にあれば、区間の全体を動かす。
        const cut = Math.max(region!.start, Math.floor(token(s.X) / SUBSLOTS) * SUBSLOTS);
        const child = `s${p.shards}`;
        trace.moved = { from: parent, to: child };
        if (s.shape === "slowPull") {
          let release!: () => void;
          const held = new Promise<void>((r) => (release = r));
          let holding = true;
          let caught = false;
          c.net.reply = (m) => {
            if (!holding || m.method !== "pull" || m.to !== parent) return undefined;
            caught = true;
            return held;
          };
          releasePull = () => {
            holding = false;
            release();
          };
          splitting = split(c, parent, child, { range: { start: cut, end: region!.end } }).catch((e: Error) => trace.problems.push(`the split failed: ${e.message}`));
          for (let k = 0; k < 400 && !caught; k++) await c.sleep(1);
          if (!caught) trace.problems.push("the pull's answer was never held");
        } else {
          await split(c, parent, child, { range: { start: cut, end: region!.end } });
        }
      } else if (step.kind === "splitEnd") {
        if (!p.split) continue;
        releasePull?.();
        releasePull = null;
        await splitting;
        splitting = null;
        c.net.reply = () => undefined;
      } else {
        // W は、idle の台本では、X のロックを取ってから 5 秒の少し後に出す (ロックの寿命が、運んだ先で延びていないか)。
        if (s.shape === "idle" && step.name === "W") await c.sleep(Math.max(0, lockedAt + 5100 - c.time));
        // W2 は、待たされている W が終わってから出す (同じ接続の文は、台本の順に効く。基準経路だけの実行では、W はロックに当たって
        // やり直し続け、後から出した W2 に追い越される)。
        if (step.name === "W2") for (const f of pendings.splice(0)) trace.results[f.i] = { outcome: await f.promise, blocked: true };
        const sql = step.name === "W" ? "UPDATE a SET v = v * 10 WHERE id = ?" : "UPDATE a SET v = v + 100 WHERE id = ?";
        const promise = writer.query(sql, [s.X]).then((r): Outcome => ({ kind: "rows", rows: asNumbers(r.values), changes: r.changes, last: null }), errorOf);
        const raced = await Promise.race([promise, c.sleep(PATIENCE_MS).then(() => null)]);
        if (raced !== null) trace.results[i] = { outcome: raced, blocked: lockedOut(raced) };
        else pendings.push({ i, promise });
      }
      await c.sleep(GAP_MS);
    }
    for (const f of pendings) {
      trace.results[f.i] = { outcome: await f.promise, blocked: true };
    }
    await c.settle();
    try {
      trace.final = asNumbers((await new Db(c).query("SELECT id, v FROM a ORDER BY id")).values) as number[][];
    } catch (e) {
      trace.problems.push(`reading the table failed: ${(e as Error).message}`);
    }
  })();
  await Promise.race([work, c.stalled(600_000, 3_000_000)]);
  check(s, trace);
  return trace;
}

/** どの置き場所でも成り立たなければならないこと (上の説明)。 */
function check(s: LockScript, t: LockTrace): void {
  const at = (k: LStep["kind"], name?: string) => s.steps.findIndex((x) => x.kind === k && (name === undefined || (x as { name?: string }).name === name));
  const endI = at("end");
  const end = t.results[endI]?.outcome;
  const committed = end?.kind === "rows" && (s.steps[endI] as { commit: boolean }).commit;
  const lockX = t.results[at("lockX")]?.outcome;
  const wI = at("w", "W");
  const w = wI >= 0 ? t.results[wI] : undefined;
  const w2 = t.results[at("w", "W2")];
  if (w2?.blocked) t.problems.push(`W2, after L ended, waited for a lock on X (${show(w2.outcome)})`);
  if (!t.final) return;
  // 最後の表。X は、L が確定したなら +1、W が成功したなら 10 倍、W2 が成功したなら +100。W は L が X のロックを取った後に出すので、
  // L が確定したなら、直列の順は L、W である (W が L より前に効いたなら、L は W を見ずに X を書いたので、L は確定してはならない)。
  // L の Y の書き込みは、確定したら +1。
  const want = new Map(Array.from({ length: ROWS }, (_v, i) => [i + 1, (i + 1) * 10]));
  const x0 = want.get(s.X)!;
  const lWrote = committed && lockX?.kind === "rows" && lockX.changes > 0;
  const wWrote = w?.outcome.kind === "rows" && w.outcome.changes > 0;
  const w2Wrote = w2?.outcome.kind === "rows" && w2.outcome.changes > 0;
  const x = ((lWrote ? x0 + 1 : x0) * (wWrote ? 10 : 1)) + (w2Wrote ? 100 : 0);
  const finalX = t.final.find((r) => r[0] === s.X)?.[1];
  if (lWrote && wWrote && finalX === x0 + 1 + (w2Wrote ? 100 : 0)) {
    t.problems.push(`L committed after W wrote X, and L's write of X overwrote W's (a lost update: W was not held by L's lock on X)`);
    return;
  }
  want.set(s.X, x);
  if (committed) {
    for (const [i, step] of s.steps.entries()) {
      if (step.kind !== "stmt" || !step.sql.startsWith("UPDATE")) continue;
      const o = t.results[i]?.outcome;
      if (o?.kind === "rows" && o.changes > 0) want.set(step.params[0]!, want.get(step.params[0]!)! + 1);
    }
  }
  const got = new Map(t.final.map(([id, v]) => [id!, v!]));
  for (const [id, v] of want) if (got.get(id) !== v) t.problems.push(`row ${id} is ${got.get(id)}, expected ${v} from the outcomes`);
}

export interface LockReport {
  divergences: string[];
  /** 分割の置き場所だけが違い、既知の未解決の欠陥として伏せたもの。 */
  masked: number;
  traces: LockTrace[];
}

/** seed の台本を全部の置き場所で流して比べる。mask なら、分割の置き場所だけの違いを伏せて数える。 */
export async function checkLockSeed(seed: number, o: { mask: boolean }): Promise<LockReport> {
  const s = makeLockScript(seed);
  const traces: LockTrace[] = [];
  for (const p of lockPlacements(s)) traces.push(await runLockPlacement(s, p));
  const label = `seed ${seed} (${s.mode}, ${s.shape}, X ${s.X})`;
  const divergences: string[] = [];
  for (const t of traces) for (const x of t.problems) divergences.push(`${label}, ${t.placement.name}: ${x}`);
  let masked = 0;
  const [unsplit1, unsplit2, splitTrace] = traces as [LockTrace, LockTrace, LockTrace];
  const sig = (r: StepOut | undefined) => (r === undefined ? "(not run)" : `${keyOf(r.outcome)}${r.blocked ? " blocked" : ""}`);
  for (const [i, step] of s.steps.entries()) {
    const a = sig(unsplit1.results[i]);
    const b = sig(unsplit2.results[i]);
    const c = sig(splitTrace.results[i]);
    const what = `${label}, step ${i} ${step.kind}${"name" in step ? ` ${step.name}` : ""}${"sql" in step ? ` ${step.sql} ${JSON.stringify(step.params)}` : ""}`;
    if (a !== b) divergences.push(`${what}: 1 shard ${a}, 2 shards ${b}`);
    else if (c !== a) {
      if (o.mask) masked++;
      else divergences.push(`${what}: without a split ${a}, with X's range split ${c}`);
    }
  }
  const fin = (t: LockTrace) => JSON.stringify(t.final);
  if (fin(unsplit1) !== fin(unsplit2)) divergences.push(`${label}: the final tables differ between 1 and 2 shards`);
  else if (fin(splitTrace) !== fin(unsplit1) && !o.mask) divergences.push(`${label}: the final table differs with X's range split`);
  return { divergences, masked, traces };
}
