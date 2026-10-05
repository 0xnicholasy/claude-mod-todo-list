import type { CommandRunInput, On } from 'claude-code'
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
  expect(statuses).toEqual(['Plan 0/1 · Writing docs'])
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
  expect(statuses).toEqual([])
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
  expect(statuses).toEqual([])
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
  expect(statuses).toEqual(['Plan 0/2 · Doing A'])
  expect(String((await $.tool.call(SHOW)).result)).toContain('2 [pending] B')
})
