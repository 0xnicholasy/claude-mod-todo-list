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
  // `id` is the call's id when the hook carries one; without it the entry is synthetic (`name:<tool>`).
  | { type: 'toolStart'; tool: string; id?: string }
  // By id first; an absent or unknown id falls back to the oldest synthetic entry of `tool`. With neither
  // id nor tool every running call is cleared.
  | { type: 'toolEnd'; id?: string; tool?: string }
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

export const emptyActivity = (now: number): ActivityState => ({ phase: 'idle', subagents: [], running: [], since: now })

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
    running: prev.running,
    since: prev.phase === phase ? prev.since : now,
  }
  if (tool !== undefined) next.tool = tool
  if (detail !== undefined) next.detail = detail

  return next
}

// Applies `phase` only when it outranks (or equals) the current phase.
const raise = (prev: ActivityState, phase: ActivityPhase, now: number, tool?: string): ActivityState =>
  RANK[prev.phase] > RANK[phase] ? prev : enter(prev, phase, now, tool)

// Settles into the turn's resting phase: `tool` labelled by the newest running call, else `working`.
const settle = (prev: ActivityState, now: number): ActivityState => {
  const last = prev.running[prev.running.length - 1]

  return last ? enter(prev, 'tool', now, last.tool) : enter(prev, 'working', now)
}

// Ends `ended` and settles; any other phase is left alone.
const fallBack = (prev: ActivityState, ended: ActivityPhase, now: number): ActivityState =>
  prev.phase === ended ? settle(prev, now) : prev

// Moves to `phase` with no running calls (a turn boundary: a stuck entry lasts at most one turn).
const enterIdle = (prev: ActivityState, phase: ActivityPhase, now: number, detail?: string): ActivityState => ({
  ...enter(prev, phase, now, undefined, detail),
  running: [],
})

// The entry a toolEnd removes: by id, else the oldest synthetic entry of `tool`; -1 when none matches.
const endedIndex = (running: ActivityState['running'], id: string | undefined, tool: string | undefined): number => {
  const byId = id ? running.findIndex(r => r.id === id) : -1
  if (byId >= 0 || !tool) return byId

  return running.findIndex(r => r.tool === tool && r.id === `name:${r.tool}`)
}

export const reduceActivity = (prev: ActivityState, event: ActivityEvent, now: number): ActivityState => {
  switch (event.type) {
    case 'turnStart':
      return enterIdle(prev, 'working', now)
    case 'turnComplete': {
      if (event.agentId !== undefined) return prev
      if (event.reason === 'aborted') return enterIdle(prev, 'interrupted', now)
      if (event.reason === 'error' || event.reason === 'refusal') return enterIdle(prev, 'error', now)

      return enterIdle(prev, 'idle', now)
    }
    case 'toolStart': {
      const tool = clean(event.tool) || 'tool'
      const entry = { id: clean(event.id ?? '') || `name:${tool}`, tool }
      const running = [...prev.running, entry]
      // A higher phase (permission, compacting, question) keeps showing; only `running` grows.
      if (RANK[prev.phase] > RANK.tool) return { ...prev, running }

      return raise({ ...prev, running }, 'tool', now, tool)
    }
    case 'toolEnd': {
      const tool = event.tool === undefined ? undefined : clean(event.tool) || 'tool'
      const id = event.id === undefined ? undefined : clean(event.id)
      const all = id === undefined && tool === undefined
      const at = all ? -1 : endedIndex(prev.running, id, tool)
      // An unknown call changes nothing.
      if (!all && at < 0) return prev
      const running = all ? [] : prev.running.filter((_, i) => i !== at)
      if (prev.phase !== 'tool' && prev.phase !== 'permission') return { ...prev, running }
      // A tool that ends while permission is shown means the dialog is over too.
      return settle({ ...prev, running }, now)
    }
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
      if (prev.phase !== 'compacting') return prev
      const resume = prev.resume ?? 'working'

      return resume === 'working' ? settle(prev, now) : enter(prev, resume, now)
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
