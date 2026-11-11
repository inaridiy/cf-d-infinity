# Plans in this repository

A plan file exists so that work can be resumed by someone who was not in the session: another agent, another
person, or the same agent after its context is gone. Keep it proportional. A small, single-session change needs
no plan file.

- Plans live under `.agents/execplans/`, named `<date>-<topic>.md`. Evidence that a plan cites (reports, logs)
  goes under `.agents/execplans/evidence/`.
- The top of the file says what is true now: goal, the owner's constraints, current state of the branch, current
  design decisions. Write decisions in the present tense. When a decision is reversed, rewrite the present-tense
  text and record the reversal in the Decision Log; do not leave both versions as instructions.
- Keep these sections current at milestones, direction changes and stopping points: `Progress` (checklist with
  commits), `未解決の問題` / open problems, `Surprises & Discoveries`, `Decision Log`, `Plan of Work`,
  `Validation and Acceptance`, `Recovery and Retained Artifacts`, `Outcomes & Retrospective`.
- Never mark a check that did not run as done. Write "not run" and why.
- Name files by repository-relative path and give commands with their working directory.
- The plan is context, not authority. A new instruction from the owner and the code as it is both win over it;
  fix the plan when they disagree.
- Language: plans may be written in Japanese, like the other development documents here.
