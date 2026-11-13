# create-cf-d-infinity

Sets up [cf-d-infinity](https://github.com/inaridiy/cf-d-infinity) (D∞), an unofficial, experimental sharded SQLite
database for Cloudflare Workers. Not affiliated with Cloudflare.

> **Not on npm yet.** This package and `cf-d-infinity` are reserved on npm with an empty 0.0.0 placeholder. The command below works after the first real release, which will be announced in the [repository](https://github.com/inaridiy/cf-d-infinity).

```sh
# after the first npm release:
# npx create-cf-d-infinity@alpha init
```

## In a Workers project

Run it in the directory that holds `wrangler.jsonc` (or `wrangler.json`). It adds the database to that Worker:

| File | Change |
|---|---|
| `wrangler.jsonc` | Comments kept. Adds the Durable Object bindings `DINF_SHARD`, `DINF_META`, `DINF_AUTOSCALER`, the migration `cf-d-infinity-v1` for their SQLite-backed classes, a Service Binding `DINF_DB` to this Worker's `DinfDatabase` entrypoint, the var `DINF_SHARD_COUNT`, and the Cron Trigger `* * * * *` that wakes the autoscaler. The autoscaler only watches until you add the var `DINF_AUTOSCALE` = `"split"` |
| `src/dinf.ts` | New. Re-exports the classes, `connect` and `autoscale`. Placed next to your `main` module |
| your `main` module | One line appended that re-exports the Durable Object classes; wrangler refers to them by name |
| `package.json` | Adds the `cf-d-infinity` dependency |

The one thing it cannot do for you is call the autoscaler from your default export; it prints the line to add:

```ts
scheduled: (_controller, env) => autoscale(env),
```

## In a cf project

When the directory has a `cloudflare.config.ts` (a project for the `cf` CLI), `init` does not edit it: the file is a
TypeScript program. It writes `src/dinf.ts`, appends the re-export line to the entrypoint, adds the dependency, and
prints the `exports`, `env` and `triggers` entries to add to the `worker` in `cloudflare.config.ts`.

## In an empty directory

Without a wrangler config, `init` creates a database-only Worker (`package.json`, `wrangler.jsonc`, `src/index.ts`,
`.dev.vars`, `.gitignore`) that application Workers bind to:

```jsonc
"services": [{ "binding": "DINF_DB", "service": "<its name>", "entrypoint": "DinfDatabase" }]
```

## Guarantees

- The whole plan is computed before anything is written. If any step conflicts with what is already there (a binding
  name in use, a class bound under another name, a partial migration), nothing is written and the exit code is 1.
- A second run changes nothing and reports what it kept.
- `wrangler.toml` is not edited; convert to `wrangler.jsonc` first.

## Options

| Option | Meaning |
|---|---|
| `--binding <NAME>` | Name of the Service Binding (default `DINF_DB`) |
| `--shards <N>` | Number of shards to start with (default 8) |
| `--no-autoscale` | Do not add the Cron Trigger |
| `--name <NAME>` | Worker name for a new database Worker (default: the directory name) |
| `--dry-run` | Print the plan and write nothing |

MIT licensed.
