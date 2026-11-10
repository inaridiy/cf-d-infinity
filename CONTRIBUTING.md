# Contributing

Thank you for looking. D∞ is an experimental research prototype with one maintainer, so please read this first.

## Before you write code

- **Bug reports are the most useful contribution.** A failing SQL statement, a history that is not serializable, a
  statement that gives a different answer from SQLite: open an issue with the statements and the schema.
- **Talk before a large change.** The protocol and the storage layout are still moving. Open an issue describing
  what you want to change and why, and wait for an answer before investing time.
- **Out of scope for now:** shard merging, a Postgres or MySQL dialect, and the analytics path.

## Setup

```sh
git clone https://github.com/inaridiy/cf-d-infinity.git
cd cf-d-infinity/packages/cf-d-infinity
npm install
npm test          # about 90 s; no Cloudflare account needed
```

Node.js 24 is what CI uses. The setup CLI lives in `packages/create-cf-d-infinity` (`npm install && npm test` there).
The Quint models need Java 17 or later: `cd specs && npm ci && ./check.sh`.

## What a change needs

| You changed | Run | Also expected |
|---|---|---|
| Anything in `packages/cf-d-infinity` | `npm run check` (types and all tests) | A test that fails without the change |
| The shard protocol (`src/shard/core.ts`, commit, recovery, migration) | The above, plus `npx vitest run test/history.test.ts test/elle-sim.test.ts` a few times | A counterexample test in `test/counterexamples.test.ts` for a bug fix; for a new mechanism, a Quint model or an argument for why none is needed |
| SQL planning or execution | The above, plus `test/slt/fetch.sh && SLT_LIMIT=1000000 npx vitest run test/slt.test.ts` | A case in `test/compat.test.ts` comparing against real SQLite |
| Billed rows per operation | `ROWCOST=1 npx vitest run test/rowcost.test.ts` | Updated bounds, with the reason |
| The wire format between Worker and shard | Read the two-step upgrade procedure in `packages/cf-d-infinity/DEVELOPMENT.md` | `PROTOCOL_VERSION` handled as described there |
| Anything a user's `wrangler.jsonc` or code refers to | `npm test` in `packages/create-cf-d-infinity` | README and both package READMEs updated in the same change |
| `specs/` | `./check.sh` | The "red" variant that reproduces the bug, alongside the fix |

Names that end up in a user's Worker (bindings, vars, classes) keep the `DINF_` / `Dinf` prefix. Durable Object class
names cannot be renamed without a migration on the user's side, so they are not changed.

## Style

Code comments and the design documents are mostly in Japanese; English is equally welcome. Comments say why, not
what. A test should be able to fail: when you add a check, confirm that it goes red when you break the thing it
guards.

## License

By contributing you agree that your contribution is licensed under the MIT License of this repository.
