import { expect, test } from 'claude-code/testing'
import { replaceAll } from './todos'

test('TodoWrite replaces the whole list and keeps updatedAt of unchanged entries', () => {
  const first = replaceAll(
    [],
    [
      { content: 'Write tests', status: 'in_progress', activeForm: 'Writing tests' },
      { content: 'Ship', status: 'pending', activeForm: 'Shipping' },
    ],
    100,
  )
  expect(first.map(i => [i.id, i.content, i.activeForm, i.status, i.updatedAt])).toEqual([
    ['todo-1', 'Write tests', 'Writing tests', 'in_progress', 100],
    ['todo-2', 'Ship', 'Shipping', 'pending', 100],
  ])

  const second = replaceAll(
    first,
    [
      { content: 'Write tests', status: 'completed', activeForm: 'Writing tests' },
      { content: 'Ship', status: 'pending', activeForm: 'Shipping' },
      { content: 'Announce', status: 'pending', activeForm: 'Announcing' },
    ],
    200,
  )
  expect(second.map(i => [i.id, i.status, i.updatedAt])).toEqual([
    ['todo-1', 'completed', 200],
    ['todo-2', 'pending', 100],
    ['todo-3', 'pending', 200],
  ])
  expect(replaceAll(second, [], 300)).toEqual([])
})

test('control characters in model-supplied text never reach the list', () => {
  const [item] = replaceAll([], [{ content: 'a\u001b[31m\nb', status: 'pending', activeForm: 'x\ty' }], 1)
  expect(item?.content).toBe('a [31m b')
  expect(item?.activeForm).toBe('x y')
})

test('bidi and zero-width characters are stripped', () => {
  const [item] = replaceAll([], [{ content: 'a\u200bb\u202ec\u2066d\ufeffe', status: 'pending' }], 1)
  expect(item?.content).toBe('abcde')
})

test('TodoWrite keeps Task* items and matches earlier entries by content, not position', () => {
  const prev = [
    { id: '7', content: 'Task seven', status: 'pending' as const, updatedAt: 5 },
    { id: 'todo-1', content: 'A', status: 'pending' as const, updatedAt: 10 },
    { id: 'todo-2', content: 'B', status: 'pending' as const, updatedAt: 20 },
  ]
  const out = replaceAll(
    prev,
    [
      { content: 'B', status: 'pending' },
      { content: 'A', status: 'pending' },
    ],
    99,
  )
  expect(out.map(i => [i.id, i.content, i.updatedAt])).toEqual([
    ['7', 'Task seven', 5],
    ['todo-1', 'B', 20],
    ['todo-2', 'A', 10],
  ])
})
