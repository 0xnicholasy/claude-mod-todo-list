import { expect, test } from 'claude-code/testing'
import { activityLabel, emptyActivity, reduceActivity } from './activity'
import type { ActivityEvent, ActivityState } from './activity'

// Runs events in order, one tick apart, from idle at t=0.
const run = (events: ActivityEvent[], start: ActivityState = emptyActivity(0)): ActivityState =>
  events.reduce((s, e, i) => reduceActivity(s, e, i + 1), start)

test('turnStart goes working; turnComplete answer goes idle', () => {
  expect(run([{ type: 'turnStart' }]).phase).toBe('working')
  expect(run([{ type: 'turnStart' }, { type: 'turnComplete', reason: 'answer' }]).phase).toBe('idle')
})

test('turnComplete maps aborted to interrupted and error/refusal to error', () => {
  expect(run([{ type: 'turnStart' }, { type: 'turnComplete', reason: 'aborted' }]).phase).toBe('interrupted')
  expect(run([{ type: 'turnStart' }, { type: 'turnComplete', reason: 'error' }]).phase).toBe('error')
  expect(run([{ type: 'turnStart' }, { type: 'turnComplete', reason: 'refusal' }]).phase).toBe('error')
})

test('a rejected dialog ends the turn as answer: idle, not interrupted', () => {
  const s = run([
    { type: 'turnStart' },
    { type: 'toolStart', tool: 'Write' },
    { type: 'permissionAsk', tool: 'Write' },
    { type: 'turnComplete', reason: 'answer' },
  ])
  expect(s.phase).toBe('idle')
})

test('turnComplete carrying an agentId leaves activity unchanged', () => {
  const working = run([{ type: 'turnStart' }])
  expect(reduceActivity(working, { type: 'turnComplete', reason: 'answer', agentId: 'a1' }, 9)).toBe(working)
  expect(reduceActivity(working, { type: 'turnComplete', reason: 'error', agentId: 'a1' }, 9)).toBe(working)
})

test('toolStart shows the tool; toolEnd returns to working', () => {
  const s = run([{ type: 'turnStart' }, { type: 'toolStart', tool: 'Bash' }])
  expect(s.phase).toBe('tool')
  expect(s.tool).toBe('Bash')
  expect(run([{ type: 'turnStart' }, { type: 'toolStart', tool: 'Bash' }, { type: 'toolEnd' }]).phase).toBe('working')
})

test('permission during a tool shows permission; toolEnd returns to working', () => {
  const s = run([{ type: 'turnStart' }, { type: 'toolStart', tool: 'Write' }, { type: 'permissionAsk', tool: 'Write' }])
  expect(s.phase).toBe('permission')
  expect(activityLabel(s)).toBe('Waiting for permission: Write')
  expect(reduceActivity(s, { type: 'toolEnd' }, 9).phase).toBe('working')
})

test('question outranks permission, compacting and tool; questionClose returns to working', () => {
  const q = run([{ type: 'turnStart' }, { type: 'toolStart', tool: 'AskUserQuestion' }, { type: 'questionOpen' }])
  expect(q.phase).toBe('question')
  // Lower phases do not override a question.
  expect(reduceActivity(q, { type: 'permissionAsk', tool: 'X' }, 9)).toBe(q)
  expect(reduceActivity(q, { type: 'compactStart' }, 9)).toBe(q)
  expect(reduceActivity(q, { type: 'toolStart', tool: 'X' }, 9)).toBe(q)
  expect(reduceActivity(q, { type: 'toolEnd' }, 9)).toBe(q)
  expect(reduceActivity(q, { type: 'questionClose' }, 9).phase).toBe('working')
})

test('permission outranks compacting and tool', () => {
  const p = run([{ type: 'turnStart' }, { type: 'permissionAsk', tool: 'Bash' }])
  expect(reduceActivity(p, { type: 'compactStart' }, 9)).toBe(p)
  expect(reduceActivity(p, { type: 'toolStart', tool: 'Read' }, 9)).toBe(p)
})

test('compacting outranks tool; compactEnd returns to working', () => {
  const s = run([{ type: 'turnStart' }, { type: 'toolStart', tool: 'Bash' }, { type: 'compactStart' }])
  expect(s.phase).toBe('compacting')
  expect(activityLabel(s)).toBe('Compacting')
  expect(reduceActivity(s, { type: 'toolStart', tool: 'Read' }, 9)).toBe(s)
  expect(reduceActivity(s, { type: 'compactEnd' }, 9).phase).toBe('working')
})

test('stopFailure goes to error with a cleaned detail', () => {
  const s = run([{ type: 'turnStart' }, { type: 'stopFailure', detail: 'rate\u001b[2J limit' }])
  expect(s.phase).toBe('error')
  expect(activityLabel(s)).toBe('Error: rate [2J limit')
})

test('sessionClear resets activity, including subagents', () => {
  const s = run([{ type: 'turnStart' }, { type: 'subagentStart', id: 'a' }, { type: 'sessionClear' }])
  expect(s.phase).toBe('idle')
  expect(s.subagents).toEqual([])
  expect(s.tool).toBeUndefined()
})

test('subagent ids form a set: duplicate start counts once, unknown stop is a no-op', () => {
  const s = run([
    { type: 'subagentStart', id: 'a' },
    { type: 'subagentStart', id: 'a' },
    { type: 'subagentStart', id: 'b' },
  ])
  expect(s.subagents).toEqual(['a', 'b'])
  expect(reduceActivity(s, { type: 'subagentStop', id: 'zzz' }, 9)).toBe(s)
  expect(reduceActivity(s, { type: 'subagentStop', id: 'a' }, 9).subagents).toEqual(['b'])
})

test('Start/Stop from an unrelated background agent keeps the set consistent', () => {
  // Stop arrives before its Start (unknown), then a late Start and Stop pair up cleanly.
  const s = run([
    { type: 'subagentStop', id: 'bg' },
    { type: 'subagentStart', id: 'x' },
    { type: 'subagentStart', id: 'bg' },
    { type: 'subagentStop', id: 'bg' },
    { type: 'subagentStop', id: 'bg' },
  ])
  expect(s.subagents).toEqual(['x'])
})

test('activityLabel covers each phase and the subagent suffix', () => {
  const base = emptyActivity(0)
  expect(activityLabel(base)).toBeUndefined()
  expect(activityLabel({ ...base, phase: 'working' })).toBe('Working')
  expect(activityLabel({ ...base, phase: 'tool', tool: 'Bash' })).toBe('Running Bash')
  expect(activityLabel({ ...base, phase: 'permission', tool: 'Edit' })).toBe('Waiting for permission: Edit')
  expect(activityLabel({ ...base, phase: 'question' })).toBe('Waiting for your answer')
  expect(activityLabel({ ...base, phase: 'compacting' })).toBe('Compacting')
  expect(activityLabel({ ...base, phase: 'interrupted' })).toBe('Interrupted')
  expect(activityLabel({ ...base, phase: 'error', detail: 'boom' })).toBe('Error: boom')
  expect(activityLabel({ ...base, phase: 'working', subagents: ['a'] })).toBe('Working · 1 subagent')
  expect(activityLabel({ ...base, phase: 'working', subagents: ['a', 'b'] })).toBe('Working · 2 subagents')
})

test('model-supplied strings are cleaned', () => {
  const s = run([{ type: 'toolStart', tool: 'Ba‮sh\u001b[2J' }])
  expect(s.tool).toBe('Bash [2J')
  expect(run([{ type: 'subagentStart', id: 'a\u001bb' }]).subagents).toEqual(['a b'])
})

test('since changes only when the phase changes', () => {
  const s = run([{ type: 'turnStart' }, { type: 'toolStart', tool: 'A' }])
  expect(s.since).toBe(2)
  expect(reduceActivity(s, { type: 'toolStart', tool: 'B' }, 9).since).toBe(2)
})

test('compactEnd restores the phase active before compactStart', () => {
  const end = (s: ActivityState) => reduceActivity(s, { type: 'compactEnd' }, 9)
  const idle = run([{ type: 'compactStart' }])
  expect(idle.phase).toBe('compacting')
  expect(end(idle).phase).toBe('idle')
  expect(activityLabel(end(idle))).toBeUndefined()
  expect(end(run([{ type: 'turnStart' }, { type: 'compactStart' }])).phase).toBe('working')
  // A repeated compactStart keeps the first resume phase.
  expect(end(run([{ type: 'compactStart' }, { type: 'compactStart' }])).phase).toBe('idle')
})
