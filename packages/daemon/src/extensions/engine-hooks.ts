import type { EngineHookName, EngineHooks, ModelMessage } from "@mendcode/engine-native"
import { OUTPUT_LIMITS } from "@mendcode/tools"
import type { DaemonExtensions } from "./loader"

/**
 * The native engine's interception points, backed by the daemon's extensions. `has` is a map lookup of the scope a
 * session's project already loaded (`prepare` loads it at the start of each turn), so without handlers no await is
 * added to a tool call or model request. What a handler may mutate is a copy; the engine's history is never shared.
 */
export function createEngineHooks(extensions: DaemonExtensions): EngineHooks {
  const scopeOf = (cwd: string) => extensions.syncScope(cwd)
  const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)
  const strings = (value: unknown) => object(value) && Object.values(value).every((item) => typeof item === "string" && !/[\r\n\0]/.test(item))
  return {
    async prepare({ cwd }) {
      await extensions.ensure(cwd)
    },
    has: (hook: EngineHookName, cwd) => hook !== "permission.request" && scopeOf(cwd)?.hooks.has(hook) === true || hook === "chat.headers" && scopeOf(cwd)?.records.some((record) => record.auth !== undefined) === true,
    async toolBefore({ cwd, ...event }) {
      const scope = scopeOf(cwd)
      return scope ? extensions.bus.toolBefore(scope.records, { ...event, cwd, args: structuredClone(event.args) }) : undefined
    },
    async toolAfter({ cwd, ...event }) {
      const scope = scopeOf(cwd)
      const changed = scope ? await extensions.bus.toolAfter(scope.records, { ...event, cwd }) : undefined
      // A rewritten result obeys the same output limit as any tool.
      return changed?.output !== undefined && changed.output.length > OUTPUT_LIMITS.maxBytes ? { ...changed, output: `${changed.output.slice(0, OUTPUT_LIMITS.maxBytes)}\n… output truncated` } : changed
    },
    async system({ cwd, ...event }) {
      const scope = scopeOf(cwd)
      return scope ? extensions.bus.promptSystem(scope.records, { ...event, cwd }) : undefined
    },
    async context({ cwd, ...event }) {
      const scope = scopeOf(cwd)
      const messages = scope ? await extensions.bus.context(scope.records, { ...event, cwd }) : undefined
      return messages as ModelMessage[] | undefined
    },
    async requestBody({ cwd, ...event }) {
      const scope = scopeOf(cwd)
      return scope ? extensions.bus.requestBefore(scope.records, { ...event, cwd, body: structuredClone(event.body) }) : undefined
    },
    async compactBefore({ cwd, ...event }) {
      const scope = scopeOf(cwd)
      return scope ? extensions.bus.compactBefore(scope.records, { ...event, cwd }) : undefined
    },
    async compactAfter({ cwd, ...event }) {
      const scope = scopeOf(cwd)
      if (scope) await extensions.bus.notify(scope.records, "compact.after", { ...event, cwd })
    },
    async parameters(event) {
      return extensions.bus.transform(scopeOf(event.cwd)?.records ?? [], "chat.params", event, {}, (value) => object(value) && (value.parameters === undefined || object(value.parameters)) && (value.maxOutputTokens === undefined || typeof value.maxOutputTokens === "number" && value.maxOutputTokens > 0 && Number.isFinite(value.maxOutputTokens)))
    },
    async headers(event) {
      const loaded = await extensions.providerOptions(event.cwd, event.provider)
      const headers: Record<string, string> = strings(loaded.options.headers) ? loaded.options.headers as Record<string, string> : {}
      const key = typeof loaded.options.apiKey === "string" ? loaded.options.apiKey : loaded.auth?.type === "api" ? loaded.auth.key : loaded.auth?.access
      if (key && !headers.authorization && !headers["x-api-key"]) {
        if (event.provider === "anthropic") headers["x-api-key"] = key
        else headers.authorization = `Bearer ${key}`
      }
      return { headers: await extensions.bus.transform(scopeOf(event.cwd)?.records ?? [], "chat.headers", { ...event, headers }, headers, strings), ...(typeof loaded.options.fetch === "function" ? { fetch: loaded.options.fetch as NonNullable<import("@mendcode/engine-native").ModelRequest["fetch"]> } : {}) }
    },
    async permission(event) {
      return extensions.bus.transform(scopeOf(event.cwd)?.records ?? [], "permission.ask", event, { status: "ask" as const }, (value) => object(value) && ["ask", "deny", "allow"].includes(String(value.status)))
    },
    async environment(event) {
      return extensions.bus.transform(scopeOf(event.cwd)?.records ?? [], "shell.env", { ...event, env: {} }, {}, (value) => strings(value) && Object.keys(value as object).every((key) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)))
    },
    async definition(event) {
      return extensions.bus.transform(scopeOf(event.cwd)?.records ?? [], "tool.definition", event, { description: event.description, parameters: event.parameters }, (value) => object(value) && typeof value.description === "string" && object(value.parameters))
    },
    async textComplete(event) {
      return extensions.bus.transform(scopeOf(event.cwd)?.records ?? [], "text.complete", event, event.text, (value) => typeof value === "string")
    },
    async compactPrompt(event) {
      return extensions.bus.transform(scopeOf(event.cwd)?.records ?? [], "compact.prompt", event, event.prompt, (value) => typeof value === "string")
    },
    async compactContinue(event) {
      return extensions.bus.transform(scopeOf(event.cwd)?.records ?? [], "compact.continue", event, true, (value) => typeof value === "boolean")
    },
  }
}
