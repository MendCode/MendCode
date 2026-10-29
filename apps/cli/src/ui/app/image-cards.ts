import type { PetImage } from "../../pets/decode"
import { DEFAULT_CELL_PIXELS } from "../../pets/frames"
import type { TranscriptImages, ImageRow } from "../../view/transcript"
import type { ItemId, SessionId } from "@mendcode/protocol"
import { MAX_CARD_IMAGE_BYTES } from "../image-decode"
import { fitImage, resizeRgba } from "../image-fit"
import { CHART_KEY, drawChart } from "../../view/chart-picture"
import { themeSelection } from "../theme"
import type { AppContext } from "./context"

/** The widest and tallest an inline image gets, in cells; a generated picture has its own bounds (`imageWaitCanvas`). */
export const IMAGE_MAX_COLS = 72
export const IMAGE_MAX_ROWS = 16
/** Decoded images kept (about 5 MB each at most), and loads running at once. */
const KEEP_IMAGES = 24
const KEEP_SCALED = 32
const PARALLEL_LOADS = 2

type Entry = { status: "loading" | "failed"; session: SessionId } | { status: "ready"; image: PetImage }

/**
 * Pictures in the transcript (docs/layout.md "Images in the transcript"): attachments of the messages and tool cards on screen are
 * fetched from the daemon by hash (`attachment.read`), decoded here and drawn over rows the transcript reserved for them. A card
 * whose image is not loaded, cannot be decoded or is not drawable (images off, tmux, remote) keeps its text.
 */
export function createImageCards(ctx: AppContext) {
  const { input, state, requestFrame } = ctx
  const entries = new Map<string, Entry>()
  const scaled = new Map<string, PetImage>()
  const waiting: Array<{ sessionId: SessionId; sha256: string }> = []
  let running = 0
  let generation = 0

  const cell = () => state.imageCellPixels ?? DEFAULT_CELL_PIXELS
  /** Drawing needs a graphics protocol on a local, alternate-screen terminal; the profile can switch it off. */
  const enabled = () => state.tuiProfile.transcriptImages && !input.remote && input.screen.inline !== true && input.screen.imageProtocol !== undefined && input.screen.imageProtocol !== "off"

  function ready(sha256: string): PetImage | undefined {
    const entry = entries.get(sha256)
    return entry?.status === "ready" ? entry.image : undefined
  }

  const images: TranscriptImages = {
    generation: () => generation,
    charts: () => enabled(),
    slot(sha256, maxCols, maxRows) {
      const image = enabled() ? ready(sha256) : undefined
      if (!image || maxCols < 6) return undefined
      const box = fitImage({ source: image, maxCols: maxRows === undefined ? Math.min(maxCols, IMAGE_MAX_COLS) : maxCols, maxRows: maxRows ?? IMAGE_MAX_ROWS, cell: cell() })
      return { cols: box.cols, rows: box.rows }
    },
  }

  /** A chart painted at the pixels of its cells; nothing to load, so it is there the first time it is asked for. */
  function chart(row: Pick<ImageRow, "sha256" | "cols" | "rows">): PetImage | undefined {
    const key = `${row.sha256}:${row.cols}x${row.rows}:${cell().width}x${cell().height}:${themeSelection()}`
    const known = scaled.get(key)
    if (known) return known
    const made = drawChart(row.sha256, row.cols * cell().width, row.rows * cell().height)
    if (!made) return undefined
    scaled.set(key, made)
    if (scaled.size > KEEP_SCALED) scaled.delete(scaled.keys().next().value!)
    return made
  }

  /** The picture to draw for one reserved block, scaled to its cells once; undefined when it is no longer held. */
  function place(row: Pick<ImageRow, "sha256" | "cols" | "rows">): PetImage | undefined {
    if (row.sha256.startsWith(CHART_KEY)) return enabled() ? chart(row) : undefined
    const entry = entries.get(row.sha256)
    if (entry?.status !== "ready" || !enabled()) return undefined
    // Seen again: the oldest unseen image is the one dropped when the cache is full.
    entries.delete(row.sha256)
    entries.set(row.sha256, entry)
    const box = fitImage({ source: entry.image, maxCols: row.cols, maxRows: row.rows, cell: cell() })
    const key = `${row.sha256}:${row.cols}x${row.rows}:${cell().width}x${cell().height}`
    const known = scaled.get(key)
    if (known) return known
    const made = resizeRgba(entry.image, box.width, box.height)
    scaled.set(key, made)
    if (scaled.size > KEEP_SCALED) scaled.delete(scaled.keys().next().value!)
    return made
  }

  async function fetchBytes(sessionId: SessionId, sha256: string): Promise<Uint8Array> {
    const chunks: Uint8Array[] = []
    let offset = 0
    for (;;) {
      const reply = await input.send({ type: "attachment.read", sessionId, sha256, offset })
      if (!reply.ok) throw new Error(reply.error.message)
      const result = reply.result as { bytes?: number; data?: string; done?: boolean } | undefined
      if (typeof result?.bytes !== "number" || result.bytes > MAX_CARD_IMAGE_BYTES || typeof result.data !== "string") throw new RangeError("[IMAGES]: attachment is not available for drawing")
      const part = Buffer.from(result.data, "base64")
      chunks.push(part)
      offset += part.length
      if (result.done || part.length === 0) break
    }
    return Buffer.concat(chunks)
  }

  async function load(sessionId: SessionId, sha256: string) {
    try {
      const { decodeCardImage } = await import("../image-decode")
      const image = await decodeCardImage(await fetchBytes(sessionId, sha256))
      entries.set(sha256, { status: "ready", image })
      for (const [key, entry] of entries) {
        if (entries.size <= KEEP_IMAGES) break
        if (entry.status === "ready" && key !== sha256) {
          entries.delete(key)
          for (const scaledKey of scaled.keys()) if (scaledKey.startsWith(`${key}:`)) scaled.delete(scaledKey)
        }
      }
      generation++
    } catch {
      entries.set(sha256, { status: "failed", session: sessionId })
    } finally {
      running--
      pump()
      requestFrame()
    }
  }

  function pump() {
    while (running < PARALLEL_LOADS && waiting.length) {
      const next = waiting.shift()!
      running++
      void load(next.sessionId, next.sha256)
    }
  }

  /** Starts loading the images of the blocks that are on screen; each is asked for once per session (a failure is not retried). */
  function ensure(sessionId: SessionId, itemIds: Iterable<ItemId>) {
    if (!enabled()) return
    for (const itemId of itemIds) {
      for (const file of state.transcript.attachmentsOf(itemId)) {
        if (!file.sha256 || !file.mime.startsWith("image/")) continue
        const known = entries.get(file.sha256)
        if (known && (known.status !== "failed" || known.session === sessionId)) continue
        entries.set(file.sha256, { status: "loading", session: sessionId })
        waiting.push({ sessionId, sha256: file.sha256 })
      }
    }
    pump()
  }

  /** The terminal's graphics or cell size changed, or the setting did: every answer may differ. */
  function invalidate() {
    scaled.clear()
    generation++
  }

  return { images, ensure, place, invalidate, get loaded() { return [...entries.values()].filter((entry) => entry.status === "ready").length }, get idle() { return running === 0 && waiting.length === 0 } }
}

export type ImageCards = ReturnType<typeof createImageCards>
