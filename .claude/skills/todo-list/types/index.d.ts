// Every atom is declared inline: `claude plugin validate` refuses a PluginState
// entry that points at an alias. The named types below are for use in code.
export type TodoStatus = 'pending' | 'in_progress' | 'completed'
export type TodoItem = {
  id: string
  content: string
  activeForm?: string
  status: TodoStatus
  updatedAt: number
}

export type PlanStatus = 'pending' | 'in_progress' | 'completed' | 'blocked' | 'skipped'
export type PlanSource = 'plan' | 'todo' | 'task'
export type PlanNode = {
  id: string
  parentId: string | null
  title: string
  activeForm?: string
  status: PlanStatus
  note?: string
  source: PlanSource
  externalId?: string
  updatedAt: number
}
// `issued` remembers the last child number handed out per parent ('' is the top level), so a
// removed id is never reused.
export type Plan = {
  title: string
  nodes: PlanNode[]
  issued: Array<{ parent: string; last: number }>
}
export type TaskState = { open: boolean; planned: boolean; denies: number }
export type ActivityPhase =
  | 'idle'
  | 'working'
  | 'tool'
  | 'permission'
  | 'question'
  | 'compacting'
  | 'interrupted'
  | 'error'
export type ActivityState = {
  phase: ActivityPhase
  tool?: string
  detail?: string
  resume?: ActivityPhase
  subagents: string[]
  since: number
}
export type PlanToolState = { name: string | null; offered: boolean }

declare module 'claude-code' {
  interface PluginState {
    'todo-list': {
      items: Array<{
        id: string
        content: string
        activeForm?: string
        status: 'pending' | 'in_progress' | 'completed'
        updatedAt: number
      }>
      // Set by a TodoWrite / TaskCreate / TaskUpdate call; cleared on prompt.submit.
      updatedThisTurn: boolean
      // Set when the nudge toast showed; cleared on prompt.submit.
      nudgedThisTurn: boolean
      plan: {
        title: string
        nodes: Array<{
          id: string
          parentId: string | null
          title: string
          activeForm?: string
          status: 'pending' | 'in_progress' | 'completed' | 'blocked' | 'skipped'
          note?: string
          source: 'plan' | 'todo' | 'task'
          externalId?: string
          updatedAt: number
        }>
        issued: Array<{ parent: string; last: number }>
      }
      task: { open: boolean; planned: boolean; denies: number }
      activity: {
        phase: 'idle' | 'working' | 'tool' | 'permission' | 'question' | 'compacting' | 'interrupted' | 'error'
        tool?: string
        detail?: string
        resume?: 'idle' | 'working' | 'tool' | 'permission' | 'question' | 'compacting' | 'interrupted' | 'error'
        subagents: string[]
        since: number
      }
      enforceSession: boolean
      planTool: { name: string | null; offered: boolean }
    }
  }
}
