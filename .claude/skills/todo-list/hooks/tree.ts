// Pure plan-tree rendering: pane lines and the status-line text. No `$` here: register.tsx
// reads the atoms and passes plain data in, then draws each TreeLine with <Text>.
import type { ActivityState, ActivityPhase, Plan, PlanNode, PlanStatus } from '../types'
import { currentNode, progress } from './plan'

// Box-drawing and geometric glyphs only; tree.test.ts asserts none is Extended_Pictographic.
export const GLYPHS = {
  completed: '✓',
  in_progress: '◉',
  pending: '○',
  blocked: '■',
  skipped: '–',
  branch: '├─',
  last: '└─',
  pipe: '│',
  full: '█',
  empty: '░',
} as const

export const BAR_CELLS = 14
const MAX_HEADER_TITLE = 20

// A row of the pane. Long titles are left to wrap="truncate-end" at render.
export type TreeLine = {
  text: string
  color?: string
  bold: boolean
  dim: boolean
  inverse: boolean
  strikethrough?: boolean
}

const plain = (text: string): TreeLine => ({ text, bold: false, dim: false, inverse: false })

const pluralSubagents = (n: number): string => `${n} subagent${n === 1 ? '' : 's'}`

// Text for an activity phase. Local stand-in: T05's `activityLabel` replaces it in T07.
const phaseLabel = (activity: ActivityState): string => {
  const phase: ActivityPhase = activity.phase
  switch (phase) {
    case 'idle':
      return 'Idle'
    case 'working':
      return 'Working'
    case 'tool':
      return activity.tool === undefined ? 'Running tool' : `Running ${activity.tool}`
    case 'permission':
      return activity.tool === undefined ? 'Waiting for permission' : `Waiting for permission: ${activity.tool}`
    case 'question':
      return 'Waiting for your answer'
    case 'compacting':
      return 'Compacting'
    case 'interrupted':
      return 'Interrupted'
    case 'error':
      return activity.detail === undefined || activity.detail === '' ? 'Error' : `Error: ${activity.detail}`
  }
}

const bar = (done: number, total: number): string => {
  const filled = total === 0 ? 0 : Math.round((done / total) * BAR_CELLS)

  return GLYPHS.full.repeat(filled) + GLYPHS.empty.repeat(BAR_CELLS - filled)
}

const percent = (done: number, total: number): number => (total === 0 ? 0 : Math.round((done / total) * 100))

const shorten = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 1)}…`)

const childrenOf = (nodes: readonly PlanNode[], id: string): PlanNode[] => nodes.filter(n => n.parentId === id)

const leavesUnder = (nodes: readonly PlanNode[], id: string): PlanNode[] => {
  const kids = childrenOf(nodes, id)

  return kids.length === 0 ? [] : kids.flatMap(k => (childrenOf(nodes, k.id).length === 0 ? [k] : leavesUnder(nodes, k.id)))
}

// The node to highlight: currentNode, or the first blocked leaf when only blocked work is
// left (currentNode returns null then).
const highlighted = (plan: Plan): PlanNode | null => {
  const current = currentNode(plan)
  if (current !== null) return current

  return plan.nodes.find(n => n.status === 'blocked' && childrenOf(plan.nodes, n.id).length === 0) ?? null
}

const nodeStyle = (status: PlanStatus): Omit<TreeLine, 'text'> => {
  switch (status) {
    case 'completed':
      return { color: 'green', bold: false, dim: true, inverse: false }
    case 'in_progress':
      return { color: 'cyan', bold: true, dim: false, inverse: false }
    case 'blocked':
      return { color: 'yellow', bold: false, dim: false, inverse: false }
    case 'skipped':
      return { bold: false, dim: true, inverse: false, strikethrough: true }
    case 'pending':
      return { bold: false, dim: false, inverse: false }
  }
}

type Row = { line: TreeLine; keep: boolean }

// Rows for `parentId`'s children, depth first. `prefix` carries the parent's pipes.
const rowsFor = (plan: Plan, parentId: string | null, prefix: string, currentId: string | null): Row[] => {
  const kids = plan.nodes.filter(n => n.parentId === parentId)
  const out: Row[] = []
  kids.forEach((node, i) => {
    const isLast = i === kids.length - 1
    const hasKids = childrenOf(plan.nodes, node.id).length > 0
    const isCurrent = node.id === currentId
    const isAncestor = currentId !== null && currentId.startsWith(`${node.id}.`)
    const collapse = hasKids && node.status === 'completed' && !isAncestor
    const lead = `${prefix}${isLast ? GLYPHS.last : GLYPHS.branch} ${GLYPHS[node.status]} ${node.id} ${node.title}`
    let text = lead
    if (collapse) {
      const under = leavesUnder(plan.nodes, node.id)
      text = `${lead} (${under.length}/${under.length})`
    } else if (node.note !== undefined && (node.status === 'blocked' || node.status === 'skipped')) {
      text = `${lead} (${node.status}: ${node.note})`
    } else if (node.note !== undefined) {
      text = `${lead} (${node.note})`
    } else if (node.status === 'blocked' || node.status === 'skipped') {
      text = `${lead} (${node.status})`
    }
    const style = nodeStyle(node.status)
    const line: TreeLine = isCurrent ? { ...style, text, bold: true, inverse: true, dim: false } : { ...style, text }
    out.push({ line, keep: isCurrent || isAncestor })
    if (hasKids && !collapse) {
      out.push(...rowsFor(plan, node.id, `${prefix}${isLast ? '   ' : `${GLYPHS.pipe}  `}`, currentId))
    }
  })

  return out
}

const activityLine = (activity: ActivityState): TreeLine => {
  const subs = activity.subagents.length > 0 ? ` · ${pluralSubagents(activity.subagents.length)}` : ''
  const text = `${activity.phase === 'idle' ? GLYPHS.pending : GLYPHS.in_progress} ${phaseLabel(activity)}${subs}`
  switch (activity.phase) {
    case 'idle':
      return { ...plain(text), dim: true }
    case 'permission':
    case 'question':
    case 'interrupted':
      return { ...plain(text), color: 'yellow' }
    case 'error':
      return { ...plain(text), color: 'red' }
    case 'working':
    case 'tool':
    case 'compacting':
      return { ...plain(text), color: 'cyan' }
  }
}

// Pane lines: header, activity line, then the tree. Past `maxLines` the path to the current
// node stays, other rows fill the remaining room in order, and "+N more" counts the hidden
// rows. maxLines below the header, activity line, path and "+N more" is raised to fit them.
export const buildTree = (plan: Plan, activity: ActivityState, opts: { maxLines: number }): TreeLine[] => {
  if (plan.nodes.length === 0) {
    const empty = plain('No plan yet.')

    return activity.phase === 'idle' && activity.subagents.length === 0
      ? [{ ...empty, dim: true }]
      : [{ ...empty, dim: true }, activityLine(activity)]
  }
  const { done, total } = progress(plan)
  const header: TreeLine = {
    ...plain(`${shorten(plan.title, MAX_HEADER_TITLE)} ${done}/${total} ${bar(done, total)} ${percent(done, total)}%`),
    bold: true,
  }
  const head = [header, activityLine(activity)]
  const rows = rowsFor(plan, null, '', highlighted(plan)?.id ?? null)
  const room = opts.maxLines - head.length
  if (rows.length <= room) return [...head, ...rows.map(r => r.line)]
  const mustKeep = rows.filter(r => r.keep).length
  const budget = Math.max(room - 1, mustKeep)
  let spare = budget - mustKeep
  const shown: TreeLine[] = []
  for (const row of rows) {
    if (row.keep) shown.push(row.line)
    else if (spare > 0) {
      shown.push(row.line)
      spare -= 1
    }
  }

  return [...head, ...shown, { ...plain(`+${rows.length - shown.length} more`), dim: true }]
}

// Status-line text, e.g. `Plan 3/7 · Escaping quotes · Waiting for permission: Bash`.
// Undefined with no plan and an idle session.
export const statusLine = (plan: Plan, activity: ActivityState): string | undefined => {
  const label = activity.phase === 'idle' ? undefined : phaseLabel(activity)
  if (plan.nodes.length === 0) return label
  const { done, total } = progress(plan)
  const node = highlighted(plan)
  const parts = [`Plan ${done}/${total}`]
  if (node !== null) parts.push(node.activeForm ?? node.title)
  if (label !== undefined) parts.push(label)

  return parts.join(' · ')
}
