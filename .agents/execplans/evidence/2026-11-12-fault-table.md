Fault table, 2026-11-12. Code under test: f393657 (before the first slice of Plan of Work 5). Built with
`node scripts/fault-table.mjs --from 1 --to 40 --procs 8 --limit 900` (resumed once after the ignoreFence hang, see open problem 18).

seeds 1..40, project sim. Each cell is failed tests / seeded tests run, then the seeds that failed (first 6).
"hung a..b" means the run of seeds a..b did not finish within 900 s and was killed.

| fault | replay | history | ddl-concurrent |
|---|---|---|---|
| none | 0/80 | 0/240 | 0/440 |
| autoIgnoresUniqueIntents | 0/80 | 0/240 | 0/440 |
| ddlIgnoresIntents | 0/80 | 0/240 | 43/440 (1, 2, 3, 4, 6, 9, ...) |
| childKeepsOldSchema | 0/80 | 0/240 | 0/440 |
| noSchemaRecheck | 0/80 | 0/240 | 0/440 |
| noWriteSetLimit | 0/80 | 0/240 | 0/440 |
| noRealtimeBump | 0/80 | 0/240 | 0/440 |
| anchorNoAbsorb | 1/80 (30) | 137/240 (1, 3, 4, 5, 6, 7, ...) | 24/440 (1, 2, 3, 4, 5, 6, ...) |
| skipReadOnlyPrepare | 27/80 (1, 4, 7, 9, 14, 16, ...) | 226/240 (1, 2, 3, 4, 5, 6, ...) | 0/440 |
| refreshNoBump | 1/80 (13) | 139/240 (1, 2, 3, 4, 5, 6, ...) | 2/440 (3, 35) |
| predicateProtected | 3/80 (14, 22, 25) | 17/240 (6, 7, 10, 12, 13, 16, ...) | 0/440 |
| ignoreIntentsInValidation | 44/80 (1, 2, 4, 5, 6, 7, ...) | 231/240 (1, 2, 3, 4, 5, 6, ...) | 352/440 (1, 2, 3, 4, 5, 6, ...) |
| readerTimeoutPass | 71/80 (1, 2, 3, 4, 5, 6, ...) | 226/240 (1, 2, 3, 4, 5, 6, ...) | 420/440 (1, 2, 3, 4, 5, 6, ...) |
| hlcNoCeiling | 1/80 (14) | 5/240 (5, 6, 9, 32, 39) | 0/440 |
| rowwiseUndo | 16/80 (3, 4, 6, 7, 9, 11, ...) | 0/240 | 0/440 |
| pushAfterDecide | 29/80 (1, 3, 4, 5, 6, 7, ...) | 122/240 (1, 2, 3, 4, 5, 6, ...) | 0/440 |
| applyAfterMoved | 0/80 | 0/240 | 2/440 (7, 14) |
| triggerCapture | 0/80 | 0/240 | 0/440 |
| dropIntentsOnMove | 0/80 | 4/240 (8, 18, 20, 34) | 3/440 (7, 11, 14) |
| servePastMove | 0/80 | 0/240 | 0/440 |
| ignoreFence | 0/80 | 57/210 (1, 2, 3, 4, 5, 7, ...) hung 26..30 | 0/0 hung 1..5, 6..10, 11..15, 16..20, 21..25, 26..30, 31..35, 36..40 |
| staleWideRead | 0/80 | 0/240 | 22/440 (2, 3, 4, 5, 7, 10, ...) |
| finishWithoutClock | 0/80 | 0/240 | 0/440 |
| ignoreTableLock | 6/80 (6, 13, 18, 19, 22, 25) | 0/240 | 91/440 (1, 2, 3, 4, 5, 6, ...) |
| publishWithoutClock | 0/80 | 0/240 | 0/440 |
| validateFromT | 0/80 | 0/240 | 0/440 |
| trustLocks | 0/80 | 17/240 (3, 4, 7, 9, 17, 18, ...) | 0/440 |
| rowSpanDespiteUnique | 44/80 (1, 2, 3, 4, 5, 6, ...) | 0/240 | 0/440 |
| repinOnRestore | 0/80 | 0/240 | 0/440 |
| replayAcrossSchemaChange | 0/80 | 0/240 | 0/440 |
| dropWithoutGuard | 0/80 | 0/240 | 0/440 |

## Replay column after the first slice (code ac92184, seeds 1..40)

The replay check now has 3 seeded tests per seed (the third is the first slice: transactions that change the schema).

| fault | replay |
|---|---|
| none | 0/120 |
| autoIgnoresUniqueIntents | 0/120 |
| ddlIgnoresIntents | 27/120 (1, 3, 4, 5, 6, 7, ...) |
| childKeepsOldSchema | 0/120 |
| noSchemaRecheck | 0/120 |
| noWriteSetLimit | 0/120 |
| noRealtimeBump | 0/120 |
| anchorNoAbsorb | 1/120 (30) |
| skipReadOnlyPrepare | 29/120 (1, 4, 7, 9, 14, 16, ...) |
| refreshNoBump | 1/120 (13) |
| predicateProtected | 3/120 (14, 22, 25) |
| ignoreIntentsInValidation | 47/120 (1, 2, 4, 5, 6, 7, ...) |
| readerTimeoutPass | 78/120 (1, 2, 3, 4, 5, 6, ...) |
| hlcNoCeiling | 1/120 (14) |
| rowwiseUndo | 16/120 (3, 4, 6, 7, 9, 11, ...) |
| pushAfterDecide | 29/120 (1, 3, 4, 5, 6, 7, ...) |
| applyAfterMoved | 0/120 |
| triggerCapture | 0/120 |
| dropIntentsOnMove | 0/120 |
| servePastMove | 0/120 |
| ignoreFence | 0/120 |
| staleWideRead | 0/120 |
| finishWithoutClock | 0/120 |
| ignoreTableLock | 6/120 (6, 13, 18, 19, 22, 25) |
| publishWithoutClock | 0/120 |
| validateFromT | 0/120 |
| trustLocks | 0/120 |
| rowSpanDespiteUnique | 46/120 (1, 2, 3, 4, 5, 6, ...) |
| repinOnRestore | 0/120 |
| replayAcrossSchemaChange | 7/120 (1, 6, 30, 31, 32, 37, ...) |
| dropWithoutGuard | 0/120 |
| noImplicitCommit | 40/120 (1, 2, 3, 4, 5, 6, ...) |
| ddlAfterFailedCommit | 39/120 (1, 2, 3, 4, 5, 6, ...) |

## ignoreFence after the settle-loop fix (2026-11-12, branch `applies`)

The settle loop now yields and retries a decided transaction at most 10 times, then fails the read with `stuck:`
(open problem 18). Seeds 1–40, same harnesses:

| fault | replay | history | ddl-concurrent |
|---|---|---|---|
| none | 0/120 | 0/240 | 0/440 |
| ignoreFence | 0/120 | 75/240 (1, 2, 3, 4, 5, 7, ...) | 80/440 (1, 2, 3, 4, 5, 6, ...) |

No run hangs any more.
