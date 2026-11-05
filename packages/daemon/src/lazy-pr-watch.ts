import path from "node:path"
import type { PrWatchOptions, PrWatchService } from "./pr-watch"
import { describeWatches, noWatch, parseRef } from "./pr-watch-helpers"
import { hasSavedPrWork } from "./saved-pr-work"

/** Restore saved watches before exposing synchronous ports; a fresh daemon imports nothing. */
export async function lazyPrWatch(options: PrWatchOptions): Promise<PrWatchService> {
  let service: PrWatchService | undefined
  let loading: Promise<PrWatchService> | undefined
  let stopped = false
  const load = () => loading ??= import("./pr-watch").then(({ createPrWatch }) => {
    service = createPrWatch(options)
    if (stopped) service.stop()
    return service
  })
  if (hasSavedPrWork(path.join(options.dir, "pr-watch.json"), "watches")) await load()
  return {
    tick: async () => { await service?.tick() },
    list: (sessionId) => service?.list(sessionId) ?? [],
    describe: describeWatches,
    check: async (...args) => (await load()).check(...args),
    control: async (...args) => (await load()).control(...args),
    drop: (sessionId) => { service?.drop(sessionId) },
    stop() { stopped = true; service?.stop() },
    port(sessionId) {
      return {
        preview: async (input) => (await load()).port(sessionId).preview(input),
        watch: async (input) => (await load()).port(sessionId).watch(input),
        unwatch(input) {
          if (service) return service.port(sessionId).unwatch(input)
          const ref = parseRef(input.pr)
          return ref.ok ? noWatch(input.pr) : ref
        },
        list: () => service?.port(sessionId).list() ?? describeWatches([]),
      }
    },
  }
}
