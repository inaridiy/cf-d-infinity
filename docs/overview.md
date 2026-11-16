# Design overview

This is the English summary of how D∞ (`cf-d-infinity`) works. The full design documents are in Japanese:
[design.md](./design.md), [scaling.md](./scaling.md), [query-engine.md](./query-engine.md),
[sql-language.md](./sql-language.md). Measurements are in [benchmarks.md](./benchmarks.md) and the formal models in
[specs/](../specs/README.md). Where this page and the code disagree, the code is right; please open an issue.

## The shape of the system

```
 your Worker ── Service Binding (DinfDatabase) ──┐
 @libsql/client ── Hrana over HTTP / WebSocket ──┤
                                                 ▼
                         stateless Worker code: parse, plan, route, merge
                              │                         │
                              ▼                         ▼
                      DinfMeta (one)            DinfShard × N
                      schema, range table       SQLite tables, change log,
                                                intents, 2PC records, HLC
                              ▲
                      DinfAutoscaler (one): decides and drives shard splits
```

- **A shard is one Durable Object holding ordinary SQLite tables.** User tables are stored as they were declared,
  with no hidden columns, and hold only the latest committed version of each row. The shard therefore runs pushed-down
  SQL, including joins and aggregates, with SQLite's own planner and executor.
- **Inside a shard, only synchronous code touches the state.** A Durable Object runs one piece of JavaScript at a
  time, so a synchronous function is atomic. The shard's kernel (`src/shard/kernel.ts`) has no `await`. A request is a
  step: it validates the schema version and the ownership of the rows it touches, and then either finishes or returns
  what it has to wait for (a peer shard, Meta, storage, a row lock). A small shell (`src/shard/core.ts`) performs the
  wait and calls the same step again from the top, so a check made before a wait is never relied on after it.
- **Replication is not implemented here.** A Durable Object's storage layer already replicates each commit to
  followers and confirms it on a quorum, so there is no Raft in this codebase.
- **Nothing sits on the hot path of every request.** There is no central timestamp oracle and no coordinator
  object. The stateless Worker code caches the schema and the range table and talks to the shards directly.
  A single Durable Object handles roughly a thousand requests per second, so any object that every transaction had
  to visit would cap the whole system.

## Placing rows

There are 65,536 hash slots. A row's slot is `hash(shard key)`, and the range table in `DinfMeta` maps slot ranges to
shards. (The range table is kept in tokens: a row's token is its slot followed by 16 bits of the hash of its whole
primary key, so that a later version can put a boundary inside one slot and spread one shard key value over two
shards. Today every boundary is a slot boundary; see [design-subslots.md](./design-subslots.md).) The shard key is the first primary-key column (`rowid` for a table without one); D∞ adds no syntax to SQLite to choose it.
Rows with the same shard key value live on the same shard across tables, so a tenant's `users` and `orders` are
colocated and a typical transaction touches one shard.

An index is a plain SQLite index inside each shard, whether or not it contains the shard key. A read by an indexed
column that is not the shard key is sent to every shard, and each shard answers from its own index.

Uniqueness is the exception, because one shard cannot check it. A `UNIQUE` constraint or index that does not contain
the shard key gets a **global index**: a table of entries (index key, primary key, shard key) placed by the index key
on the same set of shards and updated as a participant of the same transaction. A write to a table with a global
index is therefore a cross-shard commit. The global index enforces uniqueness and tells an `INSERT` where the rows
it may conflict with are; reads are not routed through it.

## Time and isolation

Each shard has a hybrid logical clock (HLC) that strictly increases every time it issues a timestamp. Timestamps
always come from shards, never from the Worker. A shard persists an upper bound for its clock (at most one row per
second) so that the clock cannot go backwards across a restart.

| Scope | Guarantee |
|---|---|
| Single-shard transaction | Strict serializable |
| Multi-shard transaction | Serializable |
| Across sessions | Autocommit reads and the first read of a transaction see every write committed before they start |

Real-time order between transactions on different shards is not guaranteed in general, because Cloudflare publishes
no bound on clock skew between Durable Objects. That rules out Spanner's commit wait and CockroachDB's uncertainty
intervals; the design leans on HLC propagation and validation instead.

## Reading

A read that stays on one shard reads that shard's latest state. A read that spans shards picks a timestamp `T`
(the maximum of the involved shards' clocks), and every shard it touches first advances its own clock to `T`, so
that anything committing later gets a larger timestamp.

Because tables hold only the latest version, reading "as of `T`" uses **rollback-read**: inside one synchronous
SQLite transaction, the shard deletes the rows changed after `T`, re-inserts their before-images from the change
log, runs the original SQL, and rolls the transaction back. A Durable Object runs one request at a time and this
section never yields, so no other request observes the intermediate state. Deleting first and inserting afterwards,
rather than updating row by row, is what lets it undo a transaction that swapped values in a `UNIQUE` column.

If the range being read holds a prepared-but-undecided write (an *intent*) with a timestamp at or below `T`, the
shard asks the transaction's anchor for its outcome instead of guessing: it may ignore the intent only when the
transaction is known to commit after `T` or to have aborted. Passing such an intent on a timeout would let one shard
show a transaction that another shard hides.

## Writing

The Worker never interprets what a write statement means. The shard executes the statement and captures the rows it
changed (with `RETURNING` where the statement allows it, with capture triggers otherwise). For a statement inside a
transaction the shard then rolls back, and the Worker buffers the row images until `COMMIT`; an autocommit statement
is executed and committed directly.

**Single-shard commit.** The shard validates the transaction's reads, applies its rows and appends one row to the
change log, all in one synchronous SQLite transaction. One durable write, no 2PC.

**Cross-shard commit.** One participating shard acts as the *anchor* and drives a two-phase commit. Since the anchor
is itself durable, the outcome does not depend on client liveness, lock TTLs or heartbeats.

1. The Worker sends the write set and the read spans to the anchor.
2. The anchor sends `prepare` to every other participant, including read-only ones. A participant aborts at once
   on a conflicting intent or lock (prepare never waits), validates its read spans, stores the intent, and
   answers with a `prepare_ts` from its clock.
3. The anchor advances its clock past every `prepare_ts`, prepares itself last, and takes its own `prepare_ts`
   as the commit timestamp `c`.
4. Participants whose reads are not protected by their own intents re-validate them up to `c` (*read refresh*).
5. The anchor durably records `committed(c)`, answers the client, and starts phase 2.
6. Each participant advances its clock to `c`, applies its intent to the tables and writes its change-log row.

Recovery is *presumed abort*: nothing is logged at the anchor during prepare. A reader or an alarm that finds an
old intent asks the anchor, and an anchor that has neither a record nor an in-flight entry writes an abort tombstone.

**Row locks.** Optimistic validation alone makes transactions that fight over the same rows fail at `COMMIT`
repeatedly, so writes take row locks when the statement runs, as in TiDB's pessimistic mode. Every row a statement
writes passes through one function in the Worker (`Txn.wrote`), whichever path ran the statement: a statement sent to
one shard takes its locks there as it runs, and a statement run in the Worker's SQLite takes them afterwards with a
locking read of the rows it wrote. `BEGIN IMMEDIATE` also locks the rows it reads by primary key. Locks live only in
the shard's memory and may vanish at any time (restart, TTL, migration) without harm, because commit-time validation
still checks every row from the moment it was read. Waiting uses wound-wait over one total order (start time; at the
same millisecond a transaction is older than an autocommit write, which holds no locks); prepared transactions
cannot be wounded and never wait, which keeps the wait graph acyclic.

## Queries across shards

Every statement has one **reference path**: gather the rows it reads into a SQLite instance inside the Worker (sql.js,
WebAssembly) and **run the original SQL there**. Scans with the filters pushed down fetch the rows, and the tables a
statement opens are taken from SQLite's own compilation of it, not from the planner's reading of the text. Expression
evaluation is never reimplemented, which is why the same statement gives the same answer wherever its rows are.

Everything else the planner (the only part written from scratch) does is an optimization of that path. If it can
prove that one shard owns all the rows, the statement is sent there unchanged; a simple aggregate is computed per
shard and merged. When an optimized path finds out while running that one shard cannot answer (the statement reads
a table that is not in its `FROM` clause, it resolves a conflict with a row on another shard, it is too big for a
shard's SQLite), the statement is planned again on the reference path and run there. A shard measures every statement
it is sent against the Durable Object SQLite limits (100 KB, 100 parameters, five compound terms) before running it,
and refuses an oversized one with a typed error rather than leaving it to SQLite's message. Whether a statement hits
those limits depends on how its rows are split into per-shard statements, so a refusal would make the outcome depend on
placement. The scans the reference path sends are kept within the limits when they are planned. That switch is in one place, and
nothing is refused because of where rows happen to be. Multi-shard `UPDATE` and `DELETE` run only when the statement
spells them out; the planner does not rewrite a statement into something else silently.

A write on the reference path is run in the Worker's SQLite and the rows it changed are captured and sent to the
shards that own them. What it can conflict with is not known before it runs, because the values it writes come from
expressions and defaults. So the write is run, then the rows that share a primary key or a `UNIQUE` value with a
changed row and were not gathered yet are fetched (through the global index when the `UNIQUE` spans shards), and the
write is run again, until nothing is missing. With those rows present SQLite itself decides what is ignored, replaced,
updated or a constraint violation. The lookups are reads of the transaction, so a conflicting row that appears later
fails validation at commit.

Whatever a statement reads on a shard is recorded as a *span* and validated at commit: a primary key, a shard-key
group, a pushed-down condition, or a whole table. The span has to cover everything the shard-side statement can
read, not just the rows the Worker expects. A subquery inside `INSERT ... VALUES` is evaluated first, as a read of
the transaction, and sent as a constant. In the simulator every statement a shard runs is checked against its spans:
the rows outside them are deleted and the statement is run again, and a different result fails the test. The tests
that compare against real SQLite also run with every statement forced onto the reference path, with and without
pushed-down filters; all three must agree.

Writes have a guard in the shard itself, so that a wrong request from the Worker cannot place a row silently. Every
row a statement changes must be owned by that shard and covered by the spans the statement declared, and every row a
transaction hands over at commit must be the row its change names. Otherwise the shard refuses the whole write with
`write outside claim:` before anything is applied. The error is not marked retryable and is not a routing refusal,
because sending the same plan again would write the same rows. Rows that arrive already decided (an applied intent, a forwarded phase 2, a
moved group) are not checked again. In the simulator a second check, written apart from the guard, finds the owner of
each written row from the range table and the shards' move records and fails the test on any write outside its
declaration or onto a shard that does not own the row.

## Schema changes

DDL goes through `DinfMeta`, which records schema changes and range moves in one append-only epoch log
([design-catalog-epoch.md](./design-catalog-epoch.md)). Every schema change is two-phase: Meta records a *prepare*,
every shard applies it and answers, and only then does Meta record the *commit*; if any shard refuses, or the driver
stops, Meta records an *abort*. The change is applied on every shard before the statement returns, and every request
carries the epoch of the snapshot it was planned on and the epoch at which the schema last changed. A shard keeps a copy of the part of the log it has applied and rejects a request planned against an older
schema, so a Worker with a stale cache cannot write through a dropped table. A request planned on a snapshot where
only the range table moved is not stale.

`DinfMeta` runs the shard statements of a change in its own SQLite, on empty copies of the tables, and records the
prepare only if they succeed. A statement that parses but that SQLite rejects is therefore refused up front. The
prepare stops writes to the tables the change must keep still (a table it drops, renames or adds a column to, or
indexes from its rows); a shard that applies it refuses those writes until it applies the commit or the abort. A
statement that can fail only where rows exist (a `UNIQUE` index over duplicates, `ADD COLUMN` with a `CHECK`) is tried
by every shard on its fenced table and rolled back; if a shard's rows break it, the change is aborted and the caller
gets SQLite's message. Nothing is undone: a change enters the schema only at its commit, so no statement ever planned
on a change that did not happen. One transition is open at a time, and the driver renews a 5-second lease; if it
stops, Meta aborts the change within the lease, and in any case after 5 minutes. Model M21.

Five rules keep a schema change from tearing a transaction that is under way:

- A shard resolves every intent it holds before it applies DDL. An intent carries row images in the old table shape,
  and a committed one could never be applied after its table or column is gone.
- A write rechecks the schema version after any wait (a row lock, a group still arriving, the prepare round at the
  anchor), because DDL may have been applied meanwhile.
- A new global (cross-shard `UNIQUE`) index on a table that has rows is built while writes to that table wait. The
  prepare write-locks the table and creates the empty index table, and the index stays invisible to planning until it
  is committed. The rows are indexed while they cannot change, then Meta commits or aborts the index exactly once. The
  committing record carries a timestamp that every shard's clock moves past, so statements that use the index come
  after every write made without it. Model M21 (it replaced M12).
- A schema change inside a transaction first commits what the transaction did, and the statements after it form a
  new transaction (as in MySQL). A transaction keeps the schema version it first planned with until it commits, also
  when it continues on another connection. Model M13.
- A `DROP TABLE` of a table the transaction read (the last step of a table rebuild) write-locks the table at its
  prepare, has every shard check that nothing changed in what the transaction read since it read it, and only then
  commits. If something changed, the drop is aborted as a conflict and no row is lost. Model M21 (it replaced M14).
- A shard born from a split catches up to its parent's schema before it accepts the parent's rows.
- A shard that is handing over or receiving a range applies no schema change until the move is finished, and the
  parent catches up to the child's version before it fences the range. Rows and intents in transit then always have
  the shape of the table that receives them. Splits and schema changes take turns through a maintenance slot at
  Meta: a split takes it only while no schema transition is open, uses the schema epoch Meta returns with it, and
  holds it until the child has received the range; Meta opens no schema transition meanwhile, so no request planned
  at the current schema is refused by a moving shard. Splits share the slot with each other. A split that stops before
  the child starts receiving releases the slot after 5 seconds; one that has started cannot be undone, so the
  autoscaler resumes it. Model M15 (stage 4 of the catalog epoch design replaces the slot with move records).

The first four came out of randomized tests and a model (M11) that found six ways the first implementation got it
wrong; the fifth came out of a second design review and is covered by simulator tests but not yet by a model. The
two-phase transition replaced an earlier scheme that recorded a change at once and withdrew it afterwards when a
shard could not apply it.

## Growing

Shards are split, never merged. `DinfAutoscaler` is woken once a minute by a Cron Trigger, collects load figures
from every shard, and follows up every few seconds only while some shard is over a threshold or a split is in
progress. A split is a pull-based live migration:

1. the child shard is told which slot range to expect,
2. the parent fences that range and stops serving it,
3. the range table switches ownership to the child, so new requests go there at once,
4. the child pulls the data from the parent, one shard-key group at a time, on demand and in the background.

A split is refused on a shard that is still receiving a range, a range cannot be fenced to a second child, and
running an interrupted split again continues the same range.

Every group that is copied carries a timestamp from the parent, and the child advances its clock to it. A shard key
that had no rows is never copied, so when the move finishes the parent hands its clock over once more for the whole
range. Without that the child could commit a row at a timestamp below one at which the parent had already answered
"no such row", and that read would end up after a write it did not see.

The child keeps that last timestamp with the range (the *range floor*) and refuses, with a retryable error, any read
or validation of a key in the range at an earlier time. It has no history of the range from before the move: a group
the parent emptied before the fence is not copied either, and without the floor the child would answer "no rows" for
it at a time when the rows still existed.

Ownership moves before the data does, which sheds load from a hot parent immediately instead of making it also pay
for a bulk copy first. A Worker whose range table predates the split is told so: a request for a moved shard key, and
a whole-table read that still believes the parent owns the moved slots, both get `NotOwner`, and the Worker refetches
the range table and plans the statement again. A transaction keeps the schema it started with and swaps in the newer
range table. A shard looks ownership up in its own copy of the epoch log; a child that has not yet applied the move
applies it when a request planned on a newer snapshot reaches it. A transaction that read the moved range before the
split cannot yet move its read time past the move, and one that wrote or lock-read a moved row before the split fails
its next statement as a conflict (open problem 37). See [scaling.md](./scaling.md) for the timestamp
rules that keep this serializable.

## How it is checked

The checks are layered. Each one catches what the layer before it cannot see.

1. **Formal models.** Eighteen Quint models cover the risky protocol parts: commit and snapshot reads, read refresh, 2PC
   recovery, HLC across restarts, split fencing and live migration, row locks, garbage collection of transaction
   records, schema changes under concurrent transactions, building a cross-shard `UNIQUE` index, schema changes inside
   transactions, table rebuilds, the ordering of schema changes and splits, `UNIQUE` across pending writes, and a
   transaction id reused by two continuations. Four more (M18 to M21) model mechanisms the code does not have yet:
   moving one tenant in pieces, re-splitting a read while pieces move, `UNIQUE` while a group moves piece by piece,
   and one epoch log in place of the catalog's separate versions and write bans.
   TLC explores them exhaustively on small instances. Each model has variants with a known bug put back, and the checker
   must find every one.
2. **Counterexamples replayed against the code.** A model only checks the design. For each bug variant that the
   implementation guards against, a deterministic simulator test drives the model's counterexample against the real
   code. For most of them (51 of 74) a fault switch also puts the same bug back into the code, and the test checks that
   the switch produces the violation; the others replay the ordering on the fixed code only. Without the replays, a rare
   ordering is left to a random seed that may never produce it. The [coverage table](./model-coverage.md) maps every
   variant to its switch and replay.
3. **A deterministic simulator.** The real shard code runs on `node:sqlite` under simulated delays, clock skew,
   restarts and splits. Time, timers, randomness and transaction IDs come from the seed, so the same seed gives the
   same run, down to every RPC, and every failure is reproduced from its seed. Every statement a shard runs is checked
   against the spans it declared. Two randomized checkers run on top:
   - a serializability checker over the transaction history;
   - a statement replay that re-runs every committed statement, in commit order, on one SQLite and compares each answer.
4. **The reference path as an oracle.** The differential suites run three times: as planned, with every scan gathered
   into the Worker, and with every statement on the reference path. A fast path that changes an answer, or an answer
   that depends on where rows are, fails there.
5. **SQLite itself as the oracle.** sqllogictest, differential fuzzing, and a generator that sends typed arguments
   through a stock `@libsql/client` and compares values and `typeof` with SQLite (INTEGER bound as BigInt, as sqld does).
6. **A fault table.** Every fault switch is run against the randomized checks over the same seeds, and the table records
   which check finds which bug, so a check that finds nothing is visible.
7. **Every night.** The randomized checks run on fresh seeds each night.
8. **Upgrades.** Data written by storage format 1 is kept as a fixture, and every later version must open it, give the
   same answers, and keep writing, splitting and changing the schema on it.
9. **Production.** The workerd integration tests also run against a Worker deployed to Cloudflare. An Elle-style
   list-append workload runs in the simulator and against production while Durable Objects are crashed, shards split,
   and code is redeployed with mixed versions.

None of this is a proof of the implementation.

## What the design describes that the code does not do yet

- **Consistent restore of all shards.** The checked procedure replays a change log kept in R2; that log is not
  written yet. Local `workerd` does not implement Durable Object point-in-time recovery, so this can only be
  developed against production.
- **The analytics path** (change log to R2, compaction, DuckDB) is not wired into the deployed Worker.
- **Hierarchical fan-out** for statements that touch more than about eight shards, and semijoin reduction.
- **Splitting inside one shard-key value**, and merging shards.
- **Region placement.** Shards are created wherever they are first reached.
- **An operator's way out of a committed transaction that cannot be applied.** The causes found so far are fixed
  and `status` reports the state, but nothing can discard such a transaction.
- **Pruning the per-group records of a finished split** (`__moved`, `__arrived`), which are kept forever.

## Ideas borrowed, and ideas left out

| From | Borrowed | Left out, and why |
|---|---|---|
| TiDB | Online schema change, intent resolution, pessimistic row locks | The central timestamp oracle: a Worker cannot batch requests to it, so it would cap throughput |
| CockroachDB | HLC, read refresh, pushing a transaction's timestamp | Uncertainty intervals: there is no published clock-skew bound |
| Vitess / PlanetScale | Sharding on top of a native database, shard keys, copy-based resharding | The MySQL protocol; weak cross-shard transactions |
| Spanner | Colocating related rows | TrueTime and commit wait |
