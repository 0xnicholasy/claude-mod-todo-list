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
    }
  }
}
