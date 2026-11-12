# Model counterexamples, fault switches and deterministic replays (2026-11-12)

For every `red` module in `specs/check.sh` (a model configuration that TLC must find a counterexample for), this table
names the fault switch that puts the same flaw into the code and a deterministic simulator test that replays the
scenario. It answers the owner's question of whether model checking can stand in front of the random tests: the
models find the design flaws; the replays check that the implementation behaves on the dangerous orderings the
models found, without waiting for a random seed to produce them (Decision Log 2026-11-12).

Survey made read-only by a subagent on `fa1a2cd`; rows `m5b_red_range`, `m5b_red_p2_window`, `m3_red` and the
`validateFromT` note were checked by hand. Test references are `packages/cf-d-infinity/test/<file>.test.ts:<line>`.
"fixed" means the test runs only the fixed code; "guard-only" means it checks the guard step, not the whole
counterexample.

Categories:
- A: the implementation has the guard, and a replay test exists (47 on fa1a2cd; all 68 rows with a guard after 2026-11-12)
- B: implemented guard, fault switch exists, no deterministic replay (4 on fa1a2cd; none left)
- C: implemented guard, no fault switch (17 on fa1a2cd; none left)
- D: a design alternative the implementation never had or no longer has; no switch needed (8)

| module | flaw modelled | fault switch | deterministic replay | cat |
|---|---|---|---|---|
| m1_red_a | read-only participants not prepared, so their reads go unvalidated | skipReadOnlyPrepare | counterexamples:153 | A |
| m1_red_b | anchor does not absorb participants' prepare_ts | anchorNoAbsorb | counterexamples:127 | A |
| m1_red_c | commit-time refresh does not advance participant HLC to c | refreshNoBump | counterexamples:217 | A |
| m1_red_d | predicate reads counted as protected, so phantom missed | predicateProtected | counterexamples:189 | A |
| m1_red_e | validation ignores others' intents (cross-shard write skew) | ignoreIntentsInValidation | counterexamples:94 | A |
| m1_red_g | push accepted after c is decided (refresh window) | pushAfterDecide | counterexamples:307 | A |
| m2_red | reader passes an in-flight intent on timeout | readerTimeoutPass | counterexamples:66 | A |
| m3_red | phase 2 and reply sent before anchor record is synced | phase2BeforeSync | counterexamples ("the anchor syncs its commit record before phase 2 (m3_red)"; uses `c.loseUnsynced(id)`, note 3; added 2026-11-12) | A |
| m4_red | only commit ts persisted, so HLC falls behind served read | hlcNoCeiling | counterexamples:242 | A |
| m5_red_switch | old push handoff: route switch before fence gives two owners | none (nearest: ignoreFence) | none (nearest: migration:223, symptom only) | D |
| m5_red_intents | handoff does not carry intents | dropIntentsOnMove | migration:182 | A |
| m5b_red_s3 | move as a transaction; child answers T<m by undo | servePastMove | migration:202 | A |
| m5b_red_s3_parent | parent answers T<m read of a moved group | ignoreFence (broader) | migration ("m5b_red_s3_parent: a parent that ignores the fence answers a read ..."; added 2026-11-12) | A |
| m5b_red_p2 | phase 2 applied at parent, not forwarded | applyAfterMoved | migration ("m5b_red_p2: applying at the parent after the group arrived ..."; added 2026-11-12) | A |
| m5b_red_p2_window | phase 2 applied at parent while the pull reply is in flight | applyAfterMoved | migration:170 | A |
| m5b_red_intents | pull does not carry intents | dropIntentsOnMove | migration:182 | A |
| m5b_red_range | finishing a move does not pass the parent clock to the child | finishWithoutClock | move-timestamp:54 | A |
| m6_red_dirty | dirty reported only on intent write | none | none | D |
| m6_red_resolved | flush at HLC instead of resolved ts | flushPastIntents | analytics ("the analytics flush stops below unresolved intents (m6_red_resolved)"; added 2026-11-12). The analytics path is not wired into the deployed Worker | A |
| m6_red_skew | clock skew plus report delay exceeds MARGIN | none | none | D |
| m7_red | undo-based restore to W | none | none | D |
| m1b_green (freshReadPicked) | autocommit read takes T before settling intents | noRealtimeBump (multi-shard path only) | counterexamples:320 (1-shard, fixed); review-regressions:144 | A |
| m1b_green_bump (freshReadSeq) | claim 3 not promised for a transaction's 2nd statement (scope limit) | none | none | D |
| m1b_red_ra | read-time refresh does not advance HLC | refreshNoBump | counterexamples ("a read-time refresh advances the clock", via log truncation; added 2026-11-12) | A |
| m1b_red_rc | T advanced after a failed read refresh | none | review2-regressions:18 (fixed, indirect) | A |
| m8_red_drop | generation DROP does not raise logLowWater | dropNoLowWater | gc ("dropping a log generation raises the conflict window (m8_red_drop)"; added 2026-11-12) | A |
| m9_red_ro_skip | read-only transaction with locked reads skips validation | lockedReadsSkipValidation (client; added 2026-11-12) | counterexamples ("m9_red_ro_skip: a read-only transaction that read under locks is validated at COMMIT") | A |
| m9_red_second_f | 2nd DML on a row resets since to the new F | secondDmlNewSince + secondDmlNewSpanSince (client, two guards: the write's since and the first DML's span; added 2026-11-12) | counterexamples ("m9_red_second_f: a second DML on a row keeps the window from the first F"); either guard alone still aborts | A |
| m9_red_imm_read_t | IMMEDIATE key read at T, validated from F | lockedReadAtT (added 2026-11-12) | counterexamples ("m9_red_imm_read_t: a locked read in BEGIN IMMEDIATE reads at F, where its window starts") | A |
| m9_red_skip_lost | trusts a held lock and skips validation | trustLocks | counterexamples:492 | A |
| m9_red_f_is_t | DML dry-run at T instead of F | dmlAtT + dmlSkipsClock (two guards: F = T, and the clock moved to T and the causal token; added 2026-11-12; validateFromT is not this flaw) | counterexamples ("m9_red_f_is_t: a pessimistic statement runs at F, a time this shard issued"); TLC's trace, with the reader also writing x so the anomaly is a lost update; either guard alone still aborts | A |
| m9_red_wound_prepared | wound steals a prepared transaction's lock and intent | woundPrepared (added 2026-11-12; the intent has no start, prepare_ts stands in) | counterexamples ("m9_red_wound_prepared: a wound never takes a prepared transaction's intent"); the victim is a 2-shard transaction prepared at the row's shard with c not yet decided, because a 1-shard commit places no intent and a decided intent is applied before the waiter waits | A |
| m9_red_no_pred | DML predicate / referenced-table spans not validated | none | counterexamples:419 (fixed) | A |
| m9_red_prepare_waits | prepare waits on others' locks (deadlock) | prepareWaits (added 2026-11-12) | counterexamples ("m9_red_prepare_waits: prepare aborts on another transaction's lock instead of waiting"); the README's order with the ages swapped (TLC's order is broken in the code by a wound on the anchor's lock); the cycle ends at the 5 s lock TTL | A |
| m9_red_wait_die | wait-die instead of wound-wait | none | none | D |
| m9_impl_wake | lock-TTL expiry never wakes the waiter | none | counterexamples:498 (fixed) | A |
| m9_red_leave_silent | woken waiter leaves without waking the next one | none | counterexamples:510 (fixed) | A |
| m10_red_no_guard | no COMMIT age check; commit after tombstone GC | none | gc:102 (fixed, guard-only) | A |
| m10_red_gc_undone | committed record GC'd before all participants applied | gcUndone | gc ("the anchor keeps a committed record until every participant applied it (m10_red_gc_undone)"; added 2026-11-12) | A |
| m10_red_guard_too_long | accepted COMMIT age G ≥ retention R | none | gc:102 (pins G=R/2) | A |
| m11_impl | all five M11 fixes removed | noSchemaRecheck+ddlIgnoresIntents+ignoreTableLock (BUG-1 none) | ddl-concurrent:334–509, one test per BUG | A |
| m11_impl_wait | BUG-3: no version recheck after lock wait | noSchemaRecheck | ddl-concurrent:416 | A |
| m11_impl_inflight | BUG-4: in-flight 2PC commits after index public | noSchemaRecheck+ddlIgnoresIntents (both) | ddl-concurrent:436 (fixed) | A |
| m11_impl_backfill | BUG-2: row changes between backfill read and write | ignoreTableLock | unique-index-build:109; ddl-concurrent:368 | A |
| m11_impl_chunk | BUG-1: same-shard duplicate overwritten in backfill | none | ddl-concurrent:334 (fixed) | A |
| m11_impl_drop | BUG-5: committed intent applied to recreated table | ddlIgnoresIntents | review-regressions:181; ddl-concurrent:495 | A |
| m11_red_no_reject | shard accepts stale-version requests | none (check at core.ts:347) | migration:234 (fixed, guard-only) | A |
| m11_red_early_public | index public before backfill finishes | publishBeforeBackfill (added 2026-11-12; publishes before any entry is written, as in the model's trace) | unique-index-build ("a UNIQUE index that spans shards is published after the existing rows are indexed (m11_red_early_public)"; added 2026-11-12) | A |
| m11_red_no_write_only | writes skip a write-only index | none | none | D |
| m11_red_no_sync | DDL returns before all shards applied it | none (stub at ddl-concurrent:687, seed sweep) | migration:247 (fixed) | A |
| m12_red_online | index used and maintained while being built (old design) | none | ddl-concurrent:368; unique-index-build:51 (fixed design) | D |
| m12_red_no_lock | shard accepts writes during the build | ignoreTableLock | unique-index-build:109 | A |
| m12_red_visible | planner uses the unfinished index | none | unique-index-build:41 (fixed) | A |
| m12_red_no_drain | version advanced while intents are held | ddlIgnoresIntents | ddl-concurrent:436 (fixed) | A |
| m12_red_stale | shard accepts stale-version plans | none | migration:234 (fixed, guard-only) | A |
| m12_red_two_exits | late publish after expiry withdrawal | none | unique-index-build:63 (fixed) | A |
| m12_red_repin | transaction takes new version without replanning | repinOnRestore | txn-across-schema-change:53 | A |
| m12_red_scan_early | scan before the shard applied the lock version | scanBeforeLock (added 2026-11-12; removes both the sync before the scan and the lock version the scan names) | unique-index-build ("the rows are read for the index only after their shard applied the write lock (m12_red_scan_early)"; added 2026-11-12) | A |
| m12_clock_red_no_clock | publish version carries no timestamp | publishWithoutClock | unique-index-build:140 | A |
| m12_clock_red_skip_empty | build skips empty shards' clocks | scanSkipsEmpty (added 2026-11-12; the build still reads the empty shard, the switch drops its clock) | unique-index-build ("the publication timestamp of a UNIQUE index includes the clocks of shards with no rows (m12_clock_red_skip_empty)"; added 2026-11-12) | A |
| m13_red_main | DDL takes effect before buffered writes, plus repin | noImplicitCommit (+repinOnRestore) | migration-tools:122 (fixed) | A |
| m13_red_pin_only | DDL does not commit first; own new table unwritable | noImplicitCommit | migration-tools:161 (fixed) | A |
| m13_red_repin | transaction takes new version without replanning | repinOnRestore | txn-across-schema-change:53 | A |
| m13_red_retry_whole | batch retried from the top, replaying committed parts | replayAcrossSchemaChange | migration-tools:195 | A |
| m13_red_ddl_anyway | DDL runs after the preceding commit failed | ddlAfterFailedCommit | migration-tools:145 (fixed) | A |
| m14_red_no_lock | DROP guard checks but does not lock | ignoreTableLock / dropWithoutGuard | rebuild-guard:181 (fixed, guard-only) | A |
| m14_red_no_check | DROP guard locks but does not check | dropWithoutGuard | rebuild-guard:81 | A |
| m14_red_check_early | check before the lock version is applied | none | rebuild-guard:74 (fixed) | A |
| m14_red_no_drain | lock version applied with intents unsettled | ddlIgnoresIntents + unchangedIgnoresIntents (two guards; added 2026-11-12) | rebuild-guard ("the guard settles intents before it checks for changes"); with only the drain removed the pending-write check still stops it | A |
| m14_red_untied | DROP passes after the lock expires | dropAfterExpiry (Meta side, in `Faults`; added 2026-11-12) | rebuild-guard ("the DROP after a rebuild is recorded only while the lock still holds (m14_red_untied)"; added 2026-11-12) | A |
| m14_red_commit_ts | check from the copy's commit ts instead of read ts | guardFromCommitTs + refreshNoBump (two guards: the commit-time refresh carries the commit ts to every shard the copy read; added 2026-11-12) | rebuild-guard ("the guard checks for changes from the time the copy read the table (m14_red_commit_ts)"); with only the commit ts put back the refresh still stops it | A |
| m15_red_no_slot | DDL recorded mid-split (not atomic) | none | ddl-vs-split-race:15 (fixed) | A |
| m15_red_stale_begin | split uses version read before taking the slot | none | split-hazards:79; child-behind-parent:17 | A |
| m15_red_early_release | slot returned before the child finishes | none | split-slot:62 (fixed) | A |
| m15_red_no_based_on | slot taken before all shards applied the latest version | splitWithoutSync (in `ClientFaults`, read by autoscaler's reserveSplit; added 2026-11-12) | split-slot ("a split takes its slot only after every shard applied the latest version (m15_red_no_based_on)"; added 2026-11-12); on fixed code the first `split()` fails with `stale schema` before taking a slot, so the replay runs it again as the Autoscaler does (open problem 21, `test/open/split-reserve-revoked.test.ts`) | A |
| m15_red_late_start | child starts after the slot expired | startWithoutSlot + fenceWithoutSlot (Meta side; two guards: startSplit, and checkSplit before the parent fences; added 2026-11-12) | split-slot ("a child that starts receiving after the split slot lapsed (m15_red_late_start)"); with only the start put back the fence check still stops it | A |

## Switches that match no red module

- `rowSpanDespiteUnique`: narrows a write's span to one row despite an in-shard UNIQUE. Used in span-check:25 and :32, review-regressions:57, health:76.
- `autoIgnoresUniqueIntents`: autocommit write ignores UNIQUE values held by other transactions' intents. Used in review-regressions:65, health:76.
- `noWriteSetLimit`: no write-set size check before commit. Used in limits:115.
- `rowwiseUndo`: undo row by row, so a UNIQUE swap breaks the snapshot. Used in counterexamples:269.
- `staleWideRead`: parent answers whole-table reads after a move (BUG-8, which no model covers). Used in ddl-concurrent:614 and :645.
- `childKeepsOldSchema`: split child does not catch up its schema when groups arrive. Only the `FAULT=` sweep uses it.
- `validateFromT`: validates from T instead of F, which widens the window. Not the same as M9's `RED_F_IS_T` (that is `dmlAtT` + `dmlSkipsClock`). No test uses it.
- `triggerCapture`: not a defect; it only forces the slower capture path. No test uses it.

## Notes

1. A also covers rows with no switch when a test replays the scenario on fixed code ("fixed"). Such a replay shows the
   guard works on that ordering but cannot show that the check would notice the guard missing.
2. `m11_impl_inflight` needs both switches on; the specs README says either fix alone closes it.
3. `m3_red` is replayed with `SimCluster.loseUnsynced(id)` (added 2026-11-12): on that shard, writes that `sync()` has not
   confirmed are rolled back by `c.restart(id)`. By default the simulator never loses writes on restart.
4. `noImplicitCommit` and `ddlAfterFailedCommit` have no "put back" test; the `FAULT=` sweep and fixed-code tests use them.
5. `test/open/*` covers open availability and cost problems and replays no red module.
