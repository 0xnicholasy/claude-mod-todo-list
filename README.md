# claude-mod-todo-list

Todo List is a Claude Code mod. It follows the task list Claude keeps (TodoWrite, TaskCreate, TaskUpdate), shows it in a "Todo" pane and in the status line, asks Claude to keep a list for non-trivial work, and shows a toast when Claude edits files with no list.

## Install

```
claude --plugin-dir <path>/.claude/skills/todo-list
```

Inside this repo the mod also loads from the project skills folder. If `/todo` is not offered, run `claude plugin list` to check that it is loaded and enabled.

## Behaviour

- Tracking: `TodoWrite` replaces the whole list. `TaskCreate` appends an item (its id comes from the tool result) and `TaskUpdate` changes it; status `deleted` removes it. Changes are applied only after the tool call succeeds. `TodoWrite` replaces only its own items, so tasks made with `TaskCreate` stay. Calls made inside subagents are ignored.
- Instruction: when `TodoWrite` or `TaskCreate` is available, a session-scoped system prompt section tells Claude to create a todo list before any task with more than 2 steps or more than one file, keep exactly one item in progress, mark items completed immediately, and add items when new work appears. Single-step answers are exempt.
- Nudge: when Claude calls `Edit`, `Write` or `NotebookEdit` and no todo update happened this turn and no unfinished item exists, a toast reads "No todo list yet for this task". It shows at most once per model turn and never blocks the tool.
- Pane: titled "Todo". The header shows `done/total` and a text progress bar. Sections run In progress (shows the activeForm), Pending, Done (dimmed), with markers `[>]`, `[ ]`, `[x]`. An empty list shows "No todos yet." The pane opens at session start in an interactive terminal session and with `/todo`.
- Status line: `Todo 3/7: <activeForm of the in-progress item>`, cleared when the list is empty.

## Manual control

Some sessions offer the model no task tool (`TodoWrite` or `TaskCreate`), so the pane would stay empty. `/todo` subcommands let you manage the list by hand. Items are numbered by their position in the list (all items, from any source).

- `/todo`: open the pane.
- `/todo add <text>`: append a pending item (id `manual-<n>`).
- `/todo start <n>`: mark item n in progress; any other in-progress item goes back to pending.
- `/todo done <n>`: mark item n completed.
- `/todo rm <n>`: remove item n.
- `/todo clear`: empty the list.

Each change refreshes the pane and status line. `TodoWrite` keeps manual items. Manual edits do not count as a model update, so the nudge still applies.

## Requirements

- Claude Code 2.1.289, the version the API types were taken from (see `CLAUDE.md`).
- The pane and toast need the terminal surface.

## Develop

- `npm install`, then `npm run check`. It runs `validate` (`claude plugin validate`), `typecheck` (`tsc -p tsconfig.json`) and `test` (`claude plugin test`). Validate and test need the `claude` CLI and run locally only. CI runs typecheck only.
- Mod path: `.claude/skills/todo-list/` (manifest `.claude-plugin/plugin.json`, hooks in `hooks/`, state contract in `types/index.d.ts`).
- Hot reload: saving a file in the mod reloads the module in a running session. The list survives, because state lives in `$.state` atoms and not in module variables.
