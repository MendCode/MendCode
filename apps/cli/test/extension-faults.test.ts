import { afterEach, describe, expect, test } from "bun:test"
import { claimExtensionFault } from "../src/extensions/fault"
import { discoverExtensions } from "../src/extensions/discover"
import { createExtensionRuntime } from "../src/extensions/runtime"
import { extension, scratch } from "./extensions-harness"

const dirs: Array<ReturnType<typeof scratch>> = []
const runtimes: Array<ReturnType<typeof createExtensionRuntime>> = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.dispose()
  for (const made of dirs.splice(0)) made.cleanup()
  delete (globalThis as { __faultLog?: string[] }).__faultLog
})

const ctx = { width: 40, height: 3 } as never
const tick = () => new Promise((resolve) => setTimeout(resolve, 20))

async function boot(files: Record<string, string>) {
  const made = scratch()
  dirs.push(made)
  for (const [name, source] of Object.entries(files)) made.write(`data/extensions/${name}`, source)
  const toasts: string[] = []
  const runtime = createExtensionRuntime({ redraw() {}, onProblem: (problem) => toasts.push(`${problem.extension}: ${problem.message}`) })
  runtimes.push(runtime)
  await runtime.load(discoverExtensions({ dataDir: made.dataDir }))
  return { runtime, toasts, made }
}

const footer = `api.slot("footer.replace", () => [[{ text: "CUSTOM-FOOTER" }]])`

describe("an extension that throws never takes the app down", () => {
  test("a sync throw in onStart disables that extension and leaves the other one running", async () => {
    const { runtime, toasts } = await boot({
      "bad.ts": extension("bad", `${footer}\napi.onStart(() => { throw new ReferenceError("readFile is not defined") })`),
      "good.ts": extension("good", `api.slot("header.replace", () => [[{ text: "GOOD-HEADER" }]])`),
    })
    runtime.start()
    expect(toasts).toEqual(["bad: start failed: ReferenceError: readFile is not defined"])
    expect(runtime.slot("footer.replace", ctx)).toBeUndefined()
    expect(runtime.slot("header.replace", ctx)?.[0]?.[0]?.text).toBe("GOOD-HEADER")
  })

  test("an async onStart that rejects is attributed to the extension and its footer falls back", async () => {
    const { runtime, toasts } = await boot({ "weekly.ts": extension("weekly", `${footer}\napi.onStart(async () => { await 0; throw new ReferenceError("readFile is not defined") })`) })
    runtime.start()
    await tick()
    expect(toasts).toEqual(["weekly: start failed: ReferenceError: readFile is not defined"])
    expect(runtime.slot("footer.replace", ctx)).toBeUndefined()
  })

  test("a promise onStart fires and forgets (void) is claimed by the process-level hook, by the file it was thrown in", async () => {
    const { runtime, toasts } = await boot({
      "weekly.ts": extension("weekly", `${footer}\nasync function refresh() { await 0; throw new ReferenceError("readFile is not defined") }\napi.onStart(() => { globalThis.__faultError = refresh().catch((error) => error) })`),
    })
    runtime.start()
    const error = await (globalThis as unknown as { __faultError: Promise<unknown> }).__faultError
    expect(claimExtensionFault(error)).toBe(true)
    expect(toasts).toEqual(["weekly: background work failed: ReferenceError: readFile is not defined"])
    expect(runtime.slot("footer.replace", ctx)).toBeUndefined()
    // A second error from the same extension (its timer keeps firing) is claimed without another notice.
    expect(claimExtensionFault(error)).toBe(true)
    expect(toasts).toHaveLength(1)
  })

  test("a throw inside an extension timer is claimed", async () => {
    const { runtime, toasts } = await boot({ "ticker.ts": extension("ticker", `${footer}\nglobalThis.__faultTimer = new Promise((resolve) => setTimeout(() => { try { null.boom } catch (error) { resolve(error) } }, 1))`) })
    const error = await (globalThis as unknown as { __faultTimer: Promise<unknown> }).__faultTimer
    expect(claimExtensionFault(error)).toBe(true)
    expect(toasts[0]).toStartWith("ticker: background work failed: TypeError")
    expect(runtime.slot("footer.replace", ctx)).toBeUndefined()
  })

  test("MendCode's own errors and other code are not claimed", async () => {
    const { runtime, toasts } = await boot({ "calm.ts": extension("calm", footer) })
    expect(claimExtensionFault(new Error("from MendCode"))).toBe(false)
    expect(claimExtensionFault("a string")).toBe(false)
    const own = new Error("in the test file")
    expect(claimExtensionFault(own)).toBe(false)
    expect(toasts).toEqual([])
    expect(runtime.slot("footer.replace", ctx)?.[0]?.[0]?.text).toBe("CUSTOM-FOOTER")
  })

  test("a throwing slot renderer is disabled and the default shows", async () => {
    const { runtime, toasts } = await boot({ "slotty.ts": extension("slotty", `api.slot("footer.replace", () => { throw new Error("render broke") })`) })
    expect(runtime.slot("footer.replace", ctx)).toBeUndefined()
    expect(toasts).toEqual(["slotty: slot footer.replace disabled: render broke"])
    expect(runtime.slot("footer.replace", ctx)).toBeUndefined()
    expect(toasts).toHaveLength(1)
  })

  test("a throwing or rejecting onDispose is reported and does not stop the dispose", async () => {
    const { runtime, toasts } = await boot({
      "sync.ts": extension("sync", `api.onDispose(() => { throw new Error("dispose sync") })`),
      "async.ts": extension("async", `api.onDispose(async () => { throw new Error("dispose async") })`),
      "fine.ts": extension("fine", `api.onDispose(() => { (globalThis.__faultLog ??= []).push("fine disposed") })`),
    })
    await runtime.dispose()
    await tick()
    expect(toasts.sort()).toEqual(["async: dispose failed: dispose async", "sync: dispose failed: dispose sync"])
    expect((globalThis as unknown as { __faultLog?: string[] }).__faultLog).toEqual(["fine disposed"])
  })
})
