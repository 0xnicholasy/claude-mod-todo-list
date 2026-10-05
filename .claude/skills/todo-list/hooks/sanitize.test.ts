import { expect, test } from 'claude-code/testing'
import { clean } from './sanitize'

test('clean turns control characters into spaces and collapses whitespace', () => {
  expect(clean('a\u001b[2Jb')).toBe('a [2Jb')
  expect(clean('  one\n\ttwo   three  ')).toBe('one two three')
  expect(clean('x\u0000y\u007fz')).toBe('x y z')
})

test('clean drops bidi and zero-width characters', () => {
  expect(clean('a\u200bb\u202ec\u2066d\ufeffe')).toBe('abcde')
})

test('clean leaves plain text and box-drawing glyphs alone', () => {
  expect(clean('Escape quotes ├─ done')).toBe('Escape quotes ├─ done')
})
