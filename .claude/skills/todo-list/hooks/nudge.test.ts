import { expect, test } from 'claude-code/testing'
import { shouldNudge } from './todos'
import type { NudgeInput } from './todos'

const base: NudgeInput = { tool: 'Edit', items: [], updatedThisTurn: false, nudgedThisTurn: false }
const open = [{ id: '1', content: 'a', status: 'pending' as const, updatedAt: 0 }]
const done = [{ id: '1', content: 'a', status: 'completed' as const, updatedAt: 0 }]

test('nudge fires for state-changing tools only', () => {
  for (const tool of ['Edit', 'Write', 'NotebookEdit']) expect(shouldNudge({ ...base, tool })).toBe(true)
  for (const tool of ['Read', 'Bash', 'Grep', 'TodoWrite']) expect(shouldNudge({ ...base, tool })).toBe(false)
})

test('nudge fires only with no todo update this turn and no unfinished items', () => {
  expect(shouldNudge({ ...base, updatedThisTurn: true })).toBe(false)
  expect(shouldNudge({ ...base, items: open })).toBe(false)
  expect(shouldNudge({ ...base, items: done })).toBe(true)
})

test('nudge fires once per turn: the nudged flag suppresses the second call', () => {
  expect(shouldNudge(base)).toBe(true)
  expect(shouldNudge({ ...base, nudgedThisTurn: true })).toBe(false)
})
