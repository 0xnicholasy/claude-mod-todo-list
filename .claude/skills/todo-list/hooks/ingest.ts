import type { Plan, PlanNode, PlanResult, PlanStatus } from './plan'
import { checkText, fromCounters, MAX_NODES, MAX_TITLE, removeNode, rollup, sortNodes, toCounters } from './plan'
import type { PlanSource } from '../types'
import { clean } from './sanitize'

// Mirrors of the TaskCreate, TaskUpdate and TodoWrite tools into the plan. Pure: the caller
// applies a result only after the tool call succeeded. Mirrored nodes are top-level leaves
// tagged with their source, so a plan `set` (which replaces only source 'plan') keeps them.

export type TaskCreateInput = { id: string; subject: string; activeForm?: string }
export type TaskUpdateInput = {
  taskId: string
  subject?: string
  activeForm?: string
  status?: PlanStatus | 'deleted'
}
export type TodoInput = { content: string; status: 'pending' | 'in_progress' | 'completed'; activeForm?: string }

// A call the mirror recognised but has nothing to apply: not an error, so no failure log or toast.
// Reasons are fixed strings with no user content in them.
export type Ignored = { ignored: string }
export type IngestResult = PlanResult | Ignored
export const IGNORED_UNKNOWN_TASK = 'task id not in the plan'

// Why a mirror was dropped, as shown in the once-per-session toast. Fixed strings: they must never
// carry the subject, a title or the ingest error text, which can hold user content.
export const DROPPED_NOT_MIRRORED = 'a task was not mirrored to the plan'
export const DROPPED_UNRECOGNISED = 'a task response was not recognised, so it was not mirrored'

type NewLeaf = { title: string; activeForm?: string; status: PlanStatus; externalId?: string }

const withSource = (plan: Plan, source: PlanSource, leaves: readonly NewLeaf[], now: number, kept: PlanNode[]): PlanResult => {
  const counters = toCounters({ title: plan.title, nodes: plan.nodes, issued: plan.issued })
  const made: PlanNode[] = []
  for (const leaf of leaves) {
    const title = checkText('title', leaf.title, MAX_TITLE, false)
    if ('error' in title) return title
    const last = (counters.get('') ?? 0) + 1
    counters.set('', last)
    const node: PlanNode = { id: `${last}`, parentId: null, title: title.text, status: leaf.status, source, updatedAt: now }
    if (leaf.externalId !== undefined) node.externalId = leaf.externalId
    if (leaf.activeForm !== undefined) {
      const form = checkText('activeForm', leaf.activeForm, MAX_TITLE, true)
      if ('error' in form) return form
      if (form.text !== '') node.activeForm = form.text
    }
    made.push(node)
  }
  const nodes = [...kept, ...made]
  if (nodes.length > MAX_NODES) return { error: `the plan would have ${nodes.length} nodes, the limit is ${MAX_NODES}` }

  return { plan: rollup({ ...plan, nodes: sortNodes(nodes), issued: fromCounters(counters) }, now) }
}

const findTask = (plan: Plan, externalId: string): PlanNode | undefined =>
  plan.nodes.find(n => n.source === 'task' && n.externalId === externalId)

export const ingestTaskCreate = (plan: Plan, input: TaskCreateInput, now: number): PlanResult => {
  const externalId = checkText('task id', String(input.id), MAX_TITLE, false)
  if ('error' in externalId) return externalId
  if (findTask(plan, externalId.text) !== undefined) return { plan }

  return withSource(plan, 'task', [{ title: input.subject, activeForm: input.activeForm, status: 'pending', externalId: externalId.text }], now, plan.nodes)
}

export const ingestTaskUpdate = (plan: Plan, input: TaskUpdateInput, now: number): IngestResult => {
  const node = findTask(plan, clean(String(input.taskId)))
  if (node === undefined) return { ignored: IGNORED_UNKNOWN_TASK }
  if (input.status === 'deleted') return removeNode(plan, node.id, now)
  const next: PlanNode = { ...node, updatedAt: now }
  if (input.subject !== undefined) {
    const title = checkText('title', input.subject, MAX_TITLE, false)
    if ('error' in title) return title
    next.title = title.text
  }
  if (input.activeForm !== undefined) {
    const form = checkText('activeForm', input.activeForm, MAX_TITLE, true)
    if ('error' in form) return form
    if (form.text === '') delete next.activeForm
    else next.activeForm = form.text
  }
  if (input.status !== undefined) next.status = input.status

  return { plan: rollup({ ...plan, nodes: plan.nodes.map(n => (n.id === node.id ? next : n)) }, now) }
}

// TodoWrite sends the whole list each time: replace the source 'todo' leaves, keep the rest.
export const ingestTodoWrite = (plan: Plan, todos: readonly TodoInput[], now: number): PlanResult =>
  withSource(
    plan,
    'todo',
    todos.map(t => ({ title: t.content, activeForm: t.activeForm, status: t.status })),
    now,
    plan.nodes.filter(n => n.source !== 'todo'),
  )
