// Pure plan-tree logic: reducers, rollup, progress and the current node.
// No `$` here: register.tsx reads and writes the atoms and passes plain data in.
//
// Shape: the plan is a flat node list with `parentId` and stable path ids ("2", "2.1", "2.1.3").
// The list is always kept in tree (pre-order) order. Every op returns `{ plan } | { error }`
// and never throws; an op that fails changes nothing.
import type { Plan, PlanNode, PlanStatus } from '../types'
import { clean } from './sanitize'

export type { Plan, PlanNode, PlanStatus }

export const MAX_DEPTH = 3
export const MAX_NODES = 60
export const MAX_TITLE = 120
export const MAX_NOTE = 200

// setPlan and addNodes take nested input: { title, activeForm?, children? }. It becomes flat
// nodes whose ids are paths ("1", "1.1", "1.1.1") handed out in input order. The plan tool
// parser (T03) turns tool input into this shape.
export type PlanInputNode = { title: string; activeForm?: string; children?: PlanInputNode[] }

export type NodeUpdate = { id: string; status?: PlanStatus; title?: string; note?: string }

export type PlanResult = { plan: Plan } | { error: string }

export const emptyPlan = (): Plan => ({ title: '', nodes: [], issued: [] })

const STATUSES: readonly PlanStatus[] = ['pending', 'in_progress', 'completed', 'blocked', 'skipped']

const depthOf = (id: string): number => id.split('.').length

// Numeric path order, so "2" < "2.1" < "2.10" < "10".
const compareIds = (a: string, b: string): number => {
  const x = a.split('.')
  const y = b.split('.')
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = Number(x[i]) - Number(y[i])
    if (d !== 0 && !Number.isNaN(d)) return d
  }

  return x.length - y.length
}

const sortNodes = (nodes: PlanNode[]): PlanNode[] => [...nodes].sort((a, b) => compareIds(a.id, b.id))

const childrenOf = (nodes: readonly PlanNode[], id: string): PlanNode[] =>
  nodes.filter(n => n.parentId === id)

const isLeaf = (nodes: readonly PlanNode[], id: string): boolean => !nodes.some(n => n.parentId === id)

const leaves = (plan: Plan): PlanNode[] => plan.nodes.filter(n => isLeaf(plan.nodes, n.id))

const validIds = (plan: Plan): string =>
  plan.nodes.length === 0 ? 'the plan has no nodes' : `valid ids: ${plan.nodes.map(n => n.id).join(', ')}`

// Cleans a title or form and checks the length limit. Returns the text or an error.
const checkText = (label: string, raw: string, max: number, allowEmpty: boolean): { text: string } | { error: string } => {
  if (typeof raw !== 'string') return { error: `${label} must be text` }
  const text = clean(raw)
  if (text === '' && !allowEmpty) return { error: `${label} is empty` }
  if (text.length > max) return { error: `${label} is ${text.length} characters, the limit is ${max}` }

  return { text }
}

// Counters of issued child numbers, keyed by parent id ('' is the top level).
const toCounters = (plan: Plan): Map<string, number> => {
  const counters = new Map<string, number>()
  for (const c of plan.issued) counters.set(c.parent, c.last)
  // Nodes that exist always count, in case `issued` was never written for them.
  for (const n of plan.nodes) {
    const key = n.parentId ?? ''
    const last = Number(n.id.split('.').pop())
    if (!Number.isNaN(last) && last > (counters.get(key) ?? 0)) counters.set(key, last)
  }

  return counters
}

const fromCounters = (counters: Map<string, number>): Plan['issued'] =>
  [...counters.entries()].map(([parent, last]) => ({ parent, last }))

// Flattens nested input under `parentId`, issuing ids from `counters`. `depth` is the depth of
// the nodes being created. Returns the new nodes or an error.
const flatten = (
  input: readonly PlanInputNode[],
  parentId: string | null,
  depth: number,
  counters: Map<string, number>,
  now: number,
): { nodes: PlanNode[] } | { error: string } => {
  if (depth > MAX_DEPTH) return { error: `the tree is deeper than ${MAX_DEPTH} levels` }
  const out: PlanNode[] = []
  for (const item of input) {
    const title = checkText('node title', item.title, MAX_TITLE, false)
    if ('error' in title) return title
    const key = parentId ?? ''
    const last = (counters.get(key) ?? 0) + 1
    counters.set(key, last)
    const id = parentId === null ? `${last}` : `${parentId}.${last}`
    const node: PlanNode = { id, parentId, title: title.text, status: 'pending', source: 'plan', updatedAt: now }
    if (item.activeForm !== undefined) {
      const form = checkText('activeForm', item.activeForm, MAX_TITLE, true)
      if ('error' in form) return form
      if (form.text !== '') node.activeForm = form.text
    }
    out.push(node)
    if (item.children !== undefined && item.children.length > 0) {
      const kids = flatten(item.children, id, depth + 1, counters, now)
      if ('error' in kids) return kids
      out.push(...kids.nodes)
    }
  }

  return { nodes: out }
}

// Parents' stored status is derived from their children after every op; leaves are set
// directly. Rules, per parent from the bottom up:
//   any child in_progress                  -> in_progress
//   any child blocked (none in_progress)   -> blocked
//   every child completed or skipped       -> completed
//   some child completed or skipped        -> in_progress (work has started)
//   otherwise                              -> pending
// A parent whose status changes gets updatedAt = now.
export const rollup = (plan: Plan, now: number): Plan => {
  const nodes = plan.nodes.map(n => ({ ...n }))
  const byId = new Map(nodes.map(n => [n.id, n]))
  const parents = nodes.filter(n => !isLeaf(nodes, n.id)).sort((a, b) => depthOf(b.id) - depthOf(a.id))
  for (const parent of parents) {
    const kids = childrenOf(nodes, parent.id).map(k => byId.get(k.id)?.status ?? k.status)
    let status: PlanStatus
    if (kids.includes('in_progress')) status = 'in_progress'
    else if (kids.includes('blocked')) status = 'blocked'
    else if (kids.every(s => s === 'completed' || s === 'skipped')) status = 'completed'
    else if (kids.some(s => s === 'completed' || s === 'skipped')) status = 'in_progress'
    else status = 'pending'
    if (parent.status !== status) {
      parent.status = status
      parent.updatedAt = now
    }
  }

  return { ...plan, nodes }
}

// Wraps an op so a bad input shape can never throw out of the hook.
const safe = (op: () => PlanResult): PlanResult => {
  try {
    return op()
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'invalid plan input' }
  }
}

// Replaces the source:'plan' nodes with `input`. Nodes from TodoWrite or Task* (other sources)
// stay, and new top-level ids start after the highest kept top-level id. A fresh set restarts
// numbering, because the model sees the whole new tree in the result.
export const setPlan = (prev: Plan, title: string, input: readonly PlanInputNode[], now: number): PlanResult =>
  safe(() => {
    const t = checkText('plan title', title, MAX_TITLE, false)
    if ('error' in t) return t
    if (input.length === 0) return { error: 'the plan has no nodes' }
    const kept = prev.nodes.filter(n => n.source !== 'plan')
    const counters = toCounters({ title: prev.title, nodes: kept, issued: [] })
    const made = flatten(input, null, 1, counters, now)
    if ('error' in made) return made
    const nodes = [...kept, ...made.nodes]
    if (nodes.length > MAX_NODES) return { error: `the plan would have ${nodes.length} nodes, the limit is ${MAX_NODES}` }

    return { plan: rollup({ title: t.text, nodes: sortNodes(nodes), issued: fromCounters(counters) }, now) }
  })

// Appends nodes under `parentId` (top level when null). A new id is one more than both the
// highest existing sibling and any id ever issued under that parent, so a removed id is not reused.
export const addNodes = (prev: Plan, parentId: string | null, input: readonly PlanInputNode[], now: number): PlanResult =>
  safe(() => {
    if (input.length === 0) return { error: 'no nodes to add' }
    if (parentId !== null && !prev.nodes.some(n => n.id === parentId)) {
      return { error: `unknown parent "${clean(String(parentId))}"; ${validIds(prev)}` }
    }
    const counters = toCounters(prev)
    const made = flatten(input, parentId, parentId === null ? 1 : depthOf(parentId) + 1, counters, now)
    if ('error' in made) return made
    const nodes = [...prev.nodes, ...made.nodes]
    if (nodes.length > MAX_NODES) return { error: `the plan would have ${nodes.length} nodes, the limit is ${MAX_NODES}` }

    return { plan: rollup({ ...prev, nodes: sortNodes(nodes), issued: fromCounters(counters) }, now) }
  })

// Batch patch: all updates apply or none. Status can only be set on a leaf (a parent's status
// is derived). `note: ''` clears the note.
export const updateNodes = (prev: Plan, updates: readonly NodeUpdate[], now: number): PlanResult =>
  safe(() => {
    if (updates.length === 0) return { error: 'no updates given' }
    const nodes = prev.nodes.map(n => ({ ...n }))
    for (const u of updates) {
      const node = nodes.find(n => n.id === u.id)
      if (node === undefined) return { error: `unknown id "${clean(String(u.id))}"; ${validIds(prev)}` }
      if (u.status !== undefined) {
        if (!STATUSES.includes(u.status)) return { error: `unknown status "${clean(String(u.status))}"; use ${STATUSES.join(', ')}` }
        if (!isLeaf(nodes, node.id)) return { error: `"${node.id}" has children, so its status comes from them; update a leaf` }
        node.status = u.status
      }
      if (u.title !== undefined) {
        const t = checkText('node title', u.title, MAX_TITLE, false)
        if ('error' in t) return t
        node.title = t.text
      }
      if (u.note !== undefined) {
        const n = checkText('note', u.note, MAX_NOTE, true)
        if ('error' in n) return n
        if (n.text === '') delete node.note
        else node.note = n.text
      }
      node.updatedAt = now
    }

    return { plan: rollup({ ...prev, nodes }, now) }
  })

// Drops a node and its subtree. Ids already issued stay recorded, so they are never reused.
export const removeNode = (prev: Plan, id: string, now: number): PlanResult =>
  safe(() => {
    if (!prev.nodes.some(n => n.id === id)) return { error: `unknown id "${clean(String(id))}"; ${validIds(prev)}` }
    const nodes = prev.nodes.filter(n => n.id !== id && !n.id.startsWith(`${id}.`))
    // Counters of the removed subtree go with it: its parent ids are never issued again.
    const issued = prev.issued.filter(c => c.parent !== id && !c.parent.startsWith(`${id}.`))
    // A parent left without children becomes a leaf: its derived status is stale, so restart it.
    const parent = prev.nodes.find(n => n.id === id)?.parentId ?? null
    if (parent !== null && isLeaf(nodes, parent)) {
      return { plan: rollup({ ...prev, nodes: nodes.map(n => (n.id === parent ? { ...n, status: 'pending', updatedAt: now } : n)), issued }, now) }
    }

    return { plan: rollup({ ...prev, nodes, issued }, now) }
  })

// Counts leaves. Skipped leaves count as done (finished), so a plan with a skipped step can
// still reach 100%.
export const progress = (plan: Plan): { done: number; total: number } => {
  const all = leaves(plan)

  return { done: all.filter(n => n.status === 'completed' || n.status === 'skipped').length, total: all.length }
}

// The node Claude is working on: the first in_progress leaf in tree order, else the first
// pending leaf, else null.
export const currentNode = (plan: Plan): PlanNode | null => {
  const all = leaves(plan)

  return all.find(n => n.status === 'in_progress') ?? all.find(n => n.status === 'pending') ?? null
}

// True while any leaf is pending, in_progress or blocked (blocked work is still open).
export const hasUnfinished = (plan: Plan): boolean =>
  leaves(plan).some(n => n.status === 'pending' || n.status === 'in_progress' || n.status === 'blocked')
