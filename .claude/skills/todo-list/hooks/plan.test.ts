import { expect, test } from 'claude-code/testing'
import {
  addNodes,
  currentNode,
  emptyPlan,
  hasUnfinished,
  progress,
  removeNode,
  rollup,
  setPlan,
  updateNodes,
} from './plan'
import type { Plan, PlanInputNode, PlanResult } from './plan'

// Unwraps a result that must succeed.
const ok = (r: PlanResult): Plan => {
  if ('error' in r) throw new Error(`expected a plan, got error: ${r.error}`)

  return r.plan
}
const err = (r: PlanResult): string => {
  if ('plan' in r) throw new Error('expected an error, got a plan')

  return r.error
}
const ids = (p: Plan): string[] => p.nodes.map(n => n.id)
const status = (p: Plan, id: string): string | undefined => p.nodes.find(n => n.id === id)?.status

const sample: PlanInputNode[] = [
  { title: 'Read exporter' },
  { title: 'Write writer', children: [{ title: 'Header', children: [{ title: 'Quote' }] }, { title: 'Stream' }] },
  { title: 'Tests' },
]

test('setPlan assigns path ids 1, 1.1, 1.1.1 in tree order with parentId links', () => {
  const plan = ok(setPlan(emptyPlan(), 'CSV export', sample, 10))
  expect(plan.title).toBe('CSV export')
  expect(ids(plan)).toEqual(['1', '2', '2.1', '2.1.1', '2.2', '3'])
  expect(plan.nodes.map(n => n.parentId)).toEqual([null, null, '2', '2.1', '2', null])
  expect(plan.nodes.every(n => n.source === 'plan' && n.updatedAt === 10)).toBe(true)
})

test('add under a parent takes max sibling id + 1 and never reuses a removed id', () => {
  let plan = ok(setPlan(emptyPlan(), 'P', sample, 1))
  plan = ok(addNodes(plan, '2', [{ title: 'Flush' }], 2))
  expect(ids(plan)).toEqual(['1', '2', '2.1', '2.1.1', '2.2', '2.3', '3'])
  plan = ok(removeNode(plan, '2.3', 3))
  plan = ok(addNodes(plan, '2', [{ title: 'Close' }], 4))
  expect(ids(plan)).toContain('2.4')
  expect(ids(plan)).not.toContain('2.3')
  plan = ok(removeNode(plan, '3', 5))
  plan = ok(addNodes(plan, null, [{ title: 'Docs' }], 6))
  expect(ids(plan)).toEqual(['1', '2', '2.1', '2.1.1', '2.2', '2.4', '4'])
})

test('update of an unknown id returns an error listing the valid ids, and changes nothing', () => {
  const plan = ok(setPlan(emptyPlan(), 'P', sample, 1))
  const message = err(updateNodes(plan, [{ id: '1', status: 'completed' }, { id: '9', status: 'completed' }], 2))
  expect(message).toContain('unknown id "9"')
  expect(message).toContain('1, 2, 2.1, 2.1.1, 2.2, 3')
  expect(status(plan, '1')).toBe('pending')
})

test('update sets leaf status, title and note; an empty note clears it; a parent status is refused', () => {
  const plan = ok(setPlan(emptyPlan(), 'P', sample, 1))
  const next = ok(updateNodes(plan, [{ id: '1', status: 'blocked', note: 'flag name?', title: 'Read it' }], 5))
  const node = next.nodes.find(n => n.id === '1')
  expect(node).toMatchObject({ status: 'blocked', note: 'flag name?', title: 'Read it', updatedAt: 5 })
  const cleared = ok(updateNodes(next, [{ id: '1', note: '' }], 6))
  expect(cleared.nodes.find(n => n.id === '1')?.note).toBeUndefined()
  expect(err(updateNodes(plan, [{ id: '2', status: 'completed' }], 2))).toContain('has children')
})

test('remove drops the subtree and reports an unknown id', () => {
  const plan = ok(setPlan(emptyPlan(), 'P', sample, 1))
  const next = ok(removeNode(plan, '2.1', 2))
  expect(ids(next)).toEqual(['1', '2', '2.2', '3'])
  expect(err(removeNode(plan, '7', 2))).toContain('unknown id "7"')
  expect(ids(ok(removeNode(plan, '2', 2)))).toEqual(['1', '3'])
})

test('rollup: all completed or skipped completes, any in_progress wins, blocked needs none in_progress', () => {
  const base = ok(setPlan(emptyPlan(), 'P', [{ title: 'A', children: [{ title: 'a1' }, { title: 'a2' }] }], 1))
  expect(status(base, '1')).toBe('pending')

  const done = ok(updateNodes(base, [{ id: '1.1', status: 'completed' }, { id: '1.2', status: 'skipped', note: 'n/a' }], 2))
  expect(status(done, '1')).toBe('completed')

  const active = ok(updateNodes(base, [{ id: '1.1', status: 'blocked', note: 'x' }, { id: '1.2', status: 'in_progress' }], 2))
  expect(status(active, '1')).toBe('in_progress')

  const blocked = ok(updateNodes(base, [{ id: '1.1', status: 'blocked', note: 'x' }], 2))
  expect(status(blocked, '1')).toBe('blocked')

  const partial = ok(updateNodes(base, [{ id: '1.1', status: 'completed' }], 2))
  expect(status(partial, '1')).toBe('in_progress')
})

test('rollup climbs more than one level and stamps updatedAt only on parents that changed', () => {
  const base = ok(setPlan(emptyPlan(), 'P', sample, 1))
  const next = ok(updateNodes(base, [{ id: '2.1.1', status: 'in_progress' }], 7))
  expect(status(next, '2.1')).toBe('in_progress')
  expect(status(next, '2')).toBe('in_progress')
  expect(next.nodes.find(n => n.id === '2')?.updatedAt).toBe(7)
  expect(next.nodes.find(n => n.id === '3')?.updatedAt).toBe(1)
  expect(rollup(next, 99)).toEqual(next)
})

test('limits: depth 3, 60 nodes, title 120 characters, note 200 characters', () => {
  const deep: PlanInputNode[] = [{ title: 'a', children: [{ title: 'b', children: [{ title: 'c', children: [{ title: 'd' }] }] }] }]
  expect(err(setPlan(emptyPlan(), 'P', deep, 1))).toContain('deeper than 3')

  const base = ok(setPlan(emptyPlan(), 'P', sample, 1))
  expect(err(addNodes(base, '2.1.1', [{ title: 'too deep' }], 2))).toContain('deeper than 3')

  const many = Array.from({ length: 61 }, (_, i) => ({ title: `n${i}` }))
  expect(err(setPlan(emptyPlan(), 'P', many, 1))).toContain('limit is 60')
  const sixty = ok(setPlan(emptyPlan(), 'P', many.slice(0, 60), 1))
  expect(sixty.nodes).toHaveLength(60)
  expect(err(addNodes(sixty, null, [{ title: 'one more' }], 2))).toContain('limit is 60')

  expect(err(setPlan(emptyPlan(), 'P', [{ title: 'x'.repeat(121) }], 1))).toContain('limit is 120')
  expect(err(setPlan(emptyPlan(), 'x'.repeat(121), sample, 1))).toContain('limit is 120')
  expect(ok(setPlan(emptyPlan(), 'P', [{ title: 'x'.repeat(120) }], 1)).nodes).toHaveLength(1)

  expect(err(updateNodes(base, [{ id: '1', note: 'n'.repeat(201) }], 2))).toContain('limit is 200')
  expect(ok(updateNodes(base, [{ id: '1', note: 'n'.repeat(200) }], 2)).nodes[0]?.note).toHaveLength(200)
})

test('a title containing an escape sequence is stored cleaned', () => {
  const plan = ok(setPlan(emptyPlan(), 'Plan\u001b[2J', [{ title: 'Wipe\u001b[2J screen', activeForm: 'Wiping‮' }], 1))
  expect(plan.title).toBe('Plan [2J')
  expect(plan.nodes[0]?.title).toBe('Wipe [2J screen')
  expect(plan.nodes[0]?.activeForm).toBe('Wiping')
  const next = ok(updateNodes(plan, [{ id: '1', title: 'T\u001b[2J', note: 'N\u001b[2J' }], 2))
  expect(next.nodes[0]).toMatchObject({ title: 'T [2J', note: 'N [2J' })
})

test('every op returns an error instead of throwing on bad input', () => {
  const plan = ok(setPlan(emptyPlan(), 'P', sample, 1))
  expect(err(setPlan(emptyPlan(), 'P', [], 1))).toContain('no nodes')
  expect(err(setPlan(emptyPlan(), '  ', sample, 1))).toContain('plan title is empty')
  expect(err(addNodes(plan, '8', [{ title: 'x' }], 2))).toContain('unknown parent "8"')
  expect(err(updateNodes(plan, [{ id: '1', status: 'done' as 'completed' }], 2))).toContain('unknown status')
  const malformed = [{ title: 42 }] as unknown as PlanInputNode[] // a runtime shape the types forbid
  expect(err(setPlan(emptyPlan(), 'P', malformed, 1))).toContain('must be text')
  expect(err(setPlan(emptyPlan(), 'P', undefined as unknown as PlanInputNode[], 1))).not.toBe('')
})

test('set keeps todo and task nodes and numbers new top-level ids after them', () => {
  const kept: Plan = {
    title: 'old',
    nodes: [{ id: '1', parentId: null, title: 'from TodoWrite', status: 'pending', source: 'todo', updatedAt: 0 }],
    issued: [],
  }
  const plan = ok(setPlan(kept, 'New', [{ title: 'planned' }], 5))
  expect(plan.nodes.map(n => [n.id, n.source])).toEqual([['1', 'todo'], ['2', 'plan']])
})

test('progress counts leaves, with skipped counted as done', () => {
  const base = ok(setPlan(emptyPlan(), 'P', sample, 1))
  expect(progress(base)).toEqual({ done: 0, total: 4 })
  const next = ok(updateNodes(base, [{ id: '1', status: 'completed' }, { id: '2.2', status: 'skipped', note: 'n/a' }], 2))
  expect(progress(next)).toEqual({ done: 2, total: 4 })
  expect(progress(emptyPlan())).toEqual({ done: 0, total: 0 })
})

test('currentNode is the first in_progress leaf, else the first pending leaf, else null', () => {
  const base = ok(setPlan(emptyPlan(), 'P', sample, 1))
  expect(currentNode(base)?.id).toBe('1')
  const mid = ok(updateNodes(base, [{ id: '1', status: 'completed' }, { id: '2.2', status: 'in_progress' }], 2))
  expect(currentNode(mid)?.id).toBe('2.2')
  const next = ok(updateNodes(mid, [{ id: '2.2', status: 'completed' }], 3))
  expect(currentNode(next)?.id).toBe('2.1.1')
  const all = ok(
    updateNodes(next, [{ id: '2.1.1', status: 'completed' }, { id: '3', status: 'completed' }], 4),
  )
  expect(currentNode(all)).toBeNull()
  expect(currentNode(emptyPlan())).toBeNull()
})

test('hasUnfinished is true while a leaf is pending, in_progress or blocked', () => {
  const base = ok(setPlan(emptyPlan(), 'P', [{ title: 'A' }, { title: 'B' }], 1))
  expect(hasUnfinished(base)).toBe(true)
  const blocked = ok(updateNodes(base, [{ id: '1', status: 'completed' }, { id: '2', status: 'blocked', note: 'x' }], 2))
  expect(hasUnfinished(blocked)).toBe(true)
  const finished = ok(updateNodes(base, [{ id: '1', status: 'completed' }, { id: '2', status: 'skipped', note: 'n/a' }], 2))
  expect(hasUnfinished(finished)).toBe(false)
  expect(hasUnfinished(emptyPlan())).toBe(false)
})

test('removing the last child resets the parent to pending instead of keeping its derived status', () => {
  const base = ok(setPlan(emptyPlan(), 'P', [{ title: 'A', children: [{ title: 'a1' }] }], 1))
  const done = ok(updateNodes(base, [{ id: '1.1', status: 'completed' }], 2))
  expect(status(done, '1')).toBe('completed')
  const next = ok(removeNode(done, '1.1', 3))
  expect(status(next, '1')).toBe('pending')
  expect(progress(next)).toEqual({ done: 0, total: 1 })
})
