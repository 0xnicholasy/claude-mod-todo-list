import { expect, test } from 'claude-code/testing'
import { taskCreateFrom, taskUpdateFrom, todosFrom } from './post-tool'

test('TaskCreate takes the id from the response and the subject and activeForm from the input', () => {
  const input = { subject: 'Write docs', description: 'd', activeForm: 'Writing docs' }
  expect(taskCreateFrom(input, { task: { id: '5', subject: 'Write docs' } })).toEqual({
    id: '5',
    subject: 'Write docs',
    activeForm: 'Writing docs',
  })
  expect(taskCreateFrom({ subject: 'x' }, { task: { id: 7 } })).toEqual({ id: '7', subject: 'x' })
})

test('TaskCreate with a bad shape gives null', () => {
  expect(taskCreateFrom({ subject: 'x' }, { task: {} })).toBeNull()
  expect(taskCreateFrom({ subject: 'x' }, 'ok')).toBeNull()
  expect(taskCreateFrom({ subject: 4 }, { task: { id: '5' } })).toBeNull()
  expect(taskCreateFrom(undefined, { task: { id: '5' } })).toBeNull()
})

test('TaskUpdate needs success true and carries only the fields the input sent', () => {
  expect(taskUpdateFrom({ taskId: '5', status: 'in_progress' }, { success: true, taskId: '5' })).toEqual({
    taskId: '5',
    status: 'in_progress',
  })
  expect(taskUpdateFrom({ taskId: '5', subject: 'S', activeForm: 'A' }, { success: true })).toEqual({
    taskId: '5',
    subject: 'S',
    activeForm: 'A',
  })
  expect(taskUpdateFrom({ taskId: '5', status: 'completed' }, { success: false })).toBeNull()
  expect(taskUpdateFrom({ taskId: '5', status: 'completed' }, { taskId: '5' })).toBeNull()
})

test('TaskUpdate with an unknown status or no task id gives null', () => {
  expect(taskUpdateFrom({ taskId: '5', status: 'done' }, { success: true })).toBeNull()
  expect(taskUpdateFrom({ status: 'completed' }, { success: true })).toBeNull()
})

test('TodoWrite prefers the stored newTodos and falls back to the input todos', () => {
  const sent = [{ content: 'A', status: 'pending', activeForm: 'Doing A' }]
  const stored = [{ content: 'B', status: 'completed' }]
  expect(todosFrom({ todos: sent }, { newTodos: stored })).toEqual([{ content: 'B', status: 'completed' }])
  expect(todosFrom({ todos: sent }, { oldTodos: [] })).toEqual(sent)
  expect(todosFrom({ todos: sent }, { newTodos: [{ content: 'B', status: 'bogus' }] })).toEqual(sent)
})

test('TodoWrite with no valid list gives null', () => {
  expect(todosFrom({ todos: [{ content: 'A' }] }, {})).toBeNull()
  expect(todosFrom({}, undefined)).toBeNull()
})
