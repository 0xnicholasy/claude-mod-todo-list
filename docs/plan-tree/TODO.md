# Plan Tree: plugin-driven task plans with live Claude state

ultraplan: plan-tree | branch: feat/plan-tree | base: main | tag: pre-plan-tree-main | created: 2026-10-05
Status: ACTIVE
Progress: 11/14 done

## Goal
With the plugin loaded, every prompt that leads to tool use gets a plan tree that Claude writes through the plugin's own `mcp__todo-list__plan` tool. That tree is the only record of progress. A pane and status line draw it as a box-drawing tree with per-node status (Completed, In progress, Pending, Blocked, Skipped). They also show what Claude is doing now: working, running a tool, waiting for permission, waiting for your answer, compacting, interrupted, error, and how many subagents are running. State-changing tools are blocked until a plan exists. Enforcement fails open and the user can switch it off.

## Constraints
- Keep the repo scaffold: package.json, tsconfig.json, CI, vendor/claude-code/claude-code.d.ts (never edited), hooks.json, plugin layout under `.claude/skills/todo-list/`.
- State only in `$.state` atoms declared inline in `types/index.d.ts`. No alias refs in PluginState, no recursive types, no module variables.
- Pure logic in its own modules under `hooks/`, each with a `*.test.ts` beside it importing `'claude-code/testing'`. `register.tsx` only wires.
- No emoji in code. Box-drawing and geometric glyphs only; a test asserts that no glyph matches `/\p{Extended_Pictographic}/u`.
- No `any` or `unknown` without a justifying comment. Never `// eslint-disable`.
- All model-supplied text goes through `clean()` (control, bidi and zero-width characters stripped) before it reaches state or the terminal.
- `npm run check` (validate + typecheck + test) is green after every todo merges into feat/plan-tree. CI runs typecheck only.
- Never block the plan tool, AskUserQuestion or read-only tools (Read, Grep, Glob, LSP, WebFetch, WebSearch, ToolSearch, TaskGet, ListMcpResourcesTool, ReadMcpResourceTool, Skill).
- Every hook body runs inside `guard()`. A throw in the gate path allows the call (fails open).
- Built by a `sonnet` implementation agent. README.md is updated.
- One landing PR from feat/plan-tree into main (D1).
- `hooks.json` takes one module; new modules are imported from `register.tsx` (a second hooks.json entry fails validate). `$` may only be passed to top-level function declarations.
- Plan-tool errors are result text starting with `Error:`; a hook-set `isError` is ignored (T01 Q3). Tests call the plan tool by its literal name `mcp__todo-list__plan`; `$.tool.register` is not available under `claude plugin test` (T01 Q9).

## Decisions
- D1 Land once at the end: one landing PR from feat/plan-tree into main. (owner, 2026-10-05)
- D2 Enforcement = BLOCK. While no plan exists for the current task, state-changing main-loop tool calls are denied with a message telling Claude to create the plan first. The project CLAUDE.md rule "The nudge never blocks: no hook returns deny" is removed (in T10). (owner, 2026-10-05)
- D3 Threshold: any prompt that leads to tool use gets a plan; pure Q&A stays plan-free. Read-only tools never trigger the gate, so a Q&A turn that only reads is never blocked. (owner, 2026-10-05)
- D4 Names stay: plugin `todo-list`, tool `mcp__todo-list__plan` (short name `plan`), command `/todo`. Avoids moving the settings key and a possible clash with a built-in `/plan` (the API refuses built-in names, vendor d.ts ~2982). | confirmed by T01
- D5 The plan is a flat node list with `parentId` and stable path ids ("1", "2.1", "2.1.3"). Ids are never reused after a remove. Max depth 3, max 60 nodes. Inline atom types cannot be recursive. | assumed, confirm by T02
- D6 Blocked set (main loop only, `agentId` absent): Edit, Write, NotebookEdit, Bash, Agent, Workflow, CronCreate, CronDelete, EnterWorktree, ExitWorktree, RemoteTrigger. Everything else is allowed, including third-party MCP tools, because the API gives no read-only flag before a call runs (ToolInfo 12413-12427 has none). Subagent calls pass, because blocking Agent already forces a plan before any subagent exists. | assumed, confirm by T13
- D7 Task boundary: a new task starts at `turn.start` for the main loop when the text is non-empty AND does not start with `<task-notification>`. A background-agent completion is a continuation, not a new task (T01 Q7). The task counts as planned if the plan already has unfinished nodes, or once Claude makes any successful plan-tool call or a mirrored TodoWrite/TaskCreate/TaskUpdate call in this task. | revised by T01
- D8 Escape hatches. The gate denies only when all hold: enforcement is on (plugin `userConfig.enforce`, default true, AND the session flag set by `/todo on|off`); the plan tool registered this session; the plan tool was in the last request's `prompt.compose` tool list; the current task has no plan. A throw anywhere in the gate allows the call. After 3 denies in one turn with no plan call, the gate pauses for the rest of that turn and shows a toast. | confirmed by T01 (userConfig delivery, pinned tool in `e.tools`, model retries after a deny; see spike.md); confirmed by T10 (gate itself)
- D9 Manual list editing (`/todo add|start|done|rm`) is removed. `/todo` keeps `open` (no args), `off`, `on` and `clear`. The owner wants no hand-filled lists. | assumed, confirm by T07
- D10 TodoWrite, TaskCreate and TaskUpdate are mirrored into the tree when they are offered, and they satisfy the gate. The plan tool stays the preferred path in the instructions. TodoWrite does not exist in 2.1.289 and TaskCreate/TaskUpdate are not offered by default (T01 Q6). Mirroring is optional coverage for sessions that enable them; the plan tool is the only default path. | revised by T01, confirm by T08
- D11 Node statuses: pending, in_progress, completed, blocked (with note), skipped (with note). A parent's status rolls up from its children. Session activity statuses come only from events; see the plan.md table. | assumed, confirm by T05
- D12 The current plan reaches the model as `prompt.submit` context on each new prompt, not in the system prompt. Keeps the prompt cache stable and resyncs ids after compaction. | assumed, confirm by T07

## Todos

### T01 Spike: prove plan-tool registration, call handling, deny and event signals live
- status: done (#2, 2026-10-05)
- needs: none
- size: M
- scope: On a throwaway branch `spike/plan-tool` cut from feat/plan-tree, add a minimal second hooks module that registers `plan` in session.start, pins it with tool.describe `isDeferred: false`, allows it in tool.check, answers it from a tool.call hook, denies Edit, Bash and Agent from tool.call, and logs turn.start, turn.complete, tool.check (ask), classic.PermissionRequest, classic.Notification, classic.SubagentStart/Stop, classic.StopFailure, session.compact and session.end to the debug log. Answer Q1-Q10 (plan.md) in `docs/plan-tree/spike.md` with observed evidence. Only the doc merges; spike code never lands on feat/plan-tree.
- files: docs/plan-tree/spike.md (new); spike-only: .claude/skills/todo-list/hooks/spike.tsx, .claude/skills/todo-list/hooks/hooks.json, .claude/skills/todo-list/.claude-plugin/plugin.json (userConfig probe)
- done when: spike.md has an observed answer (log excerpt or screen note) for each of Q1-Q10; D4 and D8 are marked confirmed or revised in this file; feat/plan-tree contains only the doc.
- verify: `claude --plugin-dir .claude/skills/todo-list --debug` on the spike branch following the Q1-Q10 script in plan.md; then on feat/plan-tree `git diff --stat main` shows only docs/plan-tree/*; `npm run check`

### T02 Add the plan data model, reducers and new atoms
- status: done (#4, 2026-10-05)
- needs: T01
- size: M
- scope: Add new atoms inline in types/index.d.ts next to the old ones (old atoms stay until T11): `plan` { title; nodes: Array<{ id, parentId: string | null, title, activeForm?, status, note?, source: 'plan' | 'todo' | 'task', externalId?, updatedAt }> }, `task` { open, planned, denies }, `activity` { phase, tool?, detail?, subagents: string[], since }, `enforceSession` boolean, `planTool` { name: string | null; offered: boolean }; export matching named types. Add `hooks/sanitize.ts` holding `clean()` with its test ported. Add `hooks/plan.ts` with pure ops `setPlan`, `addNodes`, `updateNodes`, `removeNode`, `rollup`, `progress` (counts leaves), `currentNode`, `hasUnfinished`, enforcing depth 3, 60 nodes, title 120 chars, note 200 chars. Every op returns `{ plan } | { error }` and never throws.
- files: .claude/skills/todo-list/types/index.d.ts (append), .claude/skills/todo-list/hooks/sanitize.ts (new), .claude/skills/todo-list/hooks/sanitize.test.ts (new), .claude/skills/todo-list/hooks/plan.ts (new), .claude/skills/todo-list/hooks/plan.test.ts (new)
- done when: plan.test.ts covers: set assigns ids 1, 1.1, 1.1.1; add under a parent takes max sibling id + 1 and never reuses a removed id; update of an unknown id returns an error listing valid ids; remove drops the subtree; rollup (all children completed/skipped gives completed, any in_progress gives in_progress, any blocked with none in_progress gives blocked); each limit errors; a title containing `\u001b[2J` is stored cleaned. `claude plugin validate` accepts the new atoms. Old code and tests still pass.
- verify: `npm run check`

### T03 Define the plan tool contract: schema, input parsing, model-facing result text
- status: done (#7, 2026-10-05)
- needs: T02
- size: S
- scope: Add `hooks/plan-tool.ts`: `PLAN_TOOL_SHORT_NAME = 'plan'`; `PLAN_TOOL_DESCRIPTION`; `PLAN_INPUT_SCHEMA` (op `set | add | update | remove | show`, `title`, `nodes` with nested `children` written out to depth 3, no `$ref`, `parent`, `updates[{ id, status?, title?, note? }]`, `id`); `parsePlanInput(raw)` turning loose tool.call arguments into a typed op or `{ error }` (raw is `unknown` per McpToolCallInputFallback 5795-5807; justify in a comment); `formatForModel(plan)`, a plain-text tree of ids, status words and titles capped at 4,000 chars. Errors are returned as `Error:`-prefixed result text (a hook-set `isError` is ignored, T01 Q3); the contract has no isError option.
- files: .claude/skills/todo-list/hooks/plan-tool.ts (new), .claude/skills/todo-list/hooks/plan-tool.test.ts (new)
- done when: tests show each op parses from a realistic raw object; missing `op`, a wrong-typed field and depth 4 each give a specific error; formatForModel output contains every id and status word with no ANSI escapes; the schema's `op` enum matches the parser's accepted ops (a test reads both).
- verify: `npm run check`

### T04 Build the tree renderer and status-line text
- status: done (#6, 2026-10-05)
- needs: T02
- size: M
- scope: Add `hooks/tree.ts`. `buildTree(plan, activity, { maxLines })` returns `Line[]` (`text`, `color?`, `bold`, `dim`, `inverse`): header (title, `done/total`, 14-cell `█`/`░` bar, percentage); activity line; nodes with `├─ └─ │` connectors and per-status glyph and colour (completed `✓` green dim, in_progress `◉` cyan bold, pending `○` default, blocked `■` yellow with note, skipped `–` dim strikethrough); current node bold + inverse with ancestors always expanded; completed branches collapsed to `✓ <title> (n/n)`; past maxLines the path to the current node is kept and the rest becomes `+N more`. Empty state "No plan yet." `statusLine(plan, activity)` returns e.g. `Plan 3/7 · Escaping quotes · Waiting for permission: Bash`, or undefined with no plan and idle.
- files: .claude/skills/todo-list/hooks/tree.ts (new), .claude/skills/todo-list/hooks/tree.test.ts (new)
- done when: tree.test.ts asserts exact lines for a 2-level fixture; connector choice for last and non-last children; collapse of a completed branch; a current node 3 levels deep stays visible at maxLines 6 with an accurate `+N more`; the status line for each activity phase; no glyph matches `/\p{Extended_Pictographic}/u`.
- verify: `npm run check`

### T05 Build the activity reducer (Claude state from events)
- status: done (#5, 2026-10-05)
- needs: T02
- size: S
- scope: Add `hooks/activity.ts`, pure `reduceActivity(prev, event, now)`. Events: turnStart, turnComplete(reason), toolStart(tool), toolEnd, permissionAsk(tool), questionOpen, questionClose, compactStart, compactEnd, subagentStart(id), subagentStop(id), stopFailure(detail). Phases: idle, working, tool, permission, question, compacting, interrupted, error. Precedence question > permission > compacting > tool > working. Subagent ids form a set (duplicate start counts once; unknown stop is a no-op). `activityLabel(activity)` returns the label table in plan.md. turnComplete events carrying an `agentId` are ignored, so only main-loop turn ends move to idle, interrupted or error. A user rejecting a dialog ends as reason `answer` (idle), not aborted. Add a `sessionClear` event that resets activity. Subagent ids stay a set, because Start/Stop events from unrelated background agents can arrive.
- files: .claude/skills/todo-list/hooks/activity.ts (new), .claude/skills/todo-list/hooks/activity.test.ts (new)
- done when: tests cover every transition in the plan.md table; precedence (permission during a tool shows permission; toolEnd returns to working); turnComplete reasons map aborted to interrupted, error/refusal to error, answer to idle; subagent set semantics; a turnComplete with an `agentId` leaves activity unchanged; a rejected dialog (reason `answer`) ends idle, not interrupted; sessionClear resets activity; a Start/Stop from an unrelated background agent keeps the set consistent.
- verify: `npm run check`

### T06 Build the gate decision, task lifecycle and prompt texts
- status: done (#8, 2026-10-05)
- needs: T02
- size: S
- scope: Add `hooks/gate.ts`: `BLOCKED_TOOLS` (D6); `decideGate({ tool, agentId, isPlanTool, enforceConfig, enforceSession, toolRegistered, toolOffered, planned, denies })` returning `allow`, `deny(message)` or `pause(toast)` with `MAX_DENIES = 3`; `onNewPrompt(task, plan)` (D7; text prefixed `<task-notification>` is a continuation, not a new task) and `onPlanTouched(task)`; `INSTRUCTION_TEXT` (system-prompt section: plan before any tool use, keep statuses current, use blocked/skipped with a note, ask via AskUserQuestion when unclear); `planContext(plan, toolName)` for prompt.submit; `denyText(tool, toolName)` naming the full tool name and the `set` op, never mentioning `/todo off` (that goes only to the user toast). `denyText` must spell out the exact call, for example `mcp__todo-list__plan` with `{"op":"set","title":...,"nodes":[{"title":...}]}`, because the model retried a vague deny 3 times (T01 Q5).
- files: .claude/skills/todo-list/hooks/gate.ts (new), .claude/skills/todo-list/hooks/gate.test.ts (new)
- done when: tests show Edit, Bash and Agent denied with no plan; Read, Grep, Glob, AskUserQuestion, WebSearch, the plan tool and an unknown `mcp__x__y` allowed; each fail-open input (enforce off, not registered, not offered, agentId set) allows; the 4th call after 3 denies returns pause; a new prompt with an unfinished plan is planned, with a finished or empty plan is not; a `<task-notification>` prompt keeps the task planned; `denyText` contains `mcp__todo-list__plan` and the `set` op shape.
- verify: `npm run check`

### T07 Switch register.tsx to the plan tool, tree pane and status line
- status: done (#9, 2026-10-05)
- needs: T03, T04, T06
- size: M
- scope: Rewrite the wiring in register.tsx: session.start `$.tool.register` (store the returned name in `planTool`; a failure is logged and leaves it null) and `$.command.register('todo')`; `tool.describe` pins `isDeferred: false` on the plan tool (required, T01 Q2); no `tool.check` allow for the plan tool, because the tool.call hook answers before any check (T01 Q4); `tool.call` on the plan tool (main loop: parse, reducer, `formatForModel`; a subagent gets a "plan is owned by the main session" result); prompt.compose adds the section and sets `planTool.offered` = the name is in `e.tools` AND the pin was applied (`e.tools` also lists deferred tools); prompt.submit attaches `planContext` when a plan exists; turn.start runs the task lifecycle; `ui.render` Pane draws `buildTree` (columns 48, rows 20); `ui.status`; `/todo` handles only open and clear. Tests stub registration and call by the literal name `mcp__todo-list__plan`. Remove the old TodoWrite/Task* hooks, nudge, manual subcommands and their register.test.ts cases. todos.ts stays on disk, unused.
- files: .claude/skills/todo-list/hooks/register.tsx, .claude/skills/todo-list/hooks/register.test.ts
- done when: register.test.ts proves session.start registers the tool; a `$.tool.call({ tool: '<registered name>', op: 'set', ... })` updates the plan atom, sets the status line and returns the text tree; a bad op returns error text and leaves the plan untouched; prompt.compose adds the section once and only when the tool is offered; prompt.submit context carries the plan; a subagent plan call does not change the plan.
- verify: `npm run check`; live: `claude --plugin-dir .claude/skills/todo-list`, ask for a 3-step change, confirm the pane draws the tree

### T08 Mirror TodoWrite, TaskCreate and TaskUpdate into the plan
- status: done (#10, 2026-10-05)
- needs: T07
- size: S
- scope: TaskCreate/TaskUpdate only; TodoWrite does not exist in 2.1.289, so keep its mapping only if it is cheap and tested with a synthetic event. Add `hooks/ingest.ts` with pure mappings: TodoWrite replaces the `source: 'todo'` top-level leaves; TaskCreate adds a top-level node with `source: 'task'` and `externalId` = task id; TaskUpdate finds a node by externalId, patches it, removes it on `deleted`. Wire in register.tsx after a successful `next(e)` (no deny, no isError, `result.success`), main loop only. Each successful call marks the task planned.
- files: .claude/skills/todo-list/hooks/ingest.ts (new), .claude/skills/todo-list/hooks/ingest.test.ts (new), .claude/skills/todo-list/hooks/register.tsx, .claude/skills/todo-list/hooks/register.test.ts
- done when: ingest.test.ts covers each mapping plus coexistence of plan nodes with todo/task nodes; register.test.ts shows a successful TodoWrite fills the tree and sets `task.planned`, while denied, errored and subagent calls change nothing.
- verify: `npm run check`

### T09 Wire session-activity events
- status: done (#11, 2026-10-05)
- needs: T05, T08
- size: S
- scope: In register.tsx feed `reduceActivity` from turn.start; turn.complete (reason); tool.call around `next` (main loop, not the plan tool); AskUserQuestion's tool.call around `next` (question); tool.check with `tool_use_id` and decision `ask` (permission) plus classic.PermissionRequest as a second signal; session.compact around `next` (main loop only); classic.SubagentStart and classic.SubagentStop; classic.StopFailure; session.end with reason `clear` produces sessionClear; ignore turn.complete events with an `agentId`. Log classic.Notification `notification_type` to the debug log only for now. Refresh the status line on each change. Truncate any `$.ui.log` text to 4,000 chars (host drops over 4096).
- files: .claude/skills/todo-list/hooks/register.tsx, .claude/skills/todo-list/hooks/register.test.ts
- done when: register.test.ts drives each source through `$.tool.call`, `$.tool.check` or `$.classic.<Event>` and asserts the `activity` atom and status line, including that AskUserQuestion shows "Waiting for your answer" while `next` is pending.
- verify: `npm run check`; live check of the activity line in T13

### T10 Enforce the gate with escape hatches; replace the never-block rule
- status: done (#12, 2026-10-05)
- needs: T09
- size: M
- scope: Add a catch-all `tool.call` gate hook running `decideGate`. A deny returns `{ deny }` and increments `task.denies`; on the first deny of a turn show the user toast "Blocked <tool>: no plan yet. /todo off turns this off."; pause shows a toast too. Add `userConfig.enforce` (boolean, default true) to plugin.json and read it from `register(on, options)` (PluginOptions 7316-7328). Add `/todo off|on` setting `enforceSession`. In the project CLAUDE.md replace "The nudge never blocks: no hook returns deny" with "The gate denies only blocked main-loop tools while the task has no plan; it fails open (guard failure, tool unregistered or not offered, enforcement off, 3 denies in a turn)".
- files: .claude/skills/todo-list/hooks/register.tsx, .claude/skills/todo-list/hooks/register.test.ts, .claude/skills/todo-list/.claude-plugin/plugin.json, CLAUDE.md (Rules section)
- done when: register.test.ts shows Edit denied before a plan and allowed after a `set`; Read allowed with no plan; `enforce: false` allows; `/todo off` allows and `/todo on` re-arms; a forced throw in the gate path allows; a subagent Edit is allowed; the 4th blocked call in a turn is allowed. `claude plugin validate` accepts the userConfig.
- verify: `npm run check`

### T11 Delete the old todo-list code and atoms
- status: todo
- needs: T10
- size: S
- scope: Delete the old modules and tests. Remove the `items`, `updatedThisTurn` and `nudgedThisTurn` atoms and the `TodoItem` and `TodoStatus` types from types/index.d.ts.
- files: delete .claude/skills/todo-list/hooks/todos.ts, hooks/tasks.test.ts, hooks/nudge.test.ts, hooks/compose.test.ts, hooks/progress.test.ts, hooks/replace.test.ts, hooks/manual.test.ts; edit .claude/skills/todo-list/types/index.d.ts
- done when: `grep -rn "todos'" .claude/skills/todo-list` and `grep -rn "updatedThisTurn\|nudgedThisTurn" .claude/skills/todo-list` return nothing, and the check is green.
- verify: `npm run check`

### T12 Update README, project CLAUDE.md and manifest
- status: done (#PR, 2026-10-05)
- needs: T11
- size: S
- scope: README: what it does, a text tree sample, the status and activity tables, how enforcement works and the three ways to turn it off, TodoWrite mirroring, known limits (third-party MCP tools not gated, Bash fully gated, Notification types unmapped). CLAUDE.md Stack line lists modules sanitize, plan, plan-tool, tree, activity, gate, ingest. plugin.json description and version 0.2.0.
- files: README.md, CLAUDE.md, .claude/skills/todo-list/.claude-plugin/plugin.json
- done when: the README covers every D-decision a user would notice; no doc mentions `/todo add|start|done|rm` or "never blocks".
- verify: `npm run check`; `grep -n "never blocks\|/todo add" README.md CLAUDE.md` returns nothing

### T13 Live acceptance run
- status: todo
- needs: T12
- size: S
- scope: In a live session run: (1) Q&A prompt: no plan, no deny. (2) Edit request: first Edit denied, Claude calls the plan tool, the Edit runs. (3) AskUserQuestion shows "Waiting for your answer". (4) A permission ask shows "Waiting for permission: <tool>". (5) A subagent shows "1 subagent". (6) `/todo off`: Edit allowed with no plan. (7) `/compact` keeps the plan and the next prompt's context carries it; `/clear` resets it. (8) Esc: "Interrupted". (9) A finished plan collapses. (10) Follow-up prompt after a finished plan: the gate re-arms. (11) A background subagent finishing does not re-arm the gate. Mirroring is not asserted in a default run (tools not offered). Record pass or fail per step in the Log.
- files: docs/plan-tree/TODO.md (Log)
- done when: all 11 steps logged as pass, or a failing step has a new todo filed and fixed.
- verify: `claude --plugin-dir .claude/skills/todo-list`

### TZZ Cleanup and land
- status: todo
- needs: every other todo
- scope: run `/implement cleanup`
- done when: skill removed from the branch, TODO.md archived, landing PR into main open and approved by the owner

## Backlog
- T03: confirm in T07/T13 that a 3-level nested inputSchema is accepted for a plugin tool
- T07: tree.ts still uses local phaseLabel; swap to activity.ts activityLabel in T09
- T07: task/planTool atom wiring not asserted in register.test.ts (test $ cannot read atoms)
- Suppress the engine's `todo_reminder` attachment while the plan tool is active (prompt.attachment, vendor d.ts 4056-4066).
- Read-only Bash allowlist (ls, git status, git diff) before a plan exists; needs safe command parsing.
- Map classic.Notification `notification_type` values to activity states once T01 has observed them.
- Update the "Current mods" line for todo-list in the parent `claude-mods/CLAUDE.md` (outside this repo).
- T02 follow-ups: `Plan` carries an extra `issued` counter list (not in the T02 scope text) so removed ids are never reused; T03 to T08 must pass the whole `Plan` through and use `emptyPlan()`. Parent rollup is: in_progress > blocked > all completed/skipped = completed > some done = in_progress > pending. `progress` counts skipped leaves as done; `hasUnfinished` treats blocked leaves as unfinished. Confirm both in T04/T06.
- Persist the plan across `/clear` or resume via `$.store` if the owner wants that.
- T09: with parallel tool calls, the first toolEnd drops the status to Working while another tool still runs.
- T09: a subagent's permission prompt shows as the main session waiting.
- T09: the permission and AskUserQuestion states were not captured live because dialogs cover the pane; T13 records this.

## Log
2026-10-05 T01 #2 spike answered Q1-Q10 (10 observed, 0 unobserved; sub-points unobserved listed in spike.md)
2026-10-05 amend spike corrections applied to D7, D10, T03, T05-T10, T13 (owner approved)
2026-10-05 T02 #4 plan model, reducers and new atoms
2026-10-05 T05 #5 activity reducer: Claude state from events
2026-10-05 T04 #6 tree renderer and status line
2026-10-05 T06 #8 gate decision, task lifecycle and prompt texts
2026-10-05 T03 #7 plan tool schema, parser and model-facing text
2026-10-05 T07 #9 plan tool, tree pane and status line live (3-level schema confirmed)
2026-10-05 T08 #10 TaskCreate/TaskUpdate (and synthetic TodoWrite) mirrored into the tree
2026-10-05 T09 #11 session activity events wired to the activity line
2026-10-05 T10 #12 gate blocks edits until a plan exists; fails open; /todo off|on; userConfig.enforce
2026-10-05 T12 #PR README, CLAUDE.md stack line and manifest 0.2.0
