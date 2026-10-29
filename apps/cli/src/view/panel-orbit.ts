import type { ColorName, Line } from "../ui/theme"
import { clip, fit, lineWidth, spread } from "./deck"
import { meter } from "./panel-card"
import { textWidth, truncateEnd } from "./wrap"

/** What the galaxy draws: the session's code graph has files and the symbols in them; `f` cycles through these. */
export const ORBIT_KINDS = ["file", "symbol"] as const
export type OrbitNode = {
  id: string
  /** `tool`, `agent` and `mcp` are kinds an older graph named; `openNode` still takes them. */
  kind: typeof ORBIT_KINDS[number] | "tool" | "agent" | "mcp"
  label: string
  target: string
  activity: number
  /** Last observed activity, epoch ms. */
  at?: number
  /** The name drawn next to the vertex when the label's last path segment is not enough to tell it apart. */
  short?: string
  /** A symbol's file node: the symbol is drawn next to it, so a file and its symbols form one cluster. */
  parent?: string
  /** A symbol's line in its file. */
  line?: number
}
/** How long a used node or link stays lit, ms: a spark runs along a link, then it glows, then it is warm, then it rests. */
export const ORBIT_FIRE = { spark: 600, lit: 1_500, warm: 6_000 } as const
/** What the galaxy is drawing: the session's activity, or the project's most connected files (`panel-orbit-code.ts`). `note` replaces the canvas with one muted line. */
export type OrbitView = { mode: "session" | "code"; note?: string | undefined; /** Code mode: links among the drawn files. */ links?: number | undefined }
/** The key that switches the galaxy between the session and the code. */
export const ORBIT_MODE_KEY = "m"
/** `touches` are the uses of a link (or of a node, `from === to`), each with the tool that made it; `at` is the newest. */
export type OrbitGraph = { nodes: OrbitNode[]; edges: Array<[string, string]>; omitted?: number; touches?: Array<{ from: string; to: string; at: number; tool?: string }>; at?: number }
/** `event` is the `from|to` key of the recent touch the user stepped to with `[` / `]`; its edge lights on the galaxy. */
export type OrbitCamera = { yaw: number; pitch: number; selected: number; zoom?: number; aspect?: number | undefined; filter?: typeof ORBIT_KINDS[number] | undefined; focused?: boolean; event?: string | undefined }
export type OrbitVelocity = { yaw: number; pitch: number }
export const ORBIT_FRAME_MS = 100
/** The galaxy moves while focused, while a turn runs, and while something it shows was used in the last few seconds (`lastAt`); then it rests. */
export const orbitAnimating = (visible: boolean, focused: boolean, busy: boolean, reduced: boolean, lastAt = 0, now = 0) => visible && !reduced && (focused || busy || (lastAt > 0 && now - lastAt >= 0 && now - lastAt < ORBIT_FIRE.warm))
const colors: Record<OrbitNode["kind"], ColorName> = { file: "success", symbol: "info", tool: "info", agent: "warning", mcp: "synType" }
const glyphs = { file: ["▪", "▣"], symbol: ["◇", "◆"], tool: ["+", "✦"], agent: ["◇", "◆"], mcp: ["○", "◉"] } as const
const marks = { file: "F", symbol: "S", tool: "T", agent: "A", mcp: "M" } as const
const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`
/** How far an arm winds from the core to the rim, in radians. */
const ARM_TURN = 5.2
/** Agents sit in the core; everything else is spread along the two arms from here out. */
const CORE = .14

/**
 * A fixed place in a two-armed spiral keyed by id: adding, sorting or filtering nodes never moves an existing one.
 * The disc lies in the x/z plane with radius 1; agents (the session and its sub-agents) are in the core.
 */
export function orbitPosition(id: string, kind?: OrbitNode["kind"]) {
  let hash = 2166136261
  for (let i = 0; i < id.length; i++) hash = Math.imul(hash ^ id.charCodeAt(i), 16777619)
  const index = (hash >>> 0) % 65521
  const along = (index + .5) / 65521, across = (index * 7919 % 1000) / 1000 - .5, lift = (index * 104729 % 1000) / 1000 - .5
  if (kind === "agent") {
    const radius = CORE * (.25 + .75 * (across + .5)), angle = along * Math.PI * 2
    return { x: Math.cos(angle) * radius, y: lift * .06, z: Math.sin(angle) * radius }
  }
  const radius = CORE + .1 + (1 - CORE - .1) * along, angle = radius * ARM_TURN + (index & 1) * Math.PI + across * .5
  return { x: Math.cos(angle) * radius, y: lift * .08 * (1 - radius), z: Math.sin(angle) * radius }
}

export function stepOrbit(camera: OrbitCamera, velocity: OrbitVelocity, reduced: boolean) {
  if (reduced) {
    velocity.yaw = 0
    velocity.pitch = 0
    return
  }
  camera.yaw += .018 + velocity.yaw
  camera.pitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, camera.pitch + velocity.pitch))
  velocity.yaw *= .72
  velocity.pitch *= .72
}

function projector(width: number, height: number, camera: OrbitCamera) {
  const cy = Math.cos(camera.yaw), sy = Math.sin(camera.yaw), cp = Math.cos(camera.pitch), sp = Math.sin(camera.pitch)
  // A cell is taller than wide by `aspect` (2 until the terminal reports its cell size); dividing rows by it keeps the silhouette round.
  const aspect = Math.max(1.5, Math.min(3, camera.aspect ?? 2))
  const radius = Math.max(.1, Math.min((width - 5) / 2, (height - 2) * aspect / 2)) * Math.max(.65, Math.min(1.35, camera.zoom ?? 1))
  // The near rim of a tilted disc is drawn larger than the far one, which would push the galaxy off centre; this puts it back.
  const centre = sp * cp * Math.sqrt(8) / (9 - cp * cp)
  return ({ x, y, z }: { x: number; y: number; z: number }) => {
    const rx = x * cy + z * sy, rz = z * cy - x * sy
    const ry = y * cp - rz * sp, depth = y * sp + rz * cp
    const perspective = Math.sqrt(8) / (3 - depth)
    return { x: (width - 1) / 2 + rx * radius * perspective, y: (height - 1) / 2 + (ry * perspective + centre) * radius / aspect, depth, perspective }
  }
}

/** A node's place: its own spot on the spiral, or for a symbol a spot close around its file's, fixed by its id. */
function placeOf(node: OrbitNode) {
  if (!node.parent) return orbitPosition(node.id, node.kind)
  const home = orbitPosition(node.parent, "file")
  const offset = orbitPosition(node.id, "agent")
  return { x: home.x + offset.x * 1.4, y: home.y + offset.y, z: home.z + offset.z * 1.4 }
}

export function projectOrbit(nodes: readonly OrbitNode[], width: number, height: number, camera: OrbitCamera) {
  const project = projector(width, height, camera)
  return nodes.slice(0, 96).flatMap((node, index) => camera.filter && node.kind !== camera.filter ? [] : [{ node, index, ...project(placeOf(node)) }]).map((point) => ({ ...point, x: Math.round(point.x), y: Math.round(point.y) }))
}
type Point = ReturnType<typeof projectOrbit>[number]
export const orbitNodeSize = (point: Point, camera: OrbitCamera) => point.depth > .45 || point.index === camera.selected && camera.focused !== false ? 1 : 0
export type OrbitLabel = { x: number; y: number; width: number; text: string; point: Point }

/** Nearest first, selected first while focused. Reserve node glyphs and a cell of padding around each label. */
export function orbitLabels(points: readonly Point[], width: number, height: number, camera: OrbitCamera, limit = 6, ascii = false, now = 0): OrbitLabel[] {
  const occupied = new Set<number>()
  for (const point of points) for (let dx = -orbitNodeSize(point, camera); dx <= orbitNodeSize(point, camera); dx++) occupied.add(point.y * width + point.x + dx)
  const labels: OrbitLabel[] = []
  // What just fired is named before what is merely near: the label follows the activity.
  const firing = (point: Point) => Number(!!now && !!point.node.at && now - point.node.at >= 0 && now - point.node.at < ORBIT_FIRE.warm)
  const sorted = [...points].sort((a, b) => Number(b.index === camera.selected && camera.focused !== false) - Number(a.index === camera.selected && camera.focused !== false) || firing(b) - firing(a) || b.depth - a.depth || a.node.id.localeCompare(b.node.id))
  for (const point of sorted) {
    if (labels.length >= limit) break
    const max = Math.min(18, Math.max(3, Math.floor(width / 3)))
    const raw = (point.node.short ?? point.node.label).replace(/[\x00-\x1f\x7f-\x9f]/g, "").split(/[\\/]/).at(-1) || point.node.kind
    const printable = ascii ? raw.replace(/[^\x20-\x7e]/g, "?") : raw
    let label = ""
    for (const char of printable) {
      if (textWidth(label + char) > max) break
      label += char
    }
    const size = textWidth(label), nodeSize = orbitNodeSize(point, camera)
    const candidates = [[point.x + nodeSize + 2, point.y], [point.x - nodeSize - 2 - size, point.y], [point.x + 2, point.y - 1], [point.x + 2, point.y + 1]]
    for (const [x = 0, y = 0] of candidates) {
      if (x < 1 || x + size >= width || y < 0 || y >= height) continue
      let blocked = false
      for (let dx = -1; dx <= size; dx++) if (occupied.has(y * width + x + dx)) {
        blocked = true
        break
      }
      if (blocked) continue
      labels.push({ x, y, width: size, text: label, point })
      for (let dx = -1; dx <= size; dx++) occupied.add(y * width + x + dx)
      break
    }
  }
  return labels
}

// Precompute the galaxy's dust once, outside the frame path: two arms that thin out toward the rim and a dense core.
// A fixed seed, so the same stars are drawn in every session and every frame.
const wire: Array<{ x: number; y: number; z: number; core?: true }> = []
{
  let seed = 7
  const random = () => (seed = seed * 16807 % 2147483647) / 2147483647
  for (let arm = 0; arm < 2; arm++) {
    for (let i = 0; i < 520; i++) {
      const radius = .08 + i / 520 * .97, angle = radius * ARM_TURN + arm * Math.PI, spread = .05 + radius * .09
      const x = Math.cos(angle) * radius + (random() - .5) * spread, y = (random() - .5) * .06 * (1 - radius), z = Math.sin(angle) * radius + (random() - .5) * spread
      // The projector fits radius 1 into the canvas with a clear column on each side; a star beyond it would be cut at the edge or drawn on the border.
      if (Math.hypot(x, z) <= 1) wire.push({ x, y, z })
    }
  }
  for (let i = 0; i < 110; i++) {
    const angle = random() * Math.PI * 2, radius = random() * CORE
    wire.push({ x: Math.cos(angle) * radius, y: (random() - .5) * .16, z: Math.sin(angle) * radius, core: true })
  }
}
export function orbitEdgeRole(a: number, b: number, lit = false): { fg: ColorName; dim: boolean } {
  return lit ? { fg: "warning", dim: false } : { fg: a + b >= 0 ? "border" : "muted", dim: a + b < 0 }
}

/** Bounded canvas, vertices, edges and wire geometry; no work proportional to session history. */
export function renderOrbit(graph: OrbitGraph, width: number, height: number, camera: OrbitCamera, ascii = false, live: { now?: number; busy?: boolean; reduced?: boolean } = {}, view: OrbitView = { mode: "session" }): Line[] {
  if (height <= 0) return []
  const code = view.mode === "code"
  // One status row under the canvas, never more: the counts at rest, the keys only while the panel has focus.
  const w = Math.min(80, Math.max(1, width)), h = Math.min(35, Math.max(0, height - 1))
  const points = projectOrbit(graph.nodes, w, h, camera)
  const links = view.links ?? graph.edges.length
  const sep = ascii ? " | " : " · "
  const kinds = code ? (["file"] as const) : ORBIT_KINDS
  // `▣ 12 files · ◆ 30 symbols · 41 links`; a narrow sheet drops the nouns, then the separators, rather than cut a count off.
  const legend = (named: boolean, dots: boolean): Line => [
    ...kinds.map((kind, index) => {
      const count = graph.nodes.filter((node) => node.kind === kind).length
      // A space after the mark: terminals that draw `▣` or `✦` two cells wide would otherwise cover the count.
      return { text: `${index ? dots ? sep : " " : ""}${ascii ? marks[kind] : glyphs[kind][1]} ${named ? plural(count, kind) : count}`, fg: colors[kind] }
    }),
    { text: `${dots ? sep : " "}${named ? plural(links, "link") : links}`, fg: "muted" as const },
    ...(camera.filter ? [{ text: ` [${camera.filter}]`, fg: "text" as const }] : []),
    ...(graph.omitted ? [{ text: ` +${graph.omitted}`, fg: "muted" as const }] : []),
  ]
  const node = graph.nodes[camera.selected]
  const shown = node && (!camera.filter || node.kind === camera.filter) ? node : undefined
  /** The first wording that fits the sheet; the shortest, cut, when none does. */
  const fitted = (variants: Line[]): Line => variants.find((line) => lineWidth(line) <= width) ?? variants.at(-1)!
  const mode = `${ORBIT_MODE_KEY} ${code ? "session" : "code"}`
  const keys = code ? [`hjkl · tab · enter · ${mode}`, `hjkl · tab · enter · ${ORBIT_MODE_KEY}`, "hjkl · tab"] : [`hjkl · tab · enter · f type · ${mode}`, `hjkl · tab · enter · f · ${ORBIT_MODE_KEY}`, "hjkl · tab"]
  const name = shown ? (shown.short ?? shown.label).replace(/[\x00-\x1f\x7f-\x9f]/g, "").split(/[\\/]/).at(-1) ?? "" : ""
  // While building (or off) the code view has no counts; a sheet with no canvas says its note here instead.
  const noted = code && view.note !== undefined
  // A type filter (`f`) stays named while it is on, ahead of the keys.
  const filter: Line = camera.filter ? [{ text: `[${camera.filter}] `, fg: "text" }] : []
  const status: Line = camera.focused
    ? fitted(keys.flatMap((hint) => [[...filter, ...(name && !noted ? [{ text: `${name} · `, fg: "warning" as const }] : []), { text: hint, fg: "muted" as const }], [...filter, { text: hint, fg: "muted" as const }]]))
    : noted ? h > 0 ? [] : [{ text: view.note!, fg: "muted" }] : fitted([legend(true, true), legend(false, true), legend(false, false)])
  const tail = [status]
  // The canvas is at most 80 cells; in a wider sheet it is centred instead of hugging the left edge.
  const margin = Math.max(0, Math.floor((width - w) / 2))
  const finish = (rows: Line[]) => [...rows.map((row) => (margin ? [{ text: " ".repeat(margin) }, ...row] : row)), ...tail].slice(-height).map((line) => fit(ascii ? line.map((span) => ({ ...span, text: span.text.replace(/·/g, "|").replace(/[^\x20-\x7e]/g, "?") })) : line, width))
  if (code && (view.note !== undefined || !points.length)) {
    // One muted line where the galaxy would be: building, off here, failed, or nothing to draw.
    const note = view.note ?? "No connected source files"
    return finish(Array.from({ length: h }, (_, y) => y === Math.floor(h / 2) ? [{ text: note, fg: "muted" }] : []))
  }
  if (!points.length) {
    const empty = graph.nodes.length === 0 ? ["No code touched yet", `${ORBIT_MODE_KEY} shows the project's code`] : [`No ${camera.filter} nodes yet`, "f cycles types"]
    return finish(Array.from({ length: h }, (_, y) => y === Math.floor(h / 2) ? [{ text: empty[0]!, fg: "muted" }] : y === Math.floor(h / 2) + 1 ? [{ text: empty[1]!, fg: "muted" }] : []))
  }
  const chars = Array.from({ length: h }, () => Array<string>(w).fill(" "))
  const roles = Array.from({ length: h }, () => Array<ColorName>(w).fill("border"))
  const dim = Array.from({ length: h }, () => Array<boolean>(w).fill(true))
  const bold = Array.from({ length: h }, () => Array<boolean>(w).fill(false))
  const dots = new Uint8Array(w * h), bright = new Uint8Array(w * h)
  const byId = new Map(points.map((point) => [point.node.id, point]))
  const put = (x: number, y: number, char: string, role: ColorName, faded = false, strong = false) => {
    if (x >= 0 && x < w && y >= 0 && y < h) {
      chars[y]![x] = char
      roles[y]![x] = role
      dim[y]![x] = faded
      bold[y]![x] = strong
    }
  }
  const project = projector(w, h, camera)
  const bits = [[1, 8], [2, 16], [4, 32], [64, 128]]
  for (const vertex of wire) {
    const point = project(vertex), sx = Math.round(point.x * 2), sy = Math.round(point.y * 4)
    const x = Math.floor(sx / 2), y = Math.floor(sy / 4)
    if (x < 0 || x >= w || y < 0 || y >= h) continue
    // The far half of the disc is thinner than the near half, which reads as depth; the core stays bright.
    if (point.depth < 0 && !vertex.core && (sx + sy) % 3 === 0) continue
    const at = y * w + x
    dots[at] = dots[at]! | bits[sy % 4]![sx % 2]!
    if (vertex.core) bright[at] = 1
    // The dust is the muted colour at full strength, never the terminal's dim attribute over the border colour: on a
    // transparent or busy background that pair is too faint to see.
    put(x, y, ascii ? "." : String.fromCharCode(0x2800 + dots[at]!), bright[at] ? "text" : "muted")
  }
  // Firing: how long ago each link and each node was last used. Nothing fires under reduced motion, and only the bounded touches are read.
  const now = live.now ?? 0
  const ageOf = (at: number | undefined) => (live.reduced || !at || !now || now < at ? Number.POSITIVE_INFINITY : now - at)
  const linkAt = new Map<string, number>()
  for (const touch of graph.touches ?? []) if (touch.from !== touch.to) linkAt.set(`${touch.from}|${touch.to}`, Math.max(linkAt.get(`${touch.from}|${touch.to}`) ?? 0, touch.at))
  for (const [from, to] of graph.edges.slice(0, 256)) {
    const a = byId.get(from), b = byId.get(to)
    if (!a || !b) continue
    const age = ageOf(linkAt.get(`${from}|${to}`))
    const chosen = camera.focused !== false && (a.index === camera.selected || b.index === camera.selected) || camera.event === `${from}|${to}`
    // A fresh use sends a spark from one end to the other; the whole link then glows, cools to the kind's colour and rests.
    const head = age < ORBIT_FIRE.spark ? age / ORBIT_FIRE.spark : 1
    const steps = Math.min(80, Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) * 2)
    for (let step = 1; step < steps; step++) {
      const t = step / steps, depth = a.depth + (b.depth - a.depth) * t
      const firing = age < ORBIT_FIRE.lit && t <= head
      const spark = age < ORBIT_FIRE.spark && Math.abs(t - head) <= 1 / steps
      const lit = chosen || firing
      const warm = !lit && age < ORBIT_FIRE.warm
      const role = warm ? { fg: colors[b.node.kind], dim: false } : orbitEdgeRole(depth, depth, lit)
      put(Math.round(a.x + (b.x - a.x) * t), Math.round(a.y + (b.y - a.y) * t), ascii ? spark ? "o" : lit ? "*" : "." : spark ? "●" : lit ? "•" : "·", role.fg, role.dim, lit)
    }
  }
  for (const point of [...points].sort((a, b) => Number(a.index === camera.selected && camera.focused !== false) - Number(b.index === camera.selected && camera.focused !== false) || a.depth - b.depth)) {
    const focused = point.index === camera.selected && camera.focused !== false
    const age = ageOf(point.node.at)
    const fired = age < ORBIT_FIRE.lit, warm = age < ORBIT_FIRE.warm
    const char = ascii ? marks[point.node.kind] : glyphs[point.node.kind][point.depth > .45 || focused || warm ? 1 : 0]
    const size = orbitNodeSize(point, camera), role = focused || fired ? "warning" : colors[point.node.kind]
    if (size) {
      put(point.x - 1, point.y, "[", role, false, true)
      put(point.x + 1, point.y, "]", role, false, true)
    }
    put(point.x, point.y, char, role, point.depth < 0 && !focused && !warm, point.depth > .45 || focused || warm)
  }
  for (const label of orbitLabels(points, w, h, camera, Math.min(6, Math.max(1, Math.floor(h / 2))), ascii, live.reduced ? 0 : now)) {
    let x = label.x
    for (const char of label.text) {
      const cells = textWidth(char)
      if (!cells) {
        if (x > label.x) chars[label.y]![x - 1] += char
        continue
      }
      put(x, label.y, char, label.point.index === camera.selected && camera.focused !== false ? "warning" : "text")
      if (cells === 2) put(x + 1, label.y, "", "text")
      x += cells
    }
  }
  const rows: Line[] = chars.map((row, y) => {
    const line: Line = []
    row.forEach((char, x) => {
      const role = roles[y]![x]!
      const last = line.at(-1)
      if (last?.fg === role && last.dim === dim[y]![x] && last.bold === bold[y]![x]) last.text += char
      else line.push({ text: char, fg: role, dim: dim[y]![x]!, bold: bold[y]![x]! })
    })
    return line
  })
  return finish(rows)
}

/** `now`, `12s ago`, `4m ago`, `3h ago`, `2d ago`. */
export function orbitAge(ms: number): string {
  if (ms < 1_000) return "now"
  if (ms < 60_000) return `${Math.floor(ms / 1_000)}s ago`
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`
  return `${Math.floor(ms / 86_400_000)}d ago`
}

export const ORBIT_RECENT = 12
export type OrbitTouch = NonNullable<OrbitGraph["touches"]>[number]
/** The latest touches, newest first and one per tool and node they landed on: the `recent` card's rows and the targets of `[` / `]`. */
export function orbitRecent(graph: OrbitGraph, limit = ORBIT_RECENT): OrbitTouch[] {
  const seen = new Set<string>()
  const out: OrbitTouch[] = []
  for (const touch of [...(graph.touches ?? [])].sort((a, b) => b.at - a.at || `${a.from}|${a.to}`.localeCompare(`${b.from}|${b.to}`))) {
    const key = `${touch.tool ?? touch.from}|${touch.to}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(touch)
    if (out.length >= limit) break
  }
  return out
}
export const orbitEventKey = (touch: OrbitTouch) => `${touch.from}|${touch.to}`

/** Moves the recent selection one event (`1` older, `-1` newer, wrapping) and selects the file it touched; returns false when there is nothing to step through. */
export function stepOrbitEvent(graph: OrbitGraph, camera: OrbitCamera, direction: 1 | -1): boolean {
  const events = orbitRecent(graph)
  if (!events.length) return false
  const at = camera.event ? events.findIndex((touch) => orbitEventKey(touch) === camera.event) : -1
  const next = events[(at < 0 ? direction === 1 ? 0 : events.length - 1 : (at + direction + events.length) % events.length)]!
  camera.event = orbitEventKey(next)
  const target = graph.nodes.findIndex((node) => node.id === next.to)
  if (target >= 0 && (!camera.filter || graph.nodes[target]!.kind === camera.filter)) camera.selected = target
  return true
}

const baseName = (label: string) => label.replace(/[\x00-\x1f\x7f-\x9f]/g, "").split(/[\\/]/).at(-1) || label

export type OrbitDetailRows = { focus: Line[]; recent: Line[]; top: Line[] }
/** Rows each lower card may take at most; the caller trims further to the height it has. */
export const ORBIT_CARD_ROWS = { focus: 7, recent: 8, top: 5 } as const

/**
 * The cards under the galaxy, drawn from the same graph: the focused node with its connections, the latest touches and the
 * busiest nodes. Pure and bounded (96 nodes, 256 edges); rows are exactly `width` cells.
 */
export function orbitDetails({ graph, camera, width, now, ascii = false, rows }: { graph: OrbitGraph; camera: OrbitCamera; width: number; now: number; ascii?: boolean; rows: { focus: number; recent: number; top: number } }): OrbitDetailRows {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]))
  const touchAt = new Map((graph.touches ?? []).flatMap((touch) => [[`${touch.from}|${touch.to}`, touch.at], [`${touch.to}|${touch.from}`, touch.at]] as const))
  const age = (at: number | undefined) => (at ? orbitAge(Math.max(0, now - at)) : "")
  const text = (value: string, fg: ColorName = "text", extra: { bold?: boolean } = {}): Line => fit([{ text: value, fg, ...extra }], width)
  // The right half (an age) keeps its place and the left gives way with an ellipsis; a row never loses its age to a long name.
  const pair = (left: Line, right: string, rightFg: ColorName = "muted"): Line => {
    const room = right ? width - textWidth(right) - 1 : width
    const shortened = lineWidth(left) > room ? [...clip(left, Math.max(0, room - 1)), { text: ascii ? "." : "…", fg: "muted" as const }] : left
    return fit(spread(shortened, right ? [{ text: right, fg: rightFg }] : [], width), width)
  }
  const glyph = (node: OrbitNode) => (ascii ? marks[node.kind] : glyphs[node.kind][1])
  const mark = (node: OrbitNode, selected: boolean): Line => [{ text: `${selected ? ascii ? ">" : "▸" : " "} `, fg: "warning" }, { text: `${glyph(node)} `, fg: colors[node.kind] }, { text: baseName(node.label), fg: selected ? "warning" : "text" }]

  const node = graph.nodes[camera.selected]
  const shown = node && (!camera.filter || node.kind === camera.filter) ? node : undefined
  const focus: Line[] = []
  if (!shown) focus.push(text("No node selected · tab", "muted"))
  else {
    focus.push(fit([{ text: `${glyph(shown)} `, fg: colors[shown.kind] }, { text: truncateEnd(shown.label.replace(/[\x00-\x1f\x7f-\x9f]/g, ""), Math.max(1, width - 2)), fg: "warning", bold: true }], width))
    const where = shown.kind === "symbol" && shown.target !== shown.label ? ` · ${baseName(shown.target)}${shown.line ? `:${shown.line}` : ""}` : ""
    focus.push(text(`${shown.kind}${where} · ${plural(shown.activity, "use")}${shown.at ? ` · ${age(shown.at)}` : ""}`, "muted"))
    const links = new Map<string, OrbitNode>()
    for (const [from, to] of graph.edges) {
      const other = from === shown.id ? byId.get(to) : to === shown.id ? byId.get(from) : undefined
      if (other) links.set(other.id, other)
    }
    const caption = { file: "symbols and links", symbol: "links", tool: "touched", mcp: "tools", agent: "links" }[shown.kind]
    const ordered = [...links.values()].sort((a, b) => (touchAt.get(`${shown.id}|${b.id}`) ?? b.at ?? 0) - (touchAt.get(`${shown.id}|${a.id}`) ?? a.at ?? 0) || b.activity - a.activity || a.id.localeCompare(b.id))
    if (!ordered.length) focus.push(text("No connections yet", "muted"))
    else {
      focus.push(text(caption, "muted"))
      const room = Math.max(0, rows.focus - focus.length)
      const list = ordered.length > room ? ordered.slice(0, Math.max(0, room - 1)) : ordered
      for (const other of list) focus.push(pair(mark(other, false), age(touchAt.get(`${shown.id}|${other.id}`) ?? other.at)))
      if (ordered.length > list.length) focus.push(text(`+${ordered.length - list.length} more`, "muted"))
    }
  }

  const events = orbitRecent(graph)
  const selectedAt = camera.event ? events.findIndex((touch) => orbitEventKey(touch) === camera.event) : -1
  const start = selectedAt >= rows.recent ? selectedAt - rows.recent + 1 : 0
  const arrow = ascii ? "->" : "→"
  const recent: Line[] = events.length ? events.slice(start, start + Math.max(1, rows.recent)).map((touch, offset) => {
    const selected = start + offset === selectedAt
    // `read → panel.ts`, `graph_callers → renderToolCard`: the tool that used the link and where it landed.
    const from = byId.get(touch.from), to = byId.get(touch.to)
    const source = touch.tool ?? (from ? baseName(from.label) : "tool")
    const left: Line = [{ text: selected ? ascii ? "> " : "▸ " : "  ", fg: "warning" }, { text: `${source} ${arrow} ${to ? baseName(to.label) : "node"}`, fg: selected ? "warning" : "text" }]
    return pair(left, age(touch.at))
  }) : [text("No code touched yet", "muted")]

  const busiest = [...graph.nodes].filter((candidate) => candidate.activity > 0).sort((a, b) => b.activity - a.activity || a.id.localeCompare(b.id)).slice(0, Math.max(1, rows.top))
  const peak = Math.max(1, ...busiest.map((candidate) => candidate.activity))
  // One meter column for every row: the same start and width, counts right-aligned in a column as wide as the widest count, and the
  // label (marker, glyph, name) takes what is left. A row's own number never moves the meter.
  const countCells = Math.max(...busiest.map((candidate) => String(candidate.activity).length))
  const barCells = Math.min(10, Math.max(3, Math.floor(width / 5)))
  const markCells = 4
  const labelCells = Math.max(1, width - markCells - 1 - barCells - 1 - countCells)
  const top: Line[] = busiest.length ? busiest.map((candidate) => {
    const selected = candidate === shown
    const left: Line = fit(mark({ ...candidate, label: truncateEnd(baseName(candidate.label), labelCells) }, selected), markCells + labelCells)
    const bar: Line = [...meter({ ratio: candidate.activity / peak, cells: barCells, color: colors[candidate.kind], ascii }), { text: ` ${String(candidate.activity).padStart(countCells)}`, fg: "muted" }]
    return fit([...left, { text: " " }, ...bar], width)
  }) : [text("No activity yet", "muted")]
  const plain = (lines: Line[]) => (ascii ? lines.map((line) => fit(line.map((span) => ({ ...span, text: span.text.replace(/·/g, "|").replace(/[^\x20-\x7e]/g, "?") })), width)) : lines)
  return { focus: plain(focus.slice(0, Math.max(1, rows.focus))), recent: plain(recent), top: plain(top) }
}
