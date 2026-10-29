/**
 * The contract of MendCode extensions: trusted TypeScript modules that change the runtime and the terminal UI.
 * Types only and zod-free, so both the daemon and the thin terminal client can import it.
 *
 * Discovery: `extensions/*.ts` (or `extensions/<name>/index.ts`) in every layer — the user dir, the project's
 * `.mendcode/`, and enabled packages. Project extensions load only in trusted directories, like project tools.
 * One module may export both halves; each process calls only its own:
 *
 *   export default defineExtension({
 *     name: "guard",
 *     daemon(api) { api.on("tool.before", (e) => (e.tool === "shell" && /rm -rf/.test(String(e.args.command)) ? { block: "no rm -rf" } : undefined)) },
 *     tui(api) { api.slot("footer.right", ({ width }) => [[{ text: "guarded", fg: "success" }]]) },
 *   })
 *
 * Isolation: a hook that throws or exceeds HOOK_TIMEOUT_MS is skipped and reported once per extension in
 * `/extensions`; it never fails the turn. Hooks of several extensions run in load order (user, user packages,
 * project packages, project); the first `block` wins, rewrites chain.
 */

import type { SlashMenuModel, ViewRenderer, ViewSlot } from "./views"
export type * from "./views"

export const EXTENSION_API_VERSION = 1
export const HOOK_TIMEOUT_MS = 5_000

type Awaitable<T> = T | Promise<T>
type Json = string | number | boolean | null | Json[] | { [key: string]: Json }

// ─── Daemon side ────────────────────────────────────────────────────────────────────────────────────────────────

export type SessionRef = { sessionId: string; cwd: string }

/** Every event a daemon extension can observe or shape; the value is what the handler may return. */
export type DaemonHooks = {
  /** The user's text before it becomes a turn. Return `text` to rewrite it or `handled` to swallow it (with an optional notice). */
  input: { event: SessionRef & { text: string }; result: { text?: string; handled?: true; notice?: string } | void }
  "session.start": { event: SessionRef & { parentId?: string }; result: void }
  "turn.start": { event: SessionRef & { turnId: string; text: string }; result: void }
  "turn.end": { event: SessionRef & { turnId: string; outcome: "completed" | "cancelled" | "interrupted" | "failed" }; result: void }
  /**
   * Before a tool runs (after approval). `block` refuses it with that reason as the tool's error; `args` replaces its arguments.
   * A call that reads without being `read` (a shell command's paths, grep/glob/ls's path, read's `paths`) is then also asked as
   * `{ tool: "read", args: { path } }` for each path, with `via` the real call: a rule written for reads covers every tool.
   */
  "tool.before": { event: SessionRef & { turnId: string; tool: string; callId: string; args: Record<string, unknown>; via?: { tool: string; args: Record<string, unknown> } }; result: { block?: string; args?: Record<string, unknown> } | void }
  /** After a tool ran. Return fields to replace what the model sees. */
  "tool.after": { event: SessionRef & { turnId: string; tool: string; callId: string; args: Record<string, unknown>; output: string; isError: boolean; title?: string; meta?: Record<string, unknown> }; result: { output?: string; isError?: boolean; title?: string; meta?: Record<string, string | number | boolean> } | void }
  /** The full system prompt for the next model call; return a string to replace it. */
  "prompt.system": { event: SessionRef & { system: string; role: string }; result: string | { system: string } | void }
  /** The messages about to be sent (provider-neutral); return a new array to replace them. */
  context: { event: SessionRef & { role: string; messages: ReadonlyArray<Record<string, unknown>> }; result: Array<Record<string, unknown>> | void }
  /** The provider request body right before it is sent; return an object to replace it. Advanced: shapes differ per provider. */
  "request.before": { event: SessionRef & { provider: string; model: string; body: Record<string, unknown> }; result: Record<string, unknown> | void }
  /** Before a compaction. `cancel` skips it; `summary` supplies the summary instead of asking the model. */
  "compact.before": { event: SessionRef & { reason: "auto" | "manual"; tokens: number }; result: { cancel?: true; summary?: string } | void }
  "compact.after": { event: SessionRef & { summary: string }; result: void }
  "chat.params": { event: SessionRef & { provider: string; model: string; role: string; parameters: Record<string, unknown> }; result: { parameters?: Record<string, unknown>; maxOutputTokens?: number } | void }
  "chat.headers": { event: SessionRef & { provider: string; model: string; role: string; headers: Record<string, string> }; result: Record<string, string> | void }
  "permission.ask": { event: SessionRef & { tool: string; args: Record<string, unknown> }; result: { status: "ask" | "deny" | "allow" } | void }
  "shell.env": { event: SessionRef & { env: Record<string, string> }; result: Record<string, string> | void }
  "tool.definition": { event: SessionRef & { tool: string; description: string; parameters: Record<string, unknown> }; result: { description: string; parameters: Record<string, unknown> } | void }
  "text.complete": { event: SessionRef & { itemId: string; text: string }; result: string | void }
  "compact.prompt": { event: SessionRef & { prompt: string }; result: string | void }
  "compact.continue": { event: SessionRef; result: boolean | void }
  "command.before": { event: SessionRef & { command: string; args: string; text: string }; result: string | void }
  event: { event: SessionRef & { event: Record<string, unknown> }; result: void }
}

export type DaemonHookName = keyof DaemonHooks
export type DaemonHandler<K extends DaemonHookName> = (event: DaemonHooks[K]["event"]) => Awaitable<DaemonHooks[K]["result"]>

/** A tool written in TypeScript. The JSON schema is what the model sees; `execute` gets the parsed arguments. */
export type ExtensionTool = {
  name: string
  description: string
  parameters: Record<string, unknown>
  /** Optional source-schema validation before permission review; return a terse error for invalid arguments. */
  validateArgs?(args: Record<string, unknown>): string | undefined
  permission: "read" | "write" | "execute"
  /** Same name as a built-in (read, shell, edit…) replaces it; the built-in stays reachable through `api.builtinTool`. */
  override?: boolean
  /** The lowest tier that offers the tool (docs/tiers.md). Absent: every tier. Ignored while the user has no `tier` set. */
  tier?: "minimalist" | "balanced" | "full"
  execute(args: Record<string, unknown>, ctx: ExtensionToolContext): Promise<ExtensionToolResult>
}

export type ExtensionToolContext = SessionRef & { signal: AbortSignal; onOutput(chunk: string): void }

export type ExtensionToolResult = {
  output: string
  isError?: boolean
  title?: string
  /** A renderSpec@1 tree, as for any tool. */
  render?: Json
  meta?: Record<string, string | number | boolean>
}

/** `/name args` handled by code. Return `prompt` to send text to the agent, `notice` to show a line, or nothing. */
export type ExtensionCommand = {
  name: string
  description: string
  run(args: string, ctx: SessionRef): Awaitable<{ prompt?: string; notice?: string } | void>
}

export type DaemonExtensionAPI = {
  readonly version: typeof EXTENSION_API_VERSION
  /** The extension's own directory (for its files) and a private data dir under the MendCode data dir. */
  readonly dir: string
  readonly dataDir: string
  on<K extends DaemonHookName>(hook: K, handler: DaemonHandler<K>): void
  registerTool(tool: ExtensionTool): void
  registerCommand(command: ExtensionCommand): void
  /** A built-in tool by name, to wrap it from an override. */
  builtinTool(name: string): ExtensionTool | undefined
  /** Queues a notice turn in a session (like a finished background task). */
  notify(sessionId: string, text: string): void
  log(level: "info" | "warn" | "error", message: string): void
  /**
   * A short note on the user's terminal toast line (progress, "indexed 40 files"): one line, 300 characters, at most 10
   * per 10 seconds. It never starts a turn, never enters the model's context or the transcript, and is never stored;
   * remote terminals do not get it. Use `notify` to put text in front of the model.
   */
  toast(text: string, options?: { level?: "info" | "success" | "warning" | "error" }): void
  registerAuth(auth: import("./plugin").PluginAuth): void
  /** With `baseUrl`, a whole model provider (`<id>:<model>` in /model); without it, a catalog hook for a provider configured elsewhere. */
  registerProvider(provider: import("./plugin").PluginProvider): void
  /**
   * Runs a program (no shell) and resolves with its output, never rejecting: `code` is null when it could not start or was stopped
   * at `timeoutMs` (default 30 s, at most 120 s). `cwd` defaults to the daemon's directory; pass `ctx.cwd` for the session's project.
   * `input` is written to its stdin (else stdin is empty). Output is capped at 1 MB per stream.
   */
  exec(command: string, args?: string[], options?: { cwd?: string; input?: string; timeoutMs?: number; signal?: AbortSignal }): Promise<ExecResult>

  // ─── Sessions (pi: setModel, setThinkingLevel, setActiveTools, sendUserMessage) ───
  // A session a project extension names must belong to its project. None of these changes the permission mode, an approval,
  // a budget or the tier: a model is one the user can pick in /model on the same engine, tools only narrow what is offered.

  /** The session's model and effort as its next turn would use them (absent: unknown session). */
  getModel(sessionId: string): { model: string; effort?: string } | undefined
  /** The session's own model from its next model call, like `/model` (the user's default for new sessions stays). */
  setModel(sessionId: string, model: string, options?: { effort?: string }): Promise<SessionChange>
  /** The reasoning effort of the session's model (pi's thinking level): one the model lists. */
  setThinkingLevel(sessionId: string, effort: string): Promise<SessionChange>
  /** The tool names an extension limited the session to, or undefined while every offered tool is active. */
  getActiveTools(sessionId: string): string[] | undefined
  /** Limits the session's tools to these names (patterns like `mcp__*` work) from its next model call; null lifts the limit. Never adds a tool the session is not offered. */
  setActiveTools(sessionId: string, tools: string[] | null): SessionChange
  /**
   * Queues `text` as the user's next message (a turn starts when the session is free). `deliverAs: "steer"` gives it to a running turn
   * instead, where the engine can take it. The text goes straight to the queue: input hooks and /commands do not run on it. At most 5 per
   * session per minute per extension.
   */
  sendUserMessage(sessionId: string, text: string, options?: { deliverAs?: "followUp" | "steer" }): Promise<SessionChange>

  // ─── Session entries and events between extensions (pi: appendEntry, pi.events) ───

  /** Keeps a record about a session in this extension's data folder (never in the model's context or the transcript). `false` when refused (listed in /extensions). */
  appendEntry(sessionId: string, type: string, data?: Json): boolean
  /** This extension's records about a session, oldest first (the newest 1000), optionally of one type. */
  entries(sessionId: string, type?: string): SessionEntry[]
  /** Named messages between the extensions of this daemon. */
  readonly events: ExtensionEvents

  // ─── Flags (pi: registerFlag, getFlag) ───

  /** A CLI flag: `mendcode --name` (boolean) or `mendcode --name=value` (string), for the session that invocation opens or runs. */
  registerFlag(name: string, flag: ExtensionFlag): void
  /** The flag's value for a session (what its CLI invocation passed), else the flag's default. */
  getFlag(name: string, sessionId?: string): boolean | string | undefined

  // ─── MCP servers and virtual models (pi: registerMcpServer, registerVirtualModel) ───

  /** An MCP server, the same entry as one in mcp.json (a server there with the same name wins). Started like any configured server, only where MCP is on. */
  registerMcpServer(name: string, server: ExtensionMcpServer): void
  /** A model in /model that is not a model: each call goes to the real model `route` picks from `models`. User extensions only. */
  registerVirtualModel(model: ExtensionVirtualModel): void

  // ─── Dialogs from daemon hooks (pi: ctx.ui.confirm/select/input) ───

  /**
   * Questions to the user from a hook or a command. Each needs `default`, the answer used when nobody answers before `timeoutMs`
   * (default 30 s, at most 120 s), when the user dismisses it, and at once when no terminal that shows dialogs has the session open
   * (a headless run, the web, a remote client). They never block the session: a turn keeps running while one is open.
   */
  readonly ui: ExtensionDialogs
}

export type ExecResult = { stdout: string; stderr: string; code: number | null; error?: string }

/** What a session change answered: refused changes say why and change nothing. */
export type SessionChange = { ok: true } | { ok: false; error: string }

export type SessionEntry = { type: string; at: number; data?: Json }

export type ExtensionEvents = {
  /** Listens to `name` (registered during `daemon(api)`); returns the function that stops listening. `from` is the emitter's name. */
  on(name: string, listener: (data: unknown, meta: { from: string }) => unknown): () => void
  /** Sends `data` to every listener of `name` after the current call returns. */
  emit(name: string, data?: unknown): void
}

export type ExtensionFlag = { type: "boolean"; description: string; default?: boolean } | { type: "string"; description: string; default?: string }

/** An mcp.json server entry: `command` (+ `args`, `env`, `cwd`) for a local one, or `url` (+ `headers`) for a remote one. */
export type ExtensionMcpServer = { command?: string; args?: string[]; env?: Record<string, string>; cwd?: string; url?: string; transport?: "http" | "sse"; headers?: Record<string, string>; enabled?: boolean; timeoutMs?: number }

export type ExtensionVirtualModel = {
  /** Listed and picked as `virtual:<id>`. */
  id: string
  name?: string
  /** Real model ids (`/model` ids) it may route to; the first one that exists is used when `route` answers nothing usable. */
  models: string[]
  /** Picks the model for one call; synchronous, at most 50 ms of work. `role` is main, plan, subagent, compaction… */
  route?(input: { sessionId: string; cwd: string; role: string }): string | undefined
}

export type DialogOptions<T> = { default: T; timeoutMs?: number }
export type ExtensionDialogs = {
  confirm(sessionId: string, title: string, message: string, options: DialogOptions<boolean>): Promise<boolean>
  /** Up to 9 choices; the answer is one of them. */
  select(sessionId: string, title: string, choices: string[], options: DialogOptions<string>): Promise<string>
  input(sessionId: string, title: string, options: DialogOptions<string> & { placeholder?: string }): Promise<string>
}

// ─── Terminal side ──────────────────────────────────────────────────────────────────────────────────────────────

/** Theme role names the terminal resolves to colors (the same roles theme files define). */
export type ColorRole = string
export type Span = { text: string; fg?: ColorRole; bg?: ColorRole; bold?: boolean; dim?: boolean; italic?: boolean; underline?: boolean }
export type Line = Span[]
export type MessageRole = "user" | "assistant" | "tool" | "meta"
export type ExtensionTheme = Readonly<{ name: string; colors: Readonly<Record<string, string>> }>
export type MessageData = Readonly<{ role: MessageRole; text: string; itemId?: string; turnId?: string; title?: string; status?: string; at?: number; meta?: Readonly<Record<string, string | number | boolean>> }>
export type MessageContext = { message: MessageData; width: number; theme: ExtensionTheme }
export type MessageRenderer = (ctx: MessageContext) => Line[] | undefined
export type MarkdownTransformer = (text: string, ctx: MessageContext) => string
export type PromptContext = SlotContext & { text: string; lines: readonly string[]; cursor: Readonly<{ row: number; col: number }>; theme: ExtensionTheme }
export type PromptRenderer = (ctx: PromptContext) => { lines: Line[]; cursor: { row: number; col: number } } | undefined
/** Pure, synchronous menu view. Keyboard actions and execution remain owned by the terminal. Kept for `api.view("slashMenu")`; new code uses the `slash.menu` slot. */
export type SlashMenuContext = Readonly<SlashMenuModel & { width: number; height: number; ascii: boolean }>
export type SlashMenuRenderer = (ctx: SlashMenuContext) => Line[] | undefined
export type PromptChrome = { lead?: string; border?: "auto" | "single" | "rounded" | "double" | "ascii"; preset?: "box" | "top-bottom" | "minimal" | "ascii-box" }
export type ExtensionWidget = { title: string; render: SlotRenderer }

/**
 * The live figures of the open session, the same ones the footer, the activity status, the top bar and the sidebar's `stats`
 * card draw (docs/customize.md, "Session stats"). Folded from the usage events the terminal has already received: reading it asks
 * the daemon for nothing. Totals cover the loaded window of the session. A field is absent while there is nothing to say.
 */
export type SessionStats = Readonly<{
  /** Model calls counted so far. */
  calls: number
  /** Prompt tokens that were not served from the cache, and the tokens read from and written to it. */
  input: number
  cacheRead: number
  cacheWrite: number
  /** Output tokens as the provider reported them, and the reasoning tokens it reported on top (a provider may count them in `output` too). */
  output: number
  reasoning: number
  /** Share of the session's prompt tokens read from the cache, 0..100. */
  cachePercent?: number
  /** The last call's prompt size, the part of it read from the cache, and its share, 0..100. */
  lastPrompt?: number
  lastCacheRead?: number
  lastCachePercent?: number
  /** Tokens the conversation occupies after the last call, the limit it is measured against (the compaction threshold, or the engine's own window) and the share, 0..100 (may pass 100). */
  contextTokens?: number
  contextLimit?: number
  contextPercent?: number
  /** The context figure was clamped because the engine's numbers disagreed. */
  contextApprox?: boolean
  /** Estimated spend of the calls seen, in micro-USD; absent while no call had a known price. */
  costMicros?: number
  /** Output tokens per second and time to the first token of the last call that reported timing. */
  tokensPerSecond?: number
  firstTokenMs?: number
  /** Turns left before the context reaches the compaction threshold, from the last turns' growth; absent with too little history. */
  forecastTurns?: number
  /** The session's model (provider-qualified id as shown) and reasoning effort. */
  model?: string
  effort?: string
}>

/**
 * One provider quota window as MendCode last observed it, from what the provider itself sent (response headers or the engine's
 * own rate-limit events). A window MendCode has no reading for is NOT listed: an absent entry means unknown, never 0 % or 100 %.
 * `usedPercent` and `leftPercent` are whole numbers that add up to 100. `stale` is true when the observation is older than 15 minutes
 * or its window has already reset, so the numbers describe the past; `ageMs` says how long ago. Never read another program's
 * cache files for this: show an unlisted window as unavailable.
 */
export type QuotaReading = Readonly<{
  provider: string
  /** The window's length as the provider names it: `5h`, `7d`. */
  window: string
  usedPercent: number
  leftPercent: number
  /** Epoch ms the window resets, when the provider said. */
  resetsAt?: number
  /** Epoch ms of the response or event that carried the numbers, and how long ago that was at this frame. */
  observedAt: number
  ageMs: number
  stale: boolean
}>

/**
 * What MendCode knows about usage now (docs: `mendcode docs usage`), read-only and free to read, like `stats`.
 * `context` is measured against the compaction threshold (or the engine's own window), as the footer's context figure is.
 */
export type UsageSnapshot = Readonly<{
  context?: Readonly<{ usedPercent: number; tokens: number; limit: number }>
  /** Session totals over the loaded history window. */
  tokens: Readonly<{ input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number }>
  /** Estimated spend in micro-USD; absent while no call had a known price. */
  costMicros?: number
  /** The windows MendCode has a reading for, every provider it has heard from (not only the one the session runs on). */
  quota: readonly QuotaReading[]
}>

/** The terminal's width class (docs/layout.md, "Breakpoints"): compact under 70 columns, normal 70 to 109, wide 110 to 149, xl 150 and up. */
export type Breakpoint = "compact" | "normal" | "wide" | "xl"

/** What a slot renderer knows about the screen and session. Read-only snapshot per frame. */
export type SlotContext = {
  /** Cells and rows of the area this renderer draws (a slot, a page body, a modal body). */
  width: number
  height: number
  /** The width class of the whole terminal (not of `width`), the one the built-in pages switch on. */
  breakpoint: Breakpoint
  /** The terminal's size in cells. */
  screen: Readonly<{ width: number; height: number }>
  sessionId?: string
  title?: string
  directory: string
  branch?: string
  model?: string
  effort?: string
  state: "idle" | "working" | "waiting" | "offline"
  /** Context use 0–1 when known. */
  context?: number
  /** The session stats at this frame (the same value `api.stats()` returns). */
  stats: SessionStats
  /** Context, tokens and provider quota at this frame (the same value `api.usage()` returns). */
  usage: UsageSnapshot
  now: number
}

/**
 * Where a terminal extension can draw. A slot renderer returning lines replaces (`*.replace` slots) or adds to
 * (the others) what MendCode draws there; returning `undefined` keeps the default.
 */
export type SlotName =
  | "header.replace"
  | "footer.replace"
  | "footer.left"
  | "footer.right"
  | "welcome.replace"
  | "welcome.below"
  | "prompt.above"
  | "prompt.below"
  | "prompt.replace"
  | "working.replace"
  | `sidebar:${string}`

export type SlotRenderer = (ctx: SlotContext) => Line[] | undefined

/** What a tool renderer is handed for one call. Everything in it is frozen: a renderer reads, it never changes the call. */
export type ToolRenderInput = {
  readonly tool: string
  /** What follows the name in the card title: a command, a path. */
  readonly detail: string
  /**
   * The call's arguments with `detail` among them. While the call runs (or when the daemon cut long arguments) it is `{ detail }`;
   * once it finished, every argument the tool got (secrets redacted, strings over 2000 characters and lists over 100 items cut).
   */
  readonly args: Readonly<Record<string, unknown>>
  /** True when `args` holds the whole call, false while it is only `{ detail }`. */
  readonly final: boolean
  readonly output: string
  readonly status: "running" | "ok" | "error"
  readonly width: number
  readonly expanded: boolean
}

/** Draws a tool card's body for a tool (built-in or not); `undefined` falls back to the next renderer, then the default card. */
export type ToolRenderer = (input: ToolRenderInput) => Line[] | undefined

/** A full-screen page opened by a command or a key, drawn and driven by the extension. */
export type ExtensionPage = {
  title: string
  render(ctx: SlotContext): Line[]
  /** Return true when the key was handled; `close()` returns to the chat. */
  onKey?(key: string, actions: { close(): void; redraw(): void }): boolean
}

/**
 * A card drawn over the chat (or a page) with the palette's chrome: a centered panel, the title row with `esc`, your body. Opened by
 * `actions.openModal(id)` or the `modal:<id>` action; it takes the keyboard while open, like a page.
 */
export type ExtensionModal = {
  title: string
  /** The body: `ctx.width` is the card's inner width, `ctx.height` the rows it may take; called with a fresh context every frame. */
  render(ctx: SlotContext): Line[]
  /** Return true when the key was handled; an unhandled `esc` closes the modal, `ctrl+c` always does. `actions` are the terminal's, plus `close` and `redraw`. */
  onKey?(key: string, actions: TuiActions & { close(): void; redraw(): void }): boolean
  /**
   * Card width: columns (above 1) or a share of the terminal (0 to 1), or a function of the terminal that answers one, asked every frame.
   * Absent: the palette's width. Never wider than the terminal less two columns.
   */
  width?: number | ((screen: Readonly<{ width: number; height: number; breakpoint: Breakpoint }>) => number)
}

/** Display-only message chrome. The original transcript and model context stay unchanged. */
export type MessageStyle = { icon?: string; label?: boolean | string; lead?: string; tint?: boolean; layout?: "quiet" | "classic" }

export type TuiExtensionAPI = {
  readonly version: typeof EXTENSION_API_VERSION
  readonly dir: string
  slot(name: SlotName, render: SlotRenderer): void
  /**
   * `tool` is a name (`edit`, `mcp__github__create_issue`) or a pattern ending in `*` (`mcp__github__*`, `*`). For each call the
   * exact name is asked first, then the longest matching pattern, then `*`; among equals the later registration wins.
   */
  renderTool(tool: string, render: ToolRenderer): void
  messageStyle(role: MessageRole, style: MessageStyle): void
  renderMessage(role: MessageRole, render: MessageRenderer): void
  markdown(role: MessageRole, transform: MarkdownTransformer): void
  /** Transforms assistant markdown before it is drawn. */
  markdown(transform: (text: string) => string): void
  prompt: { replace(render: PromptRenderer): void; chrome(value: PromptChrome): void }
  widget(surface: "tray" | "sidebar", id: string, widget: ExtensionWidget): void
  settings: { get(): Record<string, unknown>; get(key: string): unknown; set(key: string, value: unknown): void; set(values: Record<string, unknown>): void }
  /** Runs when this copy stops (a reload, the terminal closing). A promise is awaited, up to 2 s, before the copy that replaces it starts. */
  onDispose(dispose: () => void | Promise<void>): void
  /**
   * Runs once this copy is the live one, after the copy it replaces was disposed. Start processes, sockets and timers here, not in
   * `tui()`: on a reload the new copy is loaded while the old one still runs, so starting them in `tui()` runs two at once.
   */
  onStart(start: () => void): void
  /** A key (raw sequence or name like "ctrl+g", "leader+g") that runs an action; overrides keybindings.json. */
  key(key: string, run: (actions: TuiActions) => void): void
  /** `/name` handled in the terminal (no daemon round trip). */
  command(name: string, description: string, run: (args: string, actions: TuiActions) => void): void
  page(id: string, page: ExtensionPage): void
  /** An overlay card (see `ExtensionModal`), opened with `actions.openModal(id)` or the `modal:<id>` action. */
  modal(id: string, modal: ExtensionModal): void
  /**
   * A named action: `action:<id>` in keybindings.json and `/keymap`, and a row of the palette (`title`, else the id). It runs like a
   * key does; a throw is reported and the action stays registered.
   */
  action(id: string, run: (actions: TuiActions) => void, options?: { title?: string; description?: string }): void
  /**
   * Replaces how a part of the terminal is drawn (see `views.ts` and docs/views.md): a pure synchronous function of the
   * slot's input model that returns lines, or `undefined` to keep the built-in. `"slashMenu"` is the old name of `"slash.menu"`.
   */
  view(name: "slashMenu", render: SlashMenuRenderer): void
  view<S extends ViewSlot>(slot: S, render: ViewRenderer<S>): void
  /** Asks for a redraw (after the extension's own state changed, e.g. a timer). */
  redraw(): void
  /** Comments on the passages of an answer (docs/editor.md, "Extending"). */
  comments: {
    /**
     * Reshapes the message the pending comments and the typed text become, just before it is sent. `message` is the complete envelope as
     * built; return the text to send instead, or `undefined` to keep it. Transforms run in load order; one that throws is disabled.
     */
    beforeSend(transform: (message: string, context: { readonly comments: readonly PendingComment[]; readonly note: string }) => string | undefined): void
  }
  /** The session stats now: a frozen snapshot, never null. Reading costs nothing and sends nothing to the daemon. */
  stats(): SessionStats
  /** Context, tokens and provider quota now: a read-only snapshot, nothing is sent to the daemon and no other program's files are read. */
  usage(): UsageSnapshot
  /**
   * Calls `listener` with the new stats after a model call, a compaction or a change of model, effort or context window moved a
   * figure: at most once per change, never on a timer, and always after the current frame or event handler. A listener that throws is
   * skipped and reported like any renderer. Returns the function that stops listening; listeners also stop when the extension is
   * reloaded or disabled.
   */
  onStats(listener: (stats: SessionStats) => void): () => void
}

/** One pending comment: its number in the message, the passage it is about and what the user wrote. */
export type PendingComment = Readonly<{ n: number; quote: string; text: string; itemId?: string }>

export type TuiActions = {
  submit(text: string): void
  insert(text: string): void
  openPage(id: string): void
  /** Opens an extension modal over the current screen; `closeModal` closes the open one. */
  openModal(id: string): void
  closeModal(): void
  /**
   * Opens a file of the workspace in the file viewer (docs/file-viewer.md): the right slot beside the chat, or a page on a narrow terminal.
   * `path` is relative to the session's directory or absolute; `lines` cites a range (`to` defaults to `from`). A path outside the workspace,
   * a missing file or a folder is refused with a one-line notice, nothing is read. Read-only.
   */
  openFile(path: string, lines?: { from: number; to?: number }): void
  toast(text: string, tone?: "info" | "success" | "warning" | "error"): void
  /** The pending comments on the answer: read them, or add one ("comment on this diff hunk"). `add` is false when comments are off, the words are empty or the limit is reached. */
  comments: { list(): readonly PendingComment[]; add(comment: { quote: string; text: string }): boolean }
}

// ─── Module shape ───────────────────────────────────────────────────────────────────────────────────────────────

export type Extension = {
  name: string
  daemon?(api: DaemonExtensionAPI): Awaitable<void>
  tui?(api: TuiExtensionAPI): Awaitable<void>
}

export function defineExtension(extension: Extension): Extension {
  return extension
}

/** The hello capability of a terminal that draws extension dialogs (`api.ui`); a client without it is never asked one. */
export const EXTENSION_DIALOGS_CAPABILITY = "extension-dialogs"

/** Layer-relative directory extensions are discovered in. */
export const EXTENSIONS_DIR = "extensions"
/** User keybindings: `<dataDir>/keybindings.json`, `{ "<key>": "<action>" | null }`; null unbinds a default. */
export const KEYBINDINGS_FILE = "keybindings.json"
/** Prompt overrides looked up per layer (project wins): replace or append to the built-in prompts. */
export const PROMPT_FILES = { system: "SYSTEM.md", appendSystem: "APPEND_SYSTEM.md", compaction: "COMPACTION.md" } as const
