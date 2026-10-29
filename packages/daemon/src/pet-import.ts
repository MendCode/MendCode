import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs"
import path from "node:path"
import { PET_STATE_NAMES, type PetState } from "../../protocol/src/pet-data"
import { decodeGif, isGif } from "../../tools/src/gif-decode"
import { decodePng, MAX_SHEET_BYTES } from "../../tools/src/pet-decode"
import { IMPORT_BUDGET, IMPORT_FRAME_MS, splitSheet, type ImportFrame, type ImportSource } from "../../tools/src/pet-import"

const MAX_ENTRIES = 2_000
const natural = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true, sensitivity: "base" })
const stem = (name: string) => name.replace(/\.[^.]+$/, "")
const isPicture = (name: string) => /\.(png|gif)$/i.test(name)

/**
 * The frames of a picture on disk, by state, for `/pet import`. One PNG is a still (or a sprite sheet with `frames`); a GIF
 * is an animation with its own delays; a folder is either numbered PNG frames, or one entry per state: a subfolder of
 * frames or a `<state>.gif` / `<state>.png` (`PET_STATE_NAMES` maps the names; others are ignored and noted). Every file is
 * checked by `allow` (the permission rules) and by size before it is read; nothing outside what was named is opened.
 */
export function readImportSource(input: { path: string; frames?: { columns: number; rows: number } | undefined; ms?: number | undefined; allow(file: string): void }): { states: ImportSource; notes: string[]; name: string } {
  const ms = input.ms ?? IMPORT_FRAME_MS
  const notes: string[] = []
  let frames = 0
  const count = (more: number) => {
    frames += more
    if (frames > IMPORT_BUDGET.frames) throw new Error(`Too many frames: an imported pet holds at most ${IMPORT_BUDGET.frames}`)
  }
  const bytes = (file: string) => {
    const real = realpathSync(file)
    input.allow(real)
    const info = statSync(real)
    if (!info.isFile()) throw new Error(`Not a file: ${path.basename(file)}`)
    if (info.size > MAX_SHEET_BYTES) throw new Error(`${path.basename(file)} is larger than 32 MB`)
    return new Uint8Array(readFileSync(real))
  }
  /** A file as frames: every frame of a GIF, or the one picture of a PNG. */
  const clip = (file: string): ImportFrame[] => {
    const data = bytes(file)
    if (isGif(data)) {
      const decoded = decodeGif(data)
      count(decoded.length)
      return decoded
    }
    count(1)
    try {
      return [{ image: decodePng(data), ms }]
    } catch (error) {
      throw new Error(`${path.basename(file)}: ${error instanceof Error ? error.message.replace(/^\[PETS\]: /, "") : "not a PNG"}${/signature/.test(String(error)) ? " (PNG or GIF expected; convert JPEG or WebP first)" : ""}`)
    }
  }
  const list = (dir: string) => {
    const names = readdirSync(dir).filter((name) => !name.startsWith(".")).sort(natural)
    if (names.length > MAX_ENTRIES) throw new Error("Too many files in the folder")
    return names.map((name) => ({ name, file: path.join(dir, name), dir: statSync(path.join(dir, name), { throwIfNoEntry: false })?.isDirectory() === true }))
  }
  /** A folder of frames: its PNGs in numeric order, or its single GIF. */
  const folder = (dir: string): ImportFrame[] => {
    const pictures = list(dir).filter((entry) => !entry.dir && isPicture(entry.name))
    const pngs = pictures.filter((entry) => /\.png$/i.test(entry.name))
    if (pngs.length > 0) return pngs.flatMap((entry) => clip(entry.file))
    return pictures.length === 1 ? clip(pictures[0]!.file) : []
  }

  const root = realpathSync(input.path)
  input.allow(root)
  const name = stem(path.basename(root))
  if (!statSync(root).isDirectory()) {
    const data = bytes(root)
    if (input.frames && !isGif(data)) return { states: splitSheet(clip(root)[0]!.image, input.frames.columns, input.frames.rows, ms), notes, name }
    return { states: { idle: clip(root) }, notes, name }
  }
  if (input.frames) throw new Error("--frames cuts one sprite sheet; a folder already has one file per frame")
  const entries = list(root)
  const named = entries.filter((entry) => (entry.dir || isPicture(entry.name)) && PET_STATE_NAMES[stem(entry.name).toLowerCase()] !== undefined)
  if (named.length === 0) {
    const ignored = entries.filter((entry) => entry.dir)
    if (ignored.length > 0) notes.push(`ignored ${ignored.map((entry) => entry.name).join(", ")} (not a state name)`)
    const idle = folder(root)
    if (idle.length === 0) throw new Error("No PNG frames or GIF in the folder")
    return { states: { idle }, notes, name }
  }
  const states: ImportSource = {}
  const from = new Map<PetState, string>()
  const unknown = entries.filter((entry) => !named.includes(entry) && (entry.dir || isPicture(entry.name)))
  if (unknown.length > 0) notes.push(`ignored ${unknown.map((entry) => entry.name).join(", ")} (not a state name)`)
  // An entry named exactly like the state wins over an alias of it (`running/` over `typing/`).
  for (const entry of [...named].sort((a, b) => Number(PET_STATE_NAMES[stem(b.name).toLowerCase()] === stem(b.name).toLowerCase()) - Number(PET_STATE_NAMES[stem(a.name).toLowerCase()] === stem(a.name).toLowerCase()))) {
    const state = PET_STATE_NAMES[stem(entry.name).toLowerCase()]!
    if (from.has(state)) {
      notes.push(`ignored ${entry.name} (${from.get(state)} is already ${state})`)
      continue
    }
    const clipFrames = entry.dir ? folder(entry.file) : clip(entry.file)
    if (clipFrames.length === 0) {
      notes.push(`ignored ${entry.name} (no PNG frames or GIF)`)
      continue
    }
    states[state] = clipFrames
    from.set(state, entry.name)
  }
  if (from.size === 0) throw new Error("No frames in the state folders")
  // `thinking` was a name of `running` before it was a state: alone, it is still the working animation (and what thinking falls back to).
  if (states.thinking && !states.running) {
    states.running = states.thinking
    delete states.thinking
  }
  return { states, notes, name }
}
