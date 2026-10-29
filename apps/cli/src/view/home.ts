import type { ColorName, Line, Span } from "../ui/theme"
import { clip, fit } from "./deck"
import { tipLine } from "./home-tips"
import { DEFAULT_LOGO_FONT, DEFAULT_LOGO_TEXT, logoRowsFor, rowsWidth, type LogoFont } from "./logo-fonts"
import { relativeTime, shortenMiddle } from "./session-list"
import { defaultHomeMascot } from "./mascot"
import type { TuiProfile } from "./tui-profile"
import { lineWidth, textWidth } from "./wrap"

/** The wordmark rows for `text` in `font` (v1's fonts, `logo-fonts.ts`); MENDCODE in v1's own font by default. */
export function logoRows(text: string = DEFAULT_LOGO_TEXT, font: LogoFont = DEFAULT_LOGO_FONT): string[] {
  return logoRowsFor(text, font)
}

/** What v1's Agent View groups a session under (`routes/home.tsx`, `agentViewState`). */
export type HomeSessionState = "needs_input" | "looping" | "working" | "completed"

export type HomeSession = {
  /** Identifies the row for `selectedId`. */
  id?: string
  title: string
  state: HomeSessionState
  /** Epoch ms of the last change; the age of a completed row. */
  updatedAt: number
  /** Epoch ms the running turn started; the elapsed time of a needs-input, looping or working row. Falls back to `updatedAt`. */
  startedAt?: number
  /** The second line of the row (the tool in flight, the pending question, the project path); the state name when absent. */
  detail?: string
}

export type HomeInput = {
  /** Rows available to the home (the transcript area above the prompt). */
  height: number
  width: number
  /** Whole-terminal height, which v1's density rules use; `height` when absent. */
  screenHeight?: number
  version?: string
  /** The project root, already shortened with `~`. */
  root: string
  /** Minimal view: only the root and product row. */
  bare?: boolean
  /** Agent View rows; none renders v1's empty state. */
  sessions?: readonly HomeSession[]
  /** Highlights the row with this `HomeSession.id`. */
  selectedId?: string
  /** Epoch ms used for elapsed times and ages. */
  now?: number
  /** Animation tick of the working spinner. */
  spinner?: number
  /** Rows of an extension's `welcome.below` slot (theme spans, each cut to `width`): drawn under the centered content. */
  below?: readonly Line[]
  /** The look chosen in /customize (`tui-profile.ts`); v1's identity and welcome layout when absent. */
  look?: HomeLook
  /** A tip (`home-tips.ts` markup) drawn under the content; an extension's `below` rows take its place. */
  tip?: string
  /** The bottom row of v1's home: MCP servers on the left, the runtime version on the right. */
  footer?: HomeFooter
  /** The pixel mascot's current frame, when one is chosen and loaded (`ui/app/home-mascot.ts`); the home decides whether it fits. */
  mascot?: HomeMascot
}

/** Where the home drew the mascot: rows and columns of the home's own lines, and the box in cells. */
export type HomeMascotBox = { row: number; col: number; cols: number; rows: number }
/**
 * What the terminal hands the home when a pet is the mascot. `pixel` is absent where it cannot be drawn (16 colors, ASCII
 * glyphs): the home then keeps its ASCII mascot. `boxes` are the sizes to try, the wanted one first; `lines` gives the
 * rows of one (half blocks, or blank cells when the terminal draws the picture itself over them). `title` colors a
 * wordmark row. `shown` is called with where it was drawn, so the terminal animates and places it only while it is on screen.
 */
export type HomeMascot = { pixel?: { boxes: ReadonlyArray<{ cols: number; rows: number }>; lines(cols: number, rows: number): readonly Line[] }; title?: (row: string, width: number) => Span[]; shown?: (at: HomeMascotBox) => void }

/** The gap between the sprite and the title beside it. */
export const HOME_MASCOT_GAP = 4

export type HomeLook = Partial<Pick<TuiProfile, "logoKind" | "homeMascot" | "customAscii" | "density" | "homeRightPanel" | "tagline" | "homeHeader" | "homePanel">> & { productName?: string; logoText?: string; logoFont?: LogoFont; layout?: "centered" | "split" }
/** `mcp` is absent until the daemon answered, and the MCP part is left out when there are no servers (like v1). */
export type HomeFooter = { mcp?: { total: number; connected: number; failed: boolean } }

/** An extension's `welcome.replace` rows as the whole home: from the top, each exactly `width` cells, at most `height` rows. */
export function renderWelcomeReplacement(lines: readonly Line[], width: number, height: number): Line[] {
  return lines.slice(0, Math.max(0, height)).map((line) => {
    const used = lineWidth(line)
    return used >= width ? line : [...line, { text: " ".repeat(width - used) }]
  })
}

/** How many rows of each state v1 lists (`homeAgentManagerSurface`). */
export const HOME_SECTION_CAPS = { needs_input: 3, looping: 4, working: 4, completed: 3 } as const satisfies Record<HomeSessionState, number>

const SECTIONS: ReadonlyArray<{ state: HomeSessionState; title: string; marker: string; color: ColorName }> = [
  { state: "needs_input", title: "Needs input", marker: "✱", color: "accent" },
  { state: "looping", title: "Looping", marker: "↻", color: "accent" },
  { state: "working", title: "Working", marker: "", color: "muted" },
  { state: "completed", title: "Completed", marker: "✦", color: "success" },
]
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
const EMPTY_TITLE = "No sessions yet"

const PRODUCT = "MendCode"
const MARKER_WIDTH = 2

type Density = "full" | "compact" | "tiny"

/** v1 `homeDensity`: tiny at 17 rows or fewer, compact at 23 rows or 64 columns or fewer. */
function density(width: number, screenHeight: number): Density {
  if (screenHeight <= 17) return "tiny"
  if (screenHeight <= 23 || width <= 64) return "compact"
  return "full"
}

const blank = (count: number): Line[] => Array.from({ length: Math.max(0, count) }, (): Line => [])

/** The rows of each state in v1's order, most recent first, limited to v1's per-state caps. */
export function homeVisibleSessions(sessions: readonly HomeSession[]): HomeSession[] {
  return groupSessions(sessions).flatMap(({ state, rows }) => rows.slice(0, HOME_SECTION_CAPS[state]))
}

function groupSessions(sessions: readonly HomeSession[]) {
  return SECTIONS.map(({ state }) => ({
    state,
    rows: sessions.filter((session) => session.state === state).toSorted((a, b) => (state === "working" ? (b.startedAt ?? b.updatedAt) - (a.startedAt ?? a.updatedAt) : b.updatedAt - a.updatedAt)),
  }))
}

/** v1 `homeAgentViewElapsedLabel`: seconds, minutes, hours, days, weeks, months, years. */
function elapsed(now: number, since: number) {
  const seconds = Math.max(0, Math.floor((now - since) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d`
  if (days < 30) return `${Math.floor(days / 7)}w`
  if (days < 365) return `${Math.floor(days / 30)}mo`
  return `${Math.floor(days / 365)}y`
}

/** v1 `homeAgentViewSummaryLines`: the longest wording that fits, else wrapped over two or three lines. */
function summaryLines(counts: { waiting: number; looping: number; working: number }, width: number): string[] {
  const { waiting, looping, working } = counts
  const active = `${waiting} wait · ${looping} loop · ${working} work`
  const options = [`Agent View sessions · ${waiting} waiting · ${looping} looping · ${working} working`, `Agent View · ${active}`]
  const fits = options.find((option) => textWidth(option) <= width)
  if (fits) return [fits]
  if (textWidth(active) <= width) return ["Agent View sessions", active]
  return ["Agent View sessions", `${waiting} wait · ${looping} loop`, `${working} work`]
}

/** v1 compact row geometry (`homeAgentViewRowLayout`; the panel never reaches the 62 columns of the wide layout). */
function rowGeometry(width: number) {
  const timeWidth = width >= 52 ? 16 : width >= 44 ? 14 : width >= 36 ? 10 : 8
  return { timeWidth, titleWidth: Math.max(8, width - MARKER_WIDTH - timeWidth - 1), detailWidth: Math.max(8, width - MARKER_WIDTH) }
}

const STATE_DETAIL: Record<HomeSessionState, string> = { needs_input: "needs input", looping: "looping", working: "working", completed: "completed" }

function sessionRows(input: { session: HomeSession; marker: Span; width: number; now: number; selected: boolean }): Line[] {
  const { session, marker, width, now, selected } = input
  const { timeWidth, titleWidth, detailWidth } = rowGeometry(width)
  const bg: Partial<Span> = selected ? { bg: "element" } : {}
  const time = session.state === "completed" ? (session.updatedAt <= now - 60_000 ? `${relativeTime(now, session.updatedAt)} ago` : "now") : elapsed(now, session.startedAt ?? session.updatedAt)
  const title = shortenMiddle(session.title, titleWidth)
  const detail = shortenMiddle(session.detail ?? STATE_DETAIL[session.state], detailWidth)
  const pad = (used: number, room: number) => ({ text: " ".repeat(Math.max(0, room - used)), ...bg })
  return [
    [
      { ...marker, ...bg, text: marker.text + " ".repeat(Math.max(0, MARKER_WIDTH - textWidth(marker.text))) },
      { text: title, fg: "text", ...bg },
      pad(textWidth(title), titleWidth + 1 + Math.max(0, timeWidth - textWidth(time))),
      { text: time, fg: "muted", ...bg },
    ],
    [{ text: " ".repeat(MARKER_WIDTH), ...bg }, { text: detail, fg: "muted", ...bg }, pad(textWidth(detail), detailWidth)],
  ]
}

/** The Agent View block for `panelWidth`, with each state limited to `caps`. Rows are `panelWidth` wide except the empty state. */
function agentView(input: { sessions: readonly HomeSession[]; panelWidth: number; caps: Record<HomeSessionState, number>; now: number; spinner: number; selectedId?: string }): Line[] {
  const { sessions, panelWidth, caps, now } = input
  const groups = groupSessions(sessions)
  const count = (state: HomeSessionState) => groups.find((group) => group.state === state)!.rows.length
  const headline = count("needs_input") + count("looping") + count("working") > 0
  const out: Line[] = headline ? summaryLines({ waiting: count("needs_input"), looping: count("looping"), working: count("working") }, panelWidth).map((text): Line => [{ text, fg: "primary" }]) : []
  let listed = headline
  for (const { state, title, marker, color } of SECTIONS) {
    const rows = groups.find((group) => group.state === state)!.rows.slice(0, caps[state])
    if (rows.length === 0) continue
    if (listed) out.push([])
    listed = true
    out.push([{ text: title, fg: "text" }])
    const glyph: Span = state === "working" ? { text: SPINNER_FRAMES[input.spinner % SPINNER_FRAMES.length]!, fg: color } : { text: marker, fg: color }
    for (const session of rows) out.push(...sessionRows({ session, marker: glyph, width: panelWidth, now, selected: session.id !== undefined && session.id === input.selectedId }))
  }
  return out
}

/** Fewer rows per state, least important first, until the block is at most `room` lines (the summary and titles alone if need be). */
function fitAgentView(input: Parameters<typeof agentView>[0] & { room: number }): Line[] {
  const caps = { ...input.caps }
  const order: HomeSessionState[] = ["completed", "working", "looping", "needs_input"]
  for (;;) {
    const block = agentView({ ...input, caps })
    if (block.length <= input.room) return block
    const next = order.find((state) => caps[state] > 0)
    if (!next) return block
    caps[next] -= 1
  }
}

/** `MendCode v1.2.3`: the product name and the version, a `v` added when missing. */
function productLabel(name: string, version?: string) {
  return version ? `${name} ${version.startsWith("v") ? version : `v${version}`}` : name
}

/** Row one of v1's home: the project root on the left, `MendCode v<version>` on the right, both muted. */
function headerRow(input: { width: number; root: string; version?: string; pad: number; productName?: string }): Line {
  const { width, pad } = input
  const product = productLabel(input.productName ?? PRODUCT, input.version)
  const room = width - pad * 2
  // At least two cells between the root and the product, so a long root never reads as part of the version.
  const showProduct = room - textWidth(product) - 2 >= 8
  const rootRoom = Math.max(1, showProduct ? room - textWidth(product) - 2 : room)
  const root = shortenMiddle(input.root, rootRoom)
  const gap = showProduct ? Math.max(2, room - textWidth(root) - textWidth(product)) : 0
  return [{ text: " ".repeat(pad) }, { text: root, fg: "muted" }, ...(showProduct ? [{ text: " ".repeat(gap) }, { text: product, fg: "muted" as const }] : [])]
}

/**
 * v1's centered home. Row one holds the root and the product; under it, vertically centered, come the logo
 * (ASCII only when the terminal is at least 24 rows and 65 columns, the text `MendCode` when smaller, nothing at
 * 17 rows or fewer) and the Agent View of the sessions. The Agent View shrinks first when the space is short.
 */
export function renderHome(input: HomeInput): Line[] {
  const { width } = input
  const screenHeight = input.screenHeight ?? input.height
  const size = input.bare ? "tiny" : density(width, screenHeight)
  if (size === "tiny") return centeredHome({ ...input, below: input.below ?? [] }, size)
  // v1's bottom row takes the last row of the home; an extension's `welcome.below` rows win over the tip.
  const footer = input.footer && input.height >= MIN_FOOTER_HEIGHT ? footerRow({ width, footer: input.footer, ...(input.version ? { version: input.version } : {}) }) : undefined
  const height = footer ? input.height - 1 : input.height
  const tip = input.below?.length || !input.tip ? undefined : tipRow(input.tip, width)
  const below = input.below?.length ? input.below : tip ? [tip] : []
  const split = input.look?.layout === "split" && size === "full" && width >= SPLIT_MIN_WIDTH && height >= Math.max(10, homeIdentity(input.look).length + 8)
  const rows = split ? splitHome({ ...input, height }, below) : centeredHome({ ...input, height, below }, size)
  return footer ? [...rows.slice(0, height), ...blank(height - rows.length), footer] : rows
}

const MIN_FOOTER_HEIGHT = 8
const SPLIT_MIN_WIDTH = 76
/** v1's narrowest Agent View column beside the identity, and the gap between the two columns. */
const SPLIT_AGENT_MIN = 42
const SPLIT_GAP = 4
const SPLIT_MIN_CONTENT = 9

const centerIn = (spans: Span[], within: number): Line => [{ text: " ".repeat(Math.max(0, Math.floor((within - lineWidth(spans)) / 2))) }, ...spans]

/** The tip as one centered row, cut to the home's side padding. */
function tipRow(tip: string, width: number): Line {
  const room = Math.max(1, width - 4)
  return centerIn(clip(tipLine(tip), room), width)
}

/** v1's `home_footer`: `⊙ N MCP /status` on the left and `runtime <version>` on the right, muted, one row. */
function footerRow(input: { width: number; footer: HomeFooter; version?: string }): Line {
  const pad = 2
  const left: Span[] = []
  const mcp = input.footer.mcp
  if (mcp && mcp.total > 0) left.push({ text: "⊙ ", fg: mcp.failed ? "error" : mcp.connected > 0 ? "success" : "muted" }, { text: `${mcp.connected} MCP`, fg: "text" }, { text: " /status", fg: "muted" })
  const right: Span[] = input.version ? [{ text: `runtime ${input.version.startsWith("v") ? input.version : `v${input.version}`}`, fg: "muted" }] : []
  const room = input.width - pad * 2
  const showRight = right.length > 0 && lineWidth(left) + lineWidth(right) + 2 <= room
  const gap = showRight ? room - lineWidth(left) - lineWidth(right) : 0
  const used = clip(left, room)
  return [{ text: " ".repeat(pad) }, ...used, { text: " ".repeat(showRight ? gap : room - lineWidth(used) + pad) }, ...(showRight ? [...right, { text: " ".repeat(pad) }] : [])]
}

export function homeLook(profile: TuiProfile): HomeLook {
  return { ...profile, layout: profile.homeLayout }
}

/** Cell-accurate identity. No scaling, trimming of left padding, or bitmap conversion. */
export function homeIdentity(look?: HomeLook): string[] {
  const kind = look?.logoKind ?? "wordmark"
  const wordmark = logoRows(look?.logoText, look?.logoFont)
  // A pet mascot is a picture the terminal brings (`HomeMascot`); in text cells the mascot is always the ASCII Mend.
  const chosen = defaultHomeMascot
  if (kind === "none") return []
  if (kind === "mascot") return chosen.split("\n")
  if (kind === "custom") return (look?.customAscii || defaultHomeMascot).split("\n")
  if (kind === "both") {
    const mascot = chosen.split("\n")
    const width = Math.max(rowsWidth(mascot), rowsWidth(wordmark))
    const center = (rows: string[]) => {
      const pad = " ".repeat(Math.floor((width - rowsWidth(rows)) / 2))
      return rows.map((row) => pad + row)
    }
    // A blank row keeps the mascot's feet off the wordmark; a tall mascot gets two.
    return [...center(mascot), ...Array.from({ length: mascot.length >= 10 ? 2 : 1 }, () => ""), ...center(wordmark)]
  }
  return wordmark
}

function actionsPanel(width: number, room = 5): Line[] {
  if (room < 5) return [clip([{ text: "ctrl-s sessions · ctrl-p commands", fg: "muted" }], width)]
  const rows: Line[] = []
  for (const [index, [label, key]] of [["Resume session", "ctrl-s"], ["Open commands", "ctrl-p"], ["Quit", "ctrl-c"]].entries()) {
    if (index) rows.push([{ text: "─".repeat(width), fg: "border" }])
    rows.push([{ text: label!, fg: "text" }, { text: " ".repeat(Math.max(1, width - textWidth(label!) - textWidth(key!))) }, { text: key!, fg: "muted" }])
  }
  return rows
}

/** The wordmark (or, where it cannot be drawn, the plain name) as rows: `art` is undefined when the plain name is all there is. */
function logoArt(input: { look: HomeLook | undefined; product: string; allowArt: boolean; width: number; center: (spans: Span[]) => Line }): { art?: Line[]; plain: Line[] } {
  const wordmark = homeIdentity(input.look)
  const tagline = input.look?.tagline ? [input.center([{ text: shortenMiddle(input.look.tagline, input.width), fg: "muted" }])] : []
  const plain = input.look?.logoKind === "none" ? [] : [input.center([{ text: input.product, fg: "text" }]), ...tagline]
  const art = input.allowArt && input.width >= rowsWidth(wordmark) + 12 ? wordmark.map((row) => input.center([{ text: row + " ".repeat(rowsWidth(wordmark) - textWidth(row)), fg: "text" }])) : undefined
  return { ...(art ? { art: [...art, ...tagline] } : {}), plain }
}

/**
 * The identity with the pixel mascot, widest need first: the sprite above the wordmark, then the sprite with the wordmark
 * beside it (shorter, for a wide screen that is not tall). Each is tried against the rows the home has; when neither fits
 * the home falls back to the text identity it always had, so the sprite never takes a row from the prompt.
 */
type PixelLayout = { height: number; build(): { lines: Line[]; at: HomeMascotBox } }

function pixelIdentity(input: { look: HomeLook | undefined; mascot: HomeMascot | undefined; width: number }): PixelLayout[] {
  const { look, mascot, width } = input
  const center = (spans: Span[]): Line => centerIn(spans, width)
  const pixel = mascot?.pixel
  const kind = look?.logoKind
  if (!pixel || (kind !== "both" && kind !== "mascot")) return []
  const tagline = (room: number): Line[] => (look?.tagline ? [[{ text: shortenMiddle(look.tagline, room), fg: "muted" }]] : [])
  const wordmark = logoRows(look?.logoText, look?.logoFont)
  const wide = rowsWidth(wordmark)
  const title = (): Line[] => wordmark.map((row): Line => {
    const padded = row + " ".repeat(wide - textWidth(row))
    return mascot?.title?.(padded, wide) ?? [{ text: padded, fg: "text" }]
  })
  const layouts: PixelLayout[] = []
  // Each size in turn, the wanted one first: above the title, then beside it. The rows are asked for only when a layout is built.
  for (const { cols, rows } of pixel.boxes) {
    if (width < cols + 4) continue
    const sprite = () => pixel.lines(cols, rows).map((line) => fit(line, cols))
    const col = Math.floor((width - cols) / 2)
    if (kind === "mascot") {
      layouts.push({ height: rows + tagline(1).length, build: () => ({ lines: [...sprite().map(center), ...tagline(width - 4).map(center)], at: { row: 0, col, cols, rows } }) })
      continue
    }
    if (width >= wide + 12) layouts.push({ height: rows + 1 + wordmark.length + tagline(1).length, build: () => ({ lines: [...sprite().map(center), [], ...title().map(center), ...tagline(width - 4).map(center)], at: { row: 0, col, cols, rows } }) })
    if (width >= cols + HOME_MASCOT_GAP + wide + 8) {
      const high = Math.max(rows, wordmark.length + tagline(1).length)
      layouts.push({ height: high, build: () => {
        const right = [...title(), ...tagline(wide)]
        const [spriteTop, rightTop] = [Math.floor((high - rows) / 2), Math.floor((high - right.length) / 2)]
        const drawn = sprite()
        const lines = Array.from({ length: high }, (_, y): Line => center([...fit(drawn[y - spriteTop] ?? [], cols), { text: " ".repeat(HOME_MASCOT_GAP) }, ...fit(right[y - rightTop] ?? [], wide)]))
        return { lines, at: { row: spriteTop, col: Math.floor((width - (cols + HOME_MASCOT_GAP + wide)) / 2), cols, rows } }
      } })
    }
  }
  return layouts
}

/**
 * v1's centered home. Row one holds the root and the product; under it, vertically centered, come the logo
 * (ASCII only when the terminal is at least 24 rows and 65 columns, the text `MendCode` when smaller, nothing at
 * 17 rows or fewer) and the Agent View of the sessions. The Agent View shrinks first when the space is short.
 */
function centeredHome(input: HomeInput & { below: readonly Line[] }, size: Density): Line[] {
  const { width, height } = input
  const below = input.below
  const product = input.look?.productName ?? PRODUCT
  const pad = size === "tiny" ? 1 : 2
  // `homeHeader` off removes the first row (and the blank one above it); `homePanel` off leaves the logo without the list under it.
  const header: Line[] = input.look?.homeHeader === false ? [] : [...(size === "tiny" ? [] : blank(1)), headerRow({ width, root: input.root, productName: product, ...(input.version ? { version: input.version } : {}), pad })]
  if (size === "tiny") return [...header, ...(below.length > 0 ? [[], ...below] : [])].slice(0, Math.max(0, height))

  const center = (spans: Span[], within = width): Line => centerIn(spans, within)
  const { art, plain } = logoArt({ look: input.look, product, allowArt: size === "full" || input.look?.logoFont === "compact" || ["mascot", "custom"].includes(input.look?.logoKind ?? ""), width, center })
  // The pixel mascot needs v1's full density (24 rows, 65 columns) before its own size is even considered.
  const pixel = size === "full" ? pixelIdentity({ look: input.look, mascot: input.mascot, width }) : []
  // A taller identity gives way to the plain name before the Agent View does.
  const candidates: Array<Line[] | undefined> = art ? [art, plain] : [plain]

  const panelWidth = Math.min(54, Math.max(30, width - pad * 2 - 6), width)
  const inset = Math.floor((width - panelWidth) / 2)
  const sessions = input.sessions ?? []
  const gap = height < 14 || input.look?.density === "compact" ? 1 : input.look?.density === "spacious" ? 3 : size === "full" ? 2 : 1
  // One empty row always separates the header from the content, however tight the screen is.
  // The extension's rows come out of the centered block's room, leaving at least the logo line.
  const belowRows = below.slice(0, Math.max(0, height - header.length - 4))
  const belowSpace = belowRows.length > 0 ? belowRows.length + 1 : 0
  const room = Math.max(0, height - header.length - 1 - belowSpace)
  const build = (logo: Line[] | undefined, panelRoom: number): Line[] => {
    const view = input.look?.homePanel === false ? [] : input.look?.homeRightPanel === "actions" ? actionsPanel(Math.min(44, width - 4), height < 14 ? 1 : panelRoom).map((row) => centerIn(row, width)) : sessions.length
      ? fitAgentView({ sessions, panelWidth, caps: HOME_SECTION_CAPS, now: input.now ?? Date.now(), spinner: input.spinner ?? 0, ...(input.selectedId !== undefined ? { selectedId: input.selectedId } : {}), room: panelRoom }).map((row): Line => [{ text: " ".repeat(inset) }, ...row])
      : [center([{ text: EMPTY_TITLE, fg: "muted" }])]
    return [...(logo ? [...logo, ...(view.length ? blank(gap) : [])] : []), ...view]
  }
  // The shortest wordmark shrinks the Agent View to fit (v1); a taller font is used only when the whole Agent View fits beside it.
  let content: Line[] | undefined
  let mascotAt: HomeMascotBox | undefined
  // The pixel mascot first, largest fitting layout: it must leave the gap and at least one row of the Agent View.
  for (const layout of pixel) {
    if (layout.height + gap + 1 > room) continue
    const made = layout.build()
    const attempt = build(made.lines, room - made.lines.length - gap)
    if (attempt.length > room) continue
    content = attempt
    mascotAt = made.at
    break
  }
  if (!content) for (const logo of candidates) {
    const attempt = build(logo, (logo?.length ?? 0) > 3 && input.look?.logoKind !== "both" ? Number.POSITIVE_INFINITY : room - (logo?.length ?? 0) - gap)
    if (attempt.length <= room) {
      content = attempt
      break
    }
  }
  content ??= build(undefined, room)
  const top = 1 + Math.max(0, Math.floor((room - content.length) / 2))
  if (mascotAt) input.mascot?.shown?.({ ...mascotAt, row: header.length + top + mascotAt.row })
  return [...header, ...blank(top), ...content.slice(0, room), ...(belowRows.length > 0 ? [[], ...belowRows] : [])]
}

/**
 * v1's split welcome: one bordered box with the identity (wordmark or name, root, product and version) on the left and
 * the Agent View on the right. Narrower than the two columns need (42 cells of Agent View beside the identity) it stacks
 * them; a wordmark too wide for the columns gives way to the plain name first. There is no header row: the box holds the root.
 */
function splitHome(input: HomeInput, below: readonly Line[]): Line[] {
  const { width, height } = input
  const product = input.look?.productName ?? PRODUCT
  const inner = Math.max(24, width - 10)
  const sessions = input.sessions ?? []
  const wordmark = homeIdentity(input.look)
  const asciiWidth = rowsWidth(wordmark)
  const plainWidth = textWidth(product)
  const panelMin = input.look?.homeRightPanel === "actions" ? 30 : SPLIT_AGENT_MIN
  const twoColumnFits = (artWidth: number) => inner >= Math.max(24, artWidth) + panelMin + SPLIT_GAP
  const ascii = twoColumnFits(asciiWidth) || (asciiWidth <= inner && (input.look?.logoKind === "both" || !twoColumnFits(plainWidth)))
  // Without its panel (`homePanel` off) the box holds the identity alone, in one column.
  const twoColumn = input.look?.homePanel !== false && twoColumnFits(ascii ? asciiWidth : plainWidth)
  const artWidth = ascii ? asciiWidth : plainWidth
  const rightWidth = twoColumn ? Math.min(54, Math.max(panelMin, Math.floor(inner * 0.4)), inner - Math.max(24, artWidth) - SPLIT_GAP) : inner
  const leftWidth = twoColumn ? inner - rightWidth - SPLIT_GAP : inner
  const label = productLabel(product, input.version)

  const identityRows = (withArt: boolean): Line[] => {
    const art: Line[] = input.look?.logoKind === "none" ? [] : withArt && ascii ? wordmark.map((row) => centerIn([{ text: row + " ".repeat(asciiWidth - textWidth(row)), fg: "text" }], leftWidth)) : [centerIn([{ text: shortenMiddle(product, leftWidth), fg: "text" }], leftWidth)]
    const root = centerIn([{ text: shortenMiddle(input.root, Math.max(18, leftWidth - 2)), fg: "muted" }], leftWidth)
    return [...art, ...(input.look?.tagline ? [centerIn([{ text: shortenMiddle(input.look.tagline, leftWidth), fg: "muted" }], leftWidth)] : []), [], root, centerIn([{ text: shortenMiddle(label, leftWidth), fg: "muted" }], leftWidth)]
  }
  const belowRows = below.slice(0, Math.max(0, height - 12))
  const belowSpace = belowRows.length > 0 ? belowRows.length + 1 : 0
  // Top margin row, two border rows, one padding row above and below the content.
  const contentRoom = Math.max(1, height - 5 - belowSpace)
  const agent = (room: number): Line[] =>
    input.look?.homePanel === false ? [] : input.look?.homeRightPanel === "actions" ? actionsPanel(rightWidth, room) : sessions.length
      ? fitAgentView({ sessions, panelWidth: rightWidth, caps: HOME_SECTION_CAPS, now: input.now ?? Date.now(), spinner: input.spinner ?? 0, ...(input.selectedId !== undefined ? { selectedId: input.selectedId } : {}), room })
      : [[{ text: EMPTY_TITLE, fg: "muted" }]]
  const middle = (rows: Line[], rowsHigh: number): Line[] => [...blank(Math.floor((rowsHigh - rows.length) / 2)), ...rows]

  let content: Line[]
  if (twoColumn) {
    const full = identityRows(true)
    const identity = full.length <= contentRoom ? full : identityRows(false)
    const view = agent(contentRoom)
    const high = Math.min(contentRoom, Math.max(input.look?.density === "compact" ? 7 : input.look?.density === "spacious" ? 11 : SPLIT_MIN_CONTENT, identity.length, view.length))
    const left = middle(identity, high)
    const right = middle(view, high)
    content = Array.from({ length: high }, (_, y): Line => [...fit(left[y] ?? [], leftWidth), { text: " ".repeat(SPLIT_GAP) }, ...fit(right[y] ?? [], rightWidth)])
  } else {
    const full = identityRows(true)
    const identity = full.length + 3 <= contentRoom ? full : identityRows(false)
    const view = agent(Math.max(1, contentRoom - identity.length - 1)).map((row): Line => [{ text: " ".repeat(Math.floor((inner - rightWidth) / 2)) }, ...row])
    content = [...identity, ...(view.length ? [[], ...view] : [])].slice(0, contentRoom)
    content = [...content, ...blank(Math.min(contentRoom, SPLIT_MIN_CONTENT) - content.length)]
  }

  const margin: Span = { text: "  " }
  const edge = (left: string, right: string): Line => [margin, { text: `${left}${"─".repeat(Math.max(0, width - 6))}${right}`, fg: "border" }, margin]
  const bar: Span = { text: "│", fg: "border" }
  const row = (line: Line): Line => [margin, bar, { text: "  " }, ...fit(line, inner), { text: "  " }, bar, margin]
  return [[], edge("┌", "┐"), row([]), ...content.map(row), row([]), edge("└", "┘"), ...(belowRows.length > 0 ? [[], ...belowRows] : [])]
}
