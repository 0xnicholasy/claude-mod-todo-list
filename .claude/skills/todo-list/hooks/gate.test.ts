import { expect, test } from 'claude-code/testing'
import { BLOCKED_TOOLS, MAX_DENIES, decideGate, denyText, INSTRUCTION_TEXT, onNewPrompt, onPlanTouched, planContext } from './gate'
import type { GateInput } from './gate'
import { emptyPlan, setPlan } from './plan'
import type { Plan } from './plan'

const TOOL = 'mcp__todo-list__plan'
const base: GateInput = {
  tool: 'Edit',
  isPlanTool: false,
  planToolName: TOOL,
  enforceConfig: true,
  enforceSession: true,
  toolRegistered: true,
  toolOffered: true,
  planned: false,
  denies: 0,
}

const planOf = (statuses: Array<'pending' | 'completed'>): Plan => {
  const r = setPlan(emptyPlan(), 'T', statuses.map((_, i) => ({ title: `s${i}` })), 0)
  if ('error' in r) throw new Error(r.error)

  return { ...r.plan, nodes: r.plan.nodes.map((n, i) => ({ ...n, status: statuses[i] ?? 'pending' })) }
}

test('blocked tools are denied with no plan', () => {
  for (const tool of ['Edit', 'Bash', 'Agent']) expect(decideGate({ ...base, tool }).kind).toBe('deny')
  expect(BLOCKED_TOOLS.size).toBe(11)
  for (const tool of ['Edit', 'Write', 'NotebookEdit', 'Bash', 'Agent', 'Workflow', 'CronCreate', 'CronDelete', 'EnterWorktree', 'ExitWorktree', 'RemoteTrigger']) {
    expect(BLOCKED_TOOLS.has(tool)).toBe(true)
  }
})

test('the deny message uses the planToolName from the input', () => {
  const d = decideGate({ ...base, planToolName: 'mcp__custom__plan' })
  expect(d.kind).toBe('deny')
  if (d.kind === 'deny') {
    expect(d.message).toContain('mcp__custom__plan')
    expect(d.message).not.toContain(TOOL)
  }
  const allowed = decideGate({ ...base, tool: 'mcp__custom__plan', planToolName: 'mcp__custom__plan', isPlanTool: true })
  expect(allowed.kind).toBe('allow')
})

test('fail-open and planned checks come before the pause', () => {
  expect(decideGate({ ...base, denies: MAX_DENIES + 2, planned: true }).kind).toBe('allow')
  expect(decideGate({ ...base, denies: MAX_DENIES, toolRegistered: false }).kind).toBe('allow')
  expect(decideGate({ ...base, denies: MAX_DENIES, toolOffered: false }).kind).toBe('allow')
})

test('read-only, question, plan and unknown mcp tools are allowed', () => {
  for (const tool of ['Read', 'Grep', 'Glob', 'AskUserQuestion', 'WebSearch', 'mcp__x__y']) {
    expect(decideGate({ ...base, tool }).kind).toBe('allow')
  }
  expect(decideGate({ ...base, tool: TOOL, isPlanTool: true }).kind).toBe('allow')
})

test('each fail-open input allows', () => {
  expect(decideGate({ ...base, enforceConfig: false }).kind).toBe('allow')
  expect(decideGate({ ...base, enforceSession: false }).kind).toBe('allow')
  expect(decideGate({ ...base, toolRegistered: false }).kind).toBe('allow')
  expect(decideGate({ ...base, toolOffered: false }).kind).toBe('allow')
  expect(decideGate({ ...base, agentId: 'a1' }).kind).toBe('allow')
  expect(decideGate({ ...base, planned: true }).kind).toBe('allow')
})

test('the call after 3 denies pauses with a toast', () => {
  expect(decideGate({ ...base, denies: MAX_DENIES - 1 }).kind).toBe('deny')
  const d = decideGate({ ...base, denies: MAX_DENIES })
  expect(d.kind).toBe('pause')
  if (d.kind === 'pause') expect(d.toast).toContain('paused')
})

test('a new prompt is planned only when the plan has unfinished leaves', () => {
  const fresh = { open: false, planned: false, denies: 2 }
  expect(onNewPrompt(fresh, planOf(['pending']), 'go')).toEqual({ open: true, planned: true, denies: 0 })
  expect(onNewPrompt(fresh, planOf(['completed']), 'go').planned).toBe(false)
  expect(onNewPrompt(fresh, emptyPlan(), 'go').planned).toBe(false)
})

test('empty text and task-notification prompts keep the task unchanged', () => {
  const task = { open: true, planned: true, denies: 1 }
  expect(onNewPrompt(task, emptyPlan(), '')).toEqual(task)
  expect(onNewPrompt(task, emptyPlan(), '<task-notification>\n<task-id>a</task-id>')).toEqual(task)
})

test('onPlanTouched marks the task planned', () => {
  expect(onPlanTouched({ open: true, planned: false, denies: 2 })).toEqual({ open: true, planned: true, denies: 2 })
})

test('denyText spells out the exact set call and never mentions /todo off', () => {
  const t = denyText('Edit', TOOL)
  expect(t).toContain(`Call ${TOOL} with {"op":"set","title":"<task>","nodes":[{"title":"<step>"}]}`)
  expect(t).toContain('retry Edit')
  expect(t).not.toContain('/todo off')
  expect(t).toContain(`ToolSearch (query "select:${TOOL}")`)
})

test('instruction text names the tool and the key rules', () => {
  const t = INSTRUCTION_TEXT(TOOL)
  for (const s of [TOOL, 'in_progress', 'completed', 'blocked', 'skipped', 'AskUserQuestion', 'Pure Q&A', `ToolSearch (query "select:${TOOL}")`]) {
    expect(t).toContain(s)
  }
})

test('planContext is undefined for an empty plan and lists the plan otherwise', () => {
  expect(planContext(emptyPlan(), TOOL)).toBeUndefined()
  expect(planContext(planOf(['pending', 'completed']), TOOL)).toContain('1 pending, 2 completed')
  expect(planContext(planOf(['pending']), TOOL, () => 'TREE')).toContain('TREE')
})
