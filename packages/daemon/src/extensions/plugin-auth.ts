import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"
import type { PluginAuth, PluginAuthResult, PluginAuthValue, PluginProvider } from "@mendcode/extension-api/plugin"
import { record } from "@mendcode/extension-api/plugin-files"
import type { ExtensionRecord } from "./types"
import type { HookBus } from "./hooks"

type Entry = { record: ExtensionRecord; auth: PluginAuth }
export function createPluginAuth(dataDir: string, bus: HookBus) {
  const file = path.join(dataDir, "plugin-auth.json")
  const pending = new Map<string, { directory: string; provider: string; version: number; owner: ExtensionRecord; expires: number; method: "auto" | "code"; callback(code?: string): Promise<PluginAuthResult> | PluginAuthResult }>()
  const versions = new Map<string, number>()
  function read(): Record<string, PluginAuthValue> {
    try { return JSON.parse(readFileSync(file, "utf8")) as Record<string, PluginAuthValue> } catch { return {} }
  }
  function save(provider: string, value: PluginAuthValue) {
    mkdirSync(dataDir, { recursive: true })
    const tmp = `${file}.${randomUUID()}.tmp`
    writeFileSync(tmp, `${JSON.stringify({ ...read(), [provider]: value }, null, 2)}\n`, { mode: 0o600 })
    chmodSync(tmp, 0o600)
    renameSync(tmp, file)
  }
  function finish(provider: string, result: unknown) {
    if (!record(result) || result.type !== "success") return { authenticated: false }
    if (result.provider !== undefined && result.provider !== provider) throw new Error("plugin cannot authenticate another provider")
    if (typeof result.key === "string" && result.key) save(provider, { type: "api", key: result.key })
    else if (typeof result.access === "string" && result.access && typeof result.refresh === "string" && typeof result.expires === "number" && Number.isFinite(result.expires)) save(provider, { type: "oauth", access: result.access, refresh: result.refresh, expires: result.expires, ...(typeof result.accountId === "string" ? { accountId: result.accountId } : {}) })
    else throw new Error("plugin returned invalid credentials")
    return { authenticated: true }
  }
  return {
    set(provider: string, value: PluginAuthValue) {
      versions.set(provider, (versions.get(provider) ?? 0) + 1)
      for (const [id, flow] of pending) if (flow.provider === provider) pending.delete(id)
      save(provider, value)
    },
    remove(provider: string) {
      versions.set(provider, (versions.get(provider) ?? 0) + 1)
      for (const [id, flow] of pending) if (flow.provider === provider) pending.delete(id)
      const data = read()
      if (!Object.hasOwn(data, provider)) return
      const { [provider]: _removed, ...rest } = data
      mkdirSync(dataDir, { recursive: true })
      const tmp = `${file}.${randomUUID()}.tmp`
      writeFileSync(tmp, `${JSON.stringify(rest, null, 2)}\n`, { mode: 0o600 })
      renameSync(tmp, file)
    },
    methods(entries: Entry[]) {
      return entries.map(({ auth }) => ({ provider: auth.provider, authenticated: Boolean(read()[auth.provider]), methods: auth.methods.map((method, index) => ({ index, type: method.type, label: method.label, prompts: (method.prompts ?? []).map(({ validate: _validate, condition: _condition, ...prompt }) => prompt) })) }))
    },
    async start(entry: Entry, directory: string, index: number, inputs: Record<string, string>) {
      const { auth, record: owner } = entry
      const version = versions.get(auth.provider) ?? 0
      const method = auth.methods[index]
      if (!method) throw new Error("unknown plugin auth method")
      for (const prompt of method.prompts ?? []) {
        if (prompt.when && (inputs[prompt.when.key] === prompt.when.value) !== (prompt.when.op === "eq")) continue
        if (prompt.condition && !prompt.condition(inputs)) continue
        const error = prompt.validate?.(inputs[prompt.key] ?? "")
        if (error) throw new Error("invalid plugin auth input")
        if (prompt.type === "select" && !prompt.options?.some((option) => option.value === inputs[prompt.key])) throw new Error("invalid plugin auth selection")
      }
      const started = await bus.guard(owner, "auth.authorize", () => method.authorize ? method.authorize(inputs) : { type: "success", key: inputs.key ?? "" })
      if (!started.ok) throw new Error("plugin authorization failed; see /extensions")
      if ((versions.get(auth.provider) ?? 0) !== version) throw new Error("plugin authorization cancelled")
      if (method.type === "api") return finish(auth.provider, started.value)
      const result: unknown = started.value
      if (!record(result) || typeof result.url !== "string" || typeof result.instructions !== "string" || typeof result.callback !== "function" || !["auto", "code"].includes(String(result.method))) throw new Error("invalid plugin OAuth flow")
      const url = new URL(result.url)
      if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new Error("invalid plugin authorization URL")
      for (const [key, item] of pending) if (item.expires < Date.now()) pending.delete(key)
      if (pending.size >= 32) throw new Error("too many pending plugin logins")
      const flowId = randomUUID()
      pending.set(flowId, { directory, provider: auth.provider, version, owner, expires: Date.now() + 10 * 60_000, method: result.method as "auto" | "code", callback: result.callback as (code?: string) => Promise<PluginAuthResult> })
      return { authenticated: false, flowId, url: url.href, instructions: result.instructions.slice(0, 4000), method: result.method }
    },
    async complete(directory: string, flowId: string, code?: string) {
      const flow = pending.get(flowId)
      if (!flow || flow.directory !== directory || flow.expires < Date.now()) throw new Error("plugin login expired or not found")
      pending.delete(flowId)
      if (flow.method === "code" && !code?.trim()) throw new Error("authorization code required")
      const result = await bus.guard(flow.owner, "auth.callback", () => flow.callback(code))
      if (!result.ok) throw new Error("plugin login callback failed; see /extensions")
      if ((versions.get(flow.provider) ?? 0) !== flow.version) throw new Error("plugin authorization cancelled")
      return finish(flow.provider, result.value)
    },
    async options(entry: Entry | undefined, provider: { record: ExtensionRecord; provider: PluginProvider } | undefined, info: Record<string, unknown>) {
      const auth = typeof info.id === "string" ? read()[info.id] : undefined
      const loaded = entry?.auth.loader ? await bus.guard(entry.record, "auth.loader", () => entry.auth.loader!(async () => auth, info)) : undefined
      const options = loaded?.ok && record(loaded.value) ? loaded.value : {}
      const hook = provider?.provider.models
      const models = provider && typeof hook === "function" ? await bus.guard(provider.record, "auth.models", () => hook(info, auth ? { auth } : {})) : undefined
      return { options, ...(models?.ok && record(models.value) ? { models: models.value } : {}), ...(auth && entry ? { auth } : {}) }
    },
    invalidate() { pending.clear() },
  }
}
