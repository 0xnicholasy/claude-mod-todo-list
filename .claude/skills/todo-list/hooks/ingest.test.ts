import { expect, test } from 'claude-code/testing'
import { ingestTaskCreate, ingestTaskUpdate, ingestTodoWrite } from './ingest'
import { addNodes, emptyPlan, MAX_NODES, progress, removeNode, setPlan } from './plan'
import type { Plan, PlanResult } from './plan'

const ok = (r: PlanResult): Plan => {
  if ('error' in r) throw new Error(r.error)

  return r.plan
}

const withTask = (): Plan => ok(ingestTaskCreate(emptyPlan(), { id: '7', subject: 'Write docs', activeForm: 'Writing docs' }, 1))

test('TaskCreate adds a top-level task node keyed by the task id', () => {
  const plan = withTask()
  expect(plan.nodes).toHaveLength(1)
  expect(plan.nodes[0]).toMatchObject({
    id: '1',
    parentId: null,
    title: 'Write docs',
    activeForm: 'Writing docs',
    status: 'pending',
    source: 'task',
    externalId: '7',
  })
})

test('TaskCreate is idempotent per externalId', () => {
  const again = ok(ingestTaskCreate(withTask(), { id: '7', subject: 'Other' }, 2))
  expect(again.nodes).toHaveLength(1)
  expect(again.nodes[0]?.title).toBe('Write docs')
})

test('TaskCreate cleans the subject and rejects an empty one', () => {
  const plan = ok(ingestTaskCreate(emptyPlan(), { id: '1', subject: 'a‮b' }, 1))
  expect(plan.nodes[0]?.title).toBe('ab')
  expect('error' in ingestTaskCreate(emptyPlan(), { id: '2', subject: '  ' }, 1)).toBe(true)
})

test('TaskUpdate patches subject, activeForm and status by externalId', () => {
  const plan = ok(ingestTaskUpdate(withTask(), { taskId: '7', subject: 'Ship docs', activeForm: 'Shipping', status: 'in_progress' }, 5))
  expect(plan.nodes[0]).toMatchObject({ title: 'Ship docs', activeForm: 'Shipping', status: 'in_progress', updatedAt: 5 })
  const done = ok(ingestTaskUpdate(plan, { taskId: '7', status: 'completed' }, 6))
  expect(progress(done)).toEqual({ done: 1, total: 1 })
})

test('TaskUpdate with status deleted removes the node, and an unknown id is a no-op', () => {
  const start = withTask()
  expect(ok(ingestTaskUpdate(start, { taskId: '9', status: 'completed' }, 2))).toEqual(start)
  expect(ok(ingestTaskUpdate(start, { taskId: '7', status: 'deleted' }, 2)).nodes).toEqual([])
})

test('a removed task id is not reused by the next TaskCreate', () => {
  const removed = ok(ingestTaskUpdate(withTask(), { taskId: '7', status: 'deleted' }, 2))
  const next = ok(ingestTaskCreate(removed, { id: '8', subject: 'Next' }, 3))
  expect(next.nodes.map(n => n.id)).toEqual(['2'])
})

test('TodoWrite replaces only the todo-sourced leaves', () => {
  const first = ok(ingestTodoWrite(withTask(), [
    { content: 'A', status: 'pending', activeForm: 'Doing A' },
    { content: 'B', status: 'in_progress', activeForm: 'Doing B' },
  ], 2))
  expect(first.nodes.map(n => `${n.id}:${n.source}:${n.title}`)).toEqual(['1:task:Write docs', '2:todo:A', '3:todo:B'])
  const second = ok(ingestTodoWrite(first, [{ content: 'C', status: 'completed', activeForm: 'Doing C' }], 3))
  expect(second.nodes.map(n => `${n.id}:${n.source}:${n.title}`)).toEqual(['1:task:Write docs', '4:todo:C'])
})

test('plan nodes, task nodes and todo nodes coexist with unique ids across a later set', () => {
  let plan = ok(setPlan(emptyPlan(), 'Goal', [{ title: 'P1', children: [{ title: 'P1a' }] }], 1))
  plan = ok(ingestTaskCreate(plan, { id: '3', subject: 'T' }, 2))
  plan = ok(ingestTodoWrite(plan, [{ content: 'D', status: 'pending', activeForm: 'Doing D' }], 3))
  plan = ok(setPlan(plan, 'Goal 2', [{ title: 'Q1' }, { title: 'Q2' }], 4))
  const ids = plan.nodes.map(n => n.id)
  expect(new Set(ids).size).toBe(ids.length)
  expect(plan.title).toBe('Goal 2')
  expect(plan.nodes.filter(n => n.source === 'task').map(n => n.title)).toEqual(['T'])
  expect(plan.nodes.filter(n => n.source === 'todo').map(n => n.title)).toEqual(['D'])
  expect(plan.nodes.filter(n => n.source === 'plan').map(n => n.title)).toEqual(['Q1', 'Q2'])
  // A plan op on the mixed tree still works and removing a task node keeps the others.
  const added = ok(addNodes(plan, null, [{ title: 'Extra' }], 5))
  expect(new Set(added.nodes.map(n => n.id)).size).toBe(added.nodes.length)
  const taskId = added.nodes.find(n => n.source === 'task')?.id ?? ''
  expect(ok(removeNode(added, taskId, 6)).nodes.some(n => n.source === 'task')).toBe(false)
})

test('mirroring respects the node limit', () => {
  let plan = emptyPlan()
  for (let i = 0; i < MAX_NODES; i++) plan = ok(ingestTaskCreate(plan, { id: `${i}`, subject: `t${i}` }, 1))
  expect('error' in ingestTaskCreate(plan, { id: 'x', subject: 'one more' }, 2)).toBe(true)
})
