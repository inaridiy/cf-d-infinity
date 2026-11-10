# cf-d-infinity

**D∞: an unofficial, experimental SQLite database for Cloudflare Workers that scales past one Durable Object.**

Tables are spread over many Durable Objects, each holding ordinary SQLite. Your Worker reaches the database through a
Service Binding with a D1-compatible API, and gets what D1 does not have: interactive, serializable transactions that
span shards. Not affiliated with Cloudflare.

> **Experimental.** Do not put data you cannot afford to lose in it. Storage format, protocol and API may change
> between alpha releases. Read the [limitations](https://github.com/inaridiy/cf-d-infinity#limitations) first.

## Install

Run this in a Workers project (the directory with your `wrangler.jsonc`):

```sh
npx create-cf-d-infinity@alpha init
npm install
```

`init` adds the Durable Object bindings, their migration, a Service Binding named `DINF_DB`, and a one-minute Cron
Trigger for the autoscaler. It writes `src/dinf.ts` and re-exports the Durable Object classes from your main module.

## Use

```ts
import { autoscale, connect } from "./dinf";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const db = connect(env.DINF_DB);   // D1-compatible: prepare, bind, batch, first, all, run, raw

    const tx = await db.begin();       // BEGIN IMMEDIATE, across shards
    try {
      await tx.execute("UPDATE accounts SET balance = balance - 30 WHERE id = ?", [1]);
      await tx.execute("UPDATE accounts SET balance = balance + 30 WHERE id = ?", [2]);
      await tx.commit();
    } catch (e) {
      await tx.rollback();
      throw e;
    }
    return Response.json((await db.prepare("SELECT id, balance FROM accounts ORDER BY id").all()).results);
  },
  scheduled: (_controller: ScheduledController, env: Env) => autoscale(env),   // called by the Cron Trigger
};

export { DinfAutoscaler, DinfDatabase, DinfMeta, DinfShard } from "./dinf";
```

Drizzle's D1 driver takes the same object: `drizzle(connect(env.DINF_DB))`.

## Command line

With `wrangler dev` or `cf dev` running:

```sh
npx cf-d-infinity sql "SELECT id, balance FROM accounts ORDER BY id"
npx cf-d-infinity sql --file schema.sql
npx cf-d-infinity slow          # slow statements: SQL, duration, where it ran, shards touched
npx cf-d-infinity status        # shards, slot ranges, autoscaler events
```

The command starts a throwaway local Worker bound to your Worker's `DinfDatabase` and calls it; no HTTP endpoint or
token is involved. Add `--remote` to reach the deployed Worker through a remote binding (needs Wrangler and
`wrangler login`; the SQL then runs on production data).

## Entry points

| Import | Contents |
|---|---|
| `cf-d-infinity/cloudflare` | `DinfShard`, `DinfMeta`, `DinfAutoscaler` (Durable Objects), `DinfDatabase` (the Service Binding entrypoint), `autoscale(env)`, and a default export with `fetch` (Hrana for `@libsql/client`, token-protected) and `scheduled` |
| `cf-d-infinity/client` | `connect(binding)`. A few kilobytes; this is all an application Worker needs when the database lives in another Worker |

## Configuration

All of it lives in `wrangler.jsonc`, or in `cloudflare.config.ts` if you use the `cf` CLI (the repository README shows that form).

| Name | Kind | Meaning |
|---|---|---|
| `DINF_SHARD`, `DINF_META`, `DINF_AUTOSCALER` | Durable Object bindings | Required. The class names are `DinfShard`, `DinfMeta`, `DinfAutoscaler` |
| `DINF_DB` | Service Binding to `DinfDatabase` | What your code passes to `connect()`. The name is yours to choose (`init --binding`) |
| `DINF_SHARD_COUNT` | var | Number of shards the database starts with (default 8) |
| `triggers.crons` | Cron Trigger | `* * * * *` wakes the autoscaler, which watches the shards |
| `DINF_AUTOSCALE` | var | `"split"` lets the autoscaler split shards. Unset, it only records that a shard should be split (splits cannot be undone) |
| `DINF_AUTOSCALE_TICK_MS`, `DINF_AUTOSCALE_THRESHOLDS` | vars | Optional overrides for the autoscaler |
| `DINF_SLOW_QUERY_MS` | var | Statements slower than this are recorded (default 500; `0` records all; `off` disables). Bound parameters are never recorded |
| `DINF_API_TOKEN`, `DINF_ADMIN_TOKEN` | secrets | Only for the HTTP endpoint: SQL over Hrana, and `/admin/*`. A route whose token is not set rejects every request. The binding needs no token |

## License

MIT. This package bundles [sql.js](https://github.com/sql-js/sql.js) (MIT) and depends on
[`sql-parser-cst`](https://github.com/nene/sql-parser-cst), which is **GPL-2.0-or-later**: a Worker bundle built from this
package is a combined work covered by the GPL, and distributing such a bundle requires complying with it. See `NOTICE`.

Documentation, design notes, benchmarks and the verification story are in the
[repository](https://github.com/inaridiy/cf-d-infinity).
