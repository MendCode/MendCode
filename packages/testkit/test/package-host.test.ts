import { expect, test } from "bun:test"
import { createPackageTestHost } from "../src/package-host"

test("package fixtures share explicit events, deterministic clock and model transcripts", async () => {
  const host = createPackageTestHost<{ type: "turn" }>(["fixture answer"])
  let calls = 0
  const dispose = host.on(() => { calls++ })
  host.clock.setTimer(100, () => host.emit({ type: "turn" }))
  host.clock.advance(99); expect(calls).toBe(0)
  host.clock.advance(1); expect(calls).toBe(1)
  expect(await host.model("fixture request")).toBe("fixture answer")
  await expect(host.model("no provider fallback")).rejects.toThrow("No scripted")
  expect(host.requests).toEqual(["fixture request"])
  dispose(); host.dispose(); host.emit({ type: "turn" }); expect(calls).toBe(1)
})
