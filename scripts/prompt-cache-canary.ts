// Opt-in, in-memory ChatGPT canary. No daemon, database, foreign login or credential refresh.
// Run on each revision: bun scripts/prompt-cache-canary.ts --live before|after [--dir <MendCode data directory>]
import { homedir } from "node:os"
import path from "node:path"
import { createIdFactory } from "@mendcode/protocol"
import { compileArgsSchema } from "../packages/tools/src/json-schema"
import { createChatgptAuth, createNativeEngine, createResponsesProvider, memoryHistory, type ModelProvider } from "../packages/engine-native/src"

const args = process.argv.slice(2)
const label = args[args.indexOf("--live") + 1]
if (!args.includes("--live") || !["before", "after"].includes(label ?? "")) {
  console.error("Usage: bun scripts/prompt-cache-canary.ts --live before|after [--dir <MendCode data directory>]")
  process.exit(2)
}
const dirAt = args.indexOf("--dir")
const dir = dirAt < 0 ? path.join(homedir(), ".mendcode-v2") : args[dirAt + 1]
if (!dir || /(^|[/\\])\.(codex|claude)([/\\]|$)/.test(path.resolve(dir))) throw new Error("A MendCode-owned data directory is required")
const auth = createChatgptAuth({ dir, fetch: async () => { throw new Error("Credential refresh is disabled for this canary") } })
function requireLogin() {
  const status = auth.status()
  if (status.state !== "authorized" || !status.expiresAt || status.expiresAt - Date.now() < 120_000) throw new Error("A valid MendCode-owned ChatGPT login is required; no fallback or refresh was attempted")
  if (auth.route() !== "codex") throw new Error("This canary requires MendCode's subscription-backend login; the plan API does not enable client tool search")
}
requireLogin()

const model = "gpt-6-luna"
const abort = new AbortController()
const timeout = setTimeout(() => abort.abort(), 120_000)
const rows: Array<{ call: number; change: string; input: number; cached: number; output: number }> = []
const toolCalls: string[] = [], executed: string[] = []
let change = "first", requests = 0, pending = "initial prefix"
const adapter = createResponsesProvider({
  id: "chatgpt", model, effort: "low", baseUrl: "https://chatgpt.com/backend-api/codex",
  headers: async () => { requireLogin(); return auth.headers() },
  fetch: async (url, init) => {
    if (requests >= 6) { abort.abort(); throw new Error("Canary request limit reached") }
    requests++
    // Only the adapter's request is forwarded; headers and bodies are never logged or saved.
    const response = await fetch(url, { ...init, redirect: "error" })
    console.log(JSON.stringify({ label, call: requests, http: response.status, changed: pending, change }))
    return response
  },
})
const provider: ModelProvider = {
  ...adapter,
  async *stream(request) {
    try {
      const called: string[] = []
      for await (const event of adapter.stream(request)) {
        if (event.type === "usage") {
          const row = { call: requests, change, input: event.usage.input + event.usage.cacheRead, cached: event.usage.cacheRead, output: event.usage.output }
          rows.push(row)
          console.log(JSON.stringify({ label, model, ...row }))
        }
        if (event.type === "tool_call") { called.push(event.call.name); toolCalls.push(event.call.name) }
        yield event
      }
      pending = called.join(", ") || "answer"
    } catch {
      abort.abort() // Do not let the engine retry an error or echo provider error bodies.
      throw new Error("Canary stopped; no automatic retry or credential change")
    }
  },
}
const engine = createNativeEngine({
  provider, history: memoryHistory(), cwdFor: () => process.cwd(), compactionPrompt: "Summarize",
  permissionPolicy: () => ({ tier: "balanced" }), modelFor: () => ({ model, effort: "low" }),
  promptPrefixTrace: (line) => { change = / change=([^ ]+)/.exec(line)?.[1] ?? "unknown"; console.log(line) },
  system: () => [
    "Follow the user's exact tool sequence, one call per response. Do not skip a repeated search. Finish with OK only.",
    ...Array.from({ length: 240 }, (_, index) => `Reference row ${index}: a stable prefix preserves earlier tool definitions and conversation items during repeated discovery.`),
  ].join("\n"),
  tools: [{
    name: "cache_probe", description: "Return a deterministic probe value without reading or writing files", permission: "read",
    args: compileArgsSchema({ type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false }).zod,
    execute: async (args) => {
      const { value } = args as { value: string }
      executed.push(value)
      return { output: value, title: "Cache probe", isError: false, truncated: false }
    },
  }],
})
const id = createIdFactory()
try {
  await engine.runTurn({
    sessionId: id("session"), turnId: id("turn"), newItemId: () => id("item"),
    text: 'First search for cache_probe. Then search for cache_probe again with exactly the same query. Then call cache_probe with value "one". Then call cache_probe with value "two". Use one tool call per response, in that order. Finally say OK.',
    attachments: [], signal: abort.signal, permissionMode: () => "full", setPermissionMode: () => {}, emit: () => {}, ask: async () => ({ kind: "deny" }),
  })
  if (abort.signal.aborted || rows.length !== 5 || requests !== 5 || (rows[0]?.input ?? 0) < 2048
    || toolCalls.join(",") !== "tool_search,tool_search,cache_probe,cache_probe" || executed.join(",") !== "one,two") {
    throw new Error("Canary did not complete the prescribed five-call scenario; do not treat it as a successful comparison")
  }
} finally {
  clearTimeout(timeout)
  console.log(JSON.stringify({ label, model, requests, input: rows.reduce((sum, row) => sum + row.input, 0), cached: rows.reduce((sum, row) => sum + row.cached, 0), output: rows.reduce((sum, row) => sum + row.output, 0) }))
}
