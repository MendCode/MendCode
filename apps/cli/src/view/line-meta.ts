import type { Line } from "../ui/theme"

/**
 * What the layout knows about a drawn row and the row itself cannot say, kept beside it so copying a selection returns the text
 * and not the drawing: how many leading cells are chrome (inset, lead glyph) and whether the row only continues a wrapped line.
 * Keyed by the row's array, so a row that is rebuilt must be carried over with `carryMeta`.
 */
const softBreaks = new WeakMap<Line, "space" | "none">()
const gutters = new WeakMap<Line, number>()

/** `space`: the wrap fell between words (the break replaced a space); `none`: a long word was cut. */
export const markSoftWrapped = (row: Line, kind: "space" | "none") => void softBreaks.set(row, kind)
export const softWrapOf = (row: Line) => softBreaks.get(row)
export const markGutter = (row: Line, cells: number) => void (cells > 0 && gutters.set(row, cells))
export const gutterOf = (row: Line) => gutters.get(row) ?? 0

const folds = new WeakMap<Line, number>()

/** The summary row of the n-th `<details>` block of a message (document order): clicking it, or the details key at it, folds or opens that block. */
export const markFold = (row: Line, ordinal: number) => void folds.set(row, ordinal)
export const foldOf = (row: Line) => folds.get(row)
/** Keeps a summary row's fold mark on `to`, a row rebuilt from it. */
export function carryFold(from: Line, to: Line): Line {
  const fold = folds.get(from)
  if (fold !== undefined) folds.set(to, fold)
  return to
}

/** A `copy` button drawn in a row: the cells `[from, to)` answer a click, and `text` is what they put on the clipboard (`label` says what, for the notice). */
export type CopyRegion = { from: number; to: number; text: string; label: string; /** A button that opens `text` (an image file) instead of copying it: in the system's viewer, or shown in its folder. */ open?: "image" | "folder" }
const copies = new WeakMap<Line, readonly CopyRegion[]>()

export const markCopy = (row: Line, regions: readonly CopyRegion[]) => void (regions.length && copies.set(row, regions))
export const copyOf = (row: Line): readonly CopyRegion[] | undefined => copies.get(row)
/** Keeps a row's copy buttons on `to`, a row rebuilt from it with `shift` more cells before its content. */
export function carryCopy(from: Line, to: Line, shift: number): Line {
  const regions = copies.get(from)
  if (regions) copies.set(to, shift ? regions.map((region) => ({ ...region, from: region.from + shift, to: region.to + shift })) : regions)
  return to
}

/**
 * A row whose cells `[col, col + cols)` are row `row` of a `rows`-tall chart the terminal can paint as a picture (`key`:
 * view/chart-picture.ts). The cells hold the chart's text version, shown where pictures are not drawn.
 */
export type PictureCells = { key: string; row: number; rows: number; cols: number; col: number }
const pictures = new WeakMap<Line, PictureCells>()

export const markPicture = (row: Line, cells: PictureCells): Line => (pictures.set(row, cells), row)
export const pictureOf = (row: Line) => pictures.get(row)
/** Keeps a row's picture cells on `to`, a row rebuilt from it with `shift` more cells before its content. */
export function carryPicture(from: Line, to: Line, shift = 0): Line {
  const cells = pictures.get(from)
  if (cells) pictures.set(to, shift ? { ...cells, col: cells.col + shift } : cells)
  return to
}

/** Copies what is known about `from` onto `to`, a row built from it with `extraGutter` more leading chrome cells. */
export function carryMeta(from: Line, to: Line, extraGutter = 0): Line {
  const soft = softBreaks.get(from)
  if (soft) softBreaks.set(to, soft)
  carryFold(from, to)
  carryCopy(from, to, extraGutter)
  carryPicture(from, to, extraGutter)
  markGutter(to, gutterOf(from) + extraGutter)
  return to
}
