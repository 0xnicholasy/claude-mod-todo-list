# claude-mods: move agents-rpg + new todo-list mod

Finish line: `claude-mods/claude-mod-agents-rpg` moved with its worktree repaired and memory copied; `claude-mods/claude-mod-todo-list` passes `npm run check` and is pushed to a new private GitHub repo.

Owner decisions (2026-10-05): enforcement = instruct + nudge (never block); layout = own repo + GitHub.

- [x] 1. Build todo-list mod (sonnet): state contract, TodoWrite/Task* tracking, prompt.compose rule, nudge toast, pane + /todo command, status line, tests, README, CLAUDE.md, CI
- [x] 2. Code review pass on the new mod
- [ ] 3. Move claude-mod-agents-rpg into claude-mods; `git worktree repair`; copy memory dir to new project path
- [x] 5. `claude-mods/CLAUDE.md`: how to set up a new mod project (owner request mid-task)
- [ ] 4. Initial commit + `gh repo create --private` + push
