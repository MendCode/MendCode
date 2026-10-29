import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import type { ModelsReport, SessionId } from "@mendcode/protocol"
import { CLAUDE_MODELS, createClaudeDetection } from "../src/claude-models"
import { filteredCatalog, type ModelCatalog } from "../src/models"
import { startDaemon } from "../src/daemon"

const SUBSCRIPTION = ["gpt-6-sol", "gpt-6-luna", "gpt-6.1-sol", "gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol", "gpt-6-astra"]

/** What the daemon's own `claude --version` probe is: slow to answer after a restart, so a first request can arrive before it. */
function slowProbe() {
  const waiting: Array<(ok: boolean) => void> = []
  const calls: number[] = []
  return { calls, probe: () => new Promise<{ ok: boolean }>((resolve) => { calls.push(calls.length); waiting.push((ok) => resolve({ ok })) }), answer: (ok: boolean) => waiting.splice(0).forEach((resolve) => resolve(ok)) }
}

describe("Claude Code detection", () => {
  test("a request that arrives while the probe runs waits for it; one probe serves every request", async () => {
    const probe = slowProbe()
    const detection = createClaudeDetection({ probe: probe.probe })
    const first = detection.refresh()
    const second = detection.refresh()
    expect(detection.installed()).toBe(false)
    probe.answer(true)
    await Promise.all([first, second])
    expect(detection.installed()).toBe(true)
    expect(probe.calls).toHaveLength(1)
    await detection.refresh()
    expect(probe.calls).toHaveLength(1)
  })

  test("a failed probe is tried again once its answer is old, never on every request, and a later success sticks", async () => {
    let now = 1_000
    const probe = slowProbe()
    const detection = createClaudeDetection({ probe: probe.probe, now: () => now, recheckMs: 10_000 })
    const first = detection.refresh()
    probe.answer(false)
    await first
    expect(detection.installed()).toBe(false)
    now += 9_000
    await detection.refresh()
    expect(probe.calls).toHaveLength(1)
    now += 2_000
    const again = detection.refresh()
    expect(probe.calls).toHaveLength(2)
    probe.answer(true)
    await again
    expect(detection.installed()).toBe(true)
    now += 60_000
    await detection.refresh()
    expect(probe.calls).toHaveLength(2)
  })

  test("a probe that throws counts as not installed", async () => {
    const detection = createClaudeDetection({ probe: () => Promise.reject(new Error("spawn claude ENOENT")) })
    await detection.refresh()
    expect(detection.installed()).toBe(false)
  })
})

describe("the models report of a daemon whose Claude Code probe is still running", () => {
  const dirs: string[] = []
  const stops: Array<() => Promise<void>> = []
  afterEach(async () => {
    for (const stop of stops.splice(0)) await stop()
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  async function boot() {
    const dir = mkdtempSync(path.join(tmpdir(), "mendcode-claude-detection-"))
    dirs.push(dir)
    const probe = slowProbe()
    const detection = createClaudeDetection({ probe: probe.probe })
    void detection.refresh() // the daemon starts probing when it starts, before any client asks
    const catalog: ModelCatalog = filteredCatalog({
      selectable: true,
      list: () => [...SUBSCRIPTION.map((id) => ({ id, name: id, efforts: ["low" as const, "high" as const] })), ...(detection.installed() ? CLAUDE_MODELS : [])],
      refresh: detection.refresh,
      defaults: { model: "gpt-6-sol", effort: "high" },
    }, () => ({}))
    const daemon = await startDaemon({ dir, socketPath: path.join(dir, "d.sock"), extensionsEnabled: false, log() {}, models: catalog, info: { engine: "native" }, engine: () => ({ needsCompaction: () => false, async compact() { return { status: "ok" } }, async runShell() { return { status: "ok" } }, async runTurn() { return { status: "ok" } } }) })
    const client = createClient({ name: "claude-detection", socketPath: daemon.socketPath })
    await client.connect()
    stops.push(async () => { await client.close(); await daemon.stop() })
    return { client, probe }
  }
  const idsOf = async (client: ReturnType<typeof createClient>, sessionId?: SessionId) => {
    const reply = await client.send({ type: "models.list", ...(sessionId ? { sessionId } : {}) })
    if (!reply.ok) throw new Error(reply.error.message)
    return (reply.result as ModelsReport).models.map((model) => model.id)
  }

  test("models.list without a session and with one both wait for the probe and then list the four Claude Code models", async () => {
    const { client, probe } = await boot()
    const created = await client.send({ type: "session.create", directory: dirs[0]! })
    if (!created.ok) throw new Error(created.error.message)
    const sessionId = created.result!.sessionId as SessionId
    const bare = idsOf(client)
    const withSession = idsOf(client, sessionId)
    await Bun.sleep(30)
    probe.answer(true)
    for (const ids of await Promise.all([bare, withSession])) {
      expect(ids.filter((id) => id.startsWith("claude-")).sort()).toEqual(["claude-fable", "claude-haiku", "claude-opus", "claude-sonnet"])
      expect(ids.filter((id) => id.startsWith("gpt-"))).toHaveLength(SUBSCRIPTION.length)
    }
  })

  test("session.model.set to a Claude Code alias right after start is accepted, not refused as an unknown model", async () => {
    const { client, probe } = await boot()
    const created = await client.send({ type: "session.create", directory: dirs[0]! })
    if (!created.ok) throw new Error(created.error.message)
    const reply = client.send({ type: "session.model.set", sessionId: created.result!.sessionId as SessionId, choice: { model: "claude-opus" } })
    await Bun.sleep(30)
    probe.answer(true)
    expect(await reply).toMatchObject({ ok: true, result: { session: { model: "claude-opus" } } })
  })
})
