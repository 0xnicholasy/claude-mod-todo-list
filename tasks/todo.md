# claude-mods: move agents-rpg + new todo-list mod

Finish line: `claude-mods/claude-mod-agents-rpg` moved with its worktree repaired and memory copied; `claude-mods/claude-mod-todo-list` passes `npm run check` and is pushed to a new private GitHub repo.

Owner decisions (2026-10-05): enforcement = instruct + nudge (never block); layout = own repo + GitHub.

- [x] 1. Build todo-list mod (sonnet): state contract, TodoWrite/Task* tracking, prompt.compose rule, nudge toast, pane + /todo command, status line, tests, README, CLAUDE.md, CI
- [x] 2. Code review pass on the new mod
- [x] 3. Move claude-mod-agents-rpg into claude-mods; `git worktree repair`; copy memory dir to new project path
- [x] 5. `claude-mods/CLAUDE.md`: how to set up a new mod project (owner request mid-task)
- [x] 4. Initial commit + `gh repo create --private` + push

## 2026-10-05: manual /todo fallback

Finish line: `/todo add|start|done|rm|clear` work, `npm run check` green, reviewed, committed.

- [x] Why task tools are missing: not settings (deny list is destructive Bash only), no env var; tools exist in 2.1.289 types but are not offered this session. Cause unconfirmed.
- [ ] Subcommands (sonnet agent); `manual-` ids survive TodoWrite (owner decision)
- [ ] `npm run check` green + code review + commit
