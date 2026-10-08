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

test('permissionEnd leaves permission for working and changes no other phase', () => {
  const p = run([{ type: 'turnStart' }, { type: 'permissionAsk', tool: 'Bash' }])
  expect(reduceActivity(p, { type: 'permissionEnd' }, 9).phase).toBe('working')
  const t = run([{ type: 'turnStart' }, { type: 'toolStart', tool: 'Bash' }])
  expect(reduceActivity(t, { type: 'permissionEnd' }, 9)).toBe(t)
})

test('question outranks permission, compacting and tool; questionClose returns to working', () => {
  const q = run([{ type: 'turnStart' }, { type: 'toolStart', tool: 'AskUserQuestion' }, { type: 'questionOpen' }])
  expect(q.phase).toBe('question')
  // Lower phases do not override a question.
  expect(reduceActivity(q, { type: 'permissionAsk', tool: 'X' }, 9)).toBe(q)
  expect(reduceActivity(q, { type: 'compactStart' }, 9)).toBe(q)
  // A call started under a higher phase is tracked; the visible fields do not move.
  expect(reduceActivity(q, { type: 'toolStart', tool: 'X' }, 9)).toEqual({
    ...q,
    running: [...q.running, { id: 'name:X', tool: 'X' }],
  })
  // A toolEnd drops the running call but does not move the phase.
  expect(reduceActivity(q, { type: 'toolEnd' }, 9)).toEqual({ ...q, running: [] })
  // The AskUserQuestion entry is still running (T07 removes it by id), so the phase settles into tool.
  const closed = reduceActivity(q, { type: 'questionClose' }, 9)
  expect(closed.phase).toBe('tool')
  expect(closed.tool).toBe('AskUserQuestion')
  expect(reduceActivity(reduceActivity(q, { type: 'toolEnd' }, 9), { type: 'questionClose' }, 9).phase).toBe('working')
})

test('permission outranks compacting and tool', () => {
  const p = run([{ type: 'turnStart' }, { type: 'permissionAsk', tool: 'Bash' }])
  expect(reduceActivity(p, { type: 'compactStart' }, 9)).toBe(p)
  expect(reduceActivity(p, { type: 'toolStart', tool: 'Read' }, 9)).toEqual({ ...p, running: [{ id: 'name:Read', tool: 'Read' }] })
})

test('compacting outranks tool; compactEnd returns to working', () => {
  const s = run([{ type: 'turnStart' }, { type: 'toolStart', tool: 'Bash' }, { type: 'compactStart' }])
  expect(s.phase).toBe('compacting')
  expect(activityLabel(s)).toBe('Compacting')
  expect(reduceActivity(s, { type: 'toolStart', tool: 'Read' }, 9)).toEqual({
    ...s,
    running: [...s.running, { id: 'name:Read', tool: 'Read' }],
  })
  // Bash is still running, so compactEnd settles into tool; with none left it is working.
  const ended = reduceActivity(s, { type: 'compactEnd' }, 9)
  expect(ended.phase).toBe('tool')
  expect(ended.tool).toBe('Bash')
  expect(reduceActivity(reduceActivity(s, { type: 'toolEnd' }, 9), { type: 'compactEnd' }, 9).phase).toBe('working')
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

const twoCalls: ActivityEvent[] = [
  { type: 'turnStart' },
  { type: 'toolStart', tool: 'Read', id: 'r1' },
  { type: 'toolStart', tool: 'Bash', id: 'b1' },
]

test('two starts and one end by id keep the tool phase and show the other call', () => {
  const s = run([...twoCalls, { type: 'toolEnd', id: 'r1' }])
  expect(s.phase).toBe('tool')
  expect(s.tool).toBe('Bash')
  expect(s.running).toEqual([{ id: 'b1', tool: 'Bash' }])
})

test('ending the newest call reverts the label to the older one; ending the last gives working', () => {
  const older = run([...twoCalls, { type: 'toolEnd', id: 'b1' }])
  expect(older.phase).toBe('tool')
  expect(older.tool).toBe('Read')
  const none = reduceActivity(older, { type: 'toolEnd', id: 'r1' }, 9)
  expect(none.phase).toBe('working')
  expect(none.running).toEqual([])
})

test('toolEnd with an unknown id and no matching synthetic entry is a no-op', () => {
  const s = run(twoCalls)
  expect(reduceActivity(s, { type: 'toolEnd', id: 'zzz' }, 9)).toBe(s)
  expect(reduceActivity(s, { type: 'toolEnd', id: 'zzz', tool: 'Bash' }, 9)).toBe(s)
})

test('the name fallback removes only the oldest synthetic entry of that tool', () => {
  const s = run([
    { type: 'turnStart' },
    { type: 'toolStart', tool: 'Bash', id: 'b1' },
    { type: 'toolStart', tool: 'Bash' },
    { type: 'toolStart', tool: 'Bash' },
  ])
  expect(s.running.map(r => r.id)).toEqual(['b1', 'name:Bash', 'name:Bash'])
  const one = reduceActivity(s, { type: 'toolEnd', tool: 'Bash' }, 9)
  expect(one.running.map(r => r.id)).toEqual(['b1', 'name:Bash'])
  const two = reduceActivity(one, { type: 'toolEnd', id: 'unknown', tool: 'Bash' }, 9)
  expect(two.running.map(r => r.id)).toEqual(['b1'])
  // An end carrying an unknown id never removes an id-bearing entry by name.
  expect(reduceActivity(two, { type: 'toolEnd', id: 'unknown', tool: 'Bash' }, 9)).toBe(two)
})

test('toolEnd with a tool but no id clears a real-id entry of that tool', () => {
  const s = run([{ type: 'turnStart' }, { type: 'toolStart', tool: 'Bash', id: 'b1' }])
  const ended = reduceActivity(s, { type: 'toolEnd', tool: 'Bash' }, 9)
  expect(ended.running).toEqual([])
  expect(ended.phase).toBe('working')
})

test('another call ending keeps a pending permission wait; the asking call ending settles it', () => {
  const s = run([
    { type: 'turnStart' },
    { type: 'toolStart', tool: 'Write', id: 'a' },
    { type: 'toolStart', tool: 'Read', id: 'b' },
    { type: 'permissionAsk', tool: 'Write' },
  ])
  const other = reduceActivity(s, { type: 'toolEnd', id: 'b', tool: 'Read' }, 9)
  expect(other.phase).toBe('permission')
  expect(other.tool).toBe('Write')
  expect(other.running).toEqual([{ id: 'a', tool: 'Write' }])
  const own = reduceActivity(other, { type: 'toolEnd', id: 'a', tool: 'Write' }, 10)
  expect(own.phase).toBe('working')
})

test('a stored activity value without running or subagents is treated as empty', () => {
  const legacy = { phase: 'working', since: 0 } as unknown as ActivityState // pre-reload shape lacks the arrays
  const started = reduceActivity(legacy, { type: 'toolStart', tool: 'Bash', id: 'a' }, 1)
  expect(started.running).toEqual([{ id: 'a', tool: 'Bash' }])
  expect(reduceActivity(legacy, { type: 'toolEnd', id: 'a' }, 1).phase).toBe('working')
  expect(reduceActivity(legacy, { type: 'subagentStart', id: 's' }, 1).subagents).toEqual(['s'])
})

test('toolEnd with neither id nor tool clears every running call', () => {
  const s = run([...twoCalls, { type: 'toolEnd' }])
  expect(s.running).toEqual([])
  expect(s.phase).toBe('working')
})

test('turnStart, turnComplete and sessionClear empty running; a subagent turn end keeps it', () => {
  const s = run(twoCalls)
  expect(reduceActivity(s, { type: 'turnStart' }, 9).running).toEqual([])
  expect(reduceActivity(s, { type: 'turnComplete', reason: 'answer' }, 9).running).toEqual([])
  expect(reduceActivity(s, { type: 'turnComplete', reason: 'aborted' }, 9).running).toEqual([])
  expect(reduceActivity(s, { type: 'sessionClear' }, 9).running).toEqual([])
  expect(reduceActivity(s, { type: 'turnComplete', reason: 'answer', agentId: 'a' }, 9)).toBe(s)
})

test('a call started under permission stays tracked: ending the first leaves tool with the second, not working', () => {
  const s = run([
    { type: 'turnStart' },
    { type: 'toolStart', tool: 'Write', id: 'a' },
    { type: 'permissionAsk', tool: 'Write' },
    { type: 'toolStart', tool: 'Read', id: 'b' },
  ])
  expect(s.phase).toBe('permission')
  expect(s.tool).toBe('Write')
  expect(s.running.map(r => r.id)).toEqual(['a', 'b'])
  const after = reduceActivity(s, { type: 'toolEnd', id: 'a' }, 9)
  expect(after.phase).toBe('tool')
  expect(after.tool).toBe('Read')
  expect(after.running).toEqual([{ id: 'b', tool: 'Read' }])
})

test('permissionEnd with a call still running settles into tool with that call, not working', () => {
  const s = run([
    { type: 'turnStart' },
    { type: 'toolStart', tool: 'Write', id: 'a' },
    { type: 'permissionAsk', tool: 'Write' },
    { type: 'toolStart', tool: 'Read', id: 'b' },
  ])
  const ended = reduceActivity(s, { type: 'permissionEnd' }, 9)
  expect(ended.phase).toBe('tool')
  expect(ended.tool).toBe('Read')
  const bare = run([{ type: 'turnStart' }, { type: 'permissionAsk', tool: 'Write' }, { type: 'permissionEnd' }])
  expect(bare.phase).toBe('working')
})

test('compactEnd with a call still running settles into tool with that call, not working', () => {
  const s = run([
    { type: 'turnStart' },
    { type: 'toolStart', tool: 'Bash', id: 'a' },
    { type: 'compactStart' },
    { type: 'toolStart', tool: 'Read', id: 'b' },
  ])
  const ended = reduceActivity(s, { type: 'compactEnd' }, 9)
  expect(ended.phase).toBe('tool')
  expect(ended.tool).toBe('Read')
})
