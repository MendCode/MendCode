import { chmodSync, mkdirSync } from "node:fs"
import path from "node:path"
import { chatgptQuota, type ModelEvent, type ModelRequest } from "@mendcode/engine-native"
import type { ModelInfo } from "@mendcode/protocol"
import { claudeAlias } from "./claude-models"
import type { RefreshProbe } from "./quota-refresh"

/**
 * What each quota probe sends (docs/usage-limit.md, "Quota refresh"). The smallest request that makes the provider report its windows,
 * through the path the provider's turns already use, with credentials MendCode already holds. Each probe is a plain function the
 * schedule (quota-refresh.ts) calls; none is a session, none is stored, shown or counted in a session's usage.
 */

/**
 * The folder the `claude` and `codex` probe processes start in: empty, private (0700) and inside the data dir, never a project and never
 * the home. A process started in a project would load that project's instructions, settings, hooks and MCP servers on every probe.
 */
export function quotaProbeDir(dataDir: string): string {
  const dir = path.join(dataDir, "quota-probe")
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  return dir
}

/** The whole system prompt of a native probe, and its single user message. */
export const PROBE_SYSTEM = "Reply with one word."
export const PROBE_PROMPT = "."
/** The adapter raises any smaller cap to 16 (openai-responses.ts), so 16 is the least a native probe can ask for. */
export const PROBE_MAX_OUTPUT_TOKENS = 16

const CHEAP_MODEL = /(^|[-_.:\s])(nano|mini|luna|lite|flash|haiku)([-_.:\s]|$)/i
/** The cheapest model of a catalogue by its name (the catalogue carries no prices): the first small tier it lists, or none to let the provider pick its default. */
export function cheapestModel(models: readonly Pick<ModelInfo, "id">[]): string | undefined {
  return models.find((model) => CHEAP_MODEL.test(model.id))?.id
}

/** The lowest effort a model takes, so the probe reasons as little as the model allows. */
const lowestEffort = (model: ModelInfo | undefined) => (["minimal", "low"] as const).find((effort) => model?.efforts.includes(effort))

/** The request of a native probe: one short message, no tools, a tiny answer. Exported so the shape is pinned by a test. */
export function nativeProbeRequest({ model, effort, signal }: { model?: string | undefined; effort?: ModelRequest["effort"]; signal: AbortSignal }): ModelRequest {
  return {
    system: PROBE_SYSTEM,
    messages: [{ role: "user", content: PROBE_PROMPT }],
    tools: [],
    maxOutputTokens: PROBE_MAX_OUTPUT_TOKENS,
    cacheMode: "off",
    ...(model ? { model, effort } : {}),
    signal,
  }
}

/**
 * Native engine, ChatGPT login: one request whose response headers (`x-codex-*`) carry the 5h and weekly windows, the same numbers
 * every real turn reports. A model with a namespace (`provider:model`) is an API-key provider, which reports no windows: refused.
 */
export function nativeCodexProbe(deps: {
  /** A provider on the ChatGPT subscription that calls `onHeaders` with every response's headers. */
  provider(onHeaders: (headers: Headers) => void): { stream(request: ModelRequest): AsyncIterable<ModelEvent> }
  models(): readonly ModelInfo[]
  now(): number
}): RefreshProbe {
  return async ({ model, signal, report }) => {
    const catalogue = deps.models()
    const chosen = model ?? cheapestModel(catalogue)
    if (chosen?.includes(":")) throw new Error(`[PROBE]: ${chosen} is not a ChatGPT model, so it reports no windows`)
    let reported = false
    const provider = deps.provider((headers) => {
      const quota = chatgptQuota(headers, deps.now())
      if (quota) { reported = true; report(quota) }
    })
    const info = catalogue.find((entry) => entry.id === chosen)
    for await (const event of provider.stream(nativeProbeRequest({ model: chosen, effort: lowestEffort(info), signal }))) if (event.type === "finish") break
    if (!reported) throw new Error("[PROBE]: the response carried no rate-limit headers")
  }
}

type ClaudeProbeFn = (input: { model: string; cwd: string; bin: string; env?: Record<string, string> | undefined; signal: AbortSignal; onQuota(snapshot: Parameters<Parameters<RefreshProbe>[0]["report"]>[0]): void }) => Promise<void>

/**
 * Claude Code: one throwaway `claude` process running one minimal turn on Haiku (Claude Code's own prompt plus one word) with every tool
 * off; its `rate_limit_event` carries the windows. Haiku unless the user named another model. It runs in the probe's own empty directory,
 * never in a project: Claude Code loads the CLAUDE.md, settings, hooks and MCP servers of the folder it starts in.
 */
export function claudeCodeProbe(deps: { bin: string; dataDir: string; env?: () => Record<string, string> | undefined; run?: ClaudeProbeFn }): RefreshProbe {
  return async ({ model, signal, report }) => {
    const run = deps.run ?? (async (input) => (await import("@mendcode/engine-claude")).probeClaudeQuota(input))
    await run({ model: claudeAlias({ model: model ?? "claude-haiku" }).model, cwd: quotaProbeDir(deps.dataDir), bin: deps.bin, env: deps.env?.(), signal, onQuota: report })
  }
}

type CodexProbeFn = (input: { bin: string; cwd: string; onQuota(snapshot: Parameters<Parameters<RefreshProbe>[0]["report"]>[0]): void }) => Promise<void>

/** Codex engine: `account/rateLimits/read` on a throwaway `codex app-server`, started in the probe's own empty directory. It sends nothing to a model, so a probe costs no quota. */
export function codexAppServerProbe(deps: { bin: string; dataDir: string; run?: CodexProbeFn }): RefreshProbe {
  return async ({ signal, report }) => {
    const run = deps.run ?? (async (input) => (await import("@mendcode/engine-codex")).probeCodexQuota(input))
    if (signal.aborted) throw new Error("[PROBE]: cancelled")
    await run({ bin: deps.bin, cwd: quotaProbeDir(deps.dataDir), onQuota: report })
  }
}
