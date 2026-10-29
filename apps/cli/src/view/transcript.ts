import type { ForegroundState, Goal, ItemId, ItemKind, PermissionMode, QueueId, RenderNode, RequestId, SessionEvent, TurnId } from "@mendcode/protocol"
import { glyphs as defaultGlyphs, type Glyphs, type Line, type Span } from "../ui/theme"
import type { ToolView, TranscriptHooks } from "../extensions/hooks"
import { toolArgs, type ToolArgs } from "../extensions/tool-args"
import { errorBox, statusLine, FULL_REASONING_ROWS, type Attachment, type TurnEnd } from "./chat-blocks"
import { detailsDefaults, markdownStyleFor, renderMarkdown, wrapSpans } from "./markdown"
import { setColorOverrides } from "../ui/theme"
import { parseMarkdownColors, usageContext } from "@mendcode/protocol/wire"
import { mermaidGeneration } from "./mermaid-lazy"
import { goalCardRows, goalCardTitle, type GoalCard } from "./goal"
import { limitCardLine, limitCardRows, type LimitCard, type UsageLimitView } from "./usage-limit"
import { hasSecretMarker, maskSecretMarkers } from "./secret-markers"
import { graftTraceRender } from "./graft-map"
import { FOLD_CARD, FOLD_PAGE, FOLD_RUN, isCompactTool, isFileEdit, isFoldableTool, parseToolTitle, SPINNER_FRAMES, splitDiffAt, TOOL_PAGE_LINES, type ToolLevel } from "./tool-card"
import { countsOf, foldLabel, isReadTool } from "./tool-summary"
import { DEFAULT_IMAGE_ROOM, generatedImageCaps, IMAGE_TOOLS, imageWaitConfig, type ImageRoom } from "./image-wait"
import { callArgs, type CallArgs } from "./tool-data"
import { keyText } from "../ui/key-labels"
import { todayTimeOrDateTime } from "./time"
import { fit } from "./deck"
import { formatElapsed } from "./time"
import { DEFAULT_TUI_PROFILE, type TuiProfile } from "./tui-profile"
import { commentsOf } from "./reply-comments"
import type { MessageStyle } from "@mendcode/extension-api"
import type { AssistantMessageModel, CompactionCardModel, ReasoningModel, ToolCardModel, ToolRowModel, TurnStatusModel, UserMessageModel, ViewModels } from "@mendcode/extension-api/views"
import { plainViewHost, type ViewHost } from "./views"
import { assistantBody } from "./message-views"
import { textWidth } from "./wrap"
import { generatedImagePath, imageActionRow } from "./image-actions"
import { carryMeta, copyOf, foldOf, gutterOf, markFold, pictureOf, softWrapOf, type CopyRegion } from "./line-meta"
import { createUsageNotes, type CompactNoticeConfig, type UsageNote } from "./usage-notes"
import { modelLabel } from "./model-label"
import { compactionFacts, compactionStyle, legacyCompaction, type Compaction } from "./compaction-panel"

/** Tools whose whole result is one line worth reading collapsed (a web search's queries), instead of a line count. */
const INLINE_RESULT_TOOLS = new Set(["web_search"])
/** Tools that ask the user a question (MendCode's own, Claude Code's): their running call hides behind the question card. */
const QUESTION_TOOLS = new Set(["question", "AskUserQuestion"])

/** A collapsed card's hint: the line count, or the result itself for INLINE_RESULT_TOOLS (truncated to `room`). */
function collapsedSummary(tool: string | undefined, output: string[], room: number) {
  const count = `${output.length} line${output.length === 1 ? "" : "s"}`
  if (!INLINE_RESULT_TOOLS.has(tool ?? "") || output.length !== 1 || room < 12) return count
  const line = output[0]!.trim()
  if (textWidth(line) <= room) return line
  let out = ""
  for (const char of line) {
    if (textWidth(out + char) > room - 1) break
    out += char
  }
  return `${out}…`
}

export type Block = {
  itemId: ItemId
  turnId: TurnId
  /** `status` is the synthetic end-of-turn block (completion line, error box); it has no item behind it. */
  kind: ItemKind | "status"
  text: string
  title?: string
  status?: "running" | "ok" | "error" | "cancelled" | "interrupted" | "unknown"
  images?: number
  /** The search pattern of a finished grep or glob call (from the call's arguments), for its one-line card. */
  pattern?: string
  /** The call arguments a card draws from (a sub-agent's agent and model), picked from the call's JSON. */
  args?: CallArgs
  /** The call's whole arguments for tool renderers of extensions, parsed once when it finished. */
  input?: ToolArgs
  /** Attached files (name when the client sent one, mime), for the user message's chips. */
  attachments?: Attachment[]
  /** A system notice queued as a message (a background task ended), not something the user typed. */
  notice?: true
  /** A tool's declared presentation (renderSpec@1), drawn by rich views instead of its text. */
  render?: RenderNode
  /** A tool call the engine made for the agent (the code-map orientation), not one the model asked for. */
  injected?: true
  /** The user's own `!command`: a user message whose text is the raw command. */
  shell?: true
  /** With `shell`: `!!command`, kept out of what the model reads. */
  local?: true
  /** Small facts the tool reported on completion (a shell's `exitCode`/`durationMs`, a task's `toolCalls`). */
  meta?: Record<string, string | number | boolean>
  /** When the item started and completed (ms since epoch, from the events' `at`). */
  at?: number
  endAt?: number
  /** How the turn ended, for `status` blocks. */
  end?: TurnEnd
  /** On the synthetic marker that stands for a run of undone turns: how many messages were undone. */
  undone?: number
  /** On the synthetic card a goal event leaves (docs/goals.md): what changed and the goal as it was then. */
  goal?: GoalCard
  /** On the synthetic card a usage limit leaves when it pauses a turn or the turn resumes (docs/usage-limit.md). */
  limit?: LimitCard
  /** On the synthetic line a usage event leaves (cache miss, thinking left off, what a compaction cost); drawn only when the `cacheNotices` setting is on. */
  note?: UsageNote
}

/** `spans` carry style; `text` is the same content as plain text (tests, search, width). */
/** `gutter`: leading cells that are chrome (inset, lead glyph); `soft`: the row only continues a wrapped line (see `line-meta`). */
export type ViewLine = { text: string; spans: Line; kind: ItemKind | "gap" | "status"; itemId?: ItemId; row?: number; gutter?: number; soft?: "space" | "none"; fold?: number; /** `copy` buttons drawn in the row (code, table, list, quote and diagram headers). */ copy?: readonly CopyRegion[]; image?: ImageRow }

/** One of the rows an inline image takes: which attachment, its cells, and where it starts (column) and which row of it this is. */
/** The picture index of a chart starts here, past any attachment's. */
const CHART_INDEX = 10_000

/** `row` with the cells `[from, from + count)` replaced by blanks without a colour; the cells before and after keep their spans. */
function blankCells(row: Line, from: number, count: number): Line {
  const [before, after]: [Line, Line] = [[], []]
  let at = 0
  for (const span of row) {
    let [head, tail] = ["", ""]
    for (const char of span.text) {
      const size = textWidth(char)
      if (at + size <= from) head += char
      else if (at >= from + count) tail += char
      at += size
    }
    if (head) before.push({ ...span, text: head })
    if (tail) after.push({ ...span, text: tail })
  }
  return [...before, { text: " ".repeat(count) }, ...after]
}

/**
 * A sub-agent an engine reports inside its own session (Claude Code's Agent tool; packages/engine-claude/src/protocol.ts): the call
 * is a tool item of the conversation, and what the sub-agent does is a transcript of its own that the chat can show in its place.
 */
export type AgentThread = {
  /** The item of the call in the parent conversation. */
  itemId: ItemId
  description: string
  agent: string
  background: boolean
  running: boolean
  status: "running" | "ok" | "error" | "interrupted" | "cancelled"
  /** Stopped by the user's esc and not yet followed by another turn: it is shown as stopped, to be started again (`/relaunch`). */
  stoppedByUser?: true
  startedAt: number | undefined
  endedAt: number | undefined
  /** Tools it has called, the title of the latest, and the tokens it used once it has ended. */
  tools: number
  last: string | undefined
  tokens: number | undefined
  /** The model it runs on, when its engine says (Claude Code's sub-agents do). */
  model?: string
}
type ThreadState = { transcript: { apply(event: SessionEvent): void; prepend(events: readonly SessionEvent[]): void; setMode(next: PresentationMode): void; setAppearance(next: Partial<TuiProfile> & { reasoning: string; toolOutput: string }): void }; tools: number; last?: string; model?: string; ended?: { status: "ok" | "error" | "interrupted" | "cancelled"; at: number; tools: number; tokens: number; durationMs: number; byUser?: true } }

export type ImageRow = { sha256: string; index: number; row: number; rows: number; cols: number; col: number }

/**
 * The transcript's view of the inline images (ui/app/image-cards.ts). `slot` answers with the cells an attachment takes within
 * `maxCols` columns, or undefined while it is not shown (not loaded yet, unsupported, images off); `generation` changes whenever
 * any answer may differ, so cached layouts follow.
 */
export type TranscriptImages = {
  generation(): number
  /** Whether charts are painted as pictures now (the same condition as for attachments). */
  charts?(): boolean
  /** With `maxRows` the caller has set both bounds (a generated picture); without, the inline images' own bounds apply too. */
  slot(sha256: string, maxCols: number, maxRows?: number): { cols: number; rows: number } | undefined
}

/**
 * A finished block's rows at one layout (`key`). The rows go when the block falls out of `ROWS_CACHE_BLOCKS`; the count stays.
 * A reasoning block also keeps the layout before (`other`): its cap follows the viewport's height, and one frame can ask for two
 * heights (the sticky prompt takes a row), so without it every reasoning block was laid out twice per frame.
 */
type Cached = { key: string; count: number; lines: ViewLine[] | undefined; other?: Cached }

/**
 * Blocks whose laid-out rows stay in memory (most recently drawn first to keep). Scrolling up through a long history lays
 * out every block it passes; without a bound the rows of all of them stay (about 5 KB of heap per message, 50 MB after
 * a 10,000 message scroll). An older block keeps only its row count and is laid out again when it comes into view.
 */
export const ROWS_CACHE_BLOCKS = 600

const TOOL_TAIL_LINES = 4
const INDENT = "  "
/** Columns of padding on both sides of the session column in balanced and full (v1's container `paddingLeft/Right 2`). */
const GUTTER = 2
/** Completed one-line tool rows kept visible in a run; older ones fold into `◇ N tools more` (v1 group.ts). */
const COLLAPSE_AFTER = 5
/** In `balanced`, this many finished reading calls in a row (one turn) fold into one row (`Read 5 files · List 2 · Grep 3`). */
const READ_RUN_MIN = 3

/** A run of finished reading calls drawn as one row: its first call stands for it, the others draw nothing until it is opened. */
type ReadRun = { leader: ItemId; ids: ItemId[]; label: string }
/** How little of a tool card the full view shows: one row (`line`) or a short preview capped by kind (`brief`). */
type ToolDensity = "line" | "brief"
/** Calls whose card is a plan, a question or a lookup the reader acts on: the full view's density leaves them as they are. */
const DENSITY_EXEMPT = new Set(["todo", "question", "plan_submit", "remember", "session_search", "session_read", "session_notes", "computer_capture", "computer_key", "computer_session", "computer_observe", "computer_code"])
const DEFAULT_REASONING_ROWS = 7
/**
 * Blocks laid out at first: the newest ones. Already loaded older blocks are laid out when the reader reaches
 * the window's top (`loadOlder`); the app fetches another event page once all loaded blocks are laid out.
 */
export const WINDOW_BLOCKS = 400
/** Blocks added to the window each time the reader reaches its top. */
export const WINDOW_STEP = 200

/** v1's reasoning body height: clamp(floor(viewport × 0.32), 4, 14) rows. */
function reasoningRowsFor(height: number) {
  return Math.min(14, Math.max(4, Math.floor(height * 0.32)))
}

/**
 * How much of a turn the transcript shows. Minimal: messages, one summary line per run of tools,
 * no reasoning. Balanced: tool cards with a live tail, reasoning as a one-line summary. Full: tool
 * output and reasoning expanded (reasoning bounded to FULL_REASONING_LINES).
 */
export type PresentationMode = "minimal" | "balanced" | "full"
export const PRESENTATION_MODES: readonly PresentationMode[] = ["minimal", "balanced", "full"]

/**
 * Client-side projection of one session's events. Pure data: no timers, no IO, no renderer.
 * Finished blocks are wrapped once per width and cached; only the live block is re-wrapped,
 * and the viewport reads just the visible slice (the fix for the O(n)-per-token redraw, FC-35).
 */
export function createTranscript(options: { appearance?: Partial<TuiProfile>; /** The full tier: what the sub-agent of a `task` call runs on, by its session id or, while it runs, by what it was asked. */ subagentRun?: (ref: { taskId?: string; description: string }) => Span[] | undefined; glyphs?: Glyphs; mode?: PresentationMode; frame?: () => number; /** False while motion is reduced (setting, env or screen-reader mode): animated cards hold their first frame. */ motion?: () => boolean; now?: () => number; agent?: () => string; hooks?: TranscriptHooks; views?: ViewHost; secretTail?: (n: number) => string | undefined; images?: TranscriptImages; /** How a model id is shown on a turn's end line and a sub-agent card; the app passes the catalog's names, the default prettifies the id. */ modelLabel?: (id: string) => string; /** The notice before a compaction (usage-notes.ts); absent or returning undefined, none is said. */ compactNotice?: () => CompactNoticeConfig | undefined; /** What the terminal gives a generated picture (its rows and cell size): the wait canvas and the finished picture share that box. */ imageRoom?: () => ImageRoom; /** Whether the daemon still runs the session's background item named `description` (a background sub-agent outlives its turn). */ backgroundRunning?: (description: string) => boolean; /** Whether an edit's diff is drawn split; absent, `diffView` decides by the transcript's width. A preview narrower than the chat it shows decides by the chat's. */ splitDiff?: (width: number) => boolean } = {}) {
  const g = options.glyphs ?? defaultGlyphs()
  const shownModel = options.modelLabel ?? ((id: string) => modelLabel(id))
  const images = options.images
  const secretTail = options.secretTail
  /** A block with its `‹secret:N›` markers drawn as `‹secret ··<tail>›` (docs/secrets.md); the block itself keeps the marker. */
  const withSecretTails = (block: Block): Block => {
    if (!secretTail || !(hasSecretMarker(block.text) || (block.title !== undefined && hasSecretMarker(block.title)))) return block
    return { ...block, text: maskSecretMarkers(block.text, secretTail), ...(block.title !== undefined ? { title: maskSecretMarkers(block.title, secretTail) } : {}) }
  }
  /** Terminal extensions' markdown transforms and tool renderers; absent without extensions. */
  const hooks = options.hooks
  /** Custom views and the built-in renderers of the message and tool-card slots (docs/views.md). */
  const views = options.views ?? plainViewHost(g)
  /** Spinner frame for running tool cards (advanced by the app's pulse while a turn runs). */
  const frame = options.frame ?? (() => 0)
  const now = options.now ?? Date.now
  const imageRoom = options.imageRoom ?? (() => DEFAULT_IMAGE_ROOM)
  const roomKey = () => {
    const room = imageRoom()
    return `${room.rows}x${room.cell.width}x${room.cell.height}`
  }
  /** A finished image tool's picture: drawn in the box of its wait canvas rather than the inline images' default bounds. */
  const generatedPicture = (block: Block) => block.kind === "tool_call" && IMAGE_TOOLS.has(parseToolTitle(block.title).name)
  let mode: PresentationMode = options.mode ?? "balanced"
  let toolsExpanded = mode === "full"
  /** ctrl+o: every tool card shows a page of its whole body (and reading calls stop folding). Independent of the view. */
  let toolsOpenAll = false
  /** Cards the reader opened (true) or closed (false) one by one; absent follows the view and ctrl+o. */
  const toolOpen = new Map<ItemId, boolean>()
  /** The page of an opened card, from 0. */
  const toolPage = new Map<ItemId, number>()
  /** Folded runs of reading calls the reader opened, by the id of the run's first call. */
  const openRuns = new Set<ItemId>()
  /** What an open find bar opened to show its hits (see `revealFind`): cards with the state they had, and runs. */
  const revealedCards = new Map<ItemId, boolean | undefined>()
  const revealedRuns = new Set<ItemId>()
  let reasoningVisibility: TuiProfile["reasoning"] = "auto"
  let toolOutput: TuiProfile["toolOutput"] = "auto"
  /** True once `setAppearance` ran: a thread created later gets the same appearance. */
  let appearanceChanged = false
  let doneSymbol = g.done
  /** Items opened one by one (a long user message, a compaction summary). */
  const openItems = new Set<ItemId>()
  /** Expanded or collapsed `<details>` blocks of a message, one entry per block (`itemId#ordinal`); absent means the block's own default. */
  const detailsState = new Map<string, boolean>()
  const compactionUpdates = new Map<TurnId, Extract<SessionEvent, { type: "compaction.updated" }>>()
  /** What the transcript shows: the log's blocks without undone turns, with one marker line where a run of them was. */
  const blocks: Block[] = []
  /** Every block of the log in order, undone turns included (their events stay in the log; `turn.restored` brings them back). */
  const all: Block[] = []
  const byItem = new Map<ItemId, Block>()
  const undoneTurns = new Set<TurnId>()
  const deletedItems = new Set<ItemId>()
  /** Position of each visible block in `blocks`. */
  const index = new Map<ItemId, number>()
  /** Blocks added to the layout window above its default size, by scrolling up. */
  let conceal = true
  let appearance = { ...DEFAULT_TUI_PROFILE, ...options.appearance }
  let renderer = appearance.messageRenderer
  let timestamps = appearance.timestamps
  let username = appearance.showUsername ? appearance.username : ""
  /** How assistant Markdown is drawn in the current view: the `full` renderer's engine, calmer in balanced, plain in minimal. */
  const markdownStyle = () => markdownStyleFor({ profile: appearance, mode })
  if (options.appearance?.markdownColors) setColorOverrides(parseMarkdownColors(appearance.markdownColors).colors)
  let olderLoaded = 0
  let countsFirst = 0
  let countsGeneration = 0
  const cache = new Map<ItemId, Cached>()
  /** Blocks holding rows in `cache`, least recently used first. */
  const retained = new Set<ItemId>()
  const continuitySnapshot = new Map<string, import("@mendcode/protocol").ContinuitySummary>()
  const asyncRequests = new Map<RequestId, Extract<SessionEvent, { type: "server.request" }>>()
  const resolvedRequests = new Set<RequestId>()
  const continuity = new Map<string, import("@mendcode/protocol").ContinuitySummary>()
  const requests = new Map<RequestId, { kind: "approval" | "question"; title: string; detail: string; itemId?: ItemId }>()
  /** Per turn: when it started and the tokens its model calls used, for the completion line. */
  const turns = new Map<TurnId, { startedAt: number | undefined; model: string | undefined; input: number; output: number; reasoning: number; usage: boolean; items: number; agent?: string; shell?: true; /** Model calls, the prompt tokens read from the cache, and the cost while every call had a price (null once one did not). */ calls?: number; cacheRead?: number; costMicros?: number | null }>()
  /** Rows of a reasoning body, from the last viewport height. */
  let reasoningRows = DEFAULT_REASONING_ROWS
  /** itemId → hidden tool rows this block stands for (0: draws nothing); rebuilt when blocks change. */
  let collapsed: Map<ItemId, number> | undefined
  /** itemId → the folded run of reading calls it belongs to; rebuilt when blocks change. */
  let readRuns: Map<ItemId, ReadRun> | undefined
  /** itemId → how little of a tool card the full view's `toolDensity` shows (absent: the level decides); rebuilt when blocks change. */
  let densities: Map<ItemId, ToolDensity> | undefined
  let queue: Array<{ queueId: QueueId; preview: string; delivery?: "queue" | "steer" | "restart"; /** A system notice (a background task ended), not something the user typed. */ notice?: true }> = []
  let foreground: ForegroundState = "idle"
  let permissionMode: PermissionMode = "ask"
  /** The session's last model call: its model and the context it used (input + cache read + output tokens). */
  let lastUsage: { provider: string; model: string; contextTokens: number | undefined; /** When the provider received the call: its prompt cache's lifetime counts from here. */ callAt?: number; /** The window the engine states, when it manages its own context. */ contextWindow?: number; /** The engine's figures disagreed and the tokens were clamped to the window. */ contextApprox?: boolean; /** Where MendCode packs this session, as the engine said with that call. */ compactAt?: number } | undefined
  const usageNotes = createUsageNotes(options.compactNotice ? { notice: options.compactNotice } : {})
  /** When the latest turn started and, once it ended, when (the activity card's run time). */
  let turnClock: { startedAt: number; endedAt?: number } | undefined
  let activeTurn: TurnId | undefined
  /** When the latest of the ended turns started: a sub-agent the user stopped before it stays in sight (`stoppedByUser`). */
  let settledStart = 0
  /** The session's goal as the last `goal.changed` left it; undefined before one and after `/goal clear`. */
  let goal: Goal | undefined
  /** The session's open usage-limit pause as the last `usage.limit` left it; undefined when nothing is paused. */
  let usageLimit: UsageLimitView | undefined
  let lastSeq = 0
  let totalLinesWidth = 0
  let lineCounts: number[] = []
  /** Blocks a delta grew since the last count, other than the last block. */
  const grown = new Set<ItemId>()
  /** Loaded history only, with one accumulated delta per item. Prepend can join pages cut inside a turn or item. */
  const history = new Map<number, SessionEvent>()
  const deltaSeqs = new Map<ItemId, number>()
  let firstSeq: number | undefined

  function remember(event: SessionEvent) {
    switch (event.type) {
      case "item.delta": {
        const previousSeq = deltaSeqs.get(event.itemId)
        const previous = previousSeq === undefined ? undefined : history.get(previousSeq)
        if (previousSeq !== undefined) history.delete(previousSeq)
        history.set(event.seq, { ...event, text: byItem.get(event.itemId)?.text ?? (previous?.type === "item.delta" ? previous.text : "") + event.text })
        deltaSeqs.set(event.itemId, event.seq)
        return
      }
      case "item.completed": {
        const block = byItem.get(event.itemId)
        const deltaSeq = deltaSeqs.get(event.itemId)
        if (block && deltaSeq !== undefined) history.delete(deltaSeq)
        if (block) deltaSeqs.delete(event.itemId)
        history.set(event.seq, block ? { ...event, text: block.text } : event)
        return
      }
      case "turn.started":
      case "item.started":
      case "turn.reverted":
      case "turn.restored":
      case "message.revised":
      case "turn.completed":
      case "turn.cancelled":
      case "turn.interrupted":
      case "turn.failed":
      case "foreground.state":
      case "usage.recorded":
      case "session.permission":
      case "goal.changed":
      case "usage.limit":
      case "limit.checkpoint":
      case "queue.changed":
      case "server.request":
      case "server.request.resolved":
      case "continuity.updated":
      case "compaction.updated":
        history.set(event.seq, event)
    }
  }

  /** Counts every change to what the rows say (an event, older history, a new look); find compares it to know its hits are stale. */
  let revision = 0
  function invalidateCounts() {
    revision++
    totalLinesWidth = 0
    collapsed = undefined
    readRuns = undefined
    densities = undefined
  }

  /** Index in `blocks` of the first laid-out block: everything before it waits for `loadOlder`. */
  const firstShown = () => Math.max(0, blocks.length - WINDOW_BLOCKS - olderLoaded)

  /** A log block joins the list; one of an undone turn is kept but not shown. */
  function add(block: Block) {
    all.push(block)
    byItem.set(block.itemId, block)
    if (undoneTurns.has(block.turnId) || deletedItems.has(block.itemId)) return
    index.set(block.itemId, blocks.length)
    blocks.push(block)
  }

  /** What `usage.recorded` and `compaction.updated` leave behind: one muted line each, shown only while the matching setting is on. */
  function addNotes(event: { seq: number; turnId: TurnId; at: number }, notes: readonly UsageNote[]) {
    notes.forEach((note, i) => add({ itemId: `note:${event.seq}:${i}` as ItemId, turnId: event.turnId, kind: "status", text: "", status: "ok", at: event.at, note }))
    if (notes.length) invalidateCounts()
  }

  /** The undone turns changed: the visible list is rebuilt from the log's blocks, a marker standing in each run of undone turns. */
  function rebuild() {
    blocks.length = 0
    index.clear()
    cache.clear()
    let marker: Block | undefined
    let runMessages = 0
    let runTurns = new Set<TurnId>()
    for (const block of all) {
      if (deletedItems.has(block.itemId)) continue
      if (undoneTurns.has(block.turnId)) {
        if (!marker) {
          marker = { itemId: `undone:${block.turnId}` as ItemId, turnId: block.turnId, kind: "status", text: "", status: "ok", undone: 1, ...(block.at !== undefined ? { at: block.at } : {}) }
          index.set(marker.itemId, blocks.length)
          blocks.push(marker)
          runMessages = 0
          runTurns = new Set()
        }
        runTurns.add(block.turnId)
        if (block.kind === "user_message" && !block.notice) runMessages++
        marker.undone = Math.max(1, runMessages || runTurns.size)
        continue
      }
      marker = undefined
      index.set(block.itemId, blocks.length)
      blocks.push(block)
    }
    invalidateCounts()
  }

  /** ctrl+o in balanced opens every fold (tool rows, long messages); full starts with tool details open and messages folded. */
  const detailsOpen = () => toolsExpanded && mode !== "full"
  /** ctrl+o opens the quotes of a sent set of comments in every view (docs/editor.md); the other long messages follow `detailsOpen`. */
  const commentsOpen = (block: Block) => toolsOpenAll && block.kind === "user_message" && appearance.commentFolded && block.text.includes("<mendcode_comments")
  /** Ctrl+O opens every collapsible `<details>` block along with the tool output. */
  const detailsAllOpen = () => toolsExpanded

  /**
   * Runs of completed one-line tool rows longer than COLLAPSE_AFTER: the oldest fold into one `◇ N tools more` line. A call
   * that may change files (an edit, a write, any engine's command) ends a run and never folds, in any view.
   */
  function collapsePlan() {
    if (collapsed) return collapsed
    const plan = new Map<ItemId, number>()
    collapsed = plan
    // While a question waits, the running call that asked it draws no row: the question card stands for it (it shows once answered).
    if ([...requests.values()].some((request) => request.kind === "question"))
      for (const block of blocks) if (block.kind === "tool_call" && block.status === "running" && QUESTION_TOOLS.has(parseToolTitle(block.title).name)) plan.set(block.itemId, 0)
    if (mode === "minimal" || detailsOpen() || toolsOpenAll || toolOutput === "expanded") return plan
    const folded = readRunPlan()
    let run: Block[] = []
    const flush = () => {
      const done = run.filter((block) => block.status === "ok")
      const extra = done.length - COLLAPSE_AFTER
      if (extra > 0) done.slice(0, extra).forEach((block, at) => plan.set(block.itemId, at === 0 ? extra : 0))
      run = []
    }
    for (const block of blocks) {
      if (block.kind === "tool_call" && block.meta?.memorySaved !== true && isFoldableTool(block.title) && !folded.has(block.itemId)) run.push(block)
      else flush()
    }
    flush()
    return plan
  }

  /**
   * How much of each tool card the full view's `toolDensity` shows. `dense` (and any other view, `toolOutput` setting or ctrl+o)
   * leaves the plan empty: the level decides, as it always did. `standard` gives every call a short preview capped by kind. `calm`
   * keeps that preview for the calls that are still news (running, waiting for approval, failed, or the latest in the session) and
   * draws every other finished call as one row. A call never changes its own height when it finishes: an earlier one folds to its
   * row when the next call is added, which is the existing settle point of the tool runs.
   */
  function densityPlan() {
    if (densities) return densities
    const plan = new Map<ItemId, ToolDensity>()
    densities = plan
    const setting = appearance.toolDensity
    if (mode !== "full" || setting === "dense" || toolOutput !== "auto" || toolsOpenAll) return plan
    const cards = blocks.filter((block) => block.kind === "tool_call" && block.meta?.memorySaved !== true && !DENSITY_EXEMPT.has(parseToolTitle(block.title).name) && !isOrientation(block) && block.title !== "plan_submit")
    const latest = cards.at(-1)?.itemId
    for (const block of cards) {
      // A call that changed a file keeps its whole preview at every density: what was written is never folded to a row.
      if (isFileEdit(block.title)) continue
      const news = block.status !== "ok" && block.status !== "cancelled" || block.itemId === latest || isAwaiting(block.itemId)
      plan.set(block.itemId, setting === "calm" && !news ? "line" : "brief")
    }
    return plan
  }

  /**
   * In `balanced`, runs of three or more finished reading calls of one turn (read, ls, glob, grep; reasoning between them does
   * not break a run) fold into one row. A failed, running or approval-pending call ends a run: it always shows. In the full view's
   * `calm` density the calls already kept to one row fold the same way, with the counts spelled (`Grep 3 patterns`).
   */
  function readRunPlan() {
    if (readRuns) return readRuns
    const plan = new Map<ItemId, ReadRun>()
    readRuns = plan
    const calm = mode === "full" && appearance.toolDensity === "calm"
    if ((mode !== "balanced" && !calm) || toolOutput === "expanded" || (toolOutput === "auto" && toolsOpenAll)) return plan
    const rows = calm ? densityPlan() : undefined
    let run: Block[] = []
    const flush = () => {
      if (run.length >= READ_RUN_MIN) {
        const info: ReadRun = { leader: run[0]!.itemId, ids: run.map((block) => block.itemId), label: foldLabel(run.map((block) => parseToolTitle(block.title).name), calm) }
        for (const block of run) plan.set(block.itemId, info)
      }
      run = []
    }
    for (const block of blocks) {
      if (block.kind === "reasoning") continue
      const reading = block.kind === "tool_call" && block.status === "ok" && block.meta?.memorySaved !== true && isReadTool(parseToolTitle(block.title).name) && !isAwaiting(block.itemId) && (!rows || rows.get(block.itemId) === "line")
      if (!reading) flush()
      else {
        if (run.length && run[0]!.turnId !== block.turnId) flush()
        run.push(block)
      }
    }
    flush()
    return plan
  }

  /** How much of a tool's card shows: a card the reader opened or closed keeps that; else ctrl+o, the `toolOutput` setting and the view decide. */
  function levelOf(block: Block): ToolLevel {
    const own = toolOpen.get(block.itemId)
    if (own) return "full"
    if (own === undefined && toolOutput === "auto" && toolsOpenAll) return "full"
    if (toolOutput === "collapsed") return "summary"
    // Outside `minimal`, a call that changed a file shows its diff or content as the full view does.
    return toolOutput === "expanded" || mode === "full" || (mode === "balanced" && isFileEdit(block.title)) ? "preview" : "summary"
  }

  /** The engine's own code map (a `graph_map` the agent ran for orientation, not one the model asked for): one folded row or, opened, the card. */
  const isOrientation = (block: Block) => block.injected === true && block.status === "ok" && parseToolTitle(block.title).name === "graph_map" && typeof block.meta?.files === "number"

  /**
   * Whether the engine's code map draws as its card. A card the reader opened or closed keeps that; else ctrl+o opens it; else `codeMapCard`
   * decides (`auto`: open in the full view, one row in balanced). The minimal view keeps the row unless the reader opens it.
   */
  function mapOpen(block: Block) {
    const own = toolOpen.get(block.itemId)
    if (own !== undefined) return own
    if (levelOf(block) === "full") return true
    const setting = appearance.codeMapCard
    return mode !== "minimal" && (setting === "open" || (setting === "auto" && mode === "full"))
  }

  /** A click (or ctrl+x f) on a tool card's rows: open or close the card, turn to its next page, or open or close the folded run it leads. */
  function toggleTool(block: Block, fold: number) {
    const id = block.itemId
    if (fold === FOLD_RUN) {
      if (!openRuns.delete(id)) openRuns.add(id)
    } else if (fold === FOLD_PAGE) {
      toolPage.set(id, (toolPage.get(id) ?? 0) + 1)
    } else {
      const open = isOrientation(block) ? mapOpen(block) : levelOf(block) === "full"
      toolOpen.set(id, !open)
      toolPage.delete(id)
    }
    cache.delete(id)
    invalidateCounts()
  }

  /** The row a folded run of reading calls draws: `◇ Read 5 files · List 2 · Grep 3`; clicking it (or ctrl+x f) opens or closes the run. */
  function readRunRow(run: ReadRun, width: number): Line {
    const open = openRuns.has(run.leader)
    const row = wrapSpans([{ text: run.label, fg: "muted" }], width, [{ text: `${" ".repeat(GUTTER)}${INDENT} ${open ? g.tool : g.collapsed} `, fg: "muted" }])[0]!
    markFold(row, FOLD_RUN)
    return row
  }

  const isAwaiting = (itemId: ItemId) => [...requests.values()].some((request) => request.itemId === itemId)

  /** A tool that produced images (image generation) shows an image line, with the file path when its card text ends in one. */
  function styled(block: Block, width: number): Line[] {
    // v1's session column is padded by two: balanced and full inset everything so its panels start at column 3 and its tool rows at 5.
    const inset = mode === "minimal" ? 0 : GUTTER
    const lines = styledBody(block, width - inset)
    const under = block.kind === "tool_call" ? agentRow(block) : undefined
    if (under) lines.push(fit(under, width - inset))
    if (block.kind === "tool_call") foldWholeCard(block, lines)
    const rows = block.kind !== "tool_call" || !block.images ? lines : [...lines, ...imageRows(block, width - inset)]
    return inset ? rows.map((row) => (row.length ? carryMeta(row, [{ text: " ".repeat(inset) }, ...row], inset) : row)) : rows
  }

  /**
   * Every row of a tool card answers a click, not only its header: an opened card closes from any of its rows (its header can be
   * scrolled off), and a card with a header to open from opens from its body rows too. Rows that turn the page keep that.
   */
  function foldWholeCard(block: Block, lines: Line[]) {
    if (levelOf(block) !== "full" && !lines.some((row) => foldOf(row) === FOLD_CARD)) return
    for (const row of lines) if (foldOf(row) === undefined && row.some((span) => span.text.trim())) markFold(row, FOLD_CARD)
  }

  /** The image line under a tool that made pictures, through the `tool.row` slot. */
  function imageRows(block: Block, width: number): Line[] {
    const model = toolRowModel(block, "images")
    const id = `${block.itemId}:images`
    return views.custom("tool.row", model, { width, height: BLOCK_ROWS, id, memo: "static" })?.lines ?? views.builtin("tool.row", model, { width, height: BLOCK_ROWS }).lines
  }

  /** The file path an image tool's card text ends in, as ` · /path`. */
  function imageWhere(block: Block) {
    const last = block.text.trimEnd().split("\n").at(-1) ?? ""
    return last.startsWith("/") ? ` · ${last}` : ""
  }

  function roleStyle(role: "user" | "assistant"): MessageStyle {
    // `assistantName` is the assistant's label text: set, it shows whatever `assistantLabel` says.
    const label = role === "assistant" && appearance.assistantName ? appearance.assistantName : appearance[`${role}Label`] || role === "user" && appearance.showUsername
    return { layout: appearance.messageLayout, icon: appearance[`${role}Icon`], label, lead: appearance[`${role}Lead`], tint: role === "user" && appearance.userTint, ...hooks?.messageStyle?.(role) }
  }

  /** A role's chrome as the view models carry it: the label already resolved to text, the rest defaulted. */
  function styleOf(role: "user" | "assistant"): UserMessageModel["style"] {
    const style = roleStyle(role)
    const label = typeof style.label === "string" ? style.label : style.label ? (role === "user" ? username || "You" : "Assistant") : ""
    return { layout: style.layout ?? "quiet", icon: style.icon ?? "", lead: style.lead ?? "", label, tint: style.tint === true }
  }

  const BLOCK_ROWS = 200
  const timeOf = (block: Block) => (timestamps ? todayTimeOrDateTime(block.at ?? 0, now()) : "")

  /** The view slot a block draws through, when it has one. Minimal tool rows, saved memories and submitted plans are not cards. */
  function slotOf(block: Block): keyof ViewModels | undefined {
    if (block.kind === "user_message") return "message.user"
    if (block.kind === "agent_message") return "message.assistant"
    if (block.kind === "reasoning") return "message.reasoning"
    if (block.kind === "tool_call") return toolRowVariant(block) ? "tool.row" : "tool.card"
    // An after-turn extractor's save is an artifact block with the same memory row.
    if (block.kind === "artifact" && block.meta?.memorySaved === true && block.status === "ok") return "tool.row"
    if (block.kind === "compaction") return blocks.findLast((entry) => entry.kind === "compaction" && entry.turnId === block.turnId)?.itemId === block.itemId ? "compaction.card" : undefined
    if (block.kind === "status") return statusVariant(block) ? "turn.status" : undefined
    return undefined
  }

  /** Which of the non-card tool rows a tool call is drawn as, if any. */
  function toolRowVariant(block: Block): ToolRowModel["variant"] | undefined {
    if (block.meta?.memorySaved === true && block.status === "ok") return "memory"
    // The engine's own orientation lookup stays one row until the reader opens it; a `graph_map` the model called keeps its card.
    if (isOrientation(block) && !mapOpen(block)) return "orientation"
    // A submitted plan is content to read, not tool output: always shown in full as markdown.
    if (block.title === "plan_submit" && block.text.trim()) return "plan"
    // An image being generated keeps its wait canvas in every view, as in v1; it becomes a row again once it is done.
    if (block.status === "running" && IMAGE_TOOLS.has(parseToolTitle(block.title).name)) return undefined
    return mode === "minimal" ? "minimal" : undefined
  }

  /** Which turn-status row a status block is. */
  function statusVariant(block: Block): TurnStatusModel["variant"] | undefined {
    if (block.meta?.limitCheckpoint) return "checkpoint"
    if (block.goal) return "goal"
    if (block.limit) return "limit"
    if (block.note) return "note"
    if (block.undone !== undefined) return "undone"
    return block.end ? "end" : undefined
  }

  type Modelled = { slot: keyof ViewModels; model: ViewModels[keyof ViewModels]; prepare?: (model: never) => unknown; extra?: Record<string, unknown> }

  /** The input model of a block's slot (docs/views.md): plain data, the same for the built-in and a custom view. */
  function modelOf(block: Block, width: number): Modelled | undefined {
    const slot = slotOf(block)
    const common = { itemId: block.itemId, turnId: block.turnId, text: block.text, ...(block.at !== undefined ? { at: block.at } : {}), time: timeOf(block), mode }
    if (slot === "message.user") {
      const model: UserMessageModel = {
        ...common,
        // A `!command` always shows when it ran; the other messages only with timestamps on.
        ...(block.shell && !block.notice ? { time: todayTimeOrDateTime(block.at ?? 0, now()) } : {}),
        style: styleOf("user"),
        variant: block.notice ? "notice" : block.shell ? "shell" : "message",
        ...(block.local ? { local: true } : {}),
        ...(block.attachments ? { attachments: block.attachments.map((file) => ({ ...(file.name !== undefined ? { name: file.name } : {}), ...(file.label !== undefined ? { label: file.label } : {}), mime: file.mime })) } : {}),
        images: block.images ?? 0,
        username,
        expanded: detailsOpen() || openItems.has(block.itemId) || commentsOpen(block),
        ...(appearance.commentFolded && !block.notice && !block.shell && block.text.includes("<mendcode_comments") ? commentsOf(block.text, { layout: appearance.commentSentLayout, collapse: appearance.commentCollapse }) : {}),
      }
      return { slot, model }
    }
    if (slot === "message.assistant") {
      const prefix = `${block.itemId}#`
      const details: Record<number, boolean> = {}
      for (const [key, open] of detailsState) if (key.startsWith(prefix)) details[Number(key.slice(prefix.length))] = open
      const model: AssistantMessageModel = { ...common, style: styleOf("assistant"), renderer: conceal ? renderer : "plain", details, detailsAll: detailsAllOpen(), markdown: markdownStyle() }
      // A custom view may restyle the built-in's Markdown: it gets those rows too, 4 cells narrower than `width` (room for a rail or indent).
      const prepare = (shown: AssistantMessageModel): AssistantMessageModel => ({ ...shown, body: assistantBody(shown, Math.max(1, width - 4)) })
      return { slot, model, prepare }
    }
    if (slot === "message.reasoning") {
      const ms = block.at && block.endAt ? Math.max(0, block.endAt - block.at) : undefined
      const model: ReasoningModel = {
        itemId: block.itemId,
        turnId: block.turnId,
        text: block.text,
        running: block.status === "running",
        ...(ms !== undefined ? { ms } : {}),
        rows: reasoningVisibility === "expanded" || mode === "full" ? FULL_REASONING_ROWS : reasoningRows,
        oneLine: reasoningVisibility === "collapsed" || (reasoningVisibility !== "expanded" && mode === "minimal"),
        hidden: reasoningVisibility === "hidden",
      }
      return { slot, model }
    }
    if (slot === "tool.card") {
      const output = block.text.replace(/\s+$/, "").split("\n").filter((l) => l.length > 0)
      // A tool's own spec wins; graft's trace tool (MCP, no spec) is read back from its text into a call map.
      const spec = renderer === "full" ? (block.render ?? (block.status === "ok" ? graftTraceRender(parseToolTitle(block.title).name, block.text) : undefined)) : undefined
      const level = levelOf(block)
      const { name, detail } = parseToolTitle(block.title)
      const summary = output.length ? collapsedSummary(block.title, output, width) : undefined
      const model: ToolCardModel = {
        itemId: block.itemId,
        kind: name,
        detail,
        ...(block.title !== undefined ? { title: block.title } : {}),
        status: block.status,
        text: block.text,
        ...(summary !== undefined ? { summary } : {}),
        level,
        expanded: level !== "summary",
        page: toolPage.get(block.itemId) ?? 0,
        counts: countsOf(block.meta),
        ...(block.pattern ? { pattern: block.pattern } : {}),
        // A finished tool's own timing (shell/task report `durationMs`) beats the event clock.
        ...(block.status !== "running" && typeof block.meta?.durationMs === "number"
          ? { elapsedMs: block.meta.durationMs }
          : block.at
            ? { elapsedMs: Math.max(0, (block.status === "running" ? now() : (block.endAt ?? block.at)) - block.at) }
            : {}),
        ...(typeof block.meta?.exitCode === "number" ? { exitCode: block.meta.exitCode } : {}),
        ...(typeof block.meta?.toolCalls === "number" ? { toolCalls: block.meta.toolCalls } : {}),
        ...(block.args?.agent ? { agent: block.args.agent } : {}),
        ...(block.args?.written ? { written: block.args.written } : {}),
        ...(taskRun(block) ?? (block.args?.model ? { model: shownModel(block.args.model) } : {})),
        ...(isAwaiting(block.itemId) ? { awaiting: true } : {}),
        ...(toolOutput === "collapsed" ? { compact: true } : {}),
        ...(densityPlan().has(block.itemId) ? { density: densityPlan().get(block.itemId)! } : {}),
        ...(block.meta ? { meta: block.meta } : {}),
        frame: frame(),
        tailLines: TOOL_TAIL_LINES,
        mode: mode === "full" ? "full" : "balanced",
        ...(spec ? { render: spec as unknown as Record<string, unknown>, ...(mode === "full" ? { mapDetail: "full" as const } : {}) } : {}),
      }
      const prepare = (shown: ToolCardModel): ToolCardModel => ({ ...shown, output: output.slice(0, 400) })
      // A running image tool draws the wait canvas; reduced motion holds it on its first frame.
      const imageWait = block.status === "running" && IMAGE_TOOLS.has(name) ? imageWaitConfig(appearance, options.motion?.() ?? true, imageRoom()) : undefined
      return { slot, model, prepare, extra: { ...(hooks ? { custom: (view: ToolView) => hooks.tool(block.input ? { ...view, input: block.input } : view) } : {}), ...(imageWait ? { imageWait } : {}), ...((options.splitDiff ? options.splitDiff(width) : splitDiffAt(appearance.diffView, width)) ? { splitDiff: true } : {}) } }
    }
    if (slot === "tool.row") return { slot, model: toolRowModel(block, toolRowVariant(block)!) }
    if (slot === "compaction.card") {
      const update = compactionUpdates.get(block.turnId)
      const data = { ...(update ?? legacyCompaction(block.turnId, block.text, block.status)), ...compactionFacts(block.meta), summary: block.text }
      const expanded = detailsOpen() || openItems.has(block.itemId)
      const presentation = appearance.presentation === "auto" && mode === "minimal" ? "minimal" : appearance.presentation
      const model: CompactionCardModel = {
        itemId: block.itemId, turnId: block.turnId, state: data.state, reason: data.reason, summary: data.summary, followUp: data.followUp,
        ...(data.followUpQueueId ? { followUpQueueId: data.followUpQueueId } : {}), ...(data.idle ? { idle: true as const } : {}),
        ...(data.method !== undefined ? { method: data.method } : {}), ...(data.tailTurns !== undefined ? { tailTurns: data.tailTurns } : {}), ...(data.tailTokens !== undefined ? { tailTokens: data.tailTokens } : {}), ...(data.fallbackReason !== undefined ? { fallbackReason: data.fallbackReason } : {}), ...(data.cachedPrefix ? { cachedPrefix: true as const } : {}),
        style: compactionStyle({ ...appearance, presentation }), presentation, progress: appearance.compactionProgress, scratchpad: appearance.compactionScratchpad, expanded,
      }
      const prepare = (shown: CompactionCardModel): CompactionCardModel => ({ ...shown, summaryRows: shown.expanded ? renderMarkdown(shown.summary, Math.max(1, width - 4)) : [] })
      return { slot, model, prepare }
    }
    if (slot === "turn.status") {
      const variant = statusVariant(block)!
      const model: TurnStatusModel = {
        itemId: block.itemId, variant, mode, meta: appearance.messageMeta, done: doneSymbol, ...(block.at !== undefined ? { at: block.at } : {}), time: timeOf(block),
        // The notice before a compaction follows its own feature and setting (it is only made while they are on), not the `cacheNotices` key.
        cacheNotices: appearance.cacheNotices || block.note?.kind === "context",
        ...(variant === "end" && block.end ? { end: block.end as NonNullable<TurnStatusModel["end"]> } : {}),
        ...(variant === "goal" ? { goal: block.goal as unknown as Record<string, unknown> } : {}),
        ...(variant === "limit" ? { limit: block.limit as unknown as Record<string, unknown> } : {}),
        ...(variant === "note" ? { note: block.note!.text } : {}),
        ...(variant === "undone" ? { undone: block.undone! } : {}),
      }
      return { slot, model }
    }
    return undefined
  }

  /** The model of a tool call's non-card row. `minimal` knows how many successful tools its row stands for. */
  function toolRowModel(block: Block, variant: ToolRowModel["variant"]): ToolRowModel {
    const base = { itemId: block.itemId, variant, ...(block.title !== undefined ? { title: block.title } : {}), status: block.status, text: block.text, run: 1, folded: false }
    if (variant === "images") return { ...base, images: block.images ?? 0, where: imageWhere(block) }
    if (variant === "memory") {
      const full = typeof block.meta?.memoryText === "string" ? block.meta.memoryText : ""
      return { ...base, ...(block.meta?.memoryChange === "saved" ? { hint: "/memory undo" } : {}), ...(full ? { detail: full } : {}), open: levelOf(block) === "full" }
    }
    if (variant === "orientation") {
      const count = (value: unknown, noun: string) => `${Number(value).toLocaleString("en-US")} ${noun}`
      return { ...base, text: `Code map · ${count(block.meta?.directories, "dirs")} · ${count(block.meta?.files, "files")}`, hint: keyText("click or ctrl+o to open") }
    }
    if (variant !== "minimal") return base
    const at = index.get(block.itemId) ?? -1
    const hidden = (b: Block | undefined) => b?.kind === "tool_call" && b.meta?.memorySaved !== true && b.status === "ok"
    let run = 1
    while (hidden(blocks[at - run])) run++
    // A failure is never folded away: the last line of its output says what went wrong.
    const reason = block.status !== "running" && block.status !== "ok" ? block.text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").split("\n").findLast((line) => line.trim()) : undefined
    return { ...base, run, folded: hidden(block) && blocks[at + 1]?.kind === "tool_call", ...(reason ? { reason } : {}) }
  }

  /** Rows a custom view marked clickable become the fold rows the transcript's own click handling knows. */
  function markHits(lines: Line[], hits: ReadonlyArray<{ row: number; action: string }>) {
    for (const hit of hits) {
      const row = lines[hit.row]
      if (row && (hit.action === "toggle" || hit.action === "page")) markFold(row, hit.action === "page" ? FOLD_PAGE : FOLD_CARD)
    }
  }

  function styledBody(block: Block, width: number): Line[] {
    // Thinking whose text the provider keeps (Claude Code, a Codex item without a summary) has nothing to show: the working row says "Thinking...".
    if (block.kind === "reasoning" && !block.text.trim()) return []
    const role = block.kind === "user_message" && !block.notice ? "user" : block.kind === "agent_message" ? "assistant" : block.kind === "tool_call" ? "tool" : "meta"
    // A custom view of the block's slot comes first (docs/views.md); finished blocks are memoised on their whole input.
    const slot = slotOf(block)
    if (slot && views.hasCustom(slot)) {
      const modelled = modelOf(block, width)!
      const drawn = views.custom(slot as "message.user", modelled.model as never, { width, height: BLOCK_ROWS, id: block.itemId, memo: block.status === "running" ? "none" : "static", ...(modelled.prepare ? { prepare: modelled.prepare } : {}) })
      if (drawn) {
        markHits(drawn.lines, drawn.hits)
        return drawn.lines
      }
    }
    const message = { role, text: block.text, itemId: block.itemId, turnId: block.turnId, ...(block.title !== undefined ? { title: block.title } : {}), ...(block.at !== undefined ? { at: block.at } : {}), ...(block.status !== undefined ? { status: block.status } : {}), ...(block.meta ? { meta: block.meta } : {}) } as const
    const custom = hooks?.message?.(message, width)
    if (custom) return custom
    const transformed = hooks?.markdown(block.text, message, width) ?? block.text
    if (transformed !== block.text) {
      if (role === "user") return renderMarkdown(transformed, width)
      block = { ...block, text: transformed }
    }
    const rows = defaultBody(block, width)
    if (role !== "tool" && role !== "meta") return rows
    const style = hooks?.messageStyle?.(role)
    if (!style) return rows
    const prefix = [style.icon, style.lead, typeof style.label === "string" ? style.label : style.label ? role : ""].filter(Boolean).join(" ")
    const styled = prefix ? [[{ text: prefix, fg: "primary" as const }], ...rows] : rows
    return style.tint ? styled.map((row) => fit(row, width).map((span) => ({ ...span, bg: span.bg ?? "promptBg" as const }))) : styled
  }

  /** The built-in renderer of a block's slot, through the same typed input a custom view receives. */
  function builtinRows(block: Block, width: number): Line[] {
    const modelled = modelOf(block, width)!
    return views.builtin(modelled.slot as "message.user", modelled.model as never, { width, height: BLOCK_ROWS, ...(modelled.extra ? { extra: modelled.extra } : {}) }).lines
  }

  function defaultBody(block: Block, width: number): Line[] {
    switch (block.kind) {
      case "user_message":
      case "agent_message":
      case "reasoning":
        return builtinRows(block, width)
      case "compaction":
        return slotOf(block) ? builtinRows(block, width) : []
      case "status":
        return slotOf(block) ? builtinRows(block, width) : []
      case "artifact":
        if (slotOf(block)) {
          const rows = builtinRows(block, width)
          if (rows[0]) markFold(rows[0], FOLD_CARD)
          return rows
        }
        return wrapSpans([{ text: block.text || block.title || block.kind, fg: "muted" }], width, [{ text: INDENT }])
      case "tool_call": {
        const rows = builtinRows(block, width)
        // A memory row and the collapsed code map open and close on a click, like a card.
        const variant = toolRowVariant(block)
        if ((variant === "memory" || variant === "orientation") && rows[0]) markFold(rows[0], FOLD_CARD)
        return rows
      }
      default:
        return wrapSpans([{ text: block.text || block.title || block.kind, fg: "muted" }], width, [{ text: INDENT }])
    }
  }

  /** What a block's rows depend on besides its text: the cache is valid while this key is unchanged. */
  function layoutOf(block: Block, width: number) {
    // mermaidGeneration bumps once, the moment the diagram module finishes loading, so any message
    // rendered with its "loading diagram…" placeholder is recomputed with the real diagram after that.
    const fold = block.kind === "tool_call" ? collapsePlan().get(block.itemId) : undefined
    const open = block.kind === "tool_call" ? toolsExpanded : block.kind === "user_message" || block.kind === "compaction" ? detailsOpen() || openItems.has(block.itemId) || commentsOpen(block) : block.kind === "agent_message" ? detailsAllOpen() : false
    // A tool card's rows also follow how much of it shows, its page and the folded run it may belong to.
    const run = block.kind === "tool_call" ? readRunPlan().get(block.itemId) : undefined
    const tool = block.kind === "tool_call" || block.kind === "artifact" && block.meta?.memorySaved === true ? `:${levelOf(block)}${isOrientation(block) && mapOpen(block) ? "m" : ""}${toolPage.get(block.itemId) ?? 0}:${run ? `${run.leader === block.itemId ? run.label : "m"}${openRuns.has(run.leader) ? "o" : "c"}` : "-"}${block.kind === "tool_call" ? densityPlan().get(block.itemId)?.[0] ?? "" : ""}` : ""
    const key = `${doneSymbol}:${reasoningVisibility}:${toolOutput}:${width}:${mode}:${open ? "x" : "c"}${tool}:${mermaidGeneration()}:${fold ?? "-"}:${block.kind === "reasoning" ? reasoningRows : ""}${hooks ? `:${hooks.generation()}` : ""}${images && block.attachments?.length ? `:i${images.generation()}${generatedPicture(block) ? `:r${roomKey()}` : ""}` : ""}`
    const thread = block.meta?.subagent === true ? threads.get(block.itemId) : undefined
    return { fold, key: thread ? `${key}:a${thread.tools}${thread.ended ? "e" : ""}${thread.last ?? ""}` : key }
  }

  /** Marks a block's rows as just used; the oldest ones past `ROWS_CACHE_BLOCKS` give their rows back and keep only their count. */
  function retain(itemId: ItemId) {
    retained.delete(itemId)
    retained.add(itemId)
    while (retained.size > ROWS_CACHE_BLOCKS) {
      const oldest = retained.values().next().value!
      retained.delete(oldest)
      const entry = cache.get(oldest)
      if (entry) entry.lines = undefined
      if (entry?.other) entry.other.lines = undefined
    }
  }

  /** A block's cache entry for layout `key`: a reasoning block's layout before becomes the current one again when it is asked for. */
  function cachedAt(block: Block, key: string) {
    const cached = cache.get(block.itemId)
    if (!cached?.other || cached.key === key || cached.other.key !== key) return cached
    const swapped: Cached = { ...cached.other, other: { key: cached.key, count: cached.count, lines: cached.lines } }
    cache.set(block.itemId, swapped)
    return swapped
  }

  /** Rows a block takes at `width`: from the cache without laying it out again, so scrolling a long history costs numbers, not rows. */
  function countOf(block: Block, width: number) {
    if (block.status === "running") return linesOf(block, width).length
    const { key } = layoutOf(block, width)
    const cached = cachedAt(block, key)
    return cached && cached.key === key ? cached.count : linesOf(block, width).length
  }

  function linesOf(block: Block, width: number): ViewLine[] {
    const finished = block.status !== "running"
    const { fold, key } = layoutOf(block, width)
    const cached = cachedAt(block, key)
    if (finished && cached?.key === key && cached.lines) {
      retain(block.itemId)
      return cached.lines
    }
    const run = block.kind === "tool_call" && fold === undefined ? readRunPlan().get(block.itemId) : undefined
    const closedRun = run && !openRuns.has(run.leader)
    const rows =
      fold !== undefined
        ? fold > 0 ? [[{ text: `${mode === "minimal" ? "" : " ".repeat(GUTTER)}${INDENT} ${g.collapsed} ${fold} tool${fold === 1 ? "" : "s"} more`, fg: "muted" as const }]] : []
        : closedRun
          ? run.leader === block.itemId ? [readRunRow(run, width)] : []
          : [...(run && run.leader === block.itemId ? [readRunRow(run, width)] : []), ...styled(withSecretTails(block), width)]
    while (rows.length && !rows.at(-1)!.some((span) => span.text.trim())) rows.pop()
    const kind = block.kind === "status" ? "status" : block.kind
    const lines: ViewLine[] = rows.map((spans, row) => ({ spans, text: spans.map((s) => s.text).join(""), kind, itemId: block.itemId, row, ...(gutterOf(spans) ? { gutter: gutterOf(spans) } : {}), ...(softWrapOf(spans) ? { soft: softWrapOf(spans)! } : {}), ...(foldOf(spans) !== undefined ? { fold: foldOf(spans)! } : {}), ...(copyOf(spans) ? { copy: copyOf(spans)! } : {}) }))
    // A chart the terminal can paint: its text cells are blanked and the chat view places the picture over them. Each chart of a
    // message has its own index (the row it starts at), so two equal ones are two pictures.
    if (images?.charts?.()) {
      lines.forEach((line, at) => {
        const cells = pictureOf(line.spans)
        if (!cells) return
        line.spans = blankCells(line.spans, cells.col, cells.cols)
        line.text = line.spans.map((span) => span.text).join("")
        line.image = { sha256: cells.key, index: CHART_INDEX + at - cells.row, row: cells.row, rows: cells.rows, cols: cells.cols, col: cells.col }
      })
    }
    // Each image the terminal can draw reserves its rows under the card; the chat view places the picture over them.
    if (images && fold === undefined && !closedRun && block.attachments?.length) {
      const col = (mode === "minimal" ? 0 : GUTTER) + INDENT.length
      // A generated picture takes the box its wait canvas held (image-wait.ts `generatedImageCaps`).
      const caps = generatedPicture(block) ? generatedImageCaps({ maxCols: width - col - 2, room: imageRoom(), canvas: appearance.imageWaitCanvas }) : undefined
      block.attachments.forEach((file, at) => {
        const slot = file.sha256 && file.mime.startsWith("image/") ? (caps ? images.slot(file.sha256, caps.maxCols, caps.maxRows) : images.slot(file.sha256, width - col - 2)) : undefined
        if (!slot) return
        for (let row = 0; row < slot.rows; row++) lines.push({ text: "", spans: [], kind, itemId: block.itemId, image: { sha256: file.sha256!, index: at, row, rows: slot.rows, cols: slot.cols, col } })
      })
    }
    // A finished generated picture keeps v1's buttons under it: open, folder, copy path.
    const picture = finished && block.status === "ok" && fold === undefined && !closedRun && generatedPicture(block) ? block.attachments?.find((file) => file.mime.startsWith("image/")) : undefined
    const picturePath = picture ? generatedImagePath({ ...(block.meta ? { meta: block.meta } : {}), text: block.text }) : undefined
    if (picture && picturePath) {
      const spans = imageActionRow({ path: picturePath, mime: picture.mime, ...(picture.bytes !== undefined ? { bytes: picture.bytes } : {}), col: (mode === "minimal" ? 0 : GUTTER) + INDENT.length, width })
      lines.push({ spans, text: spans.map((span) => span.text).join(""), kind, itemId: block.itemId, gutter: 1000, copy: copyOf(spans)! })
    }
    // A folded run's row is followed by what follows the run, not by the calls it hides.
    const next = blocks[(index.get(closedRun && run.leader === block.itemId ? run.ids.at(-1)! : block.itemId) ?? -2) + 1]
    // Rows of one-line tools stack tight; a block tool (shell, diff, todo) or a card with a body gets a blank row around it.
    const stacked = (a: Block | undefined) => a?.kind === "tool_call" && (mode === "minimal" || isCompactTool(a.title) || densityPlan().get(a.itemId) === "line")
    const compactPair = (stacked(block) && stacked(next) && (mode === "minimal" || lines.length === 1)) || (mode === "minimal" && block.kind === "reasoning")
    if (!compactPair && lines.length > 0 && !(next?.kind === "status" && next.end && appearance.messageMeta !== "off")) lines.push({ text: "", spans: [], kind: "gap" })
    if (finished) {
      const before = block.kind === "reasoning" ? cached : undefined
      const other = before && before.key !== key ? { key: before.key, count: before.count, lines: before.lines } : before?.other
      cache.set(block.itemId, { key, count: lines.length, lines, ...(other ? { other } : {}) })
      retain(block.itemId)
    }
    return lines
  }

  /** A turn ended: close it with v1's completion line (and the error box for a failed turn). Nothing to say → no block. */
  function finishTurn(event: { turnId: TurnId; at: number }, end: Pick<TurnEnd, "outcome" | "reason" | "error">) {
    settledStart = Math.max(settledStart, turns.get(event.turnId)?.startedAt ?? 0)
    if (byItem.has(`status:${event.turnId}` as ItemId)) return
    activeTurn = undefined
    if (turnClock && event.at > 0) turnClock = { ...turnClock, endedAt: event.at }
    const compaction = compactionUpdates.get(event.turnId)
    if (compaction?.state === "writing") {
      compactionUpdates.set(event.turnId, { ...compaction, state: end.outcome === "completed" ? "skipped" : end.outcome === "paused" ? "failed" : end.outcome })
      for (const block of blocks) if (block.kind === "compaction" && block.turnId === event.turnId) cache.delete(block.itemId)
      invalidateCounts()
    }
    const turn = turns.get(event.turnId)
    const quiet = end.outcome === "completed" && !turn?.usage
    const ms = turn?.startedAt !== undefined && event.at > 0 ? Math.max(0, event.at - turn.startedAt) : undefined
    const summary: TurnEnd = { ...end, input: turn?.input ?? 0, output: turn?.output ?? 0, reasoning: turn?.reasoning ?? 0, usage: turn?.usage ?? false, ...(turn?.calls ? { calls: turn.calls, cached: turn.cacheRead ?? 0 } : {}), ...(typeof turn?.costMicros === "number" ? { costMicros: turn.costMicros } : {}), ...(turn?.agent ? { agent: turn.agent } : {}), ...(turn?.model ? { model: shownModel(turn.model) } : {}), ...(ms !== undefined ? { ms } : {}) }
    // A `!command` turn never calls a model; its shell card already shows the duration.
    if (quiet && (ms === undefined || turn?.shell)) return
    const previous = blocks[blocks.length - 1]
    if (previous) cache.delete(previous.itemId)
    add({ itemId: `status:${event.turnId}` as ItemId, turnId: event.turnId, kind: "status", text: "", status: "ok", end: summary, at: event.at })
    invalidateCounts()
  }

  /** What a `task` call's sub-agent runs on, when the app says it (the full tier): it takes the place of the model the call named. */
  const taskRun = (block: Block): { run: Span[] } | undefined => {
    if (!options.subagentRun || block.kind !== "tool_call") return undefined
    const described = /^task:\s*(.*)$/s.exec(block.title ?? "")?.[1]?.trim()
    if (described === undefined) return undefined
    const run = options.subagentRun({ ...(typeof block.meta?.taskId === "string" ? { taskId: block.meta.taskId } : {}), description: described })
    return run?.length ? { run } : undefined
  }

  /** Sub-agent threads by the item of their call, and the thread each of their items belongs to. */
  const threads = new Map<ItemId, ThreadState>()
  const threadOf = new Map<ItemId, ItemId>()
  /** While `prepend` rebuilds: each thread's events of the replay, handed to that thread's own prepend at the end. */
  let replayed: Map<ThreadState, SessionEvent[]> | undefined

  /** An item of a sub-agent goes to its thread, not to this conversation; true when `event` was one. */
  function routeAgent(event: SessionEvent): boolean {
    if (event.type !== "item.started" && event.type !== "item.delta" && event.type !== "item.completed") return false
    const parent = event.type === "item.started" && typeof event.meta?.agentParent === "string" ? (event.meta.agentParent as ItemId) : threadOf.get(event.itemId)
    if (!parent) return false
    threadOf.set(event.itemId, parent)
    let thread = threads.get(parent)
    if (!thread) {
      // A thread opened after the view changed starts the way the conversation reads now.
      const transcript = createTranscript({ ...options, mode })
      if (appearanceChanged) transcript.setAppearance({ ...appearance, reasoning: reasoningVisibility, toolOutput })
      threads.set(parent, (thread = { transcript, tools: 0 }))
    }
    // The thread reads the item as one of its own: without the mark, which would send it to a thread of the thread.
    let own: SessionEvent = event
    if (event.type === "item.started" && event.meta) {
      const { agentParent: _parent, agentModel, ...meta } = event.meta
      if (typeof agentModel === "string") thread.model = agentModel
      own = { ...event, meta }
    }
    if (replayed) replayed.set(thread, [...(replayed.get(thread) ?? []), own])
    else thread.transcript.apply(own)
    if (event.type === "item.started" && event.kind === "tool_call") {
      thread.tools++
      if (typeof event.meta?.tool === "string") thread.last = event.meta.tool
    }
    if (event.type === "item.completed" && event.meta?.agentEnd === true) {
      const count = (value: unknown) => (typeof value === "number" ? value : 0)
      thread.ended = { status: event.status === "ok" ? "ok" : event.status === "error" ? "error" : event.status === "cancelled" ? "cancelled" : "interrupted", at: event.at, tools: count(event.meta.toolCalls) || thread.tools, tokens: count(event.meta.tokens), durationMs: count(event.meta.durationMs), ...(event.meta.stoppedBy === "user" ? { byUser: true as const } : {}) }
    }
    cache.delete(parent)
    invalidateCounts()
    return true
  }

  function agentThread(block: Block): AgentThread {
    const thread = threads.get(block.itemId)
    const background = block.meta?.background === true
    const description = (block.title ?? "agent").replace(/^agent\s+/, "") || "agent"
    // A call the session waits for runs while its item does; a background one until its end is reported, while the turn that started
    // it runs or, after it, while the daemon still lists it among the session's background work.
    const running = background ? !thread?.ended && block.status !== "error" && (activeTurn === block.turnId || options.backgroundRunning?.(description) === true) : block.status === "running"
    const status = running ? "running" : thread?.ended?.status ?? (block.status === "error" ? "error" : block.status === "ok" ? "ok" : "interrupted")
    // Stopped by the user's esc: it stays in sight, to be started again, until a turn begun after that stop has ended.
    const stoppedByUser = thread?.ended?.byUser === true && settledStart < thread.ended.at
    return {
      itemId: block.itemId, description, agent: typeof block.meta?.agent === "string" ? block.meta.agent : "agent", background, running, status,
      ...(stoppedByUser ? { stoppedByUser: true as const } : {}),
      startedAt: block.at, endedAt: thread?.ended?.at ?? block.endAt, tools: thread?.ended?.tools ?? thread?.tools ?? 0, last: thread?.last, tokens: thread?.ended?.tokens || undefined, ...(thread?.model ? { model: thread.model } : {}),
    }
  }

  /** The line under a sub-agent's call: what it is doing now, or what it took once it has ended. */
  function agentRow(block: Block): Line | undefined {
    if (block.meta?.subagent !== true) return undefined
    const thread = agentThread(block)
    if (!thread.tools && !thread.running) return undefined
    const tools = `${thread.tools} tool${thread.tools === 1 ? "" : "s"}`
    const took = thread.startedAt !== undefined && thread.endedAt !== undefined ? formatElapsed(thread.endedAt - thread.startedAt) : undefined
    const text = thread.running
      ? [thread.last ?? (thread.background ? "running in background" : "starting"), ...(thread.tools ? [tools] : [])].join(` ${g.sep} `)
      : [tools, ...(took ? [took] : []), ...(thread.tokens ? [`${thread.tokens < 1000 ? thread.tokens : `${Math.round(thread.tokens / 1000)}k`} tokens`] : [])].join(` ${g.sep} `)
    return [{ text: `${INDENT}  ${thread.running ? "↳" : "└"} `, fg: "muted" }, { text, fg: "muted" }]
  }

  function apply(event: SessionEvent) {
    if (event.seq <= lastSeq) return
    firstSeq ??= event.seq
    lastSeq = event.seq
    revision++
    // A sub-agent's item is part of the loaded history too: a rebuild for an older page gives the thread its beginning.
    if (routeAgent(event)) return remember(event)
    if (["turn.started", "turn.completed", "turn.cancelled", "turn.interrupted", "turn.failed"].includes(event.type)) usageNotes.apply(event)
    switch (event.type) {
      case "compaction.updated":
        compactionUpdates.set(event.turnId, event)
        addNotes(event, usageNotes.apply(event))
        for (const block of blocks) if (block.kind === "compaction" && block.turnId === event.turnId) cache.delete(block.itemId)
        if (event.state === "packed" && lastUsage) lastUsage = { ...lastUsage, contextTokens: undefined }
        invalidateCounts()
        break
      case "turn.started":
        activeTurn = event.turnId
        if (event.at > 0) turnClock = { startedAt: event.at }
        turns.set(event.turnId, { startedAt: event.at > 0 ? event.at : undefined, model: undefined, input: 0, output: 0, reasoning: 0, usage: false, items: 0, ...(options.agent ? { agent: options.agent() } : {}) })
        break
      case "item.started": {
        const previous = blocks[blocks.length - 1]
        if (previous) cache.delete(previous.itemId)
        const title = typeof event.meta?.tool === "string" ? event.meta.tool : typeof event.meta?.title === "string" ? event.meta.title : undefined
        add({ itemId: event.itemId, turnId: event.turnId, kind: event.kind, text: "", status: "running", at: event.at, ...(event.meta?.subagent === true ? { meta: event.meta } : {}), ...(title ? { title } : {}), ...(event.meta?.notice === true ? { notice: true as const } : {}), ...(event.kind === "tool_call" && event.meta?.injected === true ? { injected: true as const } : {}), ...(event.meta?.shell === true ? { shell: true as const } : {}), ...(event.meta?.shell === true && event.meta.local === true ? { local: true as const } : {}), ...(event.kind === "compaction" && event.meta ? { meta: event.meta } : {}) })
        const turn = turns.get(event.turnId)
        if (turn) turn.items++
        if (turn && event.meta?.shell === true) turn.shell = true
        invalidateCounts()
        break
      }
      case "item.delta": {
        const block = byItem.get(event.itemId)
        if (block) block.text += event.text
        // A block that grows under a newer one (concurrent tools) is not the live tail the views lay out fresh: its count is redone.
        if (block && blocks.at(-1) !== block) grown.add(event.itemId)
        // A tool input the model is still writing: the card says how much (`writingChars`, `writingLines`) until the input is whole.
        if (block && event.input) {
          const { writingChars: _chars, writingLines: _lines, ...rest } = block.meta ?? {}
          block.meta = event.input.done ? rest : { ...rest, writingChars: event.input.chars, writingLines: event.input.lines }
          if (!Object.keys(block.meta).length) delete block.meta
        }
        break
      }
      case "item.completed": {
        const block = byItem.get(event.itemId)
        if (!block) break
        // Final text replaces streamed text; an empty final text never erases a tool's streamed output.
        if (event.text !== undefined && (block.kind !== "tool_call" || event.text || !block.text)) block.text = event.text
        block.status = event.status
        block.endAt = event.at
        if (event.meta) block.meta = block.kind === "compaction" ? { ...block.meta, ...event.meta } : event.meta
        // A call that started before its input was whole (a sub-agent, an early card) is named again at its end.
        if (block.kind === "tool_call" && (event.meta?.subagent === true || event.meta?.retitled === true) && typeof event.meta.tool === "string" && event.meta.tool) block.title = event.meta.tool
        if (event.attachments?.length) {
          block.images = event.attachments.length
          block.attachments = event.attachments.map((ref): Attachment => ({ mime: ref.mime, sha256: ref.sha256, ...(typeof ref.bytes === "number" ? { bytes: ref.bytes } : {}), ...(ref.name ? { name: ref.name } : {}), ...(ref.label ? { label: ref.label } : {}) }))
        }
        if (event.render) block.render = event.render
        if (block.kind === "tool_call" && event.toolInput) {
          const args = callArgs(parseToolTitle(block.title).name, event.toolInput)
          if (args?.pattern) block.pattern = args.pattern
          if (args && (args.agent || args.model || args.description || args.written)) block.args = args
          if (hooks) {
            const input = toolArgs(event.toolInput)
            if (input) block.input = input
          }
        }
        // A finished compaction replaced the history: the old context size is stale until the next model call.
        if (block.kind === "compaction" && event.status === "ok" && !compactionUpdates.has(block.turnId) && lastUsage) lastUsage = { ...lastUsage, contextTokens: undefined }
        invalidateCounts()
        break
      }
      case "turn.reverted":
        undoneTurns.add(event.turnId)
        rebuild()
        break
      case "message.revised": {
        if (event.deleted) deletedItems.add(event.itemId)
        const block = byItem.get(event.itemId)
        if (block) {
          const snapshot = event.snapshot
          block.text = snapshot.text ?? ""
          block.status = snapshot.status
          if (snapshot.render) block.render = snapshot.render
          else delete block.render
          if (snapshot.meta) block.meta = snapshot.meta
          else delete block.meta
          block.images = snapshot.attachments?.length ?? 0
          if (snapshot.attachments?.length) block.attachments = snapshot.attachments.map((ref) => ({ mime: ref.mime, sha256: ref.sha256, ...(typeof ref.bytes === "number" ? { bytes: ref.bytes } : {}), ...(ref.name ? { name: ref.name } : {}), ...(ref.label ? { label: ref.label } : {}) }))
          else delete block.attachments
        }
        rebuild()
        invalidateCounts()
        break
      }
      case "turn.restored":
        undoneTurns.delete(event.turnId)
        rebuild()
        break
      case "turn.completed":
        finishTurn(event, { outcome: "completed" })
        break
      case "turn.cancelled":
        finishTurn(event, { outcome: "cancelled" })
        break
      case "turn.interrupted":
        finishTurn(event, { outcome: "interrupted", reason: event.reason })
        break
      case "turn.failed":
        finishTurn(event, { outcome: "failed", error: event.error })
        break
      case "foreground.state":
        foreground = event.state
        break
      case "session.orchestration": {
        const id = `orchestration:${event.groupId}` as ItemId
        const known = byItem.get(id)
        if (known) { known.text = event.text; cache.delete(id) }
        else add({ itemId: id, turnId: id as unknown as TurnId, kind: "artifact", text: event.text, status: "ok", at: event.at })
        invalidateCounts()
        break
      }
      case "limit.checkpoint":
        add({ itemId: `checkpoint:${event.seq}` as ItemId, turnId: `checkpoint:${event.seq}` as TurnId, kind: "status", text: "", status: "ok", at: event.at, meta: { limitCheckpoint: true } })
        invalidateCounts()
        break
      case "usage.recorded": {
        lastUsage = { provider: event.provider, model: event.model, contextTokens: usageContext(event), callAt: event.at - (event.profile?.durationMs ?? 0), ...(event.contextWindow ? { contextWindow: event.contextWindow } : {}), ...(event.contextApprox ? { contextApprox: true } : {}), ...(event.compactAt ? { compactAt: event.compactAt } : {}) }
        const turn = turns.get(event.turnId)
        if (turn) {
          turn.model = event.model
          turn.input += event.input + event.cacheRead + event.cacheWrite
          turn.output += event.output
          turn.reasoning += event.reasoning
          turn.calls = (turn.calls ?? 0) + 1
          turn.cacheRead = (turn.cacheRead ?? 0) + event.cacheRead
          turn.costMicros = turn.costMicros === null || event.costMicros === undefined ? null : (turn.costMicros ?? 0) + event.costMicros
          turn.usage = true
        }
        addNotes(event, usageNotes.apply(event, compactionUpdates.get(event.turnId)?.state === "writing"))
        break
      }
      case "session.permission":
        permissionMode = event.mode
        break
      case "goal.changed": {
        goal = event.change === "cleared" ? undefined : event.goal
        if (!goalCardTitle(event.change, event.goal)) break
        const previous = blocks[blocks.length - 1]
        if (previous) cache.delete(previous.itemId)
        // A card belongs to no turn: its own id keeps it out of the undone runs.
        add({ itemId: `goal:${event.seq}` as ItemId, turnId: `goal:${event.seq}` as TurnId, kind: "status", text: "", status: "ok", at: event.at, goal: { change: event.change, goal: event.goal, ...(event.by ? { by: event.by } : {}), ...(event.reason ? { reason: event.reason } : {}), at: event.at } })
        invalidateCounts()
        break
      }
      case "usage.limit": {
        const closed = event.state === "resumed" || event.state === "cleared"
        const fresh = (event.state === "paused" || event.state === "scheduled") && (!usageLimit || usageLimit.turnId !== event.turnId)
        usageLimit = closed ? undefined : { state: event.state as "paused" | "scheduled" | "snoozed" | "ready", message: event.message, at: event.at, ...(event.provider ? { provider: event.provider } : {}), ...(event.resetsAt !== undefined ? { resetsAt: event.resetsAt } : {}), ...(event.turnId ? { turnId: event.turnId } : {}) }
        // The turn that hit the limit is paused, not failed: its error box gives way to the card.
        const stopped = fresh && event.turnId ? byItem.get(`status:${event.turnId}` as ItemId) : undefined
        if (stopped?.end?.outcome === "failed") {
          const { error: _error, ...rest } = stopped.end
          stopped.end = { ...rest, outcome: "paused" }
          cache.delete(stopped.itemId)
        }
        if (fresh || event.state === "resumed") {
          const previous = blocks[blocks.length - 1]
          if (previous) cache.delete(previous.itemId)
          add({ itemId: `limit:${event.seq}` as ItemId, turnId: `limit:${event.seq}` as TurnId, kind: "status", text: "", status: "ok", at: event.at, limit: { state: event.state === "resumed" ? "resumed" : event.state === "scheduled" ? "scheduled" : "paused", message: event.message, at: event.at, ...(event.provider ? { provider: event.provider } : {}), ...(event.resetsAt !== undefined ? { resetsAt: event.resetsAt } : {}) } })
        }
        invalidateCounts()
        break
      }
      case "queue.changed":
        queue = event.queue.map((entry) => ({ queueId: entry.queueId, preview: entry.preview, ...(entry.delivery ? { delivery: entry.delivery } : {}), ...(entry.kind === "notice" ? { notice: true as const } : {}) }))
        break
      case "continuity.updated":
        continuity.set(event.record.id, event.record)
        if (continuity.size > 256) continuity.delete(continuity.keys().next().value!)
        break
      case "server.request":
        requests.set(event.requestId, { kind: event.kind, title: event.title, detail: event.detail, ...(event.itemId ? { itemId: event.itemId } : {}) })
        // The folded runs and densities leave an awaited call out (and the asking call of a question), so they are planned again.
        if (event.itemId) cache.delete(event.itemId)
        if (event.itemId || event.kind === "question") invalidateCounts()
        break
      case "server.request.resolved": {
        resolvedRequests.add(event.requestId)
        if (resolvedRequests.size > 256) resolvedRequests.delete(resolvedRequests.values().next().value!)
        asyncRequests.delete(event.requestId)
        if (requests.get(event.requestId)?.itemId || requests.get(event.requestId)?.kind === "question") invalidateCounts()
        requests.delete(event.requestId)
        break
      }
    }
    remember(event)
  }

  function prepend(events: readonly SessionEvent[]) {
    const older = events.filter((event) => event.seq < (firstSeq ?? Infinity))
    if (!older.length) return
    revision++
    const replay = [...older, ...history.values()].sort((a, b) => a.seq - b.seq)
    const previousCount = blocks.length
    const previousSeq = lastSeq
    all.length = 0
    blocks.length = 0
    byItem.clear()
    index.clear()
    undoneTurns.clear()
    deletedItems.clear()
    requests.clear()
    continuity.clear()
    turns.clear()
    compactionUpdates.clear()
    cache.clear()
    history.clear()
    deltaSeqs.clear()
    firstSeq = undefined
    lastSeq = 0
    queue = []
    foreground = "idle"
    permissionMode = "ask"
    lastUsage = undefined
    usageNotes.reset()
    turnClock = undefined
    activeTurn = undefined
    settledStart = 0
    goal = undefined
    usageLimit = undefined
    invalidateCounts()
    // The threads stay (an open thread view reads them); their counters are counted again from the replay, and each thread
    // takes the events it has not seen through its own prepend.
    for (const thread of threads.values()) {
      thread.tools = 0
      delete thread.last
      delete thread.ended
    }
    replayed = new Map()
    try {
      for (const event of replay) apply(event)
    } finally {
      const handed = replayed
      replayed = undefined
      for (const [thread, own] of handed) thread.transcript.prepend(own)
    }
    lastSeq = Math.max(lastSeq, previousSeq)
    olderLoaded += Math.max(0, blocks.length - previousCount)
    invalidateCounts()
  }

  /** Line counts of all blocks at `width`; recomputed only when blocks were added/finished or width changed. */
  function counts(width: number) {
    const first = firstShown()
    // A lazily loaded diagram module changes block heights after the first layout: the counts must follow it.
    const generation = mermaidGeneration() + (images?.generation() ?? 0) * 1_000_003
    if (totalLinesWidth !== width || countsFirst !== first || countsGeneration !== generation || lineCounts.length !== blocks.length - first) {
      lineCounts = blocks.slice(first).map((block) => countOf(block, width))
      countsFirst = first
      countsGeneration = generation
      totalLinesWidth = width
      grown.clear()
    }
    for (const itemId of grown) {
      const at = index.get(itemId)
      if (at !== undefined && at >= first && at - first < lineCounts.length) lineCounts[at - first] = countOf(blocks[at]!, width)
    }
    grown.clear()
    return lineCounts
  }

  /**
   * The reasoning cap follows the viewport's height, which can change between two calls of one frame (the sticky prompt takes a row):
   * only the reasoning blocks are recounted, from their layout at that cap when they have one (`Cached.other`). Recounting every block
   * there cost a layout key per loaded block on every frame (7 ms of a streamed frame after scrolling through 10,000 messages), and
   * laying out every reasoning block again cost 10 ms a frame with a window of 100 reasoning turns.
   */
  function recountReasoning() {
    const first = firstShown()
    if (totalLinesWidth === 0 || countsFirst !== first || lineCounts.length !== blocks.length - first) return
    for (let i = first; i < blocks.length; i++) if (blocks[i]!.kind === "reasoning") lineCounts[i - first] = countOf(blocks[i]!, totalLinesWidth)
  }

  return {
    apply,
    get revision() {
      return revision
    },
    /** The sub-agents an engine reported inside this session, in the order they were called. */
    agentThreads: (): AgentThread[] => blocks.filter((block) => block.kind === "tool_call" && block.meta?.subagent === true).map(agentThread),
    /** The transcript of the sub-agent called by `itemId` (a transcript like this one), when it has reported anything. */
    agentTranscript: (itemId: ItemId): unknown => threads.get(itemId)?.transcript,
    prepend,
    get lastSeq() {
      return lastSeq
    },
    get foreground() {
      return foreground
    },
    get permissionMode() {
      return permissionMode
    },
    get lastUsage() {
      return lastUsage
    },
    /** Token totals of the usage events this client has seen, and the last call's own numbers. */
    get sessionUsage() {
      return usageNotes.totals
    },
    get modelUsage() {
      return usageNotes.models
    },
    get lastCall() {
      return usageNotes.last
    },
    /** Estimated cost of the loaded window's calls (micro-USD), and the last calls' timings. */
    get sessionCost() {
      return usageNotes.cost
    },
    get recentCalls() {
      return usageNotes.calls
    },
    get recentTurnTimes() {
      return usageNotes.turnTimes
    },
    /** Context size at the end of recent turns (the footer forecast). */
    get recentContexts() {
      return usageNotes.contexts
    },
    get turnClock() {
      return turnClock
    },
    get activeTurn() {
      return activeTurn
    },
    get goal() {
      return goal
    },
    get usageLimit() {
      return usageLimit
    },
    get queue() {
      return queue
    },
    restoreContinuity(records: readonly import("@mendcode/protocol").ContinuitySummary[]) {
      continuitySnapshot.clear()
      for (const record of records) continuitySnapshot.set(record.id, record)
    },
    restoreAsyncRequests(events: readonly Extract<SessionEvent, { type: "server.request" }>[]) {
      for (const event of events) if (!resolvedRequests.has(event.requestId)) asyncRequests.set(event.requestId, event)
    },
    get continuityJobs() {
      const combined = new Map(continuitySnapshot)
      for (const [id, record] of continuity) if (!combined.has(id) || combined.get(id)!.updatedAt <= record.updatedAt) combined.set(id, record)
      return [...combined.values()].filter((record) => record.kind === "job")
    },
    get pendingRequests() {
      return [...requests.entries()].map(([requestId, request]) => ({ requestId, ...request })).concat([...asyncRequests.values()].filter((event) => !requests.has(event.requestId) && !resolvedRequests.has(event.requestId)).map((event) => ({ requestId: event.requestId, kind: event.kind, title: event.title, detail: event.detail })))
    },
    blocks: () => blocks as readonly Block[],
    /** The laid-out lines of one block at `width`, its trailing blank row included; empty for an unknown block. */
    blockLines(itemId: ItemId, width: number): ViewLine[] {
      const at = index.get(itemId)
      return at === undefined ? [] : linesOf(blocks[at]!, width)
    },
    /** What a block carries as files (images, documents); empty for an unknown block. */
    attachmentsOf: (itemId: ItemId): readonly Attachment[] => byItem.get(itemId)?.attachments ?? [],
    compactions(): Compaction[] {
      const entries = new Map<TurnId, Compaction>()
      for (const [turnId, event] of compactionUpdates) {
        if (undoneTurns.has(turnId)) continue
        entries.set(turnId, { ...event, summary: "", state: event.state === "writing" && activeTurn !== turnId ? "interrupted" : event.state })
      }
      for (const block of blocks) {
        if (block.kind !== "compaction" || undoneTurns.has(block.turnId)) continue
        const data = entries.get(block.turnId) ?? legacyCompaction(block.turnId, block.text, block.status)
        entries.set(block.turnId, { ...data, ...compactionFacts(block.meta), summary: block.text, itemId: block.itemId })
      }
      return [...entries.values()]
    },
    setAppearance(next: Partial<TuiProfile> & { reasoning: string; toolOutput: string }) {
      appearance = { ...appearance, ...next }
      renderer = appearance.messageRenderer
      timestamps = appearance.timestamps
      username = appearance.showUsername ? appearance.username : ""
      setColorOverrides(parseMarkdownColors(appearance.markdownColors).colors)
      reasoningVisibility = next.reasoning
      toolOutput = next.toolOutput
      doneSymbol = next.doneSymbol ?? g.done
      appearanceChanged = true
      for (const thread of threads.values()) thread.transcript.setAppearance(next)
      cache.clear()
      invalidateCounts()
    },
    get toolsExpanded() {
      return toolsExpanded
    },
    get mode() {
      return mode
    },
    /** Switching mode re-renders from the same events; nothing is refetched. */
    setMode(next: PresentationMode) {
      if (next === mode) return
      mode = next
      // The sub-agents' threads read the same way: one opened next shows the mode the chat says.
      for (const thread of threads.values()) thread.transcript.setMode(next)
      toolsExpanded = next === "full"
      toolsOpenAll = false
      cache.clear()
      invalidateCounts()
    },
    /** Extensions loaded or one was disabled: every cached block is drawn again with the new hooks. */
    refresh() {
      cache.clear()
      invalidateCounts()
    },
    toggleConceal() {
      conceal = !conceal
      cache.clear()
      invalidateCounts()
    },
    get concealed() { return conceal },
    /** Ctrl+O (S3): expands or collapses every tool card; only tool caches are invalidated. */
    toggleTools() {
      toolsExpanded = !toolsExpanded
      toolsOpenAll = !toolsOpenAll
      // ctrl+o is a reset for the `<details>` blocks and the cards opened one by one too: they go back to following it.
      detailsState.clear()
      toolOpen.clear()
      toolPage.clear()
      openRuns.clear()
      for (const block of blocks) if (block.kind === "tool_call" || block.kind === "user_message" || block.kind === "compaction") cache.delete(block.itemId)
      invalidateCounts()
    },
    /**
     * Expands or collapses the `<details>` blocks of one assistant message: the block at `ordinal`, or every block
     * of the message (all open unless all already are) when no ordinal is given. State is kept per block.
     */
    toggleDetails(itemId: ItemId, ordinal?: number) {
      const block = byItem.get(itemId)
      if (!block) return
      if (block.kind === "tool_call" || block.kind === "artifact" && block.meta?.memorySaved === true) return toggleTool(block, ordinal ?? FOLD_CARD)
      const defaults = detailsDefaults(block.text)
      const targets = ordinal === undefined ? defaults.map((_, n) => n) : ordinal >= 0 && ordinal < defaults.length ? [ordinal] : []
      const key = (n: number) => `${itemId}#${n}`
      const open = !targets.every((n) => detailsState.get(key(n)) ?? (detailsAllOpen() || defaults[n]))
      for (const n of targets) detailsState.set(key(n), open)
      cache.delete(itemId)
      invalidateCounts()
    },
    /**
     * Find (`/find`) searches the rows on screen, so a hit inside a folded run or a capped tool body would be missed. While a
     * query is typed, the runs and cards whose full text has the query but whose rows do not are opened (a card at the page
     * holding the first hit); `endFind` puts them back. True when something opened or closed, so the caller lays out again.
     */
    revealFind(query: string, width: number): boolean {
      const has = (text: string) => (/[A-Z]/.test(query) ? text : text.toLowerCase()).includes(query)
      const wanted = new Set<ItemId>()
      const wantedRuns = new Set<ItemId>()
      if (query.length >= 2) {
        for (const block of blocks.slice(firstShown())) {
          if (block.kind !== "tool_call" || block.status === "running" || !has(block.text.replace(/\x1b\[[0-9;?]*[A-Za-z]|\r/g, ""))) continue
          const shows = () => linesOf(block, width).some((line) => has(line.text))
          const run = readRunPlan().get(block.itemId)
          if (run && revealedRuns.has(run.leader)) wantedRuns.add(run.leader)
          else if (run && !openRuns.has(run.leader) && !shows()) {
            openRuns.add(run.leader)
            wantedRuns.add(run.leader)
            revealedRuns.add(run.leader)
            cache.delete(block.itemId)
            invalidateCounts()
          }
          const was = revealedCards.has(block.itemId)
          if (!was && shows()) continue
          const own = toolOpen.get(block.itemId)
          const lines = block.text.replace(/\x1b\[[0-9;?]*[A-Za-z]|\r/g, "").replace(/\s+$/, "").split("\n").filter((line) => line.length > 0)
          wanted.add(block.itemId)
          if (!was && own !== true) {
            toolOpen.set(block.itemId, true)
            revealedCards.set(block.itemId, own)
          }
          toolPage.set(block.itemId, Math.floor(Math.max(0, lines.findIndex(has)) / TOOL_PAGE_LINES))
          cache.delete(block.itemId)
          invalidateCounts()
        }
      }
      let changed = wanted.size > 0 || wantedRuns.size > 0
      for (const [itemId, before] of revealedCards) {
        if (wanted.has(itemId)) continue
        if (before === undefined) toolOpen.delete(itemId)
        else toolOpen.set(itemId, before)
        toolPage.delete(itemId)
        revealedCards.delete(itemId)
        cache.delete(itemId)
        changed = true
      }
      for (const leader of revealedRuns) {
        if (wantedRuns.has(leader)) continue
        openRuns.delete(leader)
        revealedRuns.delete(leader)
        cache.delete(leader)
        changed = true
      }
      if (changed) invalidateCounts()
      return changed
    },
    /** The find bar closed: what `revealFind` opened goes back. */
    endFind() {
      revealedCards.forEach((before, itemId) => {
        if (before === undefined) toolOpen.delete(itemId)
        else toolOpen.set(itemId, before)
        toolPage.delete(itemId)
        cache.delete(itemId)
      })
      revealedRuns.forEach((leader) => {
        openRuns.delete(leader)
        cache.delete(leader)
      })
      revealedCards.clear()
      revealedRuns.clear()
      invalidateCounts()
    },
    /** Opens or folds one long item (a user message, a compaction summary) on its own. */
    toggleItem(itemId: ItemId) {
      if (!openItems.delete(itemId)) openItems.add(itemId)
      cache.delete(itemId)
      invalidateCounts()
    },
    /**
     * Visible lines for a viewport of `height` rows, `offset` rows above the bottom.
     * Touches only blocks that intersect the viewport.
     */
    from(itemId: ItemId, width: number, height: number): Line[] {
      const at = index.get(itemId)
      if (at === undefined || height <= 0) return []
      const parts: Line[][] = []
      let remaining = height
      for (let i = blocks.length - 1; i >= at && remaining > 0; i--) {
        const lines = linesOf(blocks[i]!, width).slice(-remaining).map((line) => line.spans)
        parts.unshift(lines)
        remaining -= lines.length
      }
      return parts.flat()
    },
    viewport(width: number, height: number, offset = 0): ViewLine[] {
      const rows = reasoningRowsFor(height)
      if (rows !== reasoningRows) {
        reasoningRows = rows
        recountReasoning()
      }
      const perBlock = counts(width)
      const first = firstShown()
      const live = blocks.length > 0 && blocks[blocks.length - 1]?.status === "running" ? blocks.length - 1 : -1
      if (live >= first) perBlock[live - first] = linesOf(blocks[live]!, width).length
      const out: ViewLine[] = []
      let skip = offset
      for (let i = blocks.length - 1; i >= first && out.length < height; i--) {
        const count = perBlock[i - first] ?? 0
        if (skip >= count) {
          skip -= count
          continue
        }
        const lines = linesOf(blocks[i]!, width)
        const end = lines.length - skip
        const start = Math.max(0, end - (height - out.length))
        out.unshift(...lines.slice(start, end))
        skip = 0
      }
      return out
    },
    /** Lines of the laid-out window (the newest `WINDOW_BLOCKS` blocks and whatever `loadOlder` added). */
    totalLines(width: number) {
      const perBlock = counts(width)
      const total = perBlock.reduce((sum, n) => sum + n, 0)
      // A streaming block grows between recounts; the viewport lays it out fresh, so the total must too, or a reader scrolled up drifts with every delta.
      const live = blocks.length > 0 && blocks[blocks.length - 1]?.status === "running" ? blocks.length - 1 : -1
      const first = firstShown()
      return live >= first ? total - (perBlock[live - first] ?? 0) + linesOf(blocks[live]!, width).length : total
    },
    /** Blocks above the window: received, not laid out yet. */
    get olderBlocks() {
      return firstShown()
    },
    /** Lays out `WINDOW_STEP` more blocks above the window; how many were added (0 at the very start). */
    loadOlder() {
      const before = firstShown()
      if (before === 0) return 0
      olderLoaded += WINDOW_STEP
      return before - firstShown()
    },
    /**
     * Keeps the window's first block where it was (`first` is `olderBlocks` read before new events): without it the
     * newest blocks push the window's top out and a reader scrolled up would drift.
     */
    pinWindow(first: number) {
      olderLoaded = Math.max(olderLoaded, blocks.length - WINDOW_BLOCKS - first)
    },
    /**
     * The viewport offset (rows above the bottom) that puts the top of block `itemId` on the first row of a viewport of
     * `height` rows, widening the window to reach it. Undefined when the block is not shown (unknown, or undone).
     */
    offsetFor(itemId: ItemId, width: number, height: number): number | undefined {
      const at = index.get(itemId)
      if (at === undefined) return undefined
      if (at < firstShown()) olderLoaded += firstShown() - at
      const perBlock = counts(width)
      const first = firstShown()
      let before = 0
      for (let i = 0; i < at - first; i++) before += perBlock[i] ?? 0
      const total = perBlock.reduce((sum, n) => sum + n, 0)
      return Math.max(0, Math.min(total - before - height, total - height))
    },
    /** Restores an item row at its previous screen row after prepend changes layout above it. */
    offsetForAnchor(anchor: { itemId: ItemId; row: number; screenRow: number }, width: number, height: number) {
      const at = index.get(anchor.itemId)
      if (at === undefined) return undefined
      if (at < firstShown()) olderLoaded += firstShown() - at
      const perBlock = counts(width)
      const first = firstShown()
      const before = perBlock.slice(0, at - first).reduce((sum, n) => sum + n, 0)
      const total = perBlock.reduce((sum, n) => sum + n, 0)
      return Math.max(0, total - height - before - anchor.row + anchor.screenRow)
    },
    /** Shown blocks (undone turns leave a marker), in order. */
    get visibleCount() {
      return blocks.length
    },
  }
}
export type Transcript = ReturnType<typeof createTranscript>

/** Per-session view state kept outside any mounted component, so navigation never loses it (FC-04, I8). */
export function createViewState() {
  /** `unseen` counts the rows that arrived below the viewport since the reader left the bottom; it is zero while following. */
  const sessions = new Map<string, { offset: number; follow: boolean; draft: string; unseen: number }>()
  const get = (sessionId: string) => {
    let state = sessions.get(sessionId)
    if (!state) sessions.set(sessionId, (state = { offset: 0, follow: true, draft: "", unseen: 0 }))
    return state
  }
  const settle = (state: { offset: number; follow: boolean; unseen: number }) => {
    state.follow = state.offset === 0
    if (state.follow) state.unseen = 0
  }
  return {
    get,
    scroll(sessionId: string, delta: number, maxOffset: number) {
      const state = get(sessionId)
      state.offset = Math.min(Math.max(0, state.offset + delta), Math.max(0, maxOffset))
      settle(state)
    },
    /** Puts the viewport `offset` rows above the bottom (clamped), as a jump to a message does. */
    jump(sessionId: string, offset: number, maxOffset: number) {
      const state = get(sessionId)
      state.offset = Math.min(Math.max(0, offset), Math.max(0, maxOffset))
      settle(state)
    },
    /** New content keeps a reader's position steady unless they are following the bottom. */
    onGrowth(sessionId: string, addedLines: number) {
      const state = get(sessionId)
      // An undo removes lines: the offset follows them down, never below the bottom.
      if (!state.follow) {
        state.offset = Math.max(0, state.offset + addedLines)
        if (addedLines > 0) state.unseen += addedLines
        settle(state)
      }
    },
  }
}
