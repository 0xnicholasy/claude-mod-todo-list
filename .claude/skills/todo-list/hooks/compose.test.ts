import { expect, test } from 'claude-code/testing'
import { SECTION_ID, withTodoSection } from './todos'

test('prompt.compose adds one session-scoped todo instruction after the existing sections', () => {
  const existing = [{ id: 'intro', text: 'hello', scope: 'shared' as const }]
  const out = withTodoSection(existing)
  expect(out.map(s => s.id)).toEqual(['intro', SECTION_ID])
  const added = out[1]
  expect(added?.scope).toBe('session')
  expect(added?.text).toContain('more than 2 steps')
  expect(added?.text).toContain('exactly one item in_progress')
  expect(added?.text).toContain('completed immediately')
  expect(added?.text).toContain('Trivial single-step')
})

test('the instruction is not doubled when composed twice', () => {
  const once = withTodoSection([])
  expect(withTodoSection(once)).toEqual(once)
})
