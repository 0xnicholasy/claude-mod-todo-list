import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'
import type { Plan, PlanToolState, TaskState } from '../types'
import { emptyActivity } from './activity'
import { INSTRUCTION_ID, INSTRUCTION_TEXT, onNewPrompt, onPlanTouched, planContext } from './gate'
import { emptyPlan } from './plan'
import type { PlanApplied } from './plan-tool'
import {
  applyPlanOp,
  formatForModel,
  parsePlanInput,
  PLAN_INPUT_SCHEMA,
  PLAN_TOOL_DESCRIPTION,
  PLAN_TOOL_SHORT_NAME,
  touchesPlan,
} from './plan-tool'
import { buildTree, statusLine } from './tree'

// D4: the registered name is `mcp__<plugin>__<name>`, confirmed by the T01 spike (Q1).
const PLAN_TOOL_FULL_NAME = `mcp__todo-list__${PLAN_TOOL_SHORT_NAME}`
const PANE = 'todo'
const PANE_ROWS = 20
const PANE_COLUMNS = 48
const USAGE = 'Usage: /todo (opens the pane) | /todo clear'
const NOT_OWNER_TEXT =
  'Error: the plan is owned by the main session. Subagents cannot change it; report your progress in your result instead.'

const EMPTY_TASK: TaskState = { open: false, planned: false, denies: 0 }
const plan = atom({ plugin: 'todo-list', key: 'plan' } as const, emptyPlan())
const task = atom({ plugin: 'todo-list', key: 'task' } as const, EMPTY_TASK)
const activity = atom({ plugin: 'todo-list', key: 'activity' } as const, emptyActivity(0))
const planTool = atom({ plugin: 'todo-list', key: 'planTool' } as const, {
  name: null,
  offered: false,
} as PlanToolState)

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

// Matches the plan tool by its literal name as well as the stored one. The atoms reset on
// /clear (T01 Q7) while the registration persists (Q1), so the stored name alone would stop
// matching after a /clear. The literal is safe: D4 fixes the name and Q1 confirmed it.
function isPlanTool(tool: string, stored: string | null): boolean {
  return tool === PLAN_TOOL_FULL_NAME || (stored !== null && tool === stored)
}

async function refreshStatus($: EngineInterface): Promise<void> {
  const [p, a] = await Promise.all([read($, plan), read($, activity)])
  $.ui.status(statusLine(p, a))
}

async function openPane($: EngineInterface): Promise<void> {
  await $.ui.open({ id: PANE, title: 'Plan', rows: PANE_ROWS, columns: PANE_COLUMNS })
}

async function runTodoCommand($: EngineInterface, args: string): Promise<{ text: string }> {
  const word = args.trim().toLowerCase()
  if (word === '') {
    await openPane($)

    return { text: 'Plan pane opened.' }
  }
  if (word !== 'clear') return { text: USAGE }
  await update($, plan, () => emptyPlan())
  await update($, task, () => EMPTY_TASK)
  await refreshStatus($)

  return { text: 'Plan cleared.' }
}

// Answers a call to the plan tool. The hook answers itself and never calls next(e) (T01 Q1/Q3):
// a result from the hook reaches the model verbatim, and an error is result text starting "Error:".
async function answerPlanCall($: EngineInterface, input: unknown, agentId: string | undefined): Promise<{ result: string }> {
  // Only the main loop owns the plan; a subagent's call changes nothing.
  if (agentId !== undefined) return { result: NOT_OWNER_TEXT }
  const parsed = parsePlanInput(input)
  if ('error' in parsed) return { result: parsed.error }
  const now = await $.clock.now()
  let applied = { error: 'Error: plan unchanged.' } as PlanApplied
  await update($, plan, (cur: Plan) => {
    applied = applyPlanOp(cur, parsed.parsed, now)

    return 'error' in applied ? cur : applied.plan
  })
  if ('error' in applied) return { result: applied.error }
  if (touchesPlan(parsed.parsed)) await update($, task, onPlanTouched)
  await refreshStatus($)

  return { result: applied.text }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await guard($, 'session.start', undefined, async () => {
      try {
        const registered = await $.tool.register({
          name: PLAN_TOOL_SHORT_NAME,
          description: PLAN_TOOL_DESCRIPTION,
          inputSchema: PLAN_INPUT_SCHEMA,
        })
        await update($, planTool, cur => ({ ...cur, name: registered.tool }))
      } catch (error) {
        // The name stays null: the gate and the instruction both fail open without the tool.
        $.ui.log(`todo-list: plan tool registration failed ${String(error)}`, { to: 'debug' })
      }
      await $.command.register({
        name: 'todo',
        description: 'Show the plan pane, or clear the plan',
        argumentHint: 'clear',
      })
      // The pane opens unasked only on the terminal under a person at the prompt.
      if (e.isInteractive && e.surface === 'terminal') await openPane($)
    })

    return next(e)
  })

  on('command.run', { command: 'todo' }, async ($, e) =>
    guard($, 'command.run', { text: 'Todo command failed.' }, () => runTodoCommand($, e.args)),
  )

  // Without the pin the tool is deferred behind ToolSearch and the model does not see it on
  // turn one (T01 Q2).
  on('tool.describe', async ($, e, next) => {
    const stored = await guard($, 'tool.describe', null as string | null, async () => (await read($, planTool)).name)
    if (!isPlanTool(e.tool, stored)) return next(e)

    return { ...e, isDeferred: false }
  })

  // No tool.check hook for the plan tool: the tool.call hook answers before any check (Q4).
  // The catch-all form is used because the registered name is known only after session.start.
  on('tool.call', async ($, e, next) => {
    const stored = await guard($, 'tool.call', null as string | null, async () => (await read($, planTool)).name)
    if (!isPlanTool(e.tool, stored)) return next(e)

    return guard($, 'plan tool', { result: 'Error: the plan tool failed. Try again.' }, () =>
      answerPlanCall($, e, e.agentId),
    )
  })

  // The instruction is added only when the plan tool is in the request's tool list. The pin
  // (tool.describe above) always applies to a registered plan tool, so membership in e.tools
  // means the tool is loaded. The name found here also repairs planTool after a /clear.
  on('prompt.compose', async ($, e, next) => {
    const result = await next(e)

    return guard($, 'prompt.compose', result, async () => {
      const stored = (await read($, planTool)).name
      const found = [stored, PLAN_TOOL_FULL_NAME].find(n => n !== null && e.tools.includes(n)) ?? null
      await update($, planTool, cur => ({ name: found ?? cur.name, offered: found !== null }))
      if (found === null) return result

      return {
        sections: [
          ...result.sections.filter(s => s.id !== INSTRUCTION_ID),
          { id: INSTRUCTION_ID, text: INSTRUCTION_TEXT(found), scope: 'session' as const },
        ],
      }
    })
  })

  // D12: the plan rides each new prompt as context, which also resyncs ids after a compaction.
  on('prompt.submit', async ($, e, next) => {
    const context = await guard($, 'prompt.submit', undefined as string | undefined, async () => {
      const name = (await read($, planTool)).name ?? PLAN_TOOL_FULL_NAME

      return planContext(await read($, plan), name, formatForModel)
    })
    if (context === undefined) return next(e)

    return next({ ...e, context: [...(e.context ?? []), context] })
  })

  // turn.start fires once per prompt of the main loop and not for subagents (T01 Q7).
  on('turn.start', async ($, e, next) => {
    await guard($, 'turn.start', undefined, async () => {
      const current = await read($, plan)
      await update($, task, t => onNewPrompt(t, current, e.text))
    })

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) =>
    guard(
      $,
      'ui.render',
      () => {
        const { Text } = $.ui.resolve(e)
        return <Text>Plan failed to draw.</Text>
      },
      async () => {
        const { Box, Text } = $.ui.resolve(e)
        const [p, a] = await Promise.all([read($, plan), read($, activity)])
        const maxLines = Math.max(6, (e.viewport?.rows ?? PANE_ROWS) - 4)

        return (
          <Box flexDirection="column">
            {buildTree(p, a, { maxLines }).map((line, i) => (
              <Text
                key={`line-${i}`}
                color={line.color}
                bold={line.bold}
                dimColor={line.dim}
                inverse={line.inverse}
                strikethrough={line.strikethrough}
                wrap="truncate-end"
              >
                {line.text}
              </Text>
            ))}
          </Box>
        )
      },
    ),
  )
}
