# For agents working in this repository

`cf-d-infinity` (D∞) is an experimental horizontally-sharded, SQLite-compatible database on Cloudflare Workers and
Durable Objects. Design: `docs/overview.md` (English). Development notes: `packages/cf-d-infinity/DEVELOPMENT.md`
(Japanese; where it and the code disagree, the code wins).

## Read this first

There is work in progress on the foundation. Before changing code, read the living plan:

    .agents/execplans/2026-11-10-foundation-rework.md

It states the goal, the rules the owner set, the current design decisions, what is done, what is open, and the next
step. It is written in Japanese. Keep it current: update it at milestones, direction changes and stopping points,
in the same commit as the change. How plans are written here: `.agents/PLANS.md`.

## Rules set by the owner

1. Do not fix review or test findings one by one. Assign each finding to an invariant and its owning layer (table
   in the plan). At the second fix in the same area, stop and propose a structural change or a cut in scope.
2. Before fixing a defect, have a generator or oracle that finds it. If none can, extend the oracle first.
3. A change that adds a mechanism is a feature: write the model first (`specs/`, Quint + TLC).
4. No behaviour may fail only because rows are on different shards. Users cannot control placement. When one shard
   cannot answer, fall back to gathering rows into the Worker's SQLite and running the statement there. A refusal
   (`unsupported:` error) is acceptable only when it is decided by the statement's shape or the schema, so that it
   fails every time in development. Resource limits are the exception and must be documented. An early release
   gets no exemption: a path that works only while the rows share a shard does not ship.
5. Transactions stay serializable.
6. Do not publish to npm and do not deploy to Cloudflare without the owner asking.

## Working here

    cd packages/cf-d-infinity
    npm run typecheck
    npx vitest run                       # everything, a few minutes, no Cloudflare account
    npx vitest run test/replay.test.ts   # statement replay under concurrency, one run per seed
    OPEN=1 npx vitest run test/open      # reproductions of known, unfixed defects: these are expected to fail
    node scripts/sweep.mjs test/replay.test.ts 1 2000    # run a randomized check over many seeds, list the seeds that fail
    SEEDS=117 npx vitest run test/replay.test.ts -t "seed 117"    # run one seed again; it fails the same way every time

- The simulator is deterministic: the same seed gives the same run, down to every RPC. Time, timers, randomness and
  transaction IDs come from a `Runtime` (`src/runtime.ts`); the simulator passes one built from the seed
  (`VirtualRuntime` in `test/sim.ts`). In `src/`, do not call `setTimeout`, `Date.now()`, `Math.random()` or
  `crypto.randomUUID()` directly, and in simulator tests wait with `c.sleep(ms)`, not with a real timer
  (`test/determinism.test.ts` checks the first). A failure found by a randomized test is reproduced from its seed.
- When a randomized check fails, find out first whether the check or the database is wrong. A wrong check is fixed
  on the spot. A defect in the database is not: keep the seed, write the smallest reproduction under `test/open/`,
  and assign it to an invariant in the plan.
- Every simulator test runs the span check (`test/setup.ts`): a statement that depends on rows outside the spans
  it declared fails the test. Do not switch it off to make a test pass; `noSpanCheck` is for tests that count
  rows or re-seed an old defect on purpose.
- A reproduction of a defect that is not fixed goes to `test/open/`, written to assert the correct behaviour.
  Move it to `test/` when it passes.
- Commit messages and code comments say what and why. Comments in this codebase are in Japanese.
- Checks run on this machine, not on GitHub. Before a change goes to `main`, run `scripts/check.sh` from the
  repository root (about ten minutes; `--quick` for typecheck and tests only). When `specs/` differs from `main` it
  also runs the formal models (about an hour). GitHub Actions does not run by itself: it is slow and loads GitHub
  for nothing. It runs only when started by hand.
- `scripts/cloudflare-check.sh` deploys a throwaway Worker, runs `test/workerd.test.ts` against it and deletes it. It
  deploys to Cloudflare, so run it only when the owner asks (rule 6).
- Changes go to `main` through a pull request and a squash merge once `scripts/check.sh` has passed locally. Finish
  and verify before pushing, and push once.
