import { expect, test } from 'claude-code/testing'
import { needsRefit } from './fit'
import type { PaneFit } from './fit'

const BASE: PaneFit = { columns: 120, rows: 20, placement: 'inline', wantRows: 12 }

test('needsRefit is true with nothing recorded', () => {
  expect(needsRefit(null, BASE)).toBe(true)
})

test('needsRefit is true when the width, the height or the placement changes', () => {
  expect(needsRefit(BASE, { ...BASE, columns: 46 })).toBe(true)
  expect(needsRefit(BASE, { ...BASE, rows: 45 })).toBe(true)
  expect(needsRefit(BASE, { ...BASE, placement: 'dock' })).toBe(true)
})

test('needsRefit ignores a small change in the rows the plan wants', () => {
  expect(needsRefit(BASE, BASE)).toBe(false)
  expect(needsRefit(BASE, { ...BASE, wantRows: 14 })).toBe(false)
  expect(needsRefit(BASE, { ...BASE, wantRows: 10 })).toBe(false)
})

test('needsRefit is true when the plan wants 3 or more rows more or fewer', () => {
  expect(needsRefit(BASE, { ...BASE, wantRows: 15 })).toBe(true)
  expect(needsRefit(BASE, { ...BASE, wantRows: 9 })).toBe(true)
})
