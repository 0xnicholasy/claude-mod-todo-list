import { expect, test } from 'claude-code/testing'
import type { ActivityState, Plan, PlanNode, PlanStatus } from '../types'
import type { Seg, TreeLine } from './tree'
import { buildTree, DEFAULT_ACCENT, GLYPHS, paneRows, preferredRows, statusLine } from './tree'

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
const idle: ActivityState = { phase: 'idle', subagents: [], running: [], since: 0 }
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
const padded = (left: string, count: string, width = 56): string =>
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
const toolActivity: ActivityState = { phase: 'tool', tool: 'Bash', subagents: ['a'], running: [], since: 0 }

test('buildTree draws exact lines for a 2-level fixture at width 56', () => {
  const lines = buildTree(twoLevel, toolActivity, { maxLines: 20, width: 56 })
  expect(texts(lines)).toEqual([
    'Add CSV',
    `${'━'.repeat(20)}${'─'.repeat(20)}  3/6 · 50%`,
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
  expect(segOf(row, 'T2.2')).toMatchObject({ color: DEFAULT_ACCENT, bold: true, dim: false })
  expect(segOf(row, '◂')).toMatchObject({ dim: true })
  expect(segOf(row, '◉')).toMatchObject({ color: DEFAULT_ACCENT })
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
  for (const width of [56, 60]) {
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
  const lines = buildTree(twoLevel, idle, { maxLines: 20, width: 56 })
  const bar = lines[1]
  expect(bar?.segments[0]).toMatchObject({ text: '━'.repeat(20), color: DEFAULT_ACCENT })
  expect(bar?.segments[1]).toMatchObject({ text: '─'.repeat(20), dim: true })
  expect(bar?.segments[3]).toMatchObject({ text: '3/6 · 50%', dim: true })
  expect(lines[0]?.segments[0]).toMatchObject({ bold: true })
  const widths = [10, 20, 80].map(w => (buildTree(twoLevel, idle, { maxLines: 20, width: w })[1]?.text ?? '').split('  ')[0]?.length)
  expect(widths).toEqual([6, 6, 40])
})

test('a custom accent colours the current row and the bar', () => {
  const lines = buildTree(twoLevel, { ...idle, phase: 'working' }, { maxLines: 20, accent: 'magenta' })
  expect(lines[1]?.segments[0]).toMatchObject({ color: 'magenta' })
  expect(segOf(find(lines, '2.2 T2.2'), 'T2.2')).toMatchObject({ color: 'magenta', bold: true })
  expect(segOf(find(lines, '2.2 T2.2'), '◉')).toMatchObject({ color: 'magenta' })
  expect(lines[2]?.segments[0]).toMatchObject({ color: 'magenta' })
  const defaultLeak = lines.some(l => l.segments.some(s => s.color === DEFAULT_ACCENT))
  expect(defaultLeak).toBe(false)
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
  for (const phase of ['working', 'tool', 'compacting'] as const) expect(style(phase)).toMatchObject({ color: DEFAULT_ACCENT })
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

test('a current node 3 levels deep stays visible at maxLines 8 with a labelled +N more', () => {
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
  const lines = buildTree(deep, idle, { maxLines: 8 })
  expect(lines).toHaveLength(8)
  expect(texts(lines)).toEqual([
    'Add CSV  ━━━━─────  3/7',
    '├─ ✓ 1 T1',
    '├─ ○ 2 T2',
    padded('├─ ◉ 3 T3', '2/4'),
    padded('│  └─ ◉ 3.2 T3.2', '1/3'),
    '│     ├─ ◉ 3.2.2 T3.2.2 ◂',
    '└─ ○ 4 T4',
    '+3 more · 2 done, 1 pending',
  ])
})

test('the first blocked leaf is highlighted when only blocked work is left', () => {
  const blocked = planOf(node('1', 'completed'), node('2', 'blocked', { note: 'wait' }), node('3', 'blocked'))
  const lines = buildTree(blocked, idle, { maxLines: 20 })
  expect(segOf(find(lines, '2 T2'), 'T2')).toMatchObject({ bold: true, color: DEFAULT_ACCENT })
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
  expect(Object.values(GLYPHS).join('')).toBe('✓◉○■–├─└─│━─◂∥')
})

const parallelPlan = planOf(
  node('1', 'completed'),
  node('2', 'in_progress', { parallel: true }),
  node('2.1', 'in_progress'),
  node('2.2', 'in_progress'),
  node('2.3', 'pending'),
  node('3', 'pending'),
)

test('a parallel parent gets a dim tag right after its title, before the right-aligned count', () => {
  const row = find(buildTree(parallelPlan, idle, { maxLines: 20, width: 56 }), '2 T2')
  const at = (needle: string): number => row.segments.findIndex(s => s.text.includes(needle))
  expect(segOf(row, '∥ parallel')).toMatchObject({ text: ' ∥ parallel', dim: true })
  expect(at('∥ parallel')).toBe(at('T2') + 1)
  expect(row.text).toHaveLength(56)
  expect(row.segments[row.segments.length - 1]).toMatchObject({ text: '0/3', dim: true })
  const plain = find(buildTree(twoLevel, idle, { maxLines: 20 }), '2 T2')
  expect(plain.text).not.toContain('∥')
})

test('two running leaves in a parallel group both get the accent and bold, and only the first gets the marker', () => {
  const lines = buildTree(parallelPlan, idle, { maxLines: 20, accent: 'magenta' })
  const first = find(lines, '2.1 T2.1')
  const second = find(lines, '2.2 T2.2')
  for (const row of [first, second]) {
    expect(segOf(row, '◉')).toMatchObject({ color: 'magenta' })
    expect(segOf(row, row === first ? 'T2.1' : 'T2.2')).toMatchObject({ color: 'magenta', bold: true })
  }
  expect(first.text).toContain('◂')
  expect(second.text).not.toContain('◂')
  expect(lines.filter(l => l.text.includes('◂'))).toHaveLength(1)
})

test('truncation keeps the paths to every running leaf', () => {
  const big = planOf(
    node('1', 'pending'),
    node('2', 'pending'),
    node('3', 'in_progress', { parallel: true }),
    node('3.1', 'in_progress'),
    node('3.2', 'pending'),
    node('3.3', 'in_progress'),
    node('4', 'pending'),
    node('5', 'pending'),
  )
  const lines = buildTree(big, idle, { maxLines: 7 })
  const shown = texts(lines)
  expect(shown.some(t => t.includes('3.1 T3.1'))).toBe(true)
  expect(shown.some(t => t.includes('3.3 T3.3'))).toBe(true)
  expect(shown.some(t => t.includes('3 T3'))).toBe(true)
  expect(shown[shown.length - 1]).toMatch(/^\+\d+ more · \d+ pending$/)
})

test('statusLine names the first running leaf and counts the others', () => {
  expect(statusLine(parallelPlan, idle)).toBe('Plan 1/5 · T2.1 +1 more running')
  const long = planOf(
    node('1', 'in_progress', { parallel: true, title: 'g' }),
    node('1.1', 'in_progress', { activeForm: 'x'.repeat(50) }),
    node('1.2', 'in_progress'),
    node('1.3', 'in_progress'),
  )
  expect(statusLine(long, { ...idle, phase: 'working' })).toBe(`Plan 0/3 · ${'x'.repeat(29)}… +2 more running · Working`)
})

test('the parallel glyph passes the no-emoji test and is U+2225', () => {
  expect(GLYPHS.parallel).toBe('∥')
  expect(/\p{Extended_Pictographic}/u.test(GLYPHS.parallel)).toBe(false)
})

const manyAtWidth = planOf(
  node('1', 'in_progress', { parallel: true }),
  node('1.1', 'in_progress', { title: 'A very long step title that cannot fit' }),
  node('1.2', 'blocked', { note: 'waiting on a long answer from the owner' }),
)
const busy: ActivityState = { phase: 'tool', tool: 'WebSearch', subagents: ['a', 'b'], running: [], since: 0 }

test('buildTree draws exact lines for the 2-level fixture at width 40', () => {
  const lines = buildTree(twoLevel, toolActivity, { maxLines: 20, width: 40 })
  expect(texts(lines)).toEqual([
    'Add CSV',
    `${'━'.repeat(13)}${'─'.repeat(13)}  3/6`,
    '◉ Running Bash · 1 subagent',
    '',
    '├─ ✓ 1 T1 2/2',
    '├─ ◉ 2 T2 1/3',
    '│  ├─ ✓ 2.1 T2.1',
    '│  ├─ ◉ 2.2 T2.2 ◂',
    '│  └─ ■ 2.3 T2.3 (blocked: flag name…',
    '└─ ○ 3 T3',
  ])
})

test('a narrow parent row shows a dim count after the title and a bare parallel tag', () => {
  const lines = buildTree(manyAtWidth, idle, { maxLines: 20, width: 40 })
  const row = find(lines, '1 T1')
  expect(row.text).toBe('└─ ◉ 1 T1 0/2 ∥')
  expect(segOf(row, '0/2')).toMatchObject({ dim: true })
  expect(segOf(row, GLYPHS.parallel)).toMatchObject({ dim: true })
})

test('the narrow activity line drops the subagent count when it would overflow', () => {
  const lines = buildTree(twoLevel, busy, { maxLines: 20, width: 30 })
  expect(lines[2]?.text).toBe('◉ Running WebSearch')
})

test('no line is longer than the width at widths 30 and 40', () => {
  for (const width of [30, 40]) {
    for (const plan of [twoLevel, manyAtWidth]) {
      for (const activity of [idle, toolActivity, busy]) {
        for (const line of buildTree(plan, activity, { maxLines: 20, width })) {
          expect(line.text.length).toBeLessThanOrEqual(width)
        }
      }
    }
  }
})

test('at width 56 the layout is unchanged: percentage, right-aligned counts, full notes', () => {
  const lines = buildTree(twoLevel, idle, { maxLines: 20, width: 56 })
  expect(lines[1]?.text).toBe(`${'━'.repeat(20)}${'─'.repeat(20)}  3/6 · 50%`)
  expect(find(lines, '1 T1').text).toBe(padded('├─ ✓ 1 T1', '2/2', 56))
  expect(find(lines, '2.3').text).toBe('│  └─ ■ 2.3 T2.3 (blocked: flag name?)')
})

test('preferredRows counts every line the tree would draw with no limit', () => {
  expect(preferredRows(twoLevel, idle)).toBe(buildTree(twoLevel, idle, { maxLines: 1000 }).length)
  expect(preferredRows(twoLevel, idle)).toBe(9)
  expect(preferredRows(twoLevel, toolActivity)).toBe(10)
  expect(preferredRows(planOf(), idle)).toBe(1)
})

// The owner's shape: 6 groups of 3, everything done except 3.2 which is blocked with a long note.
const owner = (): Plan => {
  const nodes: PlanNode[] = []
  for (let g = 1; g <= 6; g++) {
    nodes.push(node(`${g}`, g === 3 ? 'blocked' : 'completed', { title: `Group ${g}` }))
    for (let k = 1; k <= 3; k++) {
      const blocked = g === 3 && k === 2
      nodes.push(
        node(`${g}.${k}`, blocked ? 'blocked' : 'completed', {
          title: `Step ${g}.${k}`,
          ...(blocked ? { note: 'waiting on the owner to confirm the long running migration window '.repeat(3) } : {}),
        }),
      )
    }
  }

  return { title: 'Six-group demo plan', nodes, issued: [] }
}

test('truncation keeps tree order', () => {
  const rows = texts(buildTree(owner(), idle, { maxLines: 8, width: 80 }))
  const ids = rows.map(t => /(\d(?:\.\d)?) (?:Group|Step)/.exec(t)?.[1]).filter((x): x is string => x !== undefined)
  expect(ids).toEqual([...ids].sort((x, y) => x.localeCompare(y, undefined, { numeric: true })))
})

test('completed top-level runs fold into one line when the rows do not fit', () => {
  const rows = texts(buildTree(owner(), idle, { maxLines: 6, width: 80 }))
  expect(rows).toContain('✓ 1–2, 4–6 done')
  const lone = planOf(node('1', 'completed'), node('2', 'in_progress'), node('3', 'completed'), node('4', 'pending'), node('5', 'pending'))
  expect(texts(buildTree(lone, idle, { maxLines: 5, width: 80 }))).toContain('✓ 1, 3 done')
})

test('the overflow label counts hidden rows by status and omits zeros', () => {
  const plan = planOf(
    node('1', 'in_progress'),
    node('1.1', 'in_progress'),
    node('1.2', 'pending'),
    node('1.3', 'pending'),
    node('1.4', 'completed'),
    node('1.5', 'blocked'),
    node('1.6', 'pending'),
  )
  const rows = texts(buildTree(plan, idle, { maxLines: 6 }))
  expect(rows[rows.length - 1]).toBe('+3 more · 1 done, 1 blocked, 1 pending')
  const none = planOf(node('1', 'in_progress'), node('1.1', 'in_progress'), node('1.2', 'pending'), node('1.3', 'pending'), node('1.4', 'pending'))
  expect(texts(buildTree(none, idle, { maxLines: 5 })).pop()).toBe('+2 more · 2 pending')
})

test('at maxLines 6 the owner shape shows the folded line, the blocked path and a labelled more line', () => {
  const rows = texts(buildTree(owner(), idle, { maxLines: 6, width: 100 }))
  expect(rows).toHaveLength(6)
  expect(rows[0]).toContain('Six-group demo plan')
  expect(rows[1]).toBe('✓ 1–2, 4–6 done')
  expect(rows[2]).toContain('■ 3 Group 3')
  expect(rows.some(t => t.includes('3.2 Step 3.2') && t.includes('◂'))).toBe(true)
  expect(rows[rows.length - 1]).toMatch(/^\+\d+ more · \d+ done/)
})

test('under 10 lines the header is one line with no blank, and the activity line shows only when busy', () => {
  const calm = texts(buildTree(twoLevel, idle, { maxLines: 9, width: 56 }))
  expect(calm[0]).toMatch(/^Add CSV {2}━+─+ {2}3\/6$/)
  expect(calm[1]).toContain('1 T1')
  expect(calm.includes('')).toBe(false)
  const busyRows = texts(buildTree(twoLevel, toolActivity, { maxLines: 9, width: 56 }))
  expect(busyRows[1]).toBe('◉ Running Bash · 1 subagent')
  const roomy = texts(buildTree(twoLevel, idle, { maxLines: 10, width: 56 }))
  expect(roomy[2]).toBe('')
})

test('no line is longer than the width with a long blocked note at widths 40, 56 and 120', () => {
  for (const width of [40, 56, 120]) {
    for (const maxLines of [6, 20]) {
      for (const line of buildTree(owner(), idle, { maxLines, width })) {
        expect(line.text.length).toBeLessThanOrEqual(width)
      }
    }
  }
  const row = texts(buildTree(owner(), idle, { maxLines: 20, width: 56 })).find(t => t.includes('3.2 ')) ?? ''
  expect(row).toContain('3.2 Step 3.2')
  expect(row).toContain('(blocked: ')
})

test('a blocked parent shows no (blocked) text, and a blocked leaf without a note shows none either', () => {
  const rows = texts(buildTree(owner(), idle, { maxLines: 20, width: 100 }))
  const parent = rows.find(t => t.includes('3 Group 3')) ?? ''
  expect(parent).not.toContain('blocked')
  const bare = planOf(node('1', 'blocked'), node('2', 'pending'))
  expect(texts(buildTree(bare, idle, { maxLines: 20 })).find(t => t.includes('1 T1'))).toBe('├─ ■ 1 T1')
})

test('paneRows asks for what the tree wants, clamped to 6..20', () => {
  expect(paneRows(planOf(), idle)).toBe(6)
  expect(paneRows(owner(), idle)).toBe(12)
  const huge = planOf(...Array.from({ length: 40 }, (_, i) => node(`${i + 1}`, 'pending')))
  expect(paneRows(huge, idle)).toBe(20)
})
