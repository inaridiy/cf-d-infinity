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
- **Replication is not implemented here.** A Durable Object's storage layer already replicates each commit to
  followers and confirms it on a quorum, so there is no Raft in this codebase.
- **Nothing sits on the hot path of every request.** There is no central timestamp oracle and no coordinator
  object. The stateless Worker code caches the schema and the range table and talks to the shards directly.
  A single Durable Object handles roughly a thousand requests per second, so any object that every transaction had
  to visit would cap the whole system.

## Placing rows

There are 4,096 hash slots. A row's slot is `hash(shard key)`, and the range table in `DinfMeta` maps slot ranges to
shards. The shard key defaults to the first primary-key column; `SHARD KEY (...)` on `CREATE TABLE` overrides it.
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
repeatedly, so writes take row locks when the statement runs, as in TiDB's pessimistic mode. `BEGIN IMMEDIATE` also
locks the rows it reads by primary key. Locks live only in the shard's memory and may vanish at any time (restart,
TTL, migration) without harm, because commit-time validation still checks every row from the moment it was read.
Waiting uses wound-wait; prepared transactions cannot be wounded and never wait, which keeps the wait graph acyclic.

## Queries across shards

Every statement has one **reference path**: gather the rows it reads into a SQLite instance inside the Worker (sql.js,
WebAssembly) and **run the original SQL there**. Scans with the filters pushed down fetch the rows, and the tables a
statement opens are taken from SQLite's own compilation of it, not from the planner's reading of the text. Expression
evaluation is never reimplemented, which is why the same statement gives the same answer wherever its rows are.

Everything else the planner (the only part written from scratch) does is an optimization of that path. If it can
prove that one shard owns all the rows, the statement is sent there unchanged; a simple aggregate is computed per
shard and merged. When an optimized path finds out while running that one shard cannot answer (the statement reads
a table that is not in its `FROM` clause, it resolves a conflict with a row on another shard, a shard's SQLite
refuses it), the statement is planned again on the reference path and run there. That switch is in one place, and
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

## Schema changes

DDL goes through `DinfMeta`, which versions the schema. The change is applied on every shard before the statement
returns, and every request carries the schema version it was planned with; a shard rejects a request planned
against an older schema, so a Worker with a stale cache cannot write through a dropped table.

`DinfMeta` runs the shard statements of a change in its own SQLite, on empty copies of the tables, and records the
change only if they succeed. A statement that parses but that SQLite rejects is therefore refused up front. A
statement that fails only where rows exist (a `UNIQUE` index over duplicates, `ADD COLUMN` with a `CHECK`) is
*withdrawn*: the shard that cannot apply it asks `DinfMeta` to record the inverse as the next version, shards that
have not applied the change skip both versions, and the caller gets SQLite's message. This is safe because a new
version is recorded only after every shard applied the previous one, so nothing can have been built on the change.

Five rules keep a schema change from tearing a transaction that is under way:

- A shard resolves every intent it holds before it applies DDL. An intent carries row images in the old table shape,
  and a committed one could never be applied after its table or column is gone.
- A write rechecks the schema version after any wait (a row lock, a group still arriving, the prepare round at the
  anchor), because DDL may have been applied meanwhile.
- A new global (cross-shard `UNIQUE`) index on a table that has rows is built while writes to that table wait. The
  version that records the index write-locks the table, shards refuse writes to it, and the index stays invisible to
  planning until it is published. The rows are indexed while they cannot change, then Meta publishes or withdraws the
  index exactly once. The builder renews a 5-second lease; if it stops, the lock lifts within the lease, and a build
  ends after 5 minutes in any case. The publishing version carries a timestamp that every shard's clock moves past,
  so statements that use the index come after every write made without it. Model M12.
- A schema change inside a transaction first commits what the transaction did, and the statements after it form a
  new transaction (as in MySQL). A transaction keeps the schema version it first planned with until it commits, also
  when it continues on another connection. Model M13.
- A `DROP TABLE` of a table the transaction read (the last step of a table rebuild) write-locks the table, has every
  shard check that nothing changed in what the transaction read since it read it, and only then drops it. If
  something changed, the drop fails as a conflict and no row is lost. Model M14.
- A shard born from a split catches up to its parent's schema before it accepts the parent's rows.
- A shard that is handing over or receiving a range applies no schema change until the move is finished, and the
  parent catches up to the child's version before it fences the range. Rows and intents in transit then always have
  the shape of the table that receives them. The DDL driver waits for a split in progress instead of recording a
  version the moving shards cannot take.

The first four came out of randomized tests and a model (M11) that found six ways the first implementation got it
wrong; the fifth, and the validation and withdrawal above, came out of a second design review and are covered by
simulator tests but not yet by a model.

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

Ownership moves before the data does, which sheds load from a hot parent immediately instead of making it also pay
for a bulk copy first. A Worker whose range table predates the split is told so: a request for a moved shard key, and
a whole-table read that still believes the parent owns the moved slots, both get `NotOwner`, and the Worker refetches
the range table. See [scaling.md](./scaling.md) for the timestamp rules that keep this serializable.

## How it is checked

1. **Formal models.** Twelve Quint models cover the risky parts (schema changes under concurrent transactions, commit and snapshot reads, read refresh, 2PC
   recovery, HLC across restarts, split fencing, live migration, garbage collection of transaction records, and the
   integrated protocol). TLC explores them exhaustively on small instances. Each model has variants with a known bug
   put back, and the checker must find every one.
2. **Simulator.** The same shard code runs on `node:sqlite` under simulated delays, clock skew, restarts and splits,
   and a checker verifies that each history is serializable.
3. **Black-box checks.** An Elle-style list-append workload runs in the simulator and against production Cloudflare
   while Durable Objects are crashed, shards split, and code redeployed with mixed versions.
4. **Compatibility.** sqllogictest and differential fuzzing against real SQLite.

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
