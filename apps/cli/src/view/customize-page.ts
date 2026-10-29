import { GLYPH_CHOICES, glyphs as defaultGlyphs, setColorOverrides, themeNames, type Glyphs, type Line } from "../ui/theme"
import { columns, panelGrid, fit } from "./deck"
import { textWidth, truncateEnd, wrap } from "./wrap"
import { appearancePage, focusedWindow } from "./appearance-layout"
import { homeLook, renderHome, type HomeFooter, type HomeSession } from "./home"
import { LOGO_FONTS, LOGO_FONT_NOTE, LOGO_TEXT_MAX } from "./logo-fonts"
import { META_MARGIN, placeholderFor, PROMPT_MARGIN, promptFrame, promptRow, renderStatusRow } from "./prompt-chrome"
import { ACTIVITY_MIN_CELLS, insideRoom, placeInside } from "./activity-status"
import { activityPartsOf, renderWorkingRow } from "./working-row"
import { SAMPLE_STATS } from "./session-stats"
import { diffViewNote, renderToolCard, SPINNER_FRAMES, splitDiffAt } from "./tool-card"
import { overlayRule } from "./status-line"
import { statusItems } from "./status-items"
import { COMPACTION_PANELS, DENSITIES, HEADING_STYLES, HOME_LAYOUTS, HOME_PANELS, LOGO_KINDS, MASCOT_SIZES, PET_SIZES, MARKDOWN_COLORS_MAX, MARKDOWN_COPY_HINTS, PROMPT_CHROMES, SIDEBAR_MODES, TABLE_STYLES, normalizeMarkdownColors, normalizeAscii, normalizeLogoText, normalizeProductName, normalizePromptGlyphs, normalizeActivityMap, normalizeActivityParts, normalizeStatParts, normalizeScrollbarGlyphs, normalizeFooterText, footerRowsText, parseFooterRowsText, parseQuotaRefreshText, quotaRefreshEditText, type TuiProfile } from "./tui-profile"
import { IMAGE_MODES } from "../pets/detect"
import { ALT_LABELS, QUOTA_COLORS, QUOTA_VIEWS, CODE_MAP_CARDS, DIFF_VIEWS, TOOL_DENSITIES, TOOL_LAYOUTS, TOOL_LAYOUT_NAMES, toolLayoutOf, KEY_PROTOCOLS, OPTION_KEYS, COMMENT_CHIP_STYLES, COMMENT_CHIPS, COMMENT_HINTS, COMMENT_KEYS, COMMENT_MODES, COMMENT_SENT_LAYOUTS } from "./tui-profile"
import { FILE_OPENERS } from "./links"
import { DEFAULT_IMAGE_ROOM, IMAGE_WAIT_COLORS, IMAGE_WAIT_MODES, IMAGE_WAIT_PRESETS, imageWaitConfig, imageWaitPresetNames } from "./image-wait"
import { mascotRows } from "./mascot"
import { STATUS_BUILTINS } from "./status-items"
import { ACTIVITY_PARTS, FOOTER_ICON_MODES, FOOTER_PRESETS, FOOTER_PRESET_NAMES, footerRowsProblems, footerSegmentProblem, footerTextProblems, QUOTA_REFRESH_CLAUDE, QUOTA_REFRESH_COST, QUOTA_REFRESH_MIN_MINUTES, quotaRefreshProblems, parseMarkdownColors, STAT_PART_IDS, tuiProblems, unknownActivityParts, unknownStatParts } from "@mendcode/protocol/wire"
import { markdownStyleFor, renderMarkdown } from "./markdown"
import { MARKDOWN_SAMPLE } from "./markdown-sample"
import { truncateMiddle } from "./topbar"
import { SLASH_LAYOUTS, promptCostLine, promptCostOf, promptCostWarning, type PromptStatus } from "@mendcode/protocol/wire"
import { slashEditorKey, renderSlashEditor, type SlashEditorState } from "./slash-menu-editor"
import type { SlashCommand } from "./commands"
import type { ViewSlot } from "@mendcode/extension-api/views"

/** The sections of the /customize page, each with its rows (the docs coverage map names every title). */
export const GROUPS = [
  { title: "Extensions", rows: ["extensions", "exportLook"] },
  { title: "Views", rows: ["views", "viewScaffold"] },
  { title: "Slash menu", rows: ["slashMenu", "slashCommands"] },
  { title: "Home", rows: ["logoKind", "homeMascot", "mascotMotion", "mascotSize", "logoText", "logoFont", "customAscii", "productName", "tagline", "homeLayout", "homeRightPanel", "density", "homeTips", "homeFooter", "homeHeader", "homePanel", "showPlaceholder", "placeholderText"] },
  { title: "Prompt & footer", rows: ["promptChrome", "promptStatus", "promptBorder", "promptGlyphs", "promptLead", "statusSeparator", "showAgent", "showModel", "showProvider", "showEffort", "showPermission", "footerQuota", "quotaView", "quotaColor", "quotaRefresh", "footerToday", "footerPreset", "footerRows", "footerText", "footerIcons", "showStatus", "showCommandHint", "showAgentHint", "attachmentChips"] },
  { title: "Session chrome", rows: ["presentation", "messageRenderer", "messageLayout", "userIcon", "userLabel", "userLead", "userTint", "assistantIcon", "assistantLabel", "assistantName", "assistantLead", "messageMeta", "submitScroll", "timestamps", "username", "showUsername", "scrollbar", "scrollbarGlyphs", "jumpHint", "jumpText", "pasteSummary", "pasteSummaryMinChars", "copyOnSelect", "vimMode", "multiline", "shortcutOverlay", "escBacktrack", "queueRestore", "escRetract", "pasteBurst", "draftRetentionDays", "reasoning", "toolLayout", "toolOutput", "toolDensity", "codeMapCard", "diffView", "contextBar", "contextStyle", "topbarStats", "showTopbar", "showSessionTitle", "stickyPrompt", "showTasks", "showProject", "showDiffLines", "showDiffFiles", "terminalTitle", "titleTemplate", "titleActivity", "sessionAccent", "activityPlacement", "activityParts", "showActivity", "showElapsed", "showTokens", "showInterruptHint", "showStalled", "usageNotices", "cacheNotices", "confirmNotices", "activityMascot", "activityStates", "activityMessages", "showActivityModel", "doneSymbol"] },
  { title: "Markdown", rows: ["tableStyle", "headingStyle", "markdownCopyHints", "markdownRtl", "markdownColors"] },
  { title: "Status segments", rows: ["statusLeft", "statusRight", "statusColors"] },
  { title: "Comments", rows: ["comments", "commentKey", "commentHint", "commentHintSeconds", "commentChips", "commentChipStyle", "commentCollapse", "commentMax", "commentMarks", "commentMarkGlyph", "commentReplyKeys", "commentFolded", "commentSentLayout", "commentTemplate", "commentEntry"] },
  { title: "Capabilities", rows: ["capabilityCatalogue", "promptContext", "graphIndex"] },
  { title: "Terminal", rows: ["sidebar", "sidebarSide", "sidebarHeader", "sidebarWidth", "panelNarrow", "panelHeader", "theme", "turnBell", "turnNotify", "notifyWhen", "autoRecap", "idleReturn", "resumePrompts", "images", "transcriptImages", "hyperlinks", "fileOpener", "pathClick", "viewerNumbers", "viewerWrap", "viewerFocus", "wheelLines", "altLabel", "keyProtocol", "optionKeys", "rightClickPaste", "altScreen", "accessible", "glyphs", "processMode", "pet", "petSize", "usageClock", "reset", "activitySound"] },
  { title: "Image generation", rows: ["imageWait", "imageWaitPreset", "imageWaitSpeed", "imageWaitColor", "imageWaitMeta"] },
  { title: "Compaction", rows: ["limitCheckpoint", "compactionPanel", "compactionStyle", "compactionProgress", "compactionScratchpad"] },
] as const
export const CUSTOMIZE_ROWS = GROUPS.flatMap((group) => [...group.rows])
export type CustomizeRow = (typeof CUSTOMIZE_ROWS)[number]
export type CustomizePageState = { row: number; typing?: string; error?: string; module?: number; view?: number; menu?: SlashEditorState }
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
  footerIcons: FOOTER_ICON_MODES, glyphs: GLYPH_CHOICES, altLabel: ALT_LABELS, quotaView: QUOTA_VIEWS, quotaColor: QUOTA_COLORS, keyProtocol: KEY_PROTOCOLS, optionKeys: OPTION_KEYS, viewerWrap: ["auto", "on", "off"],
  comments: COMMENT_MODES, commentKey: COMMENT_KEYS, commentHint: COMMENT_HINTS, commentChips: COMMENT_CHIPS, commentChipStyle: COMMENT_CHIP_STYLES, commentSentLayout: COMMENT_SENT_LAYOUTS,
  slashMenu: SLASH_LAYOUTS, processMode: ["daemon", "auto", "solo"],
  imageWait: IMAGE_WAIT_MODES, imageWaitColor: IMAGE_WAIT_COLORS,
  tableStyle: TABLE_STYLES, headingStyle: HEADING_STYLES, markdownCopyHints: MARKDOWN_COPY_HINTS,
  activitySound: ["off", "pulse", "hum"],
  promptStatus: ["off", "border"],
  attachmentChips: ["inline", "above", "both"],
  scrollbar: ["auto", "always", "off"], jumpHint: ["right", "center", "left", "off"], activityPlacement: ["transcript", "above", "inside", "off"],
  turnNotify: ["off", "osc9", "osc777"],
  notifyWhen: ["unfocused", "always"],
  idleReturn: ["off", "30m", "1h", "3h"],
  compactionStyle: ["auto", "minimal", "cockpit", "quiet"],
  compactionPanel: COMPACTION_PANELS,
  contextBar: ["top", "off"], contextStyle: ["bar", "percent", "both"], messageLayout: ["quiet", "classic"], messageMeta: ["off", "compact", "full"],
  promptContext: ["minimal", "focus", "guide", "full", "custom"],
  messageRenderer: ["plain", "markdown", "full"], submitScroll: ["bottom", "clear"], presentation: ["auto", "raw", "minimal", "mendcode", "balanced", "full"], reasoning: ["auto", "hidden", "collapsed", "expanded"], toolOutput: ["auto", "collapsed", "expanded"], toolDensity: TOOL_DENSITIES, codeMapCard: CODE_MAP_CARDS, diffView: DIFF_VIEWS,
  logoKind: LOGO_KINDS, mascotSize: MASCOT_SIZES, petSize: PET_SIZES, logoFont: LOGO_FONTS, homeLayout: HOME_LAYOUTS, homeRightPanel: HOME_PANELS, density: DENSITIES,
  promptBorder: ["auto", "single", "rounded", "double", "ascii"],
  promptChrome: PROMPT_CHROMES, sidebar: SIDEBAR_MODES, sidebarSide: ["left", "right"], panelNarrow: ["hide", "sheet"], images: IMAGE_MODES, fileOpener: FILE_OPENERS, pathClick: ["auto", "panel", "editor"],
}
const LABELS: Record<CustomizeRow, string> = {
  comments: "Comments", commentKey: "Comment key", commentHint: "Comment hint", commentHintSeconds: "Hint seconds", commentChips: "Comment chips", commentChipStyle: "Chip style", commentCollapse: "Collapse at", commentMax: "Most comments", commentMarks: "Margin marks", commentMarkGlyph: "Mark glyph", commentReplyKeys: "Reply keys", commentFolded: "Fold sent", commentSentLayout: "Sent layout", commentTemplate: "Message template", commentEntry: "Comment template",
  slashMenu: "Menu layout", slashCommands: "Edit commands", processMode: "Processes",
  imageWait: "Wait canvas", imageWaitPreset: "Wait art", imageWaitSpeed: "Frame time (ms)", imageWaitColor: "Wait colour", imageWaitMeta: "Model and size",
  tableStyle: "Table style", headingStyle: "Heading style", markdownCopyHints: "Copy hints", markdownRtl: "Right-to-left", markdownColors: "Markdown colors",
  limitCheckpoint: "Pre-limit checkpoint",
  activitySound: "Activity sound", promptStatus: "Status line", sidebarWidth: "Right bar width",
  scrollbarGlyphs: "Scrollbar glyphs", jumpHint: "Jump to latest", jumpText: "Jump text", activityPlacement: "Activity status", activityParts: "Activity parts",
  compactionPanel: "Compaction panel", compactionStyle: "Compaction card", compactionProgress: "Stage progress", compactionScratchpad: "Scratchpad",
  extensions: "UI modules", exportLook: "Export look", views: "Views", viewScaffold: "New view file",
  messageLayout: "Message layout", userIcon: "User icon", assistantIcon: "Assistant icon", userLabel: "User label", assistantLabel: "Assistant label", assistantName: "Assistant name", userLead: "User lead", assistantLead: "Assistant lead", userTint: "User tint", messageMeta: "Message meta",
  messageRenderer: "Message renderer", submitScroll: "Submit scroll", timestamps: "Timestamps", username: "Username", showUsername: "Show username", scrollbar: "Scrollbar", pasteSummary: "Paste summaries", pasteSummaryMinChars: "Paste threshold", copyOnSelect: "Copy on select", vimMode: "Vim mode", multiline: "Enter adds a line", shortcutOverlay: "? shortcut overlay", escBacktrack: "Esc Esc backtrack", queueRestore: "Interrupt restores queue", escRetract: "Esc takes back unanswered", pasteBurst: "Paste burst detection", draftRetentionDays: "Draft retention (days)", statusLeft: "Left segments", statusRight: "Right segments", statusColors: "Segment colors JSON", capabilityCatalogue: "Capabilities", promptContext: "Prompt context", graphIndex: "Code graph index",
  tagline: "Tagline", promptGlyphs: "Border glyphs", activityStates: "Mascot states JSON", activityMessages: "Activity text JSON", showActivityModel: "Activity model", doneSymbol: "Completion symbol",
  presentation: "Chat presentation", reasoning: "Reasoning", toolLayout: "Tool layout", toolOutput: "Tool output", toolDensity: "Tool density", codeMapCard: "Code map card", diffView: "Diff view",
  logoKind: "Logo kind", homeMascot: "Mascot", mascotMotion: "Mascot motion", mascotSize: "Mascot size", logoText: "Logo text", logoFont: "Logo font", customAscii: "Custom ASCII", productName: "Product name", homeLayout: "Welcome layout", homeRightPanel: "Split panel", density: "Density", homeTips: "Tips", homeFooter: "Home footer", homeHeader: "Home header", homePanel: "Home panel", showPlaceholder: "Prompt example", placeholderText: "Example text",
  promptBorder: "Prompt border", showAgent: "Agent label", showEffort: "Reasoning effort", showPermission: "Permissions", quotaRefresh: "Quota refresh", footerPreset: "Footer preset", footerRows: "Footer rows", footerText: "Footer text JSON", footerIcons: "Footer icons", glyphs: "Glyphs", footerQuota: "Footer quota", quotaView: "Quota shows", quotaColor: "Quota colour", footerToday: "Footer today",
  promptChrome: "Prompt chrome", promptLead: "Prompt lead", statusSeparator: "Separator", showModel: "Model", showProvider: "Provider", showStatus: "Footer", showCommandHint: "Commands hint", showAgentHint: "Agents hint", attachmentChips: "Attachments",
  contextBar: "Context bar", contextStyle: "Context style", topbarStats: "Top bar stats", showTopbar: "Top bar", showSessionTitle: "Session title", stickyPrompt: "Pinned prompt", showTasks: "Running tasks", showProject: "Project location", showDiffLines: "Diff lines", showDiffFiles: "Changed files", terminalTitle: "Window title", titleTemplate: "Title template", titleActivity: "Title activity", showStalled: "Stalled hint", usageNotices: "Limit notices", cacheNotices: "Cache notices", confirmNotices: "Confirmations", sessionAccent: "Session accent", showActivity: "Activity text", showElapsed: "Elapsed time", showTokens: "Activity tokens", showInterruptHint: "Interrupt hint", activityMascot: "Activity mascot",
  usageClock: "Usage clock", altScreen: "Alternate screen", accessible: "Screen reader", turnNotify: "Desktop notice", notifyWhen: "Notify when", autoRecap: "Recap on return", idleReturn: "Idle prompt", resumePrompts: "Resume prompts", sidebar: "Sidebar", sidebarSide: "Sidebar side", sidebarHeader: "Sidebar header", panelNarrow: "Panel when narrow", panelHeader: "Panel header", theme: "Theme", turnBell: "Bell", images: "Images", transcriptImages: "Transcript images", hyperlinks: "Hyperlinks", fileOpener: "File opener", pathClick: "Click on a path", viewerNumbers: "Viewer line numbers", viewerWrap: "Viewer wrap", viewerFocus: "Viewer takes focus", wheelLines: "Wheel lines", altLabel: "Alt key label", keyProtocol: "Key reports", optionKeys: "Option characters", rightClickPaste: "Right-click paste", pet: "Pet", petSize: "Pet size", reset: "Reset to defaults",
}

/** The widest the label column gets: the longest label, up to 25 cells. */
const LABEL_COLUMN = Math.min(25, Math.max(...Object.values(LABELS).map(textWidth)))

/** The preset the profile's rows are, or `custom`. */
export function footerPresetOf(profile: TuiProfile): string {
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
export const VIEWS_TRUST = ["View code runs in this process with your permissions: it is not sandboxed.", "Installing a view trusts its author, the same as installing an extension."] as const

export function customizePageKey(state: CustomizePageState, key: string, profile: TuiProfile, modules: readonly UiModule[] = [], commands?: readonly SlashCommand[], views: readonly UiView[] = []): { state: CustomizePageState; action: CustomizeAction } {
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
  if (key === "\x1b" || key === "q") return { state, action: { type: "close" } }
  if (["\x1b[A", "\x1bOA", "\x10", "k", "\x1b[B", "\x1bOB", "\x0e", "j"].includes(key)) {
    const delta = ["\x1b[A", "\x1bOA", "\x10", "k"].includes(key) ? -1 : 1
    const next = Math.max(0, Math.min(CUSTOMIZE_ROWS.length - 1, state.row + delta))
    // The picked view slot survives moving between the Views rows: "New view file" writes the one picked above it.
    return { state: next === state.row ? state : { row: next, ...(state.view !== undefined ? { view: state.view } : {}) }, action: NONE }
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
    const names = FOOTER_PRESET_NAMES
    const at = names.indexOf(footerPresetOf(profile))
    const next = FOOTER_PRESETS[names[at < 0 ? (backwards ? names.length - 1 : 0) : (at + (backwards ? -1 : 1) + names.length) % names.length]!]!
    return { state, action: { type: "set", patch: { footerRows: next.rows.map((entry) => [...entry]), ...(next.profile ?? {}) } } }
  }
  if (row === "toolLayout") {
    const at = TOOL_LAYOUT_NAMES.indexOf(toolLayoutOf(profile) as (typeof TOOL_LAYOUT_NAMES)[number])
    const name = TOOL_LAYOUT_NAMES[at < 0 ? (backwards ? TOOL_LAYOUT_NAMES.length - 1 : 0) : (at + (backwards ? -1 : 1) + TOOL_LAYOUT_NAMES.length) % TOOL_LAYOUT_NAMES.length]!
    return { state, action: { type: "set", patch: { ...TOOL_LAYOUTS[name] } } }
  }
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
  const list = row === "theme" ? themeNames() : CHOICES[row]
  if (list) {
    const next = list[(Math.max(0, list.indexOf(String(value))) + (backwards ? -1 : 1) + list.length) % list.length]!
    const patch = row === "messageLayout" ? { messageLayout: next, messageMeta: next === "classic" ? "full" : "off", userIcon: next === "classic" ? "●" : "", userLead: next === "classic" ? "" : "›", userLabel: next === "classic", assistantIcon: "", assistantLead: next === "classic" ? "" : "•", assistantLabel: false, userTint: next !== "classic" } : row === "presentation" ? { presentation: next, messageRenderer: next === "raw" ? "plain" : next === "minimal" ? "markdown" : "full", reasoning: next === "raw" ? "expanded" : "collapsed" } : row === "logoFont" ? { logoFont: next, logoText: normalizeLogoText(profile.logoText, next as TuiProfile["logoFont"]) } : { [row]: next }
    return { state, action: { type: "set", patch: patch as Partial<TuiProfile> } }
  }
  return { state, action: { type: "set", patch: { [row]: !value } } }
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
  preview: { root: string; /** The columns the chat's transcript lays out in now (a diff is split by this width, not the terminal's). */ chatWidth?: number; version?: string; sessions?: readonly HomeSession[]; tip: string; mcp?: HomeFooter["mcp"]; now: number; model?: string; provider?: string; agent?: string; effort?: string; loops?: number; phase?: string; session?: (width: number, height: number, profile?: TuiProfile) => Line[] }
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
  const card = renderToolCard({ title: "edit: src/cart.ts", text: DIFF_SAMPLE, status: "ok", width, expanded: true, level: "preview", frame: 0, tailLines: 0, ...(split ? { splitDiff: true } : {}) })
  return [...wrap(note, Math.max(1, width - 1)).map((text): Line => [{ text, fg: "muted" }]), [], ...card].slice(0, height)
}

export function customizePreview(input: { profile: TuiProfile; preview: CustomizeInput["preview"]; screenHeight: number; screenWidth?: number; width: number; height: number; glyphs: Glyphs; surface?: "home" | "session" | "activity" | "markdown" | "status" | "image" | "diff"; showPrompt?: boolean }): Line[] {
  const { profile, preview, width, height, glyphs } = input
  if (input.surface === "image") return imageWaitPreview(profile, width, height).slice(0, height).map((line) => fit(line, width))
  if (input.surface === "diff") return diffViewPreview(profile, width, height, preview.chatWidth ?? input.screenWidth ?? width).map((line) => fit(line, width))
  const frame = promptFrame({ preset: profile.promptChrome, width, glyphs, rich: true, placement: profile.statusPlacement, lead: profile.promptLead, border: profile.promptBorder, borders: profile.promptGlyphs })
  const values = { mode: preview.agent ?? "", model: preview.model ?? "", provider: preview.provider ?? "", reasoning: preview.effort ?? "" }
  const status = (w: number) => renderStatusRow({ width: w, ...(profile.statusLeft ? { leftItems: statusItems(profile.statusLeft, profile.statusColors, values, profile.statusSeparator) } : {}), ...(profile.statusRight ? { rightItems: statusItems(profile.statusRight, profile.statusColors, values, profile.statusSeparator) } : {}), ...(profile.showModel && preview.model ? { model: preview.model } : {}), ...(profile.showProvider && preview.provider ? { provider: preview.provider } : {}), ...(profile.showAgent && preview.agent ? { agent: preview.agent } : {}), separator: profile.statusSeparator, ...(profile.showEffort && preview.effort ? { effort: preview.effort } : {}), loops: preview.loops ?? 0 })
  // The activity status as the live frame draws it (same renderers): a row above the prompt, over its top rule, or at the end of its first row.
  const placement = input.surface === "status" && profile.showActivity ? profile.activityPlacement : "off"
  const ruleOffset = PROMPT_MARGIN + (profile.promptChrome === "top-bottom" ? 2 : 3)
  const sample = (room: number, overlay: boolean): Line => renderWorkingRow({
    width: room, margin: overlay ? 0 : META_MARGIN, spinner: SPINNER_FRAMES[0], phase: "Generating...", now: preview.now, parts: activityPartsOf(profile.activityParts), stats: SAMPLE_STATS, ...(overlay ? { separator: glyphs.sep } : {}),
    ...(profile.showElapsed ? { elapsedMs: 81_000 } : {}), ...(profile.showTokens ? { tokens: { input: 45_200, output: 1240 } } : {}), tokensPerSecond: 42, queued: 1, interruptHint: profile.showInterruptHint,
    ...(profile.showActivityModel && preview.model ? { model: preview.model } : {}),
  })
  const ruled = placement === "above" && profile.promptChrome !== "minimal" && frame.top.length === 1
  const top: Line[] = ruled ? [overlayRule(frame.top[0]!, sample(width - ruleOffset - 4, true), ruleOffset)] : frame.top
  const typed = frame.row(promptRow({ text: "", first: true, rich: true, glyphs, lead: profile.promptLead, ...(placement === "inside" ? {} : { placeholder: placeholderFor(0) }) }))
  const first = placement === "inside" ? placeInside({ row: typed, width, right: width - (frame.rightEdge ?? PROMPT_MARGIN), label: sample(Math.max(ACTIVITY_MIN_CELLS, insideRoom(frame.inset, width - (frame.rightEdge ?? PROMPT_MARGIN))), true) }) : typed
  const prompt: Line[] = input.showPrompt === false || input.surface === "activity" && height < 10 ? [] : [...(placement === "transcript" ? [sample(width, false)] : []), ...top, first, ...frame.bottom, ...(profile.promptChrome === "minimal" ? [[]] : []), ...(profile.showStatus ? [status(width)] : [])]
  const homeHeight = Math.max(0, height - prompt.length)
  let home = input.surface === "markdown" ? markdownPreview(profile, width) : (input.surface === "session" || input.surface === "status") && preview.session ? preview.session(width, homeHeight, profile) : renderHome({ width, height: homeHeight, screenHeight: input.screenHeight, root: preview.root, ...(preview.version ? { version: preview.version } : {}), sessions: preview.sessions ?? [], now: preview.now, look: homeLook(profile), ...(profile.homeFooter ? { footer: preview.mcp ? { mcp: preview.mcp } : {} } : {}) })
  if (input.surface === "activity") {
    const phase = preview.phase ?? "idle"
    const states = profile.activityStates ? JSON.parse(profile.activityStates) : {}
    const art: Line[] = states[phase] || states.idle ? (states[phase] || states.idle).split("\n").map((text: string) => [{ text, fg: "text" }]) : mascotRows(phase)
    const messages = profile.activityMessages ? JSON.parse(profile.activityMessages) : {}
    home = [...art, ...(messages[phase] ? [[{ text: messages[phase], fg: "text" as const }]] : [])]
  }
  return [...Array.from({ length: homeHeight }, (_, y) => home[y] ?? []), ...prompt].slice(0, height).map((line) => fit(line, width))
}

export function renderCustomizePage(input: CustomizeInput): Line[] {
  if (input.state.menu) return renderSlashEditor({ state: input.state.menu, profile: input.profile, ...(input.commands ? { commands: input.commands } : {}), width: input.width, height: input.height })
  const { state, profile, width, height } = input
  const row = rowAt(state)
  const shown = state.typing === undefined ? profile : { ...profile, ...textPatch(row, state.typing, profile) }
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
  for (const group of GROUPS) {
    rows.push([{ text: group.title, fg: "primary" }])
    // What was verified about views, stated where they are managed: no sandbox, so installing one is trusting its author.
    if (group.title === "Views") rows.push([{ text: VIEWS_TRUST[0], fg: "warning" }], [{ text: VIEWS_TRUST[1], fg: "warning" }])
    rows.push([])
    for (const field of group.rows) {
      const selected = field === row
      if (selected) focus = rows.length
      const value = field === "graphIndex" ? `${input.graphIndex ?? "auto"} · git repos under 10,000 files` : field === "views" ? `${(input.views ?? []).filter((view) => view.owner !== "built-in").length} custom · ←→ select · enter off/on · r reset` : field === "viewScaffold" ? "enter writes a starter for the selected slot" : field === "slashCommands" ? "enter edit" : field === "extensions" ? `${input.modules?.length ?? 0} · ←→ select · enter toggle` : field === "exportLook" ? "enter export" : field === "reset" || field === "capabilityCatalogue" ? "" : field === "pet" ? profile.pet || input.pet || "off" : field === "homeMascot" ? (profile.homeMascot === "mend" ? "mend (ASCII) · enter choose" : `${input.mascot ?? profile.homeMascot} · enter choose`) : field === "quotaRefresh" ? (profile.quotaRefresh.length ? quotaRefreshEditText(profile.quotaRefresh) : "off · nothing is sent") : field === "footerPreset" ? footerPresetOf(profile) : field === "toolLayout" ? toolLayoutOf(profile) : field === "footerRows" ? (profile.footerRows.length ? footerRowsText(profile.footerRows) : "off · one row") : field === "footerText" ? (Object.keys(profile.footerText).length ? JSON.stringify(profile.footerText) : "none") : typeof profile[field] === "boolean" ? profile[field] ? "on" : "off" : String(profile[field] || (["theme", "activityStates", "activityMessages", "promptGlyphs", "placeholderText"].includes(field) ? "default" : field === "customAscii" ? "default art" : "none"))
      const text = selected && state.typing !== undefined ? `${state.typing.replace(/\n/g, " ↵ ")}_` : value.replace(/\n/g, " ↵ ")
      rows.push([{ text: selected ? "❯ " : "  ", fg: "primary" }, { text: `${truncateEnd(LABELS[field], labelWidth).padEnd(labelWidth)} `, fg: selected ? "primary" : "text" }, ...(field === "reset" || field === "capabilityCatalogue" ? [] : [{ text: `‹ ${truncateMiddle(text, valueRoom)} ›`, fg: "muted" as const }])])
      if (selected && field === "messageRenderer") rows.push([{ text: profile.messageRenderer === "full" ? "Markdown, diagrams and tables" : profile.messageRenderer === "markdown" ? "Markdown; diagrams shown as source" : "Unformatted text", fg: "muted" }])
      if (selected && field === "promptContext" && input.promptStatus) {
        const mode = input.promptStatus.mode
        rows.push([{ text: promptCostLine(promptCostOf(input.promptStatus, mode)), fg: "muted" }])
        if (promptCostWarning(mode)) rows.push([{ text: promptCostWarning(mode), fg: "warning" }])
      }
      if (selected && field === "commentSentLayout") rows.push([{ text: profile.commentSentLayout === "stack" ? "Your message, a blank row, each quote over its comment" : profile.commentSentLayout === "inline" ? "1 “quote” → comment on one row when it fits, else two" : "Your message, a count line, the numbered pairs on a rail", fg: "muted" }])
      if (selected && field === "quotaRefresh") rows.push([{ text: `Off until set: codex:15, claude:30 (minutes, at least ${QUOTA_REFRESH_MIN_MINUTES}). The daemon asks while a terminal is open; ${QUOTA_REFRESH_COST}.`, fg: "warning" }], [{ text: `${QUOTA_REFRESH_CLAUDE}; the Codex engine's probe only reads rate limits.`, fg: "muted" }])
      if (selected && field === "toolLayout") rows.push([{ text: "Sets the three rows below: quiet, default, detailed, everything", fg: "muted" }])
      if (selected && field === "tableStyle") rows.push([{ text: "auto is box; box, rules, grid, minimal in the full view", fg: "muted" }])
      if (selected && field === "headingStyle") rows.push([{ text: "auto underlines in full, bold in balanced; or banner, bold, underline, uppercase", fg: "muted" }])
      if (selected && field === "markdownCopyHints") rows.push([{ text: "code in balanced, code + table/diagram in full; ctrl+x Y copies any block", fg: "muted" }])
      if (selected && field === "homeMascot") rows.push([{ text: "mend: the ASCII mascot. Or any pet (full tier): /pet import <picture> adds your own. Shown when Logo kind is mascot or both", fg: "muted" }])
      if (selected && field === "mascotMotion") rows.push([{ text: "on: a pet mascot plays its frames. off: one still frame. Reduced motion always holds it still", fg: "muted" }])
      if (selected && field === "mascotSize") rows.push([{ text: "A pet mascot's box: small 24x12, medium 32x16, large 44x22 cells. A screen too small for it gets the next smaller", fg: "muted" }])
      if (selected && field === "petSize") rows.push([{ text: "The session pet's box: small 10x5, medium 16x8, large 24x12 cells; half blocks take about half as many again. Not the ASCII Mend", fg: "muted" }])
      if (selected && field === "altLabel") rows.push([{ text: "auto: opt on a Mac, alt elsewhere; or alt, opt, symbol (⌥). Only the hints change, not keybindings.json", fg: "muted" }])
      if (selected && field === "optionKeys") rows.push([{ text: "auto: on a Mac, œ ¬ ® π ≤ ≥ typed alone run opt+q l r p , . where that key works; off types them", fg: "muted" }])
      if (selected && field === "keyProtocol") rows.push([{ text: "auto: on a Mac, asks the terminal for real key reports so Option+key is Alt+key; off never asks", fg: "muted" }])
      if (selected && field === "processMode") rows.push([{ text: "daemon: separate process. auto/solo: less RAM; a hard-killed terminal interrupts its turn; slower first frame", fg: "muted" }])
      if (selected && field === "markdownColors") rows.push([{ text: 'Roles: mdHeading1, mdTableBorder, synFlag… (docs/design/markdown-parity.md)', fg: "muted" }])
      if (selected && field === "imageWait") rows.push([{ text: "static holds the first frame; so does reduced motion", fg: "muted" }])
      if (selected && field === "imageWaitPreset") rows.push([{ text: IMAGE_WAIT_PRESETS.join(", "), fg: "muted" }], [{ text: profile.imageWaitArt.length ? `Yours: ${profile.imageWaitArt.map((art) => art.name).join(", ")}` : "Your own: imageWaitArt in tui/profile.json", fg: "muted" }])
      if (selected && field === "activitySound") rows.push([{ text: profile.activitySound === "off" ? "Silent" : profile.activitySound === "pulse" ? "Pulse on completion or approval" : "Hum while working; pulse when done", fg: "muted" }])
      if (selected && state.error) rows.push([{ text: state.error, fg: "error" }])
      // Only the slots with a custom view and the one picked are listed: the other built-ins are one ←→ away.
      if (field === "views") for (const [index, view] of (input.views ?? []).entries()) {
        const here = selected && index === (state.view ?? 0)
        if (view.owner === "built-in" && !here) continue
        const status = view.disabled ? "off" : view.tripped ? "stopped" : view.owner === "built-in" ? "" : "on"
        const timing = view.calls ? ` ${view.avgMs.toFixed(1)}ms` : ""
        rows.push([{ text: `${here ? "  ›" : "   "} ${view.slot.padEnd(16)} ${view.owner.padEnd(22)}`, fg: here ? "primary" : "text" }, { text: `${status}${timing}`.trim(), fg: view.tripped ? "error" : "muted" }])
        if (view.lastError && here) rows.push([{ text: `    ${view.lastError}`, fg: "error" }])
      }
      if (field === "extensions") for (const [index, module] of (input.modules ?? []).entries()) {
        rows.push([{ text: `${selected && index === (state.module ?? 0) ? "  ›" : "   "} ${module.enabled ? "on " : "off"} ${module.name}`, fg: module.errors.length ? "error" : "text" }])
        for (const error of module.errors) rows.push([{ text: `    ${error}`, fg: "error" }])
      }
      if (selected) focusEnd = rows.length - 1
    }
    rows.push([])
  }
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
  const surface = row === "diffView" ? "diff" : GROUPS.find((group) => group.title === "Image generation")!.rows.some((field) => field === row) ? "image" : GROUPS.find((group) => group.title === "Markdown")!.rows.some((field) => field === row) ? "markdown" : row === "activityPlacement" || row === "activityParts" ? "status" : ["activityMascot", "activityStates", "activityMessages", "showActivityModel"].includes(row) ? "activity" : GROUPS.filter((group) => group.title === "Session chrome" || group.title === "Status segments" || group.title === "Compaction").some((group) => group.rows.some((field) => field === row)) ? "session" : "home"
  const previewTitle = surface === "diff" ? "Diff preview" : surface === "image" ? "Image wait preview" : surface === "session" ? "Session preview" : surface === "activity" ? "Activity preview" : surface === "status" ? "Activity status preview" : surface === "markdown" ? "Markdown preview" : "Preview"
  const options = { title: "Choices", weight: optionsWeight, body: focusedWindow(choiceRows, Math.max(focusRow, Math.min(focusLast, focusRow + choicesHeight - 2)), choicesHeight) }
  const preview = { title: previewTitle, weight: 1 - optionsWeight, body: (w: number) => customizePreview({ profile: shown, preview: input.preview, screenHeight: height, screenWidth: width, width: w, height: Math.max(1, wide ? room - 4 : room - optionsRoom - 6), glyphs: input.glyphs ?? defaultGlyphs(), surface }) }
  const body = panelGrid({ rows: wide ? [[options, preview]] : [[options], [preview]], width: inner, heights: wide ? [room] : [optionsRoom + 4, room - optionsRoom - 5], compact: false, padding: wide, maxColumns: wide ? 2 : 1 })
  return appearancePage({ title: input.title ?? "Customize", hints: state.typing !== undefined ? "type · enter save · esc cancel" : "↑↓ row · ←→ change · enter edit · esc back", body, width, height })
}
