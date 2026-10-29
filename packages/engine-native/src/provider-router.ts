import { splitModelId } from "./provider-presets"
import type { ModelEvent, ModelProvider, ModelRequest } from "./provider"

type Table = Record<string, ModelProvider | undefined>

/**
 * One provider that sends each call to the provider named in its model id (`<providerId>:<model>`, split at the first
 * colon so `openrouter:google/gemini-3-pro` and `ollama:llama3:8b` both work). A model id without a namespace (every
 * ChatGPT subscription model, and every session or setting saved before providers existed) goes to `fallback`
 * unchanged. A namespace nobody registered is an error, never a silent call to the subscription with a foreign id.
 *
 * `providers` may be a function, asked on every call, so providers added, edited or disabled while the daemon runs
 * apply from the next model call.
 */
export function createProviderRouter(input: { fallback: ModelProvider; providers: Table | (() => Table) }): ModelProvider {
  const { fallback } = input
  const table = () => (typeof input.providers === "function" ? input.providers() : input.providers)
  /** The provider of the latest call, which a network wait probes (the host that just failed is the one to watch). */
  let latest: ModelProvider = fallback
  const target = (model: string | undefined) => {
    const split = model ? splitModelId(model) : undefined
    return split ? { split, provider: table()[split.providerId] } : undefined
  }
  const selected = (model: string | undefined) => {
    const routed = target(model)
    return routed ? { provider: routed.provider, model: routed.split.model } : { provider: fallback, model }
  }
  return {
    id: fallback.id,
    model: fallback.model,
    idFor: (model) => {
      const routed = target(model)
      return routed?.provider ? routed.split.providerId : (fallback.idFor?.(model) ?? fallback.id)
    },
    async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
      const routed = target(request.model)
      if (!routed) {
        latest = fallback
        yield* fallback.stream(request)
        return
      }
      if (!routed.provider) throw new Error(`[PROVIDER]: no provider "${routed.split.providerId}" for model ${request.model}; add it with providers.set or pick another model`)
      latest = routed.provider
      yield* routed.provider.stream({ ...request, model: routed.split.model })
    },
    // A provider that cannot be probed is not reported online: its network wait runs its normal delay. Streams of other sessions
    // move `latest`, so the waiting call names its own model.
    probe: (model) => {
      const provider = model === undefined ? latest : selected(model).provider
      return provider?.probe ? provider.probe() : Promise.resolve(false)
    },
    compactionLimits: (model) => {
      const choice = selected(model)
      return choice.provider?.compactionLimits?.(choice.model) ?? {}
    },
    nativeBinding: async (model) => {
      const choice = selected(model)
      return choice.provider?.nativeBinding?.(choice.model)
    },
    compact: async (request) => {
      const choice = selected(request.model)
      if (!choice.provider?.compact) throw new Error("Native compaction is unavailable for this provider")
      return choice.provider.compact({ ...request, ...(choice.model ? { model: choice.model } : {}) })
    },
    cacheBinding: async (model) => {
      const choice = selected(model)
      return choice.provider?.cacheBinding?.(choice.model)
    },
  }
}
