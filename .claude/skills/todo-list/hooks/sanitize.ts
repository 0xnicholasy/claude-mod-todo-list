// Model-supplied text goes through clean() before it reaches state or the terminal.
// Control characters (including ESC, so an escape sequence cannot reach the terminal)
// become spaces; bidi and zero-width characters are dropped.
export const clean = (s: string): string =>
  s
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
