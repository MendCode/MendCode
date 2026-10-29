import type { ColorName, Line } from "../ui/theme"
import { fit } from "./deck"
import { textWidth, truncateEnd } from "./wrap"

/**
 * The Atom card (docs/sidebar.md): what is running right now. The nucleus is the session; each of the three orbits carries one
 * kind of running work (tool calls, sub-agents, background jobs) and one electron per item. An idle session is a bare nucleus.
 * Pure and bounded: at most `ATOM_ELECTRONS` electrons per orbit, a canvas of at most 48 by 13 cells, nothing kept between frames.
 */
export const ATOM_KINDS = ["tool", "agent", "job"] as const
export type AtomKind = typeof ATOM_KINDS[number]
export type AtomItem = { kind: AtomKind; label: string }
export const ATOM_ELECTRONS = 8
export const ATOM_FRAME_MS = 100
/** Rows the card asks for when the bar has them: the canvas, the count row and three names. */
export const ATOM_ROWS = 15
export const atomAnimating = (visible: boolean, running: number, reduced: boolean) => visible && !reduced && running > 0

const colors: Record<AtomKind, ColorName> = { tool: "info", agent: "warning", job: "success" }
const glyphs: Record<AtomKind, string> = { tool: "✦", agent: "◆", job: "▣" }
const marks: Record<AtomKind, string> = { tool: "T", agent: "A", job: "J" }
/** Each orbit's tilt around the view axis, its radius, and how many seconds an electron takes to go round. */
const orbits: Record<AtomKind, { tilt: number; radius: number; period: number }> = {
  tool: { tilt: 0, radius: 1, period: 4 },
  agent: { tilt: 1.05, radius: .84, period: 7 },
  job: { tilt: -1.05, radius: .84, period: 11 },
}
const YAW = .5, PITCH = .3
const RING_DOTS = 120

const onOrbit = (kind: AtomKind, angle: number) => {
  const { tilt, radius } = orbits[kind]
  const x = Math.cos(angle) * radius, z = Math.sin(angle) * radius
  return { x: x * Math.cos(tilt), y: x * Math.sin(tilt), z }
}

/** Where the electrons of one orbit are at `now`: evenly spaced, each orbit at its own pace. */
export function atomElectrons(kind: AtomKind, count: number, now: number) {
  const shown = Math.min(ATOM_ELECTRONS, Math.max(0, count))
  const phase = now / 1000 / orbits[kind].period * Math.PI * 2
  return Array.from({ length: shown }, (_, index) => onOrbit(kind, phase + index * Math.PI * 2 / shown))
}

export function renderAtom({ items, width, height, now, running = false, reduced = false, ascii = false, aspect = 2 }: { items: readonly AtomItem[]; width: number; height: number; now: number; running?: boolean; reduced?: boolean; ascii?: boolean; aspect?: number }): Line[] {
  if (height <= 0 || width <= 0) return []
  const counts = Object.fromEntries(ATOM_KINDS.map((kind) => [kind, items.filter((item) => item.kind === kind).length])) as Record<AtomKind, number>
  const sep = ascii ? " | " : " · "
  const legend = (named: boolean): Line => ATOM_KINDS.flatMap((kind, index) => [{ text: `${index ? named ? sep : " " : ""}${ascii ? marks[kind] : glyphs[kind]} ${counts[kind]}${named ? ` ${kind}${counts[kind] === 1 ? "" : "s"}` : ""}`, fg: counts[kind] ? colors[kind] : "muted" as ColorName }])
  const count = [legend(true), legend(false)].find((line) => line.reduce((sum, span) => sum + textWidth(span.text), 0) <= width) ?? legend(false)
  const names = (rows: number): Line[] => {
    if (rows <= 0) return []
    if (!items.length) return [[{ text: running ? "Thinking, nothing else running" : "Idle, nothing running", fg: "muted" }]]
    const shown = items.slice(0, items.length > rows ? rows - 1 : rows)
    return [
      ...shown.map((item): Line => [{ text: `${ascii ? marks[item.kind] : glyphs[item.kind]} `, fg: colors[item.kind] }, { text: truncateEnd(item.label.replace(/[\x00-\x1f\x7f-\x9f]/g, " "), Math.max(1, width - 2)), fg: "text" }]),
      ...(items.length > shown.length ? [[{ text: `+${items.length - shown.length} more`, fg: "muted" as ColorName }]] : []),
    ]
  }
  const finish = (rows: Line[]) => rows.slice(0, height).map((line) => fit(ascii ? line.map((span) => ({ ...span, text: span.text.replace(/·/g, "|").replace(/[^\x20-\x7e]/g, "?") })) : line, width))
  // Too short for a drawing worth reading: the counts and the names are the card.
  if (height < 8 || width < 16) return finish([count, ...names(height - 1)])

  const below = Math.min(3, Math.max(1, items.length), height - 8)
  const w = Math.min(48, width), h = Math.min(13, height - 1 - below)
  const ratio = Math.max(1.5, Math.min(3, aspect))
  // The tilted orbits reach about two thirds of the radius up and down, so a short canvas can draw the atom that much larger.
  const radius = Math.max(.1, Math.min((w - 3) / 2, (h - 1) * ratio / 2 / .66))
  const cy = Math.cos(YAW), sy = Math.sin(YAW), cp = Math.cos(PITCH), sp = Math.sin(PITCH)
  const project = ({ x, y, z }: { x: number; y: number; z: number }) => {
    const rx = x * cy + z * sy, rz = z * cy - x * sy
    const ry = y * cp - rz * sp, depth = y * sp + rz * cp
    const perspective = 2.6 / (3.4 - depth)
    return { x: (w - 1) / 2 + rx * radius * perspective, y: (h - 1) / 2 + ry * radius / ratio * perspective, depth }
  }
  const chars = Array.from({ length: h }, () => Array<string>(w).fill(" "))
  const roles = Array.from({ length: h }, () => Array<ColorName>(w).fill("border"))
  const dim = Array.from({ length: h }, () => Array<boolean>(w).fill(true))
  const bold = Array.from({ length: h }, () => Array<boolean>(w).fill(false))
  const dots = new Uint8Array(w * h)
  const put = (x: number, y: number, char: string, role: ColorName, faded: boolean, strong: boolean) => {
    if (x < 0 || x >= w || y < 0 || y >= h) return
    chars[y]![x] = char
    roles[y]![x] = role
    dim[y]![x] = faded
    bold[y]![x] = strong
  }
  const bits = [[1, 8], [2, 16], [4, 32], [64, 128]]
  for (const kind of ATOM_KINDS) {
    // An orbit with work on it is drawn in its colour; an empty one stays a faint track.
    const busy = counts[kind] > 0
    for (let i = 0; i < RING_DOTS; i++) {
      const point = project(onOrbit(kind, i / RING_DOTS * Math.PI * 2)), sx = Math.round(point.x * 2), sy2 = Math.round(point.y * 4)
      const x = Math.floor(sx / 2), y = Math.floor(sy2 / 4)
      if (x < 0 || x >= w || y < 0 || y >= h) continue
      if (point.depth < 0 && i % 2) continue
      const at = y * w + x
      dots[at] = dots[at]! | bits[sy2 % 4]![sx % 2]!
      put(x, y, ascii ? "." : String.fromCharCode(0x2800 + dots[at]!), busy ? colors[kind] : "border", true, false)
    }
  }
  const centre = project({ x: 0, y: 0, z: 0 }), cx = Math.round(centre.x), cyRow = Math.round(centre.y)
  put(cx, cyRow, ascii ? running ? "@" : "o" : running ? "◉" : "○", running ? "warning" : "muted", !running, running)
  const moment = reduced ? 0 : now
  for (const kind of ATOM_KINDS) {
    for (const electron of atomElectrons(kind, counts[kind], moment)) {
      const point = project(electron)
      put(Math.round(point.x), Math.round(point.y), ascii ? marks[kind] : glyphs[kind], colors[kind], false, point.depth >= 0)
    }
  }
  const canvas: Line[] = chars.map((row, y) => {
    const line: Line = []
    row.forEach((char, x) => {
      const role = roles[y]![x]!, last = line.at(-1)
      if (last?.fg === role && last.dim === dim[y]![x] && last.bold === bold[y]![x]) last.text += char
      else line.push({ text: char, fg: role, dim: dim[y]![x]!, bold: bold[y]![x]! })
    })
    return line
  })
  // The canvas is at most 48 cells; in a wider card it is centred.
  const margin = Math.max(0, Math.floor((width - w) / 2))
  return finish([...canvas.map((row) => (margin ? [{ text: " ".repeat(margin) }, ...row] : row)), count, ...names(below)])
}
