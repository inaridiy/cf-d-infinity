import { writeFileSync, mkdirSync } from "node:fs";
import { load, post, seed } from "./run.mjs";

const out = { at: new Date().toISOString(), probes: {}, ceiling: [], fanin: [], scale: [], txn: [], hot: [] };
const save = () => { mkdirSync("bench/results", { recursive: true }); writeFileSync("bench/results/latest.json", JSON.stringify(out, null, 1)); };
const log = (r) => console.log(`${r.op.padEnd(9)} shards=${String(r.shards).padEnd(3)} clients=${String(r.clients).padEnd(3)} c=${r.concurrency} ${String(r.perSec).padStart(7)}/s p50=${r.p50} p99=${r.p99} fail=${JSON.stringify(r.failures).slice(0, 110)} rej=${r.rejected} ${r.colos}`);
const run = async (cfg) => {
  await load({ ...cfg, durationMs: 1000, clients: Math.min(cfg.clients, 8) }); // DO を起こす
  const r = await load(cfg);
  log(r);
  return r;
};
const stat = (a) => { const s = [...a].sort((x, y) => x - y); return { n: s.length, p50: s[Math.floor(s.length / 2)], p90: s[Math.floor(s.length * 0.9)], max: s.at(-1) }; };

// 1. 確定レイテンシ、DO 間 RTT、時計のずれ
await seed(8, 512);
const sync = await post("/bench", { op: "sync", shards: 8, tenants: 1, concurrency: 1, durationMs: 0, times: 60 });
const peer = await post("/bench", { op: "peer", shards: 8, tenants: 1, concurrency: 1, durationMs: 0, times: 60 });
out.probes.sync = stat(sync.samples);
out.probes.peer = stat(peer.samples);
const clocks = [];
for (let i = 0; i < 5; i++) clocks.push((await post("/bench", { op: "clock", shards: 8, tenants: 1, concurrency: 1, durationMs: 0 })).samples);
const spread = clocks.map((c) => { const o = c.map((x) => x.offset); return Math.max(...o) - Math.min(...o); });
out.probes.clockSpreadMs = stat(spread);
out.probes.clockRtt = stat(clocks.flat().map((x) => x.rtt));
console.log("probes", JSON.stringify(out.probes));
save();

// 2. シャード 1 個の上限。素の DO とプロトコルを比べる
await seed(1, 64);
for (const op of ["ping", "rawRead", "rawWrite", "read", "write"]) {
  for (const clients of [4, 16, 48]) {
    out.ceiling.push(await run({ op, shards: 1, tenants: 64, clients, concurrency: 6, durationMs: 5000 }));
    save();
  }
}

// 3. 1 invocation の並列度。6 接続の制限が DO RPC に効くか
for (const concurrency of [2, 6, 12, 24, 48]) {
  out.fanin.push(await run({ op: "ping", shards: 16, tenants: 1, clients: 2, concurrency, durationMs: 4000 }));
  save();
}

// 4. スケーリング
for (const shards of [1, 2, 4, 8, 16, 32, 64]) {
  const tenants = shards * 64;
  await seed(shards, tenants).catch((e) => console.log("seed", String(e).slice(0, 100)));
  const clients = Math.min(240, Math.max(8, shards * 6));
  for (const op of ["read", "write"]) {
    out.scale.push(await run({ op, shards, tenants, clients, concurrency: 6, durationMs: 6000 }));
    save();
  }
}

// 5. 取引
for (const shards of [8, 32]) {
  const tenants = shards * 64;
  for (const op of ["txn1", "txn2"]) {
    out.txn.push(await run({ op, shards, tenants, clients: Math.min(240, shards * 6), concurrency: 4, durationMs: 6000 }));
    save();
  }
}

// 6. ホットな 1 行
for (const clients of [2, 8, 24]) {
  out.hot.push(await run({ op: "hot", shards: 8, tenants: 512, clients, concurrency: 4, durationMs: 5000 }));
  save();
}
console.log("done");
