// When the pane must be re-opened so the host sizes it again. `$.ui.open` on an open pane
// retitles it and keeps its size, so a changed terminal or plan only shows after a close + open.
export type PaneFit = { columns: number; rows: number; placement: string; wantRows: number }

// A plan growing or shrinking by less than this keeps the current frame.
export const WANT_ROWS_SLACK = 3

// `prev` is what the pane was last re-opened for (null: never recorded). True when the terminal
// size or the placement differs, or the rows the plan wants moved by WANT_ROWS_SLACK or more.
export const needsRefit = (prev: PaneFit | null, now: PaneFit): boolean => {
  if (prev === null) return true
  if (prev.columns !== now.columns || prev.rows !== now.rows || prev.placement !== now.placement) return true

  return Math.abs(prev.wantRows - now.wantRows) >= WANT_ROWS_SLACK
}
