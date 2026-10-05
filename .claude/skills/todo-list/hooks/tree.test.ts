import { expect, test } from 'claude-code/testing'
import type { ActivityState, Plan, PlanNode, PlanStatus } from '../types'
import type { Seg, TreeLine } from './tree'
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

// A row padded so `count` ends at the right edge of a pane `width` cells wide.
const padded = (left: string, count: string, width = 48): string =>
  `${left}${' '.repeat(width - left.length - count.length)}${count}`
const find = (lines: TreeLine[], needle: string): TreeLine => {
  const hit = lines.find(l => l.text.includes(needle))
  if (hit === undefined) throw new Error(`no row contains ${needle}`)

  return hit
}
const segOf = (line: TreeLine, needle: string): Seg => {
  const hit = line.segments.find(s => s.text.includes(needle))
  if (hit === undefined) throw new Error(`no segment contains ${needle}`)

  return hit
}
const toolActivity: ActivityState = { phase: 'tool', tool: 'Bash', subagents: ['a'], since: 0 }

test('buildTree draws exact lines for a 2-level fixture at width 48', () => {
  const lines = buildTree(twoLevel, toolActivity, { maxLines: 20, width: 48 })
  expect(texts(lines)).toEqual([
    'Add CSV',
    `${'━'.repeat(16)}${'─'.repeat(16)}  3/6 · 50%`,
    '◉ Running Bash · 1 subagent',
    '',
    padded('├─ ✓ 1 T1', '2/2'),
    padded('├─ ◉ 2 T2', '1/3'),
    '│  ├─ ✓ 2.1 T2.1',
    '│  ├─ ◉ 2.2 T2.2 ◂',
    '│  └─ ■ 2.3 T2.3 (blocked: flag name?)',
    '└─ ○ 3 T3',
  ])
})

test('the current row has an accent, bold title and a dim marker, with no inverse or background', () => {
  const lines = buildTree(twoLevel, idle, { maxLines: 20 })
  const row = find(lines, '2.2 T2.2')
  expect(segOf(row, 'T2.2')).toMatchObject({ color: 'cyan', bold: true, dim: false })
  expect(segOf(row, '◂')).toMatchObject({ dim: true })
  expect(segOf(row, '◉')).toMatchObject({ color: 'cyan' })
  for (const line of lines) {
    for (const s of line.segments) {
      expect('inverse' in s).toBe(false)
      expect('backgroundColor' in s).toBe(false)
    }
  }
})

test('leaf statuses get their glyph colour and title style', () => {
  const lines = buildTree(twoLevel, idle, { maxLines: 20 })
  expect(segOf(find(lines, '2.1 T2.1'), '✓')).toMatchObject({ color: 'green' })
  expect(segOf(find(lines, '2.1 T2.1'), 'T2.1')).toMatchObject({ dim: true })
  expect(segOf(find(lines, '2.3 T2.3'), '■')).toMatchObject({ color: 'yellow' })
  expect(segOf(find(lines, '2.3 T2.3'), '(blocked: flag name?)')).toMatchObject({ dim: true })
  expect(segOf(find(lines, '3 T3'), 'T3')).toMatchObject({ bold: false, dim: false })
  const skipped = buildTree(planOf(node('1', 'skipped'), node('2', 'pending')), idle, { maxLines: 20 })
  expect(segOf(find(skipped, '1 T1'), 'T1')).toMatchObject({ dim: true, strikethrough: true })
  expect(segOf(find(skipped, '1 T1'), '–')).toMatchObject({ dim: true })
})

test('a parent title is bold and never the accent colour', () => {
  const lines = buildTree(twoLevel, idle, { maxLines: 20, accent: 'magenta' })
  const title = segOf(find(lines, '2 T2'), 'T2')
  expect(title.bold).toBe(true)
  expect(title.color).toBeUndefined()
  expect(title.dim).toBe(false)
})

test('connectors and ids are dim', () => {
  const lines = buildTree(twoLevel, idle, { maxLines: 20 })
  const row = find(lines, '2.3 T2.3')
  expect(row.segments[0]).toMatchObject({ text: '│  └─ ', dim: true })
  expect(segOf(row, '2.3')).toMatchObject({ dim: true })
  expect(segOf(find(lines, '3 T3'), '└─')).toMatchObject({ dim: true })
})

test('parent counts sit dim at the right edge of the given width', () => {
  for (const width of [48, 60]) {
    const lines = buildTree(twoLevel, idle, { maxLines: 20, width })
    const row = find(lines, '2 T2')
    expect(row.text).toHaveLength(width)
    expect(row.text.endsWith('1/3')).toBe(true)
    expect(row.segments[row.segments.length - 1]).toMatchObject({ text: '1/3', dim: true })
  }
})

test('a long title is not cut at 20 characters at width 80, and is cut with an ellipsis at the width', () => {
  const title = 'Fix the deferred plan tool, then land the whole branch today'
  const long: Plan = { title, nodes: [node('1', 'in_progress')], issued: [] }
  expect(texts(buildTree(long, idle, { maxLines: 20, width: 80 }))[0]).toBe(title)
  const narrow = texts(buildTree(long, idle, { maxLines: 20, width: 30 }))[0] ?? ''
  expect(narrow).toHaveLength(30)
  expect(narrow.endsWith('…')).toBe(true)
  const longLeaf: Plan = { title: 'P', nodes: [node('1', 'pending', { title: 'x'.repeat(100) })], issued: [] }
  const row = texts(buildTree(longLeaf, idle, { maxLines: 20, width: 40 })).find(l => l.includes('1 x')) ?? ''
  expect(row).toHaveLength(40)
  expect(row).toContain('…')
})

test('a tiny width never produces a negative pad or a throw, and counts keep one space of padding', () => {
  for (const width of [1, 5, 12]) {
    const lines = buildTree(twoLevel, idle, { maxLines: 20, width })
    const row = find(lines, '◉ 2 ')
    expect(row.text.endsWith('1/3')).toBe(true)
    expect(row.text).toMatch(/ 1\/3$/)
  }
})

test('the progress bar uses a filled accent run and a dim track', () => {
  const lines = buildTree(twoLevel, idle, { maxLines: 20, width: 48 })
  const bar = lines[1]
  expect(bar?.segments[0]).toMatchObject({ text: '━'.repeat(16), color: 'cyan' })
  expect(bar?.segments[1]).toMatchObject({ text: '─'.repeat(16), dim: true })
  expect(bar?.segments[3]).toMatchObject({ text: '3/6 · 50%', dim: true })
  expect(lines[0]?.segments[0]).toMatchObject({ bold: true })
  const widths = [10, 20, 80].map(w => (buildTree(twoLevel, idle, { maxLines: 20, width: w })[1]?.text ?? '').split('  ')[0]?.length)
  expect(widths).toEqual([10, 10, 40])
})

test('a custom accent colours the current row and the bar', () => {
  const lines = buildTree(twoLevel, { ...idle, phase: 'working' }, { maxLines: 20, accent: 'magenta' })
  expect(lines[1]?.segments[0]).toMatchObject({ color: 'magenta' })
  expect(segOf(find(lines, '2.2 T2.2'), 'T2.2')).toMatchObject({ color: 'magenta', bold: true })
  expect(segOf(find(lines, '2.2 T2.2'), '◉')).toMatchObject({ color: 'magenta' })
  expect(lines[2]?.segments[0]).toMatchObject({ color: 'magenta' })
  const cyanLeak = lines.some(l => l.segments.some(s => s.color === 'cyan'))
  expect(cyanLeak).toBe(false)
})

test('the activity line is coloured by phase and omitted when idle', () => {
  const at = (phase: ActivityState['phase'], accent?: string): TreeLine[] =>
    buildTree(twoLevel, { ...idle, phase, tool: 'Bash' }, { maxLines: 20, accent })
  const style = (phase: ActivityState['phase']): Seg | undefined => at(phase)[2]?.segments[0]
  expect(style('permission')).toMatchObject({ color: 'yellow' })
  expect(style('question')).toMatchObject({ color: 'yellow' })
  expect(style('error')).toMatchObject({ color: 'red' })
  expect(style('interrupted')).toMatchObject({ dim: true })
  expect(style('interrupted')?.color).toBeUndefined()
  for (const phase of ['working', 'tool', 'compacting'] as const) expect(style(phase)).toMatchObject({ color: 'cyan' })
  expect(at('working', '#c084fc')[2]?.segments[0]).toMatchObject({ color: '#c084fc' })
  const quiet = texts(at('idle'))
  expect(quiet.slice(0, 3)).toEqual(['Add CSV', expect.stringContaining('3/6'), ''])
  expect(quiet.some(l => l.includes('Idle'))).toBe(false)
})

test('a completed branch collapses to one dim line with a dim count', () => {
  const lines = buildTree(twoLevel, idle, { maxLines: 20 })
  const row = find(lines, '1 T1')
  expect(row.text).toBe(padded('├─ ✓ 1 T1', '2/2'))
  for (const s of row.segments.filter(x => x.text.trim() !== '')) expect(s.dim).toBe(true)
  expect(lines.some(l => l.text.includes('1.1'))).toBe(false)
})

test('a current node 3 levels deep stays visible at maxLines 8 with an accurate +N more', () => {
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
  const lines = buildTree(deep, idle, { maxLines: 8 })
  expect(lines).toHaveLength(8)
  expect(segOf(lines[6] as TreeLine, 'T3.2.2')).toMatchObject({ bold: true, color: 'cyan' })
  const hidden = full.length - (lines.length - 1)
  expect(lines[lines.length - 1]?.text).toBe(`+${hidden} more`)
  expect(texts(lines)).toEqual([
    'Add CSV',
    `${'━'.repeat(14)}${'─'.repeat(18)}  3/7 · 43%`,
    '',
    '├─ ✓ 1 T1',
    padded('├─ ◉ 3 T3', '2/4'),
    padded('│  └─ ◉ 3.2 T3.2', '1/3'),
    '│     ├─ ◉ 3.2.2 T3.2.2 ◂',
    `+${hidden} more`,
  ])
})

test('the first blocked leaf is highlighted when only blocked work is left', () => {
  const blocked = planOf(node('1', 'completed'), node('2', 'blocked', { note: 'wait' }), node('3', 'blocked'))
  const lines = buildTree(blocked, idle, { maxLines: 20 })
  expect(segOf(find(lines, '2 T2'), 'T2')).toMatchObject({ bold: true, color: 'cyan' })
  expect(find(lines, '2 T2').text).toContain('◂')
  expect(find(lines, '3 T3').text).not.toContain('◂')
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
  const longPlan = planOf(node('1', 'in_progress', { activeForm: 'x'.repeat(50) }))
  expect(statusLine(longPlan, idle)).toBe(`Plan 0/1 · ${'x'.repeat(29)}…`)
  expect(statusLine(planOf(), idle)).toBeUndefined()
  expect(statusLine(planOf(), { ...idle, phase: 'working' })).toBe('Working')
})

test('no glyph is an emoji (Extended_Pictographic)', () => {
  for (const glyph of Object.values(GLYPHS)) expect(/\p{Extended_Pictographic}/u.test(glyph)).toBe(false)
  expect(Object.values(GLYPHS).join('')).toBe('✓◉○■–├─└─│━─◂')
})
