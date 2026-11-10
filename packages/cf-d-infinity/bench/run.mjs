// デプロイ済み Worker へ負荷をかける。各 POST /bench が Worker の中で concurrency 本のループを回す。
// 計測用の Worker (wrangler.bench.jsonc) を相手にする。/bench と /admin は ADMIN_TOKEN、それ以外は TOKEN で認証する。
// 使い方: URL=... TOKEN=... ADMIN_TOKEN=... node bench/run.mjs <suite>
const { URL: base, TOKEN: token, ADMIN_TOKEN: adminToken } = process.env;
const post = async (path, body) => {
  const auth = path === "/bench" || path.startsWith("/admin/") ? adminToken : token;
  const r = await fetch(base + path, {
    method: "POST", headers: { authorization: `Bearer ${auth}` }, body: JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${r.status} ${text.slice(0, 200)}`);
  return JSON.parse(text);
};
const pct = (b, p) => {
  const e = Object.entries(b).map(([k, v]) => [Number(k), v]).sort((x, y) => x[0] - y[0]);
  const n = e.reduce((s, [, v]) => s + v, 0);
  let acc = 0;
  for (const [k, v] of e) if ((acc += v) >= n * p) return k;
  return null;
};
export async function load({ op, shards, tenants, clients, concurrency = 6, durationMs = 6000, cluster, ratePerSec }) {
  const t0 = Date.now();
  const parts = await Promise.allSettled(Array.from({ length: clients }, () =>
    post("/bench", { op, cluster, shards, tenants, concurrency, durationMs, ratePerSec: ratePerSec && ratePerSec / clients })));
  const wall = (Date.now() - t0) / 1000;
  const ok = parts.filter((p) => p.status === "fulfilled").map((p) => p.value);
  const buckets = {}, failures = {}, colos = new Set();
  let count = 0, skipped = 0;
  for (const p of ok) {
    count += p.count;
    skipped += p.skipped ?? 0;
    colos.add(p.colo);
    for (const [k, v] of Object.entries(p.buckets)) buckets[k] = (buckets[k] ?? 0) + v;
    for (const [k, v] of Object.entries(p.failures)) failures[k] = (failures[k] ?? 0) + v;
  }
  const rejected = parts.filter((p) => p.status === "rejected").map((p) => String(p.reason).slice(0, 120));
  return {
    op, shards, clients, concurrency, count, perSec: Math.round(count / (durationMs / 1000)), wall,
    p50: pct(buckets, 0.5), p99: pct(buckets, 0.99), failures, skipped, rejected: rejected.length,
    rejectedSample: rejected[0], colos: [...colos],
  };
}
export async function seed(shards, tenants, cluster) {
  const per = Math.ceil(tenants / 16);
  await Promise.all(Array.from({ length: 16 }, (_, i) => post("/bench", {
    op: "seed", cluster, shards, tenants, concurrency: 1, durationMs: 0,
    from: i * per + 1, to: Math.min((i + 1) * per, tenants),
  })));
}
export { post };
