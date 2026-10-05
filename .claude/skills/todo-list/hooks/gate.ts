import type { Plan, TaskState } from '../types'
import { hasUnfinished } from './plan'

export type { Plan, TaskState }

// D6: main-loop tools that change state. Everything else is allowed, including third-party MCP tools.
export const BLOCKED_TOOLS: ReadonlySet<string> = new Set([
  'Edit',
  'Write',
  'NotebookEdit',
  'Bash',
  'Agent',
  'Workflow',
  'CronCreate',
  'CronDelete',
  'EnterWorktree',
  'ExitWorktree',
  'RemoteTrigger',
])

export const MAX_DENIES = 3

export type GateInput = {
  tool: string
  agentId?: string
  isPlanTool: boolean
  planToolName: string
  enforceConfig: boolean
  enforceSession: boolean
  toolRegistered: boolean
  toolOffered: boolean
  planned: boolean
  denies: number
}

export type GateDecision =
  | { kind: 'allow' }
  | { kind: 'deny'; message: string }
  | { kind: 'pause'; toast: string }

export const PAUSE_TOAST = 'Plan enforcement paused for this turn'

// Follows the gate algorithm in docs/plan-tree/plan.md. `planToolName` is the full registered
// plan-tool name, used only in the deny text.
export const decideGate = (input: GateInput): GateDecision => {
  if (input.agentId !== undefined && input.agentId !== '') return { kind: 'allow' }
  if (!BLOCKED_TOOLS.has(input.tool) || input.isPlanTool) return { kind: 'allow' }
  if (!input.enforceConfig || !input.enforceSession || !input.toolRegistered || !input.toolOffered) {
    return { kind: 'allow' }
  }
  if (input.planned) return { kind: 'allow' }
  if (input.denies >= MAX_DENIES) return { kind: 'pause', toast: PAUSE_TOAST }

  return { kind: 'deny', message: denyText(input.tool, input.planToolName) }
}

// D7 as revised: empty text and background-agent completions are continuations and change nothing.
export const onNewPrompt = (task: TaskState, plan: Plan, text: string): TaskState => {
  if (text.trim() === '' || text.startsWith('<task-notification>')) return task

  return { open: true, planned: hasUnfinished(plan), denies: 0 }
}

export const onPlanTouched = (task: TaskState): TaskState => ({ ...task, planned: true })

export const INSTRUCTION_ID = 'todo-list:plan'

export const INSTRUCTION_TEXT = (toolName: string): string =>
  `Plan tree: before using any tool other than read-only ones, create a plan with the ${toolName} tool (op "set"). ` +
  'Before creating the plan, find steps that do not conflict (different files, independent research, separate subagents) and put them under one parent with "parallel": true, then run them concurrently (for example several Agent calls in one message). Outside a parallel group keep exactly one leaf in_progress. Mark each leaf completed immediately when it is done. ' +
  'Use blocked or skipped with a note when a leaf cannot or need not be done. ' +
  'When a requirement is unclear, ask with AskUserQuestion and mark the affected node blocked with the question as the note. ' +
  'Pure Q&A needs no plan. ' +
  `If the tool is not loaded, load it first with ToolSearch (query "select:${toolName}").`

// Sent with each new prompt (D12). `format` renders the tree; without it the ids and statuses are listed.
// Returns undefined for an empty plan.
export const planContext = (
  plan: Plan,
  toolName: string,
  format?: (plan: Plan) => string,
): string | undefined => {
  if (plan.nodes.length === 0) return undefined
  const body = format !== undefined ? format(plan) : plan.nodes.map(n => `${n.id} ${n.status}`).join(', ')

  return `Current plan (update it with ${toolName}):\n${body}`
}

export const denyText = (tool: string, toolName: string): string =>
  `Blocked ${tool}: there is no plan for this task yet. ` +
  `Call ${toolName} with {"op":"set","title":"<task>","nodes":[{"title":"<step>"}]} first, then retry ${tool}. ` +
  `If the tool is not loaded, load it first with ToolSearch (query "select:${toolName}").`
