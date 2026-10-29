/**
 * View slots: one contract that lets an extension or a package replace how a part of the terminal is drawn.
 * Types and one small constant table only (no zod, no imports), so view authors and the thin client share it:
 * `import type { ViewRenderer } from "@mendcode/extension-api/views"`.
 *
 * The contract, in three lines:
 *   1. A slot has a typed, serialisable INPUT (plain data: exactly what the built-in renderer receives, plus the
 *      available size, theme tokens and glyph mode). Never app internals, never functions.
 *   2. A renderer is a pure, synchronous function `input -> lines | undefined`. Lines are spans with fg/bg/bold/dim and
 *      optional hit regions (`action` from the slot's closed set); `undefined` falls through to the built-in.
 *   3. The terminal keeps all input handling. A hit region only asks the terminal to run one of the slot's
 *      actions; keys, answers and permissions are never decided by a view.
 *
 * The built-in renderers go through the same registry, so the examples in docs/views.md are real.
 */

export type ViewColor = string
/** One run of text. `action` makes it clickable (an id from the slot's `actions`); `arg` says on what (an index or an id). */
export type ViewSpan = { text: string; fg?: ViewColor; bg?: ViewColor; /** On inputs only: the exact color the built-in chose. */ fgHex?: string; bgHex?: string; bold?: boolean; dim?: boolean; italic?: boolean; underline?: boolean; action?: string; arg?: string | number }
export type ViewLine = ViewSpan[]

/** Theme tokens: the active theme's name and its role -> hex table. Use a role name (`primary`, `muted`...) as `fg`/`bg` to follow the theme. */
export type ViewTheme = Readonly<{ name: string; colors: Readonly<Record<string, string>> }>

/** What every slot's input adds to its model. `width`/`height` are the cells available to the view. */
export type ViewEnv = Readonly<{ width: number; height: number; theme: ViewTheme; ascii: boolean; now: number }>

// ─── Models: what each built-in renderer receives ───────────────────────────────────────────────────────────────

export type Attachment = Readonly<{ name?: string; mime: string }>
export type MessageStyleModel = Readonly<{ layout: "quiet" | "classic"; icon: string; lead: string; label: string; tint: boolean }>
type MessageCommon = Readonly<{
  itemId: string
  turnId: string
  text: string
  /** Epoch ms of the message, when known. */
  at?: number
  /** The formatted time when the transcript shows timestamps, else "". */
  time: string
  mode: "minimal" | "balanced" | "full"
  style: MessageStyleModel
  /** The built-in's own rows of this message, so a view can add text above or under them (`[...m.builtin, footer]`). Only on a custom view's input. */
  builtin?: readonly ViewLine[]
}>

/** `variant`: a normal message, a `!command` the user ran, or a system notice written as a user turn. */
export type UserMessageModel = MessageCommon & Readonly<{
  variant: "message" | "shell" | "notice"
  local?: boolean
  /** Absent when the message has none recorded; `images` then counts pasted pictures. */
  attachments?: readonly Attachment[]
  images: number
  username: string
  /** The reader opened the long message (ctrl+o); otherwise a very long one is cut with a "more characters" row. */
  expanded: boolean
  /** Present when the message is a set of comments on passages of an answer (docs/editor.md) and the `commentFolded` setting is on: its parts, so a view can draw them its own way. The built-in folds the quotes to one line each. */
  comments?: Readonly<{
    comments: ReadonlyArray<Readonly<{ n: number; of: string; quote: string; cut: number; text: string }>>
    /** The general text sent with them. */
    note: string
    /** How the built-in draws the pairs (the `commentSentLayout` setting, `rail` when absent); a custom view may ignore it. */
    layout?: "stack" | "rail" | "inline"
    /** The `commentCollapse` setting: the cells of a quote the inline layout keeps before a pair takes two rows. */
    collapse?: number
    /** Text that came before or after the comments in the same message (an editor selection, a pasted file). */
    head?: string
    tail?: string
  }>
}>

export type AssistantMessageModel = MessageCommon & Readonly<{
  /** `plain` shows the text as written, `markdown` renders it keeping diagram source, `full` renders everything. */
  renderer: "plain" | "markdown" | "full"
  /** `<details>` blocks the reader opened or closed by ordinal; `detailsAll` is ctrl+o. */
  details: Readonly<Record<number, boolean>>
  detailsAll: boolean
  /** How Markdown is drawn: the `full` renderer's engine (`enhanced`) with its table, heading and copy-hint styles. */
  markdown: Readonly<{ enhanced: boolean; table: string; heading: string; copy: string; rtl: boolean }>
  /** The message as rows (Markdown as the renderer allows, no lead or time), laid out 4 cells narrower than `width` so a rail or indent fits. Reuse them to restyle a message without redoing Markdown. Only on a custom view's input. */
  body?: readonly ViewLine[]
}>

export type ReasoningModel = Readonly<{
  itemId: string
  turnId: string
  text: string
  running: boolean
  /** How long the model thought, when finished. */
  ms?: number
  /** Rows the built-in shows when expanded. */
  rows: number
  /** The collapsed one-line form (the profile's `reasoning: collapsed`, or the minimal view). */
  oneLine: boolean
  /** The profile hides reasoning: the built-in draws nothing. */
  hidden: boolean
}>

export type ToolStatus = "running" | "ok" | "error" | "cancelled" | "interrupted" | "unknown"
export type ToolCounts = Readonly<{ lines?: number; entries?: number; matches?: number }>
export type ToolCardModel = Readonly<{
  itemId: string
  /** The tool's name: `read`, `shell`, `edit`, `grep`, `custom__x`, `mcp__server__tool`... */
  kind: string
  /** What follows the name in the card title: a path, a command, a pattern. */
  detail: string
  /** The card title as the transcript knows it (`read: src/a.ts`). */
  title?: string
  status: ToolStatus | undefined
  /** Everything the tool printed. Large outputs are cut by the transcript before they get here. */
  text: string
  /** Non-empty output lines (at most 400): the rows the built-in summarises and pages. Only on a custom view's input. */
  output?: readonly string[]
  /** The dim summary after a collapsed card: the line count, a search's matches. */
  summary?: string
  /** `summary` (one row), `preview` (a few rows) or `full` (the body, paged). */
  level: "summary" | "preview" | "full"
  expanded: boolean
  page: number
  counts: ToolCounts
  pattern?: string
  elapsedMs?: number
  exitCode?: number
  toolCalls?: number
  agent?: string
  model?: string
  /** A write: the content its call put in the file, the first lines and how many in all; `cut` when only its start is known. */
  written?: Readonly<{ lines: readonly string[]; total: number; cut?: true }>
  /** A task: what its sub-agent runs on (model, provider, engine, effort, fast) as coloured spans; the full tier only. */
  run?: Array<{ text: string; fg?: string }>
  awaiting?: boolean
  compact?: boolean
  /** The full view's `toolDensity` for this call: `line` keeps a finished call to its header row, `brief` a short preview capped by kind. Absent: the level decides. */
  density?: "line" | "brief"
  meta?: Readonly<Record<string, unknown>>
  /** Spinner frame while running, and how many tail lines a running card shows. */
  frame: number
  tailLines: number
  /** The view mode: the minimal view draws one-line rows instead of cards, so this slot is not called there. */
  mode: "balanced" | "full"
  /** The tool's declared presentation (renderSpec), drawn under the card instead of its text. */
  render?: Readonly<Record<string, unknown>>
  mapDetail?: "balanced" | "full"
}>

export type ApprovalOption = Readonly<{ label: string; /** The letter key that also picks it ("" when none). */ key: string; choice: "once" | "session" | "project" | "user" | "deny" | "note" | "edit" | "comment" }>
export type ApprovalModel = Readonly<{
  requestId: string
  /** `panel` is the boxed prompt; `inline` is the minimal view's one-line prompt. */
  variant: "panel" | "inline"
  title: string
  tool?: string
  permission?: "read" | "write" | "execute"
  /** The text being approved: the shell command or the file and change. A view must keep it visible (see docs/views.md). */
  subject: string
  /** The built-in's detail rows (head, diff, the reviewer's reason and verdict), already wrapped for `width`. */
  detail: readonly ViewLine[]
  explain?: readonly ViewLine[]
  /** The real choices in order. Keys and their effect are owned by the terminal. */
  options: readonly ApprovalOption[]
  choice: number
  hint: string
  plan: boolean
  /** Rows of the option block the terminal draws (the one a `{options}` row places); set by the terminal on custom views. */
  optionRows?: number
}>

export type QuestionOption = Readonly<{ label: string; description?: string }>
export type BatchQuestion = Readonly<{ header: string; question: string; context?: string; options: readonly QuestionOption[]; multiple?: boolean; custom?: boolean }>
/** A batch's progress: the open tab (the last one is "Confirm"), the highlighted row, the answers per question and the typed ones. */
export type QuestionDraftModel = Readonly<{ tab: number; choice: number; answers: readonly (readonly string[])[]; custom: readonly string[]; editing: boolean; scroll: number }>
export type QuestionModel = Readonly<{
  requestId: string
  variant: "single" | "batch"
  title: string
  detail: string
  multiple: boolean
  /** Single question: its options. The "Type your own answer" row follows them (index `options.length`). */
  options: readonly QuestionOption[]
  choice: number
  picked: readonly number[]
  /** The reader is typing their own answer in the card's field (the "Type your own answer" row turned into a text field). */
  typing: boolean
  /** The questions and the draft (a single question is a batch of one: `title` as its header, `detail` as its text). */
  questions?: readonly BatchQuestion[]
  draft?: QuestionDraftModel
  /** Rows of the answer block the terminal draws (the one a `{options}` row places); set by the terminal on custom views. A batch's whole panel is that block. */
  optionRows?: number
}>

export type PromptFrameModel = Readonly<{
  preset: "box" | "top-bottom" | "minimal" | "ascii-box"
  border: "auto" | "single" | "rounded" | "double" | "ascii"
  lead: string
  /** The profile's six custom border glyphs (h, v, tl, tr, bl, br), or "". */
  borders: string
}>
/** The frame around the prompt: rows above and below it, and the cells before and after each prompt row. Each row is cut to `width`. */
export type PromptFrameOutput = Readonly<{ top: readonly ViewLine[]; bottom: readonly ViewLine[]; left?: readonly ViewSpan[]; right?: readonly ViewSpan[] }>

export type TopbarModel = Readonly<{
  path: string
  home?: string
  branch?: string
  hideProject: boolean
  files?: number
  title: string
  diff?: Readonly<{ added: number; removed: number }>
  context?: Readonly<{ tokens: number; limit: number }>
  tick?: number
  contextHover: boolean
  contextStyle: "bar" | "percent" | "both"
  navigation?: string
  /** The stat parts the profile's `topbarStats` places, as theme spans (docs/customize.md, "Session stats"). */
  stats?: readonly ViewSpan[]
}>

export type SessionRow = Readonly<{ sessionId: string; title: string; state: string; queued: number; updatedAt: number; archivedAt?: number; lifecycle?: Readonly<{ pinnedAt?: number | undefined; pr?: Readonly<{ number: number; state?: string | undefined }> | undefined }> | undefined }>
export type SessionsSidebarModel = Readonly<{ sessions: readonly SessionRow[]; current: string; selected?: string; focused: boolean }>

export type LimitAction = "resume" | "schedule" | "cancel" | "snooze" | "dismiss"
export type NoticeModel =
  | Readonly<{ kind: "toast"; variant: "info" | "success" | "warning" | "error"; title?: string; message: string; /** What to do next (`/memory undo`), muted and kept whole when one row has to cut the message. */ hint?: string; /** One row, not a floating box: the notice row above the prompt, or the inline live region. */ inline?: boolean }>
  | Readonly<{ kind: "limit"; view: Readonly<{ state: "paused" | "scheduled" | "snoozed" | "ready"; provider?: string; message: string; resetsAt?: number }>; chips: readonly Readonly<{ action: LimitAction; label: string }>[] }>
  | Readonly<{ kind: "queue"; previews: readonly string[]; delivery: readonly (("queue" | "steer" | "restart") | undefined)[]; held: boolean; paused: boolean; mode?: string; shell: readonly number[]; /** Positions that are system notices, not the user's messages. */ notices?: readonly number[] }>

export type ScriptSegment = Readonly<{ text: string; fg?: string | undefined; bold?: boolean | undefined; prepend?: boolean | undefined }>
/** The rows under the prompt (agent, model, runtime, counters). Spans inside are theme spans. */
export type FooterModel = Readonly<{
  leftItems?: readonly ViewSpan[]
  rightItems?: readonly ViewSpan[]
  separator?: string
  agent?: string
  agentColor?: Readonly<{ fg?: string; fgHex?: string }>
  model?: string
  effort?: string
  provider?: string
  counters?: readonly ViewSpan[]
  permission?: string
  permissionLabel?: string
  profile?: string
  pr?: Readonly<{ number: number; state: string }>
  loops: number
  goal?: readonly ViewSpan[]
  workflows?: Readonly<{ live: number; waiting: number }>
  notice?: string
  connection?: "connected" | "reconnecting" | "closed"
  shell?: boolean
  scriptLeft?: readonly ScriptSegment[]
  scriptRight?: readonly ScriptSegment[]
  scriptLeftRow?: readonly ScriptSegment[]
  scriptRightRow?: readonly ScriptSegment[]
  /** Script rows below the first, at most three. */
  extraRows: readonly Readonly<{ scriptLeftRow: readonly ScriptSegment[]; scriptRightRow: readonly ScriptSegment[] }>[]
}>

export type HomeSessionModel = Readonly<{ id?: string; title: string; state: "needs_input" | "looping" | "working" | "completed"; updatedAt: number; startedAt?: number; detail?: string }>
export type HomeModel = Readonly<{
  screenHeight?: number
  version?: string
  root: string
  bare: boolean
  sessions: readonly HomeSessionModel[]
  selectedId?: string
  spinner: number
  /** The /customize look: logo kind, product name, tagline, layout, density. */
  look: Readonly<Record<string, unknown>>
  tip?: string
  footer?: Readonly<{ mcp?: Readonly<{ total: number; connected: number; failed: boolean }> }>
}>

/** One panel widget of the right bar: the built-in body rows, to restyle or replace. */
export type PanelWidgetModel = Readonly<{ widget: string; options: Readonly<Record<string, unknown>>; body: readonly ViewLine[] }>

/** One line of the open file as the viewer shows it: its text (control characters already replaced), the highlighted spans, and its marks. */
export type FileViewerRow = Readonly<{
  /** 1-based line number. */
  line: number
  text: string
  /** The line in the colours of its language (the built-in highlighter); a view may restyle these or draw `text` itself. */
  spans: readonly ViewSpan[]
  /** A Git change in the margin: the line was added or modified since HEAD, or lines were removed just above it. */
  mark?: "added" | "modified" | "deleted"
  /** The lines HEAD had just above this one and the working file no longer has (at most `FILE_VIEWER_REMOVED` of them; `removedMore` counts the rest). */
  removed?: readonly string[]
  removedMore?: number
  /** Among the cited or selected lines. */
  selected: boolean
  /** Holds the search text. */
  hit: boolean
  /** The line has not been read yet (the window is loading); `text` is empty. */
  pending?: true
}>

/**
 * The file viewer: the file a click on a path opened, in the right slot beside the chat (`variant: "slot"`) or as a full page on a narrow
 * terminal (`"page"`). Read-only. `rows` are the lines from `top` that can fit, the terminal does the wrapping, the gutter and the
 * clipping. The built-in draws a header (name, size, language, `open`, `ask agent`, `copy`), a row for the slot (which one of the file and
 * the panel is showing), the lines and a hint row; a view that draws its own should keep the header's actions and a row per line.
 */
export type FileViewerModel = Readonly<{
  variant: "slot" | "page"
  /** Relative to the workspace directory it is in (forward slashes). */
  path: string
  name: string
  /** The highlighter's language (`ts`, `rust`, `md`...) or `text`. */
  language: string
  /** `text` has `rows`; the others are one line of `note`. `loading` is the first window on its way. */
  kind: "text" | "binary" | "special" | "large" | "directory" | "missing" | "loading" | "error"
  size: number
  /** All lines of the file. */
  lines: number
  /** The type of a binary file. */
  mime?: string
  note?: string
  /** The line number at the top of the view. */
  top: number
  rows: readonly FileViewerRow[]
  selection?: Readonly<{ from: number; to: number }>
  search?: Readonly<{ query: string; typing: boolean; current: number; total: number }>
  /** The keyboard is in the viewer (it is not by default: the prompt keeps it). */
  focused: boolean
  /** The right panel exists in the same slot, so the viewer can switch to it. */
  panel: boolean
  /** `wrap` is the setting resolved for this file; `prose` says it is Markdown or text, which wraps at its spaces instead of anywhere. */
  options: Readonly<{ lineNumbers: boolean; wrap: boolean; left: number; prose?: boolean }>
  /** The last thing that happened, in a few words (`reloaded`, `copied`). */
  notice?: string
  /** The link that opens the file at the cited line in the user's editor (their `fileOpener`); absent when that is `none`. */
  openLink?: string
  /** Secrets masked in the window shown. */
  redacted: number
  /** A `directory`'s entries, folders first, `..` leading when the folder is not the workspace root (kind `up`). Absent for every other kind. */
  entries?: readonly FileViewerEntry[]
  /** The entry the keyboard is on (an index of `entries`). */
  cursor?: number
  /** How many entries the folder holds; more than `entries` has when the listing was cut. */
  entriesTotal?: number
  /** The keys of the hints as the user reads them (rebinding and the Option label applied). A key that is not bound is absent: leave its hint out. */
  keys?: Readonly<{ focus?: string; switch?: string; close?: string }>
}>

/** One row of a folder listing in the viewer. */
export type FileViewerEntry = Readonly<{ name: string; kind: "up" | "dir" | "file" | "link" | "other"; size?: number }>

export type FileViewerAction = "close" | "switch" | "open" | "ask" | "copy" | "line" | "entry"

export type SlashMenuCommand = Readonly<{ name: string; aliases: readonly string[]; summary: string; group: string; shortcut?: string; setting?: string; custom?: true; ext?: true; mcp?: true }>
export type SlashMenuItem = Readonly<{ kind: "command" | "group"; label: string; group: string; command?: SlashMenuCommand; count?: number; preview?: string; expanded?: boolean; indented?: boolean }>
export type SlashMenuModel = Readonly<{
  catalog: readonly SlashMenuCommand[]
  query: string
  selection: number
  group: string
  groups: readonly Readonly<{ id: string; label: string; count?: number }>[]
  suggested?: boolean
  items: readonly SlashMenuItem[]
  layout: "tabs" | "groups" | "columns" | "flat"
}>

/** The `/status` page: daemon, engines, session, MCP, extensions and storage facts as the daemon reported them. A page view returns the whole body (`height` rows). */
export type StatusPageModel = Readonly<{
  scroll: number
  connected: boolean
  cliVersion?: string
  buildId?: string
  info?: Readonly<Record<string, unknown>>
  infoError?: string
  models?: Readonly<Record<string, unknown>>
  session: Readonly<{ model?: string; effort?: string; permission: string; permissionLabel: string; state: string; context?: Readonly<{ tokens: number; threshold: number }> }>
  mcps?: Readonly<Record<string, unknown>>
  mcpsError?: string
  extensions?: Readonly<Record<string, unknown>>
  extensionsError?: string
  terminalExtensions: Readonly<{ loaded: number; problems: number }>
  storage?: Readonly<Record<string, unknown>>
  storageError?: string
  dataDir?: string
}>


// ─── Transcript leftovers: compaction, turn status, tool rows ──────────────────────────────────────────────────

/** The compaction card of a turn: what was packed, how, and the follow-up. `summary` is the saved memory text. */
export type CompactionCardModel = Readonly<{
  itemId: string
  turnId: string
  state: string
  reason: string
  /** The daemon started it in an idle session, before the provider's prompt cache expired. */
  idle?: true
  summary: string
  followUp: string
  followUpQueueId?: string
  method?: string
  tailTurns?: number
  tailTokens?: number
  fallbackReason?: string
  /** The summary request repeated the session's last request, which the provider reads from its prompt cache. */
  cachedPrefix?: true
  /** The resolved card style (`quiet`, `minimal`, `cockpit`...), and whether the stage list and scratchpad rows show. */
  style: string
  presentation: string
  progress: boolean
  scratchpad: boolean
  /** The reader opened the card (ctrl+o): the summary shows. */
  expanded: boolean
  /** The summary as rows, 4 cells narrower than `width`. Only on a custom view's input. */
  summaryRows?: readonly ViewLine[]
}>

/** The goal, usage-limit and turn-end rows between turns. `variant` says which; the other fields are what that variant needs. */
export type TurnStatusModel = Readonly<{
  itemId: string
  variant: "end" | "goal" | "limit" | "note" | "undone" | "checkpoint"
  mode: "minimal" | "balanced" | "full"
  /** The profile's `messageMeta`: how much a turn end says. */
  meta: "off" | "compact" | "full"
  /** The completion symbol. */
  done: string
  /** When the row was made (a turn end: when the turn ended), and that time formatted, or `""` when timestamps are off. */
  at?: number
  time: string
  /** The built-in's own rows of this item, so a view can add text above or under them. Only on a custom view's input. */
  builtin?: readonly ViewLine[]
  /** `end`: the turn's outcome, token counts and error. */
  end?: Readonly<{ outcome: "completed" | "cancelled" | "interrupted" | "failed" | "paused"; agent?: string; model?: string; input: number; output: number; reasoning?: number; usage: boolean; ms?: number; reason?: string; error?: Readonly<{ code: string; message: string }> }>
  /** `goal` / `limit`: the card's own data (the goal and what changed; the limit state and reset time). */
  goal?: Readonly<Record<string, unknown>>
  limit?: Readonly<Record<string, unknown>>
  /** `note`: a cache or usage note, or the notice before a compaction; `cacheNotices` says whether to draw it (the profile switch for the first two, always true for the notice, which is only made while its own feature is on). */
  note?: string
  cacheNotices: boolean
  /** `undone`: how many messages the rewind removed. */
  undone?: number
}>

/** The rows of a tool call that are not a card: the minimal view's one-line row, a saved-memory note, a submitted plan, the image line. */
export type ToolRowModel = Readonly<{
  itemId: string
  variant: "minimal" | "memory" | "plan" | "images" | "orientation"
  title?: string
  /** `memory`: what to do next, muted at the row's right edge (`/memory undo`); `detail` is the memory's whole text and `open` says the reader opened the row. `orientation`: the engine's injected code map, collapsed to its `text`. */
  hint?: string
  detail?: string
  open?: boolean
  status: ToolStatus | undefined
  text: string
  /** `minimal`: how many tools this row stands for (a run of successful tools folds into its last row), and whether a later row already stands for this one. */
  run: number
  folded: boolean
  /** `minimal`: the last line of a failure's output. */
  reason?: string
  /** `images`: how many images the tool made, and the file path its text ends in. */
  images?: number
  where?: string
}>

// ─── Pages, overlays and bars: the envelope slots ──────────────────────────────────────────────────────────────

/**
 * Every full-screen page (settings, customize, usage, sessions, agents, memory, models, mcps, permissions, workflows, loops,
 * changes, help, onboarding, ...) draws through this ONE shape. The terminal owns the page's state (which row is selected,
 * how far it is scrolled, what is typed) and its keys; the view only draws. `body` is the page as the built-in drew it, row
 * by row: a view can return it restyled, reordered, framed or replaced. Return `body.length <= height` rows; the status rows
 * (`status`) are appended by the terminal. `selected` and `scroll` are read from what the page drew (the row it highlighted;
 * the scroll offset where the page keeps one) and are `undefined` when the page has neither. A page the view does not
 * recognise should return `undefined` to keep the built-in. A drawn page always keeps an `esc` hint: if the rows do not
 * show one, the terminal adds one (replacing the last row only when the page is full).
 */
export type PageModel = Readonly<{
  /** The page's id (`settings`, `usage`, `sessions`, ...). */
  page: string
  title: string
  /** The built-in hint line of the page (`esc back`, `↑↓ select`...), when it drew one. */
  hints?: string
  selected?: number
  scroll?: number
  body: readonly ViewLine[]
  status: readonly ViewLine[]
}>

/** The command palette, the pickers and the floating cards (fetch, rewind, goal, return prompts). `rows` is the card the built-in drew. */
export type OverlayModel = Readonly<{
  variant: "palette" | "picker" | "card"
  title: string
  query: string
  selected: number
  matches: number
  rows: readonly ViewLine[]
}>

/**
 * The rows around the prompt that are not a card: the working row, the find and prompt-search bars, the attachment chips,
 * the IDE selection, voice, vim and daemon-notice rows, the shortcut overlay, the `@` mention popup, the running sub-agents strip
 * (`agents`) and the session's background commands and agents over the prompt (`background`). A bar is drawn
 * only while the terminal shows it; `rows` is what the built-in drew.
 */
export type BarModel = Readonly<{
  variant: "working" | "find" | "search" | "attachments" | "ide" | "voice" | "vim" | "daemon" | "shortcuts" | "mention" | "agents" | "background"
  rows: readonly ViewLine[]
}>

// ─── Slot table ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Every slot, with the model its input carries and the actions its hit regions may name. */
export type ViewModels = {
  "message.user": UserMessageModel
  "message.assistant": AssistantMessageModel
  "message.reasoning": ReasoningModel
  "tool.card": ToolCardModel
  "tool.row": ToolRowModel
  "compaction.card": CompactionCardModel
  "turn.status": TurnStatusModel
  approval: ApprovalModel
  question: QuestionModel
  "prompt.frame": PromptFrameModel
  topbar: TopbarModel
  "sessions.sidebar": SessionsSidebarModel
  notice: NoticeModel
  footer: FooterModel
  home: HomeModel
  "panel.widget": PanelWidgetModel
  "file.viewer": FileViewerModel
  "slash.menu": SlashMenuModel
  "page.status": StatusPageModel
  page: PageModel
  overlay: OverlayModel
  bar: BarModel
}
export type ViewSlot = keyof ViewModels

/** The input of a renderer: the slot's model plus the environment. */
export type ViewInput<S extends ViewSlot> = Readonly<ViewModels[S] & ViewEnv>
/** What a renderer returns: lines (most slots), a frame (`prompt.frame`), or `undefined` to use the built-in. */
export type ViewOutput<S extends ViewSlot> = S extends "prompt.frame" ? PromptFrameOutput | undefined : ViewLine[] | undefined
export type ViewRenderer<S extends ViewSlot> = (input: ViewInput<S>) => ViewOutput<S>

export type ViewSlotInfo = Readonly<{
  /** Where the slot draws and what it replaces. */
  label: string
  /** The closed set of action ids a hit region of this slot may use (empty: the view cannot be clicked). */
  actions: readonly string[]
  /** What `arg` means for those actions. */
  arg?: string
  /**
   * The slot's real options grant or refuse something (an approval's "Allow once" / "Reject", a question's answers), so the terminal
   * always draws them itself in a block of its own, with their click regions. A view restyles everything around the block and may
   * place it with a row that holds only `HOST_OPTIONS_ROW`; it cannot draw on the block's rows or make a click region for an option.
   */
  hostOptions?: true
  /** `block`: a transcript item (memoised per item). `chrome`: redrawn per frame (memoised per input). `page`: a full page body. */
  kind: "block" | "chrome" | "page"
  /** Most rows the output may have; the input's `height` is never larger. */
  maxRows: number
}>

export const VIEW_SLOTS: Readonly<Record<ViewSlot, ViewSlotInfo>> = {
  "message.user": { label: "A user message in the transcript", actions: [], kind: "block", maxRows: 200 },
  "message.assistant": { label: "An assistant message in the transcript", actions: [], kind: "block", maxRows: 200 },
  "message.reasoning": { label: "A reasoning block in the transcript", actions: [], kind: "block", maxRows: 200 },
  "tool.card": { label: "A tool call card; return undefined for kinds you do not draw", actions: ["toggle", "page"], kind: "block", maxRows: 200 },
  "tool.row": { label: "A tool call that is not a card: the minimal row, a saved-memory note, a submitted plan, the image line", actions: [], kind: "block", maxRows: 200 },
  "compaction.card": { label: "The compaction card of a turn", actions: [], kind: "block", maxRows: 200 },
  "turn.status": { label: "A turn end, goal, usage-limit, rewind or cache note row", actions: [], kind: "block", maxRows: 200 },
  approval: { label: "The approval prompt above the input; the terminal draws the options (place them with a {options} row)", actions: [], hostOptions: true, kind: "chrome", maxRows: 40 },
  question: { label: "The question prompt above the input; the terminal draws the options (place them with a {options} row)", actions: [], hostOptions: true, kind: "chrome", maxRows: 40 },
  "prompt.frame": { label: "The rules or box around the input", actions: [], kind: "chrome", maxRows: 3 },
  topbar: { label: "The session top bar", actions: [], kind: "chrome", maxRows: 3 },
  "sessions.sidebar": { label: "The left session list", actions: ["open"], arg: "sessionId", kind: "chrome", maxRows: 200 },
  notice: { label: "Toasts, the usage-limit bar and the queue rows", actions: ["send", "resume", "schedule", "cancel", "snooze", "dismiss"], kind: "chrome", maxRows: 12 },
  footer: { label: "The row under the input", actions: [], kind: "chrome", maxRows: 4 },
  home: { label: "The new-chat home screen", actions: ["open"], arg: "session id", kind: "chrome", maxRows: 200 },
  "panel.widget": { label: "One widget body of the right panel", actions: [], kind: "chrome", maxRows: 40 },
  "file.viewer": { label: "The file viewer: the file a click on a path opened, in the right slot or as a page", actions: ["close", "switch", "open", "ask", "copy", "line", "entry"], arg: "a line number (action line) or an entry index (action entry)", kind: "chrome", maxRows: 200 },
  "slash.menu": { label: "The slash command menu", actions: ["select"], arg: "index into items", kind: "chrome", maxRows: 40 },
  "page.status": { label: "The /status page body", actions: [], kind: "page", maxRows: 200 },
  page: { label: "Any full-screen page: settings, customize, usage, sessions, agents, memory, models, mcps, help, changes...", actions: [], kind: "page", maxRows: 200 },
  overlay: { label: "The command palette and the pickers", actions: [], kind: "chrome", maxRows: 60 },
  bar: { label: "The working row, find bar, chips, vim, voice, IDE and daemon rows, shortcuts and the @ popup", actions: [], kind: "chrome", maxRows: 24 },
}

/** A row of a `hostOptions` slot's output that holds only this text is replaced by the terminal's option block; without one the block goes under the view's rows. */
export const HOST_OPTIONS_ROW = "{options}"

export const VIEW_SLOT_NAMES =Object.keys(VIEW_SLOTS) as ViewSlot[]
export const isViewSlot = (name: unknown): name is ViewSlot => typeof name === "string" && Object.hasOwn(VIEW_SLOTS, name)

/** A renderer slower than this per call counts as a strike (the first call of each view is not timed: it pays for warm-up). */
export const VIEW_BUDGET_MS = 4
/** Strikes (throw, over budget, invalid output) before the terminal stops calling a view and uses the built-in. */
export const VIEW_MAX_STRIKES = 3
