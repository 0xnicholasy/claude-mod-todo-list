import { expect, test } from 'claude-code/testing'
import type { ActivityState, Plan, PlanNode, PlanStatus } from '../types'
import { buildTree, GLYPHS, statusLine } from './tree'

const node = (id: string, status: PlanStatus, extra: Partial<PlanNode> = {}): PlanNode => {
  const parts = id.split('.')

  return {
    id,
    parentId: parts.length === 1 ? null : parts.slice(0, -1).join('.'),
    title: `T${id}`,
    status,
    source: 'plan',
    updatedAt: 0,
    ...extra,
  }
}

const planOf = (...nodes: PlanNode[]): Plan => ({ title: 'Add CSV', nodes, issued: [] })
const idle: ActivityState = { phase: 'idle', subagents: [], since: 0 }
const texts = (lines: { text: string }[]): string[] => lines.map(l => l.text)

// 2 levels: a completed branch, an active branch with a blocked and last child, a pending leaf.
const twoLevel = planOf(
  node('1', 'completed'),
  node('1.1', 'completed'),
  node('1.2', 'completed'),
  node('2', 'in_progress'),
  node('2.1', 'completed'),
  node('2.2', 'in_progress'),
  node('2.3', 'blocked', { note: 'flag name?' }),
  node('3', 'pending'),
)

test('buildTree draws exact lines for a 2-level fixture, with connectors for last and non-last children', () => {
  const lines = buildTree(twoLevel, { phase: 'tool', tool: 'Bash', subagents: ['a'], since: 0 }, { maxLines: 20 })
  expect(texts(lines)).toEqual([
    'Add CSV 3/6 ███████░░░░░░░ 50%',
    '◉ Running Bash · 1 subagent',
    '├─ ✓ 1 T1 (2/2)',
    '├─ ◉ 2 T2',
    '│  ├─ ✓ 2.1 T2.1',
    '│  ├─ ◉ 2.2 T2.2',
    '│  └─ ■ 2.3 T2.3 (blocked: flag name?)',
    '└─ ○ 3 T3',
  ])
})

test('buildTree styles: current node is bold and inverse, statuses get their colour', () => {
  const lines = buildTree(twoLevel, idle, { maxLines: 20 })
  const by = (t: string) => lines.find(l => l.text.includes(t))
  expect(by('2.2 T2.2')).toMatchObject({ bold: true, inverse: true })
  expect(by('2.1 T2.1')).toMatchObject({ color: 'green', dim: true, inverse: false })
  expect(by('2.3 T2.3')).toMatchObject({ color: 'yellow', inverse: false })
  expect(by('3 T3')).toMatchObject({ bold: false, dim: false, inverse: false })
  expect(buildTree(planOf(node('1', 'skipped'), node('2', 'pending')), idle, { maxLines: 20 })[2]).toMatchObject({
    dim: true,
    strikethrough: true,
  })
})

test('a completed branch collapses to a done/total line', () => {
  const lines = texts(buildTree(twoLevel, idle, { maxLines: 20 }))
  expect(lines).toContain('├─ ✓ 1 T1 (2/2)')
  expect(lines.some(l => l.includes('1.1'))).toBe(false)
})

test('a current node 3 levels deep stays visible at maxLines 6 with an accurate +N more', () => {
  const deep = planOf(
    node('1', 'completed'),
    node('2', 'pending'),
    node('3', 'in_progress'),
    node('3.1', 'completed'),
    node('3.2', 'in_progress'),
    node('3.2.1', 'completed'),
    node('3.2.2', 'in_progress'),
    node('3.2.3', 'pending'),
    node('4', 'pending'),
  )
  const full = buildTree(deep, idle, { maxLines: 40 })
  const lines = buildTree(deep, idle, { maxLines: 6 })
  expect(lines).toHaveLength(6)
  expect(texts(lines).some(l => l.includes('3.2.2 T3.2.2'))).toBe(true)
  expect(lines[4]).toMatchObject({ bold: true, inverse: true })
  const hidden = full.length - (lines.length - 1)
  expect(lines[lines.length - 1]?.text).toBe(`+${hidden} more`)
  expect(texts(lines)).toEqual([
    'Add CSV 3/7 ██████░░░░░░░░ 43%',
    '○ Idle',
    '├─ ◉ 3 T3',
    '│  └─ ◉ 3.2 T3.2',
    '│     ├─ ◉ 3.2.2 T3.2.2',
    '+6 more',
  ])
})

test('the first blocked leaf is highlighted when only blocked work is left', () => {
  const blocked = planOf(node('1', 'completed'), node('2', 'blocked', { note: 'wait' }), node('3', 'blocked'))
  const lines = buildTree(blocked, idle, { maxLines: 20 })
  expect(lines.find(l => l.text.includes('2 T2'))).toMatchObject({ bold: true, inverse: true })
  expect(lines.find(l => l.text.includes('3 T3'))).toMatchObject({ inverse: false })
  expect(statusLine(blocked, idle)).toBe('Plan 1/3 · T2')
})

test('the empty state reads "No plan yet."', () => {
  expect(texts(buildTree(planOf(), idle, { maxLines: 10 }))).toEqual(['No plan yet.'])
})

test('statusLine covers every activity phase', () => {
  const plan = planOf(node('1', 'completed'), node('2', 'in_progress', { activeForm: 'Escaping quotes' }), node('3', 'pending'))
  const at = (a: Partial<ActivityState>): string | undefined => statusLine(plan, { ...idle, ...a })
  expect(at({})).toBe('Plan 1/3 · Escaping quotes')
  expect(at({ phase: 'working' })).toBe('Plan 1/3 · Escaping quotes · Working')
  expect(at({ phase: 'tool', tool: 'Bash' })).toBe('Plan 1/3 · Escaping quotes · Running Bash')
  expect(at({ phase: 'permission', tool: 'Bash' })).toBe('Plan 1/3 · Escaping quotes · Waiting for permission: Bash')
  expect(at({ phase: 'question' })).toBe('Plan 1/3 · Escaping quotes · Waiting for your answer')
  expect(at({ phase: 'compacting' })).toBe('Plan 1/3 · Escaping quotes · Compacting')
  expect(at({ phase: 'interrupted' })).toBe('Plan 1/3 · Escaping quotes · Interrupted')
  expect(at({ phase: 'error', detail: 'rate limit' })).toBe('Plan 1/3 · Escaping quotes · Error: rate limit')
  expect(statusLine(planOf(), idle)).toBeUndefined()
  expect(statusLine(planOf(), { ...idle, phase: 'working' })).toBe('Working')
})

test('no glyph is an emoji (Extended_Pictographic)', () => {
  for (const glyph of Object.values(GLYPHS)) expect(/\p{Extended_Pictographic}/u.test(glyph)).toBe(false)
  expect(Object.values(GLYPHS).join('')).toBe('✓◉○■–├─└─│█░')
})
