# harden-concurrency follow-ups

Open low-severity doc items found by the PR #36 hardening review (merged 2026-10-09, merge commit 7e7f9af), not yet fixed. Owner: repo owner.

## Open

- C-26, `README.md:131`: the TaskCreate, TaskUpdate and TodoWrite mirroring section says every successful mirrored call counts as having a plan. An unknown-id TaskUpdate is now an ignored outcome that does not count as having a plan. The sentence should say so.
- C-16, `README.md:190` (hook table, `classic.PostToolUse` row): the "Decides" cell says an unrecognised response is logged and skipped. It also shows a once-per-session "Plan not updated" toast, and the row omits that an unknown-id TaskUpdate is ignored. The row should state both.
- C-27, `README.md:187` (hook table, `session.end` row): says it only resets activity on `/clear`. It now also resets `dropShown`, which re-arms the drop toast. The row should say so.

## Done

- E-11: removed the stale parallel-calls known-limitation bullet in a5c4498.
- C-20: added the `PermissionDenied` `permissionEnd` tool-name guard in 3e7ddb5.
