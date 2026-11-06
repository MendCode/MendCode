import type { ComputerPort, BrowserPort } from "@mendcode/tools"
import type { createComputerControl } from "./computer"
import type { createBrowserControl } from "./browser"

/** Asking for a tool port does not load native helpers; the first operation shares one control across sessions. */
export function createLazyComputerControl(...args: Parameters<typeof createComputerControl>): ReturnType<typeof createComputerControl> {
  let control: ReturnType<typeof createComputerControl> | undefined
  let loading: Promise<ReturnType<typeof createComputerControl>> | undefined
  let stopped = false
  const load = () => loading ??= import("./computer").then(({ createComputerControl }) => {
    control = createComputerControl(...args)
    // Shutdown can race the first import. A late control must never revive native operations.
    if (stopped) control.stop()
    return control
  })
  return {
    port(sessionId): ComputerPort {
      return {
        capture: async (...input) => (await load()).port(sessionId).capture(...input),
        key: async (...input) => (await load()).port(sessionId).key(...input),
        session: async (...input) => (await load()).port(sessionId).session!(...input),
        observe: async (...input) => (await load()).port(sessionId).observe!(...input),
        code: async (...input) => (await load()).port(sessionId).code!(...input),
      }
    },
    stop() { stopped = true; control?.stop() },
  }
}

/** Session cleanup and an idle shutdown do not import the browser or start its driver. */
export function createLazyBrowserControl(...args: Parameters<typeof createBrowserControl>): ReturnType<typeof createBrowserControl> {
  let control: ReturnType<typeof createBrowserControl> | undefined
  let loading: Promise<ReturnType<typeof createBrowserControl>> | undefined
  let stopped = false
  const load = () => loading ??= import("./browser").then(async ({ createBrowserControl }) => {
    control = createBrowserControl(...args)
    if (stopped) await control.stop()
    return control
  })
  return {
    port(sessionId): BrowserPort {
      return { run: async (...input) => (await load()).port(sessionId).run(...input) }
    },
    count: () => control?.count() ?? 0,
    async forget(sessionId) { if (loading) await (await loading).forget(sessionId) },
    async stop() { stopped = true; if (loading) await (await loading).stop() },
  }
}
