import { afterEach, expect, test } from "bun:test"
import { boot, openSession, say, stop, type NativeHarness } from "./native-harness"

const harnesses: NativeHarness[] = []
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.cleanup()
})

test("the promptCache setting is validated, stored, reset with null, and read at each model call", async () => {
  const h = await boot({ steps: [stop("a"), stop("b"), stop("c"), stop("d")] })
  harnesses.push(h)
  const sessionId = await openSession(h)
  const set = (value: unknown) => h.client.send({ type: "settings.set", patch: { promptCache: value } })

  await say(h, sessionId, "unset")
  expect(await set("fast")).toMatchObject({ ok: false })
  expect(await set("off")).toMatchObject({ ok: true, result: { settings: { promptCache: "off" } } })
  await say(h, sessionId, "off")
  expect(await set("smart")).toMatchObject({ ok: true, result: { settings: { promptCache: "smart" } } })
  await say(h, sessionId, "smart")
  expect(await set(null)).toMatchObject({ ok: true })
  expect(await h.client.send({ type: "settings.get" })).toMatchObject({ ok: true, result: { settings: {} } })
  await say(h, sessionId, "reset")

  expect(h.requests.map((r) => [r.cacheMode, r.cacheKey])).toEqual([
    ["legacy", sessionId],
    ["off", undefined],
    ["smart", sessionId],
    ["legacy", sessionId],
  ])
  const settings = (await h.client.send({ type: "settings.get" })) as { ok: true; result: { settings: Record<string, unknown> } }
  expect("promptCache" in settings.result.settings).toBe(false)
})
