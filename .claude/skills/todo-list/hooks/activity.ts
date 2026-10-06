// Pure activity reducer: what Claude is doing right now, derived from events.
// No `$` here: register.tsx raises events from the hooks and stores the result in the atom.
//
// The atom holds only the visible phase, so precedence is enforced by the transitions:
// question > permission > compacting > tool > working. A lower-phase event never overrides a
// higher phase; ending a phase falls back to `working` (the turn is still running).
import type { ActivityPhase, ActivityState } from '../types'
import { clean } from './sanitize'

export type { ActivityPhase, ActivityState }

export type TurnReason = 'answer' | 'aborted' | 'error' | 'refusal' | (string & {})

export type ActivityEvent =
  | { type: 'turnStart' }
  // An `agentId` marks a subagent's turn end; only main-loop turn ends move the phase.
  | { type: 'turnComplete'; reason: TurnReason; agentId?: string }
  | { type: 'toolStart'; tool: string }
  | { type: 'toolEnd' }
  | { type: 'permissionAsk'; tool: string }
  | { type: 'permissionEnd' }
  | { type: 'questionOpen' }
  | { type: 'questionClose' }
  | { type: 'compactStart' }
  | { type: 'compactEnd' }
  | { type: 'subagentStart'; id: string }
  | { type: 'subagentStop'; id: string }
  | { type: 'stopFailure'; detail: string }
  | { type: 'sessionClear' }

export const emptyActivity = (now: number): ActivityState => ({ phase: 'idle', subagents: [], since: now })

// Higher rank wins. idle, interrupted and error are turn-end states, ranked below working.
const RANK: Record<ActivityPhase, number> = {
  idle: 0,
  interrupted: 0,
  error: 0,
  working: 1,
  tool: 2,
  compacting: 3,
  permission: 4,
  question: 5,
}

// Moves to `phase` (keeping `since` when the phase is unchanged).
const enter = (prev: ActivityState, phase: ActivityPhase, now: number, tool?: string, detail?: string): ActivityState => {
  const next: ActivityState = {
    phase,
    subagents: prev.subagents,
    since: prev.phase === phase ? prev.since : now,
  }
  if (tool !== undefined) next.tool = tool
  if (detail !== undefined) next.detail = detail

  return next
}

// Applies `phase` only when it outranks (or equals) the current phase.
const raise = (prev: ActivityState, phase: ActivityPhase, now: number, tool?: string): ActivityState =>
  RANK[prev.phase] > RANK[phase] ? prev : enter(prev, phase, now, tool)

// Ends `ended` and falls back to working; any other phase is left alone.
const fallBack = (prev: ActivityState, ended: ActivityPhase, now: number): ActivityState =>
  prev.phase === ended ? enter(prev, 'working', now) : prev

export const reduceActivity = (prev: ActivityState, event: ActivityEvent, now: number): ActivityState => {
  switch (event.type) {
    case 'turnStart':
      return enter(prev, 'working', now)
    case 'turnComplete': {
      if (event.agentId !== undefined) return prev
      if (event.reason === 'aborted') return enter(prev, 'interrupted', now)
      if (event.reason === 'error' || event.reason === 'refusal') return enter(prev, 'error', now)

      return enter(prev, 'idle', now)
    }
    case 'toolStart':
      return raise(prev, 'tool', now, clean(event.tool) || 'tool')
    case 'toolEnd':
      // A tool that ends while permission is shown means the dialog is over too.
      return prev.phase === 'tool' || prev.phase === 'permission' ? enter(prev, 'working', now) : prev
    case 'permissionAsk':
      return raise(prev, 'permission', now, clean(event.tool) || 'tool')
    case 'permissionEnd':
      // A subagent's call ended, so its dialog is over; it must not touch the main loop's tool phase.
      return fallBack(prev, 'permission', now)
    case 'questionOpen':
      return enter(prev, 'question', now)
    case 'questionClose':
      return fallBack(prev, 'question', now)
    case 'compactStart': {
      // A repeat start, or a higher phase, changes nothing; keep the first resume phase.
      if (RANK[prev.phase] >= RANK.compacting) return prev
      // A tool name would be stale once compaction ends, so a tool resumes as working.
      const next = enter(prev, 'compacting', now)
      next.resume = prev.phase === 'tool' ? 'working' : prev.phase

      return next
    }
    case 'compactEnd':
      return prev.phase === 'compacting' ? enter(prev, prev.resume ?? 'working', now) : prev
    case 'subagentStart': {
      const id = clean(event.id)
      if (!id || prev.subagents.includes(id)) return prev

      return { ...prev, subagents: [...prev.subagents, id] }
    }
    case 'subagentStop': {
      const id = clean(event.id)
      if (!prev.subagents.includes(id)) return prev

      return { ...prev, subagents: prev.subagents.filter(s => s !== id) }
    }
    case 'stopFailure':
      return enter(prev, 'error', now, undefined, clean(event.detail))
    case 'sessionClear':
      return emptyActivity(now)
  }
}

// The status line and pane label; undefined when there is nothing to show.
export const activityLabel = (activity: ActivityState): string | undefined => {
  const n = activity.subagents.length
  const tool = activity.tool ?? 'tool'
  let base: string | undefined
  switch (activity.phase) {
    case 'working':
      base = 'Working'
      break
    case 'tool':
      base = `Running ${tool}`
      break
    case 'permission':
      base = `Waiting for permission: ${tool}`
      break
    case 'question':
      base = 'Waiting for your answer'
      break
    case 'compacting':
      base = 'Compacting'
      break
    case 'interrupted':
      base = 'Interrupted'
      break
    case 'error':
      base = activity.detail ? `Error: ${activity.detail}` : 'Error'
      break
    case 'idle':
      base = undefined
      break
  }
  if (n === 0) return base

  return `${base ?? 'Idle'} · ${n} subagent${n === 1 ? '' : 's'}`
}
