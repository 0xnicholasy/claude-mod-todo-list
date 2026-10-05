import { expect, test } from 'claude-code/testing'
import { addTask, updateTask } from './todos'

test('TaskCreate appends a pending item under the id the result gave, once', () => {
  const one = addTask([], '7', 'Fix login', 'Fixing login', 10)
  expect(one).toEqual([
    { id: '7', content: 'Fix login', activeForm: 'Fixing login', status: 'pending', updatedAt: 10 },
  ])
  const two = addTask(one, '8', 'Add docs', undefined, 11)
  expect(two.map(i => i.id)).toEqual(['7', '8'])
  expect(two[1]?.activeForm).toBeUndefined()
  expect(addTask(two, '8', 'Again', undefined, 12)).toEqual(two)
})

test('TaskUpdate patches status and text, and deleted removes the item', () => {
  const start = addTask(addTask([], '1', 'A', undefined, 1), '2', 'B', undefined, 1)
  const started = updateTask(start, { taskId: '1', status: 'in_progress', activeForm: 'Doing A' }, 5)
  expect(started[0]).toEqual({
    id: '1',
    content: 'A',
    activeForm: 'Doing A',
    status: 'in_progress',
    updatedAt: 5,
  })
  expect(started[1]).toEqual(start[1])

  const renamed = updateTask(started, { taskId: '1', subject: 'A2' }, 6)
  expect(renamed[0]?.content).toBe('A2')
  expect(renamed[0]?.status).toBe('in_progress')

  expect(updateTask(renamed, { taskId: '2', status: 'deleted' }, 7).map(i => i.id)).toEqual(['1'])
  expect(updateTask(renamed, { taskId: 'nope', status: 'completed' }, 7)).toEqual(renamed)
})
