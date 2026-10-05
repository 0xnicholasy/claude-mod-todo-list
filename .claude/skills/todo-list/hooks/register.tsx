import { atom, read, update } from 'claude-code'
import type { CommandPresentation, EngineInterface, Register } from 'claude-code'
import type { Plan, PlanToolState, TaskState } from '../types'
import { emptyActivity, reduceActivity } from './activity'
import type { ActivityEvent } from './activity'
import { needsRefit } from './fit'
import type { PaneFit } from './fit'
import type { GateDecision } from './gate'
import { decideGate, INSTRUCTION_ID, INSTRUCTION_TEXT, MAX_DENIES, onNewPrompt, onPlanTouched, planContext } from './gate'
import { ingestTaskCreate, ingestTaskUpdate, ingestTodoWrite } from './ingest'
import { emptyPlan } from './plan'
import type { PlanResult } from './plan'
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
import { clean } from './sanitize'
import { buildTree, DEFAULT_ACCENT, DEFAULT_WIDTH, paneRows, statusLine } from './tree'

// D4: the registered name is `mcp__<plugin>__<name>`, confirmed by the T01 spike (Q1).
const PLAN_TOOL_FULL_NAME = `mcp__todo-list__${PLAN_TOOL_SHORT_NAME}`
const PANE = 'todo'
const PANE_ROWS = 20
const PANE_COLUMNS = 56
const DOCK_TIP = ' Tip: the fullscreen layout docks this pane beside the transcript.'
const DOCK_MIN_COLUMNS = 110
// The host drops $.ui.log text over 4096 characters (T01 extra findings).
const LOG_LIMIT = 4000
const ASK_TOOL = 'AskUserQuestion'
const USAGE = 'Usage: /todo (opens the pane) | /todo clear | /todo off | /todo on | /todo color <name|#hex|reset>'
const ACCENT_PATTERN = /^(#[0-9a-fA-F]{6}|[a-zA-Z]{1,24})$/
const NOT_OWNER_TEXT =
  'Error: the plan is owned by the main session. Subagents cannot change it; report your progress in your result instead.'

const EMPTY_TASK: TaskState = { open: false, planned: false, denies: 0 }
const plan = atom({ plugin: 'todo-list', key: 'plan' } as const, emptyPlan())
const task = atom({ plugin: 'todo-list', key: 'task' } as const, EMPTY_TASK)
const activity = atom({ plugin: 'todo-list', key: 'activity' } as const, emptyActivity(0))
// D8: the session half of the enforcement switch; `/todo on|off` flips it. The other half is the
// plugin option `enforce`.
const enforceSession = atom({ plugin: 'todo-list', key: 'enforceSession' } as const, true as boolean)
// The session accent set by `/todo color`; null defers to the plugin option `accentColor`.
const accentOverride = atom({ plugin: 'todo-list', key: 'accentOverride' } as const, null as string | null)
const planTool = atom({ plugin: 'todo-list', key: 'planTool' } as const, {
  name: null,
  offered: false,
} as PlanToolState)

// What the pane was last re-opened for; null until the first re-open. Written only from refitPane
// (state writes are refused while a render draws).
const paneFit = atom({ plugin: 'todo-list', key: 'paneFit' } as const, null as PaneFit | null)

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

// Feeds one event to the activity reducer and redraws the status line. Top-level function
// declaration because `$` is passed to it (plugin validate rule).
async function applyActivity($: EngineInterface, event: ActivityEvent): Promise<void> {
  const now = await $.clock.now()
  await update($, activity, cur => reduceActivity(cur, event, now))
  await refreshStatus($)
}

function debugLog($: EngineInterface, text: string): void {
  $.ui.log(text.slice(0, LOG_LIMIT), { to: 'debug' })
}

// Inline the pane is as tall as the tree wants (a short plan wastes no rows); docked it is
// PANE_COLUMNS wide. Both are requests: the host decides the placement and may keep a size
// the person dragged.
//
// `rows` only counts when the pane opens: one already open keeps the size it opened at (the
// session-start open sees an empty plan, so 6 rows). `resize` closes it first so the person's
// `/todo` re-opens at the height the plan wants now.
async function openPane($: EngineInterface, resize = false): Promise<void> {
  const [p, a] = await Promise.all([read($, plan), read($, activity)])
  const rows = paneRows(p, a)
  if (resize && (await $.ui.panes()).some(pane => pane.id === PANE)) await $.ui.close({ id: PANE })
  await $.ui.open({ id: PANE, title: 'Plan', rows, columns: PANE_COLUMNS })
}

// Re-opens the listed pane so the host sizes it for the terminal and plan as they are now.
// The fit is recorded first: the re-open redraws the pane, and that render must find the same
// fit and stop. A pane the person closed is not listed and is left closed.
async function refitPane($: EngineInterface, fit: PaneFit): Promise<void> {
  if (!(await $.ui.panes()).some(pane => pane.id === PANE)) return
  await update($, paneFit, () => fit)
  await $.ui.close({ id: PANE })
  const opened = await $.ui.open({ id: PANE, title: 'Plan', rows: fit.wantRows, columns: PANE_COLUMNS })
  // The fit stays recorded, so a render that finds it unchanged does not try again.
  if (!opened.isPlaced) $.ui.log(`todo-list: refit open not placed: ${opened.reason}`.slice(0, LOG_LIMIT), { to: 'debug' })
}

async function runTodoCommand(
  $: EngineInterface,
  args: string,
  presentation: CommandPresentation,
): Promise<{ text: string }> {
  const raw = args.trim()
  const word = raw.toLowerCase()
  if (word === 'color' || word.startsWith('color ')) {
    const value = raw.slice('color'.length).trim()
    if (value.toLowerCase() === 'reset') {
      await update($, accentOverride, () => null)

      return { text: 'Accent color reset.' }
    }
    if (!ACCENT_PATTERN.test(value)) return { text: USAGE }
    await update($, accentOverride, () => value)

    return { text: `Accent color set to ${value}.` }
  }
  if (word === '') {
    await openPane($, true)
    const tip = !presentation.isFullscreen && presentation.columns >= DOCK_MIN_COLUMNS ? DOCK_TIP : ''

    return { text: `Plan pane opened.${tip}` }
  }
  if (word === 'off' || word === 'on') {
    await update($, enforceSession, () => word === 'on')

    return { text: word === 'on' ? 'Plan enforcement is on.' : 'Plan enforcement is off for this session.' }
  }
  if (word !== 'clear') return { text: USAGE }
  await update($, plan, () => emptyPlan())
  await update($, task, () => EMPTY_TASK)
  await refreshStatus($)

  return { text: 'Plan cleared.' }
}

// A toast failure must never change the deny/allow outcome of the gate.
function safeToast($: EngineInterface, text: string): void {
  try {
    $.ui.toast(text)
  } catch (error) {
    try {
      $.ui.log(`todo-list: toast threw ${String(error)}`, { to: 'debug' })
    } catch {
      // Logging must never throw out of a hook.
    }
  }
}

// The gate (D8). Runs for main-loop calls other than the plan tool, inside guard(): any throw,
// including one from the state, allows the call; a toast failure is caught and does not. `denies` counts blocked calls in this turn
// (turn.start resets it); after MAX_DENIES the gate pauses, and the pause toast shows once
// because the pausing call moves `denies` past MAX_DENIES.
async function runGate($: EngineInterface, tool: string, enforceConfig: boolean): Promise<GateDecision> {
  const [stored, session, t] = await Promise.all([read($, planTool), read($, enforceSession), read($, task)])
  const decision = decideGate({
    tool,
    isPlanTool: false,
    planToolName: stored.name ?? PLAN_TOOL_FULL_NAME,
    enforceConfig,
    enforceSession: session,
    toolRegistered: stored.name !== null,
    toolOffered: stored.offered,
    planned: t.planned,
    denies: t.denies,
  })
  if (decision.kind === 'deny') {
    await update($, task, cur => ({ ...cur, denies: cur.denies + 1 }))
    if (t.denies === 0) safeToast($, `Blocked ${tool}: no plan yet. /todo off turns this off.`)
  } else if (decision.kind === 'pause' && t.denies === MAX_DENIES) {
    await update($, task, cur => ({ ...cur, denies: cur.denies + 1 }))
    safeToast($, decision.toast)
  }

  return decision
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

// Mirrors a successful TaskCreate/TaskUpdate/TodoWrite call into the plan (D10). The call has
// already run; a rejected mapping (a limit, say) leaves the plan alone and is only logged.
async function mirror($: EngineInterface, name: string, apply: (cur: Plan, now: number) => PlanResult): Promise<void> {
  const now = await $.clock.now()
  let failure: string | null = null
  await update($, plan, (cur: Plan) => {
    const out = apply(cur, now)
    if ('error' in out) {
      failure = out.error

      return cur
    }

    return out.plan
  })
  if (failure !== null) {
    $.ui.log(`todo-list: ${name} not mirrored: ${failure}`, { to: 'debug' })

    return
  }
  await update($, task, onPlanTouched)
  await refreshStatus($)
}

export const register: Register = (on, options) => {
  // A missing value counts as on (D8).
  const enforceConfig = options.enforce !== false
  // Effective accent = session override ?? plugin option ?? cyan.
  const accentConfig =
    typeof options.accentColor === 'string' && ACCENT_PATTERN.test(options.accentColor) ? options.accentColor : DEFAULT_ACCENT

  on('session.start', async ($, e, next) => {
    await guard($, 'session.start', undefined, async () => {
      try {
        const registered = await $.tool.register({
          name: PLAN_TOOL_SHORT_NAME,
          description: PLAN_TOOL_DESCRIPTION,
          inputSchema: PLAN_INPUT_SCHEMA,
        })
        await update($, planTool, cur => ({ ...cur, name: registered.tool }))
        // The describe answer is cached per session: after a hot reload it may have been computed
        // before this module's pin existed, which leaves the tool deferred behind ToolSearch.
        try {
          $.ui.invalidate('tool.describe')
        } catch (error) {
          $.ui.log(`todo-list: tool.describe invalidate failed ${String(error)}`, { to: 'debug' })
        }
      } catch (error) {
        // The name stays null: the gate and the instruction both fail open without the tool.
        $.ui.log(`todo-list: plan tool registration failed ${String(error)}`, { to: 'debug' })
      }
      await $.command.register({
        name: 'todo',
        description: 'Show the plan pane, clear the plan, or turn plan enforcement off or on',
        argumentHint: 'clear | off | on | color <name|#hex|reset>',
      })
      // The pane opens unasked only on the terminal under a person at the prompt.
      if (e.isInteractive && e.surface === 'terminal') await openPane($)
    })

    return next(e)
  })

  on('command.run', { command: 'todo' }, async ($, e) =>
    guard($, 'command.run', { text: 'Todo command failed.' }, () => runTodoCommand($, e.args, e.presentation)),
  )

  // Without the pin the tool is deferred behind ToolSearch and the model does not see it on
  // turn one (T01 Q2).
  on('tool.describe', async ($, e, next) => {
    const stored = await guard($, 'tool.describe', null as string | null, async () => (await read($, planTool)).name)
    if (!isPlanTool(e.tool, stored)) return next(e)

    return { ...e, isDeferred: false }
  })

  // Session activity (T09). Observe-only hooks: each records an event and returns what `next`
  // returns, unchanged; a guard failure never blocks or alters the call. The tool.call part of
  // it lives in the single catch-all tool.call hook below.
  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    await guard($, 'tool.check activity', undefined, async () => {
      if (verdict.decision === 'ask' && e.tool_use_id !== undefined) {
        await applyActivity($, { type: 'permissionAsk', tool: e.tool })
      }
    })

    return verdict
  })

  // Second permission signal. Recorded before next: the chain may wait on the dialog itself.
  // Repeating permissionAsk is idempotent in the reducer.
  on('classic.PermissionRequest', async ($, e, next) => {
    await guard($, 'PermissionRequest', undefined, () => applyActivity($, { type: 'permissionAsk', tool: e.tool_name }))

    return next(e)
  })

  on('classic.SubagentStart', async ($, e, next) => {
    await guard($, 'SubagentStart', undefined, () => applyActivity($, { type: 'subagentStart', id: e.agent_id }))

    return next(e)
  })

  on('classic.SubagentStop', async ($, e, next) => {
    await guard($, 'SubagentStop', undefined, () => applyActivity($, { type: 'subagentStop', id: e.agent_id }))

    return next(e)
  })

  on('classic.StopFailure', async ($, e, next) => {
    await guard($, 'StopFailure', undefined, () =>
      applyActivity($, { type: 'stopFailure', detail: e.error_details ?? e.error }),
    )

    return next(e)
  })

  // Only the notification type is logged for now (spike: only permission_prompt observed).
  on('classic.Notification', async ($, e, next) => {
    await guard($, 'Notification', undefined, () => {
      debugLog($, `todo-list: notification ${clean(e.notification_type)}`)
    })

    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    await guard($, 'compact start', undefined, () => applyActivity($, { type: 'compactStart' }))
    try {
      return await next(e)
    } finally {
      await guard($, 'compact end', undefined, () => applyActivity($, { type: 'compactEnd' }))
    }
  })

  // The subagent's turn.complete carries agentId; the reducer ignores it (T01 Q7).
  on('turn.complete', async ($, e, next) => {
    await guard($, 'turn.complete', undefined, () =>
      applyActivity($, { type: 'turnComplete', reason: e.reason, agentId: e.agentId }),
    )

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await guard($, 'session.end', undefined, () => applyActivity($, { type: 'sessionClear' }))
    }

    return next(e)
  })

  // No tool.check hook for the plan tool: the tool.call hook answers before any check (Q4).
  // The catch-all form is used because the registered name is known only after session.start.
  //
  // One catch-all tool.call hook only: the host refuses two without a matcher. It does two jobs
  // in this order. (1) The plan tool and subagent calls: the plan tool is answered right here
  // and never reaches the activity code, so the activity wrapper cannot swallow its answer;
  // a subagent call goes straight to next(e). (2) Every other main-loop call is wrapped in
  // activity start/end around next(e) and its result is returned untouched. This hook is
  // registered BEFORE the matcher hooks for TaskCreate/TaskUpdate/TodoWrite below (first
  // registered is outermost), so those mirrors run inside next(e), still see the real result,
  // and their results pass back out through this wrapper unchanged.
  on('tool.call', async ($, e, next) => {
    const kind = await guard($, 'tool.call', 'skip' as 'skip' | 'plan' | 'tool' | 'question', async () => {
      const stored = (await read($, planTool)).name
      if (isPlanTool(e.tool, stored)) return 'plan'
      if (e.agentId !== undefined) return 'skip'

      return e.tool === ASK_TOOL ? 'question' : 'tool'
    })
    if (kind === 'skip') return next(e)
    if (kind === 'plan') {
      return guard($, 'plan tool', { result: 'Error: the plan tool failed. Try again.' }, () =>
        answerPlanCall($, e, e.agentId),
      )
    }
    // The gate runs after the plan answer and before the activity wrapper, so a denied call never
    // shows as Running. A guard failure allows the call.
    const gated = await guard($, 'gate', { kind: 'allow' } as GateDecision, () => runGate($, e.tool, enforceConfig))
    if (gated.kind === 'deny') return { deny: gated.message }
    const open: ActivityEvent = kind === 'question' ? { type: 'questionOpen' } : { type: 'toolStart', tool: e.tool }
    const close: ActivityEvent = kind === 'question' ? { type: 'questionClose' } : { type: 'toolEnd' }
    await guard($, 'tool start', undefined, () => applyActivity($, open))
    try {
      return await next(e)
    } finally {
      await guard($, 'tool end', undefined, () => applyActivity($, close))
    }
  })

  // D10: mirror TaskCreate, TaskUpdate and TodoWrite into the tree. Main loop only; each hook
  // lets the call run first and applies it only after it succeeded. The result is never changed.
  on('tool.call', { tool: 'TaskCreate' }, async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran
    await guard($, 'TaskCreate', undefined, () =>
      mirror($, 'TaskCreate', (cur, now) =>
        ingestTaskCreate(cur, { id: ran.result.task.id, subject: e.subject, activeForm: e.activeForm }, now),
      ),
    )

    return ran
  })

  on('tool.call', { tool: 'TaskUpdate' }, async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true || !ran.result.success) return ran
    await guard($, 'TaskUpdate', undefined, () =>
      mirror($, 'TaskUpdate', (cur, now) =>
        ingestTaskUpdate(cur, { taskId: e.taskId, subject: e.subject, activeForm: e.activeForm, status: e.status }, now),
      ),
    )

    return ran
  })

  on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran
    await guard($, 'TodoWrite', undefined, () =>
      mirror($, 'TodoWrite', (cur, now) => ingestTodoWrite(cur, ran.result.newTodos ?? e.todos, now)),
    )

    return ran
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
    await guard($, 'turn.start activity', undefined, () => applyActivity($, { type: 'turnStart' }))

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
        const [p, a, override] = await Promise.all([read($, plan), read($, activity), read($, accentOverride)])
        // The engine clips the body to scroll.bodyRows, so the tree must fit that and not the
        // whole terminal, or the bottom (usually the current step) is cut off silently.
        const bodyRows = e.props.scroll?.bodyRows ?? 0
        const maxLines = bodyRows > 0 ? bodyRows : Math.max(6, (e.viewport?.rows ?? PANE_ROWS) - 4)
        // bodyColumns is the room inside the pane frame; the viewport is the whole terminal.
        const width = e.props.bodyColumns > 0 ? e.props.bodyColumns : DEFAULT_WIDTH
        const accent = override ?? accentConfig
        // The host keeps the size a pane opened at, and a change of height alone does not redraw
        // it. A render that sees another terminal size, placement or plan height re-opens it.
        // Fired and not awaited: the re-open closes the instance being drawn. Main view only.
        if (e.viewport !== undefined && e.props.view?.agentId === undefined) {
          const fit: PaneFit = {
            columns: e.viewport.columns,
            rows: e.viewport.rows,
            placement: e.props.placement,
            wantRows: paneRows(p, a),
          }
          const prev = await read($, paneFit)
          if (needsRefit(prev, fit)) {
            void guard($, 'refit pane', undefined, () => refitPane($, fit))
          }
        }

        return (
          <Box flexDirection="column">
            {buildTree(p, a, { maxLines, width, accent }).map((line, i) => (
              <Text key={`line-${i}`} wrap="truncate-end">
                {line.segments.length === 1 && line.text === ''
                  ? ' '
                  : line.segments.map((s, k) => (
                      <Text
                        key={`seg-${k}`}
                        color={s.color}
                        bold={s.bold}
                        dimColor={s.dim}
                        strikethrough={s.strikethrough}
                      >
                        {s.text}
                      </Text>
                    ))}
              </Text>
            ))}
          </Box>
        )
      },
    ),
  )
}
