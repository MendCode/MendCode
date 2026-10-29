import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { ModelMetadata, type ProviderModel } from "@mendcode/protocol"
import type { Fetch } from "@mendcode/engine-native"

export const MODELS_DEV_URL = "https://models.dev/api.json"
const CACHE_FILE = "models-dev-cache.json"
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 20_000
const MAX_BYTES = 16 * 1024 * 1024

/** What the cache keeps of a models.dev entry: the reasoning controls and the price, nothing that changes which models a provider lists. */
type Facts = Pick<ProviderModel, "reasoning" | "reasoning_options" | "cost">
const KEPT = ["reasoning", "reasoning_options", "cost"] as const

/**
 * A copy of models.dev's catalog, cut to the reasoning controls and prices, that names the levels a provider's models (and an
 * ACP agent's, OpenCode's ids being models.dev's `provider/model`) offer in /model and F3. It only adds facts to models a provider
 * or agent already lists; a hand-written `models.dev.json` in the data directory still decides a provider's list (docs/providers.md).
 * It is fetched in the background when missing or a week old, never on the way to a frame or a turn.
 */
export function createModelsDev(options: { dir: string; fetch?: Fetch; now?: () => number; log?(message: string): void }) {
  const file = path.join(options.dir, CACHE_FILE)
  const now = options.now ?? Date.now
  let cache: { stamp: number; providers: Record<string, Record<string, Facts>> } | undefined
  let refreshing: Promise<boolean> | undefined

  function read(): Record<string, Record<string, Facts>> {
    let stamp: number
    try { stamp = statSync(file).mtimeMs } catch { return {} }
    if (cache?.stamp === stamp) return cache.providers
    try { cache = { stamp, providers: JSON.parse(readFileSync(file, "utf8")) } } catch { cache = { stamp, providers: {} } }
    return cache.providers
  }

  function stale(): boolean {
    try { return now() - statSync(file).mtimeMs > MAX_AGE_MS } catch { return true }
  }

  async function download(): Promise<boolean> {
    try {
      const response = await (options.fetch ?? fetch)(MODELS_DEV_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const text = await response.text()
      if (text.length > MAX_BYTES) throw new Error(`${text.length} bytes`)
      const providers: Record<string, Record<string, Facts>> = {}
      for (const [provider, value] of Object.entries(JSON.parse(text) as Record<string, { models?: Record<string, Record<string, unknown>> }>)) {
        for (const [model, entry] of Object.entries(value?.models ?? {})) {
          // models.dev writes `null` for a field it has no value for: absent, not invalid.
          const parsed = ModelMetadata.pick({ reasoning: true, reasoning_options: true, cost: true }).safeParse(Object.fromEntries(KEPT.flatMap((key) => (entry?.[key] === null || entry?.[key] === undefined ? [] : [[key, entry[key]]]))))
          if (parsed.success && Object.keys(parsed.data).length) (providers[provider] ??= {})[model] = parsed.data
        }
      }
      mkdirSync(options.dir, { recursive: true })
      const temporary = `${file}.${process.pid}.tmp`
      writeFileSync(temporary, JSON.stringify(providers))
      renameSync(temporary, file)
      cache = undefined
      return true
    } catch (error) {
      options.log?.(`models.dev catalog not refreshed: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }

  return {
    /** The facts models.dev has for one of a provider's models, if any. */
    facts(provider: string, model: string): Facts | undefined {
      return read()[provider]?.[model]
    },
    /** Fetches the catalog when it is missing or a week old (`force`: always); one download at a time. */
    refresh(force = false): Promise<boolean> {
      if (!force && !stale()) return Promise.resolve(false)
      return (refreshing ??= download().finally(() => { refreshing = undefined }))
    },
  }
}
export type ModelsDev = ReturnType<typeof createModelsDev>
