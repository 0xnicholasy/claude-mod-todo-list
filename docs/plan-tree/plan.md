# Plan Tree: design notes

All line numbers refer to `vendor/claude-code/claude-code.d.ts` (Claude Code 2.1.289).

## Data model (types/index.d.ts, inline)
- `plan`: { title, nodes[] }. Each node is { id, parentId, title, activeForm?, status, note?, source, externalId?, updatedAt }. Flat because PluginState types must be inline and cannot be recursive. Ids are stable paths ("2.1.3"), never renumbered.
- `task`: { open, planned, denies }. Reset on turn.start with non-empty text (D7).
- `activity`: { phase, tool?, detail?, subagents[], since }.
- `enforceSession`: boolean, default true.
- `planTool`: { name, offered }.

## Plan tool (`mcp__todo-list__plan`)
| op | input | effect |
|---|---|---|
| set | title, nodes[{ title, activeForm?, children? }] to depth 3 | replaces the source:'plan' nodes |
| add | parent?, nodes[...] | appends children (top level when parent is absent) |
| update | updates[{ id, status?, title?, note? }] | batch patch, leaves only for status |
| remove | id | drops the subtree |
| show | none | returns the current tree |

Every answer is `{ result: <plain-text tree> }`. Errors are a result text starting with "Error:", or `isError` if T01 shows a hook may set it. Served by a tool.call hook on the registered name (2936-2951).

## Status sources
| Shown as | Event (line) |
|---|---|
| Node Completed / In progress / Pending / Blocked / Skipped | plan tool calls (tool.call 3841-3849); TodoWrite/TaskCreate/TaskUpdate (15839, 15860, 15880) |
| Working | turn.start (4290-4294; input 12723-12734) |
| Running <tool> | tool.call before `next` resolves (3841-3849), main loop: `agentId` absent (198-208) |
| Waiting for permission: <tool> | tool.check result `decision: 'ask'` with `tool_use_id` (3850-3861, 12238, 12247-12290); classic.PermissionRequest (7177-7183) |
| Waiting for your answer | tool.call on AskUserQuestion while `next` is pending (input 15374; dialog props 9238-9259; `$.ui.ask` 2333-2348) |
| Compacting | session.compact around `next` (4222-4233; input 10254-10284) |
| N subagents running | classic.SubagentStart / SubagentStop (11688-11699); agent.spawn alternative (3968-3976, 265-295) |
| Idle | turn.complete reason `answer` (4305-4312, 12679) |
| Interrupted | turn.complete reason `aborted` (12679) |
| Error | turn.complete reason `error` or `refusal` (12679); classic.StopFailure (11560-11565) |
| (debug log only) | classic.Notification `notification_type: string` (6402-6407) |

Classic events: `on('classic.<Event>')` (1176-1182). Tests raise them with `$.classic.<Event>` (14180-14190, 14274-14280).

## Gate algorithm (hooks/gate.ts, wired in T10)
1. Allow if `agentId` is set, the tool is not in BLOCKED_TOOLS, or the tool is the plan tool.
2. Allow if `enforce` (userConfig) or `enforceSession` is false, `planTool.name` is null, or `planTool.offered` is false.
3. Allow if `task.planned`.
4. If `task.denies >= 3`: allow, and toast "Plan enforcement paused for this turn".
5. Otherwise deny with denyText, increment `denies`, toast the user once per turn.

Any throw allows (guard fallback = `next(e)`).

## Layout sample (pane, 48 columns)
    Add CSV export                3/7 ██████░░░░░░░░ 43%
    ◉ Running Bash · 1 subagent
    ├─ ✓ 1 Read the existing exporter (2/2)
    ├─ ◉ 2 Write the CSV writer
    │  ├─ ✓ 2.1 Header row
    │  ├─ ◉ 2.2 Escape quotes and commas
    │  └─ ○ 2.3 Stream large files
    ├─ ■ 3 Wire the CLI flag (blocked: flag name?)
    └─ ○ 4 Tests
    +2 more
Status line: `Plan 3/7 · Escaping quotes and commas · Running Bash`

## T01 spike questions
- Q1 Exact name returned by `$.tool.register` for plugin `todo-list` (hyphen accepted? 12490-12495, 6908-6910).
- Q2 Is the tool in `prompt.compose` `e.tools` on turn one (4174-4185)? Does `tool.describe` `isDeferred: false` keep it out of ToolSearch (4067-4080)?
- Q3 Does a hook's `{ result: string }` reach the model as text? May a hook set `isError: true` (12141-12194)?
- Q4 Does the registered tool raise a permission dialog, and does `tool.check` allow suppress it?
- Q5 Does `{ deny }` on Edit, Bash and Agent reach the model as an error with no dialog? Does an Agent deny stop the spawn?
- Q6 Why TodoWrite/Task* were missing: in `e.tools` or `$.tool.list()`, or deferred?
- Q7 Observed: turn.start text for a typed prompt vs a continuation; turn.complete reasons; tool.check ask with `tool_use_id`; which classic.* events fire and the Notification types; session.end reason on `/clear`; whether atoms survive hot reload and `/clear`.
- Q8 Manifest `userConfig` syntax for a boolean, and how `register(on, options)` receives it under `--plugin-dir` (7316-7328).
- Q9 Under `claude plugin test`: does `$.tool.register` work, and does `$.tool.call({ tool: <name>, ... })` hit the hook? Do `$.classic.*` and `$.tool.check` work?
- Q10 Do the glyphs ✓ ◉ ○ ■ – ├─ └─ │ █ ░ render at single width in the terminal pane?

## Open questions for the implementer
1. Whether a `tool.call` hook may set `isError: true` on its own `{ result }` (Q3).
2. `userConfig` manifest syntax for a boolean option (Q8).
3. Whether `/plan` is a built-in name (D4 avoids it either way).
4. Inferred, not tested: a plugin tool can raise a permission prompt; `turn.start` text is `""` on continuations; atoms survive `/compact` and hot reload.
5. Whether `✓` (U+2713) and `◉` (U+25C9) fall outside Extended_Pictographic; the T04 test decides, ASCII fallbacks if it fails.
6. Whether a three-level nested JSON schema is accepted for an MCP tool `inputSchema` (no `$ref` on purpose).
7. Whether `claude plugin test` supports `$.tool.register` and calls to the registered name (Q9). If not, T07 tests call the hook through `$.tool.call` with the literal name and stub registration.
