import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const TODOS = [{ content: 'Write it', status: 'in_progress' as const, activeForm: 'Writing it' }]
const DONE = { oldTodos: [], newTodos: TODOS }

// The world beneath the mod: a clock, and a log sink that records what a failed guard wrote.
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

// Each test records the status line the mod sets: no entry means the list was never touched.
const watchStatus = (on: Parameters<Parameters<typeof test>[1] & ((...a: never[]) => unknown)>[1]) => on

test('a successful TodoWrite replaces the list and sets the status line', async ($, on) => {
  const { statuses, logs } = setup(on)
  on('tool.call', { tool: 'TodoWrite' }, async () => ({ result: DONE }))
  await $.tool.call({ tool: 'TodoWrite', todos: TODOS })
  expect(logs).toEqual([])
  expect(statuses).toEqual(['Todo 0/1: Writing it'])
})

test('a denied TodoWrite does not touch the list', async ($, on) => {
  const { statuses } = setup(on)
  on('tool.call', { tool: 'TodoWrite' }, async () => ({ deny: 'no' }))
  await $.tool.call({ tool: 'TodoWrite', todos: TODOS })
  expect(statuses).toEqual([])
})

test('a TodoWrite that came back as an error does not touch the list', async ($, on) => {
  const { statuses } = setup(on)
  on('tool.call', { tool: 'TodoWrite' }, async () => ({ result: DONE, isError: true as const }))
  await $.tool.call({ tool: 'TodoWrite', todos: TODOS })
  expect(statuses).toEqual([])
})

test('a TaskUpdate with success false does not touch the list', async ($, on) => {
  const { statuses } = setup(on)
  on('tool.call', { tool: 'TaskCreate' }, async () => ({ result: { task: { id: '7', subject: 'Seven' } } }))
  on('tool.call', { tool: 'TaskUpdate' }, async () => ({
    result: { success: false, taskId: '7', updatedFields: [] },
  }))
  await $.tool.call({ tool: 'TaskCreate', subject: 'Seven', description: 'd' })
  expect(statuses).toEqual(['Todo 0/1'])
  await $.tool.call({ tool: 'TaskUpdate', taskId: '7', status: 'completed' })
  expect(statuses).toEqual(['Todo 0/1'])
})

test('a subagent TodoWrite does not touch the main list', async ($, on) => {
  const { statuses } = setup(on)
  on('tool.call', { tool: 'TodoWrite' }, async () => ({ result: DONE }))
  // agentId is not in $.tool.call's typed arguments (it names the loop, set by the engine);
  // the object is widened to carry it so the engine sees a subagent-loop call.
  const subagentCall: Parameters<typeof $.tool.call>[0] & { agentId: string } = {
    tool: 'TodoWrite',
    todos: TODOS,
    agentId: 'sub-1',
  }
  await $.tool.call(subagentCall)
  expect(statuses).toEqual([])
})

test('prompt.compose adds the todo section once, and none without a todo tool', async ($, on) => {
  const base = { model: 'm', promptModel: 'm', surfaces: [], outputStyle: null, traits: [] }
  on('prompt.compose', async () => ({ sections: [] }))
  const withTool = await $.prompt.compose({ ...base, tools: ['Read', 'TodoWrite'] })
  const again = await $.prompt.compose({ ...base, tools: ['Read', 'TodoWrite'] })
  expect(withTool.sections.filter(s => s.id === 'todo-list:instruction')).toHaveLength(1)
  expect(again.sections.filter(s => s.id === 'todo-list:instruction')).toHaveLength(1)
  const without = await $.prompt.compose({ ...base, tools: ['Read', 'Bash'] })
  expect(without.sections.filter(s => s.id === 'todo-list:instruction')).toHaveLength(0)
})
