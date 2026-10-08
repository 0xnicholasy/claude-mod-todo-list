import { atom, read, update } from 'claude-code'
import type { CommandPresentation, EngineInterface, Register } from 'claude-code'
import type { Plan, PlanToolState, TaskState } from '../types'
import { emptyActivity, reduceActivity } from './activity'
import type { ActivityEvent } from './activity'
import { needsRefit } from './fit'
import type { PaneFit } from './fit'
import type { GateDecision, GateTransition } from './gate'
import { INSTRUCTION_ID, INSTRUCTION_TEXT, onNewPrompt, onPlanTouched, planContext, transition } from './gate'
import { DROPPED_NOT_MIRRORED, DROPPED_UNRECOGNISED, ingestTaskCreate, ingestTaskUpdate, ingestTodoWrite } from './ingest'
import type { IngestResult } from './ingest'
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
import { taskCreateFrom, taskUpdateFailed, taskUpdateFrom, todosFrom } from './post-tool'
import { clean } from './sanitize'
import { ACCENT_STORE_KEY, resolveAccent, validAccent } from './accent'
import { buildTree, DEFAULT_WIDTH, paneRows, statusLine } from './tree'

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
const unknownColorText = (value: string): string =>
  `Unknown color "${value}". Use a name (red, green, yellow, blue, magenta, cyan, white, gray, claude, or a ...Bright variant) or #rrggbb. For orange, try claude.`
const NOT_OWNER_TEXT =
  'Error: the plan is owned by the main session. Subagents cannot change it; report your progress in your result instead.'

const EMPTY_TASK: TaskState = { open: false, planned: false, denies: 0 }
const plan = atom({ plugin: 'todo-list', key: 'plan' } as const, emptyPlan())
const task = atom({ plugin: 'todo-list', key: 'task' } as const, EMPTY_TASK)
const activity = atom({ plugin: 'todo-list', key: 'activity' } as const, emptyActivity(0))
// D8: the session half of the enforcement switch; `/todo on|off` flips it. The other half is the
// plugin option `enforce`.
const enforceSession = atom({ plugin: 'todo-list', key: 'enforceSession' } as const, true as boolean)
// The accent set by `/todo color`, loaded from the plugin store at session start so it applies to
// every session; null defers to the plugin option `accentColor`.
const accentOverride = atom({ plugin: 'todo-list', key: 'accentOverride' } as const, null as string | null)
// Whether the dropped-mirror toast has shown this session. Claimed with a compare-and-set update so
// only one of several concurrent drops toasts. The host resets atoms on /clear (T01 Q7), and the
// session.end clear path resets it too.
const dropShown = atom({ plugin: 'todo-list', key: 'dropShown' } as const, false as boolean)
const planTool = atom({ plugin: 'todo-list', key: 'planTool' } as const, {
  name: null,
  offered: false,
} as PlanToolState)

// What the pane was last re-opened for; null until the first re-open. Written only from refitPane
// (state writes are refused while a render draws).
const paneFit = atom({ plugin: 'todo-list', key: 'paneFit' } as const, null as PaneFit | null)

// Whether the first prompt may still open the pane: 'armed' at an eligible session.start, 'done'
// once the first prompt has had its one chance. Never re-armed, so a pane the person closes stays
// closed. A /clear resets it to 'idle' and no session.start follows, so a cleared session does not re-open.
const firstPromptOpen = atom({ plugin: 'todo-list', key: 'firstPromptOpen' } as const, 'idle' as 'idle' | 'armed' | 'done')

// Runs a hook body and returns its fallback on any throw. Top-level function declaration because
// `$` is passed to it (plugin validate rule).
async function guard<T>(
  $: EngineInterface,
  name: string,
  fallback: T | (() => T),
  body: () => Promise<T> | T,
): Promise<T> {
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

// A debug line must never stop what follows it (a toast, a gate decision), so a throwing log is swallowed.
function debugLog($: EngineInterface, text: string): void {
  try {
    $.ui.log(text.slice(0, LOG_LIMIT), { to: 'debug' })
  } catch {
    // Logging must never throw out of a hook.
  }
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
      try {
        await $.store.delete(ACCENT_STORE_KEY)
      } catch (error) {
        $.ui.log(`todo-list: accent store delete failed ${String(error)}`, { to: 'debug' })

        return { text: 'Accent color reset for this session only; the saved color could not be cleared.' }
      }

      return { text: 'Accent color reset. The saved color is cleared for future sessions.' }
    }
    if (value === '') return { text: USAGE }
    const accent = validAccent(value)
    if (accent === null) return { text: unknownColorText(value) }
    await update($, accentOverride, () => accent)
    try {
      await $.store.set(ACCENT_STORE_KEY, accent)
    } catch (error) {
      $.ui.log(`todo-list: accent store write failed ${String(error)}`, { to: 'debug' })

      return { text: `Accent color set to ${accent} for this session only; it could not be saved.` }
    }

    return { text: `Accent color set to ${accent}. Saved for future sessions.` }
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

// A toast failure must never change the deny/allow outcome of the gate. Answers whether it was shown.
function safeToast($: EngineInterface, text: string): boolean {
  try {
    $.ui.toast(text)

    return true
  } catch (error) {
    debugLog($, `todo-list: toast threw ${String(error)}`)

    return false
  }
}

// The gate (D8). Runs for main-loop calls other than the plan tool, inside guard(): any throw,
// including one from the state, allows the call; a toast failure is caught and does not. `denies` counts blocked calls in this turn
// (turn.start resets it); after MAX_DENIES the gate pauses, and the pause toast shows once
// because the pausing call moves `denies` past MAX_DENIES.
async function runGate($: EngineInterface, tool: string, enforceConfig: boolean): Promise<GateDecision> {
  const [stored, session, snapshot] = await Promise.all([read($, planTool), read($, enforceSession), read($, task)])
  const input = {
    tool,
    isPlanTool: false,
    planToolName: stored.name ?? PLAN_TOOL_FULL_NAME,
    enforceConfig,
    enforceSession: session,
    toolRegistered: stored.name !== null,
    toolOffered: stored.offered,
  }
  // Fast path: within a turn `planned` only goes false to true, so a snapshot that allows with no
  // denies counted is final and needs no write. Any other snapshot goes through the transition.
  const early = transition({ ...snapshot, denies: 0 }, input)
  if (early.decision.kind === 'allow') return early.decision
  // The decision and the deny count come from one transition on the value the write is checked
  // against. `update` reruns the reducer when its write misses ifVersion, so `out` is reassigned on
  // every attempt and only the attempt that landed is acted on. Toasts fire after update resolves.
  let out: GateTransition | undefined
  await update($, task, cur => {
    out = transition(cur, input)

    return out.next
  })
  if (out === undefined) {
    debugLog($, `todo-list: gate reducer did not run, allowing ${tool}`)

    return { kind: 'allow' }
  }
  if (out.toast === 'deny') safeToast($, `Blocked ${tool}: no plan yet. /todo off turns this off.`)
  else if (out.toast === 'pause' && out.decision.kind === 'pause') safeToast($, out.decision.toast)

  return out.decision
}

// Tells the person once per session that a task call was not mirrored. The reason is one of the
// fixed DROPPED_* strings. Must run after the mirror's own update() has resolved, never inside a
// reducer. `update` reruns the reducer when its write misses ifVersion, so `won` is reassigned on
// every attempt and only the attempt that flipped false to true toasts. A claim whose toast failed is released.
async function reportDrop($: EngineInterface, reason: string): Promise<void> {
  let won = false
  await update($, dropShown, cur => {
    won = !cur

    return true
  })
  // A toast that did not show gives the claim back, so the next drop can still tell the person.
  if (won && !safeToast($, `Plan not updated: ${reason}`)) await update($, dropShown, () => false)
}

// A tool response the narrowing does not know: logged with detail, and reported once.
async function dropUnrecognised($: EngineInterface, name: string): Promise<void> {
  debugLog($, `todo-list: ${name} response not recognised, not mirrored`)
  await reportDrop($, DROPPED_UNRECOGNISED)
}

// Answers a call to the plan tool with the text the model reads. The plan tool's tool.call hook
// answers itself and never calls next(e) (T01 Q1/Q3): a result from the hook reaches the model
// verbatim, and an error is result text starting "Error:".
async function answerPlanCall($: EngineInterface, input: unknown, agentId: string | undefined): Promise<string> {
  // Only the main loop owns the plan; a subagent's call changes nothing.
  if (agentId !== undefined) return NOT_OWNER_TEXT
  const parsed = parsePlanInput(input)
  if ('error' in parsed) return parsed.error
  const now = await $.clock.now()
  let applied = { error: 'Error: plan unchanged.' } as PlanApplied
  await update($, plan, (cur: Plan) => {
    applied = applyPlanOp(cur, parsed.parsed, now)

    return 'error' in applied ? cur : applied.plan
  })
  if ('error' in applied) return applied.error
  if (touchesPlan(parsed.parsed)) await update($, task, onPlanTouched)
  await refreshStatus($)

  return applied.text
}

// Mirrors a successful TaskCreate/TaskUpdate/TodoWrite call into the plan (D10). The call has
// already run; a rejected mapping (a limit, say) leaves the plan alone and is only logged. An
// ignored call (a TaskUpdate for an id the plan does not hold) is also only logged: it changes
// nothing, so it neither counts as having a plan nor redraws the status line.
async function mirror($: EngineInterface, name: string, apply: (cur: Plan, now: number) => IngestResult): Promise<void> {
  const now = await $.clock.now()
  // `update` runs the reducer again when its write misses ifVersion, so every attempt assigns the
  // whole outcome: a result from an earlier attempt must not outlive a retry that differs.
  let outcome = { kind: 'failed', text: 'plan unchanged' } as { kind: 'ok' | 'failed' | 'ignored'; text: string }
  await update($, plan, (cur: Plan) => {
    const out = apply(cur, now)
    if ('error' in out) {
      outcome = { kind: 'failed', text: out.error }

      return cur
    }
    if ('ignored' in out) {
      outcome = { kind: 'ignored', text: out.ignored }

      return cur
    }
    outcome = { kind: 'ok', text: '' }

    return out.plan
  })
  if (outcome.kind === 'failed') {
    debugLog($, `todo-list: ${name} not mirrored: ${outcome.text}`)
    await reportDrop($, DROPPED_NOT_MIRRORED)

    return
  }
  if (outcome.kind === 'ignored') {
    debugLog($, `todo-list: ${name} ignored: ${outcome.text}`)

    return
  }
  await update($, task, onPlanTouched)
  await refreshStatus($)
}

// The call id as the activity reducer should see it: a blank id is absent, so the name fallback applies.
const presentId = (id: string | undefined): string | undefined => (id !== undefined && id.trim() !== '' ? id : undefined)

// Ends the activity a finished call started, by its tool_use_id so a parallel batch keeps the calls
// still running. A subagent's call never started one; it only clears a permission label (its own
// ask may be the one shown) and leaves a main-loop tool phase alone. The plan tool never showed as
// Running.
async function endTool(
  $: EngineInterface,
  tool: string,
  toolUseId: string | undefined,
  agentId: string | undefined,
): Promise<void> {
  if (isPlanTool(tool, (await read($, planTool)).name)) return
  if (agentId !== undefined) {
    // Only redraws when a permission label is up, so an ordinary subagent call stays silent.
    if ((await read($, activity)).phase === 'permission') await applyActivity($, { type: 'permissionEnd' })

    return
  }
  const id = presentId(toolUseId)
  await applyActivity($, tool === ASK_TOOL ? { type: 'questionClose' } : { type: 'toolEnd', tool, ...(id !== undefined ? { id } : {}) })
}

// A call finished: ends its activity, then mirrors a main-loop TaskCreate, TaskUpdate or TodoWrite
// into the plan (D10). The hook only runs for a call that succeeded; a response in a shape the
// narrowing does not know is logged and skipped. `input` and `response` are `unknown` because the
// host types tool_input and tool_response that way; post-tool.ts narrows them.
async function afterTool(
  $: EngineInterface,
  tool: string,
  toolUseId: string | undefined,
  input: unknown,
  response: unknown,
  agentId: string | undefined,
): Promise<void> {
  await endTool($, tool, toolUseId, agentId)
  if (agentId !== undefined) return
  if (tool === 'TaskCreate') {
    const created = taskCreateFrom(input, response)
    if (created === null) return dropUnrecognised($, 'TaskCreate')
    await mirror($, 'TaskCreate', (cur, now) => ingestTaskCreate(cur, created, now))
  } else if (tool === 'TaskUpdate') {
    // The tool said the update failed: nothing to mirror and nothing to report.
    if (taskUpdateFailed(response)) return debugLog($, 'todo-list: TaskUpdate reported failure, not mirrored')
    const updated = taskUpdateFrom(input, response)
    if (updated === null) return dropUnrecognised($, 'TaskUpdate')
    await mirror($, 'TaskUpdate', (cur, now) => ingestTaskUpdate(cur, updated, now))
  } else if (tool === 'TodoWrite') {
    const todos = todosFrom(input, response)
    if (todos === null) return dropUnrecognised($, 'TodoWrite')
    await mirror($, 'TodoWrite', (cur, now) => ingestTodoWrite(cur, todos, now))
  }
}

// Loads the colour saved by `/todo color` into the atom. A store error or a bad value keeps the
// default. Atoms reset on /clear after session.end and no session.start fires for it, so the first
// turn.start after a /clear calls this too.
async function loadSavedAccent($: EngineInterface): Promise<void> {
  await guard($, 'accent load', undefined, async () => {
    const saved = validAccent(await $.store.get(ACCENT_STORE_KEY))
    if (saved !== null) await update($, accentOverride, () => saved)
  })
}

export const register: Register = (on, options) => {
  // A missing value counts as on (D8).
  const enforceConfig = options.enforce !== false
  // Effective accent = saved `/todo color` (accentOverride) ?? plugin option ?? default; see resolveAccent.
  const accentConfig = resolveAccent(null, options.accentColor)

  on('session.start', async ($, e, next) => {
    // Load the colour saved by `/todo color`. A store error or a bad value keeps the default.
    await loadSavedAccent($)
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
      // The pane opens unasked only on the terminal under a person at the prompt. The host leaves
      // an unasked open undrawn below 110 columns, so the first prompt (an open the person asked
      // for, placed at any width) opens it again if it is still unplaced.
      if (e.isInteractive && e.surface === 'terminal') {
        await update($, firstPromptOpen, () => 'armed')
        await openPane($)
      }
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

  // Session activity (T09). Observe-only hooks: each records an event and returns the event it was
  // given, unchanged; a guard failure never blocks or alters the call. The tool.call and
  // PostToolUse hooks below record tool start and end.
  //
  // The permission signal. Recorded before next: the chain may wait on the dialog itself.
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

  // A subagent's compaction carries agent_id and is not shown.
  on('classic.PreCompact', async ($, e, next) => {
    if (e.agent_id === undefined) await guard($, 'compact start', undefined, () => applyActivity($, { type: 'compactStart' }))

    return next(e)
  })

  on('classic.PostCompact', async ($, e, next) => {
    if (e.agent_id === undefined) await guard($, 'compact end', undefined, () => applyActivity($, { type: 'compactEnd' }))

    return next(e)
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
      await guard($, 'session.end', undefined, () => update($, dropShown, () => false))
    }

    return next(e)
  })

  // The gate and the start of the activity. The catch-all form is used because the registered name
  // is known only after session.start.
  //
  // The host refuses two tool.call hooks without a matcher, so this is the only one. It passes
  // every call on with next(e) except a gate deny. Subagent calls and the plan tool go straight to
  // next(e): the plan tool is answered by the matcher hook below, which is registered after this
  // one so that this one sees the call first. Other main-loop calls run the gate and, once
  // allowed, record Running (or Waiting for your answer). The end of the call is recorded by
  // classic.PostToolUse and classic.PostToolUseFailure.
  on('tool.call', async ($, e, next) => {
    const kind = await guard($, 'tool.call', 'skip' as 'skip' | 'tool' | 'question', async () => {
      if (e.agentId !== undefined) return 'skip'
      if (isPlanTool(e.tool, (await read($, planTool)).name)) return 'skip'

      return e.tool === ASK_TOOL ? 'question' : 'tool'
    })
    if (kind !== 'tool' && kind !== 'question') return next(e)
    // A guard failure allows the call.
    const gated = await guard($, 'gate', { kind: 'allow' } as GateDecision, () => runGate($, e.tool, enforceConfig))
    // This text is gate.ts's denyText without the tool name (the hook must return a fixed string);
    // register.test.ts checks the two stay in step.
    if (gated.kind === 'deny') {
      return { deny: 'Blocked: there is no plan for this task yet. Call mcp__todo-list__plan with {"op":"set","title":"<task>","nodes":[{"title":"<step>"}]} first, then retry the tool. If the tool is not loaded, load it first with ToolSearch (query "select:mcp__todo-list__plan").' }
    }
    // A denied call never shows as Running.
    // AskUserQuestion only opens the question phase; it has no running entry to end.
    const id = presentId(e.tool_use_id)
    const open: ActivityEvent =
      kind === 'question' ? { type: 'questionOpen' } : { type: 'toolStart', tool: e.tool, ...(id !== undefined ? { id } : {}) }
    await guard($, 'tool start', undefined, () => applyActivity($, open))

    return next(e)
  })

  // The plan tool. The API serves a plugin's own tool only from a tool.call hook, so this one answers
  // every call to it and never reads `next`. The model reads the returned text as the tool result.
  on('tool.call', { tool: 'mcp__todo-list__plan' }, async ($, e) => {
    const text = await guard($, 'plan tool', 'Error: the plan tool failed. Try again.', () =>
      answerPlanCall($, e, e.agentId),
    )

    return { result: text }
  })

  // The end of a call, and D10: mirror TaskCreate, TaskUpdate and TodoWrite into the tree. The hook
  // runs after the tool succeeded and changes nothing in what the model sees.
  on('classic.PostToolUse', async ($, e, next) => {
    await guard($, 'PostToolUse', undefined, () =>
      afterTool($, e.tool_name, e.tool_use_id, e.tool_input, e.tool_response, e.agent_id),
    )

    return next(e)
  })

  on('classic.PostToolUseFailure', async ($, e, next) => {
    await guard($, 'PostToolUseFailure', undefined, () => endTool($, e.tool_name, e.tool_use_id, e.agent_id))

    return next(e)
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

  on('prompt.submit', async ($, e, next) => {
    await guard($, 'first prompt open', undefined, async () => {
      if ((await read($, firstPromptOpen)) !== 'armed') return
      await update($, firstPromptOpen, () => 'done')
      if (!(await $.ui.panes()).some(pane => pane.id === PANE && pane.isPlaced)) await openPane($)
    })

    return next(e)
  })

  // turn.start fires once per prompt of the main loop and not for subagents (T01 Q7).
  on('turn.start', async ($, e, next) => {
    if ((await read($, accentOverride)) === null) await loadSavedAccent($)
    await guard($, 'turn.start', undefined, async () => {
      const current = await read($, plan)
      await update($, task, t => onNewPrompt(t, current, e.text))
    })
    await guard($, 'turn.start activity', undefined, () => applyActivity($, { type: 'turnStart' }))
    // D12: the plan rides each new prompt as a user-role row the model reads (the person does not
    // see it as typed), which also resyncs ids after a compaction.
    await guard($, 'plan context', undefined, async () => {
      const name = (await read($, planTool)).name ?? PLAN_TOOL_FULL_NAME
      const text = planContext(await read($, plan), name, formatForModel)
      if (text !== undefined) await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
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
