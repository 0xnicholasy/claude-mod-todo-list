// When the pane must be re-opened so the host sizes it again. `$.ui.open` on an open pane
// retitles it and keeps its size, so a changed terminal or plan only shows after a close + open.
export type PaneFit = { columns: number; rows: number; placement: string; wantRows: number }

// A plan growing or shrinking by less than this keeps the current frame.
export const WANT_ROWS_SLACK = 3

// Below this width a re-open is not placed. The d.ts for `$.ui.open` says: "Asked, the person's
// command, prompt or press behind it (not `focus`), it is placed at any width; unasked, from 144
// columns, 110 for one once asked." The refit open is unasked, so under 110 columns the pane
// would be closed and never drawn again. A narrow redraw already gets the compact layout.
export const REFIT_MIN_COLUMNS = 110

// `prev` is what the pane was last re-opened for (null: never recorded). True when the terminal
// size or the placement differs (never below REFIT_MIN_COLUMNS), or the rows the plan wants moved by WANT_ROWS_SLACK or more.
export const needsRefit = (prev: PaneFit | null, now: PaneFit): boolean => {
  if (now.columns < REFIT_MIN_COLUMNS) return false
  if (prev === null) return true
  if (prev.columns !== now.columns || prev.rows !== now.rows || prev.placement !== now.placement) return true

  return Math.abs(prev.wantRows - now.wantRows) >= WANT_ROWS_SLACK
}
