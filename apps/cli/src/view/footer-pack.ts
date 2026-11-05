import { FOOTER_PACK_DEFAULT, FOOTER_PACK_OFF, footerPackProblems, quotaReadings, type FooterPackFile, type FooterPackGlyphSet, type FooterPackLook, type FooterPackSegment, type QuotaReading, type QuotaSnapshotLike } from "@mendcode/protocol/wire"
import type { PermissionMode } from "@mendcode/protocol"
import { COLOR_NAMES } from "../themes/define"
import type { ColorName, Line, Span } from "../ui/theme"
import { META_MARGIN, PROMPT_MARGIN } from "./prompt-chrome"
import { truncateEnd } from "./session-list"
import { lineWidth as widthOf, textWidth } from "./wrap"
import clean from "./footer-packs/clean"
import powerline from "./footer-packs/powerline"
import minimal from "./footer-packs/minimal"
import badges from "./footer-packs/badges"
import bars from "./footer-packs/bars"
import plain from "./footer-packs/plain"

/**
 * Footer packs (docs/customize.md "Footer packs"): one data file is a whole footer look. This module reads the file into rows; the
 * chrome (ui/app/chrome.ts) decides when a pack draws at all (never over a footer the user made) and gathers the facts it shows.
 * Each segment draws nothing when it has nothing to say, so a quiet session has a quiet footer.
 */

/** The built-in packs, in the order `/footer pack` lists them. Adding one is a data file in footer-packs/ and a line here. */
export const BUILTIN_FOOTER_PACKS: Readonly<Record<string, FooterPackFile>> = { clean, powerline, minimal, badges, bars, plain }

let filePacks: Readonly<Record<string, FooterPackFile>> = {}

export type FooterPackProblem = { name: string; message: string }

/** Pack files from the layers (a profile's, the user's and the project's `footer-packs/`): a file wins over a built-in of the same name. */
export function registerFooterPacks(files: ReadonlyArray<{ name: string; json?: unknown; problem?: string | undefined }>): FooterPackProblem[] {
  const packs: Record<string, FooterPackFile> = {}
  const problems: FooterPackProblem[] = []
  for (const file of files) {
    const problem = file.problem ?? footerPackProblems(file.json)[0] ?? rolesProblem(file.json as FooterPackFile)
    if (problem) problems.push({ name: file.name, message: problem })
    else packs[file.name] = file.json as FooterPackFile
  }
  filePacks = packs
  return problems
}

const ROLES = new Set<string>(COLOR_NAMES)
function rolesProblem(pack: FooterPackFile): string | undefined {
  for (const key of ["colors", "backgrounds"] as const) for (const [name, role] of Object.entries(pack[key] ?? {})) if (!ROLES.has(role)) return `${key}.${name}: "${role}" is not a theme role`
  return undefined
}

/** Every pack name `footerPack` can take now: the built-ins, then the files' own. */
export const footerPackNames = (): string[] => [...new Set([...Object.keys(BUILTIN_FOOTER_PACKS), ...Object.keys(filePacks)])]

/** The pack `name` names; an unknown name is the default pack (a pack that left with its profile does not leave the footer blank). */
export function footerPackNamed(name: string): FooterPackFile | undefined {
  if (name === FOOTER_PACK_OFF) return undefined
  return filePacks[name] ?? BUILTIN_FOOTER_PACKS[name] ?? BUILTIN_FOOTER_PACKS[FOOTER_PACK_DEFAULT]
}

/** The glyph set a pack is drawn with: the terminal's, or `text` (no symbol at all) for `footerPackSymbols: text` and a screen reader. */
export type PackGlyphs = FooterPackGlyphSet | "text"

const FALLBACK: Record<FooterPackGlyphSet, readonly FooterPackGlyphSet[]> = { nerd: ["nerd", "unicode", "ascii"], unicode: ["unicode", "ascii"], ascii: ["ascii"] }

/** The pack's look for a glyph set: its text form, with the first glyph set it gives along the fallback (nerd → unicode → ascii) over it. */
export function packLook(pack: FooterPackFile, glyphs: PackGlyphs): FooterPackLook {
  const base: FooterPackLook = { ...pack }
  if (glyphs === "text") return base
  const found = FALLBACK[glyphs].map((set) => pack.symbols?.[set]).find((look) => look !== undefined)
  if (!found) return base
  return { ...base, ...found, icons: { ...base.icons, ...found.icons }, labels: { ...base.labels, ...found.labels } }
}

/** What the footer can say this frame; each field absent when there is nothing to show. */
export type PackFacts = {
  /** The settings area of this folder when it is not `personal`: its rules apply, so it leads the first row. */
  area?: string
  directory?: string
  branch?: string
  git?: { staged: number; unstaged: number; untracked: number; conflicts?: number; ahead?: number; behind?: number }
  diff?: { added: number; removed: number }
  model?: string
  /** Priority processing's mark, and whether this model gets it. */
  fast?: { mark: string; applies: boolean }
  effort?: string
  adaptive?: boolean
  context?: { tokens: number; limit: number; approx?: boolean; label?: string }
  quotas?: readonly QuotaSnapshotLike[]
  costMicros?: number
  /** A PR review running for another session's watch (`reviewing Symbex-1#25`); the watching session shows it at work instead. */
  reviewing?: string
  jobs?: number
  loops?: number
  workflows?: number
  /** Children (sessions another session started) waiting for approval whose card is in another session than the open one; `/approvals` goes there. */
  childApprovals?: number
  agents?: number
  waiting?: number
  goal?: Line
  /** The agent that answers (`Build`, `Plan`). */
  mode?: string
  modeColor?: Pick<Span, "fg" | "fgHex">
  permission?: PermissionMode
  permissionLabel?: string
  connection?: "connected" | "reconnecting" | "closed"
  /** The counters and hints the row ends with (`ctrl-p commands`, an Mflow wait). */
  hints?: Line
  now: number
}

/** A segment the user must always see: an agent that acts without asking, a lost connection. They never give way and are added when a pack leaves them out. */
const KEPT: ReadonlySet<FooterPackSegment> = new Set(["permission", "connection"])
/** When a row is too narrow the lowest rank gives way first, the later of equal rank before the earlier. */
const RANK: Readonly<Record<FooterPackSegment, number>> = { area: 6, hints: 1, cost: 2, diff: 3, effort: 3, jobs: 4, agents: 5, directory: 4, branch: 5, git: 5, quota: 6, goal: 7, mode: 7, model: 8, context: 9, permission: 99, connection: 99 }
const PERMISSION_COLOR: Record<PermissionMode, ColorName> = { ask: "muted", smart: "info", edits: "warning", full: "error", plan: "heading" }
const PIE = ["○", "◔", "◑", "◕", "●"] as const

type Part = { id: FooterPackSegment; spans: Span[]; compact?: Span[]; bg?: ColorName; chip?: string }

/** Tokens as a budget reads them: 812, 9.4K, 48K, 1.2M. */
function short(value: number): string {
  if (value < 1000) return String(Math.round(value))
  if (value < 10_000) return `${(value / 1000).toFixed(1).replace(/\.0$/, "")}K`
  if (value < 1e6) return `${Math.round(value / 1000)}K`
  return `${(value / 1e6).toFixed(1).replace(/\.0$/, "")}M`
}

/** `▕██▌░░░▏` (or `[###...]` in ASCII): `percent` of six cells, in eighths. */
export function packBar(percent: number, ascii: boolean): string {
  const cells = 6
  const clamped = Math.max(0, Math.min(100, percent))
  if (ascii) {
    const filled = Math.round((clamped / 100) * cells)
    return `[${"#".repeat(filled)}${".".repeat(cells - filled)}]`
  }
  const eighths = Math.round((clamped / 100) * cells * 8)
  const full = Math.floor(eighths / 8)
  const part = eighths % 8
  const partial = part ? "▏▎▍▌▋▊▉"[part - 1]! : ""
  return `▕${"█".repeat(full)}${partial}${"░".repeat(cells - full - (partial ? 1 : 0))}▏`
}

export const pieGlyph = (percent: number) => PIE[Math.max(0, Math.min(4, Math.round(Math.max(0, Math.min(100, percent)) / 25)))]!

type Built = { spans: Span[]; compact?: Span[]; tone?: ColorName } | undefined

/** The words before a figure: the pack's icon and label for `id`, then `fallback` when the pack names no label. */
function lead(look: FooterPackLook, id: FooterPackSegment, fallback = ""): Span[] {
  const icon = look.icons?.[id]
  const label = look.labels?.[id] ?? fallback
  return [...(icon ? [{ text: `${icon} `, fg: "primary" as const }] : []), ...(label ? [{ text: `${label} `, fg: "muted" as const }] : [])]
}

function segment(id: FooterPackSegment, facts: PackFacts, pack: FooterPackFile, look: FooterPackLook, glyphs: PackGlyphs): Built {
  const color = (fallback: ColorName): ColorName => (pack.colors?.[id] as ColorName | undefined) ?? fallback
  const ascii = glyphs === "ascii" || glyphs === "text"
  const [warnAt, errorAt] = pack.contextWarn ?? [70, 90]
  switch (id) {
    case "area":
      return facts.area ? { spans: [...lead(look, id, ascii ? "" : "◆"), { text: facts.area, fg: color("heading"), bold: true }] } : undefined
    case "directory": {
      if (!facts.directory) return undefined
      const base = facts.directory.split(/[\\/]/).filter(Boolean).at(-1) ?? facts.directory
      return { spans: [...lead(look, id), { text: facts.directory, fg: color("body") }], ...(base !== facts.directory ? { compact: [...lead(look, id), { text: base, fg: color("body") }] } : {}) }
    }
    case "branch":
      return facts.branch ? { spans: [...lead(look, id), { text: facts.branch, fg: color("secondary") }] } : undefined
    case "git": {
      if (!facts.branch) return undefined
      const git = facts.git
      const marks: Span[] = []
      const mark = (text: string, fg: ColorName) => marks.push({ text: ` ${text}`, fg })
      if (git?.conflicts) mark(`!${git.conflicts}`, "error")
      if (git?.staged) mark(`+${git.staged}`, "success")
      if (git?.unstaged) mark(`*${git.unstaged}`, "warning")
      if (git?.untracked) mark(`?${git.untracked}`, "muted")
      if (git?.ahead) mark(`${ascii ? "^" : "↑"}${git.ahead}`, "info")
      if (git?.behind) mark(`${ascii ? "v" : "↓"}${git.behind}`, "info")
      const name: Span[] = [...lead(look, id), { text: facts.branch, fg: color("secondary") }]
      return { spans: [...name, ...marks], ...(marks.length ? { compact: name } : {}) }
    }
    case "diff":
      return facts.diff && facts.diff.added + facts.diff.removed > 0 ? { spans: [...lead(look, id), { text: `+${facts.diff.added}`, fg: "success" }, { text: ` -${facts.diff.removed}`, fg: "error" }] } : undefined
    case "model":
      return facts.model ? { spans: [...lead(look, id), { text: facts.model, fg: color("text") }, ...(facts.fast ? [{ text: ` ${facts.fast.mark}${facts.fast.applies ? "" : " n/a"}`, fg: facts.fast.applies ? "warning" as const : "muted" as const }] : [])] } : undefined
    case "effort":
      return facts.effort ? { spans: [...lead(look, id), { text: facts.effort, fg: color("muted") }, ...(facts.adaptive ? [{ text: ":JEV", fg: "primary" as const }] : [])] } : undefined
    case "context": {
      const context = facts.context
      if (!context || context.limit <= 0) return undefined
      const percent = Math.round((context.tokens / context.limit) * 100)
      const tone: ColorName = percent >= errorAt ? "error" : percent >= warnAt ? "warning" : color("muted")
      const figure = `${context.approx ? "~" : ""}${percent}%`
      const word = pack.words && percent >= warnAt ? (percent >= errorAt ? " near limit" : " high") : ""
      const label = context.label ?? "ctx"
      const shape = look.context === "pie" && ascii ? "percent" : look.context ?? "percent"
      const text = shape === "pie" ? `${pieGlyph(percent)} ${figure}` : shape === "fraction" ? `${short(context.tokens)}/${short(context.limit)}` : shape === "bar" ? `${packBar(percent, ascii)} ${figure}` : figure
      const spans: Span[] = [...lead(look, id, shape === "percent" || shape === "bar" ? label : ""), { text: `${text}${word}`, fg: tone }]
      return { spans, ...(shape === "bar" || shape === "fraction" ? { compact: [...lead(look, id, label), { text: `${figure}${word}`, fg: tone }] } : {}), tone }
    }
    case "quota": {
      const readings = quotaReadings(facts.quotas ?? [], facts.now).filter((reading) => !reading.stale)
      const below = pack.quotaBelow ?? 20
      const shown = readings.filter((reading) => reading.leftPercent < below)
      if (!shown.length) return undefined
      const providers = new Set(readings.map((reading) => reading.provider)).size
      const one = (reading: QuotaReading, bar: boolean): Span[] => {
        const tone: ColorName = reading.leftPercent < 10 ? "error" : reading.leftPercent < 20 ? "warning" : color("muted")
        const name = `${providers > 1 ? `${reading.provider} ` : ""}${reading.window}`
        const word = pack.words && reading.leftPercent < 20 ? " low" : ""
        return [{ text: `${name} `, fg: "muted" }, { text: `${bar ? `${packBar(reading.usedPercent, ascii)} ` : ""}${reading.leftPercent}% left${word}`, fg: tone }]
      }
      const join = (bar: boolean) => shown.flatMap((reading, at) => [...(at ? [{ text: look.separator ?? " · ", fg: "muted" as const }] : []), ...one(reading, bar)])
      const lowest = shown.reduce((low, reading) => (reading.leftPercent < low.leftPercent ? reading : low))
      const tone: ColorName = lowest.leftPercent < 10 ? "error" : "warning"
      return { spans: [...lead(look, id), ...join(look.quota === "bar")], compact: [...lead(look, id), ...one(lowest, false)], tone }
    }
    case "cost":
      return facts.costMicros !== undefined && facts.costMicros >= 5_000 ? { spans: [...lead(look, id), { text: `$${(facts.costMicros / 1e6).toFixed(2)}`, fg: color("text") }] } : undefined
    case "jobs":
      return facts.jobs ? { spans: [...lead(look, id), { text: `${facts.jobs} shell${facts.jobs === 1 ? "" : "s"}`, fg: color("secondary") }] } : undefined
    case "agents": {
      const words = [
        ...(facts.reviewing ? [facts.reviewing] : []),
        ...(facts.agents ? [`${facts.agents} agent${facts.agents === 1 ? "" : "s"}`] : []),
        ...(facts.loops ? [`${facts.loops} loop${facts.loops === 1 ? "" : "s"}`] : []),
        ...(facts.workflows ? [`${facts.workflows} workflow${facts.workflows === 1 ? "" : "s"}`] : []),
        ...(facts.childApprovals ? [`${facts.childApprovals} child approval${facts.childApprovals === 1 ? "" : "s"}`] : []),
      ]
      if (!words.length) return undefined
      return { spans: [...lead(look, id), { text: words.join(" "), fg: facts.waiting ? "warning" : color("secondary") }, ...(facts.childApprovals ? [{ text: " · /approvals", fg: "warning" as const }] : facts.waiting ? [{ text: " · needs input", fg: "warning" as const }] : [])] }
    }
    case "goal":
      return facts.goal?.length ? { spans: [...facts.goal] } : undefined
    case "mode": {
      if (!facts.mode) return undefined
      // The default agent is named only on a badge: a plain row says the agent when it is not the one that always answers.
      if (!pack.backgrounds?.mode && facts.mode.toLowerCase() === "build") return undefined
      return { spans: [...lead(look, id), { text: facts.mode, fg: color("heading"), ...facts.modeColor, bold: true }] }
    }
    case "permission": {
      if (!facts.permission || facts.permission === "ask") return undefined
      // Plan mode is named once: the agent already says `Plan`.
      if (facts.permission === "plan" && facts.mode?.toLowerCase() === "plan") return undefined
      return { spans: [...lead(look, id), { text: facts.permissionLabel ?? facts.permission, fg: PERMISSION_COLOR[facts.permission], bold: true }], tone: PERMISSION_COLOR[facts.permission] }
    }
    case "connection":
      return facts.connection && facts.connection !== "connected" ? { spans: [{ text: facts.connection === "reconnecting" ? "offline · reconnecting…" : "disconnected", fg: "warning" }], tone: "warning" } : undefined
    case "hints":
      return facts.hints?.length ? { spans: facts.hints.map((span) => (span.text.startsWith("  ") ? { ...span, text: span.text.trimStart() } : span)) } : undefined
  }
}

/** A part drawn as a chip: one colour on a fill (` PLAN `), or the text in its colour between brackets (`[PLAN]`). */
function chipOf(part: Part, look: FooterPackLook, pack: FooterPackFile, spans: Span[]): Span[] {
  const text = spans.map((span) => span.text).join("")
  const upper = part.id === "mode" || part.id === "permission" ? text.toUpperCase() : text
  const fill = part.bg!
  if (look.chips === "brackets" && look.style !== "powerline") return [{ text: `[${upper}]`, fg: fill, bold: true }]
  const dark = fill === "element" || fill === "panel" || fill === "promptBg"
  const fg = (pack.colors?.[part.id] as ColorName | undefined) ?? (dark ? "text" : "background")
  return [{ text: ` ${upper} `, fg, bg: fill, bold: part.id === "mode" || part.id === "permission" }]
}

/** One side of a row as drawn: parts joined by the separator, chips as chips, powerline arrows between fills. */
function drawSide(parts: readonly Part[], side: "left" | "right", look: FooterPackLook, pack: FooterPackFile, compacted: ReadonlySet<Part>): Line {
  const line: Line = []
  const powerline = look.style === "powerline"
  parts.forEach((part, at) => {
    const spans = compacted.has(part) && part.compact ? part.compact : part.spans
    if (!powerline) {
      // Two filled chips side by side need only a gap: the fill already parts them.
      const chips = part.bg && parts[at - 1]?.bg && look.chips !== "brackets"
      if (at) line.push(chips ? { text: " " } : { text: look.separator ?? " · ", fg: "muted" })
      line.push(...(part.bg ? chipOf(part, look, pack, spans) : spans))
      return
    }
    const previous = parts[at - 1]
    if (side === "left" && at === 0 && look.caps?.start) line.push({ text: look.caps.start, fg: part.bg! })
    if (side === "left" && previous && look.arrows?.left) line.push({ text: look.arrows.left, fg: previous.bg!, bg: part.bg! })
    if (side === "right" && look.arrows?.right) line.push({ text: look.arrows.right, fg: part.bg!, ...(previous ? { bg: previous.bg! } : {}) })
    line.push(...chipOf(part, look, pack, spans))
  })
  const last = parts.at(-1)
  if (powerline && last) {
    if (side === "left" && look.arrows?.left) line.push({ text: look.arrows.left, fg: last.bg! })
    if (side === "right" && look.caps?.end) line.push({ text: look.caps.end, fg: last.bg! })
  }
  return line
}

/** The parts of one side: the segments with something to say, each with its fill when the pack draws it as a chip. */
function sideParts(ids: readonly FooterPackSegment[], facts: PackFacts, pack: FooterPackFile, look: FooterPackLook, glyphs: PackGlyphs): Part[] {
  return ids.flatMap((id): Part[] => {
    const built = segment(id, facts, pack, look, glyphs)
    if (!built || !built.spans.length) return []
    const named = pack.backgrounds?.[id] as ColorName | undefined
    // In a chip a state's colour is the fill: the context turns amber and red, a permission takes its own colour.
    const bg = look.style === "powerline" ? ((id === "context" || id === "quota" || id === "permission" || id === "connection") && built.tone && built.tone !== "muted" && built.tone !== (pack.colors?.[id] as string | undefined) ? built.tone : named ?? "element") : named ? (id === "permission" && built.tone ? built.tone : named) : undefined
    return [{ id, spans: built.spans, ...(built.compact ? { compact: built.compact } : {}), ...(bg ? { bg } : {}) }]
  })
}

/**
 * The pack's rows for this frame, each at most `width` cells with the status row's margins, as many as `limit` allows. A row with
 * nothing to say is left out; the first row always stands (a footer that comes and goes would move the prompt). A row too narrow
 * gives each part its shorter form, the lowest rank first, then drops parts the same way; a permission or a lost connection stays.
 */
export function renderFooterPack({ pack, facts, width, glyphs, limit }: { pack: FooterPackFile; facts: PackFacts; width: number; glyphs: PackGlyphs; limit: number }): Line[] {
  const look = packLook(pack, glyphs)
  const room = Math.max(0, width - META_MARGIN - PROMPT_MARGIN)
  const placed = new Set(pack.rows.flatMap((row) => [...(row.left ?? []), ...(row.right ?? [])]))
  const rows = pack.rows.map((row, index) => ({
    // The area leads the first row when the pack does not place it: the rules of that area apply to this folder.
    left: index === 0 && !placed.has("area") ? ["area" as const, ...(row.left ?? [])] : row.left ?? [],
    // What must always show joins the first row's right side when the pack does not place it.
    right: index === 0 ? [...[...KEPT].filter((id) => !placed.has(id)), ...(row.right ?? [])] : row.right ?? [],
  }))
  const lines: Line[] = []
  for (const row of rows) {
    if (lines.length >= Math.max(1, limit)) break
    const left = sideParts(row.left, facts, pack, look, glyphs)
    const right = sideParts(row.right, facts, pack, look, glyphs)
    if (!left.length && !right.length) continue
    lines.push([{ text: " ".repeat(META_MARGIN) }, ...fitRow({ left, right, room, look, pack })])
  }
  return lines.length ? lines : [[{ text: " ".repeat(META_MARGIN) }]]
}

function fitRow({ left, right, room, look, pack }: { left: Part[]; right: Part[]; room: number; look: FooterPackLook; pack: FooterPackFile }): Line {
  const compacted = new Set<Part>()
  const draw = () => {
    const l = drawSide(left, "left", look, pack, compacted)
    const r = drawSide(right, "right", look, pack, compacted)
    return { l, r, width: widthOf(l) + widthOf(r) + (l.length && r.length ? 2 : 0) }
  }
  const rank = (part: Part) => (KEPT.has(part.id) ? Number.POSITIVE_INFINITY : RANK[part.id])
  const lowest = (parts: Part[]) => {
    const least = Math.min(...parts.map(rank))
    return parts.findLast((part) => rank(part) === least)!
  }
  let drawn = draw()
  while (drawn.width > room) {
    const shorter = [...left, ...right].filter((part) => part.compact && !compacted.has(part))
    if (!shorter.length) break
    compacted.add(lowest(shorter))
    drawn = draw()
  }
  while (drawn.width > room) {
    const droppable = [...left, ...right].filter((part) => !KEPT.has(part.id))
    if (droppable.length <= (left.length + right.length === droppable.length ? 1 : 0)) break
    const drop = lowest(droppable)
    for (const side of [left, right]) if (side.includes(drop)) side.splice(side.indexOf(drop), 1)
    drawn = draw()
  }
  const { l, r } = drawn
  if (drawn.width > room) return cut([...l, ...(r.length ? [{ text: "  " }, ...r] : [])], room)
  return r.length ? [...l, { text: " ".repeat(Math.max(l.length ? 2 : 0, room - widthOf(l) - widthOf(r))) }, ...r] : l
}

function cut(line: Line, width: number): Line {
  const out: Line = []
  let used = 0
  for (const span of line) {
    const w = textWidth(span.text)
    if (used + w <= width) {
      out.push(span)
      used += w
      continue
    }
    const text = truncateEnd(span.text, width - used)
    if (text) out.push({ ...span, text })
    break
  }
  return out
}

export type FooterPackPatch = { footerPack?: string; footerPackSymbols?: "auto" | "text"; footerPackStack?: boolean }

/**
 * `/footer pack [NAME|off] [text|symbols] [stack|alone]`, or undefined when `args` is not about packs. Alone it lists the packs; the
 * words after the name set the glyphs (words only, or the terminal's) and whether the pack stacks above a footer of the user's own.
 */
export function parseFooterPackCommand(args: string, current: { pack: string; symbols: "auto" | "text"; stack: boolean }): { ok: true; patch: FooterPackPatch; notice: string } | { ok: false; error: string } | undefined {
  const [word, ...rest] = args.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (word !== "pack" && word !== "packs") return undefined
  const names = [...footerPackNames(), FOOTER_PACK_OFF]
  if (!rest.length) return { ok: false, error: `packs: ${names.map((name) => (name === current.pack ? `${name}*` : name)).join(", ")} · /footer pack NAME [text|symbols] [stack|alone]` }
  const [name, ...flags] = rest
  if (!names.includes(name!)) return { ok: false, error: `unknown pack "${name}" (${names.join(", ")}; a file is footer-packs/<name>.json)` }
  const patch: FooterPackPatch = { footerPack: name! }
  for (const flag of flags) {
    if (flag === "text") patch.footerPackSymbols = "text"
    else if (flag === "symbols" || flag === "auto") patch.footerPackSymbols = "auto"
    else if (flag === "stack") patch.footerPackStack = true
    else if (flag === "alone") patch.footerPackStack = false
    else return { ok: false, error: `usage: /footer pack ${name} [text|symbols] [stack|alone]` }
  }
  const symbols = patch.footerPackSymbols ?? current.symbols
  const stack = patch.footerPackStack ?? current.stack
  return { ok: true, patch, notice: name === FOOTER_PACK_OFF ? "footer pack: off (the built-in footer)" : `footer pack ${name}${symbols === "text" ? " · text only" : ""}${stack ? " · stacked above your footer" : ""}` }
}

/** Whether the pack draws `id` anywhere (the chrome asks git's state and the like only for a pack that shows them). */
export const packPlaces = (pack: FooterPackFile, id: FooterPackSegment) => pack.rows.some((row) => row.left?.includes(id) || row.right?.includes(id))
