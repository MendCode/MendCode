import { kittyDelete, kittyPlace, kittyTransmit } from "../pets/kitty"
import type { PetImage } from "../pets/decode"
import type { ImageProtocol } from "../pets/detect"
import { iterm2Inline, sixelEncode, validateImage } from "./image-protocol"
import { DEFAULT_CELL_PIXELS, sizePet, type CellPixels } from "../pets/frames"

/** One image on the grid. `slot` names the placement ('pet'), `key` the image content ('greenie/idle/3/16x4'); row/col are 0-based cells. */
export type ImagePlacement = {
  slot: string; key: string; image: PetImage; row: number; col: number; cols: number; rows: number; align?: "bottom"
  /** Only some rows of a taller picture are on screen: `of` is its whole height in rows, `skip` the rows cut from its top; `rows` are the ones shown, from `row`. */
  part?: { of: number; skip: number }
}

const fullRows = (p: Pick<ImagePlacement, "rows" | "part">) => p.part?.of ?? p.rows
const samePart = (a: ImagePlacement["part"], b: ImagePlacement["part"]) => a?.of === b?.of && a?.skip === b?.skip

/**
 * Images drawn above the text grid. The screen calls `uploads` outside the synchronized frame and `places` inside it;
 * strings are written as returned. `invalidate` follows every ESC[2J (the terminal dropped its images).
 */
export type ImageLayer = {
  protocol?: ImageProtocol
  /** Non-id protocols lose images when text overwrites their rows. */
  replaceOnRows?: boolean
  /** Old image rows to restore before placing this frame (move, resize, new content or removal). */
  repaintRows?(placements: ImagePlacement[]): ReadonlySet<number>
  uploads(placements: ImagePlacement[]): string
  places(placements: ImagePlacement[], changedRows: ReadonlySet<number>): string
  invalidate(): void
  clearAll(): string
  /** Grid size in cells (the screen keeps it current): a placement touching the last row or column is skipped. */
  setSize?(width: number, height: number): void
}

/** Distinct image contents kept in the terminal at once; the oldest unused one is freed beyond this. */
export const MAX_CACHED_IMAGES = 64

type Placed = { key: string; imageId: number; row: number; col: number; cols: number; rows: number; part?: ImagePlacement["part"] }

/** Kitty-protocol layer: uploads each content once per epoch, re-places a slot only when it moved, resized or changed image. */
export function createKittyLayer({ random = Math.random, cellPixels = DEFAULT_CELL_PIXELS }: { random?: () => number; cellPixels?: CellPixels } = {}): ImageLayer {
  validateCellPixels(cellPixels)
  const cacheKey = (p: ImagePlacement) => JSON.stringify([p.key, p.cols, fullRows(p), cellPixels.width, cellPixels.height])
  // A random base id per process so another program on the same terminal is unlikely to reuse ours.
  let nextImageId = 1 + Math.floor(Math.min(Math.max(random(), 0), 0.999999) * 0x7fff0000)
  const cache = new Map<string, number>() // key -> image id, least recently used first
  const slotIds = new Map<string, number>() // slot -> stable placement id
  const placed = new Map<string, Placed>() // slot -> what the terminal shows now
  let grid: { width: number; height: number } | undefined

  const fits = (p: ImagePlacement) =>
    [p.row, p.col, p.cols, p.rows].every(Number.isInteger) && p.row >= 0 && p.col >= 0 && p.cols >= 1 && p.rows >= 1 &&
    (!grid || (p.row + p.rows <= grid.height - 1 && p.col + p.cols <= grid.width - 1))

  /** Drawable placements by slot; the last one wins when a slot repeats. */
  function visible(placements: ImagePlacement[]) {
    const bySlot = new Map<string, ImagePlacement>()
    for (const p of placements) if (fits(p)) bySlot.set(p.slot, p)
    return bySlot
  }

  function placementId(slot: string) {
    let id = slotIds.get(slot)
    if (id === undefined) {
      id = slotIds.size + 1
      slotIds.set(slot, id)
    }
    return id
  }

  /** Frees the oldest image whose key is not in `keep`; "" when there is none. */
  function evict(keep: ReadonlySet<string>) {
    for (const [key, imageId] of cache) {
      if (keep.has(key)) continue
      cache.delete(key)
      for (const [slot, p] of placed) if (p.imageId === imageId) placed.delete(slot)
      return kittyDelete({ imageId })
    }
    return ""
  }

  return {
    protocol: "kitty",
    uploads(placements) {
      const wanted = visible(placements)
      const keep = new Set([...wanted.values()].map(cacheKey))
      let out = ""
      for (const p of wanted.values()) {
        const imageId = cache.get(cacheKey(p))
        if (imageId !== undefined) {
          cache.delete(cacheKey(p))
          cache.set(cacheKey(p), imageId)
          continue
        }
        while (cache.size >= MAX_CACHED_IMAGES) {
          const freed = evict(keep)
          if (!freed) break
          out += freed
        }
        validateImage(p.image)
        const fresh = nextImageId++
        cache.set(cacheKey(p), fresh)
        out += kittyTransmit({ imageId: fresh, image: sizePet(p.image, p.cols, fullRows(p), cellPixels, p.align) })
      }
      return out
    },
    places(placements, changedRows) {
      const wanted = visible(placements)
      let out = ""
      for (const [slot, last] of placed) {
        if (wanted.has(slot)) continue
        out += kittyDelete({ imageId: last.imageId, placementId: placementId(slot) })
        placed.delete(slot)
      }
      for (const p of wanted.values()) {
        const imageId = cache.get(cacheKey(p))
        if (imageId === undefined) continue // not uploaded: nothing to show yet
        const last = placed.get(p.slot)
        let stale = !last || last.key !== p.key || last.imageId !== imageId || last.row !== p.row || last.col !== p.col || last.cols !== p.cols || last.rows !== p.rows || !samePart(last.part, p.part)
        // Text writes do not disturb Kitty images; re-placing after a text change is only for terminals not known to comply.
        if (!stale) for (let y = p.row; y < p.row + p.rows; y++) if (changedRows.has(y)) stale = true
        if (!stale) continue
        const id = placementId(p.slot)
        // A new image gets its own placement, so the old one goes first; the same image is replaced in place.
        if (last && last.imageId !== imageId) out += kittyDelete({ imageId: last.imageId, placementId: id })
        out += `\x1b[${p.row + 1};${p.col + 1}H${kittyPlace({ imageId, placementId: id, cols: p.cols, rows: p.rows, ...(p.part ? { band: { y: p.part.skip * cellPixels.height, height: p.rows * cellPixels.height } } : {}) })}`
        placed.set(p.slot, { key: p.key, imageId, row: p.row, col: p.col, cols: p.cols, rows: p.rows, ...(p.part ? { part: p.part } : {}) })
      }
      return out
    },
    invalidate() {
      // ESC[2J deleted every image and placement: forget them so the next frame uploads and places again.
      cache.clear()
      placed.clear()
    },
    clearAll() {
      let out = ""
      for (const imageId of cache.values()) out += kittyDelete({ imageId })
      cache.clear()
      placed.clear()
      return out
    },
    setSize(width, height) {
      grid = { width, height }
    },
  }
}

type InlinePlaced = Pick<ImagePlacement, "key" | "row" | "col" | "cols" | "rows" | "part">
const samePlacement = (a: InlinePlaced | undefined, b: InlinePlaced) => a !== undefined && a.key === b.key && a.row === b.row && a.col === b.col && a.cols === b.cols && a.rows === b.rows && samePart(a.part, b.part)

/** The pixel rows `from` to `from + height` of `image`. */
function band(image: PetImage, from: number, height: number): PetImage {
  return { width: image.width, height, rgba: image.rgba.subarray(from * image.width * 4, (from + height) * image.width * 4) }
}

/** Pixel-only sixel has no cell sizing command. Hosts may supply their known cell geometry. */
export const SIXEL_CELL_PIXELS = DEFAULT_CELL_PIXELS

function validateCellPixels(cellPixels: CellPixels) {
  if (![cellPixels.width, cellPixels.height].every((n) => Number.isInteger(n) && n > 0 && n <= 256)) throw new RangeError("[IMAGES]: invalid cell pixels")
}

export function createInlineLayer(protocol: "iterm2" | "sixel", { cellPixels = SIXEL_CELL_PIXELS }: { cellPixels?: { width: number; height: number } } = {}): ImageLayer {
  const placed = new Map<string, InlinePlaced>()
  const cache = new Map<string, string>()
  let grid: { width: number; height: number } | undefined
  validateCellPixels(cellPixels)

  function visible(placements: ImagePlacement[]) {
    const wanted = new Map<string, ImagePlacement>()
    for (const p of placements) {
      if (![p.row, p.col, p.cols, p.rows].every(Number.isInteger) || p.row < 0 || p.col < 0 || p.cols < 1 || p.rows < 1) continue
      if (grid && (p.row + p.rows > grid.height - 1 || p.col + p.cols > grid.width - 1)) continue
      wanted.set(p.slot, p)
    }
    return wanted
  }

  const cacheKey = (p: ImagePlacement) => JSON.stringify([p.key, p.cols, p.rows, p.part?.of, p.part?.skip])

  return {
    protocol,
    replaceOnRows: true,
    repaintRows(placements) {
      const wanted = visible(placements)
      const rows = new Set<number>()
      for (const [slot, last] of placed) {
        const next = wanted.get(slot)
        if (next && samePlacement(last, next)) continue
        for (let y = last.row; y < last.row + last.rows; y++) rows.add(y)
      }
      return rows
    },
    uploads(placements) {
      const wanted = visible(placements)
      const keep = new Set([...wanted.values()].map(cacheKey))
      for (const p of wanted.values()) {
        const key = cacheKey(p)
        let encoded = cache.get(key)
        if (encoded !== undefined) cache.delete(key)
        else {
          validateImage(p.image)
          const whole = sizePet(p.image, p.cols, fullRows(p), cellPixels, p.align)
          const image = p.part ? band(whole, p.part.skip * cellPixels.height, p.rows * cellPixels.height) : whole
          encoded = protocol === "iterm2" ? iterm2Inline({ ...p, image }) : sixelEncode(image)
          while (cache.size >= MAX_CACHED_IMAGES) {
            const old = [...cache.keys()].find((candidate) => !keep.has(candidate))
            if (old === undefined) break
            cache.delete(old)
          }
        }
        cache.set(key, encoded)
      }
      return "" // No separate upload command: these protocols display their payload immediately.
    },
    places(placements, changedRows) {
      const wanted = visible(placements)
      for (const slot of placed.keys()) if (!wanted.has(slot)) placed.delete(slot)
      let out = ""
      for (const p of wanted.values()) {
        const encoded = cache.get(cacheKey(p))
        if (encoded === undefined) continue
        let stale = !samePlacement(placed.get(p.slot), p)
        if (!stale) for (let y = p.row; y < p.row + p.rows; y++) if (changedRows.has(y)) stale = true
        if (!stale) continue
        out += `\x1b[${p.row + 1};${p.col + 1}H${encoded}`
        placed.set(p.slot, { key: p.key, row: p.row, col: p.col, cols: p.cols, rows: p.rows, ...(p.part ? { part: p.part } : {}) })
      }
      return out
    },
    invalidate() {
      placed.clear()
    },
    clearAll() {
      let out = ""
      for (const p of placed.values()) for (let y = p.row; y < p.row + p.rows; y++) out += `\x1b[${y + 1};${p.col + 1}H\x1b[0m${" ".repeat(p.cols)}`
      placed.clear()
      cache.clear()
      return out
    },
    setSize(width, height) {
      grid = { width, height }
    },
  }
}

export function createImageLayer(protocol: Exclude<ImageProtocol, "off">, options: { cellPixels?: { width: number; height: number } } = {}): ImageLayer {
  return protocol === "kitty" ? createKittyLayer(options) : createInlineLayer(protocol, options)
}
