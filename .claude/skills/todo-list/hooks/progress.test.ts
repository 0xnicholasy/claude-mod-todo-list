import { expect, test } from 'claude-code/testing'
import { buildLines, headerText, progress, progressBar, statusText } from './todos'
import type { TodoItem } from './todos'

const item = (id: string, status: TodoItem['status'], activeForm?: string): TodoItem => {
  const base: TodoItem = { id, content: `task ${id}`, status, updatedAt: 0 }
  return activeForm === undefined ? base : { ...base, activeForm }
}

test('progress, bar and header text count completed items', () => {
  const list = [item('1', 'completed'), item('2', 'completed'), item('3', 'in_progress'), item('4', 'pending')]
  expect(progress(list)).toEqual({ done: 2, total: 4 })
  expect(progressBar(2, 4)).toBe('[#####-----]')
  expect(progressBar(0, 0)).toBe('[----------]')
  expect(headerText(list)).toBe('2/4 [#####-----]')
})

test('status line shows done/total and the in-progress activeForm, cleared when empty', () => {
  const list = [item('1', 'completed'), item('2', 'in_progress', 'Running tests'), item('3', 'pending')]
  expect(statusText(list)).toBe('Todo 1/3: Running tests')
  expect(statusText([item('1', 'completed'), item('2', 'pending')])).toBe('Todo 1/2')
  expect(statusText([])).toBeUndefined()
})

test('pane lines run In progress, Pending, Done with markers, and show an empty state', () => {
  const list = [
    item('1', 'completed'),
    item('2', 'pending'),
    item('3', 'in_progress', 'Doing three'),
  ]
  const lines = buildLines(list, 20)
  expect(lines.map(l => l.text)).toEqual([
    '1/3 [###-------]',
    'In progress (1)',
    '[>] Doing three',
    'Pending (1)',
    '[ ] task 2',
    'Done (1)',
    '[x] task 1',
  ])
  expect(lines.filter(l => l.dim).map(l => l.text)).toEqual(['Done (1)', '[x] task 1'])
  expect(buildLines([], 20).map(l => l.text)).toEqual(['0/0 [----------]', 'No todos yet.'])

  // Section headers draw with a blank row above, so they cost two rows against the budget.
  const rowsOf = (ls: ReturnType<typeof buildLines>): number =>
    ls.reduce((sum, l) => sum + (l.kind === 'section' ? 2 : 1), 0)
  const cut = buildLines(list, 5)
  expect(cut.map(l => l.text)).toEqual(['1/3 [###-------]', 'In progress (1)', '[>] Doing three', '+2 more'])
  expect(rowsOf(cut)).toBeLessThanOrEqual(5)

  // A cut never ends on a section header with no item under it.
  for (let max = 3; max <= 12; max++) {
    const out = buildLines(list, max)
    expect(rowsOf(out)).toBeLessThanOrEqual(Math.max(max, 3))
    const beforeMore = out.filter(l => l.kind !== 'more')
    if (out.length !== beforeMore.length) expect(beforeMore[beforeMore.length - 1]?.kind).not.toBe('section')
  }
})
