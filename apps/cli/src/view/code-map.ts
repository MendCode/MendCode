import type { ColorName, Line, Span } from "../ui/theme"
import { fit, lineWidth } from "./deck"
import { compact } from "./format"
import { truncateEnd } from "./session-list"
import { textWidth } from "./wrap"

/**
 * A call map drawn the way MendCode v1 drew its graphs: a thin square frame with the title set into its top edge and the status
 * (hidden counts, saved tokens, ctrl+o) into its bottom edge, nodes as small diamonds and the links between them as fine braille dot
 * lines. Callers sit on the left, the centre symbol (accent `◆`) in the middle, callees (or search matches) on the right; every direct
 * neighbour is joined to the centre by its own dotted line, so the links fan out instead of running along one long rail. A symbol is
 * its name with a muted `file:line` (the file without its extension, plus the fewest parent directories that tell two files apart). A
 * deeper hop hangs, indented, under the entry it was reached through. A row too narrow drops its file before a name is cut; a file is
 * never cut. The box is as wide as its content. Under `MIN_WIDE` columns the same map stacks (callers, centre, callees) along one
 * dotted spine; under `MIN_FRAMED` the frame goes. Pure: every row is exactly the same width.
 */

export const CODE_MAP = { minWide: 70, minFramed: 40, maxWidth: 132, rows: { balanced: 6, full: 12 }, stackedRows: { balanced: 5, full: 10 }, centerMax: 40, nameGap: 2, minSide: 8, fan: { min: 4, max: 14 } } as const

export type CodeMapEntry = { label: string; file?: string | undefined; line?: number | undefined; kind?: string | undefined; depth?: number | undefined; via?: string | undefined }
export type CodeMapSide = { title: string; entries: readonly CodeMapEntry[]; more?: number | undefined; flow?: "in" | "out" | "none" | undefined }
export type CodeMapInput = {
  center: CodeMapEntry
  left: CodeMapSide
  right: CodeMapSide
  title?: string | undefined
  width: number
  /** Every row of both sides (ctrl+o); otherwise each side is cut to a few rows plus a count in the footer. */
  expanded?: boolean | undefined
  /** `balanced` shows names and locations; `full` adds kinds and a longer preview. */
  detail?: "balanced" | "full" | undefined
  ascii?: boolean | undefined
  /** Estimated tokens this lookup kept out of the context; shown in the footer as `~N tokens saved` when positive. */
  saved?: number | undefined
}

type Glyphs = { tl: string; tr: string; bl: string; br: string; h: string; v: string; node: string; centre: string; hang: string; dots: boolean }

const UNICODE: Glyphs = { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│", node: "◇", centre: "◆", hang: "⠣", dots: true }
const ASCII: Glyphs = { tl: "+", tr: "+", bl: "+", br: "+", h: "-", v: "|", node: "o", centre: "@", hang: "`", dots: false }

const KIND_SHORT: Readonly<Record<string, string>> = { function: "fn", method: "fn", class: "class", interface: "iface", variable: "var", namespace: "ns", search: "find" }
/** A node's colour says what it is, as v1's legend did per group: functions blue, types violet, values green. */
const KIND_COLOR: Readonly<Record<string, ColorName>> = { function: "info", method: "info", class: "synType", interface: "synType", type: "synType", enum: "synType", variable: "success", const: "success", namespace: "secondary" }
const nodeColor = (kind: string | undefined): ColorName => (kind ? KIND_COLOR[kind] ?? "info" : "info")

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim()
const total = (side: CodeMapSide) => side.entries.length + (side.more ?? 0)
/** `7 callers`, `1 caller`, `1 match`: the side's title is the plural noun. */
const counted = (count: number, title: string) => `${count} ${count === 1 ? title.replace(/(ch)es$|s$/, "$1") : title}`

/** One symbol of a side, ready to draw: where it hangs (`depth`, 1 = joined to the centre), its name, its muted location suffix and its kind's colour. */
type Item = { depth: number; direct: boolean; kind: string; name: string; location: string; color: ColorName }

type SideItems = { items: Item[]; /** Entries a ctrl+o would show. */ cut: number; /** Entries not drawn, including the ones nothing can show. */ hidden: number }

/**
 * The shortest label that tells each file from the others: its name without the extension (`transcript`), with
 * the fewest parent directories added when two files would read the same (`a/index`, `b/index`); two files that
 * differ only by extension keep it.
 */
export function uniquePaths(files: readonly string[]): Map<string, string> {
  const distinct = [...new Set(files.filter((file) => file !== ""))]
  const label = ({ file, parts, bare }: { file: string; parts: number; bare: boolean }) => {
    const segments = file.split("/")
    const last = segments.at(-1)!
    return [...segments.slice(-parts, -1), bare ? last.replace(/^(.+)\.[^.]+$/, "$1") : last].join("/")
  }
  const out = new Map<string, string>()
  for (const file of distinct) {
    const depth = file.split("/").length
    let chosen = file
    search: for (const bare of [true, false]) {
      for (let parts = 1; parts <= depth; parts++) {
        const mine = label({ file, parts, bare })
        if (!distinct.some((other) => other !== file && label({ file: other, parts, bare }) === mine)) {
          chosen = mine
          break search
        }
      }
    }
    out.set(file, chosen)
  }
  return out
}

/** `tokens saved` as the footer shows it: `~850 tokens saved`, `~12.4K tokens saved`; `short` drops the word `tokens`. */
export function savedLabel(tokens: number, short = false) {
  return `~${compact(Math.round(tokens))} ${short ? "saved" : "tokens saved"}`
}

function locationOf({ entry, paths, relativeTo }: { entry: CodeMapEntry; paths: ReadonlyMap<string, string>; relativeTo?: string | undefined }) {
  const line = entry.line ? `:${entry.line}` : ""
  // A symbol in the centre's own file only needs its line; the centre already names the file.
  if (!entry.file || entry.file === relativeTo) return line
  return `${paths.get(entry.file) ?? entry.file}${line}`
}

/**
 * One side's rows in tree order: every entry sits right under the entry it was reached through (`via`; without one, the
 * nearest shallower entry before it). Direct hops are shown first, then deeper ones whose parent is shown, up to `limit`
 * rows. An entry whose parent is not in the list can never be placed, so it is only counted.
 */
function sideItems({ side, limit, detail, paths, centerFile }: { side: CodeMapSide; limit: number; detail: "balanced" | "full"; paths: ReadonlyMap<string, string>; centerFile: string | undefined }): SideItems {
  const entries = side.entries.map((entry, index) => ({ entry, index, depth: Math.max(1, entry.depth ?? 1) }))
  const parentOf = (at: number): number | undefined => {
    const own = entries[at]!
    if (own.depth === 1) return undefined
    const earlier = own.entry.via === undefined ? entries.slice(0, at).reverse().find((other) => other.depth < own.depth) : undefined
    const named = own.entry.via === undefined ? undefined : (entries.find((other) => other.depth === own.depth - 1 && other.entry.label === own.entry.via) ?? entries.find((other) => other.depth < own.depth && other.entry.label === own.entry.via))
    return (named ?? earlier)?.index ?? -1
  }
  const parents = entries.map((_, at) => parentOf(at))
  const byDepth = [...entries].sort((a, b) => a.depth - b.depth || a.index - b.index)
  const placeable = new Set<number>()
  const shown = new Set<number>()
  for (const { index, depth } of byDepth) {
    const parent = parents[index]
    if (depth > 1 && (parent === undefined || parent < 0 || !placeable.has(parent))) continue
    placeable.add(index)
    if (shown.size < limit && (depth === 1 || (parent !== undefined && shown.has(parent)))) shown.add(index)
  }
  const children = new Map<number, number[]>()
  for (const { index } of entries) {
    const parent = parents[index]
    if (parent !== undefined && parent >= 0) children.set(parent, [...(children.get(parent) ?? []), index])
  }
  const ordered: number[] = []
  const walk = (index: number) => {
    if (!shown.has(index)) return
    ordered.push(index)
    for (const child of children.get(index) ?? []) walk(child)
  }
  for (const { index, depth } of entries) if (depth === 1) walk(index)
  const items = ordered.map((index): Item => {
    const { entry, depth } = entries[index]!
    return {
      depth,
      direct: depth === 1,
      kind: detail === "full" && entry.kind ? `${KIND_SHORT[entry.kind] ?? entry.kind} ` : "",
      name: `${depth > 9 ? `d${depth} ` : ""}${oneLine(entry.label)}`,
      location: locationOf({ entry, paths, relativeTo: centerFile }),
      color: nodeColor(entry.kind),
    }
  })
  return { items, cut: placeable.size - shown.size, hidden: entries.length - shown.size + (side.more ?? 0) }
}

/** The lead of a row in front of its name: a deeper hop's indent and its dotted hook. */
const hangOf = (item: Item, glyphs: Glyphs) => (item.depth > 1 ? `${"  ".repeat(Math.min(8, item.depth - 2))}${glyphs.hang} ` : "")

/** Cells the name part of a row takes: hang, kind, name. */
const nameWidth = (item: Item, glyphs: Glyphs) => textWidth(hangOf(item, glyphs) + item.kind + item.name)

/** The name part of a row clipped to `width`: the hang is muted, the kind dim, the name normal. */
function nameSpans({ item, width, glyphs }: { item: Item; width: number; glyphs: Glyphs }): Span[] {
  const hang = hangOf(item, glyphs)
  const spans: Span[] = []
  if (hang) spans.push({ text: hang, fg: "border" })
  if (item.kind) spans.push({ text: item.kind, fg: "muted", dim: true })
  spans.push({ text: truncateEnd(item.name, Math.max(1, width - textWidth(hang + item.kind))), fg: "text" })
  return fit(spans, width)
}

/** `location` is the width of the file-suffix column (0 = none): a row whose suffix is wider than it shows no suffix. */
type Columns = { name: number; location: number }

const columnsWidth = ({ name, location }: Columns) => name + (location > 0 ? CODE_MAP.nameGap + location : 0)

/** Natural column widths of a side: the widest name part and the widest location. */
function naturalColumns(items: readonly Item[], glyphs: Glyphs): Columns {
  return { name: Math.max(0, ...items.map((item) => nameWidth(item, glyphs))), location: Math.max(0, ...items.map((item) => textWidth(item.location))) }
}

/** Column widths for a side given `room` cells: names keep their width, and the suffixes that do not fit next to them are dropped (a name is cut only when it alone exceeds the room). */
function fitColumns({ items, natural, room }: { items: readonly Item[]; natural: Columns; room: number }): Columns {
  const name = Math.max(1, Math.min(natural.name, room))
  const allowed = room - name - CODE_MAP.nameGap
  const kept = items.map((item) => textWidth(item.location)).filter((width) => width > 0 && width <= allowed)
  return { name, location: Math.max(0, ...kept) }
}

/** `name  location` as spans, both columns padded so the rows line up. */
function rowCells({ item, columns, glyphs }: { item: Item | undefined; columns: Columns; glyphs: Glyphs }): Span[] {
  if (!item) return [{ text: " ".repeat(columnsWidth(columns)) }]
  const spans = nameSpans({ item, width: columns.name, glyphs })
  if (columns.location > 0) {
    const shown = textWidth(item.location) <= columns.location ? item.location : ""
    spans.push({ text: " ".repeat(CODE_MAP.nameGap) }, ...fit(shown ? [{ text: shown, fg: "muted", dim: true }] : [], columns.location))
  }
  return spans
}

type Centre = { name: string; where: string }

function centreOf({ center, detail, paths }: { center: CodeMapEntry; detail: "balanced" | "full"; paths: ReadonlyMap<string, string> }): Centre {
  const kind = detail === "full" && center.kind ? `${KIND_SHORT[center.kind] ?? center.kind}` : ""
  const place = locationOf({ entry: center, paths })
  return { name: oneLine(center.label), where: [kind, place].filter(Boolean).join(" · ") }
}

/** What the footer says: the symbols left out per side, the saved-tokens estimate and the key hint. */
function footerText({ input, left, right, room }: { input: CodeMapInput; left: SideItems; right: SideItems; room: number }): string {
  const counts: string[] = []
  for (const [side, found] of [[input.left, left], [input.right, right]] as const) if (found.hidden > 0 && side.title !== "") counts.push(`+${counted(found.hidden, side.title)}`)
  const saved = input.saved !== undefined && input.saved > 0 ? input.saved : undefined
  const cut = left.cut + right.cut > 0
  const longest = Math.max(input.left.entries.length, input.right.entries.length)
  const hint = cut ? ["ctrl+o"] : input.expanded === true && longest > CODE_MAP.rows.balanced ? ["ctrl+o collapses"] : []
  // A narrow box shortens the estimate, then drops it, before it would cut the key hint.
  const variants = saved === undefined ? [[]] : [[savedLabel(saved)], [savedLabel(saved, true)], []]
  const lines = variants.map((estimate) => [...counts, ...estimate, ...hint].join(" · "))
  return lines.find((line) => textWidth(line) <= room) ?? lines.at(-1)!
}

/**
 * A braille dot canvas `width` cells by `height` rows (2 × 4 dots a cell) for the links. A link is drawn dot by dot from one end to the
 * other, so a short one is a few dots and a steep one a staircase: the fine, sparse lines of v1's graphs. ASCII marks a touched cell `.`.
 */
function dotCanvas(width: number, height: number) {
  const bits = new Uint8Array(Math.max(0, width * height))
  const BIT = [[0x01, 0x08], [0x02, 0x10], [0x04, 0x20], [0x40, 0x80]] as const
  const plot = (x: number, y: number) => {
    const cx = Math.floor(x / 2), cy = Math.floor(y / 4)
    if (cx < 0 || cy < 0 || cx >= width || cy >= height) return
    bits[cy * width + cx]! |= BIT[y % 4]![x % 2]!
  }
  const segment = (x0: number, y0: number, x1: number, y1: number) => {
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1)
    for (let step = 0; step <= steps; step++) plot(Math.round(x0 + ((x1 - x0) * step) / steps), Math.round(y0 + ((y1 - y0) * step) / steps))
  }
  return {
    /**
     * A link between two dots (`y` counts dot rows, 4 a text row) that leaves the hub at its own angle and arrives level at the leaf
     * (`hub` names which end is which), so the links of the centre part at once instead of running together in a knot.
     */
    line(x0: number, y0: number, x1: number, y1: number, hub: "start" | "end") {
      const span = Math.max(1, Math.abs(x1 - x0))
      const ease = (t: number) => (hub === "start" ? 1 - (1 - t) * (1 - t) : t * t)
      let previous = { x: x0, y: y0 }
      for (let step = 1; step <= span; step++) {
        const t = step / span
        const next = { x: Math.round(x0 + (x1 - x0) * t), y: Math.round(y0 + (y1 - y0) * ease(t)) }
        segment(previous.x, previous.y, next.x, next.y)
        previous = next
      }
      if (span === 1 && x0 === x1) segment(x0, y0, x1, y1)
    },
    row(y: number, dots: boolean): Span[] {
      let text = ""
      for (let x = 0; x < width; x++) {
        const cell = bits[y * width + x]!
        text += cell === 0 ? " " : dots ? String.fromCharCode(0x2800 + cell) : "."
      }
      return width > 0 ? [{ text, fg: "border" }] : []
    },
  }
}

/** The dot row a text row's links leave from: the second of its four, level with the middle of the glyphs. */
const LINK_DOT = 1

type Layout = { input: CodeMapInput; glyphs: Glyphs; detail: "balanced" | "full"; limit: number; inner: number; title: string; paths: ReadonlyMap<string, string> }
type Built = { rows: Line[]; footer: string; inner: number }

function wideRows({ input, glyphs, detail, limit, inner, title, paths }: Layout): Built {
  const centerFile = input.center.file || undefined
  const left = sideItems({ side: input.left, limit, detail, paths, centerFile })
  const right = sideItems({ side: input.right, limit, detail, paths, centerFile })
  const footer = footerText({ input, left, right, room: inner })
  const hasLeft = left.items.length > 0
  const hasRight = right.items.length > 0
  const centre = centreOf({ center: input.center, detail, paths })
  // Height first: the centre sits in the middle; each side is centred on it, so the dotted links fan out evenly above and below.
  const height = Math.max(left.items.length, right.items.length, centre.where ? 2 : 1)
  const centreRow = Math.floor((height - 1) / 2)
  const leftTop = Math.floor((height - left.items.length) / 2)
  const rightTop = Math.floor((height - right.items.length) / 2)
  const spreadOf = (items: readonly Item[], top: number) => Math.max(0, ...items.map((item, at) => (item.direct ? Math.abs(top + at - centreRow) : 0)))
  const fanFor = (rise: number) => Math.max(CODE_MAP.fan.min, Math.min(CODE_MAP.fan.max, rise * 3 + 4))
  let leftFan = hasLeft ? fanFor(spreadOf(left.items, leftTop)) : 0
  let rightFan = hasRight ? fanFor(spreadOf(right.items, rightTop)) : 0
  // A side's block is its columns plus the node and the cell between them: `name  loc ◇` on the left, `◇ name  loc` on the right.
  const nodeCells = 2
  const naturalLeft = naturalColumns(left.items, glyphs)
  const naturalRight = naturalColumns(right.items, glyphs)
  const centreName = Math.min(CODE_MAP.centerMax, textWidth(centre.name))
  let centreWidth = Math.max(2 + centreName + (hasRight ? 1 : 0), centre.where ? 2 + textWidth(centre.where) + (hasRight ? 1 : 0) : 0)
  const sideNeed = (natural: Columns, on: boolean) => (on ? columnsWidth(natural) + nodeCells : 0)
  const wanted = sideNeed(naturalLeft, hasLeft) + leftFan + centreWidth + rightFan + sideNeed(naturalRight, hasRight)
  const budget = Math.min(inner, Math.max(wanted, textWidth(title) + 2, textWidth(footer)))
  // The fans give up cells first, then the files' suffixes (below), and the centre only when the names alone do not fit.
  let over = wanted - budget
  while (over > 0 && (leftFan > CODE_MAP.fan.min || rightFan > CODE_MAP.fan.min)) {
    if (leftFan >= rightFan && leftFan > CODE_MAP.fan.min) leftFan--
    else if (rightFan > CODE_MAP.fan.min) rightFan--
    else leftFan--
    over--
  }
  const sides = (hasLeft ? 1 : 0) + (hasRight ? 1 : 0)
  const names = (hasLeft ? naturalLeft.name : 0) + (hasRight ? naturalRight.name : 0)
  const spare = budget - leftFan - rightFan - sides * nodeCells - names
  if (spare < centreWidth) centreWidth = Math.max(Math.min(centreWidth, 14), spare)
  const room = Math.max(0, budget - leftFan - rightFan - centreWidth - sides * nodeCells)
  let leftRoom = hasLeft ? columnsWidth(naturalLeft) : 0
  let rightRoom = hasRight ? columnsWidth(naturalRight) : 0
  if (leftRoom + rightRoom > room) {
    // Reserve both names, then callers' suffixes first. Callees take only the content they can still show.
    const names = (hasLeft ? naturalLeft.name : 0) + (hasRight ? naturalRight.name : 0)
    if (names >= room) {
      leftRoom = hasLeft ? Math.max(1, Math.floor((room * naturalLeft.name) / Math.max(1, names))) : 0
      rightRoom = hasRight ? Math.max(1, room - leftRoom) : 0
    } else {
      leftRoom = hasLeft ? columnsWidth(fitColumns({ items: left.items, natural: naturalLeft, room: room - (hasRight ? naturalRight.name : 0) })) : 0
      rightRoom = hasRight ? Math.min(columnsWidth(naturalRight), room - leftRoom) : 0
    }
  }
  const leftColumns = hasLeft ? fitColumns({ items: left.items, natural: naturalLeft, room: Math.max(CODE_MAP.minSide, leftRoom) }) : { name: 0, location: 0 }
  const rightColumns = hasRight ? fitColumns({ items: right.items, natural: naturalRight, room: Math.max(CODE_MAP.minSide, rightRoom) }) : { name: 0, location: 0 }
  const leftBlock = hasLeft ? columnsWidth(leftColumns) + nodeCells : 0
  const rightBlock = hasRight ? columnsWidth(rightColumns) + nodeCells : 0
  const content = leftBlock + leftFan + centreWidth + rightFan + rightBlock
  const boxInner = Math.min(inner, Math.max(content, textWidth(title) + 2, textWidth(footer)))
  const showWhere = centre.where !== "" && textWidth(centre.where) + 2 <= centreWidth

  // The links: every direct neighbour to the centre's diamond. The left fan ends at the diamond; the right one leaves from the end of its name.
  // At the centre a link to a row above leaves from the top dots of its cell and one below from the bottom ones, so the two halves of a fan stay apart.
  const hubDot = (row: number) => centreRow * 4 + (row < centreRow ? 0 : row > centreRow ? 3 : LINK_DOT)
  const leftDots = dotCanvas(leftFan, height)
  left.items.forEach((item, at) => { if (item.direct) leftDots.line(leftFan * 2 - 1, hubDot(leftTop + at), 0, (leftTop + at) * 4 + LINK_DOT, "start") })
  const rightDots = dotCanvas(rightFan, height)
  right.items.forEach((item, at) => { if (item.direct) rightDots.line(0, hubDot(rightTop + at), rightFan * 2 - 1, (rightTop + at) * 4 + LINK_DOT, "start") })
  const shownName = truncateEnd(centre.name, Math.max(1, centreWidth - 2 - (hasRight ? 1 : 0)))
  const rows: Line[] = []
  for (let y = 0; y < height; y++) {
    const row: Line = []
    if (hasLeft) {
      const item = left.items[y - leftTop]
      row.push(...rowCells({ item, columns: leftColumns, glyphs }))
      row.push(item?.direct ? { text: ` ${glyphs.node}`, fg: item.color } : { text: "  " })
      row.push(...leftDots.row(y, glyphs.dots))
    }
    if (y === centreRow) {
      const name: Line = [{ text: `${glyphs.centre} `, fg: "accent", bold: true }, { text: shownName, fg: "accent", bold: true }]
      // The centre's own link to the right fan runs from the end of its name, so no rail of padding sits between them.
      const tail = centreWidth - lineWidth(name)
      row.push(...name, ...(hasRight && tail > 0 ? [{ text: " " }, ...(tail > 1 ? [{ text: (glyphs.dots ? "⠒" : ".").repeat(tail - 1), fg: "border" as const }] : [])] : tail > 0 ? [{ text: " ".repeat(tail) }] : []))
    } else if (y === centreRow + 1 && showWhere) row.push(...fit([{ text: `  ${centre.where}`, fg: "muted", dim: true }], centreWidth))
    else row.push({ text: " ".repeat(centreWidth) })
    if (hasRight) {
      const item = right.items[y - rightTop]
      row.push(...rightDots.row(y, glyphs.dots))
      row.push(item?.direct ? { text: `${glyphs.node} `, fg: item.color } : { text: "  " })
      row.push(...rowCells({ item, columns: rightColumns, glyphs }))
    }
    rows.push(fit(row, boxInner))
  }
  return { rows, footer, inner: boxInner }
}

function stackedRows({ input, glyphs, detail, limit, inner, title, paths }: Layout): Built {
  const centerFile = input.center.file || undefined
  const left = sideItems({ side: input.left, limit, detail, paths, centerFile })
  const right = sideItems({ side: input.right, limit, detail, paths, centerFile })
  const footer = footerText({ input, left, right, room: inner })
  const centre = centreOf({ center: input.center, detail, paths })
  // One spine down the left edge: each direct neighbour is a diamond on it, the centre's diamond sits where the callers end.
  const lead = 2
  const naturalLeft = naturalColumns(left.items, glyphs)
  const naturalRight = naturalColumns(right.items, glyphs)
  const centreNatural = 2 + textWidth(centre.name) + (centre.where ? 2 + textWidth(centre.where) : 0)
  const wanted = Math.max(centreNatural, left.items.length ? lead + columnsWidth(naturalLeft) : 0, right.items.length ? lead + columnsWidth(naturalRight) : 0)
  const budget = Math.min(inner, Math.max(wanted, textWidth(title) + 2, textWidth(footer)))
  const leftColumns = fitColumns({ items: left.items, natural: naturalLeft, room: Math.max(1, budget - lead) })
  const rightColumns = fitColumns({ items: right.items, natural: naturalRight, room: Math.max(1, budget - lead) })
  const content = Math.max(centreNatural, left.items.length ? lead + columnsWidth(leftColumns) : 0, right.items.length ? lead + columnsWidth(rightColumns) : 0)
  const boxInner = Math.min(inner, Math.max(Math.min(content, budget), textWidth(title) + 2, textWidth(footer)))
  // The diamonds stack into the spine; a deeper hop continues it with a dotted bar and hangs its name under its parent's.
  const spine = glyphs.dots ? "⡇" : ":"
  const sideRow = (item: Item, columns: Columns): Line => [item.direct ? { text: `${glyphs.node} `, fg: item.color } : { text: `${spine} `, fg: "border" }, ...rowCells({ item, columns, glyphs })]
  const rows: Line[] = left.items.map((item) => sideRow(item, leftColumns))
  const nameRoom = Math.max(1, boxInner - 2)
  const whereRoom = nameRoom - textWidth(centre.name) - 2
  rows.push([
    { text: `${glyphs.centre} `, fg: "accent", bold: true },
    { text: truncateEnd(centre.name, nameRoom), fg: "accent", bold: true },
    ...(centre.where && textWidth(centre.where) <= whereRoom ? [{ text: `  ${centre.where}`, fg: "muted" as const, dim: true }] : []),
  ])
  rows.push(...right.items.map((item) => sideRow(item, rightColumns)))
  return { rows: rows.map((line) => fit(line, boxInner)), footer, inner: boxInner }
}

/** The frame's title when the spec gives none: the centre and what each side holds, `renderToolCard · 7 callers · 16 callees`. */
function summaryOf(input: CodeMapInput) {
  const counts = [input.left, input.right].filter((side) => side.title !== "").map((side) => counted(total(side), side.title))
  return [oneLine(input.center.label), ...counts].join(" · ")
}

/** v1's frame: thin square edges, the title set into the top edge and the status into the bottom one, so neither costs a row. */
function frame({ rows, title, inner, glyphs, footer }: { rows: Line[]; title: string; inner: number; glyphs: Glyphs; footer: string }): Line[] {
  const fill = inner + 2
  const edge = (text: string): Span => ({ text, fg: "border" })
  const set = (text: string, fg: ColorName, bold: boolean, ends: [string, string]): Line => {
    if (!text || fill < 6) return [edge(`${ends[0]}${glyphs.h.repeat(fill)}${ends[1]}`)]
    const shown = truncateEnd(text, fill - 2)
    return [edge(ends[0]), { text: shown, fg, ...(bold ? { bold } : { dim: true }) }, edge(`${glyphs.h.repeat(fill - textWidth(shown))}${ends[1]}`)]
  }
  const wrap = (line: Line): Line => [edge(`${glyphs.v} `), ...fit(line, inner), edge(` ${glyphs.v}`)]
  return [set(title, "primary", true, [glyphs.tl, glyphs.tr]), ...rows.map(wrap), set(footer, "muted", false, [glyphs.bl, glyphs.br])]
}

export function renderCodeMap(input: CodeMapInput): Line[] {
  const width = Math.max(4, Math.floor(input.width))
  const glyphs = input.ascii ? ASCII : UNICODE
  const detail = input.detail ?? "balanced"
  const wide = width >= CODE_MAP.minWide
  const framed = width >= CODE_MAP.minFramed
  const limit = input.expanded ? Number.POSITIVE_INFINITY : (wide ? CODE_MAP.rows : CODE_MAP.stackedRows)[detail]
  const paths = uniquePaths([input.center, ...input.left.entries, ...input.right.entries].map((entry) => entry.file ?? ""))
  const title = input.title !== undefined && input.title !== "" ? oneLine(input.title) : summaryOf(input)
  const room = Math.max(1, Math.min(width, CODE_MAP.maxWidth) - (framed ? 4 : 0))
  const built = (wide ? wideRows : stackedRows)({ input, glyphs, detail, limit, inner: room, title: framed ? title : "", paths })
  const body = framed
    ? frame({ rows: built.rows, title, inner: built.inner, glyphs, footer: built.footer })
    : [...built.rows, ...(built.footer ? [fit([{ text: truncateEnd(built.footer, built.inner), fg: "muted" as const, dim: true }], built.inner)] : [])]
  const drawn = framed ? built.inner + 4 : built.inner
  const sized = body.map((line) => (lineWidth(line) === drawn ? line : fit(line, drawn)))
  // Same-width stand-ins for the two punctuation marks the plain glyph set does not have.
  return input.ascii ? sized.map((line) => line.map((span) => ({ ...span, text: span.text.replace(/…/g, "~").replace(/·/g, "|") }))) : sized
}
