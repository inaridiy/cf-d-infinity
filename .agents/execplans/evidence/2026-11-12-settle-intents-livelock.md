Found while building the fault table (Plan of Work 5), 2026-11-12.

With the fault switch `ignoreFence` (a parent keeps accepting requests for a range it has fenced), the history check
`stays serializable with splits and restarts (seed 27)` never finishes. It ran for 11.5 hours at 100% of one core
before the table runner was stopped; the test's own time limit and the simulator's stall detector never fired.

Reproduce (it does not stop by itself; kill it):

    cd packages/cf-d-infinity
    FAULT=ignoreFence SEEDS=27 node node_modules/vitest/vitest.mjs run test/history.test.ts --project sim -t "seed 27\b"

Pausing the run through the inspector stops it in `ShardCore.settleIntents` (src/shard/core.ts). That loop asks each
pending intent's anchor for the outcome; if committed it calls `finalize`, then looks for pending intents again.
If `finalize` leaves the intent in place, the loop asks again forever. When the anchor is the shard itself, `ask` and
`finalize` resolve through microtasks only, so the loop never yields to timers or to the simulator's events: the
event loop starves, which is why no time limit fires.

Reading: the fault creates an intent that is committed but cannot be applied where it sits (the parent took a
prepare after it fenced the range). That is the symptom of invariant 2 (a committed transaction can always be
applied). The loop has no progress check, so the failure shows up as a livelock instead of an error. Not fixed here.
