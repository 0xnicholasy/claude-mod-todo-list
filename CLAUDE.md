# claude-mod-todo-list

A Claude Code mod ("Todo List"): a pane, status line and gentle nudges that follow Claude's task list. Written in TypeScript (TSX) as a plugin of function hooks that hot-reloads in a session.

## Stack and commands

- Package manager: npm. Dev dependency: TypeScript 5.x.
- Mod path: `.claude/skills/todo-list/` (manifest in `.claude-plugin/plugin.json`, hooks in `hooks/`, state contract in `types/index.d.ts`). Pure logic (reducers, progress math, pane lines, nudge decision, prompt section) is in `hooks/todos.ts`; `hooks/register.tsx` wires it to the hooks.
- Claude Code version the API types came from: 2.1.289. The API declarations are vendored at `vendor/claude-code/claude-code.d.ts`; never edit that file, regenerate it by loading the plugin-authoring skill.
- `npm run check` is the gate. It runs `validate` (`claude plugin validate`), `typecheck` (`tsc -p tsconfig.json`) and `test` (`claude plugin test`). Validate and test need the claude CLI and run locally only; CI runs typecheck.

## Rules

- No emoji in code.
- No `any` or `unknown` without a comment that justifies it.
- Never silence a TypeScript error with `// eslint-disable`.
- State lives in `$.state` atoms declared in `types/index.d.ts`, never in module variables.
- The nudge never blocks: no hook returns `deny`.

## Delivery

- Build with a `sonnet` implementation agent.
- Tests: `npm run check`.
- Docs to update: `README.md`.
