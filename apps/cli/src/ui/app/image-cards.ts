import type { PetImage } from "../../pets/decode"
import { DEFAULT_CELL_PIXELS } from "../../pets/frames"
import type { TranscriptImages, ImageRow } from "../../view/transcript"
import type { ItemId, SessionId } from "@mendcode/protocol"
import { imageSize, MAX_CARD_IMAGE_BYTES } from "../image-decode"
import { fitImage, keptSize } from "../image-fit"
import { CHART_KEY, drawChart } from "../../view/chart-picture"
import { themeSelection } from "../theme"
import type { AppContext } from "./context"
import type { ImageHost } from "../image-host"

/** The widest and tallest an inline image gets, in cells; a generated picture has its own bounds (`imageWaitCanvas`). */
export const IMAGE_MAX_COLS = 72
export const IMAGE_MAX_ROWS = 16
/** Pictures drawn at their cells' size kept for redrawing (a screenshot is about 2 MB at the largest), sizes known, and jobs running at once. */
const KEEP_SCALED = 32
const KEEP_SIZES = 1024
const PARALLEL_JOBS = 3
/** Attachments whose whole bytes came with the first chunk, and the first chunks of bigger ones, held until they are drawn. */
const KEEP_BYTES = 8
const KEEP_STARTS = 32

type Entry = { status: "loading" | "failed"; session: SessionId } | { status: "ready"; session: SessionId; width: number; height: number }
type Job = { kind: "size"; sessionId: SessionId; sha256: string } | { kind: "draw"; sessionId: SessionId; sha256: string; key: string; width: number; height: number }

/**
 * Pictures in the transcript (docs/layout.md "Images in the transcript"): attachments of the messages and tool cards on screen are
 * fetched from the daemon by hash (`attachment.read`) and drawn over rows the transcript reserved for them. Their size comes from
 * the file's header (the first chunk), so the rows are reserved at once; only a picture that is placed on screen is decoded and
 * scaled to its cells, by the image host (image-host.ts) off this thread. A card whose image is not loaded, cannot be decoded or
 * is not drawable (images off, tmux, remote) keeps its text.
 */
export function createImageCards(ctx: AppContext, { host: hostOption }: { /** false: decode and scale in this process (tests). */ host?: ImageHost | false } = {}) {
  const { input, state, requestFrame } = ctx
  const entries = new Map<string, Entry>()
  const scaled = new Map<string, PetImage>()
  /** Pictures being decoded for their cells, by their `scaled` key. */
  const drawing = new Set<string>()
  const held = new Map<string, Uint8Array>()
  const starts = new Map<string, Uint8Array>()
  let host: ImageHost | undefined = hostOption || undefined
  let epoch = 0
  const waiting: Job[] = []
  let running = 0
  /** Size jobs queued or running: until they finish, the rows of the blocks on screen still move. */
  let sizing = 0
  let generation = 0

  const cell = () => state.imageCellPixels ?? DEFAULT_CELL_PIXELS
  /** Drawing needs a graphics protocol on a local, alternate-screen terminal; the profile can switch it off. */
  const enabled = () => state.tuiProfile.transcriptImages && !input.remote && input.screen.inline !== true && input.screen.imageProtocol !== undefined && input.screen.imageProtocol !== "off"

  function ready(sha256: string) {
    const entry = entries.get(sha256)
    return entry?.status === "ready" ? entry : undefined
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

  function keepScaled(key: string, image: PetImage) {
    scaled.set(key, image)
    if (scaled.size > KEEP_SCALED) scaled.delete(scaled.keys().next().value!)
  }

  /** A chart painted at the pixels of its cells; nothing to load, so it is there the first time it is asked for. */
  function chart(row: Pick<ImageRow, "sha256" | "cols" | "rows">): PetImage | undefined {
    const key = `${row.sha256}:${row.cols}x${row.rows}:${cell().width}x${cell().height}:${themeSelection()}`
    const known = scaled.get(key)
    if (known) return known
    const made = drawChart(row.sha256, row.cols * cell().width, row.rows * cell().height)
    if (!made) return undefined
    keepScaled(key, made)
    return made
  }

  /**
   * The picture to draw for one reserved block, at the pixels of its cells. The first time a block asks, the picture is decoded for
   * it in the background and the block stays empty until the next frame after that (a few tens of milliseconds).
   */
  function place(row: Pick<ImageRow, "sha256" | "cols" | "rows">): PetImage | undefined {
    if (row.sha256.startsWith(CHART_KEY)) return enabled() ? chart(row) : undefined
    const entry = ready(row.sha256)
    if (!entry || !enabled()) return undefined
    const box = fitImage({ source: entry, maxCols: row.cols, maxRows: row.rows, cell: cell() })
    const key = `${row.sha256}:${row.cols}x${row.rows}:${cell().width}x${cell().height}`
    const known = scaled.get(key)
    if (known) {
      // Seen again: the oldest unseen picture is the one dropped when the cache is full.
      scaled.delete(key)
      scaled.set(key, known)
      return known
    }
    // While sizes are still being read the blocks move, so drawing waits for them: only the pictures that end up on screen are decoded.
    if (!drawing.has(key) && sizing === 0) {
      drawing.add(key)
      // On screen now: ahead of the sizes still being read for blocks further away.
      waiting.unshift({ kind: "draw", sessionId: entry.session, sha256: row.sha256, key, width: box.width, height: box.height })
      pump()
    }
    return undefined
  }

  async function imageHost() {
    if (hostOption !== false && !host) host = (await import("../image-host")).createImageHost()
    return host && !host.broken ? host : undefined
  }

  /** The picture decoded (and scaled to `size`): in the image host, or here when there is none or it stopped working. */
  async function decode(bytes: Uint8Array, size?: { width: number; height: number }): Promise<PetImage> {
    const helper = await imageHost()
    if (helper) {
      try { return await (size ? helper.render(bytes, size.width, size.height) : helper.decode(bytes)) }
      catch (error) { if (!helper.broken) throw error }
    }
    const local = await import("../image-decode")
    return size ? local.renderCardImage(bytes, size.width, size.height) : local.decodeCardImage(bytes)
  }

  function readChunk(sessionId: SessionId, sha256: string, offset: number) {
    return input.send({ type: "attachment.read", sessionId, sha256, offset }).then((reply) => {
      if (!reply.ok) throw new Error(reply.error.message)
      const result = reply.result as { bytes?: number; data?: string; done?: boolean } | undefined
      if (typeof result?.bytes !== "number" || result.bytes > MAX_CARD_IMAGE_BYTES || typeof result.data !== "string") throw new RangeError("[IMAGES]: attachment is not available for drawing")
      const part = Buffer.from(result.data, "base64")
      return { part, done: result.done === true || part.length === 0 }
    })
  }

  async function fetchBytes(sessionId: SessionId, sha256: string, first?: Uint8Array): Promise<Uint8Array> {
    const kept = held.get(sha256)
    if (kept) return kept
    const chunks: Uint8Array[] = first ? [first] : []
    let offset = first?.length ?? 0
    for (;;) {
      const { part, done } = await readChunk(sessionId, sha256, offset)
      chunks.push(part)
      offset += part.length
      if (done) break
    }
    return Buffer.concat(chunks)
  }

  function hold(sha256: string, bytes: Uint8Array) {
    held.set(sha256, bytes)
    if (held.size > KEEP_BYTES) held.delete(held.keys().next().value!)
  }

  /** Learns a picture's size: from the header in its first chunk, or by decoding it when the header does not tell. */
  async function size(sessionId: SessionId, sha256: string) {
    const { part, done } = await readChunk(sessionId, sha256, 0)
    let known = imageSize(part)
    if (done) hold(sha256, part)
    else {
      starts.set(sha256, part)
      if (starts.size > KEEP_STARTS) starts.delete(starts.keys().next().value!)
    }
    if (known) known = keptSize(known)
    else {
      const bytes = done ? part : await fetchBytes(sessionId, sha256, part)
      hold(sha256, bytes)
      known = await decode(bytes)
    }
    entries.set(sha256, { status: "ready", session: sessionId, width: known.width, height: known.height })
    for (const key of entries.keys()) {
      if (entries.size <= KEEP_SIZES) break
      if (key !== sha256 && entries.get(key)?.status === "ready") entries.delete(key)
    }
  }

  async function draw(job: Extract<Job, { kind: "draw" }>) {
    const asked = epoch
    const bytes = await fetchBytes(job.sessionId, job.sha256, starts.get(job.sha256))
    starts.delete(job.sha256)
    const image = await decode(bytes, job)
    held.delete(job.sha256)
    if (asked === epoch) keepScaled(job.key, image)
  }

  async function run(job: Job) {
    try {
      if (job.kind === "size") await size(job.sessionId, job.sha256)
      else await draw(job)
    } catch {
      entries.set(job.sha256, { status: "failed", session: job.sessionId })
      held.delete(job.sha256)
      starts.delete(job.sha256)
    } finally {
      if (job.kind === "draw") drawing.delete(job.key)
      else sizing--
      // A size known (or a picture that turned out not to draw) changes the rows the transcript reserves.
      if (job.kind === "size" || entries.get(job.sha256)?.status === "failed") generation++
      running--
      pump()
      requestFrame()
    }
  }

  function pump() {
    while (running < PARALLEL_JOBS && waiting.length) {
      running++
      void run(waiting.shift()!)
    }
  }

  /** Starts loading the images of the blocks that are on screen; each is asked for once per session (a failure is not retried). */
  function ensure(sessionId: SessionId, itemIds: Iterable<ItemId>) {
    if (!enabled()) return
    for (const itemId of itemIds) {
      for (const file of state.transcript.attachmentsOf(itemId)) {
        if (!file.sha256 || !file.mime.startsWith("image/")) continue
        const known = entries.get(file.sha256)
        // A picture already sized is read again later (a redraw at other cells) by the session on screen now, not the first that showed it: that one may be gone.
        if (known?.status === "ready" && known.session !== sessionId) entries.set(file.sha256, { ...known, session: sessionId })
        if (known && (known.status !== "failed" || known.session === sessionId)) continue
        entries.set(file.sha256, { status: "loading", session: sessionId })
        waiting.push({ kind: "size", sessionId, sha256: file.sha256 })
        sizing++
      }
    }
    // The host gets ready while the sizes are read, so the first picture on screen does not wait for it to start.
    if (waiting.length) void imageHost().then((helper) => helper?.warm())
    pump()
  }

  /** The terminal's graphics or cell size changed, or the setting did: every answer may differ. */
  function invalidate() {
    epoch++
    scaled.clear()
    generation++
  }

  return { images, ensure, place, invalidate, get loaded() { return [...entries.values()].filter((entry) => entry.status === "ready").length }, get idle() { return running === 0 && waiting.length === 0 } }
}

export type ImageCards = ReturnType<typeof createImageCards>
