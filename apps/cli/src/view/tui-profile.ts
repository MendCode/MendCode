import { sidebarSpec } from "./sidebar-spec"
import type { SidebarWidget } from "@mendcode/protocol"
import fs from "node:fs"
import path from "node:path"
import { DEFAULT_LOGO_FONT, DEFAULT_LOGO_TEXT, LOGO_FONTS, LOGO_TEXT_MAX, type LogoFont } from "./logo-fonts"
import { cells, textWidth } from "./wrap"
import { IMAGE_MODES, type ImageMode } from "../pets/detect"
import { FILE_OPENERS, type FileOpener } from "./links"
import { PROCESS_MODES, type ProcessMode } from "../process-modes"
import { GLYPH_CHOICES, type GlyphChoice } from "../ui/theme"
import { ACTIVITY_PARTS, ACTIVITY_PARTS_DEFAULT, QUOTA_REFRESH_DEFAULT_MINUTES, normalizeQuotaRefresh, type QuotaRefreshEntry, FOOTER_ICON_MODES, STAT_PART_IDS, footerRowsProblems, footerTextProblems, normalizeUsageWidgets, type FooterIconMode, type UsageWidgetId } from "@mendcode/protocol/wire"
import { parseMarkdownColors } from "@mendcode/protocol/wire"
import { SLASH_LAYOUTS, slashProfileProblems, type SlashLayout, type SlashGroup, type SlashPreference } from "@mendcode/protocol/wire"
import { DEFAULT_IMAGE_WAIT_CANVAS, DEFAULT_IMAGE_WAIT_INTERVAL, IMAGE_WAIT_COLORS, IMAGE_WAIT_LIMITS, IMAGE_WAIT_MODES, normalizeImageWaitArt, normalizeImageWaitCanvas, imageWaitPresetNames, type ImageWaitArt, type ImageWaitCanvas, type ImageWaitColor, type ImageWaitMode } from "./image-wait"

/**
 * The terminal's own look, kept on this machine in `<dataDir>/tui/profile.json` (v1's TUI profile: prompt chrome,
 * home identity, welcome layout, tips and footer). It never goes through the daemon: another terminal on the same
 * data dir picks it up at its next start. Values are checked by hand, so the startup graph stays free of zod; a
 * missing or broken file is the defaults.
 */

export const PROMPT_CHROMES = ["box", "top-bottom", "minimal", "ascii-box"] as const
export type PromptChrome = (typeof PROMPT_CHROMES)[number]

export const HOME_LAYOUTS = ["centered", "split"] as const
export type HomeLayout = (typeof HOME_LAYOUTS)[number]

/** The left project sessions (view/sidebar.ts): `auto` and legacy `always` show from 110 columns, `hidden` never. */
export const SIDEBAR_MODES = ["auto", "always", "hidden"] as const
export type SidebarMode = (typeof SIDEBAR_MODES)[number]

export const LOGO_KINDS = ["wordmark", "mascot", "both", "custom", "none"] as const
/** How large a pet mascot is drawn on the home (`pets/home-pet.ts`): 12, 16 or 22 rows; a screen too small for one gets the next smaller. */
export const MASCOT_SIZES = ["small", "medium", "large"] as const
/** How large the session pet is drawn above the prompt (`pets/pet-slot.ts`): 5, 8 or 12 rows through the image layer. */
export const PET_SIZES = ["small", "medium", "large"] as const
/**
 * The mascot of the home (`logoKind` mascot or both): `mend` is the ASCII one, anything else a pet by reference
 * (`user:<id>`, `codex:<id>`, `package:<id>`; full tier). `mendy`, a built-in sprite that was removed, reads as `mend`.
 */
export function normalizeHomeMascot(value: unknown): string {
  return typeof value === "string" && /^(user|codex|package):[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value) ? value : "mend"
}
export const HOME_PANELS = ["actions", "agentManager"] as const
export const COMPACTION_PANELS = ["panel", "stats", "arcade", "scratchpad", "quiet"] as const
export const DENSITIES = ["compact", "comfortable", "spacious"] as const
/** The `full` renderer's Markdown looks (view/markdown-style.ts resolves `auto` per view). */
export const TABLE_STYLES = ["auto", "box", "rules", "grid", "minimal"] as const
export const HEADING_STYLES = ["auto", "banner", "bold", "underline", "uppercase"] as const
export const MARKDOWN_COPY_HINTS = ["auto", "code", "all", "off"] as const
/** Comments on an answer's passages. `auto` follows the view: on in balanced and full, off in minimal. */
export const COMMENT_MODES = ["auto", "on", "off"] as const
/** The engine's code map in the transcript: `auto` opens the card (diagram and summary row) in the full view and keeps one folded row in balanced; `open` and `folded` force either. The minimal view always keeps the row. */
export const CODE_MAP_CARDS = ["auto", "open", "folded"] as const
/**
 * How much the tool cards of the full view show. `calm` keeps a bounded preview on the latest, running and failed calls only and
 * draws every earlier one as a single row (runs of looking calls group); `standard` gives every call a short preview capped by kind;
 * `dense` is the full view as it was: every call with its whole preview. The balanced and minimal views ignore it.
 */
export const TOOL_DENSITIES = ["calm", "standard", "dense"] as const
/**
 * How an edit's diff is drawn in its tool card: `unified` one column of removed and added lines, `split` the old file on the left
 * and the new on the right from 100 columns, `auto` split only from 160. Narrower terminals, and a file that only gains or only
 * loses lines, stay unified.
 */
export const DIFF_VIEWS = ["unified", "split", "auto"] as const
/**
 * Tool layouts: one /customize choice that sets the three tool card keys together. `quiet` folds every card and the code
 * map, `default` is the shipped look, `detailed` previews every call and opens the map, `everything` opens every card in full.
 * Not stored: the row shows the layout the three keys match, or `custom`.
 */
export const TOOL_LAYOUTS = {
  quiet: { toolOutput: "collapsed", toolDensity: "calm", codeMapCard: "folded" },
  default: { toolOutput: "auto", toolDensity: "calm", codeMapCard: "auto" },
  detailed: { toolOutput: "auto", toolDensity: "standard", codeMapCard: "open" },
  everything: { toolOutput: "expanded", toolDensity: "dense", codeMapCard: "open" },
} as const satisfies Record<string, { toolOutput: "auto" | "collapsed" | "expanded"; toolDensity: (typeof TOOL_DENSITIES)[number]; codeMapCard: (typeof CODE_MAP_CARDS)[number] }>
export const TOOL_LAYOUT_NAMES = Object.keys(TOOL_LAYOUTS) as Array<keyof typeof TOOL_LAYOUTS>
/** The tool layout the profile's tool card keys match, or `custom`. */
export function toolLayoutOf(profile: Pick<TuiProfile, "toolOutput" | "toolDensity" | "codeMapCard">): string {
  return TOOL_LAYOUT_NAMES.find((name) => Object.entries(TOOL_LAYOUTS[name]).every(([key, value]) => profile[key as keyof typeof profile] === value)) ?? "custom"
}
export const COMMENT_KEYS = ["comment", "quote"] as const
export const COMMENT_HINTS = ["prompt", "passage", "off"] as const
export const COMMENT_CHIPS = ["above", "below", "rule"] as const
export const COMMENT_CHIP_STYLES = ["chips", "numbers", "count"] as const
/** How a sent set of comments is drawn: the pairs on a rail under a count (the default), each quote over its comment, or one-line pairs. */
export const COMMENT_SENT_LAYOUTS = ["rail", "stack", "inline"] as const
export const DEFAULT_REPLY_KEYS = "jkcd"
/** The Alt key in hints: `auto` is Option on macOS and Alt elsewhere; `alt`, `opt` (plain ASCII) and `symbol` (⌥) force a form on any OS. */
export const ALT_LABELS = ["auto", "alt", "opt", "symbol"] as const
/** The footer `quota` segment: what is spent (`used`) or what remains (`left`), in pressure colours or the theme's primary (`accent`). */
export const QUOTA_VIEWS = ["used", "left"] as const
export const QUOTA_COLORS = ["pressure", "accent"] as const
/** The kitty keyboard protocol (ui/keyboard-protocol.ts): `auto` asks the terminal for it on macOS only and uses it when the terminal answers; `off` never asks. */
export const KEY_PROTOCOLS = ["auto", "off"] as const
/** The Option characters (view/option-keys.ts): `auto` runs the alt binding a lone Option character stands for on a Mac, where that binding means something; `off` types the character. */
export const OPTION_KEYS = ["auto", "off"] as const
/** Bound of the `markdownColors` JSON; roles are checked by `markdownColorProblem`. */
export const MARKDOWN_COLORS_MAX = 2048

export type TuiProfile = {
  /** Table drawing in the `full` renderer; `auto` is box in every view. */
  tableStyle: (typeof TABLE_STYLES)[number]
  /** Heading drawing in the `full` renderer; `auto` underlines h1/h2 in the full view and bolds in balanced. */
  headingStyle: (typeof HEADING_STYLES)[number]
  /** Copy buttons on code, tables, lists, quotes and diagrams; `auto` is all in the full view, code only in balanced, none in minimal. */
  markdownCopyHints: (typeof MARKDOWN_COPY_HINTS)[number]
  /** Paragraphs that start with a right-to-left letter are right-aligned and reordered visually. */
  markdownRtl: boolean
  /** JSON object `{ "mdHeading1": "#rrggbb", … }` overriding single Markdown roles over the active theme; empty keeps the theme's. */
  markdownColors: string
  slashMenu: SlashLayout
  slashGroups: SlashGroup[]
  slashCommands: SlashPreference[]
  compactionStyle: "auto" | "minimal" | "cockpit" | "quiet"
  compactionPanel: (typeof COMPACTION_PANELS)[number]
  compactionProgress: boolean
  compactionScratchpad: boolean
  disabledUiExtensions: string[]
  /** View slots the user switched off: their custom views are skipped and the built-in draws (docs/views.md). */
  disabledViews: string[]
  promptContext: "minimal" | "focus" | "guide" | "full" | "custom"
  presentation: "auto" | "raw" | "mendcode" | "minimal" | "balanced" | "full"
  messageRenderer: "plain" | "markdown" | "full"
  submitScroll: "bottom" | "clear"
  timestamps: boolean
  username: string
  showUsername: boolean
  /** The transcript's right-edge track: `auto` while scrolling or off the bottom, `always`, or `off`. `auto` and `always` keep one column free of text, so showing and hiding it never reflows. */
  scrollbar: "auto" | "always" | "off"
  /** Thumb then track, one cell each; one glyph alone draws no track. Empty uses the glyph set's. */
  scrollbarGlyphs: string
  /** The "jump to latest" button drawn while the view is off the bottom. */
  jumpHint: "right" | "center" | "left" | "off"
  /** Its text; `{n}` is the rows that arrived while scrolled up, `{key}` the End hint. Empty is the default text. */
  jumpText: string
  /** Where the working row (spinner, phase, elapsed) sits: its own row in the transcript, over the prompt's top rule, inside the prompt's first row, or not at all. */
  activityPlacement: "transcript" | "above" | "inside" | "off"
  /** The parts it shows, in order (`ACTIVITY_PARTS`); a part the old `show*` toggles switch off stays hidden. */
  activityParts: string
  /** Comments on passages of an answer (docs/editor.md): `auto` is on in the balanced and full views and off in minimal. */
  comments: (typeof COMMENT_MODES)[number]
  /** What `alt+q` (and its `ctrl+x w` chord) does with a selection: comment on it, or quote it into the prompt as before. `ctrl+g` always comments. */
  commentKey: (typeof COMMENT_KEYS)[number]
  /** Where the offer to comment shows: by the prompt (the copied toast, a pill on the prompt's rule), by the passage, or nowhere. */
  commentHint: (typeof COMMENT_HINTS)[number]
  /** How long the offer after a copy stays, in seconds. */
  commentHintSeconds: number
  /** Where the pending comments sit: a row above the prompt, a row under it, or a count on the prompt's top rule. */
  commentChips: (typeof COMMENT_CHIPS)[number]
  /** `chips` show each quote's start, `numbers` only the numbers, `count` always collapses to `N comments`. */
  commentChipStyle: (typeof COMMENT_CHIP_STYLES)[number]
  /** Cells of its quote a chip must keep; a row that cannot give every chip that many collapses to a count. */
  commentCollapse: number
  /** Most comments held at once, 1 to 9. */
  commentMax: number
  /** The marks in the margin beside commented passages. */
  commentMarks: boolean
  /** One glyph for the margin mark; empty is the glyph set's rail. */
  commentMarkGlyph: string
  /** The reply mode's keys, in order: next unit, previous unit, comment the unit, decide the options. */
  commentReplyKeys: string
  /** The message's envelope for the model, `\n` for a line break; empty is the built-in wording (docs/editor.md). */
  commentTemplate: string
  /** One comment's entry inside the envelope; empty is the built-in one. */
  commentEntry: string
  /** A sent comment message is drawn folded (quotes on one line, `ctrl+o` opens them). */
  commentFolded: boolean
  /** The folded sent message: `rail` (a count line, the numbered pairs on a rail under your message), `stack` (a blank row, each quote over its comment) or `inline` (`1 “quote” → comment` on one row when it fits). */
  commentSentLayout: (typeof COMMENT_SENT_LAYOUTS)[number]
  /** Where a pasted or attached image, PDF, file or folder shows: `inline` is a token in the prompt text where it was pasted (the model gets it there), `above` the chip row over the prompt with the attachment after the text, `both` the tokens and the row. */
  attachmentChips: "inline" | "above" | "both"
  pasteSummary: boolean
  pasteSummaryMinChars: number
  /** Releasing the mouse after selecting text in the transcript or the prompt copies it (OSC 52). */
  copyOnSelect: boolean
  /** Modal editing in the prompt (`/vim`): normal, insert and visual modes. */
  vimMode: boolean
  /** Enter inserts a newline and shift/alt/ctrl+Enter send (`/multiline`). Slash commands and shell lines still send on Enter. */
  multiline: boolean
  /** `?` on an empty prompt opens the shortcut overlay. */
  shortcutOverlay: boolean
  /** How the Alt key is written in key hints (ui/key-labels.ts): `auto` says Option on macOS and Alt elsewhere. Only the display changes; keybindings.json keeps `alt`. */
  altLabel: (typeof ALT_LABELS)[number]
  /** Whether the terminal is asked for real key reports on a Mac, so Option+key arrives as Alt+key (ui/keyboard-protocol.ts). Read at start and applied when it changes. */
  keyProtocol: (typeof KEY_PROTOCOLS)[number]
  /** Whether a lone character that Option typed on a Mac (`œ` for Option+Q) runs the alt binding it stands for (ui/app/option-keys.ts). */
  optionKeys: (typeof OPTION_KEYS)[number]
  /** Esc twice on an idle, empty prompt opens the backtrack picker. */
  escBacktrack: boolean
  /** Esc-Esc that interrupts a turn moves the queued prompts back into the prompt (otherwise the queue is held). */
  queueRestore: boolean
  /** Esc-Esc on a turn the model has not answered yet takes the message back (an undo) and puts it in the prompt to fix, as Claude Code does. */
  escRetract: boolean
  /** Several lines arriving in one terminal read without a bracketed paste are inserted as a paste, not sent line by line. */
  pasteBurst: boolean
  /** Unsent drafts older than this many days are deleted by the daemon; 0 keeps them. */
  draftRetentionDays: number
  statusLeft: string
  statusRight: string
  statusColors: string
  reasoning: "auto" | "hidden" | "collapsed" | "expanded"
  toolOutput: "auto" | "collapsed" | "expanded"
  codeMapCard: (typeof CODE_MAP_CARDS)[number]
  toolDensity: (typeof TOOL_DENSITIES)[number]
  diffView: (typeof DIFF_VIEWS)[number]
  tagline: string
  promptGlyphs: string
  activityMessages: string
  activityStates: string
  showActivityModel: boolean
  doneSymbol: string
  logoKind: (typeof LOGO_KINDS)[number]
  homeMascot: string
  /** A pet mascot plays its frames; off holds it still. Reduced motion holds it still whatever this says. */
  mascotMotion: boolean
  mascotSize: (typeof MASCOT_SIZES)[number]
  customAscii: string
  homeRightPanel: (typeof HOME_PANELS)[number]
  density: (typeof DENSITIES)[number]
  theme: string
  /** Pins the mode the `system` theme uses, so the terminal's light/dark changes are ignored; empty follows the terminal. */
  themeLock: "" | "dark" | "light"
  pet: string
  petSize: (typeof PET_SIZES)[number]
  promptLead: string
  statusPlacement: "auto" | "inside" | "outside"
  statusSeparator: string
  showAgent: boolean
  showEffort: boolean
  showPermission: boolean
  promptBorder: "auto" | "single" | "rounded" | "double" | "ascii"
  showModel: boolean
  showProvider: boolean
  showStatus: boolean
  showContext: boolean
  contextBar: "top" | "off"
  contextStyle: "bar" | "percent" | "both"
  /** Stat parts the top bar shows left of the context bar, in order (`STAT_PART_IDS`); empty shows none. */
  topbarStats: string
  /** Legacy wire field; no footer rendering or customization row. */
  showFooterContext: boolean
  footerQuota: boolean
  quotaView: (typeof QUOTA_VIEWS)[number]
  quotaColor: (typeof QUOTA_COLORS)[number]
  footerToday: boolean
  /** Providers whose quota windows the daemon asks for on a timer (docs/usage-limit.md, "Quota refresh"); empty is off and nothing is ever sent. Each probe spends some of the quota it measures. */
  quotaRefresh: QuotaRefreshEntry[]
  /** The built-in footer as rows of segment names (docs/customize.md, "Footer rows"); empty is the single default row. */
  footerRows: string[][]
  /** Lines the `text:<name>` segment shows: one line, or a list one of which shows per day. */
  footerText: Record<string, string | string[]>
  /** An icon before each footer segment: none, plain Unicode glyphs, or Nerd Font icons. */
  footerIcons: FooterIconMode
  messageLayout: "quiet" | "classic"
  userIcon: string
  assistantIcon: string
  userLabel: boolean
  assistantLabel: boolean
  /** The assistant's label text ("Assistant" when empty); set, the label shows even with `assistantLabel` off. */
  assistantName: string
  userLead: string
  assistantLead: string
  userTint: boolean
  messageMeta: "off" | "compact" | "full"
  /** The row above a session's transcript (project, title, context); off removes the row, not only its parts. */
  showTopbar: boolean
  showSessionTitle: boolean
  stickyPrompt: boolean
  showProject: boolean
  showDiffLines: boolean
  showDiffFiles: boolean
  terminalTitle: boolean
  titleTemplate: string
  /** Prefix the window title with "working" or "needs input" while a turn runs or waits. */
  titleActivity: boolean
  sessionAccent: boolean
  sidebarSide: "left" | "right"
  /** Under 110 columns the right panel hides (`hide`) or becomes a sheet above the prompt (`sheet`). */
  panelNarrow: "hide" | "sheet"
  /** The right panel's first row (its preset, `/panel`, the focus key); off gives that row to the cards. */
  panelHeader: boolean
  activityMascot: boolean
  showActivity: boolean
  showElapsed: boolean
  showTokens: boolean
  showInterruptHint: boolean
  /** Say so in the working row when a turn has produced nothing for a while. */
  showStalled: boolean
  /** Notices when a usage window or the context nears its limit. Off by default: the footer already shows both; a limit that is reached is always said. */
  usageNotices: boolean
  limitCheckpoint: boolean
  /** Transcript lines for prompt-cache misses, thinking left off and what a compaction cost. Off by default. */
  cacheNotices: boolean
  /** A notice for an action that simply worked and whose result is already on screen (text copied by selecting, a draft saved or restored, a quote or queued prompt put in the prompt, a goal set). Off by default: success is silent; what failed or tells something new is always said. */
  confirmNotices: boolean
  showCommandHint: boolean
  showAgentHint: boolean

  promptChrome: PromptChrome
  /** The wordmark's letters (upper-cased when drawn). */
  logoText: string
  logoFont: LogoFont
  /** Named on the home's top row, in the terminal title and as the plain-text logo of a small terminal. */
  productName: string
  homeLayout: HomeLayout
  homeTips: boolean
  homeFooter: boolean
  /** The home screen's first row (the project folder, the product name, the runtime version); off gives the row to the logo. */
  homeHeader: boolean
  /** The home screen's panel under the logo: the session list, or the actions (`homeRightPanel`); off leaves the logo alone. */
  homePanel: boolean
  /** The example text in the empty prompt on the home screen. */
  showPlaceholder: boolean
  /** Own text for that example; empty keeps the built-in examples. */
  placeholderText: string
  /** The left session list's first row ("Sessions" and the focus key); off gives the row to the sessions. */
  sidebarHeader: boolean
  /** The running sub-agents and background commands listed over the prompt; off leaves them to /tasks and ctrl+t. */
  showTasks: boolean
  /** Show the local block-font clock in the Usage dashboard. */
  usageClock: boolean
  /** Ring the terminal bell when a turn ends (off by default). */
  turnBell: boolean
  /** A desktop notification through the terminal (OSC 9 or OSC 777) when a turn ends or waits for an approval or an answer (off by default). */
  turnNotify: "off" | "osc9" | "osc777"
  /** When the bell and the desktop notice go out: only while this terminal is not the focused window (a terminal that does not report focus counts as unfocused), or always. */
  notifyWhen: "unfocused" | "always"
  /** On returning to a terminal that was away while a turn finished, show the session recap (spends one model call; off by default). */
  autoRecap: boolean
  /** Ask before sending a message into a session that has sat idle this long with a large context (the prompt cache has gone cold). */
  idleReturn: "off" | "30m" | "1h" | "3h"
  /** Resuming a session that ran in another directory asks where to continue; resuming a very large one offers to compact it. */
  resumePrompts: boolean
  activitySound: "off" | "pulse" | "hum"
  sidebarWidgets: SidebarWidget[]
  rightSidebar: boolean
  /** Cells the right bar takes; 0 keeps the automatic 48 (56 from 150 columns). */
  sidebarWidth: number
  /** `border` draws `READY › model › effort › repo › branch › ctx` in the prompt's top rule and leaves the row under it telemetry only. */
  promptStatus: "off" | "border"
  sidebar: SidebarMode
  images: ImageMode
  /** Images the session produced or received (read image, screenshot, generated, pasted) are drawn in the transcript when `images` finds a protocol. */
  transcriptImages: boolean
  /** URLs and file paths in the transcript are OSC 8 hyperlinks (terminals that ignore them show plain text). */
  hyperlinks: boolean
  /** The editor a file path link opens: a `file://` link for the system's default, an editor's URI scheme, or none (no file links). */
  fileOpener: FileOpener
  /** What a plain click on a file path in the transcript does: `panel` opens it in the file viewer (right slot, or a page on a narrow terminal), `editor` leaves it to the terminal's own link (today's behaviour), `auto` is `panel` where the `file_viewer` feature is on (balanced and full) and `editor` elsewhere. */
  pathClick: "auto" | "panel" | "editor"
  /** The file viewer shows a line number column. */
  viewerNumbers: boolean
  /** The file viewer wraps long lines under the line number (`off` cuts them and ←/→ scroll sideways); `auto` wraps prose (Markdown, text) and cuts code. */
  viewerWrap: "auto" | "on" | "off"
  /** Opening a file gives the viewer the keyboard (off: the prompt keeps it and the file scrolls with the wheel). */
  viewerFocus: boolean
  /** Rows one wheel notch scrolls the transcript. */
  wheelLines: number
  /** A right click pastes the clipboard into the prompt (reads the local clipboard; off by default). */
  rightClickPaste: boolean
  /** The terminal's alternate screen. Off keeps the chat inline so finished output lands in the terminal's scrollback (next launch; `--no-alt-screen` does it for one run). */
  altScreen: boolean
  /** Screen-reader mode: the chat stays inline (no alternate screen), no animation, no mouse reporting, plain text output (docs/accessibility.md; the screen and mouse part applies at the next launch, `--accessible` does it for one run). */
  accessible: boolean
  /** The glyph set every view draws with: `auto` asks the terminal (Nerd Font only where it is known to ship, ASCII on old terminals); `ascii` also turns each frame into plain ASCII (`ui/ascii.ts`). */
  glyphs: GlyphChoice
  /** How many processes this terminal uses. `daemon` always uses a separate detached daemon. `auto` (default; `solo` is the same) hosts the daemon in the terminal's own process when none is running (it exits, or hands over to a detached daemon, when the terminal closes): less RAM, but a hard-killed terminal interrupts its running turn, and the first frame is slower. Every tier's bundle is `auto`. Applies at the next launch; `--process` and `MENDCODE_PROCESS` override it (docs/performance.md). */
  processMode: ProcessMode
  usageWidgets: UsageWidgetId[]
  usageWeatherEnabled: boolean
  usageWeatherRegion: string
  /** Ids of the tutorial lessons done or skipped, comma separated; `/tutorial` resumes after them. */
  tutorialDone: string
  /** The canvas a running image tool draws (view/image-wait.ts): a looping animation, or its first frame only. Reduced motion always holds it still. */
  imageWait: ImageWaitMode
  /** A built-in preset (`drops`, `cycle`, `constellation`, `orbit`, `pulse`, `scanner`) or the name of one of `imageWaitArt`. */
  imageWaitPreset: string
  /** Milliseconds per frame, 80 to 5000. */
  imageWaitSpeed: number
  /** `mixed` gives the moving marks the accent and keeps the trail muted; `accent` and `muted` draw the whole field in one. */
  imageWaitColor: ImageWaitColor
  /** The model and requested size under the field. */
  imageWaitMeta: boolean
  /** The canvas's bounds in cells: width and height ranges, height as a share of the width, and inner padding. */
  imageWaitCanvas: ImageWaitCanvas
  /** The user's own presets: `{ name, frames: [frame, …] | static: frame, fit: contain|crop, align: left|center|right }`, a frame a string or a list of lines. */
  imageWaitArt: ImageWaitArt[]
}

export const DEFAULT_PRODUCT_NAME = "MendCode"
export const PRODUCT_NAME_MAX = 32

export const DEFAULT_TUI_PROFILE: Readonly<TuiProfile> = {
  tableStyle: "auto",
  headingStyle: "auto",
  markdownCopyHints: "auto",
  markdownRtl: true,
  markdownColors: "",
  slashMenu: "tabs",
  slashGroups: [],
  slashCommands: [],
  compactionStyle: "auto",
  compactionPanel: "panel",
  compactionProgress: true,
  compactionScratchpad: true,
  disabledUiExtensions: [],
  disabledViews: [],
  promptContext: "focus",
  messageRenderer: "full",
  submitScroll: "bottom",
  timestamps: false,
  username: "",
  showUsername: false,
  scrollbar: "off",
  scrollbarGlyphs: "",
  jumpHint: "right",
  jumpText: "",
  activityPlacement: "transcript",
  activityParts: ACTIVITY_PARTS_DEFAULT,
  comments: "auto",
  commentKey: "comment",
  commentHint: "prompt",
  commentHintSeconds: 5,
  commentChips: "above",
  commentChipStyle: "chips",
  commentCollapse: 14,
  commentMax: 9,
  commentMarks: true,
  commentMarkGlyph: "",
  commentReplyKeys: "jkcd",
  commentTemplate: "",
  commentEntry: "",
  commentFolded: true,
  commentSentLayout: "rail",
  attachmentChips: "inline",
  pasteSummary: true,
  pasteSummaryMinChars: 1000,
  copyOnSelect: true,
  vimMode: false,
  multiline: false,
  shortcutOverlay: true,
  altLabel: "auto",
  keyProtocol: "auto",
  optionKeys: "auto",
  escBacktrack: true,
  queueRestore: false,
  escRetract: true,
  pasteBurst: true,
  draftRetentionDays: 14,
  statusLeft: "",
  statusRight: "",
  statusColors: "",
  presentation: "auto",
  reasoning: "auto",
  toolOutput: "auto",
  codeMapCard: "auto",
  toolDensity: "calm",
  diffView: "unified",
  tagline: "",
  promptGlyphs: "",
  activityMessages: "",
  activityStates: "",
  showActivityModel: false,
  doneSymbol: "◈",
  logoKind: "wordmark",
  homeMascot: "mend",
  mascotMotion: true,
  mascotSize: "medium",
  customAscii: "",
  homeRightPanel: "agentManager",
  density: "comfortable",
  theme: "",
  themeLock: "",
  pet: "",
  petSize: "small",
  promptLead: "❭",
  statusPlacement: "auto",
  statusSeparator: " · ",
  showAgent: true,
  showEffort: false,
  showPermission: true,
  promptBorder: "auto",
  showModel: true,
  showProvider: true,
  showStatus: true,
  showContext: true,
  contextBar: "top",
  contextStyle: "both",
  topbarStats: "",
  showFooterContext: false,
  footerQuota: false,
  quotaView: "used",
  quotaColor: "pressure",
  footerToday: false,
  quotaRefresh: [],
  footerRows: [],
  footerText: {},
  footerIcons: "none",
  messageLayout: "quiet",
  userIcon: "",
  assistantIcon: "",
  userLabel: false,
  assistantLabel: false,
  assistantName: "",
  userLead: "›",
  assistantLead: "•",
  userTint: true,
  messageMeta: "off",
  showTopbar: true,
  showSessionTitle: true,
  stickyPrompt: true,
  showProject: true,
  showDiffLines: true,
  showDiffFiles: false,
  terminalTitle: true,
  titleTemplate: "{product} | {session}",
  titleActivity: true,
  sessionAccent: false,
  sidebarSide: "left",
  panelNarrow: "hide",
  panelHeader: true,
  activityMascot: false,
  showActivity: true,
  showElapsed: true,
  showTokens: true,
  showInterruptHint: true,
  showStalled: true,
  usageNotices: false,
  limitCheckpoint: true,
  cacheNotices: false,
  confirmNotices: false,
  showCommandHint: false,
  showAgentHint: false,
  promptChrome: "top-bottom",
  logoText: DEFAULT_LOGO_TEXT,
  logoFont: DEFAULT_LOGO_FONT,
  productName: DEFAULT_PRODUCT_NAME,
  homeLayout: "centered",
  homeTips: false,
  homeFooter: false,
  homeHeader: true,
  homePanel: true,
  showPlaceholder: true,
  placeholderText: "",
  sidebarHeader: true,
  showTasks: true,
  usageClock: true,
  turnBell: false,
  turnNotify: "off",
  notifyWhen: "unfocused",
  autoRecap: false,
  // Nothing stands between a message and its sending unless the user turned the question on.
  idleReturn: "off",
  resumePrompts: false,
  activitySound: "off",
  sidebarWidgets: [],
  rightSidebar: false,
  sidebarWidth: 0,
  promptStatus: "off",
  sidebar: "auto",
  images: "auto",
  transcriptImages: true,
  hyperlinks: true,
  fileOpener: "file",
  pathClick: "auto",
  viewerNumbers: true,
  viewerWrap: "auto",
  viewerFocus: false,
  wheelLines: 3,
  rightClickPaste: false,
  altScreen: true,
  accessible: false,
  glyphs: "auto",
  processMode: "auto",
  usageWidgets: [],
  usageWeatherEnabled: false,
  usageWeatherRegion: "",
  tutorialDone: "",
  imageWait: "animated",
  imageWaitPreset: "drops",
  imageWaitSpeed: DEFAULT_IMAGE_WAIT_INTERVAL,
  imageWaitColor: "mixed",
  imageWaitMeta: true,
  imageWaitCanvas: { ...DEFAULT_IMAGE_WAIT_CANVAS },
  imageWaitArt: [],
}

const PROFILE_FILE = ["tui", "profile.json"] as const

export const tuiProfilePath = (dataDir: string) => path.join(dataDir, ...PROFILE_FILE)

/** One printable line: controls and escape sequences are dropped, runs of blanks collapse, the ends are trimmed. */
function oneLine(value: unknown, max: number): string {
  if (typeof value !== "string") return ""
  // eslint-disable-next-line no-control-regex
  return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max)
}

const oneOf = <T extends string>(list: readonly T[], value: unknown): T | undefined => list.find((item) => item === value)

/** v1's picker folds the legacy fonts into `mendcode`. */
function fontOf(value: unknown): LogoFont | undefined {
  return value === "classic" || value === "opencode" ? "mendcode" : oneOf(LOGO_FONTS, value)
}

export function normalizeLogoText(value: unknown, font: LogoFont = DEFAULT_LOGO_FONT): string {
  return oneLine(value, LOGO_TEXT_MAX[font]) || DEFAULT_LOGO_TEXT
}

export function normalizeProductName(value: unknown): string {
  return oneLine(value, PRODUCT_NAME_MAX) || DEFAULT_PRODUCT_NAME
}

/** Multiline terminal-safe art. Preserve spaces, drop escapes/controls, bound its size. */
export function normalizeAscii(value: unknown): string {
  if (typeof value !== "string") return ""
  return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\r/g, "").replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, "").split("\n").slice(0, 12).map((line) => line.slice(0, 120)).join("\n").trimEnd()
}

/** Six single-cell glyphs: horizontal, vertical, top-left, top-right, bottom-left, bottom-right. */
export function normalizePromptGlyphs(raw: unknown): string {
  const text = typeof raw === "string" ? raw : ""
  const glyphs = [...cells(text)]
  return glyphs.length === 6 && glyphs.every((cell) => cell.width === 1 && !/[\x00-\x1f\x7f]/.test(cell.text)) ? text : ""
}

/** Thumb, then track: one or two single-cell glyphs; anything else is the glyph set's own. */
export function normalizeScrollbarGlyphs(raw: unknown): string {
  const text = typeof raw === "string" ? raw : ""
  const glyphs = [...cells(text)]
  return glyphs.length >= 1 && glyphs.length <= 2 && glyphs.every((cell) => cell.width === 1 && !/[\x00-\x20\x7f]/.test(cell.text)) ? text : ""
}

/** A whole number in `[min, max]`; anything else is `fallback`. */
export function boundedInt(raw: unknown, min: number, max: number, fallback: number): number {
  return typeof raw === "number" && Number.isFinite(raw) ? Math.max(min, Math.min(max, Math.floor(raw))) : fallback
}

/** The margin mark of a pending comment: one single-cell glyph; anything else is the glyph set's own rail. */
export function normalizeMarkGlyph(raw: unknown): string {
  const text = typeof raw === "string" ? raw : ""
  const glyphs = [...cells(text)]
  return glyphs.length === 1 && glyphs[0]!.width === 1 && !/[\x00-\x20\x7f]/.test(glyphs[0]!.text) ? text : ""
}

/** The reply mode's four keys (next, previous, comment, decide): distinct printable letters or symbols, never a digit (1 to 9 jump to an option). Anything else is the default. */
export function normalizeReplyKeys(raw: unknown): string {
  const keys = typeof raw === "string" ? [...raw] : []
  const valid = keys.length === 4 && keys.every((key, at) => /^[^\s\x00-\x1f\x7f\d]$/u.test(key) && keys.indexOf(key) === at)
  return valid ? (raw as string) : DEFAULT_REPLY_KEYS
}

/** An envelope or entry wording: one line, `\n` for a break, at most 1200 characters and every placeholder it needs; unusable is empty (the built-in one). */
export function normalizeWording(raw: unknown, ...required: string[]): string {
  const text = oneLine(raw, 1200)
  return text && required.every((token) => text.includes(`{${token}}`)) ? text : ""
}

/** The known activity parts of a comma list, once each, in the order given; an empty or unusable list is the default. */
export function normalizeActivityParts(raw: unknown): string {
  if (typeof raw !== "string" || raw.length > 256) return ACTIVITY_PARTS_DEFAULT
  const names = raw.split(",").map((name) => name.trim()).filter((name, index, all) => (ACTIVITY_PARTS as readonly string[]).includes(name) && all.indexOf(name) === index)
  return names.length ? names.join(",") : ACTIVITY_PARTS_DEFAULT
}

/** The known stat parts of a comma list, once each, in the order given; anything unusable is the empty list (no stats in the top bar). */
/** `footerRows` as stored; an invalid value is no rows (the default single row), never a half-read list. */
export function normalizeFooterLayout(raw: unknown): string[][] {
  return footerRowsProblems(raw).length ? [] : (raw as string[][]).map((row) => [...row])
}

/** `footerText` as stored; an invalid value is no text. */
export function normalizeFooterText(raw: unknown): Record<string, string | string[]> {
  return footerTextProblems(raw).length ? {} : { ...(raw as Record<string, string | string[]>) }
}

/** `quotaRefresh` as one line to edit: `codex:15, claude:30:claude-haiku` (provider, minutes, model). */
export const quotaRefreshEditText = (entries: readonly QuotaRefreshEntry[]): string => entries.map((entry) => [entry.provider, entry.everyMinutes ?? QUOTA_REFRESH_DEFAULT_MINUTES, ...(entry.model ? [entry.model] : [])].join(":")).join(", ")
export function parseQuotaRefreshText(text: string): QuotaRefreshEntry[] {
  return text.split(",").map((part) => part.trim()).filter(Boolean).map((part): QuotaRefreshEntry => {
    const [provider, minutes, ...model] = part.split(":")
    return { provider: provider as QuotaRefreshEntry["provider"], ...(minutes ? { everyMinutes: Number(minutes) } : {}), ...(model.length ? { model: model.join(":") } : {}) }
  })
}

/** The rows as one line to edit (`directory,text:tagline; model,context`), and back. */
export const footerRowsText = (rows: readonly (readonly string[])[]): string => rows.map((row) => row.join(",")).join("; ")
export function parseFooterRowsText(text: string): string[][] {
  return text.split(";").map((row) => row.split(",").map((name) => name.trim().toLowerCase()).filter(Boolean)).filter((row) => row.length > 0)
}

export function normalizeStatParts(raw: unknown): string {
  if (typeof raw !== "string" || raw.length > 128) return ""
  return raw.split(",").map((name) => name.trim()).filter((name, index, all) => (STAT_PART_IDS as readonly string[]).includes(name) && all.indexOf(name) === index).join(",")
}

/** Bounded data-only activity overrides; invalid JSON keeps the last/default map. */
export function normalizeActivityMap(raw: unknown, ascii: boolean): string {
  if (typeof raw !== "string" || raw.length > 16_000) return ""
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return ""
    const phases = ["idle", "hover", "thinking", "planning", "memory", "compacting", "reading", "searching", "sending", "patching", "editing", "running", "installing", "testing", "subagents", "browsing", "retrying", "blocked", "done", "error", "uploading", "downloading"]
    const map: Record<string, string> = {}
    for (const phase of phases) {
      const value = Array.isArray(parsed[phase]) ? parsed[phase][0] : parsed[phase]
      if (typeof value !== "string") continue
      const text = ascii ? normalizeAscii(value).split("\n").slice(0, 5).map((line) => {
        let row = ""
        for (const cell of cells(line)) {
          if (textWidth(row) + cell.width > 24) break
          row += cell.text
        }
        return row
      }).join("\n") : oneLine(value, 80)
      if (text) map[phase] = text
    }
    return Object.keys(map).length ? JSON.stringify(map) : ""
  } catch {
    return ""
  }
}

/** The valid entries of a `markdownColors` JSON, re-serialised; invalid or empty is "". */
export function normalizeMarkdownColors(raw: unknown): string {
  if (typeof raw !== "string" || raw.length > MARKDOWN_COLORS_MAX) return ""
  const { colors } = parseMarkdownColors(raw)
  return Object.keys(colors).length ? JSON.stringify(colors) : ""
}

/** Any parsed JSON as a complete profile: each field is kept only when valid, else it is the default. */
export function normalizeTuiProfile(raw: unknown): TuiProfile {
  const source = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const logoFont = fontOf(source.logoFont) ?? DEFAULT_TUI_PROFILE.logoFont
  const bool = (key: keyof TuiProfile) => typeof source[key] === "boolean" ? source[key] as boolean : DEFAULT_TUI_PROFILE[key] as boolean
  return {
    tableStyle: oneOf(TABLE_STYLES, source.tableStyle) ?? "auto",
    headingStyle: oneOf(HEADING_STYLES, source.headingStyle) ?? "auto",
    markdownCopyHints: oneOf(MARKDOWN_COPY_HINTS, source.markdownCopyHints) ?? "auto",
    markdownRtl: bool("markdownRtl"),
    markdownColors: normalizeMarkdownColors(source.markdownColors),
    slashMenu: oneOf(SLASH_LAYOUTS, source.slashMenu) ?? "tabs",
    slashGroups: slashProfileProblems("slashGroups", source.slashGroups).length ? [] : source.slashGroups as SlashGroup[],
    slashCommands: slashProfileProblems("slashCommands", source.slashCommands).length ? [] : source.slashCommands as SlashPreference[],
    disabledUiExtensions: Array.isArray(source.disabledUiExtensions) ? source.disabledUiExtensions.filter((name): name is string => typeof name === "string").slice(0, 128) : [],
    disabledViews: Array.isArray(source.disabledViews) ? source.disabledViews.filter((name): name is string => typeof name === "string" && /^[a-z]+(\.[a-z]+)?$/.test(name)).slice(0, 32) : [],
    compactionStyle: oneOf(["auto", "minimal", "cockpit", "quiet"] as const, source.compactionStyle) ?? "auto",
    compactionPanel: oneOf(COMPACTION_PANELS, source.compactionPanel) ?? "panel",
    compactionProgress: bool("compactionProgress"),
    compactionScratchpad: bool("compactionScratchpad"),
    promptContext: oneOf(["minimal", "focus", "guide", "full", "custom"] as const, source.promptContext) ?? "focus",
    presentation: oneOf(["auto", "raw", "mendcode", "minimal", "balanced", "full"] as const, source.presentation) ?? "auto",
    messageRenderer: source.messageRenderer === "rich" ? "full" : oneOf(["plain", "markdown", "full"] as const, source.messageRenderer) ?? "full",
    submitScroll: source.submitScroll === "clear" ? "clear" : "bottom",
    timestamps: bool("timestamps"),
    username: oneLine(source.username, 64),
    showUsername: bool("showUsername"),
    scrollbar: source.scrollbar === true ? "always" : oneOf(["auto", "always", "off"] as const, source.scrollbar) ?? DEFAULT_TUI_PROFILE.scrollbar,
    scrollbarGlyphs: normalizeScrollbarGlyphs(source.scrollbarGlyphs),
    jumpHint: oneOf(["right", "center", "left", "off"] as const, source.jumpHint) ?? "right",
    jumpText: oneLine(source.jumpText, 40),
    activityPlacement: oneOf(["transcript", "above", "inside", "off"] as const, source.activityPlacement) ?? "transcript",
    activityParts: normalizeActivityParts(source.activityParts),
    comments: oneOf(COMMENT_MODES, source.comments) ?? "auto",
    commentKey: oneOf(COMMENT_KEYS, source.commentKey) ?? "comment",
    commentHint: oneOf(COMMENT_HINTS, source.commentHint) ?? "prompt",
    commentHintSeconds: boundedInt(source.commentHintSeconds, 1, 60, 5),
    commentChips: oneOf(COMMENT_CHIPS, source.commentChips) ?? "above",
    commentChipStyle: oneOf(COMMENT_CHIP_STYLES, source.commentChipStyle) ?? "chips",
    commentCollapse: boundedInt(source.commentCollapse, 6, 40, 14),
    commentMax: boundedInt(source.commentMax, 1, 9, 9),
    commentMarks: bool("commentMarks"),
    commentMarkGlyph: normalizeMarkGlyph(source.commentMarkGlyph),
    commentReplyKeys: normalizeReplyKeys(source.commentReplyKeys),
    commentTemplate: normalizeWording(source.commentTemplate, "comments"),
    commentEntry: normalizeWording(source.commentEntry, "quote", "text"),
    commentFolded: bool("commentFolded"),
    commentSentLayout: oneOf(COMMENT_SENT_LAYOUTS, source.commentSentLayout) ?? "rail",
    attachmentChips: oneOf(["inline", "above", "both"] as const, source.attachmentChips) ?? "inline",
    pasteSummary: bool("pasteSummary"),
    pasteSummaryMinChars: typeof source.pasteSummaryMinChars === "number" && Number.isFinite(source.pasteSummaryMinChars) ? Math.max(1, Math.min(100_000, Math.floor(source.pasteSummaryMinChars))) : 1000,
    copyOnSelect: bool("copyOnSelect"),
    vimMode: bool("vimMode"),
    multiline: bool("multiline"),
    shortcutOverlay: bool("shortcutOverlay"),
    altLabel: oneOf(ALT_LABELS, source.altLabel) ?? "auto",
    keyProtocol: oneOf(KEY_PROTOCOLS, source.keyProtocol) ?? "auto",
    optionKeys: oneOf(OPTION_KEYS, source.optionKeys) ?? "auto",
    escBacktrack: bool("escBacktrack"),
    queueRestore: bool("queueRestore"),
    escRetract: bool("escRetract"),
    pasteBurst: bool("pasteBurst"),
    draftRetentionDays: typeof source.draftRetentionDays === "number" && Number.isFinite(source.draftRetentionDays) ? Math.max(0, Math.min(3650, Math.floor(source.draftRetentionDays))) : 14,
    statusLeft: oneLine(source.statusLeft, 256),
    statusRight: oneLine(source.statusRight, 256),
    statusColors: oneLine(source.statusColors, 4096),
    reasoning: oneOf(["auto", "hidden", "collapsed", "expanded"] as const, source.reasoning) ?? "auto",
    toolOutput: oneOf(["auto", "collapsed", "expanded"] as const, source.toolOutput) ?? "auto",
    codeMapCard: oneOf(CODE_MAP_CARDS, source.codeMapCard) ?? "auto",
    toolDensity: oneOf(TOOL_DENSITIES, source.toolDensity) ?? "calm",
    diffView: oneOf(DIFF_VIEWS, source.diffView) ?? "unified",
    tagline: oneLine(source.tagline, 80),
    promptGlyphs: normalizePromptGlyphs(source.promptGlyphs),
    activityMessages: normalizeActivityMap(source.activityMessages, false),
    activityStates: normalizeActivityMap(source.activityStates, true),
    showActivityModel: bool("showActivityModel"),
    doneSymbol: oneLine(source.doneSymbol, 2) || "◈",
    logoKind: oneOf(LOGO_KINDS, source.logoKind) ?? DEFAULT_TUI_PROFILE.logoKind,
    homeMascot: normalizeHomeMascot(source.homeMascot),
    mascotMotion: typeof source.mascotMotion === "boolean" ? source.mascotMotion : DEFAULT_TUI_PROFILE.mascotMotion,
    mascotSize: oneOf(MASCOT_SIZES, source.mascotSize) ?? DEFAULT_TUI_PROFILE.mascotSize,
    customAscii: normalizeAscii(source.customAscii),
    homeRightPanel: oneOf(HOME_PANELS, source.homeRightPanel) ?? DEFAULT_TUI_PROFILE.homeRightPanel,
    density: oneOf(DENSITIES, source.density) ?? DEFAULT_TUI_PROFILE.density,
    theme: oneLine(source.theme, 64),
    themeLock: oneOf(["dark", "light"] as const, source.themeLock) ?? "",
    pet: oneLine(source.pet, 128),
    petSize: oneOf(PET_SIZES, source.petSize) ?? DEFAULT_TUI_PROFILE.petSize,
    promptLead: oneLine(source.promptLead, 12) || DEFAULT_TUI_PROFILE.promptLead,
    statusPlacement: oneOf(["auto", "inside", "outside"] as const, source.statusPlacement) ?? "auto",
    statusSeparator: typeof source.statusSeparator === "string" && !/[\x00-\x1f\x7f-\x9f]/.test(source.statusSeparator) ? source.statusSeparator.slice(0, 8) : DEFAULT_TUI_PROFILE.statusSeparator,
    titleTemplate: oneLine(source.titleTemplate, 180) || DEFAULT_TUI_PROFILE.titleTemplate,
    sidebarSide: oneOf(["left", "right"] as const, source.sidebarSide) ?? "left",
    panelNarrow: oneOf(["hide", "sheet"] as const, source.panelNarrow) ?? "hide",
    panelHeader: bool("panelHeader"),
    showAgent: bool("showAgent"),
    showEffort: bool("showEffort"),
    showPermission: bool("showPermission"),
    promptBorder: oneOf(["auto", "single", "rounded", "double", "ascii"] as const, source.promptBorder) ?? "auto",
    showModel: bool("showModel"),
    showProvider: bool("showProvider"),
    showStatus: bool("showStatus"),
    showContext: source.contextBar === "off" ? false : source.contextBar === "top" ? true : bool("showContext"),
    contextBar: oneOf(["top", "off"] as const, source.contextBar) ?? (source.showContext === false ? "off" : "top"),
    contextStyle: oneOf(["bar", "percent", "both"] as const, source.contextStyle) ?? "both",
    topbarStats: normalizeStatParts(source.topbarStats),
    showFooterContext: false,
    footerQuota: bool("footerQuota"),
    quotaView: oneOf(QUOTA_VIEWS, source.quotaView) ?? "used",
    quotaColor: oneOf(QUOTA_COLORS, source.quotaColor) ?? "pressure",
    footerToday: bool("footerToday"),
    quotaRefresh: normalizeQuotaRefresh(source.quotaRefresh),
    footerRows: normalizeFooterLayout(source.footerRows),
    footerText: normalizeFooterText(source.footerText),
    footerIcons: oneOf(FOOTER_ICON_MODES, source.footerIcons) ?? "none",
    messageLayout: oneOf(["quiet", "classic"] as const, source.messageLayout) ?? "quiet",
    userIcon: oneLine(source.userIcon, 4),
    assistantIcon: oneLine(source.assistantIcon, 4),
    userLabel: bool("userLabel"),
    assistantLabel: bool("assistantLabel"),
    assistantName: oneLine(source.assistantName, 32),
    userLead: typeof source.userLead === "string" ? oneLine(source.userLead, 4) : "›",
    assistantLead: typeof source.assistantLead === "string" ? oneLine(source.assistantLead, 4) : "•",
    userTint: bool("userTint"),
    messageMeta: oneOf(["off", "compact", "full"] as const, source.messageMeta) ?? "off",
    showTopbar: bool("showTopbar"),
    showSessionTitle: bool("showSessionTitle"),
    stickyPrompt: bool("stickyPrompt"),
    showProject: bool("showProject"),
    showDiffLines: bool("showDiffLines"),
    showDiffFiles: bool("showDiffFiles"),
    terminalTitle: bool("terminalTitle"),
    titleActivity: bool("titleActivity"),
    sessionAccent: bool("sessionAccent"),
    activityMascot: bool("activityMascot"),
    showActivity: bool("showActivity"),
    showElapsed: bool("showElapsed"),
    showTokens: bool("showTokens"),
    showInterruptHint: bool("showInterruptHint"),
    showStalled: bool("showStalled"),
    usageNotices: bool("usageNotices"),
    limitCheckpoint: bool("limitCheckpoint"),
    cacheNotices: bool("cacheNotices"),
    confirmNotices: bool("confirmNotices"),
    showCommandHint: bool("showCommandHint"),
    showAgentHint: bool("showAgentHint"),
    promptChrome: oneOf(PROMPT_CHROMES, source.promptChrome) ?? DEFAULT_TUI_PROFILE.promptChrome,
    logoText: normalizeLogoText(source.logoText, logoFont),
    logoFont,
    productName: normalizeProductName(source.productName),
    homeLayout: oneOf(HOME_LAYOUTS, source.homeLayout) ?? DEFAULT_TUI_PROFILE.homeLayout,
    homeTips: typeof source.homeTips === "boolean" ? source.homeTips : DEFAULT_TUI_PROFILE.homeTips,
    homeFooter: typeof source.homeFooter === "boolean" ? source.homeFooter : DEFAULT_TUI_PROFILE.homeFooter,
    homeHeader: bool("homeHeader"),
    homePanel: bool("homePanel"),
    showPlaceholder: bool("showPlaceholder"),
    placeholderText: oneLine(source.placeholderText, 120),
    sidebarHeader: bool("sidebarHeader"),
    showTasks: bool("showTasks"),
    usageClock: bool("usageClock"),
    turnBell: typeof source.turnBell === "boolean" ? source.turnBell : DEFAULT_TUI_PROFILE.turnBell,
    turnNotify: oneOf(["off", "osc9", "osc777"] as const, source.turnNotify) ?? "off",
    notifyWhen: oneOf(["unfocused", "always"] as const, source.notifyWhen) ?? DEFAULT_TUI_PROFILE.notifyWhen,
    autoRecap: typeof source.autoRecap === "boolean" ? source.autoRecap : DEFAULT_TUI_PROFILE.autoRecap,
    idleReturn: oneOf(["off", "30m", "1h", "3h"] as const, source.idleReturn) ?? DEFAULT_TUI_PROFILE.idleReturn,
    resumePrompts: typeof source.resumePrompts === "boolean" ? source.resumePrompts : DEFAULT_TUI_PROFILE.resumePrompts,
    activitySound: oneOf(["off", "pulse", "hum"] as const, source.activitySound) ?? "off",
    sidebarWidgets: sidebarSpec(source.sidebarWidgets),
    rightSidebar: typeof source.rightSidebar === "boolean" ? source.rightSidebar : false,
    sidebarWidth: typeof source.sidebarWidth === "number" && Number.isInteger(source.sidebarWidth) && source.sidebarWidth >= 32 && source.sidebarWidth <= 80 ? source.sidebarWidth : 0,
    promptStatus: oneOf(["off", "border"] as const, source.promptStatus) ?? "off",
    sidebar: oneOf(SIDEBAR_MODES, source.sidebar) ?? DEFAULT_TUI_PROFILE.sidebar,
    images: oneOf(IMAGE_MODES, source.images) ?? DEFAULT_TUI_PROFILE.images,
    transcriptImages: bool("transcriptImages"),
    hyperlinks: bool("hyperlinks"),
    fileOpener: oneOf(FILE_OPENERS, source.fileOpener) ?? DEFAULT_TUI_PROFILE.fileOpener,
    pathClick: oneOf(["auto", "panel", "editor"] as const, source.pathClick) ?? DEFAULT_TUI_PROFILE.pathClick,
    viewerNumbers: bool("viewerNumbers"),
    // It was on/off, off by default: a saved `false` is the old default and becomes `auto`, a saved `true` stays on.
    viewerWrap: source.viewerWrap === true ? "on" : oneOf(["auto", "on", "off"] as const, source.viewerWrap) ?? "auto",
    viewerFocus: bool("viewerFocus"),
    wheelLines: typeof source.wheelLines === "number" && Number.isFinite(source.wheelLines) ? Math.max(1, Math.min(20, Math.floor(source.wheelLines))) : DEFAULT_TUI_PROFILE.wheelLines,
    rightClickPaste: bool("rightClickPaste"),
    altScreen: bool("altScreen"),
    accessible: bool("accessible"),
    glyphs: oneOf(GLYPH_CHOICES, source.glyphs) ?? "auto",
    processMode: oneOf(PROCESS_MODES, source.processMode) ?? DEFAULT_TUI_PROFILE.processMode,
    usageWidgets: normalizeUsageWidgets(source.usageWidgets),
    usageWeatherEnabled: bool("usageWeatherEnabled"),
    usageWeatherRegion: oneLine(source.usageWeatherRegion, 120),
    tutorialDone: typeof source.tutorialDone === "string" ? source.tutorialDone.replace(/[^a-z0-9,-]/g, "").slice(0, 400) : "",
    ...imageWaitKeys(source),
  }
}

/** The image wait keys of a stored profile; a preset that names no built-in and no user preset is the default. */
function imageWaitKeys(source: Record<string, unknown>): Pick<TuiProfile, "imageWait" | "imageWaitPreset" | "imageWaitSpeed" | "imageWaitColor" | "imageWaitMeta" | "imageWaitCanvas" | "imageWaitArt"> {
  const art = normalizeImageWaitArt(source.imageWaitArt)
  return {
    imageWait: oneOf(IMAGE_WAIT_MODES, source.imageWait) ?? DEFAULT_TUI_PROFILE.imageWait,
    imageWaitPreset: typeof source.imageWaitPreset === "string" && imageWaitPresetNames(art).includes(source.imageWaitPreset) ? source.imageWaitPreset : DEFAULT_TUI_PROFILE.imageWaitPreset,
    imageWaitSpeed: boundedInt(source.imageWaitSpeed, IMAGE_WAIT_LIMITS.intervalMin, IMAGE_WAIT_LIMITS.intervalMax, DEFAULT_TUI_PROFILE.imageWaitSpeed),
    imageWaitColor: oneOf(IMAGE_WAIT_COLORS, source.imageWaitColor) ?? DEFAULT_TUI_PROFILE.imageWaitColor,
    imageWaitMeta: typeof source.imageWaitMeta === "boolean" ? source.imageWaitMeta : DEFAULT_TUI_PROFILE.imageWaitMeta,
    imageWaitCanvas: normalizeImageWaitCanvas(source.imageWaitCanvas),
    imageWaitArt: art,
  }
}

/** The footer names the model in use (a `model` segment in the rows, or the single row's model label), so a change needs no notice of its own. */
export const footerShowsModel = (profile: Pick<TuiProfile, "showStatus" | "showModel" | "footerRows">) =>
  profile.showStatus && (profile.footerRows.length ? profile.footerRows.some((row) => row.includes("model")) : profile.showModel)

/** The saved profile; the defaults when the file is missing, unreadable or not JSON. */
export function readTuiProfile(dataDir: string): TuiProfile {
  try {
    const file = tuiProfilePath(dataDir)
    if (!fs.existsSync(file)) return { ...DEFAULT_TUI_PROFILE }
    const raw = JSON.parse(fs.readFileSync(file, "utf8"))
    const profile = normalizeTuiProfile(raw)
    if (raw && ["small", "standard", "shadow", "classic", "opencode", "slant"].includes(raw.logoFont)) writeTuiProfile(dataDir, profile)
    return profile
  } catch {
    return { ...DEFAULT_TUI_PROFILE }
  }
}

/** Saves `profile` (validated again) next to the other terminal files; written whole, then renamed into place. */
export function writeTuiProfile(dataDir: string, profile: TuiProfile): { ok: true } | { ok: false; error: string } {
  const file = tuiProfilePath(dataDir)
  const temp = `${file}.${process.pid}.tmp`
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(temp, `${JSON.stringify(normalizeTuiProfile(profile), null, 2)}\n`)
    fs.renameSync(temp, file)
    return { ok: true }
  } catch (error) {
    try {
      fs.rmSync(temp, { force: true })
    } catch {
      // Nothing left to clean up.
    }
    return { ok: false, error: `[TUI]: could not save ${file}: ${error instanceof Error ? error.message : String(error)}` }
  }
}
