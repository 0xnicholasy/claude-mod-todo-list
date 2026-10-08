# Concurrency and failure-path hardening

ultraplan: harden-concurrency | branch: feat/harden-concurrency | base: main | tag: pre-harden-concurrency-main | created: 2026-10-08
Status: ACTIVE
Progress: 2/9 done

## Goal
The mod must behave correctly when Claude runs tool calls in parallel and when a write or a mirror fails. Specifically:
- The gate denies exactly MAX_DENIES calls per turn, pauses once and toasts once.
- The status line keeps "Running" until the last parallel call ends.
- A mirrored task always marks the turn planned.
- A dropped mirror is visible once per session.
- A test locks the plan tool's failure path.

## Constraints
- Package manager: npm. Pure logic lives in its own module under `.claude/skills/todo-list/hooks/` with a `*.test.ts` beside it, and tests import `'claude-code/testing'`. `register.tsx` only wires.
- State lives in `$.state` atoms declared inline in `types/index.d.ts` (no type alias in PluginState). Helpers that take `$` are top-level `function` declarations, not const arrows (fix 10a8cf1).
- Never edit `vendor/claude-code/claude-code.d.ts` (CC 2.1.289). `hooks.json` takes one module.
- No emoji. No `any`/`unknown` without a justifying comment. No `// eslint-disable`.
- Gate invariant: the gate denies only blocked main-loop tools while the task has no plan. It fails open on a guard failure, an unregistered or unoffered tool, enforcement off, or 3 denies in a turn.
- Every todo's verify includes `rtk proxy npm run check` (validate + typecheck + test; a bare nested `npm run` breaks under the RTK hook) and the CI equivalent `npm ci && npm run typecheck`.
- Each todo gets an independent review by the `codex` subagent, which does not see the author's reasoning. The author may not clear its own change.
- Re-verify first: before a workstream's first todo, re-read its cited lines. If the premise no longer holds, mark the todo `skipped (<reason>)` and log it to `tasks/research/STATE.md`. Do not improvise a replacement.
- Emergent forks: take the lowest-risk reversible option and log it in one line to `tasks/research/STATE.md`. Failure-mode lessons that a test cannot lock go to `tasks/lessons.md`. `tasks/` is gitignored and stays local.
- Preserve every mitigation listed in a todo. Removing or weakening one requires stopping for review.
- Two strikes on the same step: revert, take the simplest working alternative, and log why.
- Never deploy. Never push to main. Never add a dependency without flagging it in the PR body. Never read `.env`. The final landing PR into main is a HARD STOP for a human merge.
- Update README.md where behaviour changes. Use conventional commits `fix(todo-list): ...` / `test(todo-list): ...`.
- File-overlap rule: no two todos that edit the same file run in parallel. `needs:` serializes them. Every merge leaves feat/harden-concurrency green.

## Decisions
- D1 Land once at the end. The owner merges the landing PR into main. (owner, 2026-10-08)
- D2 No enabler PR: `.github/workflows/ci.yml` already runs on `feat/**` (lines 4, 6). | confirmed by T01 (CI ran on PR #26)
- D3 No self-heal for dropped mirrors. A status-only update cannot rebuild a title, and late updates can bring deleted tasks back. (owner reviewer, 2026-10-08)
- D4 `activity.running` entries are `Array<{ id: string; tool: string }>`, not `string[]`. Three needs drive this: the label must fall back to the previous still-running call's name when the newest ends, the name fallback must work, and a start without an id gets a synthetic id `name:<tool>`. | assumed, confirm by T03

## Todos

### T01 Lock the plan-tool failure path with a test
- status: done (#26, 2026-10-08)
- needs: none
- size: S
- scope: Extend the gateSetup corruption seam (register.test.ts:614-625) to cover the `plan` atom as a one-shot. The first `state.get` for key `plan` returns a malformed value and then the flag clears itself. Add `plan` to the `corrupt` shape as an optional field so the two existing callers (`{ task: false, toast: false }` at :680, :719) keep compiling. Add one case that does these steps in order: (1) turn.start; (2) a plan `set` call; (3) assert the result equals `'Error: the plan tool failed. Try again.'` (register.tsx:494); (4) a following `{ op: 'show' }` reports "No plan yet"; (5) Edit is still denied. Mitigations: the seam must be one-shot. Do a mutation check: move `await update($, task, onPlanTouched)` above the plan `update` in `answerPlanCall` (register.tsx:243-249), show that the new test fails, then restore. Test-only change.
- files: .claude/skills/todo-list/hooks/register.test.ts (gateSetup :614-633, new case after :689)
- done when: the new case passes at HEAD and fails under the mutation, and the output of the failing run is recorded in the PR body. `rg -n "plan tool failed" .claude/skills/todo-list/hooks/register.test.ts` finds the assertion. No non-test file changed.
- verify: `rtk proxy npm run check`; `npm ci && npm run typecheck`; mutation run: `rtk proxy npm run test` with the move applied (expect 1 failure), then `git diff --stat` shows only register.test.ts

### T02 Reset the mirror() outcome on every CAS attempt
- status: done (#PR, 2026-10-08)
- needs: T01
- size: S
- scope: In `mirror()` (register.tsx:257-277), `let failure` is set on error and never cleared across `update` retries (vendor d.ts:13981-13987 retries on an ifVersion miss; concurrent PostToolUse is permitted, d.ts:7507). Replace it with an outcome that every reducer attempt reassigns whole, following the `applied` pattern in answerPlanCall (register.tsx:242-247). Add a register.test.ts seam: an `on('state.set', ...)` that, on the first write to key `plan` only, swaps in a different plan and returns `{ isSet: false, version }` to force one miss (StateSetResult, d.ts:11533-11539). Two cases:
  - Error-then-success: the start plan has 60 nodes, so TaskCreate hits MAX_NODES (plan.ts:13). The seam swaps in a smaller plan, and the retry succeeds. Assert the plan contains the task, the status line shows it, and Edit is allowed.
  - Success-then-error: the start plan has 59 nodes, the seam swaps in a 60-node plan, and the retry fails. Assert the task stays unplanned and Edit is denied.
  If the harness does not route `update` writes through `state.set` hooks, log the fork to STATE.md and drive the miss through the lowest-risk alternative seam.
- files: .claude/skills/todo-list/hooks/register.tsx (:257-277), .claude/skills/todo-list/hooks/register.test.ts
- done when: the error-then-success case fails at HEAD (shown before the fix) and passes after it, and the success-then-error case passes both before and after. The `mirror` outcome variable is assigned on every reducer path.
- verify: `rtk proxy npm run check`; `npm ci && npm run typecheck`

### T03 Track running tool calls in the activity reducer (pure)
- status: todo
- needs: none
- size: M
- scope: Add `running: Array<{ id: string; tool: string }>` (D4) inline to the `activity` atom (types/index.d.ts:64-71) and to the named `ActivityState` (:34-41). `emptyActivity` (activity.ts:31) defaults it to `[]`. Event changes:
  - `toolStart` takes `{ tool; id?: string }` and appends an entry, using id `name:<tool>` when none is given.
  - `toolEnd` takes `{ id?: string; tool?: string }` and removes by id. When the id is absent or unknown, it removes the oldest synthetic entry with the same tool. When neither id nor tool is given, it clears all entries (the current behaviour, so register.tsx stays green unchanged).
  - Phase falls to `working` only when `running` is empty. The label is the most recently started call that is still running.
  - `turnStart`, `turnComplete` (main loop) and `sessionClear` clear `running`.
  - Permission stays orthogonal: PermissionRequest has no id.
  Fix the ActivityState literals in tree.ts and tree.test.ts that the new required field breaks.
  Mitigations: match by id, using the name only as a fallback. Keep the turn-boundary clear so a stuck label lasts at most one turn.
- files: .claude/skills/todo-list/types/index.d.ts (:34-41, :64-71), .claude/skills/todo-list/hooks/activity.ts (:18-31, :77-81, :116-117), .claude/skills/todo-list/hooks/activity.test.ts, .claude/skills/todo-list/hooks/tree.ts, .claude/skills/todo-list/hooks/tree.test.ts
- done when: activity.test.ts covers the cases below. `claude plugin validate` accepts the atom. Existing activity and tree tests pass.
  - Two starts and one end by id: phase is still `tool` and the label shows the other call.
  - Ending the newest call reverts the label to the older one.
  - Ending the last call gives `working`.
  - An unknown id is a no-op.
  - The name fallback removes only a synthetic entry.
  - turnStart, turnComplete and sessionClear empty `running`.
- verify: `rtk proxy npm run check`; `npm ci && npm run typecheck`

### T04 Extract a pure gate transition (decision plus deny count)
- status: todo
- needs: none
- size: S
- scope: In gate.ts, add `transition(cur: TaskState, input: Omit<GateInput, 'planned' | 'denies'>)`. It returns `{ next: TaskState; decision: GateDecision; toast: 'deny' | 'pause' | null }`. The decision is `decideGate({ ...input, planned: cur.planned, denies: cur.denies })` (gate.ts:45-54). Keep the decideGate ordering, so planned, offered, off and disabled inputs allow without an increment. Transitions:
  - deny: `denies + 1`, with toast `deny` only when `cur.denies === 0`.
  - pause at `cur.denies === MAX_DENIES`: `denies + 1`, toast `pause`.
  - pause at `denies > MAX_DENIES`: return `cur` unchanged, no toast.
  - allow: `cur` unchanged.
  No wiring in this todo.
- files: .claude/skills/todo-list/hooks/gate.ts (:21-64), .claude/skills/todo-list/hooks/gate.test.ts
- done when: gate.test.ts walks denies 0 through 5 and asserts decision, next.denies and toast at each step. It also asserts that planned, unoffered, enforcement-off and agentId inputs leave `denies` unchanged with toast null, and that the >MAX_DENIES case returns the same object reference.
- verify: `rtk proxy npm run check`; `npm ci && npm run typecheck`

### T05 Make an unknown-id TaskUpdate an explicit ignored outcome
- status: todo
- needs: T02
- size: S
- scope: Today `ingestTaskUpdate` (ingest.ts:55-57) returns `{ plan }` for an unknown taskId, and `mirror` still runs `onPlanTouched` (register.tsx:275-276). Return a distinct `{ ignored: '<stable reason>' }` outcome instead, and widen the result type. In `mirror`, an ignored outcome debug-logs only and skips `onPlanTouched` and the status refresh. No toast: an ignored outcome is not a drop.
- files: .claude/skills/todo-list/hooks/ingest.ts (:44-57 and the result type), .claude/skills/todo-list/hooks/ingest.test.ts, .claude/skills/todo-list/hooks/register.tsx (mirror :257-277), .claude/skills/todo-list/hooks/register.test.ts
- done when: ingest.test.ts asserts that an unknown id gives `ignored`. A register.test.ts case covers a fresh turn plus a TaskUpdate for an unknown id: Edit is still denied (no onPlanTouched) and no toast fires.
- verify: `rtk proxy npm run check`; `npm ci && npm run typecheck`

### T06 Show a dropped mirror once per session
- status: todo
- needs: T05, T03
- size: M
- scope:
  - Reporter: add one central top-level `function reportDrop($, reason)` in register.tsx. Both mirror errors (register.tsx:270-273) and the afterTool parse failures (register.tsx:306-317, parsers in post-tool.ts:21-62) call it.
  - Toast: the reporter shows one `safeToast` with a stable reason string that carries no user content. The strings are exported constants in ingest.ts. The existing debug log stays.
  - "Already shown" flag: a new boolean atom, declared inline in types/index.d.ts and claimed with a CAS `update` (false to true). Only the attempt that wins the claim toasts. Verify that the host resets atoms on /clear (register.tsx:322-323); if it does not, reset the flag explicitly in the session-clear path.
  - README: document the toast in the mirroring section.
  Mitigations: T02 lands first. The once-flag is a CAS atom. Reason strings are stable and free of user content. A successful retry shows no toast.
- files: .claude/skills/todo-list/types/index.d.ts, .claude/skills/todo-list/hooks/ingest.ts, .claude/skills/todo-list/hooks/ingest.test.ts, .claude/skills/todo-list/hooks/register.tsx (:255-319), .claude/skills/todo-list/hooks/register.test.ts, README.md (mirroring section near line 131)
- done when: register.test.ts shows each of the following:
  - A 60-node plan plus TaskCreate gives one toast and leaves the plan unchanged.
  - Two concurrent failures (Promise.all of two PostToolUse) give one toast.
  - A failure followed by a successful retry, using the T02 seam, gives no toast.
  - An unknown-id TaskUpdate gives no toast and no onPlanTouched.
  - An unrecognised TaskCreate response gives one toast.
  - After a session clear, a new failure toasts again.
  - The toast text contains no subject or title from the input.
  ingest.test.ts asserts the reason constants contain no input text.
- verify: `rtk proxy npm run check`; `npm ci && npm run typecheck`

### T07 Wire tool_use_id so a parallel batch keeps "Running"
- status: todo
- needs: T06
- size: M
- scope:
  - In the catch-all tool.call hook (register.tsx:485), pass `e.tool_use_id` (ToolCallEnvelope, d.ts:12088-12103) into `toolStart`.
  - `endTool` (register.tsx:282-291) takes an id and a tool. Pass `e.tool_use_id` (typed `string` on PostToolUse/PostToolUseFailure, d.ts:7525, 7540) and the tool name from classic.PostToolUse (:503-509) and classic.PostToolUseFailure (:511-515).
  - post-tool.ts changes only if the id turns out empty at runtime. In that case add a `toolUseId()` helper with a test in post-tool.test.ts.
  - README activity table (line 106): a parallel batch shows the most recently started call until the last one ends.
- files: .claude/skills/todo-list/hooks/register.tsx (:282-291, :469-515), .claude/skills/todo-list/hooks/register.test.ts, README.md (:101-113); conditional: .claude/skills/todo-list/hooks/post-tool.ts, .claude/skills/todo-list/hooks/post-tool.test.ts
- done when: register.test.ts runs two concurrent `$.tool.call` with distinct `tool_use_id`, then one `classic.PostToolUse` for the first id. The status line is still `Running <other tool>`. After the second PostToolUse it shows Working. A PostToolUseFailure for an unknown id leaves the status unchanged.
- verify: `rtk proxy npm run check`; `npm ci && npm run typecheck`; live: `claude --plugin-dir .claude/skills/todo-list`. In one message, ask for one Agent call and one Bash call in parallel. Read the status line: it shows Running until both end. Record the observed lines in the PR body and in the Log.

### T08 Make the gate decision and the deny count one atomic transition
- status: todo
- needs: T07, T04
- size: M
- scope: In `runGate` (register.tsx:209-231), `t` comes from a snapshot read (:210), and the decision and toasts use the stale `t` (:223-225). Rewrite as follows:
  - Read `planTool` and `enforceSession` as a snapshot, as today.
  - Call `update($, task, cur => { out = transition(cur, input); return out.next })`, where `out` is reassigned on every reducer attempt.
  - Return `out.decision`.
  - Fire the deny or pause toast from `out.toast` only after `update` resolves, outside the reducer.
  Optional fast path: when the snapshot decision is `allow`, skip the write. Within a turn `planned` only goes false to true, so a snapshot allow is safe. If taken, log it to STATE.md.
  Mitigations:
  - Pure transition tests from T04.
  - A concurrent register test: Promise.all of 4 `$.tool.call(EDIT)` gives exactly MAX_DENIES denies, one deny toast and one pause toast. Show it FAILS before the fix. If Promise.all does not reproduce the race, add a deterministic CAS-miss seam on `task` writes and log the fork to STATE.md.
  - The existing sequential test (register.test.ts:700-716) stays green: 3 denies, pause on the 4th, then allows.
  - Side effects stay outside the retrying reducer.
- files: .claude/skills/todo-list/hooks/register.tsx (:205-231), .claude/skills/todo-list/hooks/register.test.ts (gate block :610-725)
- done when: the concurrent test fails at the T07 head and passes after the change, with both runs' output recorded in the PR body. The sequential gate test, the fail-open tests (:679-689) and the throwing-toast test (:718+) pass. `runGate` has no reference to a pre-update `t.denies`.
- verify: `rtk proxy npm run check`; `npm ci && npm run typecheck`

### TZZ Cleanup and land
- status: todo
- needs: every other todo
- scope: run `/implement cleanup`
- done when: skill removed from the branch, TODO.md archived, landing PR into main open and approved by the owner

## Backlog

## Log
- 2026-10-08 T01 done: plan-tool failure path locked by a register.test.ts case; mutation check failed as expected (#26)
- 2026-10-08 T02 done: mirror() reassigns its whole outcome on every CAS attempt; a forced-miss state.set seam covers error-then-success and success-then-error (#PR)
