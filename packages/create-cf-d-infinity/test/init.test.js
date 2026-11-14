import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "jsonc-parser";
import { Conflict, apply, plan } from "../src/init.js";

const dir = (files = {}) => {
  const d = mkdtempSync(join(tmpdir(), "dinf-init-"));
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(d, name, ".."), { recursive: true });
    writeFileSync(join(d, name), content);
  }
  return d;
};
const read = (d, f) => readFileSync(join(d, f), "utf8");
const run = (d, opts) => {
  const r = plan(d, opts);
  apply(r);
  return r;
};

const EXISTING = `{
  // my app
  "name": "my-app",
  "main": "src/index.ts", // entry
  "compatibility_date": "2026-07-01",
  "kv_namespaces": [{ "binding": "CACHE", "id": "abc" }],
  /* keep me */
  "vars": { "GREETING": "hi" },
}
`;
const APP = {
  "wrangler.jsonc": EXISTING,
  "package.json": `{\n  "name": "my-app",\n  "dependencies": {\n    "hono": "^4.0.0"\n  }\n}\n`,
  "src/index.ts": `export default { fetch: () => new Response("hi") };\n`,
};

test("adds everything to an existing Worker and keeps its comments and other settings", () => {
  const d = dir(APP);
  const r = run(d);
  const text = read(d, "wrangler.jsonc");
  for (const comment of ["// my app", "// entry", "/* keep me */"]) assert.ok(text.includes(comment), comment);
  const c = parse(text);
  assert.deepEqual(c.durable_objects.bindings, [
    { name: "DINF_SHARD", class_name: "DinfShard" },
    { name: "DINF_META", class_name: "DinfMeta" },
    { name: "DINF_AUTOSCALER", class_name: "DinfAutoscaler" },
  ]);
  assert.deepEqual(c.migrations, [{ tag: "cf-d-infinity-v1", new_sqlite_classes: ["DinfShard", "DinfMeta", "DinfAutoscaler"] }]);
  assert.deepEqual(c.services, [{ binding: "DINF_DB", service: "my-app", entrypoint: "DinfDatabase" }]);
  assert.deepEqual(c.vars, { GREETING: "hi", DINF_SHARD_COUNT: "8" });
  assert.deepEqual(c.triggers, { crons: ["* * * * *"] });
  assert.deepEqual(c.kv_namespaces, [{ binding: "CACHE", id: "abc" }]);

  assert.match(read(d, "src/dinf.ts"), /export \{ DinfAutoscaler, DinfDatabase, DinfMeta, DinfShard, autoscale \} from "cf-d-infinity\/cloudflare";/);
  const main = read(d, "src/index.ts");
  assert.ok(main.startsWith(APP["src/index.ts"]), "the user's code is untouched above the appended line");
  assert.match(main, /export \{ DinfAutoscaler, DinfDatabase, DinfMeta, DinfShard \} from "\.\/dinf";/);
  assert.deepEqual(JSON.parse(read(d, "package.json")).dependencies, { hono: "^4.0.0", "cf-d-infinity": "^0.1.0-alpha.0" });
  assert.ok(r.next.some((n) => n.includes("scheduled")), "tells the user to wire the scheduled handler");
});

test("a second run changes nothing", () => {
  const d = dir(APP);
  run(d);
  const before = Object.fromEntries(["wrangler.jsonc", "package.json", "src/index.ts", "src/dinf.ts"].map((f) => [f, read(d, f)]));
  const again = run(d);
  assert.equal(again.writes.length, 0);
  for (const [f, text] of Object.entries(before)) assert.equal(read(d, f), text, f);
});

test("appends to existing bindings, migrations, services and crons instead of replacing them", () => {
  const d = dir({
    ...APP,
    "wrangler.jsonc": `{
  "name": "my-app",
  "main": "src/index.ts",
  "durable_objects": { "bindings": [{ "name": "ROOM", "class_name": "Room" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["Room"] }],
  "services": [{ "binding": "AUTH", "service": "auth" }],
  "triggers": { "crons": ["0 * * * *"] }
}
`,
  });
  run(d);
  const c = parse(read(d, "wrangler.jsonc"));
  assert.deepEqual(c.durable_objects.bindings.map((b) => b.name), ["ROOM", "DINF_SHARD", "DINF_META", "DINF_AUTOSCALER"]);
  assert.deepEqual(c.migrations.map((m) => m.tag), ["v1", "cf-d-infinity-v1"]);
  assert.deepEqual(c.services.map((s) => s.binding), ["AUTH", "DINF_DB"]);
  assert.deepEqual(c.triggers.crons, ["0 * * * *", "* * * * *"]);
});

// Durable Object のクラスの宣言には `migrations` と `exports` の 2 通りがある。`exports` の Durable Object の項目と
// `migrations` は、同じ Worker の設定に両方は書けない (Cloudflare が検証で拒む)。Workflow の項目は両立する。
// 出典 (2026-11-14 に確認): https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/
const LIVE = { type: "durable-object", storage: "sqlite" };
const USES_EXPORTS = `{
  // my app
  "name": "my-app",
  "main": "src/index.ts",
  "durable_objects": { "bindings": [{ "name": "ROOM", "class_name": "Room" }] },
  "exports": {
    // the chat room
    "Room": { "type": "durable-object", "storage": "sqlite" }, // live
    /* retired */
    "OldRoom": { "type": "durable-object", "state": "deleted" },
    "Mailer": { "type": "workflow", "name": "mailer" },
  },
}
`;

test("declares the classes in exports, and adds no migration, when the configuration declares Durable Object classes with exports", () => {
  const d = dir({ ...APP, "wrangler.jsonc": USES_EXPORTS });
  const r = run(d);
  const text = read(d, "wrangler.jsonc");
  for (const comment of ["// my app", "// the chat room", "// live", "/* retired */"]) assert.ok(text.includes(comment), comment);
  const c = parse(text);
  assert.equal(c.migrations, undefined, "a migration next to Durable Object exports is rejected by Cloudflare");
  assert.deepEqual(c.exports, {
    Room: LIVE,
    OldRoom: { type: "durable-object", state: "deleted" },
    Mailer: { type: "workflow", name: "mailer" },
    DinfShard: LIVE, DinfMeta: LIVE, DinfAutoscaler: LIVE,
  });
  assert.deepEqual(c.durable_objects.bindings.map((b) => b.name), ["ROOM", "DINF_SHARD", "DINF_META", "DINF_AUTOSCALER"]);
  assert.deepEqual(c.services, [{ binding: "DINF_DB", service: "my-app", entrypoint: "DinfDatabase" }]);
  assert.ok(r.done.some((line) => line.includes("exports") && line.includes("DinfAutoscaler")), "reports the exports entries");
  assert.ok(!r.done.some((line) => line.includes("migration cf-d-infinity-v1")), "reports no migration");

  // 2 回目は何も変えない。
  const again = run(d);
  assert.equal(again.writes.length, 0);
  assert.equal(read(d, "wrangler.jsonc"), text);
  assert.ok(again.kept.some((line) => line.includes("exports")));
});

test("adds only the classes that exports does not declare yet", () => {
  const d = dir({ ...APP, "wrangler.jsonc": `{\n  "name": "my-app",\n  "main": "src/index.ts",\n  "exports": {\n    "DinfShard": { "type": "durable-object", "state": "created", "storage": "sqlite" }\n  }\n}\n` });
  run(d);
  const c = parse(read(d, "wrangler.jsonc"));
  assert.equal(c.migrations, undefined);
  assert.deepEqual(c.exports, { DinfShard: { type: "durable-object", state: "created", storage: "sqlite" }, DinfMeta: LIVE, DinfAutoscaler: LIVE });
});

test("still adds the migration when exports holds only Workflow entries", () => {
  // Workflow の項目は `migrations` と一緒に書ける。旧来の書き方のままにする。
  const d = dir({ ...APP, "wrangler.jsonc": `{\n  "name": "my-app",\n  "main": "src/index.ts",\n  "exports": { "Mailer": { "type": "workflow", "name": "mailer" } }\n}\n` });
  run(d);
  const c = parse(read(d, "wrangler.jsonc"));
  assert.deepEqual(c.migrations, [{ tag: "cf-d-infinity-v1", new_sqlite_classes: ["DinfShard", "DinfMeta", "DinfAutoscaler"] }]);
  assert.deepEqual(c.exports, { Mailer: { type: "workflow", name: "mailer" } });
});

test("follows exports when only an environment declares Durable Object classes with it", () => {
  // `migrations` は環境に継承されるので、最上位に足すと、`exports` を使う環境の設定が両方を持つことになる。
  const d = dir({ ...APP, "wrangler.jsonc": `{\n  "name": "my-app",\n  "main": "src/index.ts",\n  "env": {\n    "staging": { "exports": { "Room": { "type": "durable-object", "storage": "sqlite" } } }\n  }\n}\n` });
  run(d);
  const c = parse(read(d, "wrangler.jsonc"));
  assert.equal(c.migrations, undefined);
  assert.deepEqual(c.exports, { DinfShard: LIVE, DinfMeta: LIVE, DinfAutoscaler: LIVE });
  assert.deepEqual(c.env, { staging: { exports: { Room: LIVE } } });
});

test("refuses on a conflict and writes nothing at all", () => {
  const cases = {
    "a Durable Object binding with our name and another class": `"durable_objects": { "bindings": [{ "name": "DINF_META", "class_name": "Other" }] }`,
    "the binding name taken by D1": `"d1_databases": [{ "binding": "DINF_DB", "database_id": "x" }]`,
    "a Service Binding with our name pointing elsewhere": `"services": [{ "binding": "DINF_DB", "service": "other" }]`,
    "a migration that declares only some of the classes": `"migrations": [{ "tag": "v1", "new_sqlite_classes": ["DinfShard"] }]`,
    "Durable Object exports and migrations together": `"exports": { "Room": { "type": "durable-object", "storage": "sqlite" } },\n  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["Room"] }]`,
    "Durable Object exports in an environment and migrations at the top level": `"migrations": [{ "tag": "v1", "new_sqlite_classes": ["Room"] }],\n  "env": { "staging": { "exports": { "Room": { "type": "durable-object", "storage": "sqlite" } } } }`,
    "a tombstone for one of our classes in exports": `"exports": { "Room": { "type": "durable-object", "storage": "sqlite" }, "DinfMeta": { "type": "durable-object", "state": "deleted" } }`,
    "one of our classes on the key-value backend in exports": `"exports": { "DinfShard": { "type": "durable-object", "storage": "legacy-kv" } }`,
    "one of our class names used by a Workflow in exports": `"exports": { "DinfShard": { "type": "workflow", "name": "shard" } }`,
    "exports that is not an object": `"exports": ["Room"]`,
  };
  for (const [name, fragment] of Object.entries(cases)) {
    const files = { ...APP, "wrangler.jsonc": `{\n  "name": "my-app",\n  "main": "src/index.ts",\n  ${fragment}\n}\n` };
    const d = dir(files);
    assert.throws(() => run(d), Conflict, name);
    for (const [f, text] of Object.entries(files)) assert.equal(read(d, f), text, `${name}: ${f}`);
    assert.deepEqual(readdirSync(join(d, "src")), ["index.ts"], name);
  }
});

test("takes another binding name with --binding", () => {
  const d = dir({ ...APP, "wrangler.jsonc": `{\n  "name": "my-app",\n  "main": "src/index.ts",\n  "d1_databases": [{ "binding": "DINF_DB", "database_id": "x" }]\n}\n` });
  const r = run(d, { binding: "BIG_DB" });
  assert.deepEqual(parse(read(d, "wrangler.jsonc")).services, [{ binding: "BIG_DB", service: "my-app", entrypoint: "DinfDatabase" }]);
  assert.ok(r.next.some((n) => n.includes("env.BIG_DB")));
});

test("leaves the Cron Trigger out with autoscale off, and refuses wrangler.toml and broken JSON", () => {
  const d = dir(APP);
  run(d, { autoscale: false });
  assert.equal(parse(read(d, "wrangler.jsonc")).triggers, undefined);
  assert.throws(() => plan(dir({ "wrangler.toml": `name = "x"\n` })), /wrangler\.toml/);
  assert.throws(() => plan(dir({ "wrangler.jsonc": `{ "name": ` })), /not valid JSON/);
  assert.throws(() => plan(dir({ "wrangler.jsonc": `{ "main": "src/index.ts" }` })), /no "name"/);
});

test("creates a database Worker in an empty directory, and refuses to overwrite files there", () => {
  const d = dir();
  run(d, { name: "My DB!" });
  const c = parse(read(d, "wrangler.jsonc"));
  assert.equal(c.name, "my-db");
  assert.equal(c.workers_dev, false);
  assert.deepEqual(c.triggers, { crons: ["* * * * *"] });
  assert.deepEqual(c.durable_objects.bindings.map((b) => b.class_name), ["DinfShard", "DinfMeta", "DinfAutoscaler"]);
  assert.match(read(d, "src/index.ts"), /export \{ default \} from "cf-d-infinity\/cloudflare";/);
  assert.match(read(d, ".dev.vars"), /DINF_API_TOKEN=dev-only-token/);
  assert.equal(JSON.parse(read(d, "package.json")).dependencies["cf-d-infinity"], "^0.1.0-alpha.0");
  // 2 回目は wrangler.jsonc があるので、既存のプロジェクトとして扱う。binding を足すだけで、作ったファイルは壊さない。
  const before = read(d, "src/index.ts");
  run(d);
  assert.equal(read(d, "src/index.ts"), before);

  const taken = dir({ "package.json": "{}" });
  assert.throws(() => plan(taken), /already exist: package\.json/);
});

test("in a cf project it leaves cloudflare.config.ts alone, prepares the code, and prints the configuration to add", () => {
  const CONFIG = `import { bindings, defineConfig } from "cf/config";
import * as entrypoint from "./src/worker.ts" with { type: "cf-worker" };

export default defineConfig({
\tworker: { name: "shop", compatibilityDate: "2026-11-04", entrypoint, env: { WORLD: bindings.text("World") } },
});
`;
  const files = { ...APP, "cloudflare.config.ts": CONFIG, "src/worker.ts": APP["src/index.ts"] };
  delete files["wrangler.jsonc"];
  delete files["src/index.ts"];
  const d = dir(files);
  const r = run(d);
  assert.equal(r.mode, "cf");
  assert.equal(read(d, "cloudflare.config.ts"), CONFIG);
  assert.match(read(d, "src/dinf.ts"), /from "cf-d-infinity\/cloudflare"/);
  assert.match(read(d, "src/worker.ts"), /export \{ DinfAutoscaler, DinfDatabase, DinfMeta, DinfShard \} from "\.\/dinf";/);
  assert.equal(JSON.parse(read(d, "package.json")).dependencies["cf-d-infinity"], "^0.1.0-alpha.0");
  const snippet = r.next.find((n) => n.includes("exports.durableObject"));
  assert.match(snippet, /DINF_DB: bindings\.worker\(\{ worker: "shop", exportName: "DinfDatabase" \}\)/);
  assert.match(snippet, /DinfMeta: exports\.durableObject\(\{ storage: "sqlite" \}\)/);
  assert.match(snippet, /triggers\.scheduled\(\{ schedule: "\* \* \* \* \*" \}\)/);
  assert.ok(r.next.some((n) => n.includes("npx cf dev")));

  // 設定に足し終えた後の 2 回目は、何も書かず、足す内容も出さない。
  writeFileSync(join(d, "cloudflare.config.ts"), CONFIG.replace("env: {", "exports: { DinfShard: 1 }, env: {"));
  const again = run(d);
  assert.equal(again.writes.length, 0);
  assert.ok(!again.next.some((n) => n.includes("exports.durableObject")));
});

test("the command line prints the plan, exits non-zero on a conflict, and supports --dry-run", () => {
  const bin = new URL("../bin.js", import.meta.url).pathname;
  const d = dir(APP);
  const dry = execFileSync("node", [bin, "init", "--dry-run"], { cwd: d, encoding: "utf8" });
  assert.match(dry, /dry run: nothing was written/);
  assert.equal(read(d, "wrangler.jsonc"), EXISTING);
  const out = execFileSync("node", [bin], { cwd: d, encoding: "utf8" });
  assert.match(out, /Added cf-d-infinity to this Worker/);
  assert.match(execFileSync("node", [bin], { cwd: d, encoding: "utf8" }), /Nothing to change/);
  const bad = spawnSync("node", [bin, "--shards", "0"], { cwd: d, encoding: "utf8" });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /Nothing was written/);
});
