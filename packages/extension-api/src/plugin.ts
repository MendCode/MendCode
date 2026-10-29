import type { DaemonExtensionAPI, ExtensionToolContext, Line, SlotContext, TuiExtensionAPI } from "./index"

type Awaitable<T> = T | Promise<T>
export type PluginAuthValue = { type: "api"; key: string } | { type: "oauth"; access: string; refresh: string; expires: number; accountId?: string }
export type PluginAuthResult = { type: "failed" } | ({ type: "success"; provider?: string } & ({ key: string } | { access: string; refresh: string; expires: number; accountId?: string }))
export type PluginAuthPrompt = {
  type: "text" | "select"
  key: string
  message: string
  placeholder?: string
  options?: Array<{ label: string; value: string; hint?: string }>
  validate?(value: string): string | undefined
  condition?(inputs: Record<string, string>): boolean
  when?: { key: string; op: "eq" | "neq"; value: string }
}
export type PluginAuthMethod = { label: string; prompts?: PluginAuthPrompt[] } & (
  | { type: "api"; authorize?(inputs?: Record<string, string>): Awaitable<PluginAuthResult> }
  | { type: "oauth"; authorize(inputs?: Record<string, string>): Awaitable<{ url: string; instructions: string; method: "auto" | "code"; callback(code?: string): Awaitable<PluginAuthResult> }> }
)
export type PluginAuth = { provider: string; methods: PluginAuthMethod[]; loader?(auth: () => Promise<PluginAuthValue | undefined>, provider: Record<string, unknown>): Awaitable<Record<string, unknown>> }
/** One model of a provider an extension adds (`id` is the provider's own; MendCode lists it as `<provider>:<id>`). */
export type PluginProviderModel = { id: string; name?: string; context?: number; images?: boolean; effort?: boolean; maxOutputTokens?: number }
/**
 * A model provider. With `baseUrl` it is a whole provider MendCode calls itself (like a `providers.json` entry, docs/providers.md):
 * `type` is the wire format (default `openai-compatible`), the key comes from the environment variable `apiKeyEnv` (or the /env
 * vault), never from the module's source, and `models` lists what `/model` offers. Without `baseUrl`, `models` is a function that
 * enriches the catalog of a provider configured elsewhere (the v1 plugin hook).
 */
export type PluginProvider = {
  id: string
  name?: string
  type?: "openai" | "anthropic" | "openai-compatible" | "google" | "xai" | "mistral" | "cohere"
  baseUrl?: string
  apiKeyEnv?: string
  headers?: Record<string, string>
  models?: PluginProviderModel[] | ((provider: Record<string, unknown>, ctx: { auth?: PluginAuthValue }) => Awaitable<Record<string, Record<string, unknown>>>)
}
export type PluginTool = {
  description: string
  args: Record<string, unknown>
  permission?: "read" | "write" | "execute"
  execute(args: Record<string, unknown>, context: ExtensionToolContext & { directory: string; worktree: string; sessionID: string; callID?: string; metadata(value: Record<string, unknown>): void; ask(input: unknown): Promise<void> }): Awaitable<string | { output: string; metadata?: Record<string, unknown> }>
}
export type PluginHook = (input: Record<string, unknown>, output: Record<string, unknown>) => Awaitable<void>
export type PluginHooks = {
  tool?: Record<string, PluginTool>
  auth?: PluginAuth
  provider?: PluginProvider
  config?(config: Record<string, unknown>): Awaitable<void>
  event?(input: { event: Record<string, unknown> }): Awaitable<void>
  "chat.message"?: PluginHook
  "chat.params"?: PluginHook
  "chat.headers"?: PluginHook
  "permission.ask"?: PluginHook
  "command.execute.before"?: PluginHook
  "tool.execute.before"?: PluginHook
  "tool.execute.after"?: PluginHook
  "shell.env"?: PluginHook
  "experimental.chat.messages.transform"?: PluginHook
  "experimental.chat.system.transform"?: PluginHook
  "experimental.session.compacting"?: PluginHook
  "experimental.compaction.autocontinue"?: PluginHook
  "experimental.text.complete"?: PluginHook
  "tool.definition"?: PluginHook
}
/** Daemon adapters expose a local bridge rather than the donor's HTTP SDK or Bun shell. */
export type PluginInput = { directory: string; worktree: string; project: { id: string; worktree: string }; client: DaemonExtensionAPI; serverUrl: URL }
export type Plugin = (input: PluginInput, options?: Record<string, unknown>) => Awaitable<PluginHooks>
export type RowPluginAPI = TuiExtensionAPI & {
  app: { version: string; capabilities: string[] }
  slots: { register(input: { id?: string | number; slots: Record<string, (ctx: SlotContext) => Line[]> }): () => void }
  route: { register(routes: Array<{ name: string; title?: string; render(ctx: SlotContext): Line[] }>): () => void; navigate(name: string): void }
  lifecycle: { signal: AbortSignal; onDispose(cb: () => void): () => void }
  metadata: {
    current(): string | undefined
    list(): Promise<{ data: unknown }>
    get(input?: { sessionID?: string }): Promise<{ data: unknown }>
    getCurrent(): Promise<{ data: unknown }>
    patch(input: { sessionID?: string; patch?: Record<string, unknown> }): Promise<{ data: unknown }>
  }
}
