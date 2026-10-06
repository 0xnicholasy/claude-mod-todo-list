import { expect, test } from 'claude-code/testing'
import { resolveAccent, validAccent } from './accent'
import { DEFAULT_ACCENT } from './tree'

test('a valid saved accent wins over the plugin option', async () => {
  expect(resolveAccent('magenta', 'green')).toBe('magenta')
  expect(resolveAccent('#c084fc', 'green')).toBe('#c084fc')
})

test('an invalid saved accent is ignored in favour of the option', async () => {
  expect(resolveAccent('red;rm', 'green')).toBe('green')
  expect(resolveAccent(42, 'green')).toBe('green')
})

test('the plugin option is used when nothing is saved', async () => {
  expect(resolveAccent(undefined, 'green')).toBe('green')
})

test('an invalid option with nothing valid saved falls back to the default', async () => {
  expect(resolveAccent(undefined, 'red;rm')).toBe(DEFAULT_ACCENT)
  expect(resolveAccent(null, undefined)).toBe(DEFAULT_ACCENT)
})

test('a colour name the renderer cannot draw is rejected', async () => {
  expect(validAccent('orange')).toBeNull()
})

test('a Bright name in any letter case returns the canonical spelling', async () => {
  expect(validAccent('RedBright')).toBe('redBright')
})

test('the claude theme key and a hex colour are accepted', async () => {
  expect(validAccent('claude')).toBe('claude')
  expect(validAccent('#d97757')).toBe('#d97757')
})
