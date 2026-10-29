import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { startDaemon } from "../src"
import { remoteTokens } from "../src/remote"
import type { RefreshProbe } from "../src/quota-refresh"

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

/** A daemon on a throwaway data directory with fake probes: no provider, no network, no login file of the machine. */
async function boot(input: { profile?: Record<string, unknown>; safeMode?: boolean; fail?: boolean } = {}) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mendd-qrefresh-")))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  if (input.profile) {
    mkdirSync(path.join(dir, "tui"), { recursive: true })
    writeFileSync(path.join(dir, "tui", "profile.json"), JSON.stringify(input.profile))
  }
  const sent: Array<{ provider: string; model?: string }> = []
  const probe = (provider: "codex" | "claude"): RefreshProbe => async ({ model, report }) => {
    sent.push({ provider, ...(model ? { model } : {}) })
    if (input.fail) throw new Error("[PROBE]: refused")
    report({ type: "quota.snapshot", provider, windows: [{ id: "primary", label: "5h", usedPercent: 12, resetsAt: Date.now() + 3_600_000 }], fetchedAt: Date.now(), source: "test probe" })
  }
  const daemon = await startDaemon({
    dir, socketPath: path.join(dir, "mendd.sock"), listen: "127.0.0.1:0", ...(input.safeMode ? { safeMode: true } : {}),
    quotaRefresh: { probes: { codex: probe("codex"), claude: probe("claude") }, random: () => 0 },
    engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }),
  })
  cleanups.push(() => daemon.stop())
  const client = createClient({ socketPath: daemon.socketPath, name: "qrefresh" })
  await client.connect()
  cleanups.push(() => client.close())
  let peers = 0
  async function remote(readOnly: boolean) {
    const token = remoteTokens(dir).create({ name: `${readOnly ? "ro" : "full"}-${++peers}`, readOnly }).token
    const peer = createClient({ name: "remote", remote: { hostname: "127.0.0.1", port: daemon.remotePort!, token } })
    await peer.connect()
    cleanups.push(() => peer.close())
    return peer
  }
  /** One look of the schedule, as its own timer would make (random() = 0 puts the first probe at the first look). */
  const look = async () => { await daemon.quotaRefresh.tick() }
  return { dir, daemon, client, sent, remote, look }
}

test("it is off by default: with a terminal attached and a long wait, nothing is sent and daemon.info says nothing", async () => {
  const h = await boot()
  for (let i = 0; i < 5; i++) await h.look()
  expect(h.sent).toEqual([])
  const info = await h.client.send({ type: "daemon.info" })
  expect(info.ok && "quotaRefresh" in (info.result ?? {})).toBe(false)
})

test("a profile that lists a provider turns it on: one probe through the injected path, its quota is stored and counted", async () => {
  const h = await boot({ profile: { quotaRefresh: [{ provider: "codex", everyMinutes: 15, model: "gpt-6-luna" }] } })
  await h.look()
  expect(h.sent).toEqual([{ provider: "codex", model: "gpt-6-luna" }])
  expect(h.daemon.store.latestQuota().some((quota) => quota.provider === "codex" && quota.source === "test probe")).toBe(true)
  const info = await h.client.send({ type: "daemon.info" })
  expect(info.ok ? info.result?.quotaRefresh : undefined).toMatchObject([{ provider: "codex", everyMinutes: 15, state: "on", probesToday: 1, model: "gpt-6-luna" }])
  // A second look inside the interval sends nothing more, and the reading is fresh.
  await h.look()
  expect(h.sent).toHaveLength(1)
}, 30_000)

test("safe mode turns it off even when the profile lists a provider", async () => {
  const h = await boot({ profile: { quotaRefresh: [{ provider: "codex" }] }, safeMode: true })
  for (let i = 0; i < 3; i++) await h.look()
  expect(h.sent).toEqual([])
  const info = await h.client.send({ type: "daemon.info" })
  expect(info.ok && "quotaRefresh" in (info.result ?? {})).toBe(false)
})

test("the user's feature override off wins over the profile", async () => {
  const h = await boot({ profile: { quotaRefresh: [{ provider: "codex" }] } })
  await h.client.send({ type: "settings.set", patch: { features: { quota_refresh: false } } })
  await h.look()
  await h.look()
  expect(h.sent).toEqual([])
})

test("a failing probe never touches a session: the log of an open session does not change", async () => {
  const h = await boot({ profile: { quotaRefresh: [{ provider: "claude" }] }, fail: true })
  const created = await h.client.send({ type: "session.create", directory: h.dir, title: "t" })
  const sessionId = (created.ok ? created.result?.sessionId : undefined) as Parameters<typeof h.daemon.store.readAfter>[0]
  const before = h.daemon.store.readAfter(sessionId, 0).length
  await h.look()
  expect(h.sent).toHaveLength(1)
  expect(h.daemon.store.readAfter(sessionId, 0)).toHaveLength(before)
  const info = await h.client.send({ type: "daemon.info" })
  expect(info.ok ? info.result?.quotaRefresh : undefined).toMatchObject([{ provider: "claude", probesToday: 1, lastError: expect.stringContaining("refused") }])
}, 30_000)

test("remote peers cannot turn it on: tui.change from a full-access or read-only peer is refused, and turning it off stays possible", async () => {
  const h = await boot({ profile: { quotaRefresh: [{ provider: "codex" }] } })
  for (const readOnly of [false, true]) {
    const peer = await h.remote(readOnly)
    const refused = await peer.send({ type: "tui.change", input: { operation: "apply", profile: { quotaRefresh: [{ provider: "claude", everyMinutes: 5 }] } } })
    expect(refused).toMatchObject({ ok: false, error: { code: "forbidden" } })
  }
  const full = await h.remote(false)
  const off = await full.send({ type: "tui.change", input: { operation: "apply", profile: { quotaRefresh: [] } } })
  expect(off.ok).toBe(true)
  const local = await h.client.send({ type: "tui.query", operation: "profile" })
  expect(local.ok ? (local.result?.profile as Record<string, unknown>).quotaRefresh : undefined).toEqual([])
  // A local terminal can turn it on again.
  const on = await h.client.send({ type: "tui.change", input: { operation: "apply", profile: { quotaRefresh: [{ provider: "claude", everyMinutes: 30 }] } } })
  expect(on.ok).toBe(true)
})

test("a value that is not a valid list is rejected with one line and nothing is saved", async () => {
  const h = await boot()
  for (const bad of [[{ provider: "codex", everyMinutes: 1 }], [{ provider: "gemini" }], [{ provider: "codex" }, { provider: "codex" }], "codex"]) {
    const reply = await h.client.send({ type: "tui.change", input: { operation: "apply", profile: { quotaRefresh: bad } } })
    expect(reply.ok).toBe(false)
  }
  const local = await h.client.send({ type: "tui.query", operation: "profile" })
  expect(local.ok ? (local.result?.profile as Record<string, unknown>).quotaRefresh : undefined).toEqual([])
})
