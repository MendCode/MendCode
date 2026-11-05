import { expect, test } from "bun:test"
import type { SessionId } from "@mendcode/protocol"
import type { Store } from "@mendcode/store"
import { createLazyBrowserControl, createLazyComputerControl } from "../src/lazy-controls"

test("unused controls do not inspect options, sessions or drivers, including cleanup", async () => {
  const unused = () => { throw new Error("unused control was initialized") }
  const computer = createLazyComputerControl({ hasSession: unused } as unknown as Store, ".", { get run() { return unused() } })
  const browser = createLazyBrowserControl({ get driver() { return unused() } })
  computer.port("unused" as SessionId)
  browser.port("unused")
  expect(browser.count()).toBe(0)
  await browser.forget("unused")
  computer.stop()
  await browser.stop()
})

test("concurrent computer calls share initialization and retain the live feature switch", async () => {
  let reads = 0
  let enabled = false
  const control = createLazyComputerControl({ hasSession: () => true } as unknown as Store, ".", {
    enabled: () => enabled,
    platform: "not-macos",
    get run() { reads++; return async () => { throw new Error("must not run a native command") } },
  })
  try {
    const results = await Promise.all(["one", "two"].map((id) => control.port(id as SessionId).capture({}, new AbortController().signal)))
    expect(results.every((result) => result.isError && result.output.includes("off"))).toBe(true)
    const initializedReads = reads
    expect(initializedReads).toBeGreaterThan(0)
    enabled = true
    expect((await control.port("one" as SessionId).capture({}, new AbortController().signal)).output).toContain("macOS only")
    expect(reads).toBe(initializedReads)
  } finally { control.stop() }
})

test("shutdown racing first computer use prevents native work", async () => {
  let calls = 0
  const control = createLazyComputerControl({ hasSession: () => true } as unknown as Store, ".", {
    enabled: true, platform: "darwin", run: async () => { calls++; throw new Error("must not run") },
  })
  const pending = control.port("one" as SessionId).capture({}, new AbortController().signal)
  control.stop()
  expect((await pending).isError).toBe(true)
  expect(calls).toBe(0)
})

test("shutdown racing first browser use prevents driver launch", async () => {
  let launches = 0
  const browser = createLazyBrowserControl({ enabled: true, driver: { launch: async () => { launches++; throw new Error("must not launch") } } })
  const pending = browser.port("one").run({ action: "navigate", url: "https://example.test" }, new AbortController().signal)
  await browser.stop()
  expect(await pending).toEqual({ ok: false, error: "the daemon is stopping" })
  expect(launches).toBe(0)
})
