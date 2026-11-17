// 本物の workerd (Miniflare) で、Durable Object の instance が再起動したとき、その instance に届いていた RPC がどうなるかを確かめる。
// シミュレータの再起動 (test/sim.ts の SimCluster.restart) は、これに合わせる。
//
// 確かめること。DO の中で、メモリの Promise を待っている要求 (行ロックの待ちと同じ形。タイマーで起きる) があるときに、同じ instance を
//   1. ctx.abort() で止める (DO の再起動を、コードから起こす公式の手段)、
//   2. 待ちの間に、別の要求が例外で instance を壊す (blockConcurrencyWhile の中で投げると、instance は捨てられる)、
// とき、
//   a. 待っていた要求の呼び出し側は、いつ、どんな誤りを受け取るか (待ちが終わるまで待たされるか)、
//   b. 古い instance の待ちの続き (タイマーの後のコード) は走るか。走るなら、保存に書けるか、ほかの DO へ RPC を送れるか。
import { Miniflare } from "miniflare";
import { afterAll, describe, expect, it } from "vitest";

const SCRIPT = `
import { DurableObject } from "cloudflare:workers";

export class Probe extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS log(at INTEGER, what TEXT)");
    this.born = Date.now();
  }
  // 行ロックの待ちと同じ形の要求。メモリの Promise を、タイマーが解く。起きた後で、保存に書き、別の DO へ知らせる。
  async hold(ms, tag) {
    this.ctx.storage.sql.exec("INSERT INTO log VALUES (?, ?)", Date.now(), "start " + tag);
    await new Promise((r) => setTimeout(r, ms));
    let wrote = "yes";
    try {
      this.ctx.storage.sql.exec("INSERT INTO log VALUES (?, ?)", Date.now(), "after " + tag);
    } catch (e) {
      wrote = "threw: " + (e && e.message);
    }
    let told = "yes";
    try {
      await this.env.WITNESS.get(this.env.WITNESS.idFromName("w")).note("continued " + tag + " wrote=" + wrote);
    } catch (e) {
      told = "threw: " + (e && e.message);
    }
    return { tag, wrote, told, born: this.born };
  }
  async kill(how) {
    if (how === "abort") this.ctx.abort(new Error("probe abort"));
    if (how === "throw") await this.ctx.blockConcurrencyWhile(async () => { throw new Error("probe broke the instance"); });
    return "not reached";
  }
  async log() {
    return { born: this.born, rows: this.ctx.storage.sql.exec("SELECT at, what FROM log ORDER BY at").toArray() };
  }
}

export class Witness extends DurableObject {
  notes = [];
  async note(s) { this.notes.push(s); }
  async read() { return this.notes; }
}

export default {
  async fetch(req, env) {
    const u = new URL(req.url);
    const stub = env.PROBE.get(env.PROBE.idFromName(u.searchParams.get("name") ?? "p"));
    const t0 = Date.now();
    try {
      let out;
      if (u.pathname === "/hold") out = await stub.hold(Number(u.searchParams.get("ms")), u.searchParams.get("tag"));
      else if (u.pathname === "/kill") out = await stub.kill(u.searchParams.get("how"));
      else if (u.pathname === "/log") out = await stub.log();
      else if (u.pathname === "/witness") out = await env.WITNESS.get(env.WITNESS.idFromName("w")).read();
      return Response.json({ ok: out, ms: Date.now() - t0 });
    } catch (e) {
      return Response.json({ error: String(e && e.message), ms: Date.now() - t0 });
    }
  },
};
`;

const instances: Miniflare[] = [];
afterAll(async () => {
  for (const mf of instances) await mf.dispose();
});
function worker(): Miniflare {
  const mf = new Miniflare({
    modules: true,
    script: SCRIPT,
    compatibilityDate: "2026-07-01",
    durableObjects: { PROBE: { className: "Probe", useSQLite: true }, WITNESS: { className: "Witness", useSQLite: true } },
  });
  instances.push(mf);
  return mf;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const get = async (mf: Miniflare, path: string) => (await mf.dispatchFetch(`http://x${path}`)).json() as Promise<{ ok?: any; error?: string; ms: number }>;

describe("a Durable Object instance that restarts while a request waits inside it", () => {
  for (const how of ["abort", "throw"] as const) {
    it(`${how}: fails the waiting request at once, and the old instance's continuation does not write or send`, async () => {
      const mf = worker();
      const name = `p-${how}`;
      expect((await get(mf, `/log?name=${name}`)).ok.rows).toEqual([]);
      const held = get(mf, `/hold?name=${name}&ms=3000&tag=${how}`);
      await sleep(300);
      const killed = await get(mf, `/kill?name=${name}&how=${how}`);
      const waited = await held;
      console.info(`RESTART PROBE ${how}: kill -> ${JSON.stringify(killed)}; held -> ${JSON.stringify(waited)}`);
      // 待っていた要求は、待ちの期限 (3 秒) を待たずに失敗する。
      expect(waited.error).toBeDefined();
      expect(waited.ms).toBeLessThan(2000);
      // 古い instance のタイマーの後を待ってから、新しい instance と、知らせを受ける DO を読む。
      await sleep(3500);
      const after = await get(mf, `/log?name=${name}`);
      const witness = await get(mf, `/witness`);
      console.info(`RESTART PROBE ${how}: log -> ${JSON.stringify(after.ok)}; witness -> ${JSON.stringify(witness.ok)}`);
      expect(after.ok.rows.map((r: { what: string }) => r.what)).toEqual([`start ${how}`]);
      expect(witness.ok).toEqual([]);
    }, 30_000);
  }
});
