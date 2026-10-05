import type { ActivityState, Plan, PlanNode, PlanStatus } from '../types'
import { activityLabel } from './activity'
import { currentNode, progress } from './plan'

export const GLYPHS = {
  completed: '✓',
  in_progress: '◉',
  pending: '○',
  blocked: '■',
  skipped: '–',
  branch: '├─',
  last: '└─',
  pipe: '│',
  filled: '━',
  track: '─',
  marker: '◂',
} as const

export const DEFAULT_WIDTH = 48
export const DEFAULT_ACCENT = 'cyan'
const STATUS_TITLE_MAX = 30

// One run of text with one style. A row is a list of these so ids, connectors and titles
// can be styled apart. There is deliberately no inverse or background field.
export type Seg = {
  text: string
  color?: string
  bold: boolean
  dim: boolean
  strikethrough?: boolean
}

export type TreeLine = {
  // The segments joined: what the row reads as without colour.
  text: string
  segments: Seg[]
}

export type TreeOptions = { maxLines: number; width?: number; accent?: string }

const seg = (text: string, over: Partial<Seg> = {}): Seg => ({ text, bold: false, dim: false, ...over })
const dimSeg = (text: string): Seg => seg(text, { dim: true })
const lineOf = (segments: Seg[]): TreeLine => ({ text: segments.map(s => s.text).join(''), segments })
const blank = (): TreeLine => lineOf([seg('')])

const percent = (done: number, total: number): number => (total === 0 ? 0 : Math.round((done / total) * 100))

const shorten = (text: string, max: number): string => {
  if (text.length <= max) return text

  return max <= 1 ? '…' : `${text.slice(0, max - 1)}…`
}

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n))

const bar = (done: number, total: number, accent: string, width: number): Seg[] => {
  const cells = clamp(width - 16, 10, 40)
  const filled = total === 0 ? 0 : Math.round((done / total) * cells)

  return [
    seg(GLYPHS.filled.repeat(filled), { color: accent }),
    dimSeg(GLYPHS.track.repeat(cells - filled)),
    seg('  '),
    dimSeg(`${done}/${total} · ${percent(done, total)}%`),
  ]
}

const childrenOf = (nodes: readonly PlanNode[], id: string): PlanNode[] => nodes.filter(n => n.parentId === id)

const leavesUnder = (nodes: readonly PlanNode[], id: string): PlanNode[] => {
  const kids = childrenOf(nodes, id)

  return kids.length === 0 ? [] : kids.flatMap(k => (childrenOf(nodes, k.id).length === 0 ? [k] : leavesUnder(nodes, k.id)))
}

const countUnder = (nodes: readonly PlanNode[], id: string): string => {
  const under = leavesUnder(nodes, id)
  const done = under.filter(n => n.status === 'completed' || n.status === 'skipped').length

  return `${done}/${under.length}`
}

const highlighted = (plan: Plan): PlanNode | null => {
  const current = currentNode(plan)
  if (current !== null) return current

  return plan.nodes.find(n => n.status === 'blocked' && childrenOf(plan.nodes, n.id).length === 0) ?? null
}

const glyphStyle = (status: PlanStatus, accent: string): Partial<Seg> => {
  switch (status) {
    case 'completed':
      return { color: 'green' }
    case 'in_progress':
      return { color: accent }
    case 'blocked':
      return { color: 'yellow' }
    case 'skipped':
      return { dim: true }
    case 'pending':
      return {}
  }
}

const noteOf = (node: PlanNode): string => {
  if (node.note !== undefined) {
    return node.status === 'blocked' || node.status === 'skipped' ? ` (${node.status}: ${node.note})` : ` (${node.note})`
  }

  return node.status === 'blocked' || node.status === 'skipped' ? ` (${node.status})` : ''
}

type Row = { line: TreeLine; keep: boolean }

type Ctx = { plan: Plan; currentId: string | null; accent: string; width: number }

const rowFor = (ctx: Ctx, node: PlanNode, lead: string, hasKids: boolean, collapse: boolean): TreeLine => {
  const { plan, currentId, accent, width } = ctx
  const isCurrent = node.id === currentId
  const count = hasKids ? countUnder(plan.nodes, node.id) : null
  const note = collapse ? '' : noteOf(node)
  const marker = isCurrent ? ` ${GLYPHS.marker}` : ''
  const fixed = lead.length + 2 + node.id.length + 1 + note.length + marker.length + (count === null ? 0 : count.length + 1)
  const title = shorten(node.title, Math.max(1, width - fixed))
  let titleSeg: Seg
  let glyphSeg: Seg
  if (collapse) {
    titleSeg = dimSeg(title)
    glyphSeg = dimSeg(GLYPHS[node.status])
  } else {
    glyphSeg = seg(GLYPHS[node.status], glyphStyle(node.status, accent))
    if (isCurrent) titleSeg = seg(title, { color: accent, bold: true })
    else if (hasKids) titleSeg = seg(title, { bold: true })
    else if (node.status === 'completed') titleSeg = dimSeg(title)
    else if (node.status === 'in_progress') titleSeg = seg(title, { bold: true })
    else if (node.status === 'skipped') titleSeg = seg(title, { dim: true, strikethrough: true })
    else titleSeg = seg(title)
  }
  const segs: Seg[] = [dimSeg(lead), glyphSeg, seg(' '), dimSeg(node.id), seg(' '), titleSeg]
  if (note !== '') segs.push(dimSeg(note))
  if (marker !== '') segs.push(dimSeg(marker))
  if (count !== null) {
    const used = segs.reduce((n, s) => n + s.text.length, 0)
    segs.push(seg(' '.repeat(Math.max(1, width - used - count.length))), dimSeg(count))
  }

  return lineOf(segs)
}

const rowsFor = (ctx: Ctx, parentId: string | null, prefix: string): Row[] => {
  const { plan, currentId } = ctx
  const kids = plan.nodes.filter(n => n.parentId === parentId)
  const out: Row[] = []
  kids.forEach((node, i) => {
    const isLast = i === kids.length - 1
    const hasKids = childrenOf(plan.nodes, node.id).length > 0
    const isCurrent = node.id === currentId
    const isAncestor = currentId !== null && currentId.startsWith(`${node.id}.`)
    const collapse = hasKids && node.status === 'completed' && !isAncestor
    const lead = `${prefix}${isLast ? GLYPHS.last : GLYPHS.branch} `
    out.push({ line: rowFor(ctx, node, lead, hasKids, collapse), keep: isCurrent || isAncestor })
    if (hasKids && !collapse) {
      out.push(...rowsFor(ctx, node.id, `${prefix}${isLast ? '   ' : `${GLYPHS.pipe}  `}`))
    }
  })

  return out
}

const activityLine = (activity: ActivityState, accent: string): TreeLine | null => {
  const label = activityLabel(activity)
  if (label === undefined) return null
  const text = `${GLYPHS.in_progress} ${label}`
  switch (activity.phase) {
    case 'permission':
    case 'question':
      return lineOf([seg(text, { color: 'yellow' })])
    case 'error':
      return lineOf([seg(text, { color: 'red' })])
    case 'interrupted':
      return lineOf([dimSeg(text)])
    case 'idle':
      return lineOf([dimSeg(`${GLYPHS.pending} ${label}`)])
    case 'working':
    case 'tool':
    case 'compacting':
      return lineOf([seg(text, { color: accent })])
  }
}

export const buildTree = (plan: Plan, activity: ActivityState, opts: TreeOptions): TreeLine[] => {
  const width = opts.width ?? DEFAULT_WIDTH
  const accent = opts.accent ?? DEFAULT_ACCENT
  const act = activityLine(activity, accent)
  if (plan.nodes.length === 0) {
    const empty = lineOf([dimSeg('No plan yet.')])

    return act === null ? [empty] : [empty, act]
  }
  const { done, total } = progress(plan)
  const head: TreeLine[] = [
    lineOf([seg(shorten(plan.title, width), { bold: true })]),
    lineOf(bar(done, total, accent, width)),
  ]
  if (act !== null) head.push(act)
  head.push(blank())
  const rows = rowsFor({ plan, currentId: highlighted(plan)?.id ?? null, accent, width }, null, '')
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

  return [...head, ...shown, lineOf([dimSeg(`+${rows.length - shown.length} more`)])]
}

export const statusLine = (plan: Plan, activity: ActivityState): string | undefined => {
  const label = activityLabel(activity)
  if (plan.nodes.length === 0) return label
  const { done, total } = progress(plan)
  const node = highlighted(plan)
  const parts = [`Plan ${done}/${total}`]
  if (node !== null) parts.push(shorten(node.activeForm ?? node.title, STATUS_TITLE_MAX))
  if (label !== undefined) parts.push(label)

  return parts.join(' · ')
}
