import { expect, test } from 'claude-code/testing'
import { applyManual, parseTodoArgs, replaceAll } from './todos'
import type { TodoItem } from './todos'

const item = (id: string, content: string, status: TodoItem['status'] = 'pending'): TodoItem => ({
  id,
  content,
  status,
  updatedAt: 1,
})

const ok = (r: ReturnType<typeof applyManual>): { items: TodoItem[]; text: string } => {
  if ('error' in r) throw new Error(r.error)

  return r
}

test('parseTodoArgs maps each subcommand and cleans text', () => {
  expect(parseTodoArgs('  ')).toEqual({ kind: 'open' })
  expect(parseTodoArgs('add  write\tdocs ')).toEqual({ kind: 'add', text: 'write docs' })
  expect(parseTodoArgs('start 2')).toEqual({ kind: 'start', index: 2 })
  expect(parseTodoArgs('done 3')).toEqual({ kind: 'done', index: 3 })
  expect(parseTodoArgs('rm 1')).toEqual({ kind: 'rm', index: 1 })
  expect(parseTodoArgs('clear')).toEqual({ kind: 'clear' })
})

test('parseTodoArgs rejects empty add, non-integer n and unknown subcommands', () => {
  expect(parseTodoArgs('add   ').kind).toBe('error')
  expect(parseTodoArgs('start x').kind).toBe('error')
  expect(parseTodoArgs('done 1.5').kind).toBe('error')
  expect(parseTodoArgs('rm -1').kind).toBe('error')
  expect(parseTodoArgs('rm').kind).toBe('error')
  const unknown = parseTodoArgs('frobnicate')
  expect(unknown.kind === 'error' && unknown.message.includes('Usage:')).toBe(true)
})

test('add appends a pending manual item and never reuses a manual id', () => {
  const first = ok(applyManual([item('todo-1', 'a')], { kind: 'add', text: 'one' }, 5))
  expect(first.items.map(i => [i.id, i.content, i.status, i.updatedAt])).toEqual([
    ['todo-1', 'a', 'pending', 1],
    ['manual-1', 'one', 'pending', 5],
  ])
  expect(first.text).toBe('Added: one (2 items)')
  // manual-1 removed, manual-2 stays: the next id is 3, not a reused 1.
  const list = [item('manual-2', 'two'), item('manual-5', 'five')]
  const next = ok(applyManual(list, { kind: 'add', text: 'six' }, 6))
  expect(next.items.map(i => i.id)).toEqual(['manual-2', 'manual-5', 'manual-6'])
})

test('start sets in_progress and demotes the other in_progress item', () => {
  const list = [item('todo-1', 'a', 'in_progress'), item('manual-1', 'b'), item('7', 'c', 'completed')]
  const r = ok(applyManual(list, { kind: 'start', index: 2 }, 9))
  expect(r.items.map(i => i.status)).toEqual(['pending', 'in_progress', 'completed'])
  expect(r.items[1]?.updatedAt).toBe(9)
})

test('done completes and rm removes by 1-based position, any source', () => {
  const list = [item('todo-1', 'a'), item('7', 'b')]
  const done = ok(applyManual(list, { kind: 'done', index: 2 }, 3))
  expect(done.items.map(i => i.status)).toEqual(['pending', 'completed'])
  const removed = ok(applyManual(list, { kind: 'rm', index: 1 }, 3))
  expect(removed.items.map(i => i.id)).toEqual(['7'])
})

test('clear empties the list', () => {
  expect(ok(applyManual([item('todo-1', 'a')], { kind: 'clear' }, 1)).items).toEqual([])
})

test('out-of-range index and parse errors are errors and change nothing', () => {
  const list = [item('todo-1', 'a')]
  expect('error' in applyManual(list, { kind: 'done', index: 2 }, 1)).toBe(true)
  expect('error' in applyManual(list, { kind: 'rm', index: 0 }, 1)).toBe(true)
  expect(applyManual(list, { kind: 'error', message: 'bad' }, 1)).toEqual({ error: 'bad' })
  expect(list).toEqual([item('todo-1', 'a')])
})

test('TodoWrite keeps manual items', () => {
  const prev = [item('manual-1', 'mine'), item('todo-1', 'old')]
  const next = replaceAll(prev, [{ content: 'new', status: 'pending' }], 2)
  expect(next.map(i => i.id)).toEqual(['manual-1', 'todo-1'])
  expect(next[0]?.content).toBe('mine')
  expect(next[1]?.content).toBe('new')
})
