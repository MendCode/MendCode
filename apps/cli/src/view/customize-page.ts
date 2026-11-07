import { GLYPH_CHOICES, glyphs as defaultGlyphs, setColorOverrides, themeNames, type Glyphs, type Line } from "../ui/theme"
import { columns, panelGrid, fit } from "./deck"
import { textWidth, truncateEnd, wrap } from "./wrap"
import { appearancePage, focusedWindow } from "./appearance-layout"
import { homeLook, renderHome, type HomeFooter, type HomeInput, type HomeSession } from "./home"
import { LOGO_FONTS, LOGO_FONT_NOTE, LOGO_TEXT_MAX } from "./logo-fonts"
import { META_MARGIN, placeholderFor, PROMPT_MARGIN, promptFrame, promptRow, renderStatusRow } from "./prompt-chrome"
import { ACTIVITY_MIN_CELLS, insideRoom, placeInside } from "./activity-status"
import { activityPartsOf, renderWorkingRow } from "./working-row"
import { SAMPLE_STATS } from "./session-stats"
import { diffViewNote, renderToolCard, SPINNER_FRAMES, splitDiffAt } from "./tool-card"
import { toolDesignNames, toolDesignOf } from "./tool-design"
import { TIMESTAMP_PLACES } from "./tui-profile"
import { overlayRule } from "./status-line"
import { statusItems } from "./status-items"
import { COMPACTION_PANELS, DENSITIES, DEFAULT_TUI_PROFILE, HEADING_STYLES, HOME_INPUTS, HOME_LAYOUTS, HOME_PANELS, LOGO_KINDS, MASCOT_SIZES, PET_SIZES, MARKDOWN_COLORS_MAX, MARKDOWN_COPY_HINTS, PROMPT_CHROMES, SIDEBAR_MODES, TABLE_STYLES, normalizeMarkdownColors, normalizeAscii, normalizeLogoText, normalizeProductName, normalizePromptGlyphs, normalizeActivityMap, normalizeActivityParts, normalizeStatParts, normalizeScrollbarGlyphs, normalizeFooterText, footerRowsText, parseFooterRowsText, parseQuotaRefreshText, quotaRefreshEditText, type TuiProfile } from "./tui-profile"
import { IMAGE_MODES } from "../pets/detect"
import { ALT_LABELS, QUOTA_COLORS, QUOTA_VIEWS, CODE_MAP_CARDS, DIFF_VIEWS, TOOL_DENSITIES, TOOL_LAYOUTS, TOOL_LAYOUT_NAMES, toolLayoutOf, KEY_PROTOCOLS, OPTION_KEYS, COMMENT_CHIP_STYLES, COMMENT_CHIPS, COMMENT_HINTS, COMMENT_KEYS, COMMENT_MODES, COMMENT_SENT_LAYOUTS } from "./tui-profile"
import { FILE_OPENERS } from "./links"
import { DEFAULT_IMAGE_ROOM, IMAGE_WAIT_COLORS, IMAGE_WAIT_MODES, IMAGE_WAIT_PRESETS, imageWaitConfig, imageWaitPresetNames } from "./image-wait"
import { mascotRows } from "./mascot"
import { STATUS_BUILTINS } from "./status-items"
import { ACTIVITY_PARTS, FOOTER_ICON_MODES, FOOTER_PACK_BUILTINS, FOOTER_PACK_OFF,FOOTER_PRESETS, FOOTER_PRESET_NAMES, footerRowsProblems, footerSegmentProblem, footerTextProblems, QUOTA_REFRESH_CLAUDE, QUOTA_REFRESH_COST, QUOTA_REFRESH_MIN_MINUTES, quotaRefreshProblems, parseMarkdownColors, STAT_PART_IDS, tuiProblems, unknownActivityParts, unknownStatParts } from "@mendcode/protocol/wire"
import { markdownStyleFor, renderMarkdown } from "./markdown"
import { MARKDOWN_SAMPLE } from "./markdown-sample"
import { renderTopbar, truncateMiddle } from "./topbar"
import { partsLine } from "./stat-parts"
import { SLASH_LAYOUTS, promptCostLine, promptCostOf, promptCostWarning, type PromptStatus } from "@mendcode/protocol/wire"
import { slashEditorKey, renderSlashEditor, type SlashEditorState } from "./slash-menu-editor"
import type { SlashCommand } from "./commands"
import type { ViewSlot } from "@mendcode/extension-api/views"
import { PROFILE_KEY_HELP } from "@mendcode/protocol/tui-key-help"
import type { SessionEvent } from "@mendcode/protocol"
import { HOME_TIPS } from "./home-tips"
import { pageSearchKey, pageSearchRow, searchMatches, type PageSearch } from "./page-search"
import { footerRowsOf } from "./footer-rows"
import { createTranscript, type PresentationMode } from "./transcript"
import { statusLineSpans } from "./status-line"
import { terminalTitle } from "./terminal-title"
import type { HomeMascot } from "./home"

import { CUSTOMIZE_ROWS, GROUPS, LABELS, type CustomizeRow } from "./customize-rows"
// The rows' sections and names are plain data in ./customize-rows (other pages read them); this page re-exports them.
export { CUSTOMIZE_ROWS, GROUPS, LABELS, type CustomizeRow }
type GroupTitle = (typeof GROUPS)[number]["title"]
const GROUP_OF = new Map<CustomizeRow, { group: GroupTitle; part: string }>(GROUPS.flatMap((group) => group.parts.flatMap((part) => part.rows.map((row) => [row, { group: group.title, part: part.title }] as const))))
export type CustomizePageState = { row: number; typing?: string; error?: string; module?: number; view?: number; menu?: SlashEditorState; search?: PageSearch }

/** What the page knows besides the profile: the view's mode (the full view draws default footer rows) and an extension that draws the footer. */
export type CustomizeFacts = { mode?: PresentationMode; footerExtension?: string }

/** The footer rows that draw the footer now (the user's, a preset's, or the full view's default), or none while one row does. */
const footerRowsNow = (profile: TuiProfile, facts: CustomizeFacts) => footerRowsOf({ mode: facts.mode ?? "balanced", profile, list: undefined })

/** The rows of the one-row footer that footer rows (or an extension's footer) leave without effect. */
const ONE_ROW_FOOTER = new Set<CustomizeRow>(["showAgent", "showModel", "showProvider", "showEffort", "statusLeft", "statusRight"])

/**
 * Whether a row is listed: a row that depends on something switched off is hidden with it (Top bar off hides what the top bar shows,
 * raw chat hides Markdown), so every listed row changes something on screen. The picked row is always listed.
 */
export function rowShown(row: CustomizeRow, profile: TuiProfile, facts: CustomizeFacts = {}): boolean {
  const part = GROUP_OF.get(row)?.part
  const kind = profile.logoKind
  if (part === "Markdown") return profile.presentation !== "raw" && profile.messageRenderer !== "plain"
  if (row === "logoText" || row === "logoFont") return kind === "wordmark" || kind === "both"
  if (row === "customAscii") return kind === "custom"
  if (row === "homeMascot" || row === "mascotMotion" || row === "mascotSize") return kind === "mascot" || kind === "both"
  if (row === "homeInput") return profile.homeLayout !== "split"
  if (row === "homeRightPanel") return profile.homePanel
  if (row === "homeTips") return HOME_TIPS.length > 0
  if (row === "placeholderText") return profile.showPlaceholder
  if ((part === "Footer" || part === "Segments" || part === "Quota") && row !== "showStatus" && !profile.showStatus) return false
  if (ONE_ROW_FOOTER.has(row) && (facts.footerExtension || footerRowsNow(profile, facts).rows.length > 0)) return false
  if (row === "quotaView" || row === "quotaColor" || row === "quotaRefresh") return profile.footerQuota || footerRowsNow(profile, facts).rows.some((entries) => entries.includes("quota"))
  if (row === "username") return profile.showUsername
  if (row === "scrollbarGlyphs") return profile.scrollbar !== "off"
  if (row === "jumpText") return profile.jumpHint !== "off"
  if (part === "Status" && row !== "activityPlacement") return profile.activityPlacement !== "off"
  if (row === "activityStates") return profile.activityMascot
  if (row === "imageWaitSpeed") return profile.imageWait !== "static"
  if (part === "Top bar" && row !== "showTopbar") return profile.showTopbar && (row !== "contextStyle" || profile.contextBar !== "off")
  if (row === "sidebarSide" || row === "sidebarHeader") return profile.sidebar !== "hidden"
  if (row === "titleTemplate" || row === "titleActivity") return profile.terminalTitle
  if (row === "pasteSummaryMinChars") return profile.pasteSummary
  if (row === "notifyWhen") return profile.turnNotify !== "off"
  if (GROUP_OF.get(row)?.group === "Comments" && row !== "comments") return profile.comments !== "off" && (row !== "commentMarkGlyph" || profile.commentMarks) && (row !== "commentHintSeconds" || profile.commentHint !== "off")
  return true
}

/** Whether `row` answers the search: its label, its section, its subheading or what it changes. */
export const rowMatches = (row: CustomizeRow, query: string) => searchMatches(query, [LABELS[row], row, GROUP_OF.get(row)?.group ?? "", GROUP_OF.get(row)?.part ?? "", PROFILE_KEY_HELP[row] ?? ""])

/** A row on the page now: shown for this profile and, while a search has words, matching them. */
const listed = (row: CustomizeRow, profile: TuiProfile, facts: CustomizeFacts, query = "") => rowShown(row, profile, facts) && rowMatches(row, query)

/** How many times ↓ moves from the first row to `row` with this profile: a hidden row is passed over. */
export function customizeSteps(row: CustomizeRow, profile: TuiProfile = DEFAULT_TUI_PROFILE, facts: CustomizeFacts = {}): number {
  return CUSTOMIZE_ROWS.slice(1, CUSTOMIZE_ROWS.indexOf(row) + 1).filter((field) => field === row || rowShown(field, profile, facts)).length
}

/** The next listed row from `from`, `delta` rows on; the same row at either end. */
function nextShown(from: number, delta: number, profile: TuiProfile, facts: CustomizeFacts, query = ""): number {
  for (let at = from + delta; at >= 0 && at < CUSTOMIZE_ROWS.length; at += delta) if (listed(CUSTOMIZE_ROWS[at]!, profile, facts, query)) return at
  return from
}

/** Rows that hold a whole number: ←→ step it (Enter types it), within the bounds the profile accepts. `auto` is 0 below `min`. */
const NUMBER_ROWS: Partial<Record<CustomizeRow, { min: number; max: number; step: number; auto?: true }>> = {
  imageWaitSpeed: { min: 80, max: 5000, step: 20 }, pasteSummaryMinChars: { min: 1, max: 100_000, step: 100 }, draftRetentionDays: { min: 0, max: 3650, step: 1 },
  wheelLines: { min: 1, max: 20, step: 1 }, sidebarWidth: { min: 32, max: 80, step: 2, auto: true },
  commentHintSeconds: { min: 1, max: 60, step: 1 }, commentCollapse: { min: 6, max: 40, step: 1 }, commentMax: { min: 1, max: 9, step: 1 },
}
function stepNumber(row: CustomizeRow, value: number, backwards: boolean): number {
  const range = NUMBER_ROWS[row]!
  if (range.auto && value === 0) return backwards ? 0 : range.min
  const next = value + (backwards ? -range.step : range.step)
  if (range.auto && next < range.min) return 0
  return Math.max(range.min, Math.min(range.max, next))
}
export type UiModule = { name: string; enabled: boolean; errors: string[] }
/** One view slot as the Views section lists it: who draws it, how it behaves, whether the user switched it off. */
export type UiView = { slot: ViewSlot; label: string; owner: string; disabled: boolean; tripped: boolean; strikes: number; calls: number; avgMs: number; lastError?: string }
export type CustomizeAction = { type: "none" } | { type: "close" } | { type: "set"; patch: Partial<TuiProfile> } | { type: "open"; command: string } | { type: "pet" } | { type: "reset" } | { type: "toggleExtension"; name: string } | { type: "exportLook" } | { type: "toggleView"; slot: ViewSlot } | { type: "resetView"; slot: ViewSlot } | { type: "scaffoldView"; slot: ViewSlot }
const NONE: CustomizeAction = { type: "none" }
export const createCustomizePageState = (): CustomizePageState => ({ row: 0 })
const rowAt = (state: CustomizePageState) => CUSTOMIZE_ROWS[Math.max(0, Math.min(state.row, CUSTOMIZE_ROWS.length - 1))]!
const TEXT_ROWS = new Set<CustomizeRow>(["imageWaitSpeed", "quotaRefresh", "footerRows", "footerText", "userIcon", "assistantIcon", "userLead", "assistantLead", "username", "statusLeft", "statusRight", "statusColors", "pasteSummaryMinChars", "draftRetentionDays", "logoText", "customAscii", "productName", "promptLead", "statusSeparator", "titleTemplate", "tagline", "promptGlyphs", "activityStates", "activityMessages", "doneSymbol", "wheelLines", "sidebarWidth", "markdownColors", "activityParts", "topbarStats", "jumpText", "scrollbarGlyphs", "placeholderText", "assistantName"])
/** The Comments rows that are typed (numbers, glyphs, the keys, the wording), with what each may hold. */
const COMMENT_TEXT_ROWS = ["commentHintSeconds", "commentCollapse", "commentMax", "commentMarkGlyph", "commentReplyKeys", "commentTemplate", "commentEntry"] as const
for (const row of COMMENT_TEXT_ROWS) TEXT_ROWS.add(row)
const COMMENT_TEXT_MAX: Record<(typeof COMMENT_TEXT_ROWS)[number], number> = { commentHintSeconds: 2, commentCollapse: 2, commentMax: 1, commentMarkGlyph: 2, commentReplyKeys: 4, commentTemplate: 1200, commentEntry: 1200 }
const COMMENT_TEXT_HELP: Record<(typeof COMMENT_TEXT_ROWS)[number], string> = {
  commentHintSeconds: "Use an integer 1..60",
  commentCollapse: "Use an integer 6..40",
  commentMax: "Use an integer 1..9",
  commentMarkGlyph: "Use one or two single-cell glyphs, or nothing for the default",
  commentReplyKeys: "Use four different letters: next, previous, comment, decide",
  commentTemplate: "Needs {comments}; may use {count} {note} {note_text}; write line breaks as \\n",
  commentEntry: "Needs {quote} and {text}; may use {n} {of} {cut}; write line breaks as \\n",
}
const CHOICES: Partial<Record<CustomizeRow, readonly string[]>> = {
  footerIcons: FOOTER_ICON_MODES, footerPack: [...FOOTER_PACK_BUILTINS, FOOTER_PACK_OFF], glyphs: GLYPH_CHOICES, altLabel: ALT_LABELS, quotaView: QUOTA_VIEWS, quotaColor: QUOTA_COLORS, keyProtocol: KEY_PROTOCOLS, optionKeys: OPTION_KEYS, viewerWrap: ["auto", "on", "off"],
  comments: COMMENT_MODES, commentKey: COMMENT_KEYS, commentHint: COMMENT_HINTS, commentChips: COMMENT_CHIPS, commentChipStyle: COMMENT_CHIP_STYLES, commentSentLayout: COMMENT_SENT_LAYOUTS,
  slashMenu: SLASH_LAYOUTS, processMode: ["daemon", "auto", "solo"],
  imageWait: IMAGE_WAIT_MODES, imageWaitColor: IMAGE_WAIT_COLORS,
  tableStyle: TABLE_STYLES, headingStyle: HEADING_STYLES, markdownCopyHints: MARKDOWN_COPY_HINTS,
  activitySound: ["off", "pulse", "hum"],
  promptStatus: ["off", "border"],
  attachmentChips: ["inline", "above", "both"],
  timestamps: TIMESTAMP_PLACES,
  scrollbar: ["auto", "always", "off"], jumpHint: ["right", "center", "left", "off"], activityPlacement: ["transcript", "above", "inside", "off"],
  turnNotify: ["off", "osc9", "osc777"],
  notifyWhen: ["unfocused", "always"],
  idleReturn: ["off", "30m", "1h", "3h"],
  compactionStyle: ["auto", "minimal", "cockpit", "quiet"],
  compactionPanel: COMPACTION_PANELS,
  contextBar: ["top", "off"], contextStyle: ["bar", "percent", "both"], messageLayout: ["quiet", "classic"], messageMeta: ["off", "compact", "full"],
  promptContext: ["minimal", "focus", "guide", "full", "custom"],
  messageRenderer: ["plain", "markdown", "full"], submitScroll: ["bottom", "clear"], presentation: ["auto", "raw", "minimal", "mendcode", "balanced", "full"], reasoning: ["auto", "hidden", "collapsed", "expanded"], toolOutput: ["auto", "collapsed", "expanded"], toolDensity: TOOL_DENSITIES, codeMapCard: CODE_MAP_CARDS, diffView: DIFF_VIEWS,
  logoKind: LOGO_KINDS, mascotSize: MASCOT_SIZES, petSize: PET_SIZES, logoFont: LOGO_FONTS, homeLayout: HOME_LAYOUTS, homeInput: HOME_INPUTS, homeRightPanel: HOME_PANELS, density: DENSITIES,
  promptBorder: ["auto", "single", "rounded", "double", "ascii"],
  promptChrome: PROMPT_CHROMES, sidebar: SIDEBAR_MODES, sidebarSide: ["left", "right"], panelNarrow: ["hide", "sheet"], images: IMAGE_MODES, fileOpener: FILE_OPENERS, pathClick: ["auto", "panel", "editor"],
}

/** The widest the label column gets: the longest label, up to 25 cells. */
const LABEL_COLUMN = Math.min(25, Math.max(...Object.values(LABELS).map(textWidth)))

/** The preset the profile's rows are, or `custom`. */
export function footerPresetOf(profile: TuiProfile): string {
  // No rows and the default on: the full view shows the `rows` preset by itself (balanced and minimalist their single row).
  if (profile.footerRows.length === 0 && profile.footerDefaultRows) return "default"
  return FOOTER_PRESET_NAMES.find((name) => JSON.stringify(FOOTER_PRESETS[name]!.rows) === JSON.stringify(profile.footerRows)) ?? "custom"
}

export { toolLayoutOf }

function textPatch(row: CustomizeRow, text: string, profile: TuiProfile): Partial<TuiProfile> {
  if (row === "commentHintSeconds" || row === "commentCollapse" || row === "commentMax") return { [row]: Number(text) }
  if (row === "pasteSummaryMinChars") return { pasteSummaryMinChars: Number(text) }
  if (row === "imageWaitSpeed") return { imageWaitSpeed: Number(text) }
  if (row === "draftRetentionDays") return { draftRetentionDays: Number(text) }
  if (row === "wheelLines") return { wheelLines: Number(text) }
  if (row === "sidebarWidth") return { sidebarWidth: Number(text) }
  if (row === "markdownColors") return { markdownColors: normalizeMarkdownColors(text) }
  if (row === "footerRows") return { footerRows: parseFooterRowsText(text) }
  if (row === "quotaRefresh") return { quotaRefresh: parseQuotaRefreshText(text) }
  if (row === "footerText") {
    try { return { footerText: normalizeFooterText(JSON.parse(text)) } } catch { return {} }
  }
  if (row === "logoText") return { logoText: normalizeLogoText(text, profile.logoFont) }
  if (row === "productName") return { productName: normalizeProductName(text) }
  if (row === "customAscii") return { customAscii: normalizeAscii(text), logoKind: "custom" }
  if (row === "promptGlyphs") return { promptGlyphs: normalizePromptGlyphs(text) }
  if (row === "activityParts") return { activityParts: normalizeActivityParts(text) }
  if (row === "topbarStats") return { topbarStats: normalizeStatParts(text) }
  if (row === "scrollbarGlyphs") return { scrollbarGlyphs: normalizeScrollbarGlyphs(text) }
  if (row === "activityStates" || row === "activityMessages") return { [row]: normalizeActivityMap(text, row === "activityStates") || (text.trim() ? profile[row] : "") }
  return { [row]: text }
}

/** The trust statement shown above the Views rows (and in docs/views.md): views are extension code, not sandboxed. */
export const VIEWS_TRUST = ["Views are not sandboxed: they run with your permissions."] as const

export function customizePageKey(state: CustomizePageState, key: string, profile: TuiProfile, modules: readonly UiModule[] = [], commands?: readonly SlashCommand[], views: readonly UiView[] = [], facts: CustomizeFacts = {}): { state: CustomizePageState; action: CustomizeAction } {
  if (state.menu) {
    const result = slashEditorKey(state.menu, key, profile, commands)
    return { state: result.close ? { row: state.row } : { ...state, menu: result.state }, action: result.patch ? { type: "set", patch: result.patch } : NONE }
  }
  const row = rowAt(state)
  if (state.typing !== undefined) {
    if (key === "\x1b") return { state: { row: state.row }, action: NONE }
    if (key === "\x7f" || key === "\b") return { state: { ...state, typing: state.typing.slice(0, -1) }, action: NONE }
    if (key === "\r") {
      if ((row === "statusLeft" || row === "statusRight") && state.typing.trim() && state.typing.split(",").some((name) => !STATUS_BUILTINS.includes(name.trim() as (typeof STATUS_BUILTINS)[number]))) return { state: { ...state, error: "Unknown status segment" }, action: NONE }
      if (row === "statusColors" && state.typing.trim()) {
        try {
          const colors = JSON.parse(state.typing)
          if (!colors || typeof colors !== "object" || Array.isArray(colors) || Object.entries(colors).some(([key, value]) => !STATUS_BUILTINS.includes(key as (typeof STATUS_BUILTINS)[number]) && footerSegmentProblem(key) !== undefined || typeof value !== "string" || !/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(value))) throw new Error()
        } catch { return { state: { ...state, error: "Use segment: #rgb JSON" }, action: NONE } }
      }
      if (row === "footerRows" && footerRowsProblems(parseFooterRowsText(state.typing)).length) return { state: { ...state, error: footerRowsProblems(parseFooterRowsText(state.typing))[0]!.replace(/^footerRows: /, "") }, action: NONE }
      if (row === "quotaRefresh" && quotaRefreshProblems(parseQuotaRefreshText(state.typing)).length) return { state: { ...state, error: `${quotaRefreshProblems(parseQuotaRefreshText(state.typing))[0]!.replace(/^quotaRefresh/, "")} · use codex:15, claude:30` }, action: NONE }
      if (row === "footerText" && state.typing.trim()) {
        let parsed: unknown
        try { parsed = JSON.parse(state.typing) } catch { return { state: { ...state, error: 'Use { "tagline": "text" } JSON' }, action: NONE } }
        const problems = footerTextProblems(parsed)
        if (problems.length) return { state: { ...state, error: problems[0]!.replace(/^footerText: /, "") }, action: NONE }
      }
      if (row === "footerText" && !state.typing.trim()) return { state: { row: state.row }, action: { type: "set", patch: { footerText: {} } } }
      if (row === "markdownColors" && state.typing.trim() && parseMarkdownColors(state.typing).error) return { state: { ...state, error: `Use { "mdHeading1": "#rrggbb" }: ${parseMarkdownColors(state.typing).error}` }, action: NONE }
      if ((COMMENT_TEXT_ROWS as readonly string[]).includes(row) && state.typing && (tuiProblems(textPatch(row, state.typing, profile)).length || ((row === "commentHintSeconds" || row === "commentCollapse" || row === "commentMax") && !/^\d+$/.test(state.typing)))) return { state: { ...state, error: COMMENT_TEXT_HELP[row as (typeof COMMENT_TEXT_ROWS)[number]] }, action: NONE }
      if (row === "draftRetentionDays" && (!/^\d+$/.test(state.typing) || tuiProblems({ draftRetentionDays: Number(state.typing) }).length)) return { state: { ...state, error: "Use an integer 0..3650 (0 keeps drafts)" }, action: NONE }
      if (row === "wheelLines" && (!/^\d+$/.test(state.typing) || tuiProblems({ wheelLines: Number(state.typing) }).length)) return { state: { ...state, error: "Use an integer 1..20" }, action: NONE }
      if (row === "sidebarWidth" && (!/^\d+$/.test(state.typing) || tuiProblems({ sidebarWidth: Number(state.typing) }).length)) return { state: { ...state, error: "Use 0 (automatic) or an integer 32..80" }, action: NONE }
      if (row === "imageWaitSpeed" && (!/^\d+$/.test(state.typing) || tuiProblems({ imageWaitSpeed: Number(state.typing) }).length)) return { state: { ...state, error: "Use an integer 80..5000" }, action: NONE }
      if (row === "pasteSummaryMinChars" && tuiProblems({ pasteSummaryMinChars: Number(state.typing) }).length) return { state: { ...state, error: "Use an integer 1..100000" }, action: NONE }
      if (state.typing.trim() && (row === "activityStates" || row === "activityMessages") && !normalizeActivityMap(state.typing, row === "activityStates")) return { state: { ...state, error: "Invalid phase map JSON" }, action: NONE }
      if (state.typing && row === "promptGlyphs" && !normalizePromptGlyphs(state.typing)) return { state: { ...state, error: "Use six single-cell border glyphs" }, action: NONE }
      if (state.typing.trim() && row === "activityParts" && unknownActivityParts(state.typing).length) return { state: { ...state, error: `Unknown part: ${ACTIVITY_PARTS.join(", ")}` }, action: NONE }
      if (state.typing.trim() && row === "topbarStats" && unknownStatParts(state.typing).length) return { state: { ...state, error: `Unknown part: ${STAT_PART_IDS.join(", ")}` }, action: NONE }
      if (state.typing && row === "scrollbarGlyphs" && !normalizeScrollbarGlyphs(state.typing)) return { state: { ...state, error: "Use a thumb glyph, then an optional track glyph" }, action: NONE }
      return { state: { row: state.row }, action: { type: "set", patch: textPatch(row, state.typing, profile) } }
    }
    if (row === "customAscii" && (key === "\x0a" || key === "\x1b\r")) return { state: { ...state, typing: `${state.typing}\n` }, action: NONE }
    if ((row === "customAscii" ? /^[^\x00-\x09\x0b-\x1f\x7f-\x9f]+$/u : /^[^\x00-\x1f\x7f-\x9f]+$/u).test(key)) {
      const max = (COMMENT_TEXT_ROWS as readonly string[]).includes(row) ? COMMENT_TEXT_MAX[row as (typeof COMMENT_TEXT_ROWS)[number]] : row === "markdownColors" ? MARKDOWN_COLORS_MAX : row === "footerRows" ? 600 : row === "footerText" ? 2000 : row === "quotaRefresh" ? 200 : row === "statusColors" ? 4096 : row === "statusLeft" || row === "statusRight" ? 256 : row === "username" ? 64 : row === "activityStates" || row === "activityMessages" ? 16_000 : row === "tagline" ? 80 : row === "placeholderText" ? 120 : row === "assistantName" ? 32 : row === "promptGlyphs" ? 12 : row === "activityParts" ? 256 : row === "topbarStats" ? 128 : row === "jumpText" ? 40 : row === "scrollbarGlyphs" ? 2 : row === "doneSymbol" ? 2 : row === "customAscii" ? 1452 : row === "logoText" ? LOGO_TEXT_MAX[profile.logoFont] : row === "titleTemplate" ? 180 : row === "promptLead" ? 12 : row === "statusSeparator" ? 8 : 32
      return { state: { ...state, typing: (state.typing + key).slice(0, max) }, action: NONE }
    }
    return { state, action: NONE }
  }
  // `/` filters the rows by name, section and what they change; Enter goes to the picked row, Esc clears the filter.
  const searched = pageSearchKey(state.search, key)
  if (searched) {
    const { search, event } = searched
    const query = search.open ? search.query : ""
    const here = listed(rowAt(state), profile, facts, query) ? state.row : nextShown(-1, 1, profile, facts, query)
    const row = here < 0 ? state.row : here
    return { state: { row, ...(event === "changed" ? { search } : {}) }, action: NONE }
  }
  const query = state.search?.query ?? ""
  if (key === "\x1b" || key === "q") return { state, action: { type: "close" } }
  if (["\x1b[A", "\x1bOA", "\x10", "k", "\x1b[B", "\x1bOB", "\x0e", "j"].includes(key)) {
    const delta = ["\x1b[A", "\x1bOA", "\x10", "k"].includes(key) ? -1 : 1
    const next = nextShown(state.row, delta, profile, facts, query)
    // The picked view slot survives moving between the Views rows: "New view file" writes the one picked above it.
    return { state: next === state.row ? state : { row: next, ...(state.view !== undefined ? { view: state.view } : {}), ...(state.search ? { search: state.search } : {}) }, action: NONE }
  }
  const backwards = ["\x1b[D", "\x1bOD", "h"].includes(key)
  // Views: ←→ pick a slot, enter switches its custom view off or on, r clears its faults (and its switch).
  if (row === "views" || row === "viewScaffold") {
    const picked = views[Math.min(state.view ?? 0, Math.max(0, views.length - 1))]
    if (row === "views" && key === "r" && picked) return { state, action: { type: "resetView", slot: picked.slot } }
    if (!picked) return { state, action: NONE }
    if (row === "viewScaffold") return { state, action: key === "\r" ? { type: "scaffoldView", slot: picked.slot } : NONE }
    if (key === "\r" || key === " ") return { state, action: { type: "toggleView", slot: picked.slot } }
    if (backwards || ["\x1b[C", "\x1bOC", "l"].includes(key)) return { state: { ...state, view: (views.indexOf(picked) + (backwards ? -1 : 1) + views.length) % views.length }, action: NONE }
    return { state, action: NONE }
  }
  if (!backwards && !["\x1b[C", "\x1bOC", "l", " ", "\r"].includes(key)) return { state, action: NONE }
  if (row === "exportLook") return { state, action: key === "\r" ? { type: "exportLook" } : NONE }
  if (row === "slashCommands") return { state: { ...state, menu: { selected: 0 } }, action: NONE }
  if (row === "extensions") {
    if (!modules.length) return { state, action: NONE }
    const selected = Math.min(state.module ?? 0, modules.length - 1)
    if (key === "\r" || key === " ") return { state, action: { type: "toggleExtension", name: modules[selected]!.name } }
    return { state: { ...state, module: (selected + (backwards ? -1 : 1) + modules.length) % modules.length }, action: NONE }
  }
  if (row === "pet") return { state, action: key === "\r" ? { type: "pet" } : { type: "set", patch: { pet: profile.pet && profile.pet !== "off" ? "off" : "mend" } } }
  if (row === "reset") return { state, action: key === "\r" ? { type: "reset" } : NONE }
  if (row === "footerPreset") {
    const names = ["default", ...FOOTER_PRESET_NAMES]
    const at = names.indexOf(footerPresetOf(profile))
    const name = names[at < 0 ? (backwards ? names.length - 1 : 0) : (at + (backwards ? -1 : 1) + names.length) % names.length]!
    if (name === "default") return { state, action: { type: "set", patch: { footerRows: [], footerDefaultRows: true } } }
    const next = FOOTER_PRESETS[name]!
    return { state, action: { type: "set", patch: { footerRows: next.rows.map((entry) => [...entry]), ...(next.profile ?? {}) } } }
  }
  if (row === "toolLayout") {
    const at = TOOL_LAYOUT_NAMES.indexOf(toolLayoutOf(profile) as (typeof TOOL_LAYOUT_NAMES)[number])
    const name = TOOL_LAYOUT_NAMES[at < 0 ? (backwards ? TOOL_LAYOUT_NAMES.length - 1 : 0) : (at + (backwards ? -1 : 1) + TOOL_LAYOUT_NAMES.length) % TOOL_LAYOUT_NAMES.length]!
    return { state, action: { type: "set", patch: { ...TOOL_LAYOUTS[name] } } }
  }
  if (NUMBER_ROWS[row] && key !== "\r" && key !== " ") return { state, action: { type: "set", patch: { [row]: stepNumber(row, Number(profile[row as keyof TuiProfile]) || 0, backwards) } as Partial<TuiProfile> } }
  if (TEXT_ROWS.has(row)) return { state: key === "\r" ? { ...state, typing: row === "quotaRefresh" ? quotaRefreshEditText(profile.quotaRefresh) : row === "footerRows" ? footerRowsText(profile.footerRows) : row === "footerText" ? (Object.keys(profile.footerText).length ? JSON.stringify(profile.footerText) : "") : String(profile[row as keyof TuiProfile]) } : state, action: NONE }
  if (row === "promptContext") return { state, action: { type: "open", command: "prompt-mode" } }
  // The mascot is the ASCII Mend or an installed pet: its list (with previews) is the `/mascot` page.
  if (row === "homeMascot") return { state, action: { type: "open", command: "mascot" } }
  if (row === "capabilityCatalogue") return { state, action: { type: "open", command: "help" } }
  // A daemon setting, not a look: `/graph default` saves it for every project (`/graph on|off` overrides one).
  if (row === "graphIndex") return { state, action: key === "\r" || key === " " || key === "\x1b[C" || key === "\x1b[D" ? { type: "open", command: "graph default next" } : NONE }
  // The built-in presets, then the user's own (`imageWaitArt` in the profile file).
  if (row === "imageWaitPreset") {
    const names = imageWaitPresetNames(profile.imageWaitArt)
    return { state, action: { type: "set", patch: { imageWaitPreset: names[(Math.max(0, names.indexOf(profile.imageWaitPreset)) + (backwards ? -1 : 1) + names.length) % names.length]! } } }
  }
  const value = profile[row]
  const list = row === "theme" ? themeNames() : row === "toolDesign" ? toolDesignNames() : CHOICES[row]
  if (list) {
    const next = list[(Math.max(0, list.indexOf(String(value))) + (backwards ? -1 : 1) + list.length) % list.length]!
    const patch = row === "messageLayout" ? { messageLayout: next, messageMeta: next === "classic" ? "full" : "off", userIcon: next === "classic" ? "●" : "", userLead: next === "classic" ? "" : "›", userLabel: next === "classic", assistantIcon: "", assistantLead: next === "classic" ? "" : "•", assistantLabel: false, userTint: next !== "classic" } : row === "presentation" ? { presentation: next, messageRenderer: next === "raw" ? "plain" : next === "minimal" ? "markdown" : "full", reasoning: next === "raw" ? "expanded" : "collapsed" } : row === "logoFont" ? { logoFont: next, logoText: normalizeLogoText(profile.logoText, next as TuiProfile["logoFont"]) } : { [row]: next }
    return { state, action: { type: "set", patch: patch as Partial<TuiProfile> } }
  }
  return { state, action: { type: "set", patch: { [row]: !value } } }
}

/** What the preview draws with besides the profile; the callbacks are the terminal's own drawing with the previewed profile in place of the saved one. */
export type CustomizePreviewInput = {
  root: string
  /** The columns the chat's transcript lays out in now (a diff is split by this width, not the terminal's). */
  chatWidth?: number
  version?: string
  sessions?: readonly HomeSession[]
  tip: string
  mcp?: HomeFooter["mcp"]
  now: number
  model?: string
  provider?: string
  agent?: string
  effort?: string
  loops?: number
  phase?: string
  /** The view the chat draws in; Chat presentation picks another one in the sample. */
  mode?: PresentationMode
  /** The footer the chat draws (the user's own rows, presets and extensions included). */
  footer?: (width: number, profile: TuiProfile) => Line[]
  /** The status line of `promptStatus: border`, `room` cells wide. */
  statusLine?: (room: number, profile: TuiProfile) => Line | undefined
  /** The start screen's pet mascot, as the real home gets it. */
  mascot?: HomeMascot | undefined
  /** The session's title and branch, for the top bar and the window title. */
  session?: { title: string; branch?: string }
}

export type CustomizeInput = {
  commands?: readonly SlashCommand[]
  title?: string
  modules?: readonly UiModule[]
  views?: readonly UiView[]
  state: CustomizePageState; profile: TuiProfile; pet?: string
  /** The name of the pet that is the start screen's mascot, when the list of pets has been read. */
  mascot?: string
  /** Where the code graph indexes by default (`codegraph_index`): auto, on or off. */
  graphIndex?: string
  /** The prompt status, for the cost notice under the prompt context row. */
  promptStatus?: PromptStatus
  preview: CustomizePreviewInput
  facts?: CustomizeFacts
  /** Called when the preview drew the home's pet mascot, with where the preview's first cell is on the page (for the picture). */
  mascotAt?: (origin: { row: number; col: number }) => void
  width: number; height: number; glyphs?: Glyphs
}

/** The Markdown sample drawn by the full view's engine with the profile's Markdown settings, and the profile's colour overrides applied while the page is up. */
function markdownPreview(profile: TuiProfile, width: number): Line[] {
  setColorOverrides(parseMarkdownColors(profile.markdownColors).colors)
  return renderMarkdown(MARKDOWN_SAMPLE, width, "body", { style: markdownStyleFor({ profile, mode: "full" }) })
}

/** A running image call as the transcript draws it with the profile's wait canvas, on its first frame, shrunk to the pane's rows. */
function imageWaitPreview(profile: TuiProfile, width: number, height: number): Line[] {
  const room = { ...DEFAULT_IMAGE_ROOM, rows: Math.max(3, height - 1) }
  return renderToolCard({ title: "image_gen: a lighthouse at dusk", text: "model openai/gpt-image-2\nsize 1536x1024\n", status: "running", width, expanded: false, frame: 0, tailLines: 0, elapsedMs: 4_000, imageWait: imageWaitConfig(profile, false, room) })
}

const DIFF_SAMPLE = [
  "@@ -12,5 +12,5 @@",
  " export function total(items: Item[]) {",
  "-  let sum = 0",
  "-  for (const item of items) sum += item.price",
  "+  const sum = items.reduce((acc, item) => acc + item.price * item.qty, 0)",
  "+  if (sum < 0) throw new RangeError(\"negative total\")",
  "-  return sum",
  "+  return Math.round(sum * 100) / 100",
  " }",
].join("\n")

/** What `diffView` does in the chat now, then a sample edit drawn that way: the pane is narrower than the chat, so the choice follows the chat's width. */
function diffViewPreview(profile: TuiProfile, width: number, height: number, chatWidth: number): Line[] {
  const split = splitDiffAt(profile.diffView, chatWidth)
  const note = diffViewNote(profile.diffView, chatWidth)
  const card = renderToolCard({ title: "edit: src/cart.ts", text: DIFF_SAMPLE, status: "ok", width, expanded: true, level: "preview", frame: 0, tailLines: 0, ...(split ? { splitDiff: true } : {}), design: toolDesignOf(profile.toolDesign) })
  return [...wrap(note, Math.max(1, width - 1)).map((text): Line => [{ text, fg: "muted" }]), [], ...card].slice(0, height)
}

/** What the preview pane draws for a row: the part of the screen the row changes. */
export type PreviewScene = "home" | "chat" | "prompt" | "status" | "activity" | "markdown" | "diff" | "image" | "about"
const SCENE_TITLES: Record<PreviewScene, string> = { home: "Home preview", chat: "Chat preview", prompt: "Prompt and footer preview", status: "Activity status preview", activity: "Activity preview", markdown: "Markdown preview", diff: "Diff preview", image: "Image wait preview", about: "What it does" }

export function previewScene(row: CustomizeRow): PreviewScene {
  const { group, part } = GROUP_OF.get(row) ?? { group: "Advanced", part: "" }
  if (row === "diffView" || row === "toolDesign") return "diff"
  if (part === "Markdown") return "markdown"
  if (group === "Look" || group === "Chat" || part === "Top bar") return "chat"
  if (group === "Home") return "home"
  if (group === "Prompt & footer") return "prompt"
  if (part === "Status") return "status"
  if (row === "activityMascot" || row === "activityStates" || row === "activityMessages") return "activity"
  if (part === "Image wait") return "image"
  return "about"
}

/** The sample conversation, drawn by a real transcript: a question, reasoning, a read, an edit and an answer with Markdown. */
const SAMPLE_ANSWER = [
  "The total now counts quantities.",
  "",
  "## What changed",
  "- `total()` multiplies **price × qty**",
  "- a negative total throws a `RangeError`",
  "",
  "| Item | Qty | Price |",
  "| --- | ---: | ---: |",
  "| Pen | 2 | 1.50 |",
  "| Book | 1 | 12.00 |",
].join("\n")

/** The view a presentation draws in (`settings.ts` applies the same when the row changes); `auto` keeps the tier's. */
export const presentationMode = (presentation: TuiProfile["presentation"], view: PresentationMode): PresentationMode =>
  presentation === "auto" ? view : presentation === "raw" ? "full" : presentation === "mendcode" ? "balanced" : presentation

let sampleCache: { key: string; lines: Line[] } | undefined
function sampleChat(input: { profile: TuiProfile; mode: PresentationMode; width: number; chatWidth: number; glyphs: Glyphs; now: number }): Line[] {
  const { profile, width, glyphs, now } = input
  const mode = presentationMode(profile.presentation, input.mode)
  // One sample per look and width: the page redraws on every key, the transcript is built again only when something it draws changed.
  const key = `${JSON.stringify(profile)}|${mode}|${width}|${input.chatWidth}|${glyphs.sep}`
  if (sampleCache?.key === key) return sampleCache.lines
  const transcript = createTranscript({ appearance: profile, mode, glyphs, now: () => now, frame: () => 0, motion: () => false, splitDiff: () => splitDiffAt(profile.diffView, input.chatWidth) })
  let seq = 0
  const emit = (event: Record<string, unknown>) => transcript.apply({ sessionId: "session_sample", seq: ++seq, at: now - 60_000, ...event } as unknown as SessionEvent)
  emit({ type: "turn.started", turnId: "turn_sample", queueId: "queue_sample" })
  const item = (itemId: string, kind: string, text: string, tool?: string) => {
    emit({ type: "item.started", turnId: "turn_sample", itemId, kind, ...(tool ? { meta: { tool } } : {}) })
    if (kind === "tool_call") emit({ type: "item.delta", itemId, text })
    emit({ type: "item.completed", itemId, status: "ok", text })
  }
  item("item_user", "user_message", "Make the cart total count quantities")
  item("item_think", "reasoning", "The total sums prices only; it has to multiply by qty and reject a negative result.")
  item("item_read", "tool_call", "export function total(items: Item[]) {\n  let sum = 0\n  for (const item of items) sum += item.price\n  return sum\n}", "read: src/cart.ts")
  item("item_edit", "tool_call", DIFF_SAMPLE, "edit: src/cart.ts")
  item("item_answer", "agent_message", SAMPLE_ANSWER)
  emit({ type: "turn.completed", turnId: "turn_sample", status: "ok" })
  const lines = transcript.viewport(width, 400, 0).map((line) => line.spans)
  sampleCache = { key, lines }
  return lines
}

/** The top bar over the sample, from the profile's top bar rows. */
function sampleTopbar(profile: TuiProfile, preview: CustomizePreviewInput, width: number): Line {
  const stats = profile.topbarStats ? partsLine(profile.topbarStats.split(","), SAMPLE_STATS, { quiet: true }) : []
  const inner = renderTopbar({
    width: width - PROMPT_MARGIN * 2, path: profile.showProject ? preview.root : "", hideProject: !profile.showProject,
    ...(profile.showProject ? { branch: preview.session?.branch ?? "main" } : {}),
    title: profile.showSessionTitle ? preview.session?.title || "Cart total" : "",
    ...(profile.showDiffFiles ? { files: 1 } : {}), ...(profile.showDiffLines ? { diff: { added: 3, removed: 3 } } : {}),
    ...(profile.contextBar !== "off" ? { context: { tokens: 22_000, limit: 200_000 } } : {}), contextStyle: profile.contextStyle,
    ...(stats.length ? { stats } : {}),
  })
  return [{ text: " ".repeat(PROMPT_MARGIN) }, ...inner]
}

/** The prompt as the chat draws it with the profile, then the footer under it. */
function promptBlock(input: { profile: TuiProfile; preview: CustomizePreviewInput; width: number; glyphs: Glyphs; home: boolean; activity: boolean }): { prompt: Line[]; footer: Line[] } {
  const { profile, preview, width, glyphs } = input
  const frame = promptFrame({ preset: profile.promptChrome, width, glyphs, rich: true, placement: profile.statusPlacement, lead: profile.promptLead, border: profile.promptBorder, borders: profile.promptGlyphs })
  const values = { mode: preview.agent ?? "", model: preview.model ?? "", provider: preview.provider ?? "", reasoning: preview.effort ?? "" }
  const status = (w: number) => renderStatusRow({ width: w, ...(profile.statusLeft ? { leftItems: statusItems(profile.statusLeft, profile.statusColors, values, profile.statusSeparator) } : {}), ...(profile.statusRight ? { rightItems: statusItems(profile.statusRight, profile.statusColors, values, profile.statusSeparator) } : {}), ...(profile.showModel && preview.model && profile.promptStatus !== "border" ? { model: preview.model } : {}), ...(profile.showProvider && preview.provider && profile.promptStatus !== "border" ? { provider: preview.provider } : {}), ...(profile.showAgent && preview.agent ? { agent: preview.agent } : {}), separator: profile.statusSeparator, ...(profile.showEffort && preview.effort && profile.promptStatus !== "border" ? { effort: preview.effort } : {}), loops: preview.loops ?? 0 })
  // The activity status as the live frame draws it (same renderers): a row above the prompt, over its top rule, or at the end of its first row.
  const placement = input.activity && profile.showActivity ? profile.activityPlacement : "off"
  const ruleOffset = PROMPT_MARGIN + (profile.promptChrome === "top-bottom" ? 2 : 3)
  const sample = (room: number, overlay: boolean): Line => renderWorkingRow({
    width: room, margin: overlay ? 0 : META_MARGIN, spinner: SPINNER_FRAMES[0], phase: "Generating...", now: preview.now, parts: activityPartsOf(profile.activityParts), style: profile.activityStyle, groupSeparator: glyphs.sep, ...(profile.activityTokens ? { tokenFigures: profile.activityTokens.split(",") } : {}), stats: SAMPLE_STATS, ...(overlay ? { separator: glyphs.sep } : {}),
    ...(profile.showElapsed ? { elapsedMs: 81_000 } : {}), ...(profile.showTokens ? { tokens: { input: 45_200, output: 1240 } } : {}), tokensPerSecond: 42, queued: 1, interruptHint: profile.showInterruptHint,
    ...(profile.showActivityModel && preview.model ? { model: preview.model } : {}),
  })
  const ruled = profile.promptChrome !== "minimal" && frame.top.length === 1
  // `promptStatus: border`: the READY › model › … line over the top rule, as the chat draws it (the activity takes the rule while a turn works).
  const lineRoom = width - PROMPT_MARGIN * 2 - 6
  const statusLine = ruled && profile.promptStatus === "border" ? preview.statusLine?.(lineRoom, profile) ?? statusLineSpans({ stateLabel: "READY", state: "idle", glyphs, ...(preview.model ? { model: preview.model } : {}), ...(preview.effort ? { effort: preview.effort } : {}), repo: preview.root.split(/[\\/]/).filter(Boolean).at(-1) ?? "project", branch: preview.session?.branch ?? "main", contextPercent: 11 }, lineRoom) : undefined
  const top: Line[] = placement === "above" && ruled ? [overlayRule(frame.top[0]!, sample(width - ruleOffset - 4, true), ruleOffset)] : statusLine?.length ? [overlayRule(frame.top[0]!, statusLine, ruleOffset)] : frame.top
  const placeholder = input.home && profile.showPlaceholder && placement !== "inside" ? profile.placeholderText || placeholderFor(0) : undefined
  const typed = frame.row(promptRow({ text: "", first: true, rich: true, glyphs, lead: profile.promptLead, ...(placeholder ? { placeholder } : {}) }))
  const first = placement === "inside" ? placeInside({ row: typed, width, right: width - (frame.rightEdge ?? PROMPT_MARGIN), label: sample(Math.max(ACTIVITY_MIN_CELLS, insideRoom(frame.inset, width - (frame.rightEdge ?? PROMPT_MARGIN))), true) }) : typed
  const prompt: Line[] = [...(placement === "transcript" ? [sample(width, false)] : []), ...top, first, ...frame.bottom, ...(profile.promptChrome === "minimal" ? [[]] : [])]
  const footer = profile.showStatus ? preview.footer?.(width, profile) ?? [status(width)] : []
  return { prompt, footer }
}

/** The home with the prompt where `homeInput` puts it: under the logo, or at the bottom over the footer. */
function homeScene(input: { profile: TuiProfile; preview: CustomizePreviewInput; width: number; height: number; screenHeight: number; screenWidth?: number; glyphs: Glyphs; showPrompt: boolean; onMascot?: () => void }): Line[] {
  const { profile, preview, width, height } = input
  const mascot = preview.mascot && (profile.logoKind === "mascot" || profile.logoKind === "both") ? { ...preview.mascot, shown: (at: Parameters<NonNullable<HomeMascot["shown"]>>[0]) => { preview.mascot?.shown?.(at); input.onMascot?.() } } : undefined
  const home = (rows: number, prompt?: HomeInput["prompt"]) => renderHome({ width, height: rows, screenHeight: input.screenHeight, ...(input.screenWidth ? { screenWidth: input.screenWidth } : {}), root: preview.root, ...(preview.version ? { version: preview.version } : {}), sessions: preview.sessions ?? [], now: preview.now, look: homeLook(profile), ...(profile.homeTips && preview.tip ? { tip: preview.tip } : {}), ...(profile.homeFooter ? { footer: preview.mcp ? { mcp: preview.mcp } : {} } : {}), ...(mascot ? { mascot } : {}), ...(prompt ? { prompt } : {}) })
  if (!input.showPrompt) return home(height)
  const { prompt, footer } = promptBlock({ profile, preview, width, glyphs: input.glyphs, home: true, activity: false })
  const room = Math.max(0, height - footer.length)
  let gap: number | undefined
  const lifted = profile.homeInput !== "bottom" && profile.homeLayout !== "split" ? home(room, { rows: prompt.length, at: profile.homeInput, placed: (row) => { gap = row } }) : undefined
  if (lifted && gap !== undefined) return [...lifted.slice(0, gap), ...prompt, ...lifted.slice(gap + prompt.length, room), ...Array.from({ length: Math.max(0, room - lifted.length) }, (): Line => []), ...footer]
  const rest = Math.max(0, room - prompt.length)
  const drawn = home(rest)
  return [...Array.from({ length: rest }, (_, y) => drawn[y] ?? []), ...prompt, ...footer]
}

/** The sample conversation under the top bar, the prompt and the footer under it, as the chat lays them out. */
function chatScene(input: { profile: TuiProfile; preview: CustomizePreviewInput; width: number; height: number; glyphs: Glyphs; activity: boolean }): Line[] {
  const { profile, preview, width, height, glyphs } = input
  const { prompt, footer } = promptBlock({ profile, preview, width, glyphs, home: false, activity: input.activity })
  const top = profile.showTopbar ? [sampleTopbar(profile, preview, width)] : []
  const room = Math.max(0, height - top.length - prompt.length - footer.length)
  const chat = sampleChat({ profile, mode: preview.mode ?? "balanced", width, chatWidth: preview.chatWidth ?? width, glyphs, now: preview.now })
  // The newest rows when it does not fit, as the chat follows the bottom; a short one starts under the bar after one blank row.
  const body = chat.length >= room ? chat.slice(chat.length - room) : [[], ...chat].slice(0, room)
  return [...top, ...body, ...Array.from({ length: Math.max(0, room - body.length) }, (): Line => []), ...prompt, ...footer]
}

/** A row's own words: what it changes, what it is set to now, the default and the choices. For rows with nothing to draw (keys, notices, processes). */
function aboutScene(input: { row: CustomizeRow; profile: TuiProfile; preview: CustomizePreviewInput; value: string; width: number }): Line[] {
  const { row, profile, width } = input
  const lines: Line[] = [[{ text: LABELS[row], fg: "primary", bold: true }], []]
  for (const text of wrap(PROFILE_KEY_HELP[row] ?? "", Math.max(1, width))) lines.push([{ text, fg: "text" }])
  lines.push([], [{ text: "Now      ", fg: "muted" }, { text: input.value || "none", fg: "primary" }])
  const fallback = (DEFAULT_TUI_PROFILE as Record<string, unknown>)[row]
  if (fallback !== undefined && typeof fallback !== "object") lines.push([{ text: "Default  ", fg: "muted" }, { text: typeof fallback === "boolean" ? fallback ? "on" : "off" : String(fallback) || "none", fg: "text" }])
  const list = row === "theme" ? undefined : CHOICES[row]
  if (list) for (const [index, text] of wrap(list.join(" · "), Math.max(1, width - 9)).entries()) lines.push([{ text: index ? "         " : "Choices  ", fg: "muted" }, { text, fg: "text" }])
  if (row === "terminalTitle" || row === "titleTemplate" || row === "titleActivity") {
    const title = profile.terminalTitle ? terminalTitle({ template: profile.titleTemplate, product: profile.productName, session: input.preview.session?.title || "Cart total", route: "chat", path: input.preview.root, state: "generating", activity: profile.titleActivity, ...(input.preview.model ? { model: input.preview.model } : {}), branch: input.preview.session?.branch ?? "main" }) : "the terminal's own title"
    lines.push([], [{ text: "Title    ", fg: "muted" }, { text: truncateEnd(title, Math.max(1, width - 9)), fg: "text" }])
  }
  if (NUMBER_ROWS[row]) lines.push([], [{ text: "←→ change by " + NUMBER_ROWS[row]!.step + " · enter types a value", fg: "muted" }])
  return lines
}

export function customizePreview(input: { profile: TuiProfile; preview: CustomizePreviewInput; screenHeight: number; screenWidth?: number; width: number; height: number; glyphs: Glyphs; surface?: PreviewScene; showPrompt?: boolean; row?: CustomizeRow; value?: string; onMascot?: () => void }): Line[] {
  const { profile, preview, width, height, glyphs } = input
  const scene = input.surface ?? "home"
  const done = (lines: Line[]) => Array.from({ length: Math.max(0, height) }, (_, y) => fit(lines[y] ?? [], width))
  if (scene === "image") return done(imageWaitPreview(profile, width, height))
  if (scene === "diff") return done(diffViewPreview(profile, width, height, preview.chatWidth ?? input.screenWidth ?? width))
  if (scene === "markdown") return done(markdownPreview(profile, width))
  if (scene === "about") return done(aboutScene({ row: input.row ?? "theme", profile, preview, value: input.value ?? "", width }))
  if (scene === "home") return done(homeScene({ profile, preview, width, height, screenHeight: input.screenHeight, ...(input.screenWidth ? { screenWidth: input.screenWidth } : {}), glyphs, showPrompt: input.showPrompt !== false, ...(input.onMascot ? { onMascot: input.onMascot } : {}) }))
  if (scene === "activity") {
    const phase = preview.phase ?? "idle"
    const states = profile.activityStates ? JSON.parse(profile.activityStates) : {}
    const art: Line[] = states[phase] || states.idle ? (states[phase] || states.idle).split("\n").map((text: string) => [{ text, fg: "text" }]) : mascotRows(phase)
    const messages = profile.activityMessages ? JSON.parse(profile.activityMessages) : {}
    const { prompt, footer } = promptBlock({ profile, preview, width, glyphs, home: false, activity: true })
    const shown = [...art, ...(messages[phase] ? [[{ text: messages[phase], fg: "text" as const }]] : [])]
    // A short pane keeps every row of the art before the prompt and the footer get any.
    if (shown.length + prompt.length + footer.length > height) return done(shown)
    const room = Math.max(0, height - prompt.length - footer.length)
    return done([...Array.from({ length: room }, (_, y) => shown[y - Math.max(0, room - shown.length)] ?? []), ...prompt, ...footer])
  }
  return done(chatScene({ profile, preview, width, height, glyphs, activity: scene === "status" }))
}

/** The value a row shows between its arrows. */
function rowValue(field: CustomizeRow, profile: TuiProfile, input: CustomizeInput): string {
  if (field === "graphIndex") return `${input.graphIndex ?? "auto"} · git repos under 10,000 files`
  if (field === "views") return `${(input.views ?? []).filter((view) => view.owner !== "built-in").length} custom`
  if (field === "viewScaffold") return "enter writes a starter"
  if (field === "slashCommands") return "enter edit"
  if (field === "extensions") return `${input.modules?.length ?? 0} loaded`
  if (field === "exportLook") return "enter export"
  if (field === "reset" || field === "capabilityCatalogue") return ""
  if (field === "pet") return profile.pet || input.pet || "off"
  if (field === "homeMascot") return profile.homeMascot === "mend" ? "mend (ASCII) · enter choose" : `${input.mascot ?? profile.homeMascot} · enter choose`
  if (field === "quotaRefresh") return profile.quotaRefresh.length ? quotaRefreshEditText(profile.quotaRefresh) : "off · nothing is sent"
  if (field === "footerPreset") return footerPresetOf(profile)
  if (field === "toolLayout") return toolLayoutOf(profile)
  if (field === "footerRows") return profile.footerRows.length ? footerRowsText(profile.footerRows) : "off · one row"
  if (field === "footerText") return Object.keys(profile.footerText).length ? JSON.stringify(profile.footerText) : "none"
  if (field === "sidebarWidth" && profile.sidebarWidth === 0) return "auto"
  const value = profile[field as keyof TuiProfile]
  if (typeof value === "boolean") return value ? "on" : "off"
  return String(value || (["theme", "activityStates", "activityMessages", "promptGlyphs", "placeholderText"].includes(field) ? "default" : field === "customAscii" ? "default art" : "none"))
}

/** What a few rows say under themselves when picked, beyond what the row changes (that is the preview's or the key help's). */
function rowNotes(field: CustomizeRow, profile: TuiProfile, input: CustomizeInput): Line[] {
  const muted = (text: string): Line => [{ text, fg: "muted" }]
  switch (field) {
    case "messageRenderer": return [muted(profile.messageRenderer === "full" ? "Markdown, diagrams and tables" : profile.messageRenderer === "markdown" ? "Markdown; diagrams shown as source" : "Unformatted text")]
    case "promptStatus": return [muted(profile.promptStatus === "border" ? "border: READY › model › effort › project › branch over the prompt's top rule" : "off: the prompt's top rule stays a plain line; border draws the status there")]
    case "promptContext": {
      if (!input.promptStatus) return []
      const mode = input.promptStatus.mode
      return [muted(promptCostLine(promptCostOf(input.promptStatus, mode))), ...(promptCostWarning(mode) ? [[{ text: promptCostWarning(mode), fg: "warning" as const }]] : [])]
    }
    case "commentSentLayout": return [muted(profile.commentSentLayout === "stack" ? "Your message, a blank row, each quote over its comment" : profile.commentSentLayout === "inline" ? "1 “quote” → comment on one row when it fits, else two" : "Your message, a count line, the numbered pairs on a rail")]
    case "quotaRefresh": return [[{ text: `Off until set: codex:15, claude:30 (minutes, at least ${QUOTA_REFRESH_MIN_MINUTES}). The daemon asks while a terminal is open; ${QUOTA_REFRESH_COST}.`, fg: "warning" }], muted(`${QUOTA_REFRESH_CLAUDE}; the Codex engine's probe only reads rate limits.`)]
    case "toolLayout": return [muted("Sets the three rows below: quiet, default, detailed, everything")]
    case "tableStyle": return [muted("auto is box; box, rules, grid, minimal in the full view")]
    case "headingStyle": return [muted("auto underlines in full, bold in balanced; or banner, bold, underline, uppercase")]
    case "markdownCopyHints": return [muted("code in balanced, code + table/diagram in full; ctrl+x Y copies any block")]
    case "homeMascot": return [muted("mend: the ASCII mascot. Or any pet (full tier): /pet import <picture> adds your own")]
    case "mascotMotion": return [muted("on: a pet mascot plays its frames. off: one still frame. Reduced motion always holds it still")]
    case "mascotSize": return [muted("A pet mascot's box: small 24x12, medium 32x16, large 44x22 cells. A screen too small for it gets the next smaller")]
    case "petSize": return [muted("The session pet's box: small 10x5, medium 16x8, large 24x12 cells; half blocks take about half as many again. Not the ASCII Mend")]
    case "logoKind": return [muted("wordmark: letters · mascot · both · custom: your own art · none")]
    case "logoFont": return [muted(LOGO_FONT_NOTE[profile.logoFont])]
    case "productName": return [muted("Named on the home's first row, in the window title and when the logo does not fit")]
    case "homeInput": return [muted("bottom: as in chat · center: under the logo, both centered · top: under the logo at the top")]
    case "altLabel": return [muted("auto: opt on a Mac, alt elsewhere; or alt, opt, symbol (⌥). Only the hints change, not keybindings.json")]
    case "optionKeys": return [muted("auto: on a Mac, œ ¬ ® π ≤ ≥ typed alone run opt+q l r p , . where that key works; off types them")]
    case "keyProtocol": return [muted("auto: on a Mac, asks the terminal for real key reports so Option+key is Alt+key; off never asks")]
    case "processMode": return [muted("daemon: separate process. auto/solo: less RAM; a hard-killed terminal interrupts its turn; slower first frame")]
    case "markdownColors": return [muted("Roles: mdHeading1, mdTableBorder, synFlag… (docs/design/markdown-parity.md)")]
    case "imageWait": return [muted("static holds the first frame; so does reduced motion")]
    case "imageWaitPreset": return [muted(IMAGE_WAIT_PRESETS.join(", ")), muted(profile.imageWaitArt.length ? `Yours: ${profile.imageWaitArt.map((art) => art.name).join(", ")}` : "Your own: imageWaitArt in tui/profile.json")]
    case "activitySound": return [muted(profile.activitySound === "off" ? "Silent" : profile.activitySound === "pulse" ? "Pulse on completion or approval" : "Hum while working; pulse when done")]
    case "views": return [muted("←→ slot · enter on/off · r clears its faults")]
    case "extensions": return [muted("←→ module · enter on/off")]
    default: return NUMBER_ROWS[field] ? [muted("←→ change · enter type a value")] : []
  }
}

/** The line over the footer rows when they cannot change it: footer rows of the user's, a preset's, or an extension's footer. */
function footerOwner(profile: TuiProfile, facts: CustomizeFacts): string | undefined {
  if (facts.footerExtension) return `Extension ${facts.footerExtension} draws the footer; the rows below only reach what it leaves.`
  const { rows, builtIn } = footerRowsNow(profile, facts)
  if (!rows.length) return undefined
  const preset = footerPresetOf(profile)
  return builtIn ? "The full view's footer rows are in use: Footer rows edits them." : preset === "custom" ? "Your own footer rows are in use: the one-row options don't apply." : `The ${preset} footer rows are in use: the one-row options don't apply.`
}

/** Where the preview pane's first cell lands on the page: the page's two rows and margin, the panels' borders, padding and gap. */
function previewOrigin(input: { wide: boolean; inner: number; optionsWeight: number; optionsRoom: number }): { row: number; col: number } {
  if (!input.wide) return { row: 2 + input.optionsRoom + 4 + 1 + 1, col: 2 + 2 }
  const left = columns(input.inner, [input.optionsWeight, 1 - input.optionsWeight], 1)[0]!
  return { row: 2 + 1 + 1, col: 2 + left + 1 + 2 }
}

export function renderCustomizePage(input: CustomizeInput): Line[] {
  if (input.state.menu) return renderSlashEditor({ state: input.state.menu, profile: input.profile, ...(input.commands ? { commands: input.commands } : {}), width: input.width, height: input.height })
  const { state, profile, width, height } = input
  const facts = input.facts ?? { ...(input.preview.mode ? { mode: input.preview.mode } : {}) }
  const row = rowAt(state)
  const shown = state.typing === undefined ? profile : { ...profile, ...textPatch(row, state.typing, profile) }
  const query = state.search?.query ?? ""
  const inner = width - 4
  // Side by side from 90 columns (the choices get half until 120); narrower, the preview goes under the choices.
  const wide = width >= 90
  const optionsWeight = width < 120 ? 0.5 : 0.45
  const leftWidth = wide ? columns(inner, [optionsWeight, 1 - optionsWeight])[0]! : inner
  // The label column fits the longest label when there is room, and a label longer than it is cut, never run into its value.
  const choicesWidth = leftWidth - 4
  const labelWidth = Math.min(LABEL_COLUMN, Math.max(10, choicesWidth - 2 - 1 - 4 - 12))
  const valueRoom = Math.max(1, choicesWidth - 2 - labelWidth - 1 - 4)
  const rows: Line[] = []
  let focus = 0
  let focusEnd = 0
  const searchRow = pageSearchRow(state.search, CUSTOMIZE_ROWS.filter((field) => listed(field, profile, facts, query)).length, choicesWidth)
  if (searchRow) rows.push(searchRow, [])
  for (const group of GROUPS) {
    const fields = (part: (typeof group.parts)[number]) => part.rows.filter((field) => field === row || listed(field, profile, facts, query))
    if (!group.parts.some((part) => fields(part).length)) continue
    rows.push([{ text: group.title, fg: "primary", bold: true }])
    for (const part of group.parts) {
      const list = fields(part)
      if (!list.length) continue
      if (part.title) rows.push([{ text: part.title, fg: "muted" }])
      // What was verified about views, stated where they are managed: no sandbox, so installing one is trusting its author.
      if (part.title === "Views") rows.push([{ text: VIEWS_TRUST[0], fg: "warning" }])
      if (part.title === "Footer" && profile.showStatus) {
        const owner = footerOwner(profile, facts)
        if (owner) rows.push([{ text: owner, fg: "muted" }])
      }
      for (const field of list) {
        const selected = field === row
        if (selected) focus = rows.length
        const value = rowValue(field, profile, input)
        const text = selected && state.typing !== undefined ? `${state.typing.replace(/\n/g, " ↵ ")}_` : value.replace(/\n/g, " ↵ ")
        rows.push([{ text: selected ? "❯ " : "  ", fg: "primary" }, { text: `${truncateEnd(LABELS[field], labelWidth).padEnd(labelWidth)} `, fg: selected ? "primary" : "text" }, ...(field === "reset" || field === "capabilityCatalogue" ? [] : [{ text: `‹ ${truncateMiddle(text, valueRoom)} ›`, fg: "muted" as const }])])
        if (selected) {
          // The row says what it is: its own note, else what it changes on screen.
          const notes = rowNotes(field, profile, input)
          rows.push(...(notes.length ? notes : PROFILE_KEY_HELP[field] ? [[{ text: PROFILE_KEY_HELP[field]!, fg: "muted" as const }]] : []))
          if (state.error) rows.push([{ text: state.error, fg: "error" }])
        }
        // Only the slots with a custom view and the one picked are listed: the other built-ins are one ←→ away.
        if (field === "views") {
          const listedViews = (input.views ?? []).map((view, index) => ({ view, here: selected && index === (state.view ?? 0) })).filter(({ view, here }) => view.owner !== "built-in" || here)
          const slotWidth = Math.max(0, ...listedViews.map(({ view }) => textWidth(view.slot)))
          const ownerWidth = Math.max(0, ...listedViews.map(({ view }) => textWidth(view.owner)))
          for (const { view, here } of listedViews) {
            const status = view.disabled ? "off" : view.tripped ? "stopped" : view.owner === "built-in" ? "" : "on"
            const timing = view.calls ? `${view.avgMs.toFixed(1)}ms` : ""
            rows.push([{ text: `${here ? "  ›" : "   "} ${view.slot.padEnd(slotWidth)}  ${view.owner.padEnd(ownerWidth)}  `, fg: here ? "primary" : "text" }, { text: [status, timing].filter(Boolean).join(" · "), fg: view.tripped ? "error" : "muted" }])
            if (view.lastError && here) rows.push([{ text: `    ${view.lastError}`, fg: "error" }])
          }
        }
        if (field === "extensions") for (const [index, module] of (input.modules ?? []).entries()) {
          rows.push([{ text: `${selected && index === (state.module ?? 0) ? "  ›" : "   "} ${module.enabled ? "on " : "off"} ${module.name}`, fg: module.errors.length ? "error" : "text" }])
          for (const error of module.errors) rows.push([{ text: `    ${error}`, fg: "error" }])
        }
        if (selected) focusEnd = rows.length - 1
      }
    }
    rows.push([])
  }
  if (query && !CUSTOMIZE_ROWS.some((field) => listed(field, profile, facts, query))) rows.push([{ text: "No row matches", fg: "muted" }])
  // A note wider than the panel wraps instead of being cut; the window keeps the picked row and as much of its notes as fit.
  const choiceRows: Line[] = []
  let focusRow = 0
  let focusLast = 0
  for (const [index, line] of rows.entries()) {
    if (index === focus) focusRow = choiceRows.length
    if (line.length === 1 && textWidth(line[0]!.text) > choicesWidth) for (const text of wrap(line[0]!.text, choicesWidth)) choiceRows.push([{ ...line[0]!, text }])
    else choiceRows.push(line)
    if (index === focusEnd) focusLast = choiceRows.length - 1
  }
  const room = Math.max(1, height - 2)
  // Stacked, a short screen gives the choices a third; a tall one keeps most rows for the preview (a Markdown sample is long).
  const optionsRoom = wide ? room - 7 : Math.max(3, Math.floor(room * (room >= 30 ? 0.25 : 0.35)))
  // Stacked panels have no padding: the choices box holds two rows more than optionsRoom.
  const choicesHeight = Math.max(1, wide ? room - 4 : optionsRoom + 2)
  const scene = previewScene(row)
  const options = { title: "Choices", weight: optionsWeight, body: [...(searchRow ? choiceRows.slice(0, 2) : []), ...focusedWindow(searchRow ? choiceRows.slice(2) : choiceRows, Math.max(focusRow, Math.min(focusLast, focusRow + choicesHeight - 2)) - (searchRow ? 2 : 0), choicesHeight - (searchRow ? 2 : 0))] }
  let mascotShown = false
  const preview = { title: SCENE_TITLES[scene], weight: 1 - optionsWeight, body: (w: number) => customizePreview({ profile: shown, preview: input.preview, screenHeight: height, screenWidth: width, width: w, height: Math.max(1, wide ? room - 4 : room - optionsRoom - 6), glyphs: input.glyphs ?? defaultGlyphs(), surface: scene, row, value: rowValue(row, shown, input), onMascot: () => { mascotShown = true } }) }
  const body = panelGrid({ rows: wide ? [[options, preview]] : [[options], [preview]], width: inner, heights: wide ? [room] : [optionsRoom + 4, room - optionsRoom - 5], compact: false, padding: wide, maxColumns: wide ? 2 : 1 })
  if (mascotShown) input.mascotAt?.(previewOrigin({ wide, inner, optionsWeight, optionsRoom }))
  const hints = state.typing !== undefined ? "type · enter save · esc cancel" : state.search?.open ? "type to filter · ↑↓ row · enter go · esc clear" : "↑↓ row · ←→ change · enter edit · / search · esc back"
  return appearancePage({ title: input.title ?? "Customize", hints, body, width, height })
}
