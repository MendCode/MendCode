import type { LoopService } from "@mendcode/loops"

/** The empty service answers synchronous readers without importing the scheduler. Mutations await load first. */
export function createLazyLoops(create: () => Promise<LoopService>, start = true) {
  let loaded: LoopService | undefined
  let loading: Promise<LoopService> | undefined
  let disposed = false
  const load = () => loading ??= create().then((value) => {
    loaded = value
    if (disposed) value.dispose()
    else if (start) value.start()
    return value
  })
  const ready = () => {
    if (!loaded) throw new Error("Loop service must be loaded before mutation")
    return loaded
  }
  const service: LoopService = {
    create: (input) => ready().create(input),
    list: (directory) => loaded?.list(directory) ?? [],
    get: (id) => loaded?.get(id),
    forSession: (id) => loaded?.forSession(id),
    reportOnlySession: (id) => loaded?.reportOnlySession(id) ?? false,
    observe: (event) => loaded?.observe(event),
    update: (id, patch) => ready().update(id, patch),
    pause: (id) => loaded?.pause(id),
    accept: (id, reason) => ready().accept(id, reason),
    review: (id, input) => ready().review(id, input),
    resume: (id) => ready().resume(id),
    activate: (id, reason) => ready().activate(id, reason),
    fire: (id, note) => ready().fire(id, note),
    stop: (id) => ready().stop(id),
    runNow: (id) => ready().runNow(id),
    tick: async (input) => (await load()).tick(input),
    remove: (id) => ready().remove(id),
    start: () => ready().start(),
    dispose() { disposed = true; loaded?.dispose() },
  }
  return { service, load }
}
