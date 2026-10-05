// Pure todo logic: the list reducers, progress math, pane lines and the nudge decision.
// No `$` here: register.tsx reads and writes the atoms and passes plain data in.
import type { TodoItem, TodoStatus } from '../types'

export type { TodoItem, TodoStatus }

export type TodoInput = { content: string; status: TodoStatus; activeForm?: string }

export type TaskUpdateInput = {
  taskId: string
  subject?: string
  activeForm?: string
  status?: TodoStatus | 'deleted'
}

// Subjects and forms come from the model: a control character would reach the terminal
// (escape injection), so each becomes a space.
// Control characters become spaces; bidi and zero-width characters are dropped.
export const clean = (s: string): string =>
  s
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim()

// TodoWrite replaces the whole list. An entry whose content and status are unchanged
// keeps its updatedAt; ids are positional.
const TODO_PREFIX = 'todo-'

// TodoWrite replaces the TodoWrite items only: Task* items (ids without the `todo-` prefix)
// stay. A TodoWrite item keeps its updatedAt when an earlier one has the same content and status.
export const replaceAll = (
  prev: readonly TodoItem[],
  todos: readonly TodoInput[],
  now: number,
): TodoItem[] => {
  const kept = prev.filter(p => !p.id.startsWith(TODO_PREFIX))
  const earlier = prev.filter(p => p.id.startsWith(TODO_PREFIX))
  const used = new Set<TodoItem>()
  const written = todos.map((todo, i) => {
    const content = clean(todo.content)
    const before = earlier.find(
      p => !used.has(p) && p.content === content && p.status === todo.status,
    )
    if (before !== undefined) used.add(before)
    const item: TodoItem = {
      id: `${TODO_PREFIX}${i + 1}`,
      content,
      status: todo.status,
      updatedAt: before === undefined ? now : before.updatedAt,
    }
    const activeForm = todo.activeForm === undefined ? undefined : clean(todo.activeForm)
    if (activeForm !== undefined && activeForm !== '') item.activeForm = activeForm

    return item
  })

  return [...kept, ...written]
}

export const addTask = (
  prev: readonly TodoItem[],
  id: string,
  subject: string,
  activeForm: string | undefined,
  now: number,
): TodoItem[] => {
  if (prev.some(p => p.id === id)) return [...prev]
  const item: TodoItem = { id, content: clean(subject), status: 'pending', updatedAt: now }
  const form = activeForm === undefined ? undefined : clean(activeForm)
  if (form !== undefined && form !== '') item.activeForm = form

  return [...prev, item]
}

// TaskUpdate: patches the named item; status "deleted" removes it. An unknown id is a no-op.
export const updateTask = (
  prev: readonly TodoItem[],
  update: TaskUpdateInput,
  now: number,
): TodoItem[] => {
  if (!prev.some(p => p.id === update.taskId)) return [...prev]
  if (update.status === 'deleted') return prev.filter(p => p.id !== update.taskId)

  return prev.map(p => {
    if (p.id !== update.taskId) return p
    const next: TodoItem = { ...p, updatedAt: now }
    if (update.subject !== undefined) next.content = clean(update.subject)
    if (update.activeForm !== undefined) next.activeForm = clean(update.activeForm)
    if (update.status !== undefined && update.status !== 'deleted') next.status = update.status

    return next
  })
}

export const progress = (items: readonly TodoItem[]): { done: number; total: number } => ({
  done: items.filter(i => i.status === 'completed').length,
  total: items.length,
})

export const PROGRESS_WIDTH = 10

export const progressBar = (done: number, total: number, width = PROGRESS_WIDTH): string => {
  const filled = total === 0 ? 0 : Math.round((done / total) * width)

  return `[${'#'.repeat(filled)}${'-'.repeat(width - filled)}]`
}

export const headerText = (items: readonly TodoItem[]): string => {
  const { done, total } = progress(items)

  return `${done}/${total} ${progressBar(done, total)}`
}

const label = (item: TodoItem): string => item.activeForm ?? item.content

// "Todo 3/7: <activeForm of the in-progress item>"; undefined (clear the line) with no items.
export const statusText = (items: readonly TodoItem[]): string | undefined => {
  if (items.length === 0) return undefined
  const { done, total } = progress(items)
  const active = items.find(i => i.status === 'in_progress')

  return active === undefined ? `Todo ${done}/${total}` : `Todo ${done}/${total}: ${label(active)}`
}

export type Line = { kind: 'header' | 'section' | 'item' | 'empty' | 'more'; text: string; dim: boolean }

export const EMPTY_TEXT = 'No todos yet.'

// Pane lines in order: header, In progress (activeForm), Pending, Done (dim). Past
// `maxLines` the tail is cut and a "+N more" line closes the list.
export const buildLines = (items: readonly TodoItem[], maxLines: number): Line[] => {
  const lines: Line[] = [{ kind: 'header', text: headerText(items), dim: false }]
  if (items.length === 0) {
    lines.push({ kind: 'empty', text: EMPTY_TEXT, dim: true })

    return lines
  }
  const sections: Array<[string, string, TodoStatus, boolean]> = [
    ['In progress', '[>]', 'in_progress', false],
    ['Pending', '[ ]', 'pending', false],
    ['Done', '[x]', 'completed', true],
  ]
  for (const [title, marker, status, dim] of sections) {
    const group = items.filter(i => i.status === status)
    if (group.length === 0) continue
    lines.push({ kind: 'section', text: `${title} (${group.length})`, dim })
    for (const item of group) {
      const text = status === 'in_progress' ? label(item) : item.content
      lines.push({ kind: 'item', text: `${marker} ${text}`, dim })
    }
  }
  // A section header draws with marginTop 1, so it costs two rows.
  const rows = (l: Line): number => (l.kind === 'section' ? 2 : 1)
  if (lines.reduce((sum, l) => sum + rows(l), 0) <= maxLines) return lines
  const budget = Math.max(1, maxLines - 1)
  const kept: Line[] = []
  let used = 0
  for (const line of lines) {
    if (kept.length > 0 && used + rows(line) > budget) break
    kept.push(line)
    used += rows(line)
  }
  while (kept.length > 1 && kept[kept.length - 1]?.kind === 'section') kept.pop()
  const hidden = lines.slice(kept.length).filter(l => l.kind === 'item').length

  return [...kept, { kind: 'more', text: `+${hidden} more`, dim: true }]
}

export const NUDGE_TOOLS: ReadonlySet<string> = new Set(['Edit', 'Write', 'NotebookEdit'])

export const NUDGE_TEXT = 'No todo list yet for this task'

export type NudgeInput = {
  tool: string
  items: readonly TodoItem[]
  updatedThisTurn: boolean
  nudgedThisTurn: boolean
}

// True when the toast should show: a state-changing tool, no todo update this turn, no
// unfinished item, and no nudge yet this turn. Never a reason to block the tool.
export const shouldNudge = (input: NudgeInput): boolean =>
  NUDGE_TOOLS.has(input.tool) &&
  !input.updatedThisTurn &&
  !input.nudgedThisTurn &&
  !input.items.some(i => i.status !== 'completed')

export const SECTION_ID = 'todo-list:instruction'

export const SECTION_TEXT =
  'Todo list: for any non-trivial task (more than 2 steps, or touching more than one file), create a todo list before starting work. ' +
  'Keep exactly one item in_progress at a time. Mark each item completed immediately when it is done, and add items when new work is discovered. ' +
  'Trivial single-step answers do not need a todo list.'

type Section = { id: string; text: string; scope: 'shared' | 'session' }

// Appends the instruction as a session section; a section with the same id is replaced,
// so a re-run never doubles it.
export const withTodoSection = (sections: readonly Section[]): Section[] => [
  ...sections.filter(s => s.id !== SECTION_ID),
  { id: SECTION_ID, text: SECTION_TEXT, scope: 'session' },
]
