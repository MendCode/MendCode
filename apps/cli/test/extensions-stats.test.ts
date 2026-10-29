import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { createIdFactory } from "@mendcode/protocol"
import { appHarness, extension, scratch } from "./extensions-harness"

const made: Array<ReturnType<typeof scratch>> = []
const store = globalThis as unknown as { __ext?: Record<string, unknown> }
const ids = createIdFactory()
function layout() {
  const next = scratch()
  made.push(next)
  store.__ext = {}
  return next
}
afterEach(() => {
  for (const item of made.splice(0)) item.cleanup()
  delete store.__ext
})

const EXAMPLE = readFileSync(path.join(import.meta.dir, "../../../examples/extensions/cache-ctx.ts"), "utf8")

type Harness = Awaited<ReturnType<typeof appHarness>>
/** One finished model call: `cacheRead` of the prompt came from the cache, the window is 100,000 tokens. */
function call(h: Harness, { input, cacheRead, output = 0 }: { input: number; cacheRead: number; output?: number }) {
  h.event({ type: "usage.recorded", turnId: ids("turn"), provider: "p", model: "gpt-6-luna", input, output, reasoning: 0, cacheRead, cacheWrite: 0, contextWindow: 100_000 })
  h.app.render()
}

describe("api.stats() and api.onStats()", () => {
  test("the example draws `cache 99% · ctx 21%` in the footer and follows the next call", async () => {
    const { dataDir, write } = layout()
    write("data/extensions/cache-ctx.ts", EXAMPLE)
    const h = await appHarness({ dataDir, width: 100, mode: "full" })
    await h.start()
    h.message("question", "answer")
    expect(h.text()).not.toContain("cache ")
    call(h, { input: 200, cacheRead: 20_800 })
    await Bun.sleep(5)
    h.app.render()
    expect(h.text()).toContain("cache 99% · ctx 21%")
    call(h, { input: 5_000, cacheRead: 20_800 })
    await Bun.sleep(5)
    h.app.render()
    expect(h.text()).toContain("cache 89% · ctx 26%")
  })

  test("stats() is a frozen snapshot that keeps its identity until a figure moves; onStats runs once per change, after the event, and stops on disposal", async () => {
    const { dataDir, write } = layout()
    write("data/extensions/probe.ts", extension("probe", `
      const seen = globalThis.__ext
      seen.first = api.stats()
      seen.frozen = Object.isFrozen(api.stats())
      seen.same = api.stats() === api.stats()
      seen.heard = []
      seen.stop = api.onStats((stats) => seen.heard.push(stats.cacheRead))
      api.onDispose(() => { seen.disposed = true })
    `))
    const h = await appHarness({ dataDir, width: 100 })
    await h.start()
    const seen = store.__ext as { first: { calls: number }; frozen: boolean; same: boolean; heard: number[]; stop: () => void }
    expect(seen.first).toMatchObject({ calls: 0, cacheRead: 0 })
    expect(seen.frozen).toBe(true)
    expect(seen.same).toBe(true)
    call(h, { input: 1, cacheRead: 100 })
    expect(seen.heard).toEqual([])
    await Bun.sleep(5)
    expect(seen.heard).toEqual([100])
    seen.stop()
    call(h, { input: 1, cacheRead: 200 })
    await Bun.sleep(5)
    expect(seen.heard).toEqual([100])
  })

  test("a listener that throws is reported once and the other extensions still hear the change", async () => {
    const { dataDir, write } = layout()
    write("data/extensions/a-throws.ts", extension("a-throws", `api.onStats(() => { throw new Error("listener failed") })`))
    write("data/extensions/b-hears.ts", extension("b-hears", `globalThis.__ext.heard = 0; api.onStats(() => { globalThis.__ext.heard++ })`))
    const h = await appHarness({ dataDir, width: 100 })
    await h.start()
    call(h, { input: 1, cacheRead: 100 })
    await Bun.sleep(5)
    expect((store.__ext as { heard: number }).heard).toBe(1)
    call(h, { input: 1, cacheRead: 300 })
    await Bun.sleep(5)
    expect((store.__ext as { heard: number }).heard).toBe(2)
  })

  test("slot renderers see the same figures as ctx.stats", async () => {
    const { dataDir, write } = layout()
    write("data/extensions/slot.ts", extension("slot", `api.slot("footer.right", (ctx) => [[{ text: "S:" + ctx.stats.cacheRead + "/" + api.stats().cacheRead, fg: "muted" }]])`))
    const h = await appHarness({ dataDir, width: 100, mode: "full" })
    await h.start()
    h.message("question", "answer")
    call(h, { input: 1, cacheRead: 100 })
    expect(h.text()).toContain("S:100/100")
  })
})
