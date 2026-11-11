Second opinion from Opus, 2026-11-11. Asked for by the owner ("Opusに壁打ちしてそれぞれ決定して") on two decisions:
how to create a cross-shard UNIQUE index on a populated table, and whether to keep the weekly CI run.
The brief gave it the two options of open problem 2 without a recommendation. It read the code, traced both
failing seeds and wrote a probe. Its two new claims (a read fails, a row is lost) were then reproduced in
`packages/cf-d-infinity/test/open/unique-index-build.test.ts`.

---

I recommend (a), but in a different form from the plan's: treat it as a table write lock recorded in the schema version, with an automatic way out if the driver dies. (b) as written is not enough. For CI, drop the weekly run.

## Decision 1: online `CREATE UNIQUE INDEX`

**The root cause holds, and I traced both seeds.**
- **Seed 100:** transaction `s100c11-2p` moved `[3,3]` from 1 to 2 and `[1,1]` from 2 to 1941. Its two index changes for k=2 merged into "nothing → nothing" (rpc 567).
- **Seed 364:** a slightly different path. `[3,1]` and `[4,3]` both had v=2 before the DDL. The backfill wrote the entry 2→`[3,1]` (rpc 406). Then transaction `s364c10-27` moved `[4,3]` off 2 and deleted that entry while naming `[4,3]` as the owner (rpc 424). So the deleted entry can come from the backfill, not only from a writer.
- **Why the shard deletes it:** `applyAndLog` replaces `Change.before` with whatever row is stored (`core.ts:1604`), and `validate` only checks `row && before === null` (`core.ts:1529`).

**"Removal names its row" is not sufficient.** I wrote a deterministic probe. It pauses the backfill before the second shard is scanned, with duplicate values on both shards:
1. **A read fails.** A join that gathers the table fails with `UNIQUE constraint failed: t.v`. Meta adds the user's index text to `cat.ddl` from the start of the build (`ddl.ts:251`, `meta.ts:117`), so the Worker's SQLite enforces an index that has not been checked yet. If the driver dies, this lasts forever; the comment at `db.ts:1195` says the index then stays half-built.
2. **A row is lost.** `INSERT OR REPLACE` found the indexed row through `conflicting()`, deleted it, and committed. The DDL then failed on the duplicates. No serial order explains that deletion, so this breaks rule 5.
3. **Same class, observational:** `assertUnique` refuses writes because of an index that may never exist.

None of these involve removal. A shorter window of the same class exists for shard-local UNIQUE indexes, between recording and withdrawal; the `checkUnique` pre-check races with writes.

**M11 cannot find this bug.** It models the index as a set of (value, row) pairs, and its removal (`idxPut`, `exclude(Set((old, r)))`) already names its row. The model faithfully copies the single-entry overwrite in the backfill (BUG-1) but not in writers. So M11 being green says nothing about this property. (b) first needs M11 rebuilt around the real storage, plus the transaction buffer, conflict-resolving statements, gathers in the Worker's SQLite, and a dying driver.

**Why (a), argued from the code:**
- Right now every write path has to handle the half-built state correctly: `indexChanges` (three modes), `assertUnique`, `conflicting()`, the planner (`plan.ts:793`), Worker replay, `Txn.buffer`, the shard apply step and the backfill's validation. Every future path (the Plan 5 generator, the Plan 7 UNIQUE read) would join that list. A lock makes the half-built state unreachable for every statement.
- The backfill already has to finish within one Worker request's subrequest budget (`db.ts:1196`), so the lock only ever covers small tables, for seconds. SQLite itself holds the write lock during `CREATE INDEX`.

**What (a) has to get right:**
- **Where the lock lives:** the version that records the index marks the table as write-locked. Shards enforce it from their own copy of the table definition, at the one place every write already passes: `assertWriteSetFits`, called by `prepareSync`, `commitLocal`, `execAuto` and `execDirect`. The Worker's check is only there to fail fast.
- **What it reuses:** shards already reject stale-catalog requests (`ensureSchema`/`requireSchema`) and resolve all intents before applying a DDL. The backfill already starts only after every shard has applied the version (`syncAll`). Together these mean that once the backfill starts, no write to the table can commit anywhere. No separate barrier protocol is needed.
- **Withdrawal:** once rows are frozen, any duplicate the backfill finds is real, so the UNIQUE error returned to the DDL caller is consistent. The existing `DROP INDEX` lifts the lock.
- **The Worker's SQLite gets the index only when it becomes public.**
- **A dying driver:** Meta keeps a deadline for the build and withdraws it when the deadline passes (an alarm). Publishing and withdrawing are both recorded against the same version, so only one can win; `publishIndex` must fail if the index is no longer being built. Delete the "run the same statement again" resume path.
- **Splits:** this is the slot planned for invariant 4 in Plan 6 (Meta permits one maintenance operation at a time, with a rule for what frees it). Build it once, here. Blocking splits during the build also removes the backfill's routing-change loop.
- **Rule 4:** the refusal does not depend on placement and is not `unsupported:`. It is a retryable "table locked by a schema change" error, with a bounded wait inside the Worker, like SQLite's busy timeout. Document it next to the resource limits.

Note that (a) adds a mechanism (the lock and its exit), so rule 3 applies to it too. It is not purely a scope cut.

**What (a) lets us delete:** index maintenance during the build, `Txn.assume` (its only caller is the backfill), the backfill's validation and conflict retries, the resume path, and the BUG-2/2b class.

**What the model must show first:**
- Store the index as value → row with value-keyed removal, as the code has it.
- The red variant (today's design) must reproduce the seed 364 shape; two rows are enough.
- Further red variants must fail: lock checked only in the Worker, no draining of intents, publish not tied to the version.
- Green must hold: `schemaSafe`, plus "no write to the table commits while it is locked", plus "no committed outcome relied on an index that was not yet public", plus exactly one exit.
- Liveness: with a fair expiry, the lock always lifts.

**What the oracle and generator must exercise:**
- Today the DDL workload accepts every UNIQUE error from any operation (`ddl-harness.ts:622`). Replace that with classified errors; reads must never fail with UNIQUE.
- Add conflict-resolving statements (`INSERT OR REPLACE/IGNORE`, `ON CONFLICT`) and reads that force a gather. `ddl-concurrent` is not in the reference projects today.
- Add a serial replay that includes the DDL at its publish point, or omits it if it failed.
- Add a fault that kills the driver, and a UNIQUE index plus splits scenario.
- Re-insert each removed guard and check that the generator, not a dedicated test, catches it.

**A third option, for later:** store index entries keyed by (k, pk), which makes removal structurally safe and matches M11. Build without enforcing anything (a dead driver is harmless) and lock the table only for a final duplicate check. That would be the online optimisation once tables get large. It has to agree with (a), which plays the role of the reference path. Refusing the DDL on populated tables is out: it would pass in development and fail in production.

**Corrections to the plan:**
- Invariant table row 7 still says the cause has not been investigated.
- (a)'s description is missing the Worker-replay change, the exit for a dead driver, and the need for a model.
- (b) underestimates the work, as shown above.
- The Decision Log lists the write lock-out as "保留" (deferred).

## Decision 2: weekly CI run

**Drop the schedule and keep manual dispatch.** The models do not reference `src/`. With `specs/` unchanged, TLC re-checks exactly the same thing, and the schedule skips the tests job, so the only thing it can catch is tool drift. The one real risk is someone merging a `specs/` change without running `--models`; the weekly run would catch that up to a week late. A better guard is for `scripts/check.sh` to turn `--models` on itself when `specs/` differs from `main`. The scheduled time that would actually find new failures is the fresh-seed sweep (Plan 5, completion criterion 8); decide separately whether that runs locally or on CI.

Two stale details: the `changes` job in `ci.yml` no longer does anything with only these two triggers, and `AGENTS.md` still says CI runs on every pull request and runs the models when `specs/` changes.
