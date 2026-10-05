import type { CommandRunInput, EngineInterface, On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'

// The plan tool is called by its literal name: $.tool.register is not available under
// `claude plugin test` (T01 Q9), and the hooks match this name whether or not registration ran.
// The test engine `$` has no `state`, and a test hook may not read the plugin's atoms, so every
// assertion goes through what the hooks return, the status line and the pane.
const TOOL = 'mcp__todo-list__plan' as const
const INSTRUCTION_ID = 'todo-list:plan'
const USER = { kind: 'composer' } as const

const SET = {
  tool: TOOL,
  op: 'set',
  title: 'Add README section',
  nodes: [{ title: 'Draft', children: [{ title: 'Outline' }, { title: 'Write' }] }, { title: 'Review' }],
}
const SHOW = { tool: TOOL, op: 'show' }

// The world beneath the mod: a clock, a log sink and a status recorder.
const setup = (on: On): { logs: string[]; statuses: Array<string | undefined> } => {
  const logs: string[] = []
  const statuses: Array<string | undefined> = []
  mock.clock(on)
  on('ui.log', async (_$, e, next) => {
    logs.push(e.text)

    return next(e)
  })
  on('ui.status', async (_$, e, next) => {
    statuses.push(e.text)

    return next(e)
  })

  return { logs, statuses }
}

test('plan set updates the plan, the status line and returns the text tree', async ($, on) => {
  const { statuses, logs } = setup(on)
  const out = await $.tool.call(SET)
  expect(logs).toEqual([])
  expect(out.result).toContain('Plan: Add README section (0/3 done)')
  expect(out.result).toContain('1 [pending] Draft')
  expect(out.result).toContain('  1.1 [pending] Outline')
  expect(statuses).toEqual(['Plan 0/3 · Outline'])
  // The atom holds the plan: a later show returns the same tree.
  expect((await $.tool.call(SHOW)).result).toBe(out.result)
})

test('a bad plan op returns Error text and leaves the plan unchanged', async ($, on) => {
  const { statuses } = setup(on)
  const set = await $.tool.call(SET)
  const out = await $.tool.call({ tool: TOOL, op: 'update', updates: [{ id: '9', status: 'completed' }] })
  expect(String(out.result)).toMatch(/^Error:/)
  const bogus = await $.tool.call({ tool: TOOL, op: 'explode' })
  expect(String(bogus.result)).toMatch(/^Error:/)
  expect(statuses).toEqual(['Plan 0/3 · Outline'])
  expect((await $.tool.call(SHOW)).result).toBe(set.result)
})

test('a subagent plan call changes nothing', async ($, on) => {
  const { statuses } = setup(on)
  // agentId is set by the engine for a subagent loop; the object is widened to carry it.
  const subagentCall: Parameters<typeof $.tool.call>[0] & { agentId: string } = { ...SET, agentId: 'sub-1' }
  const out = await $.tool.call(subagentCall)
  expect(String(out.result)).toContain('owned by the main session')
  expect(statuses).toEqual([])
  expect(String((await $.tool.call(SHOW)).result)).toContain('No plan yet')
})

test('prompt.compose adds the plan section once, and only when the tool is offered', async ($, on) => {
  setup(on)
  const base = { model: 'm', promptModel: 'm', surfaces: [], outputStyle: null, traits: [] }
  on('prompt.compose', async () => ({ sections: [] }))
  const withTool = await $.prompt.compose({ ...base, tools: ['Read', TOOL] })
  const again = await $.prompt.compose({ ...base, tools: ['Read', TOOL] })
  expect(withTool.sections.filter(s => s.id === INSTRUCTION_ID)).toHaveLength(1)
  expect(again.sections.filter(s => s.id === INSTRUCTION_ID)).toHaveLength(1)
  expect(withTool.sections.find(s => s.id === INSTRUCTION_ID)?.text).toContain(TOOL)
  const without = await $.prompt.compose({ ...base, tools: ['Read', 'Bash'] })
  expect(without.sections.filter(s => s.id === INSTRUCTION_ID)).toHaveLength(0)
})

test('tool.describe pins the plan tool and leaves other tools alone', async ($, on) => {
  setup(on)
  on('tool.describe', async (_$, e) => ({ description: e.description, isDeferred: true as const }))
  const plain = await $.tool.describe({ tool: 'Read', description: 'd', provider: { plugin: 'engine', tier: 'core' } })
  expect(plain.isDeferred).toBe(true)
  const pinned = await $.tool.describe({ tool: TOOL, description: 'd', provider: { plugin: 'todo-list', tier: 'user' } })
  expect(pinned.isDeferred).toBe(false)
})

test('prompt.submit attaches the plan as context, and nothing for an empty plan', async ($, on) => {
  setup(on)
  on('prompt.submit', async (_$, e) => ({ text: e.text, context: e.context }))
  const empty = await $.prompt.submit({ text: 'hello', wait: false, origin: USER })
  expect(empty.context ?? []).toEqual([])
  await $.tool.call(SET)
  const out = await $.prompt.submit({ text: 'continue', wait: false, origin: USER })
  expect(out.context).toHaveLength(1)
  expect(out.context?.[0]).toContain(`update it with ${TOOL}`)
  expect(out.context?.[0]).toContain('1.2 [pending] Write')
})

test('turn.start runs the task lifecycle without a guard failure', async ($, on) => {
  const { logs } = setup(on)
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }))
  await $.tool.call(SET)
  await $.turn.start({ text: 'next prompt', turnId: 't1' })
  expect(logs).toEqual([])
})

const todo = (args: string): CommandRunInput => ({
  command: 'todo',
  args,
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 80 },
})

test('/todo clear empties the plan and the status line; other subcommands show usage', async ($, on) => {
  const { statuses } = setup(on)
  await $.tool.call(SET)
  const bad = await $.command.run(todo('add write docs'))
  expect(bad.text).toContain('Usage: /todo')
  expect(String((await $.tool.call(SHOW)).result)).toContain('1.2 [pending] Write')
  const out = await $.command.run(todo('clear'))
  expect(out.text).toBe('Plan cleared.')
  expect(String((await $.tool.call(SHOW)).result)).toContain('No plan yet')
  expect(statuses.at(-1)).toBeUndefined()
})

test('/todo with no args opens the pane', async ($, on) => {
  setup(on)
  const opened: string[] = []
  on('ui.open', async (_$, e) => {
    opened.push(e.id)

    return { value: { isPlaced: true as const } }
  })
  const out = await $.command.run(todo(''))
  expect(out.text).toBe('Plan pane opened.')
  expect(opened).toEqual(['todo'])
})

// The tool beneath the mod: the stub stands in for the real tool and supplies the result.
const stubTasks = (on: On, update: { success: boolean } = { success: true }): void => {
  on('tool.call', { tool: 'TaskCreate' }, async () => ({ result: { task: { id: '5', subject: 'Write docs' } } }))
  on('tool.call', { tool: 'TaskUpdate' }, async () => ({
    result: { success: update.success, taskId: '5', updatedFields: ['status'] },
  }))
}
const CREATE = { tool: 'TaskCreate', subject: 'Write docs', description: 'd', activeForm: 'Writing docs' } as const
const START = { tool: 'TaskUpdate', taskId: '5', status: 'in_progress' } as const

test('a successful TaskCreate and TaskUpdate fill and patch the tree', async ($, on) => {
  const { statuses, logs } = setup(on)
  stubTasks(on)
  const out = await $.tool.call(CREATE)
  expect(out.result).toEqual({ task: { id: '5', subject: 'Write docs' } })
  // T09: the call itself now shows as Running, then the mirrored plan, then back to Working.
  expect(statuses).toEqual(['Running TaskCreate', 'Plan 0/1 · Writing docs · Running TaskCreate', 'Plan 0/1 · Writing docs · Working'])
  expect(String((await $.tool.call(SHOW)).result)).toContain('1 [pending] Write docs')
  await $.tool.call(START)
  expect(String((await $.tool.call(SHOW)).result)).toContain('1 [in_progress] Write docs')
  await $.tool.call({ tool: 'TaskUpdate', taskId: '5', status: 'deleted' })
  expect(String((await $.tool.call(SHOW)).result)).toContain('No plan yet')
  expect(logs).toEqual([])
})

test('task nodes survive a later plan set', async ($, on) => {
  setup(on)
  stubTasks(on)
  await $.tool.call(CREATE)
  const out = await $.tool.call(SET)
  expect(String(out.result)).toContain('Write docs')
  expect(String(out.result)).toContain('Draft')
})

test('denied, errored and subagent task calls change nothing', async ($, on) => {
  const { statuses } = setup(on)
  on('tool.call', { tool: 'TaskCreate' }, async (_$, e) => {
    if (e.subject === 'denied') return { deny: 'no' }
    const result = { task: { id: '5', subject: e.subject } }

    return e.subject === 'errored' ? { result, isError: true as const } : { result }
  })
  await $.tool.call({ ...CREATE, subject: 'denied' })
  await $.tool.call({ ...CREATE, subject: 'errored' })
  const sub: Parameters<typeof $.tool.call>[0] & { agentId: string } = { ...CREATE, agentId: 'sub-1' }
  await $.tool.call(sub)
  // T09: the denied and errored main-loop calls show Running then Working; no plan status appears.
  expect(statuses.filter(s => s?.includes('Plan'))).toEqual([])
  expect(statuses).toEqual(['Running TaskCreate', 'Working', 'Running TaskCreate', 'Working'])
  expect(String((await $.tool.call(SHOW)).result)).toContain('No plan yet')
})

test('a TaskUpdate that did not succeed changes nothing', async ($, on) => {
  const { statuses } = setup(on)
  const update = { success: true }
  stubTasks(on, update)
  await $.tool.call(CREATE)
  statuses.length = 0
  update.success = false
  await $.tool.call(START)
  // T09: only the activity part of the line changes; the plan part stays as it was.
  expect(statuses).toEqual(['Plan 0/1 · Writing docs · Running TaskUpdate', 'Plan 0/1 · Writing docs · Working'])
  expect(String((await $.tool.call(SHOW)).result)).toContain('1 [pending] Write docs')
})

test('a synthetic TodoWrite event fills the tree with todo nodes', async ($, on) => {
  const { statuses } = setup(on)
  const todos: Array<{ content: string; status: 'pending' | 'in_progress' | 'completed'; activeForm: string }> = [
    { content: 'A', status: 'in_progress', activeForm: 'Doing A' },
    { content: 'B', status: 'pending', activeForm: 'Doing B' },
  ]
  // The synthetic event: the real tool is absent in 2.1.289 (T01 Q6), so the stub plays it.
  on('tool.call', { tool: 'TodoWrite' }, async () => ({ result: { oldTodos: [], newTodos: todos } }))
  await $.tool.call({ tool: 'TodoWrite', todos })
  expect(statuses).toEqual(['Running TodoWrite', 'Plan 0/2 · Doing A · Running TodoWrite', 'Plan 0/2 · Doing A · Working'])
  expect(String((await $.tool.call(SHOW)).result)).toContain('2 [pending] B')
})

// Session activity (T09). Nothing answers beneath the mod under `claude plugin test`
// (T01 Q9), so each test installs the stub the event needs.
// No timers in the test types (types: []), so yield microtasks until the pending hooks parked.
const settle = async (): Promise<void> => {
  for (let i = 0; i < 200; i += 1) await Promise.resolve()
}
// setup() plus the turn.start answer that nothing beneath the mod gives.
const activitySetup = (on: On): ReturnType<typeof setup> => {
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }))

  return setup(on)
}
const BASH = { tool: 'Bash', command: 'ls' } as const
const stubBash = (on: On): void => {
  on('tool.call', { tool: 'Bash' }, async () => ({ result: 'ok' }))
}
// A stub whose `next` stays pending until release() is called.
const pending = (): { wait: Promise<void>; release: () => void } => {
  let release: () => void = () => undefined
  const wait = new Promise<void>(resolve => {
    release = resolve
  })

  return { wait, release }
}

test('running a tool shows Running <tool>, and finishing it falls back to Working', async ($, on) => {
  const { statuses } = activitySetup(on)
  const gate = pending()
  on('tool.call', { tool: 'Bash' }, async () => {
    await gate.wait

    return { result: 'ok' }
  })
  await $.turn.start({ text: 'go', turnId: 't1' })
  expect(statuses.at(-1)).toBe('Working')
  const call = $.tool.call(BASH)
  await settle()
  expect(statuses.at(-1)).toBe('Running Bash')
  gate.release()
  await call
  expect(statuses.at(-1)).toBe('Working')
})

test('a tool that errors still ends the running state', async ($, on) => {
  const { statuses } = activitySetup(on)
  on('tool.call', { tool: 'Bash' }, async () => {
    throw new Error('boom')
  })
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call(BASH).catch(() => undefined)
  expect(statuses.at(-1)).toBe('Working')
})

test('tool.check ask shows Waiting for permission, and PermissionRequest repeats it harmlessly', async ($, on) => {
  const { statuses } = activitySetup(on)
  on('tool.check', async () => ({ decision: 'ask' as const }))
  on('classic.PermissionRequest', async () => ({}))
  // A query carries no tool_use_id and changes nothing.
  await $.tool.check({ tool: 'Bash', input: { command: 'ls' } })
  expect(statuses).toEqual([])
  await $.tool.check({ tool: 'Bash', input: { command: 'ls' }, tool_use_id: 'tu1' })
  expect(statuses.at(-1)).toBe('Waiting for permission: Bash')
  const before = statuses.length
  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: {} })
  expect(statuses.at(-1)).toBe('Waiting for permission: Bash')
  expect(statuses.length).toBe(before + 1)
})

test('an allowed tool.check changes nothing', async ($, on) => {
  const { statuses } = activitySetup(on)
  on('tool.check', async () => ({ decision: 'allow' as const }))
  await $.tool.check({ tool: 'Read', input: {}, tool_use_id: 'tu1' })
  expect(statuses).toEqual([])
})

test('AskUserQuestion shows Waiting for your answer while next is pending', async ($, on) => {
  const { statuses } = activitySetup(on)
  const gate = pending()
  on('tool.call', { tool: 'AskUserQuestion' }, async () => {
    await gate.wait

    return { result: 'answered' }
  })
  await $.turn.start({ text: 'go', turnId: 't1' })
  const call = $.tool.call({ tool: 'AskUserQuestion', questions: [] })
  await settle()
  expect(statuses.at(-1)).toBe('Waiting for your answer')
  gate.release()
  await call
  expect(statuses.at(-1)).toBe('Working')
})

test('the plan tool never shows as Running and its answer passes through', async ($, on) => {
  const { statuses } = activitySetup(on)
  const out = await $.tool.call(SET)
  expect(out.result).toContain('Plan: Add README section')
  expect(statuses).toEqual(['Plan 0/3 · Outline'])
})

test('a mirrored TaskCreate passes through the activity wrapper and ends Running', async ($, on) => {
  const { statuses } = activitySetup(on)
  stubTasks(on)
  await $.turn.start({ text: 'go', turnId: 't1' })
  const out = await $.tool.call(CREATE)
  expect(out.result).toEqual({ task: { id: '5', subject: 'Write docs' } })
  expect(statuses.at(-1)).toBe('Plan 0/1 · Writing docs · Working')
})

test('a subagent tool call does not show as Running', async ($, on) => {
  const { statuses } = activitySetup(on)
  stubBash(on)
  const sub: Parameters<typeof $.tool.call>[0] & { agentId: string } = { ...BASH, agentId: 'sub-1' }
  await $.tool.call(sub)
  expect(statuses).toEqual([])
})

test('compacting shows Compacting while next is pending, then resumes', async ($, on) => {
  const { statuses } = activitySetup(on)
  const gate = pending()
  on('session.compact', async () => {
    await gate.wait

    return { skip: 'test' }
  })
  await $.turn.start({ text: 'go', turnId: 't1' })
  // next() refuses an empty transcript, so the call carries one message.
  const run = $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'hello', toolUses: [] }] })
  await settle()
  expect(statuses.at(-1)).toBe('Compacting')
  gate.release()
  await run
  expect(statuses.at(-1)).toBe('Working')
})

test('subagent start and stop count running subagents, by id', async ($, on) => {
  const { statuses } = activitySetup(on)
  on('classic.SubagentStart', async () => ({}))
  on('classic.SubagentStop', async () => ({}))
  const start = (id: string) => $.classic.SubagentStart({ agent_id: id, agent_type: 'general-purpose' })
  const stop = (id: string) =>
    $.classic.SubagentStop({
      agent_id: id,
      agent_type: 'general-purpose',
      agent_transcript_path: '',
      stop_hook_active: false,
    })
  await start('a1')
  expect(statuses.at(-1)).toBe('Idle · 1 subagent')
  await start('a1')
  await start('a2')
  expect(statuses.at(-1)).toBe('Idle · 2 subagents')
  await stop('unrelated')
  expect(statuses.at(-1)).toBe('Idle · 2 subagents')
  await stop('a1')
  await stop('a2')
  expect(statuses.at(-1)).toBeUndefined()
})

test('turn.complete shows Interrupted and Error, and answer returns to idle', async ($, on) => {
  const { statuses } = activitySetup(on)
  on('turn.complete', async (_$, e) => ({ text: e.answer }))
  const done = (reason: 'answer' | 'aborted' | 'error') =>
    $.turn.complete({ answer: '', durationMs: 1, isAborted: reason === 'aborted', turnId: 't1', reason })
  await $.turn.start({ text: 'go', turnId: 't1' })
  await done('aborted')
  expect(statuses.at(-1)).toBe('Interrupted')
  await $.turn.start({ text: 'again', turnId: 't2' })
  await done('error')
  expect(statuses.at(-1)).toBe('Error')
  await $.turn.start({ text: 'again', turnId: 't3' })
  await done('answer')
  expect(statuses.at(-1)).toBeUndefined()
})

test('StopFailure shows Error with the detail', async ($, on) => {
  const { statuses } = activitySetup(on)
  on('classic.StopFailure', async () => ({}))
  await $.classic.StopFailure({ error: 'rate_limit' })
  expect(statuses.at(-1)).toBe('Error: rate_limit')
})

test('a subagent turn.complete leaves the status unchanged', async ($, on) => {
  const { statuses } = activitySetup(on)
  on('turn.complete', async (_$, e) => ({ text: e.answer }))
  await $.turn.start({ text: 'go', turnId: 't1' })
  const before = statuses.at(-1)
  await $.turn.complete({
    answer: '',
    durationMs: 1,
    isAborted: true,
    turnId: 't1',
    reason: 'aborted',
    agentId: 'sub-1',
  })
  expect(statuses.at(-1)).toBe(before)
  expect(before).toBe('Working')
})

test('session.end with reason clear resets the activity; other reasons do not', async ($, on) => {
  const { statuses } = activitySetup(on)
  on('session.end', async (_$, e) => ({ sessionId: e.sessionId }))
  await $.turn.start({ text: 'go', turnId: 't1' })
  const end = (reason: 'clear' | 'other') =>
    $.session.end({ reason, sessionId: 's1', resume: { id: 's1' } } as Parameters<typeof $.session.end>[0])
  await end('other')
  expect(statuses.at(-1)).toBe('Working')
  await end('clear')
  expect(statuses.at(-1)).toBeUndefined()
})

test('Notification is logged by type only, and the call result is unchanged', async ($, on) => {
  const { logs } = activitySetup(on)
  on('classic.Notification', async () => ({}))
  await $.classic.Notification({ message: 'secret text', notification_type: 'permission_prompt' })
  expect(logs).toEqual(['todo-list: notification permission_prompt'])
})

// The gate (T10). The gate allows unless the plan tool is registered and offered, and under
// `claude plugin test` registration does not run, so each test first sends a prompt.compose that
// lists the plan tool, which stores the name and marks it offered. Edit and Bash are stubbed
// beneath the mod, and toasts are recorded.
const gateSetup = async ($: Engine, on: On, corrupt = { task: false, toast: false }): Promise<{ toasts: string[] }> => {
  const toasts: string[] = []
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }))
  on('prompt.compose', async () => ({ sections: [] }))
  on('ui.toast', async (_$, e, next) => {
    if (corrupt.toast) throw new Error('toast failed')
    toasts.push(e.text)

    return next(e)
  })
  // The seam for a forced throw: once `corrupt.task` is set, the task atom reads back malformed.
  on('state.get', async (_$, e, next) => (corrupt.task && e.key === 'task' ? { value: { value: null, version: 1 } } : next(e)))
  on('tool.call', { tool: 'Edit' }, async () => ({ result: 'edited' }))
  on('tool.call', { tool: 'Read' }, async () => ({ result: 'read' }))
  setup(on)
  const base = { model: 'm', promptModel: 'm', surfaces: [], outputStyle: null, traits: [] }
  await $.prompt.compose({ ...base, tools: ['Read', 'Edit', TOOL] })

  return { toasts }
}
const EDIT = { tool: 'Edit', file_path: '/x', old_string: 'a', new_string: 'b' } as const
const isDenied = (out: { deny?: string }): boolean => out.deny !== undefined

test('gate: Edit is denied before a plan and allowed after a set', async ($, on) => {
  const { toasts } = await gateSetup($, on)
  await $.turn.start({ text: 'edit a file', turnId: 't1' })
  const denied = await $.tool.call(EDIT)
  expect(denied.deny).toContain(TOOL)
  expect(denied.deny).toContain('"op":"set"')
  expect(toasts).toEqual(['Blocked Edit: no plan yet. /todo off turns this off.'])
  await $.tool.call(SET)
  const allowed = await $.tool.call(EDIT)
  expect(allowed.deny).toBeUndefined()
  expect(allowed.result).toBe('edited')
})

test('gate: Read is allowed with no plan', async ($, on) => {
  const { toasts } = await gateSetup($, on)
  await $.turn.start({ text: 'look', turnId: 't1' })
  const out = await $.tool.call({ tool: 'Read', file_path: '/x' })
  expect(out.result).toBe('read')
  expect(toasts).toEqual([])
})

test('gate: enforce false in the plugin options allows Edit', { options: { enforce: false } }, async ($, on) => {
  const { toasts } = await gateSetup($, on)
  await $.turn.start({ text: 'edit a file', turnId: 't1' })
  const out = await $.tool.call(EDIT)
  expect(out.result).toBe('edited')
  expect(toasts).toEqual([])
})

test('gate: /todo off allows Edit and /todo on re-arms the gate', async ($, on) => {
  await gateSetup($, on)
  await $.turn.start({ text: 'edit a file', turnId: 't1' })
  const off = await $.command.run(todo('off'))
  expect(off.text).toContain('off')
  expect((await $.tool.call(EDIT)).result).toBe('edited')
  const onReply = await $.command.run(todo('on'))
  expect(onReply.text).toContain('on')
  expect(isDenied(await $.tool.call(EDIT))).toBe(true)
})

test('gate: a throw in the gate path allows the call', async ($, on) => {
  const corrupt = { task: false, toast: false }
  await gateSetup($, on, corrupt)
  await $.turn.start({ text: 'edit a file', turnId: 't1' })
  expect(isDenied(await $.tool.call(EDIT))).toBe(true)
  // The gate now reads a malformed task atom and throws; the guard fails open.
  corrupt.task = true
  const out = await $.tool.call(EDIT)
  expect(out.deny).toBeUndefined()
  expect(out.result).toBe('edited')
})

test('gate: a subagent Edit is allowed', async ($, on) => {
  const { toasts } = await gateSetup($, on)
  await $.turn.start({ text: 'edit a file', turnId: 't1' })
  const sub: Parameters<typeof $.tool.call>[0] & { agentId: string } = { ...EDIT, agentId: 'sub-1' }
  const out = await $.tool.call(sub)
  expect(out.result).toBe('edited')
  expect(toasts).toEqual([])
})

test('gate: the 4th blocked call in a turn is allowed, and the toast shows once per turn', async ($, on) => {
  const { toasts } = await gateSetup($, on)
  await $.turn.start({ text: 'edit a file', turnId: 't1' })
  expect(isDenied(await $.tool.call(EDIT))).toBe(true)
  expect(isDenied(await $.tool.call(EDIT))).toBe(true)
  expect(isDenied(await $.tool.call(EDIT))).toBe(true)
  // Three denies, one deny toast.
  expect(toasts).toEqual(['Blocked Edit: no plan yet. /todo off turns this off.'])
  expect((await $.tool.call(EDIT)).result).toBe('edited')
  expect((await $.tool.call(EDIT)).result).toBe('edited')
  // The pause toast also shows once.
  expect(toasts).toEqual(['Blocked Edit: no plan yet. /todo off turns this off.', 'Plan enforcement paused for this turn'])
  // A new prompt re-arms the gate and the deny toast shows again.
  await $.turn.start({ text: 'another edit', turnId: 't2' })
  expect(isDenied(await $.tool.call(EDIT))).toBe(true)
  expect(toasts).toHaveLength(3)
})

test('gate: a throwing toast does not change the deny', async ($, on) => {
  const corrupt = { task: false, toast: true }
  await gateSetup($, on, corrupt)
  await $.turn.start({ text: 'edit a file', turnId: 't1' })
  const denied = await $.tool.call(EDIT)
  expect(denied.deny).toContain(TOOL)
  expect(denied.result).toBeUndefined()
})
