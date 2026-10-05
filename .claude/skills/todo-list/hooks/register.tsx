import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'
import type { TodoItem } from '../types'
import {
  addTask,
  buildLines,
  replaceAll,
  shouldNudge,
  statusText,
  updateTask,
  withTodoSection,
  NUDGE_TEXT,
} from './todos'

const TODO_TOOLS: ReadonlySet<string> = new Set(['TodoWrite', 'TaskCreate'])
const PANE = 'todo'
const PANE_ROWS = 14
const PANE_COLUMNS = 40
const EMPTY_ITEMS: TodoItem[] = []
const items = atom({ plugin: 'todo-list', key: 'items' } as const, EMPTY_ITEMS)
const updatedThisTurn = atom({ plugin: 'todo-list', key: 'updatedThisTurn' } as const, false)
const nudgedThisTurn = atom({ plugin: 'todo-list', key: 'nudgedThisTurn' } as const, false)

// Runs a hook body; a failure is logged to the debug log as `todo-list: <name> threw` and
// never thrown, so a bug here cannot block a tool call or a prompt.
const guard = async <T,>(
  $: EngineInterface,
  name: string,
  fallback: T | (() => T),
  body: () => Promise<T> | T,
): Promise<T> => {
  try {
    return await body()
  } catch (error) {
    try {
      $.ui.log(`todo-list: ${name} threw ${String(error)}`, { to: 'debug' })
    } catch {
      // Logging must never throw out of a hook.
    }
    return typeof fallback === 'function' ? (fallback as () => T)() : fallback
  }
}

// Applies a list reducer inside the updater, marks the turn as updated and refreshes the
// status line from the list the reducer produced.
const applyList = async (
  $: EngineInterface,
  reduce: (list: TodoItem[], now: number) => TodoItem[],
): Promise<void> => {
  const now = await $.clock.now()
  let next: TodoItem[] = EMPTY_ITEMS
  await update($, items, cur => {
    next = reduce(cur, now)
    return next
  })
  await update($, updatedThisTurn, () => true)
  $.ui.status(statusText(next))
}

const openPane = async ($: EngineInterface): Promise<void> => {
  await $.ui.open({ id: PANE, title: 'Todo', rows: PANE_ROWS, columns: PANE_COLUMNS })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await guard($, 'session.start', undefined, async () => {
      await $.command.register({ name: 'todo', description: 'Show the todo list pane' })
      // The pane opens unasked only on the terminal under a person at the prompt.
      if (e.isInteractive && e.surface === 'terminal') await openPane($)
    })

    return next(e)
  })

  on('command.run', { command: 'todo' }, async $ =>
    guard($, 'command.run', { text: 'Todo pane failed to open.' }, async () => {
      await openPane($)

      return { text: 'Todo pane opened.' }
    }),
  )

  // The instruction is added only when the request offers a todo tool to act on it.
  on('prompt.compose', async (_$, e, next) => {
    const result = await next(e)
    if (!e.tools.some(t => TODO_TOOLS.has(t))) return result

    return { sections: withTodoSection(result.sections) }
  })

  // turn.start fires once per model turn of the main loop (its input carries no agentId),
  // so the per-turn flags reset here and not on a prompt typed over a running turn.
  on('turn.start', async ($, e, next) => {
    await guard($, 'turn.start', undefined, async () => {
      await update($, updatedThisTurn, () => false)
      await update($, nudgedThisTurn, () => false)
    })

    return next(e)
  })

  // TodoWrite: the input list replaces the whole list, applied only after the call succeeded.
  // A subagent's calls (agentId set) pass through: the list is the main loop's.
  on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran
    await guard($, 'TodoWrite', undefined, () => {
      // result.newTodos is the list after the update; e.todos is the fallback.
      const todos = ran.result.newTodos ?? e.todos

      return applyList($, (cur, now) => replaceAll(cur, todos, now))
    })

    return ran
  })

  // TaskCreate: the new task's id comes from the tool result.
  on('tool.call', { tool: 'TaskCreate' }, async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran
    await guard($, 'TaskCreate', undefined, async () => {
      const id = ran.result.task.id
      await applyList($, (cur, now) => addTask(cur, id, e.subject, e.activeForm, now))
    })

    return ran
  })

  on('tool.call', { tool: 'TaskUpdate' }, async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran
    await guard($, 'TaskUpdate', undefined, async () => {
      if (!ran.result.success) return
      await applyList($, (cur, now) =>
        updateTask(
          cur,
          { taskId: e.taskId, subject: e.subject, activeForm: e.activeForm, status: e.status },
          now,
        ),
      )
    })

    return ran
  })

  // Nudge: a toast once per turn, before the state-changing tool runs. Never a deny.
  on('tool.call', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    await guard($, 'nudge', undefined, async () => {
      const state = {
        tool: e.tool,
        items: await read($, items),
        updatedThisTurn: await read($, updatedThisTurn),
        nudgedThisTurn: false,
      }
      if (!shouldNudge(state)) return
      // The flag is tested and set inside the updater, so two calls cannot both toast.
      let first = false
      await update($, nudgedThisTurn, v => {
        first = !v

        return true
      })
      if (first) $.ui.toast(NUDGE_TEXT)
    })

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) =>
    guard(
      $,
      'ui.render',
      () => {
        const { Text } = $.ui.resolve(e)
        return <Text>Todo failed to draw.</Text>
      },
      async () => {
        const { Box, Text } = $.ui.resolve(e)
        const list = await read($, items)
        const maxLines = Math.max(3, (e.viewport?.rows ?? 24) - 4)

        return (
          <Box flexDirection="column">
            {buildLines(list, maxLines).map((line, i) => (
              <Box key={`line-${i}`} marginTop={line.kind === 'section' ? 1 : 0}>
                <Text bold={line.kind === 'header'} dimColor={line.dim} wrap="truncate-end">
                  {line.text}
                </Text>
              </Box>
            ))}
          </Box>
        )
      },
    ),
  )
}
