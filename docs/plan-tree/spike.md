# T01 spike: answers to Q1-Q10

Run 2026-10-05 against Claude Code 2.1.289 (`claude --version`), Opus 5.5 main model. Spike code (a hooks module registering `plan`, logging each event with a `SPIKE` prefix to the debug log) ran from a scratch copy of the plugin and was deleted afterwards; only this doc is committed. Headless runs used `claude -p ... --plugin-dir <spike> --debug-file <log> --output-format stream-json --verbose`; interactive runs used a detached tmux session (200x50) with `--permission-mode default`.

Findings that apply beyond Q1-Q10 are in "Extra findings" at the end.

## Q1 Name returned by `$.tool.register`

- **Answer:** `mcp__todo-list__plan`. The hyphen in the plugin name is accepted. Observed.
- **Evidence:** debug log: `SPIKE registered={"tool":"mcp__todo-list__plan"}`. The model then called `mcp__todo-list__plan` and the hook answered it. Registration persists across `/clear` (session.start does not refire; the next prompt still offered and ran the tool) and across a hot reload (session.start refired and re-registered).
- **Impact on plan:** none. D4 confirmed. T07 may store the returned name in `planTool.name` as planned.

## Q2 In `e.tools` on turn one; does `isDeferred: false` keep it out of ToolSearch

- **Answer:** Yes to both, and the pin is required. With `tool.describe` returning `isDeferred: false` the tool is loaded and callable on turn one with no ToolSearch step. Without the pin it is deferred (behind ToolSearch) in this environment. `e.tools` in `prompt.compose` lists deferred tools as well (319 to 353 names, most of them deferred MCP tools), so presence in `e.tools` does not mean the tool is loaded. Observed.
- **Evidence:**
  - `SPIKE prompt.compose tools=319 plan=true TodoWrite=false TaskCreate=false` (headless); `tools=353 plan=true` (interactive).
  - Pinned: the model's first action was `mcp__todo-list__plan {"op":"show"}` with no ToolSearch call; asked to classify, it listed `mcp__todo-list__plan` under "Loaded (callable now)".
  - Unpinned (same plugin, `tool.describe` returns `next` result unchanged): the model answered "`mcp__todo-list__plan` is **deferred**. You have to load it with ToolSearch before it can be called."
  - `$.tool.list()` at session.start returned 35 names (non-deferred set) including `mcp__todo-list__plan`.
- **Impact on plan:** T07 must keep the `tool.describe` pin. T10's "plan tool in the last request's tool list" condition is satisfied by `e.tools` membership once the pin exists; it is not evidence on its own that the tool is loaded, so the gate relies on the pin plus `planTool.name`.

## Q3 Does `{ result: string }` reach the model; may a hook set `isError: true`

- **Answer:** The text reaches the model verbatim as the tool result. A hook-set `isError: true` is ignored: the model's tool result is not flagged as an error. Use a result text starting with `Error:` for failures. Observed.
- **Evidence:**
  - Hook returned `{ result: "SPIKE-ECHO {...}" }`; stream-json shows `tool_result` content `"SPIKE-ECHO {\"op\":\"show\",\"tool\":\"mcp__todo-list__plan\",...}"` and the model quoted it exactly.
  - Hook returned `{ result: 'Error: SPIKE-ISERROR-TEXT', isError: true }`; stream-json shows `"content": "Error: SPIKE-ISERROR-TEXT"` with `is_error` absent (null). The vendor type marks `isError` as "Set by core" (12195-12200).
  - The `tool.call` event `e` for a plugin tool is the model's input fields spread beside `tool` and `tool_use_id`: `{ op, tool, tool_use_id }`.
- **Impact on plan:** plan.md already says errors are a text starting with "Error:". T03 and T07 must not rely on `isError`. Remove the "or `isError` if T01 shows a hook may set it" wording.

## Q4 Permission dialog for the registered tool; does `tool.check` allow suppress it

- **Answer:** No dialog is raised, and `tool.check` is never reached for the plan tool, because the `tool.call` hook answers the call first. The `tool.check` allow is therefore unnecessary. Observed in headless and in an interactive `--permission-mode default` session.
- **Evidence:**
  - Interactive, default mode: after "Call the plan tool with op show." the log has `tool.call tool=mcp__todo-list__plan` then `turn.complete reason=answer`; no `tool.check`, no `classic.PermissionRequest`, no `classic.Notification`. The screen showed `todo-list - plan (MCP)(op: "show")` and the result with no prompt.
  - Contrast: `Write` in the same session logged `tool.check ENTER tool=Write` then `tool.check tool=Write decision=ask tool_use_id=toolu_01Jzi...`, `classic.PermissionRequest tool=Write`, `classic.Notification type=permission_prompt msg=Claude needs your permission`, and the dialog showed "Do you want to create w.txt? 1. Yes 2. ... 3. No".
  - Order for a call that passes the hooks: `tool.call` hooks, then `tool.check` (with `tool_use_id`), then PermissionRequest and the Notification when the decision is `ask`.
- **Impact on plan:** T07 can drop the `tool.check` allow for the plan tool (keeping one is harmless). Activity "Waiting for permission" fires from `tool.check` `ask` or `classic.PermissionRequest`, never for the plan tool. Not tested: a plan tool call that calls `next(e)` instead of answering.

## Q5 Does `{ deny }` on Edit, Bash and Agent reach the model with no dialog; does an Agent deny stop the spawn

- **Answer:** Yes. The model receives the deny text as a tool error, no dialog opens, `tool.check` is not reached, and a denied Agent call never spawns a subagent. Observed.
- **Evidence:**
  - Bash: stream-json `tool_result` content `"<tool_use_error>SPIKE-DENIED Bash: create a plan first</tool_use_error>"`, `is_error: True`; debug log `tool.call Bash ...: resolved by a hooks module (deny: SPIKE-DENIED Bash: create a plan first)`; `hello.txt` was not created.
  - Agent: same shape; the log has no `classic.SubagentStart` for the denied call, and the model reported "the subagent never started".
  - Edit: not exercised by a prompt; the hook path is the same `tool.call` deny (observed on Bash and Agent).
  - Deny order: the log shows `tool.call` then the deny line with no `tool.check ENTER` for that `tool_use_id`.
  - Retry behavior: the model retried a denied Agent call 3 times, calling the plan tool between attempts with a made-up `op`; it never produced a valid plan because the spike plan tool only echoed.
- **Impact on plan:** D8's "after 3 denies in one turn" pause is well placed: the model does retry. T10's deny text must say exactly how to create a plan (the `set` op and its fields), because a vague text led to blind retries.

## Q6 Why TodoWrite and Task* were missing

- **Answer:** They are not offered at all in this environment: not in `$.tool.list()`, not in `prompt.compose` `e.tools`, and not in the headless `init` tool list, so they are absent rather than deferred. `TodoWrite` does not appear in the tool set; `TaskCreate` appears only when named in `--tools`. The root cause of the default omission was not found. Observed (absence); cause unobserved.
- **Evidence:**
  - `SPIKE prompt.compose ... TodoWrite=false TaskCreate=false` in headless and interactive runs; the only matching names are `TaskStop`, `EnterPlanMode`, `ExitPlanMode` and `mcp__todo-list__plan`.
  - The `init` event of `claude -p --output-format stream-json --verbose` lists `Task`, `TaskStop`, `mcp__todo-list__plan` and no `TodoWrite` or `TaskCreate`.
  - `claude -p ... --tools "TodoWrite,TaskCreate,Read"` produced an init tool list of `['Read', 'TaskCreate', ...]`: `TaskCreate` exists, `TodoWrite` does not.
  - `CLAUDE_CODE_ENABLE_TASKS` set to `1`, `0` and `true` changed nothing; `~/.claude/settings.json` has no `TodoWrite` or `Task*` entry (checked by grep).
- **Impact on plan:** D10 and T08 (mirroring TodoWrite/TaskCreate/TaskUpdate) cover tools that this install does not offer by default, so the plan tool is the only default path to a plan. T08 stays valid for sessions that do offer them, but T13 cannot assert a mirror in the default run, and T06's "satisfy the gate through TodoWrite" branch is dead code by default. The vendor types still declare all three (15839, 15860, 15880).

## Q7 Event signals

Each sub-answer is separate.

- **turn.start text.** A typed prompt gives the prompt text. A continuation is NOT empty: a background subagent finishing produced `turn.start` with `text="<task-notification>\n<task-id>a217...</task-id>\n<tool-use-id>...</tool-use-id>\n<output-file>...</output-file>\n<status>completed</status>\n<summary>Agent \"Read note.txt, reply hi\" finished</summary>..."`. `e` keys are `text|turnId` (no `agentId`). `turn.start` fired once per prompt in a tool loop (one `turn.start`, many `tool.call`, one `turn.complete`), and not for subagents. Observed.
- **turn.complete.** `reason=answer` for a normal answer and also when the user rejected a permission dialog; `reason=aborted` after pressing Esc mid-answer (`e` keys: `answer|durationMs|isAborted|turnId|reason`). It fires for subagents too: a subagent's `turn.complete` has an `agentId` key (`agentId=aeaa35a2ce07d2bc9`) and arrives before the main loop's. `error`, `refusal` not observed. Observed (answer, aborted).
- **tool.check ask with `tool_use_id`.** Observed: `tool.check tool=Write decision=ask tool_use_id=toolu_01JziLaRG9xzASUeh64prgXn` (same id as the `tool.call` line).
- **classic.* events.** Observed: `classic.PermissionRequest` (`tool_name`), `classic.Notification` (`notification_type=permission_prompt`, `message=Claude needs your permission`), `classic.SubagentStart` (fields include `agent_id`, `agent_type`, `prompt_id`, `transcript_path`), `classic.SubagentStop` (`agent_id`). Not observed: `classic.StopFailure`, any Notification type other than `permission_prompt` (including `idle_prompt`).
- **session.compact.** `/compact` logged `session.compact begin` then `session.compact end` around `next`. Observed.
- **session.end.** `/clear` logged `session.end {"reason":"clear",...,"resume":{"id":...}}`; process exit logged `reason":"other"`. Observed.
- **Atoms.** Probe counter atom: survives `/compact` (value 4 before and after), survives a hot reload of the hooks module (5 after the edit; session.start refired with the new module), and RESETS on `/clear` (`atomBefore=0` on the next prompt). Observed.
- **Subagent noise.** Subagent `tool.call` events carry `agentId`. Subagent start/stop events from other background agents of this user's setup appeared in the same debug log (`classic.SubagentStop` for ids the prompt never spawned), so a counter keyed off Start/Stop must track ids in a set.
- **Impact on plan:**
  - D7 is wrong as written ("empty text means a continuation"). Background-completion continuations arrive as `<task-notification>` text, so they would open a new task and reset the gate. T06 and T13 need a rule: treat text starting with `<task-notification>` as a continuation.
  - T05/T09: `turn.complete` must ignore events with `agentId`; "Idle" must come only from the main loop's `turn.complete`. A user rejection ends as `answer`, not `aborted`.
  - `/clear` resets all atoms: the plan is lost on `/clear` (as plan.md's "Later" list already says); `session.end` reason `clear` is the signal to reset `activity`.
  - T09: map Notification `permission_prompt` only; others stay unmapped until observed.

## Q8 `userConfig` boolean syntax and delivery to `register(on, options)`

- **Answer:** Declare it in `.claude-plugin/plugin.json`; `register(on, options)` receives `{ enforce: true }` by default and the settings value when set. Observed.
- **Evidence:**
  - Manifest: `"userConfig": { "enforce": { "type": "boolean", "title": "Enforce plan", "description": "Block state-changing tools until a plan exists", "default": true } }`; `claude plugin validate` accepted it.
  - Under `--plugin-dir`: `SPIKE session.start options={"enforce":true}`; the debug log says `plugin todo-list: no pluginConfigs["todo-list" or "todo-list@inline"].options ... every option is its default`.
  - With `--settings '{"pluginConfigs":{"todo-list":{"options":{"enforce":false}}}}'`: `options={"enforce":false}`.
  - `options` is the second argument of `register(on, options)`, as `Register` types it (8804).
- **Impact on plan:** T07/T10 read `options.enforce` from `register`'s second parameter. T12's docs give the settings snippet above for turning enforcement off.

## Q9 Behavior under `claude plugin test`

- **Answer:** `$.tool.register` is NOT available in tests. `$.tool.call` with the literal name `mcp__todo-list__plan` reaches the plugin's own `tool.call` hook. `$.tool.check` and `$.classic.<Event>` work, but nothing answers them beneath the plugins, so a test must add its own `on('tool.check', ...)` or `on('classic.<Event>', ...)` stub. Observed.
- **Evidence:** a throwaway test run with `claude plugin test`:
  - `$.tool.register` threw `TypeError: $.tool.register is not a function`.
  - `on('tool.call', { tool: 'mcp__todo-list__plan' }, ...)` then `$.tool.call({ tool: 'mcp__todo-list__plan', op: 'show' })` returned `{"result":"HOOK-ANSWER"}`.
  - `$.tool.check({ tool: 'Read', ... })` threw `HooksError: no implementation for tool.check` until the test answers it with `on('tool.check', ...)`.
  - `$.classic.SubagentStart({ agent_id, agent_type })` raised the event (the test's own hook saw it) and threw `no implementation for classic.SubagentStart` for the missing base answer.
- **Impact on plan:** plan.md's Q9 fallback applies: T07 tests call the hook through `$.tool.call` with the literal name and skip registration (guard a missing `$.tool.register` as a logged failure leaving `planTool.name` null, or test the registration code through a stub). T06/T09 tests that raise classic events or `tool.check` must register stub implementations.

## Q10 Glyph width

- **Answer:** All of `✓ ◉ ○ ■ – ├─ └─ │ █ ░` occupy one cell each in tmux, and the Ink pane drew them intact. Observed under tmux only; the outer terminal (Ghostty) was not checked separately.
- **Evidence:**
  - Printed the 11 glyphs `✓◉○■–├─└│█░` in a tmux pane and read `#{cursor_x}`: `cursor_x=11` (11 glyphs, 11 cells; none double width).
  - A plugin pane (`$.ui.open`, 40 columns, 6 rows) rendered rows `A|✓ ◉ ○ ■ – |A`, `B|├─ └─ │ |B`, `C|█░█░ |C` inside its box with the border intact.
  - Unicode East Asian Width: `✓ ◉ ░` are N; `○ ■ – ├ ─ └ │ █` are A (ambiguous), which can render double width in a CJK-ambiguous-wide terminal. Environment: `LANG=en_HK.UTF-8`, `TERM_PROGRAM=ghostty`.
- **Impact on plan:** none for the owner's setup. T04 keeps the glyph set; an ASCII fallback is only needed if an ambiguous-width terminal is reported. Owner may confirm the outer terminal's width by eye once the pane is built (T13).

## Decisions

- **D4:** confirmed. `mcp__todo-list__plan` registers with the hyphenated plugin name and runs; the short name `plan` was accepted by `$.tool.register`. (Whether `/plan` is a built-in command name was not tested; D4 avoids the question.)
- **D8:** confirmed with notes. The plugin `userConfig.enforce` plumbing works (Q8), the plan tool is in `e.tools` once pinned (Q2), and a throw in the gate allowing the call needs no host support. Two notes for T10: `e.tools` includes deferred tools, so "offered" relies on the `tool.describe` pin; and the model retries denied calls (Q5), so the 3-deny pause is justified.

## Extra findings

- `hooks.json` accepts one module per plugin: `{ "modules": ["./register.tsx", "./spike.tsx"] }` fails `claude plugin validate` with "a second entry is refused". Any later todo that adds a second module must instead import it from `register.tsx`.
- `claude plugin validate` rejects passing `$` to a function unless it is a top-level function declaration (or a const bound to `on(...)`): "`$` is passed to "log", which is not a function declared at the top of this file". `guard()` in register.tsx already satisfies this; new helpers that take `$` must be top-level function declarations.
- `$.ui.log` drops text over 4096 characters: `$.ui.log dropped: HooksError: todo-list: ui.log: text over 4096 characters (host check)`. Any debug log of a tool list or a plan must be truncated.
- A hook that answers `tool.call` with `{ result }` skips `tool.check`, so the plan tool never produces permission-state events.
- The spike used the `tool.call` hook's `e.agentId` to tell subagent calls apart: absent on the main loop, set (for example `aeaa35a2ce07d2bc9`) on a subagent's `Read` and `SubagentHandback`.

## Not observed

- `classic.StopFailure` and Notification types other than `permission_prompt`.
- `turn.complete` reasons `error` and `refusal`.
- Whether `/plan` is a built-in name.
- Glyph width in the outer Ghostty terminal (tmux only).
- Why `TaskCreate` is off by default in this install.
- A plan tool call that calls `next(e)` instead of answering from the hook.
