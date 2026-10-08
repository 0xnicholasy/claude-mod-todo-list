# Todo List for Claude Code

Todo List is a Claude Code plugin that shows Claude's task plan as a tree in a pane and the status line, with live activity. Claude writes the plan through a plugin tool, `mcp__todo-list__plan`, and state-changing tools wait until a plan exists.

![Todo List pane showing a plan tree with completed, running and blocked steps](docs/pane.png)

## Features

- Plan tree tool. Claude writes a tree (up to 3 levels, 60 nodes) through `mcp__todo-list__plan`. Steps that do not conflict can be grouped as parallel.
- Pane and status line. Both draw the tree with per-node status and a progress bar.
- Live activity. The current activity (running a tool, waiting for permission, compacting, subagents running) comes from session events, not from Claude's own report.
- Plan-first enforcement. Edit, Write, Bash and other state-changing tools are denied until a plan exists. Enforcement fails open and can be turned off.
- `/todo` command. Reopen the pane, clear the plan, switch enforcement, and set the accent color (Claude orange by default, saved across sessions).

## Installation

Install from GitHub:

```
/plugin marketplace add 0xnicholasy/claude-mod-todo-list
/plugin install todo-list@claude-mod-todo-list
```

The same works from the shell as `claude plugin marketplace add ...` and `claude plugin install ...`. Set options at install with `--config`, for example `--config accentColor=#c084fc` or `--config enforce=false`. Add `-s project` to install for one project only (scopes: `user`, `project`, `local`; default `user`).

To run from a checkout instead:

```
git clone https://github.com/0xnicholasy/claude-mod-todo-list.git
cd claude-mod-todo-list
claude --plugin-dir .claude/skills/todo-list
```

Run it from the repo root, or pass the absolute path to `.claude/skills/todo-list`. An installed plugin takes precedence over a local copy with the same name, so uninstall it while developing. If `/todo` is not offered, run `claude plugin list` to check that the plugin is loaded and enabled.

Update (restart required):

```
claude plugin marketplace update claude-mod-todo-list
claude plugin update todo-list@claude-mod-todo-list
```

Uninstall with `claude plugin uninstall todo-list@claude-mod-todo-list`.

## Usage

Claude creates the plan on its own: the plugin adds one instruction to the system prompt that asks for a plan before any tool other than read-only ones. You control the plugin with `/todo`:

| Command | Effect |
|---|---|
| `/todo` | Open the pane (reopens it at the height the plan needs). |
| `/todo clear` | Empty the plan. |
| `/todo off` | Turn plan enforcement off for this session. |
| `/todo on` | Turn plan enforcement back on. |
| `/todo color <name\|#hex\|reset>` | Set the accent color, saved for every session. `reset` returns to the `accentColor` option. |

The pane opens at session start on an interactive terminal 110 columns or wider. On a narrower terminal the host holds an unasked pane undrawn, so it opens on your first prompt instead (once per session, so a pane you close stays closed). The status line shows a short form, for example `Plan 3/7 · Escaping quotes and commas · Running Bash`.

### Pane

```
Add CSV export
━━━━━━━━━━━─────────────────────────────  2/7 · 29%
◉ Running Bash · 1 subagent

├─ ✓ 1 Read the existing exporter                    2/2
├─ ◉ 2 Write the CSV writer ∥ parallel               0/3
│  ├─ ◉ 2.1 Header row ◂
│  ├─ ◉ 2.2 Escape quotes and commas
│  └─ ○ 2.3 Stream large files
├─ ■ 3 Wire the CLI flag (blocked: flag name?)
└─ ○ 4 Tests
```

The first line is the plan title and the second is a progress bar (leaves done out of total leaves). Then comes the live activity, then the tree with each node's id. Parent rows show their done/total count at the right edge. The current step is marked with `◂`. A parallel group shows `∥ parallel` after its title; every running step in it has the accent color and a bold title, but only the first carries `◂`. When the tree is too tall, the paths to all running steps stay visible and the rest is summarized as `+N more`.

Below 50 columns the pane compacts: a shorter bar, `done/total` with no percentage, the count after a parent's title, a bare `∥` for a parallel group, notes cut to 20 characters, and no subagent count when it does not fit.

Claude Code chooses where the pane goes; a plugin cannot force it. The pane docks beside the transcript only in the fullscreen layout, from 110 columns. The main screen always shows it inline above the prompt. The plugin's type declarations describe the main screen as "`CLAUDE_CODE_NO_FLICKER=0`, tmux by default", so setting `CLAUDE_CODE_NO_FLICKER=1` should give the fullscreen layout (inferred from that note; the declarations name only the `=0` value). The pane asks for 56 columns when docked and for as many rows as the tree needs (6 to 20) when inline. A size you dragged wins.

### Node status

| Glyph | Status | Meaning |
|---|---|---|
| `✓` | Completed | The step is done. |
| `◉` | In progress | The step is running. Outside a parallel group, one leaf runs at a time. |
| `○` | Pending | Not started. |
| `■` | Blocked | The step cannot proceed; the note says why. |
| `–` | Skipped | The step was dropped; the note says why. |

A parent takes its status from its children. Any child in progress makes the parent in progress. Otherwise any blocked child makes it blocked. If every child is completed or skipped, the parent is completed. If some are done and the rest are pending, it is in progress. Otherwise it is pending. Only leaves are set through the tool.

### Activity

| Label | When |
|---|---|
| Working | A prompt was submitted and Claude is thinking. |
| Running `<tool>` | A tool call from the main session is running. |
| Waiting for permission: `<tool>` | A tool call is waiting on a permission dialog. |
| Waiting for your answer | Claude asked a question with AskUserQuestion. |
| Compacting | The conversation is being compacted. |
| N subagents | Appended to any label while N subagents run. |
| Interrupted | The turn was aborted, for example with Esc. |
| Error | The turn ended in an error or a refusal. |
| (none) | The turn ended with an answer. The activity line is left out. |

### The plan tool

`mcp__todo-list__plan` takes an `op` field.

| Op | Input | Effect |
|---|---|---|
| `set` | `title`, `nodes` | Replaces the plan. Nodes nest up to 3 levels, 60 nodes in total. |
| `add` | `parent?`, `nodes` | Appends children under a node, or at the top level when `parent` is absent. |
| `update` | `updates` of `{ id, status?, title?, note? }` | Batch patch. Status applies to leaves only. |
| `remove` | `id` | Drops a node and its subtree. Ids are never reused. |
| `show` | none | Returns the current tree with ids. |

A node may set `parallel: true` (on `set` or `add`). Its children may then be in progress at the same time; anywhere else a second in-progress leaf is rejected with an error naming the shared parent. Every answer is the plain-text tree. A failure is a result that starts with `Error:`. The current plan is attached to each new prompt, so ids stay in sync after a compaction. `/clear` resets the plan.

### TaskCreate, TaskUpdate and TodoWrite mirroring

When the session offers `TaskCreate`, `TaskUpdate` or `TodoWrite`, successful main-session calls are mirrored into the tree as top-level nodes and count as having a plan. The plan tool stays the preferred path. In Claude Code 2.1.289, `TodoWrite` does not exist and `TaskCreate` and `TaskUpdate` are not offered by default, so the plan tool is the only default path.

### Enforcement

Until the current task has a plan, these main-session tools are denied: Edit, Write, NotebookEdit, Bash, Agent, Workflow, CronCreate, CronDelete, EnterWorktree, ExitWorktree and RemoteTrigger. The denial tells Claude the exact `set` call to make.

These are never blocked: the plan tool, read-only tools (Read, Grep, Glob, LSP, WebFetch, WebSearch, ToolSearch, TaskGet, ListMcpResourcesTool, ReadMcpResourceTool, Skill), AskUserQuestion, and any call made inside a subagent. A prompt that only reads files or answers a question is never blocked.

A task starts at each typed prompt. A background-agent completion (`<task-notification>`) continues the current task. A task counts as planned when the plan has unfinished nodes, or after any successful plan tool call or mirrored task call.

Enforcement fails open. It allows every call when:

- the `enforce` option is `false`, or `/todo off` was run for the session;
- the plan tool did not register, or was not offered to the model;
- the gate throws an error;
- 3 calls were denied in one turn without a plan call (the gate pauses for the rest of that turn and shows a toast).

## Configuration

Options are set at install (`--config`), in settings, or per run:

| Option | Type | Default | Effect |
|---|---|---|---|
| `enforce` | boolean | `true` | Block state-changing tools until a plan exists. |
| `accentColor` | string | `claude` | Theme key or color for the current step, running steps and progress bar, for example `claude`, `magenta`, `#c084fc`. An invalid value falls back to Claude orange. |

```
claude --plugin-dir .claude/skills/todo-list \
  --settings '{"pluginConfigs":{"todo-list":{"options":{"enforce":false,"accentColor":"#c084fc"}}}}'
```

A color saved with `/todo color` takes precedence over `accentColor`. The `claude` theme key follows the light and dark themes.

## How it works: hooks

The plugin registers 20 hooks in `.claude/skills/todo-list/hooks/register.tsx`. Only one of them decides anything (the catch-all `tool.call` hook). Hooks pass the host's event or result through unchanged except where the last column says otherwise. A hook that throws is caught and logged to the debug log, and the call proceeds as if the plugin were not there.

| Hook | What it does | What it decides, and when | What it changes |
|---|---|---|---|
| `session.start` | Loads the saved accent color, registers the plan tool and the `/todo` command, and on an interactive terminal arms the first-prompt pane open and opens the pane. | Nothing. | Registers the plan tool and `/todo`; opens the pane; invalidates the cached `tool.describe` answer. |
| `command.run` (`todo`) | Runs `/todo` and its subcommands. | Which subcommand to run, from the typed arguments. | Opens or resizes the pane, clears the plan, flips the session enforcement switch, writes or deletes the saved accent color. |
| `tool.describe` | For the plan tool only, marks it as not deferred so the model sees it on the first turn. | Nothing; other tools pass through. | Sets `isDeferred: false` on the plan tool's description. |
| `tool.check` | Observes the permission verdict. When it is `ask`, records "waiting for permission". | Nothing. Observe-only. | Returns the verdict unchanged. Updates activity and the status line. |
| `classic.PermissionRequest` | Records "waiting for permission" for the tool. | Nothing. Observe-only. | Passes the event on unchanged. Updates activity. |
| `classic.SubagentStart` | Records that a subagent started. | Nothing. Observe-only. | Passes the event on unchanged. Updates the subagent count. |
| `classic.SubagentStop` | Records that a subagent stopped. | Nothing. Observe-only. | Passes the event on unchanged. Updates the subagent count. |
| `classic.StopFailure` | Records that the turn ended in an error. | Nothing. Observe-only. | Passes the event on unchanged. Updates activity. |
| `classic.Notification` | Writes the notification type to the debug log. | Nothing. Observe-only. | Passes the event on unchanged. |
| `session.compact` | Marks "Compacting" for the main session while a compaction runs. | Nothing. Observe-only. | Passes the event on unchanged. Updates activity. |
| `turn.complete` | Records how the turn ended (answer, interrupted, error). | Nothing. Observe-only. | Passes the event on unchanged. Updates activity. |
| `session.end` | On `/clear`, resets the activity state. | Nothing. Observe-only. | Passes the event on unchanged. |
| `tool.call` (catch-all) | Answers calls to the plan tool itself. For other main-loop calls, runs the gate, then wraps the call in activity start and end. Subagent calls pass through. | Denies a state-changing main-loop tool (see Enforcement for the list) when the task has no plan and enforcement is on. Allows everything else. Fails open: guard failure, plan tool not registered or not offered, enforcement off, or 3 denies in the turn. | A denied call returns a deny message instead of running. Plan tool calls return the plan text and update the plan. For all other calls the result is returned untouched. |
| `tool.call` (`TaskCreate`) | After a successful main-loop call, mirrors it into the plan. | Nothing. | Adds a node to the plan. The call's result is returned unchanged. |
| `tool.call` (`TaskUpdate`) | After a successful main-loop call, mirrors the update into the plan. | Nothing. | Updates a node in the plan. The call's result is returned unchanged. |
| `tool.call` (`TodoWrite`) | After a successful main-loop call, mirrors the todo list into the plan. | Nothing. | Updates the plan from the todo list. The call's result is returned unchanged. |
| `prompt.compose` | Checks whether the plan tool is in the request's tool list and records it. | Whether to add the instruction: only when the plan tool is offered. | Adds one system prompt section (`todo-list:plan`) that asks Claude to plan first. Adds nothing when the tool is not offered. |
| `prompt.submit` | On the first prompt of a session, opens the pane if it is not placed. Attaches the current plan to the prompt. | Whether to attach the plan: only when the plan has nodes. | Appends the current plan as one extra context entry to the prompt. May open the pane. |
| `turn.start` | Reloads the saved accent color after a `/clear`, resets the per-turn deny count, records "Working". | Nothing. | Updates task state and activity. Passes the event on unchanged. |
| `ui.render` (`Pane`, `todo`) | Draws the plan tree. If the terminal size, placement or plan height changed, re-opens the pane so the host resizes it. | Nothing. | Returns the pane contents. May close and reopen the pane. |

Observe-only hooks: `tool.check`, `classic.PermissionRequest`, `classic.SubagentStart`, `classic.SubagentStop`, `classic.StopFailure`, `classic.Notification`, `session.compact`, `turn.complete`, `session.end`. They update the plugin's own activity state and pass the host's event or verdict through unchanged. The `TaskCreate`, `TaskUpdate` and `TodoWrite` hooks never change the tool's result; they only copy it into the plan.

## Data and privacy

- The plugin makes no network calls.
- The only persisted data is the accent color, stored under one plugin store key (`accentColor`) when you run `/todo color`. `/todo color reset` deletes it.
- The plan, activity and enforcement switch live in session state and are not written to disk by the plugin. `/clear` resets them.
- The plugin reads no credentials, tokens or environment variables, and does not read or write files or run processes.
- The plan tool is registered locally through `$.tool.register` and appears as an MCP tool named `mcp__todo-list__plan`. It is answered by the plugin's own hook, not by a separate server.

The plugin sends the current plan to the model as part of each prompt, and the plan tool's name and the planning instruction as part of the system prompt. That is how Claude sees the plan.

## Requirements

- Claude Code 2.1.289, the version the API types were taken from.
- The terminal surface. The pane and toast need it.

## Development

```
npm install
npm run check
```

`npm run check` runs `validate` (`claude plugin validate`), `typecheck` (`tsc -p tsconfig.json`) and `test` (`claude plugin test`). Validate and test need the `claude` CLI and run locally only; CI runs typecheck.

- Mod path: `.claude/skills/todo-list/` (manifest `.claude-plugin/plugin.json`, hooks in `hooks/`, state contract in `types/index.d.ts`). The marketplace manifest is `.claude-plugin/marketplace.json`. Bump the version in `plugin.json` for releases.
- Hot reload: saving a file in the mod reloads the module in a running session. The plan survives because state lives in `$.state` atoms and not in module variables.
- Under the RTK shell hook, run the check as `rtk proxy npm run check`.

## Known limitations

- Third-party MCP tools are not gated, because the API gives no read-only flag before a call runs.
- All of Bash is gated, including read-only commands such as `ls`.
- Notification types other than `permission_prompt` are not mapped to an activity.
- With parallel tool calls, the status drops back to Working as soon as the first call finishes.
- A subagent's permission prompt shows as the main session waiting for permission.
- Dialogs cover the pane.

## License

MIT. See [LICENSE](LICENSE).
