import { afterEach, expect, test } from "bun:test"
import { createProviderService } from "../src/providers"
import { boot, openSession, say, stop, until, type NativeHarness } from "./native-harness"
import { compactionThreshold } from "@mendcode/engine-native"

const running: NativeHarness[] = []
afterEach(async () => { for (const h of running.splice(0).reverse()) await h.cleanup() })

test("B23 client config validates, persists and broadcasts without a provider request", async () => {
  const h = await boot()
  running.push(h)
  const config = { auto: false, prune: false, tail_turns: 1, reserved: 12_000, threshold: 90, portable_mode: "incremental" as const, max_summary_tokens: 512 }
  expect(await h.client.setCompactionConfig(config)).toMatchObject({ ok: true })
  expect(await h.client.compactionConfig()).toEqual({ ok: true, config })
  expect(h.store.settings.get().compaction).toEqual(config)
  expect(await h.client.send({ type: "settings.set", patch: { compaction: { timeout_ms: 999 } } })).toMatchObject({ ok: false, error: { code: "invalid_command" } })
  expect(h.store.settings.get().compaction).toEqual(config)
  expect(h.requests).toHaveLength(0)
  expect(await h.client.setCompactionConfig(null)).toMatchObject({ ok: true })
  expect(await h.client.compactionConfig()).toEqual({ ok: true, config: {} })
}, 10_000)

test("B23 a manually queued compaction keeps verbatim tail and incremental output cap with auto disabled", async () => {
  const h = await boot({ steps: [stop("result one"), stop("result two"), stop("saved baseline"), stop("next result")] })
  running.push(h)
  const sessionId = await openSession(h)
  await h.client.setCompactionConfig({ auto: false, tail_turns: 1, portable_mode: "incremental", max_summary_tokens: 512 })
  await say(h, sessionId, "first request")
  await say(h, sessionId, "latest constraint")
  await h.client.send({ type: "session.compact", sessionId })
  await until(() => h.events.some((event) => event.type === "compaction.updated" && event.state === "packed"))
  // The summary request repeats the last call (its tool list too) and keeps the incremental output cap.
  expect(h.requests[2]).toMatchObject({ tools: h.requests[1]!.tools, maxOutputTokens: 512 })
  expect(h.store.engineMessages.load(sessionId, "native").slice(1)).toMatchObject([{ role: "user", content: "latest constraint" }, { role: "assistant", content: "result two" }])
  await say(h, sessionId, "continue")
  expect(h.requests[3]!.messages.map((message) => "content" in message ? message.content : "tool")).toEqual([expect.stringContaining("saved baseline"), "latest constraint", "result two", "continue"])
  expect(h.events.find((event) => event.type === "item.started" && event.kind === "compaction")).toMatchObject({ meta: { compactionMethod: "incremental", tailTurns: 1 } })
}, 10_000)

test("B23 provider/model overrides persist, route and invalidate the adapter cache without network", async () => {
  const h = await boot()
  running.push(h)
  let calls = 0
  const providers = createProviderService({ dir: h.dir, env: { LOCAL_FAKE_KEY: "local-only-fake" }, fetch: async () => { calls++; throw new Error("network forbidden") } })
  expect(providers.set({ id: "openai", apiKeyEnv: "LOCAL_FAKE_KEY", compaction: { threshold: 80 }, models: [{ id: "gpt-model", context: 200_000, compaction: { token_limit: 120_000 } }] })).toMatchObject({ ok: true })
  expect(providers.list()[0]).toMatchObject({ compaction: { threshold: 80 }, models: [{ compaction: { token_limit: 120_000 } }] })
  const refreshing = createProviderService({ dir: h.dir, env: { LOCAL_FAKE_KEY: "local-only-fake" }, fetch: async () => Response.json({ data: [{ id: "gpt-model", context_window: 200_000 }] }) })
  expect(await refreshing.refresh("openai")).toMatchObject({ ok: true, provider: { models: [{ compaction: { token_limit: 120_000 } }] } })
  const limits = providers.runtime().openai!.compactionLimits!("gpt-model")
  expect(compactionThreshold({ threshold: 95 }, limits)).toBe(120_000)
  const before = providers.runtime().openai
  providers.set({ id: "openai", compaction: { token_limit: 100_000 }, models: [{ id: "gpt-model", context: 200_000 }] })
  expect(providers.runtime().openai).not.toBe(before)
  expect(compactionThreshold({}, providers.runtime().openai!.compactionLimits!("gpt-model"))).toBe(100_000)
  expect(createProviderService({ dir: h.dir, env: {} }).list()[0]?.compaction).toEqual({ token_limit: 100_000 })
  providers.set({ id: "openai", compaction: null })
  expect(providers.list()[0]?.compaction).toBeUndefined()
  expect(calls).toBe(0)
}, 10_000)

test("B23 native checkpoint reloads from daemon storage and stays private on the wire", async () => {
  const provider = { nativeBinding: async () => "local:script-1", compact: async () => ({ output: [{ type: "compaction", encrypted_content: "local-private-checkpoint" }] }) }
  const h = await boot({ steps: [stop("first result"), stop("last result")], provider })
  running.push(h)
  const sessionId = await openSession(h)
  await h.client.setCompactionConfig({ strategy: "native", tail_turns: 1 })
  await say(h, sessionId, "first request")
  await say(h, sessionId, "keep this constraint")
  await h.client.send({ type: "session.compact", sessionId })
  await until(() => h.events.some((event) => event.type === "compaction.updated" && event.state === "packed"))
  expect(h.store.engineMessages.load(sessionId, "native")[0]).toMatchObject({ compaction: { method: "native", native: { output: [{ type: "compaction", encrypted_content: "local-private-checkpoint" }] } } })
  expect(JSON.stringify(h.events)).not.toContain("local-private-checkpoint")
  h.client.close()
  await h.daemon.stop()
  const restarted = await boot({ dir: h.dir, project: h.project, steps: [stop("resumed")], provider })
  running.push(restarted)
  expect((await restarted.client.compactionConfig())).toEqual({ ok: true, config: { strategy: "native", tail_turns: 1 } })
  await restarted.client.subscribe(sessionId, 0)
  await say(restarted, sessionId, "after restart")
  expect(restarted.requests[0]!.nativeContext).toEqual([{ type: "compaction", encrypted_content: "local-private-checkpoint" }])
  expect(restarted.requests[0]!.messages.some((message) => message.role === "user" && message.content === "keep this constraint")).toBe(true)
  expect(JSON.stringify(restarted.events)).not.toContain("local-private-checkpoint")
}, 20_000)
