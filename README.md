# D∞ (cf-d-infinity)

[![npm version](https://img.shields.io/npm/v/cf-d-infinity/alpha.svg?color=007acc)](https://www.npmjs.com/package/cf-d-infinity)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)

**An unofficial, experimental, horizontally scalable SQLite database with real transactions, running entirely on Workers and Durable Objects in your own Cloudflare account.**

Read the name as "D-infinity": the D1 API your Worker already speaks, without the single-database ceiling. Add it to a Worker with one command; the Worker plans each statement, the shards are Durable Objects holding ordinary SQLite, and there is no server to run.

> **Status: experimental.** A research prototype. Do not put data you cannot afford to lose in it; read [Limitations](#limitations) first.

## Key features

- **Interactive transactions, across shards.** `BEGIN`, read, decide, write, `COMMIT`, serializable by default, with no central timestamp oracle. D1 offers `batch()` only.
- **Works with the SQLite clients you have.** `@libsql/client` over HTTP or WebSocket, Drizzle, and a D1-compatible API. You change the URL.
- **Scales past one database.** Tables are spread over up to 4,096 hash slots, and a shard can be split online. The autoscaler watches every shard and, once you opt in with `DINF_AUTOSCALE = "split"`, splits hot or large ones itself. One shard takes ~950 single-shard writes/s; 64 shards reached 18,784 writes/s. Transactions that span shards are far slower: about 44–60 per second per shard (see [When not to use it](#when-not-to-use-it)).
- **SQLite semantics, not a reimplementation.** Each shard is SQLite, and cross-shard statements re-run the original SQL in a WebAssembly SQLite inside the Worker. All 8,884 queries of sqllogictest `select1`–`select5` match.
- **Pay per row, no instance to size.** Durable Object pricing: 2 billed rows per single-row `UPDATE`, $0.20 per GB-month. When nothing is happening, the only activity is the autoscaler waking each shard once a minute.
- **Checked, not only claimed.** Eleven formal models, a fault-injecting simulator, and Elle-style black-box checks against production Cloudflare while Durable Objects crash and shards split.

## Quick start

Run `init` in a Workers project, the directory that holds your `wrangler.jsonc`. (For a project that uses the [`cf` CLI](https://developers.cloudflare.com/cf/) and `cloudflare.config.ts`, see [Wrangler and cf](#wrangler-and-cf).) The database becomes part of that Worker: its configuration lives in `wrangler.jsonc`, its version in `package.json`, and one `wrangler dev` runs both. You need Node 20 or later; local development needs no Cloudflare account.

```sh
npx create-cf-d-infinity@alpha init    # edits wrangler.jsonc and package.json, writes src/dinf.ts
npm install
npx wrangler dev
```

`init` adds three Durable Object classes, their migration, a Service Binding that points back at this Worker's `DinfDatabase` entrypoint, and a one-minute Cron Trigger that wakes the autoscaler. Comments in the file are kept, nothing is written if a name is already taken, and a second run changes nothing. It appends one line to your main module that re-exports the classes; the only change left to you is the `scheduled` line shown below.

```jsonc
// wrangler.jsonc (added by init; "my-app" is this Worker's own name)
"durable_objects": { "bindings": [
  { "name": "DINF_SHARD", "class_name": "DinfShard" },
  { "name": "DINF_META", "class_name": "DinfMeta" },
  { "name": "DINF_AUTOSCALER", "class_name": "DinfAutoscaler" }
] },
"migrations": [{ "tag": "cf-d-infinity-v1", "new_sqlite_classes": ["DinfShard", "DinfMeta", "DinfAutoscaler"] }],
"services": [{ "binding": "DINF_DB", "service": "my-app", "entrypoint": "DinfDatabase" }],
"vars": { "DINF_SHARD_COUNT": "8" },
"triggers": { "crons": ["* * * * *"] }    // the autoscaler watches the shards; add "DINF_AUTOSCALE": "split" to vars to let it split them
```

Use it through the binding. The binding is the credential; no token crosses it.

```ts
import { autoscale, connect } from "./dinf";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const db = connect(env.DINF_DB);     // D1-compatible: prepare, bind, batch, first, all, run, raw

    await db.prepare("CREATE TABLE IF NOT EXISTS accounts(id INTEGER PRIMARY KEY, balance INTEGER NOT NULL)").run();
    await db.batch([
      db.prepare("INSERT OR REPLACE INTO accounts(id, balance) VALUES (?, ?)").bind(1, 100),
      db.prepare("INSERT OR REPLACE INTO accounts(id, balance) VALUES (?, ?)").bind(2, 100),
    ]);

    const tx = await db.begin();         // BEGIN IMMEDIATE; the two rows live on different shards
    try {
      const { rows } = await tx.execute("SELECT balance FROM accounts WHERE id = ?", [1]);
      if (Number(rows[0]!.balance) < 30) throw new Error("insufficient funds");
      await tx.execute("UPDATE accounts SET balance = balance - 30 WHERE id = 1");
      await tx.execute("UPDATE accounts SET balance = balance + 30 WHERE id = 2");
      await tx.commit();                 // two-phase commit across both shards
    } catch (e) {
      await tx.rollback();
      throw e;
    }
    return Response.json((await db.prepare("SELECT id, balance FROM accounts ORDER BY id").all()).results);
  },
  scheduled: (_controller: ScheduledController, env: Env) => autoscale(env),   // called by the Cron Trigger
};

// Added by create-cf-d-infinity: wrangler.jsonc refers to these classes by name.
export { DinfAutoscaler, DinfDatabase, DinfMeta, DinfShard } from "./dinf";
```

Open <http://localhost:8787>: it returns `[{"id":1,"balance":70},{"id":2,"balance":130}]`. `npx wrangler types` gives `Env` its types. Drizzle's D1 driver takes the same object: `drizzle(connect(env.DINF_DB))`. `npx wrangler deploy` ships the app and the database together; this needs the Workers Paid plan.

## Command line

With the dev server running (`wrangler dev` or `cf dev`), the package's command talks to the database in it:

```sh
npx cf-d-infinity sql "SELECT id, balance FROM accounts ORDER BY id"
npx cf-d-infinity sql --file schema.sql          # several statements; also reads standard input
npx cf-d-infinity sql "SELECT * FROM accounts WHERE id = ?" --param 1 --json
npx cf-d-infinity slow                           # recorded slow statements, newest first
npx cf-d-infinity status                         # shards, their health, and anything that needs attention
npx cf-d-infinity export --out dump.sql          # schema and every row, as SQL
npx cf-d-infinity import dump.sql                # load such a file into an empty database
```

It needs no HTTP endpoint and no token. The command starts a throwaway local Worker with a Service Binding to your Worker's `DinfDatabase` entrypoint, calls it, and exits (under a second). It finds the Worker by the `name` in `wrangler.jsonc` or `cloudflare.config.ts`; pass `--worker <NAME>` otherwise.

Add `--remote` to run against the deployed Worker instead: `npx cf-d-infinity sql --remote "SELECT ..."`. The throwaway Worker still runs on your machine, and only its binding is a [remote binding](https://developers.cloudflare.com/workers/local-development/#remote-bindings), so nothing is deployed and nothing is exposed. This needs Wrangler in the project and `wrangler login`, takes several seconds per command, and runs the SQL on production data.

**Health.** `status` lists each shard's size, the writes still waiting for their transaction's outcome, committed transactions not yet applied everywhere, and splits in progress. It names what needs attention (for example a committed transaction that cannot be applied, with the error) and exits with code 2 when there is something, so a monitoring script can use it.

**Export.** `export` writes the DDL you ran and every row as SQL, one statement per line; `import` runs such a file. It reads shard by shard without a common timestamp, so it is not a consistent snapshot unless writes are stopped, and it refuses to run while a shard split is moving data. It is the only way to get your data out today.

**Slow statements.** A statement that takes longer than `DINF_SLOW_QUERY_MS` (a var; default 500 ms, `0` records everything, `off` disables) is recorded with its SQL text, duration, where it ran (`shard` for one shard, `gather` or `partial` for a scan gathered into the Worker, `transaction` for a batch), the number of shards it touched and its retries. Bound parameters are never recorded. The last 1,000 entries are kept, and a burst is capped at 20 entries per 10 seconds per isolate. The same list is available to your code as `env.DINF_DB.slowQueries()`.

## Wrangler and cf

D∞ works with both Wrangler and the `cf` CLI (in beta; it runs projects through Vite and reads `cloudflare.config.ts`).

| | Wrangler | cf |
|---|---|---|
| Configuration | `wrangler.jsonc`, edited by `init` | `cloudflare.config.ts`; `init` prints the block to add, because the file is a program |
| Develop and deploy | `wrangler dev`, `wrangler deploy` | `cf dev`, `cf deploy` |
| `npx cf-d-infinity ...` | works against `wrangler dev` | works against `cf dev` |
| `npx cf-d-infinity ... --remote` | works (uses Wrangler's remote bindings) | needs Wrangler installed as well |

In a cf project, `init` writes `src/dinf.ts`, re-exports the classes from your entrypoint, adds the dependency, and prints this for the `worker` in `cloudflare.config.ts`:

```ts
exports: {
  DinfShard: exports.durableObject({ storage: "sqlite" }),
  DinfMeta: exports.durableObject({ storage: "sqlite" }),
  DinfAutoscaler: exports.durableObject({ storage: "sqlite" }),
  DinfDatabase: exports.worker(),
},
env: {
  DINF_SHARD: bindings.durableObject({ worker: "my-app", exportName: "DinfShard" }),
  DINF_META: bindings.durableObject({ worker: "my-app", exportName: "DinfMeta" }),
  DINF_AUTOSCALER: bindings.durableObject({ worker: "my-app", exportName: "DinfAutoscaler" }),
  DINF_DB: bindings.worker({ worker: "my-app", exportName: "DinfDatabase" }),
  DINF_SHARD_COUNT: bindings.text("8"),
},
triggers: [triggers.scheduled({ schedule: "* * * * *" })],   // add DINF_AUTOSCALE: bindings.text("split") to env to let it split shards
```

`cf` is in beta and its configuration can change; this was checked with `cf` 1.0.0-beta.28 (`cf dev`, `cf build` and the generated types).

## Layouts and local development

| Layout | Binding in `wrangler.jsonc` | Local development |
|---|---|---|
| **Same Worker** (what `init` sets up) | `"service": "<this Worker>", "entrypoint": "DinfDatabase"` | One `wrangler dev`. Data is kept in this project's `.wrangler/state` |
| **Separate database Worker**, shared by several apps | `"service": "my-db", "entrypoint": "DinfDatabase"` | `wrangler dev -c wrangler.jsonc -c ../my-db/wrangler.jsonc` in one process, or one `wrangler dev` per project (they find each other). Data is kept in `my-db/.wrangler/state` |

For the separate layout, run `init` in an empty directory: it creates a database-only Worker. Each app then needs the one `services` line and `cf-d-infinity/client`, a few kilobytes with no database code in it:

```ts
import { connect } from "cf-d-infinity/client";
const db = connect(env.DINF_DB);
```

The Cron Trigger does not fire by itself under `wrangler dev`. To watch the autoscaler locally, start with `wrangler dev --test-scheduled` and call `curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"`.

### From outside a Worker

Node, a script or another cloud reaches the database over Hrana with a bearer token, using `@libsql/client` unchanged. The database-only Worker serves this endpoint from its default export (set `"workers_dev": true` to expose it); `init` writes dev-only tokens to its `.dev.vars`. `wss://` is cheaper per statement than `https://`.

```sh
npm install @libsql/client
node --input-type=module <<'EOF'
import { createClient } from "@libsql/client";
const db = createClient({ url: "ws://localhost:8787", authToken: "dev-only-token" });

await db.execute("CREATE TABLE IF NOT EXISTS accounts(id INTEGER PRIMARY KEY, balance INTEGER NOT NULL)");
await db.execute("INSERT OR REPLACE INTO accounts(id, balance) VALUES (1, 100), (2, 100)");

const tx = await db.transaction("write");
await tx.execute("UPDATE accounts SET balance = balance - 30 WHERE id = 1");
await tx.execute("UPDATE accounts SET balance = balance + 30 WHERE id = 2");
await tx.commit();

console.log((await db.execute("SELECT id, balance FROM accounts ORDER BY id")).rows);
db.close();
EOF
```

In production the tokens are secrets: `npx wrangler secret put DINF_API_TOKEN` for SQL and `DINF_ADMIN_TOKEN` for `/admin/*`. A route whose token is not set rejects every request.

## How it compares

Public figures as of 2026-11, from each vendor's documentation (linked below). Only the D∞ column was measured by this project; the others were not benchmarked here.

| | D∞ | Cloudflare D1 | Turso | Neon | Supabase | PlanetScale |
|---|---|---|---|---|---|---|
| Engine | SQLite | SQLite | SQLite (libSQL) | Postgres | Postgres | MySQL (Vitess), Postgres |
| Interactive transactions | Yes, across shards | No, `batch()` only | Yes | Yes | Yes | Yes |
| Writers | One per shard; shards added online | One per database | One primary per database | One primary | One primary | One primary per shard |
| Horizontal sharding | Automatic, transparent | No | No | No | No | Yes (Vitess, Neki) |
| Largest database | 10 GB per shard, up to 4,096 shards (64 tested) | 10 GB, cannot be raised | Not stated | No stated limit | 10 TB recommended on 16XL | Grows with shards |
| Write throughput | ~950/s per shard; 18,784/s on 64 shards | Single-threaded; ≤1,000 queries/s at 1 ms each | Not published | By compute size (to 56 CU) | By compute size (to 16XL) | By cluster size and shard count |
| Latency from a Worker | 31 ms read, 41 ms write p50 (Tokyo client, end to end) | In-platform binding | HTTP or WebSocket to its region | Hyperdrive or HTTP driver to its region | Hyperdrive to its region | Hyperdrive or HTTP driver to its region |
| Write price | $1.00 per million rows; 2 rows per single-row `UPDATE` | $1.00 per million rows | $1.00 per million rows over plan | Compute time, $0.106 per CU-hour | Instance, from ~$10/month plus $25 plan | Instance, from $5/month (Postgres) |
| Storage price | $0.20 per GB-month | $0.75 per GB-month | $0.75 per GB over plan | $0.35 per GB-month | $0.125 per GB-month | 10 GB included, then by region |
| Cost when idle | One probe per shard per minute while autoscaling is on; none when off | None | Plan fee | Scales to zero | Instance keeps running | Instance keeps running |
| Where it runs | Your Cloudflare account | Cloudflare | Vendor cloud | Vendor cloud | Vendor cloud | Vendor cloud |

Read it this way: against D1 you gain interactive transactions and room beyond 10 GB, and pay one extra billed row per write plus a 2PC (~13 rows) whenever a transaction spans shards. Against the Postgres and MySQL services you give up their SQL dialects, extensions and maturity, and get a database that lives next to your Worker with no instance to size.

Sources: [D1 limits](https://developers.cloudflare.com/d1/platform/limits/), [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), [Turso pricing](https://turso.tech/pricing), [Neon plans](https://neon.com/docs/introduction/plans), [Supabase compute and disk](https://supabase.com/docs/guides/platform/compute-and-disk), [PlanetScale plans](https://planetscale.com/docs/planetscale-plans). D∞: [docs/benchmarks.md](docs/benchmarks.md).

## When not to use it

The numbers above are for a workload that partitions cleanly by a shard key. Check these before choosing D∞ over D1:

- **Under 10 GB and no need for interactive transactions: use D1.** It bills 1 row per write instead of 2, and it is faster.
- **A `UNIQUE` column or index that does not contain the shard key makes every write to that table a cross-shard commit.** `email TEXT UNIQUE` on a table sharded by `id` is the common case. Such an `INSERT` bills about 15 rows instead of 3, and takes a two-phase commit.
- **Cross-shard transactions are slow.** Measured: 483 per second on 8 shards and 1,406 on 32 (about 44–60 per shard), p50 265–315 ms and p99 in seconds, automatic retries included.
- **A statement that reads every shard does not get faster with more shards**, and at most 200,000 rows can be gathered for one statement. That limit is checked in the Worker after the rows arrive, so a careless `SELECT *` on a large table can exhaust the Worker's memory.
- **A snapshot older than a fraction of a second can fail under write load.** A read "as of T" undoes at most 50 changed rows per shard, counted over the whole shard. A long optimistic `BEGIN` on a busy shard gets `ReadTooOld` and has to retry; the 10-minute change log is an upper bound, not what you can rely on.
- **Reads are not free of billed rows while a shard is active**: each active shard writes one clock row per second.

## Architecture

```mermaid
flowchart LR
  Client["Your Worker or any SQLite client<br/>(@libsql/client, Drizzle)"]
  subgraph Account["Your Cloudflare account"]
    Worker["Your Worker, or a database-only Worker (stateless)<br/>DinfDatabase: parse, plan, route by hash slot,<br/>cross-shard SQL in wasm SQLite"]
    Meta["DinfMeta<br/>schema, 4,096-slot range table"]
    Shards["DinfShard × N<br/>SQLite tables, change log, HLC"]
    Scaler["DinfAutoscaler<br/>decides and drives splits"]
  end
  Client -->|Service Binding, HTTPS or WebSocket| Worker
  Worker --> Meta
  Worker -->|RPC| Shards
  Shards -->|2PC, live migration| Shards
  Scaler --> Shards
  Scaler --> Meta
```

Rows are placed by `hash(shard key)`; the shard key defaults to the first primary-key column, and `SHARD KEY (...)` overrides it. Indexes that do not contain the shard key become global indexes. A cross-shard commit is a two-phase commit led by one of the participating shards, ordered by per-shard hybrid logical clocks. Replication is the Durable Object storage layer's; nothing here implements Raft. The design borrows from TiDB, CockroachDB and PlanetScale; [docs/overview.md](docs/overview.md) explains the mechanisms, and [docs/design.md](docs/design.md) has the full write-up (in Japanese).

## Guarantees

| Scope | Guarantee |
|---|---|
| Single-shard transaction | Strict serializable (not verified during a Durable Object failover) |
| Multi-shard transaction | Serializable |
| Real-time order across sessions | Autocommit reads and the first read of a transaction see every write committed before they start. Later statements of a transaction may miss a newer commit on another shard. (Until 0.1.0-alpha.0 this did not hold for an autocommit read of several shards that excluded the transaction's anchor; fixed, with a regression test) |

`BEGIN IMMEDIATE` (`transaction("write")`) takes row locks and rarely fails at `COMMIT`. Plain `BEGIN` is optimistic and can fail at `COMMIT` with `SQLITE_BUSY`; retrying it is the application's job.

None of the following is a proof of the implementation:

- **Formal models** ([specs/](specs/README.md)): eleven Quint models of the risky protocol parts, exhaustively checked with TLC on small instances. Each has variants with a known bug re-introduced, and TLC finds every one.
- **Simulator**: the real shard code runs on `node:sqlite` under simulated delays, clock skew, restarts and splits, with a serializability checker over the history.
- **Black-box checks** (Elle-style list-append): run in the simulator and against production Cloudflare while Durable Objects are crashed, shards split and code redeployed. The latest production run (10 minutes, 38 crashes, 22,798 commits) found no anomaly; earlier runs found three real bugs, including an undocumented Durable Object limit of 5 terms per compound `SELECT`.
- **Compatibility**: sqllogictest (`select1`–`select5` in full, ~174,000 further queries) and differential fuzzing against real SQLite (200 seeds).

## Limitations

- **No point-in-time restore across shards.** Each Durable Object has its own 30-day PITR, but nothing restores all shards to one consistent point yet. `npx cf-d-infinity export` gives a logical dump, which is consistent only if writes are stopped while it runs.
- **One database, two static tokens.** No multi-tenancy, no per-user permissions.
- **Thin observability.** There is a slow-statement log (see [Command line](#command-line)), but no abort-rate or scatter-rate metrics and no tracing.
- **Unverified platform behavior.** Whether an old Durable Object instance can serve reads during failover is not documented by Cloudflare and was not tested. Clock skew between Durable Objects has no published bound.
- **SQLite differences.** Foreign keys are not enforced; `TEMP` tables, `ATTACH` and FTS5 are unavailable; integers beyond 2^53 lose precision; implicit rowids are unique but not contiguous. Durable Object SQLite limits also apply (for example 100 bound parameters). See [docs/sql-language.md](docs/sql-language.md).
- **Scale limits.** At most 200,000 rows gathered into the Worker per statement; no hierarchical fan-out beyond 8 shards; a single hot row tops out around 650 writes/s; shards are never merged; the autoscaler notices new load within about a minute, then follows it every 5 seconds.
- **No region control.** A shard is created near the Worker that first reaches it and never moves, so latency grows with distance from there.
- **No stability promise.** Storage format, wire protocol and admin API may change between commits. The stored data carries a format version: a release that does not understand the format refuses to open it and says so, instead of rewriting it. No release has changed the format yet, so this has only been exercised in tests.
- **Splitting a shard cannot be undone or cancelled, so automatic splitting is opt-in.** By default the autoscaler only records that a shard should be split (`npx cf-d-infinity status` shows `would-split`); set the var `DINF_AUTOSCALE` to `"split"` to let it act. Splitting has been measured with 128 shard-key groups per shard, not with millions. A shard-key group larger than 16 MB cannot be moved, and a split that meets one stops with an error naming it. A statement that reads a whole table is retried for under a second and then fails while a split is still moving data.
- **The schema is fetched from one Durable Object.** Each Worker isolate caches it for 2 seconds and refetches on the request path, so that object is a dependency of every request.

## Develop

```sh
git clone https://github.com/inaridiy/cf-d-infinity.git && cd cf-d-infinity/packages/cf-d-infinity
npm install
npm test              # unit, simulator and workerd tests, about 90 s, no Cloudflare account
npx wrangler dev --var DINF_API_TOKEN:dev-only-token --var DINF_ADMIN_TOKEN:dev-only-admin
```

With `wrangler dev` running, the script under [From outside a Worker](#from-outside-a-worker) works from that directory as written, and `curl -X POST http://localhost:8787/admin/status -H "authorization: Bearer dev-only-admin" -d '{}'` lists the 8 shards and the slot range each owns.

| Command (in `packages/cf-d-infinity/` unless noted) | Purpose |
|---|---|
| `npm run typecheck` | `tsc --noEmit` |
| `npm run build` | Build `lib/`, what the npm package ships |
| `test/slt/fetch.sh && SLT_LIMIT=1000000 npx vitest run test/slt.test.ts` | Download and run sqllogictest `select1`–`select5` |
| `FUZZ_SEEDS=200 FUZZ_LENGTH=150 npx vitest run test/fuzz.test.ts` | Differential fuzzing against real SQLite |
| `ROWCOST=1 npx vitest run test/rowcost.test.ts` | Check billed rows per operation |
| `npm run deploy:bench` | Deploy the separate benchmark and fault-injection build |
| `node bin/cli.js sql "SELECT 1" --worker <NAME>` | The `cf-d-infinity` command, against a dev server on this machine |
| `npm test` (in `packages/create-cf-d-infinity/`) | Tests of the setup CLI |
| `./check.sh` (in `specs/`, needs Java 17 or later) | Check all Quint models with TLC |

`packages/cf-d-infinity/` is the library, its tests and benchmarks; `packages/create-cf-d-infinity/` the setup CLI; `specs/` the Quint models; `spikes/` early experiments. [DEVELOPMENT.md](packages/cf-d-infinity/DEVELOPMENT.md) lists every HTTP endpoint and the two-step upgrade procedure (in Japanese).

## Documentation

The overview is in English; the detailed documents are in Japanese for now.

| Topic | Guide |
|---|---|
| How it works, in English | [Design overview](docs/overview.md) |
| Protocol, isolation, 2PC, recovery | [Design](docs/design.md) |
| What SQL runs where, and SQLite differences | [SQL dialect](docs/sql-language.md) |
| Live migration, autoscaling, storage | [Scaling](docs/scaling.md) |
| Statement placement and pushdown rules | [Query engine](docs/query-engine.md) |
| Every production measurement | [Benchmarks](docs/benchmarks.md) |
| Durable Object limits and prices this relies on | [Platform facts](docs/platform-facts.md) |
| Formal models and what they abstract away | [Specs](specs/README.md) |

## Contributing, disclaimer and license

Bug reports are welcome, and please open an issue before a large change; [CONTRIBUTING](CONTRIBUTING.md) lists what each kind of change needs. [SECURITY](SECURITY.md) is for vulnerability reports.

Not affiliated with, endorsed by or supported by Cloudflare or any vendor named above. "D∞" and `cf-d-infinity` are this project's own names, not a Cloudflare product; "Cloudflare", "D1" and the other vendors' names are trademarks of their owners and are used only to describe compatibility and to compare.

MIT, see [LICENSE](LICENSE). The deployed Worker bundles third-party packages under their own licenses. The SQL parser [`sql-parser-cst`](https://github.com/nene/sql-parser-cst) is **GPL-2.0-or-later**, so a built Worker bundle is a combined work covered by the GPL; if you distribute such a bundle, you must comply with it. SQLite in the Worker comes from [sql.js](https://github.com/sql-js/sql.js) (MIT).
