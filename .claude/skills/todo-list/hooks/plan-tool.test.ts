import { expect, test } from 'claude-code/testing'
import { emptyPlan, setPlan } from './plan'
import type { Plan } from './plan'
import { applyPlanOp, formatForModel, parsePlanInput, PLAN_INPUT_SCHEMA, PLAN_TOOL_DESCRIPTION, PLAN_TOOL_SHORT_NAME, touchesPlan } from './plan-tool'
import type { PlanOp } from './plan-tool'

const parsed = (raw: unknown): PlanOp => {
  const r = parsePlanInput(raw)
  if ('error' in r) throw new Error(`expected an op, got ${r.error}`)

  return r.parsed
}
const errorOf = (raw: unknown): string => {
  const r = parsePlanInput(raw)
  if ('parsed' in r) throw new Error('expected an error')

  return r.error
}
const built = (r: ReturnType<typeof setPlan>): Plan => {
  if ('error' in r) throw new Error(r.error)

  return r.plan
}

const realistic: Record<string, unknown> = {
  set: {
    op: 'set',
    title: 'CSV export',
    nodes: [{ title: 'Read exporter', activeForm: 'Reading exporter' }, { title: 'Write writer', children: [{ title: 'Header' }, { title: 'Quote', children: [{ title: 'Commas' }] }] }],
  },
  add: { op: 'add', parent: '2', nodes: [{ title: 'Stream' }] },
  update: { op: 'update', updates: [{ id: '1', status: 'completed' }, { id: '2.1', status: 'blocked', note: 'flag name?' }] },
  remove: { op: 'remove', id: '2.1' },
  show: { op: 'show' },
}

test('each op parses from a realistic raw object', () => {
  expect(PLAN_TOOL_SHORT_NAME).toBe('plan')
  expect(parsed(realistic.set)).toEqual({
    op: 'set',
    title: 'CSV export',
    nodes: [{ title: 'Read exporter', activeForm: 'Reading exporter' }, { title: 'Write writer', children: [{ title: 'Header' }, { title: 'Quote', children: [{ title: 'Commas' }] }] }],
  })
  expect(parsed(realistic.add)).toEqual({ op: 'add', parent: '2', nodes: [{ title: 'Stream' }] })
  expect(parsed({ op: 'add', nodes: [{ title: 'Top' }] })).toEqual({ op: 'add', parent: null, nodes: [{ title: 'Top' }] })
  expect(parsed(realistic.update)).toEqual({
    op: 'update',
    updates: [{ id: '1', status: 'completed' }, { id: '2.1', status: 'blocked', note: 'flag name?' }],
  })
  expect(parsed(realistic.remove)).toEqual({ op: 'remove', id: '2.1' })
  expect(parsed(realistic.show)).toEqual({ op: 'show' })
})

test('the schema op enum equals the ops the parser accepts', () => {
  const props = PLAN_INPUT_SCHEMA.properties as Record<string, { enum?: string[] }>
  const schemaOps = props.op?.enum ?? []
  expect([...schemaOps].sort()).toEqual(Object.keys(realistic).sort())
  for (const op of schemaOps) expect(parsed(realistic[op]).op).toBe(op)
  expect(errorOf({ op: 'rename' })).toContain('unknown op "rename"')
})

test('the schema nests children to depth 3 without $ref', () => {
  const text = JSON.stringify(PLAN_INPUT_SCHEMA)
  expect(text.includes('$ref')).toBe(false)
  const props = PLAN_INPUT_SCHEMA.properties as Record<string, { items?: Record<string, unknown> }>
  let level = props.nodes?.items
  let depth = 0
  while (level !== undefined) {
    depth++
    const kids = (level.properties as Record<string, { items?: Record<string, unknown> }>).children
    level = kids?.items
  }
  expect(depth).toBe(3)
})

test('the description is 3 to 6 sentences covering the plan rules', () => {
  const sentences = PLAN_TOOL_DESCRIPTION.split(/(?<=\.)\s+/)
  expect(sentences.length >= 3 && sentences.length <= 6).toBe(true)
  for (const word of ['set', 'in_progress', 'completed', 'blocked', 'skipped', 'note', 'add']) expect(PLAN_TOOL_DESCRIPTION).toContain(word)
})

test('missing op, a wrong-typed field and depth 4 each give a specific error', () => {
  expect(errorOf({ title: 'x', nodes: [] })).toBe('Error: missing "op"; use one of set, add, update, remove, show')
  expect(errorOf('set')).toContain('got a string')
  expect(errorOf({ op: 'set', title: 'T', nodes: [{ title: 5 }] })).toBe('Error: nodes[0].title must be a string, got a number')
  expect(errorOf({ op: 'update', updates: [{ id: '1', status: 'done' }] })).toContain('updates[0].status "done" is unknown')
  expect(errorOf({ op: 'remove', id: 3 })).toBe('Error: op remove needs an "id" string, got a number')
  const deep = { title: 'a', children: [{ title: 'b', children: [{ title: 'c', children: [{ title: 'd' }] }] }] }
  expect(errorOf({ op: 'set', title: 'T', nodes: [deep] })).toContain('nodes[0].children[0].children[0].children is too deep')
  expect(errorOf({ op: 'add', parent: '1.2', nodes: [{ title: 'x', children: [{ title: 'y' }] }] })).toContain('too deep')
  expect(errorOf({ op: 'add', parent: '1.2.3', nodes: [{ title: 'x' }] })).toContain('already at depth 3')
})

test('formatForModel lists every id and status word with no ANSI and a header', () => {
  const plan = built(setPlan(emptyPlan(), 'CSV export', [{ title: 'Read' }, { title: 'Write', children: [{ title: 'Header' }, { title: 'Quote' }] }], 1))
  const done = applyPlanOp(plan, parsed({ op: 'update', updates: [{ id: '1', status: 'completed' }, { id: '2.1', status: 'in_progress' }, { id: '2.2', status: 'skipped', note: 'n/a' }] }), 2)
  if ('error' in done) throw new Error(done.error)
  const text = formatForModel(done.plan)
  const blocked = applyPlanOp(done.plan, parsed({ op: 'update', updates: [{ id: '2.1', status: 'blocked', note: 'why' }] }), 3)
  if ('error' in blocked) throw new Error(blocked.error)
  expect(formatForModel(blocked.plan)).toContain('[blocked] Header (why)')
  for (const id of ['1', '2', '2.1', '2.2']) expect(text).toContain(`${id} [`)
  for (const word of ['completed', 'in_progress', 'skipped']) expect(text).toContain(`[${word}]`)
  expect(text).toContain('Plan: CSV export (2/3 done)')
  expect(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/.test(text)).toBe(false)
  expect(formatForModel(emptyPlan())).toContain('No plan yet')
})

test('formatForModel strips ANSI from titles and caps output at 4000 chars', () => {
  const nodes = Array.from({ length: 60 }, (_, i) => ({ title: `\u001b[31mStep ${i} ${'x'.repeat(100)}` }))
  const plan = built(setPlan(emptyPlan(), 'Big', nodes, 1))
  const text = formatForModel(plan)
  expect(text.length <= 4000).toBe(true)
  expect(text.includes('\u001b')).toBe(false)
  expect(text).toContain('more nodes not shown')
  expect(text).toContain('1 [pending]')
})

test('applyPlanOp runs set, add, update, remove and show against the plan', () => {
  const empty = emptyPlan()
  const set = applyPlanOp(empty, parsed(realistic.set), 5)
  if ('error' in set) throw new Error(set.error)
  expect(set.plan.nodes.map(n => n.id)).toEqual(['1', '2', '2.1', '2.2', '2.2.1'])
  expect(set.text).toContain('Plan: CSV export')

  const add = applyPlanOp(set.plan, parsed(realistic.add), 6)
  if ('error' in add) throw new Error(add.error)
  expect(add.plan.nodes.some(n => n.id === '2.3')).toBe(true)

  const upd = applyPlanOp(add.plan, parsed(realistic.update), 7)
  if ('error' in upd) throw new Error(upd.error)
  expect(upd.plan.nodes.find(n => n.id === '2.1')?.status).toBe('blocked')
  expect(upd.text).toContain('2.1 [blocked] Header (flag name?)')

  const rem = applyPlanOp(upd.plan, parsed(realistic.remove), 8)
  if ('error' in rem) throw new Error(rem.error)
  expect(rem.plan.nodes.some(n => n.id === '2.1')).toBe(false)

  const show = applyPlanOp(rem.plan, parsed(realistic.show), 9)
  if ('error' in show) throw new Error(show.error)
  expect(show.plan).toBe(rem.plan)
  expect(show.text).toBe(formatForModel(rem.plan))
})

test('applyPlanOp returns Error-prefixed text for a rejected op and leaves the caller plan untouched', () => {
  const plan = built(setPlan(emptyPlan(), 'T', [{ title: 'A' }], 1))
  const r = applyPlanOp(plan, parsed({ op: 'remove', id: '9' }), 2)
  expect('error' in r && r.error.startsWith('Error: unknown id "9"')).toBe(true)
  expect(plan.nodes.length).toBe(1)
  const dup = applyPlanOp(plan, parsed({ op: 'update', updates: [{ id: '1', status: 'completed' }, { id: '7', note: 'x' }] }), 3)
  expect('error' in dup).toBe(true)
  expect(plan.nodes[0]?.status).toBe('pending')
})

test('formatForModel never cuts a node line in half, at any plan size', () => {
  for (let n = 1; n <= 60; n++) {
    const nodes = Array.from({ length: n }, (_, i) => ({ title: `S${i}${'x'.repeat(100)}` }))
    const text = formatForModel(built(setPlan(emptyPlan(), 'Big', nodes, 1)))
    expect(text.length <= 4000).toBe(true)
    for (const line of text.split('\n').slice(1)) expect(/^\d+ \[pending\] S\d+x{100}$|^\.\.\. \d+ more nodes not shown/.test(line)).toBe(true)
  }
})

test('formatForModel keeps a long final line whole instead of slicing it', () => {
  for (let len = 40; len <= 120; len += 3) {
    for (let n = 2; n <= 60; n++) {
      const nodes = Array.from({ length: n }, (_, i) => ({ title: i === n - 1 ? 'y'.repeat(120) : `${'x'.repeat(len)}` }))
      const text = formatForModel(built(setPlan(emptyPlan(), 'Big', nodes, 1)))
      expect(text.length <= 4000).toBe(true)
      for (const line of text.split('\n').slice(1)) expect(/^\d+ \[pending\] (x+|y{120})$|^\.\.\. \d+ more nodes not shown/.test(line)).toBe(true)
    }
  }
})

test('touchesPlan is false for show and true for every op that writes the plan', () => {
  expect(touchesPlan(parsed({ op: 'show' }))).toBe(false)
  expect(touchesPlan(parsed({ op: 'set', title: 'T', nodes: [{ title: 'A' }] }))).toBe(true)
  expect(touchesPlan(parsed({ op: 'add', nodes: [{ title: 'A' }] }))).toBe(true)
  expect(touchesPlan(parsed({ op: 'update', updates: [{ id: '1', status: 'completed' }] }))).toBe(true)
  expect(touchesPlan(parsed({ op: 'remove', id: '1' }))).toBe(true)
})

test('parallel parses at depth 1 to 3 and in updates', () => {
  const nodes = [{ title: 'A', parallel: true, children: [{ title: 'B', parallel: false, children: [{ title: 'C' }] }] }]
  const r = parsePlanInput({ op: 'set', title: 'P', nodes })
  if (!('parsed' in r) || r.parsed.op !== 'set') throw new Error('expected a parsed set')
  expect(r.parsed.nodes[0]?.parallel).toBe(true)
  expect(r.parsed.nodes[0]?.children?.[0]?.parallel).toBe(false)
  const u = parsePlanInput({ op: 'update', updates: [{ id: '1', parallel: true }] })
  if (!('parsed' in u) || u.parsed.op !== 'update') throw new Error('expected a parsed update')
  expect(u.parsed.updates[0]?.parallel).toBe(true)
})

test('a non-boolean parallel gives an error naming the field', () => {
  const a = parsePlanInput({ op: 'set', title: 'P', nodes: [{ title: 'A', children: [{ title: 'B', parallel: 'yes' }] }] })
  expect('error' in a && a.error).toContain('nodes[0].children[0].parallel must be a boolean')
  const b = parsePlanInput({ op: 'update', updates: [{ id: '1', parallel: 1 }] })
  expect('error' in b && b.error).toContain('updates[0].parallel must be a boolean')
})

test('formatForModel marks a parallel parent and the schema offers parallel at every depth', () => {
  const plan = setPlan(emptyPlan(), 'P', [{ title: 'Group', parallel: true, children: [{ title: 'A' }, { title: 'B' }] }], 1)
  if ('error' in plan) throw new Error(plan.error)
  expect(formatForModel(plan.plan)).toContain('1 [pending] Group [parallel]')
  expect(formatForModel(plan.plan)).not.toContain('1.1 [pending] A [parallel]')
  expect(JSON.stringify(PLAN_INPUT_SCHEMA).split('"parallel"').length - 1).toBe(4)
})
