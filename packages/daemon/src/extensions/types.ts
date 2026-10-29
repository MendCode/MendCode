import type { DaemonHookName, ExtensionCommand, ExtensionTool } from "@mendcode/extension-api"

/** Where an extension module came from: a user/project folder of its own, or an installed package (builtin included). */
export type ExtensionOrigin = "user" | "project" | "package"

/** The most errors kept per extension; the rest are dropped (the first ones explain the rest). */
export const MAX_EXTENSION_ERRORS = 20

/** Consecutive failures (throw, rejection, timeout, wrong shape) after which a handler or command is not called again this session. */
export const BREAKER_THRESHOLD = 3

/** Hooks that rewrite what the model reads by an amount nobody measures; `/extensions` flags them next to the measured tool cost. */
export const CONTEXT_REWRITE_HOOKS = ["prompt.system", "context", "request.before"] as const

/** Every hook name at runtime. The type check below fails when the contract gains a hook this list misses. */
export const DAEMON_HOOKS = ["input", "session.start", "turn.start", "turn.end", "tool.before", "tool.after", "prompt.system", "context", "request.before", "compact.before", "compact.after", "chat.params", "chat.headers", "permission.ask", "shell.env", "tool.definition", "text.complete", "compact.prompt", "compact.continue", "command.before", "event"] as const satisfies readonly DaemonHookName[]
const _allHooksListed: Exclude<DaemonHookName, (typeof DAEMON_HOOKS)[number]> extends never ? true : never = true
void _allHooksListed

export type HookHandler = (event: never) => unknown

/** One loaded (or refused, or failed) extension module, with everything it registered. */
export type ExtensionRecord = {
  /** The extension's own name; the file's name when the module did not load. */
  name: string
  origin: ExtensionOrigin
  /** The package that ships the extension, for `origin: "package"`. */
  pkg?: string
  /** Which side of the trust line the layer is on: `project` layers load only in trusted directories. */
  layer: "user" | "project"
  file: string
  /** The extension's folder (`extensions/<name>/`) or the `extensions/` folder holding a single file. */
  dir: string
  daemon: boolean
  tui: boolean
  trusted: boolean
  handlers: Map<DaemonHookName, HookHandler[]>
  tools: Map<string, ExtensionTool>
  commands: Map<string, ExtensionCommand>
  errors: string[]
  /** Set once an error of this extension was written to the log (one log line per extension). */
  logged: boolean
  /** Registrations after `daemon(api)` returned (or timed out) are refused. */
  sealed: boolean
  /** Circuit breaker by handler (`tool.before#0`) or command (`/name`): consecutive failures, and whether the handler is stopped for the session. */
  breaker: Map<string, { fails: number; open: boolean }>
  /** Turned off by the user (`extensions.disable`): listed, nothing imported or run. */
  disabled?: boolean
  /** A reload failed and this record is the previous working version; the failure, for `/extensions`. */
  kept?: string
  pluginId?: string
  abi?: "v1-adapter" | "tool-module"
  auth?: import("@mendcode/extension-api/plugin").PluginAuth
  provider?: import("@mendcode/extension-api/plugin").PluginProvider
  /** The project a project-layer module was loaded for: the only one whose sessions it may act on. */
  scopeDir?: string
  /** `api.events.on` listeners by event name. */
  listeners?: Map<string, Array<(data: unknown, meta: { from: string }) => unknown>>
  /** `api.registerFlag` declarations by name. */
  flags?: Map<string, import("@mendcode/extension-api").ExtensionFlag>
  /** `api.registerMcpServer` entries by server name. */
  mcpServers?: Map<string, import("@mendcode/extension-api").ExtensionMcpServer>
  /** Dialogs (`api.ui`) of this extension waiting on the user, and when the last one ended: a hook waiting on one is not timed out. */
  waiting?: number
  waitEnded?: number
  /** `api.registerVirtualModel` models. */
  virtualModels?: import("@mendcode/extension-api").ExtensionVirtualModel[]
}

export type ExtensionLog = (level: "info" | "warn" | "error", message: string) => void
