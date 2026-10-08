import type { TaskCreateInput, TaskUpdateInput, TodoInput } from './ingest'

// Narrows the tool_input and tool_response of a finished TaskCreate, TaskUpdate or TodoWrite call
// to what ingest.ts takes. The host types both fields `unknown`, so every field is checked here
// and a bad shape gives null: the caller logs it and mirrors nothing.

type Dict = Record<string, unknown>

// `unknown` is justified: the host hands the tool's input and response over untyped.
const isDict = (value: unknown): value is Dict => typeof value === 'object' && value !== null && !Array.isArray(value)

const isText = (value: unknown): value is string => typeof value === 'string'

// Task ids arrive as strings; a number is accepted and kept as text.
const idText = (value: unknown): string | undefined =>
  isText(value) && value !== '' ? value : typeof value === 'number' ? String(value) : undefined

const TASK_STATUSES: readonly string[] = ['pending', 'in_progress', 'completed', 'deleted']
const TODO_STATUSES: readonly string[] = ['pending', 'in_progress', 'completed']

export const taskCreateFrom = (input: unknown, response: unknown): TaskCreateInput | null => {
  if (!isDict(input) || !isDict(response) || !isDict(response.task)) return null
  const id = idText(response.task.id)
  if (id === undefined || !isText(input.subject)) return null
  const out: TaskCreateInput = { id, subject: input.subject }
  if (isText(input.activeForm)) out.activeForm = input.activeForm

  return out
}

// Only a call the tool reported as successful (`success: true`) counts.
export const taskUpdateFrom = (input: unknown, response: unknown): TaskUpdateInput | null => {
  if (!isDict(input) || !isDict(response) || response.success !== true) return null
  const taskId = idText(input.taskId)
  if (taskId === undefined) return null
  const out: TaskUpdateInput = { taskId }
  if (isText(input.subject)) out.subject = input.subject
  if (isText(input.activeForm)) out.activeForm = input.activeForm
  if (input.status !== undefined) {
    if (!isText(input.status) || !TASK_STATUSES.includes(input.status)) return null
    out.status = input.status as TaskUpdateInput['status']
  }

  return out
}

const todoList = (value: unknown): TodoInput[] | null => {
  if (!Array.isArray(value)) return null
  const out: TodoInput[] = []
  for (const item of value as unknown[]) {
    if (!isDict(item) || !isText(item.content) || !isText(item.status) || !TODO_STATUSES.includes(item.status)) return null
    const todo: TodoInput = { content: item.content, status: item.status as TodoInput['status'] }
    if (isText(item.activeForm)) todo.activeForm = item.activeForm
    out.push(todo)
  }

  return out
}

// The list the tool stored (`newTodos`), else the list the call sent.
export const todosFrom = (input: unknown, response: unknown): TodoInput[] | null =>
  (isDict(response) ? todoList(response.newTodos) : null) ?? (isDict(input) ? todoList(input.todos) : null)
