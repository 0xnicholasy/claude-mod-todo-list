import { addNodes, MAX_DEPTH, MAX_NOTE, MAX_TITLE, progress, removeNode, setPlan, updateNodes } from './plan'
import type { NodeUpdate, Plan, PlanInputNode, PlanStatus } from './plan'
import { clean } from './sanitize'

export const PLAN_TOOL_SHORT_NAME = 'plan'

export const MAX_FORMAT_CHARS = 4000

export const PLAN_OPS = ['set', 'add', 'update', 'remove', 'show'] as const
export type PlanOpName = (typeof PLAN_OPS)[number]

const PLAN_STATUSES: readonly PlanStatus[] = ['pending', 'in_progress', 'completed', 'blocked', 'skipped']

export const PLAN_TOOL_DESCRIPTION = [
  'Keep a plan tree for the current task. Call op "set" once at the start of any task that needs tools, with a short title and the steps as nodes (children nest up to 3 levels).',
  'Keep exactly one leaf in_progress at a time, and mark each leaf completed with op "update" as soon as it is done.',
  'If a step cannot proceed or is dropped, set it to blocked or skipped and give a note that says why.',
  'Use op "add" to attach new subtasks under a node (or at the top level) when the work grows, op "remove" to drop a node and its subtree, and op "show" to read the current tree and ids.',
  'A parent node takes its status from its children, so only update leaves.',
].join(' ')

// unknown: a JSON Schema fragment is free-form JSON that the engine passes through untouched, so no narrower type exists.
type SchemaNode = Record<string, unknown>

// Written out level by level because the schema must not use $ref.
const nodeSchema = (levels: number): SchemaNode => {
  const properties: Record<string, SchemaNode> = {
    title: { type: 'string', description: `Short step title, at most ${MAX_TITLE} characters` },
    activeForm: { type: 'string', description: 'Present-tense form shown while the step runs, e.g. "Writing tests"' },
  }
  if (levels > 1) {
    properties.children = { type: 'array', description: 'Substeps', items: nodeSchema(levels - 1) }
  }

  return { type: 'object', properties, required: ['title'] }
}

// JSON Schema is open-ended data, hence the Record<string, unknown> shape the ToolSpec type itself uses.
export const PLAN_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    op: { type: 'string', enum: [...PLAN_OPS], description: 'What to do with the plan' },
    title: { type: 'string', description: 'Plan title (op set)' },
    nodes: { type: 'array', description: 'Steps to create (ops set and add)', items: nodeSchema(MAX_DEPTH) },
    parent: { type: 'string', description: 'Id of the node to add under, e.g. "2" or "2.1"; omit for the top level (op add)' },
    updates: {
      type: 'array',
      description: 'Patches to apply (op update)',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Node id, e.g. "2.1"' },
          status: { type: 'string', enum: [...PLAN_STATUSES], description: 'New status; leaves only' },
          title: { type: 'string', description: 'New title' },
          note: { type: 'string', description: `Why it is blocked or skipped, at most ${MAX_NOTE} characters; empty text clears it` },
        },
        required: ['id'],
      },
    },
    id: { type: 'string', description: 'Id of the node to remove, with its subtree (op remove)' },
  },
  required: ['op'],
}

export type PlanOp =
  | { op: 'set'; title: string; nodes: PlanInputNode[] }
  | { op: 'add'; parent: string | null; nodes: PlanInputNode[] }
  | { op: 'update'; updates: NodeUpdate[] }
  | { op: 'remove'; id: string }
  | { op: 'show' }

// Only ops that write the plan count as planning for the gate (D2). `show` is read-only, so it
// must not let the model bypass the gate on an empty plan.
export const touchesPlan = (op: PlanOp): boolean => op.op !== 'show'

export type ParsedPlanInput = { parsed: PlanOp } | { error: string }

export type PlanApplied = { plan: Plan; text: string } | { error: string }

const fail = (message: string): { error: string } => ({ error: `Error: ${message}` })

// tool.call arguments arrive as McpToolCallInputFallback (loose keys), so every field is checked here.
// unknown is genuinely needed: nothing about the model's JSON is known until it is narrowed.
type Raw = Record<string, unknown>

// unknown: type guard over untrusted model input.
const isRecord = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v)

// unknown: the value is read from untrusted model input and narrowed to string here.
const stringField = (obj: Raw, key: string, where: string): { value: string | undefined } | { error: string } => {
  const v = obj[key]
  if (v === undefined) return { value: undefined }
  if (typeof v !== 'string') return fail(`${where}${key} must be a string, got ${describe(v)}`)

  return { value: v }
}

// unknown: only reports the runtime type of untrusted model input in an error message.
const describe = (v: unknown): string => (v === null ? 'null' : Array.isArray(v) ? 'an array' : `a ${typeof v}`)

// unknown: nodes arrive as untrusted model input and are validated element by element.
const parseNodes = (raw: unknown, maxLevels: number, where: string, level = 1): { nodes: PlanInputNode[] } | { error: string } => {
  if (!Array.isArray(raw)) return fail(`${where} must be an array, got ${describe(raw)}`)
  const nodes: PlanInputNode[] = []
  for (const [i, item] of raw.entries()) {
    const at = `${where}[${i}]`
    if (!isRecord(item)) return fail(`${at} must be an object, got ${describe(item)}`)
    if (typeof item.title !== 'string') return fail(`${at}.title must be a string, got ${describe(item.title)}`)
    const node: PlanInputNode = { title: item.title }
    const form = stringField(item, 'activeForm', `${at}.`)
    if ('error' in form) return form
    if (form.value !== undefined) node.activeForm = form.value
    if (item.children !== undefined) {
      if (!Array.isArray(item.children)) return fail(`${at}.children must be an array, got ${describe(item.children)}`)
      if (item.children.length > 0) {
        if (level >= maxLevels) return fail(`${at}.children is too deep: the plan allows ${MAX_DEPTH} levels in total, depth ${level + 1} is not allowed here`)
        const kids = parseNodes(item.children, maxLevels, `${at}.children`, level + 1)
        if ('error' in kids) return kids
        node.children = kids.nodes
      }
    }
    nodes.push(node)
  }

  return { nodes }
}

// unknown: updates arrive as untrusted model input and are validated element by element.
const parseUpdates = (raw: unknown): { updates: NodeUpdate[] } | { error: string } => {
  if (!Array.isArray(raw)) return fail(`updates must be an array, got ${describe(raw)}`)
  const updates: NodeUpdate[] = []
  for (const [i, item] of raw.entries()) {
    const at = `updates[${i}]`
    if (!isRecord(item)) return fail(`${at} must be an object, got ${describe(item)}`)
    if (typeof item.id !== 'string') return fail(`${at}.id must be a string, got ${describe(item.id)}`)
    const update: NodeUpdate = { id: item.id }
    if (item.status !== undefined) {
      if (typeof item.status !== 'string') return fail(`${at}.status must be a string, got ${describe(item.status)}`)
      const status = PLAN_STATUSES.find(s => s === item.status)
      if (status === undefined) return fail(`${at}.status "${clean(item.status)}" is unknown; use ${PLAN_STATUSES.join(', ')}`)
      update.status = status
    }
    const title = stringField(item, 'title', `${at}.`)
    if ('error' in title) return title
    if (title.value !== undefined) update.title = title.value
    const note = stringField(item, 'note', `${at}.`)
    if ('error' in note) return note
    if (note.value !== undefined) update.note = note.value
    updates.push(update)
  }

  return { updates }
}

// unknown: raw is the loose tool.call input (McpToolCallInputFallback), validated here before any typed use.
export const parsePlanInput = (raw: unknown): ParsedPlanInput => {
  if (!isRecord(raw)) return fail(`the plan tool takes an object with an "op" field, got ${describe(raw)}`)
  if (raw.op === undefined) return fail(`missing "op"; use one of ${PLAN_OPS.join(', ')}`)
  if (typeof raw.op !== 'string') return fail(`"op" must be a string, got ${describe(raw.op)}`)
  const op = PLAN_OPS.find(o => o === raw.op)
  if (op === undefined) return fail(`unknown op "${clean(raw.op)}"; use one of ${PLAN_OPS.join(', ')}`)

  switch (op) {
    case 'set': {
      if (typeof raw.title !== 'string') return fail(`op set needs a "title" string, got ${describe(raw.title)}`)
      if (raw.nodes === undefined) return fail('op set needs "nodes"')
      const made = parseNodes(raw.nodes, MAX_DEPTH, 'nodes')
      if ('error' in made) return made

      return { parsed: { op, title: raw.title, nodes: made.nodes } }
    }
    case 'add': {
      if (raw.nodes === undefined) return fail('op add needs "nodes"')
      const parent = stringField(raw, 'parent', '')
      if ('error' in parent) return parent
      const parentId = parent.value === undefined || parent.value === '' ? null : parent.value
      // A parent at depth 2 leaves one level for the new nodes.
      const room = parentId === null ? MAX_DEPTH : MAX_DEPTH - parentId.split('.').length
      if (room < 1) return fail(`"${clean(parentId ?? '')}" is already at depth ${MAX_DEPTH}; add under a shallower node`)
      const made = parseNodes(raw.nodes, room, 'nodes')
      if ('error' in made) return made

      return { parsed: { op, parent: parentId, nodes: made.nodes } }
    }
    case 'update': {
      if (raw.updates === undefined) return fail('op update needs "updates"')
      const made = parseUpdates(raw.updates)
      if ('error' in made) return made

      return { parsed: { op, updates: made.updates } }
    }
    case 'remove': {
      if (typeof raw.id !== 'string') return fail(`op remove needs an "id" string, got ${describe(raw.id)}`)

      return { parsed: { op, id: raw.id } }
    }
    case 'show':
      return { parsed: { op } }
  }
}

const STATUS_WORD: Record<PlanStatus, string> = {
  pending: 'pending',
  in_progress: 'in_progress',
  completed: 'completed',
  blocked: 'blocked',
  skipped: 'skipped',
}

// Plain text, one node per line, indented by depth: `2.1 [in_progress] Title (note)`. No ANSI, capped.
export const formatForModel = (plan: Plan): string => {
  if (plan.nodes.length === 0) return 'No plan yet. Call op "set" with a title and nodes to create one.'
  const { done, total } = progress(plan)
  const head = `Plan: ${clean(plan.title)} (${done}/${total} done)`
  const lines = plan.nodes.map(n => {
    const note = n.note === undefined ? '' : ` (${clean(n.note)})`

    return `${'  '.repeat(n.id.split('.').length - 1)}${n.id} [${STATUS_WORD[n.status]}] ${clean(n.title)}${note}`
  })
  const out = [head]
  let size = head.length
  for (const [i, line] of lines.entries()) {
    const left = lines.length - i
    const tail = `\n... ${left} more nodes not shown; use op "show" after removing finished nodes`
    const fits = left === 1 ? size + 1 + line.length <= MAX_FORMAT_CHARS : size + 1 + line.length + tail.length <= MAX_FORMAT_CHARS
    if (!fits) {
      out.push(tail.slice(1))

      return out.join('\n').slice(0, MAX_FORMAT_CHARS)
    }
    out.push(line)
    size += 1 + line.length
  }

  return out.join('\n').slice(0, MAX_FORMAT_CHARS)
}

export const applyPlanOp = (plan: Plan, op: PlanOp, now: number): PlanApplied => {
  if (op.op === 'show') return { plan, text: formatForModel(plan) }
  const result =
    op.op === 'set'
      ? setPlan(plan, op.title, op.nodes, now)
      : op.op === 'add'
        ? addNodes(plan, op.parent, op.nodes, now)
        : op.op === 'update'
          ? updateNodes(plan, op.updates, now)
          : removeNode(plan, op.id, now)
  if ('error' in result) return fail(result.error)

  return { plan: result.plan, text: formatForModel(result.plan) }
}
