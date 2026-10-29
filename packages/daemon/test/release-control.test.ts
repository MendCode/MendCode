import { afterEach, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { Settings, isReadOnlyCommand, type ReleaseChannel } from "@mendcode/protocol"
import { ReleaseReport } from "../../protocol/src/release"
import { startDaemon } from "../src/daemon"
import { createReleaseControl } from "../src/release-control"
import { fakePorts, release, REPO, tempDir } from "../../upgrade/test/helpers"

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
function setup(options: { version?: string; target?: string; auto?: boolean | "notify"; idle?: boolean; mode?: "attested" | "cosign" } = {}) {
  const tmp = tempDir()
  cleanups.push(tmp.cleanup)
  const target = options.target ?? "1.0.1"
  const fake = fakePorts([release({ tag: `v${target}`, prerelease: target.includes("-"), binaries: { [`mendcode-${target}-linux-x64`]: "new" }, ...(options.mode ? { mode: options.mode } : {}) })])
  const settings = { autoupdate: options.auto ?? false }
  const notices: Array<{ version: string; channel: ReleaseChannel; installed: boolean }> = []
  const dataDir = path.join(tmp.dir, "data")
  const service = createReleaseControl({ dir: dataDir, settings: () => settings, idle: () => options.idle !== false, notify: (version, channel, installed) => notices.push({ version, channel, installed }), options: { ports: fake.ports, env: { MENDCODE_UPGRADE_REPO: REPO }, home: tmp.dir, version: options.version ?? "1.0.0", platform: { os: "linux", arch: "x64" } } })
  cleanups.push(() => service.stop())
  return { service, settings, notices, dataDir, fake, tmp }
}

test("B40 default-off and inspect/set are offline; channel is remembered without installation", async () => {
  const h = setup()
  h.service.wake()
  expect(ReleaseReport.parse(await h.service.inspect())).toMatchObject({ channel: "stable", autoupdate: false, status: "unchecked", recovery: null })
  expect(existsSync(h.dataDir)).toBe(false)
  expect(await h.service.set("nightly")).toMatchObject({ channel: "nightly" })
  expect(JSON.parse(readFileSync(path.join(h.dataDir, "upgrade.json"), "utf8")).channel).toBe("nightly")
  expect(h.fake.requested).toEqual([])
  expect(existsSync(path.join(h.dataDir, "bin"))).toBe(false)
})

test("B40 explicit check deduplicates in-flight work and notifications, keeps check disk read-only", async () => {
  const h = setup()
  const results = await Promise.all([h.service.check(), h.service.check()])
  expect(results[0]).toMatchObject({ latest: "v1.0.1", status: "update-available" })
  expect(h.fake.requested).toHaveLength(1)
  await h.service.check()
  expect(h.notices).toEqual([{ version: "v1.0.1", channel: "stable", installed: false }])
  expect(existsSync(h.dataDir)).toBe(false)
})

test("B40 notify checks without installing; true installs only a verified stable patch", async () => {
  const notify = setup({ auto: "notify" })
  notify.service.wake()
  // stop awaits the tracked check; notify mode never activates a binary.
  for (let i = 0; i < 100 && !notify.notices.length; i++) await Bun.sleep(2)
  expect(notify.notices).toHaveLength(1)
  expect(notify.fake.requested).toHaveLength(1)
  expect(existsSync(path.join(notify.dataDir, "bin"))).toBe(false)
  const automatic = setup({ auto: true })
  automatic.service.wake()
  for (let i = 0; i < 100 && !automatic.notices.some((notice) => notice.installed); i++) await Bun.sleep(2)
  expect(automatic.notices.at(-1)).toMatchObject({ version: "v1.0.1", installed: true })
  expect(readFileSync(path.join(automatic.dataDir, "bin/mendcode-next"), "utf8")).toBe("new")
}, 20_000)

test("B40 auto refuses non-patch versions and busy sessions, cancels activation after policy changes", async () => {
  for (const options of [{ target: "1.1.0" }, { target: "0.0.9" }, { idle: false }, { version: "1.0.0-beta.1" }]) {
    const h = setup({ ...options, auto: true })
    h.service.wake()
    for (let i = 0; i < 100 && !h.notices.length; i++) await Bun.sleep(2)
    await h.service.stop()
    expect(existsSync(path.join(h.dataDir, "bin/mendcode-next"))).toBe(false)
  }
  const h = setup({ auto: true })
  h.fake.ports.verifyProvenance = async () => { h.settings.autoupdate = false }
  h.service.wake()
  for (let i = 0; i < 100 && !h.fake.requested.some((url) => url.endsWith("release-index.json")); i++) await Bun.sleep(2)
  await h.service.stop()
  expect(existsSync(path.join(h.dataDir, "bin/mendcode-next"))).toBe(false)
})

test("B40 stale channel checks cannot replace current channel status", async () => {
  const h = setup()
  const fetchJson = h.fake.ports.fetchJson
  let finish!: () => void
  h.fake.ports.fetchJson = async (url) => { await new Promise<void>((resolve) => { finish = resolve }); return fetchJson(url) }
  const checked = h.service.check()
  for (let i = 0; i < 100 && !finish; i++) await Bun.sleep(2)
  await h.service.set("beta")
  finish()
  expect(await checked).toMatchObject({ channel: "beta", status: "unchecked", latest: null })
  expect(h.notices).toEqual([])
})

test("B40 schemas and remote policy reject invalid autoupdate/channel, never classify check or set as read-only", () => {
  for (const value of [false, true, "notify"]) expect(Settings.safeParse({ autoupdate: value }).success).toBe(true)
  expect(Settings.safeParse({ autoupdate: "auto" }).success).toBe(false)
  expect(isReadOnlyCommand("release.inspect")).toBe(true)
  expect(isReadOnlyCommand("release.set")).toBe(false)
  expect(isReadOnlyCommand("release.check")).toBe(false)
})

test("B40 daemon/protocol/client persist channel and push automatic-update availability with local fakes", async () => {
  const h = setup()
  const events: string[] = []
  const daemon = await startDaemon({ dir: h.dataDir, socketPath: path.join(h.tmp.dir, "mendd.sock"), extensionsEnabled: false, release: { ports: h.fake.ports, env: { MENDCODE_UPGRADE_REPO: REPO }, version: "1.0.0", platform: { os: "linux", arch: "x64" } }, engine: ({ clock }) => createFauxEngine({ clock }) })
  cleanups.push(() => daemon.stop())
  const client = createClient({ socketPath: daemon.socketPath, name: "B40", onGlobal: (event) => { events.push(event.type) } })
  cleanups.push(() => client.close())
  await client.connect()
  expect(await client.releaseInspect()).toMatchObject({ ok: true, report: { autoupdate: false } })
  expect(await client.releaseSet("nightly")).toMatchObject({ ok: true, result: { channel: "nightly" } })
  await client.releaseSet("stable")
  expect(await client.send({ type: "settings.set", patch: { autoupdate: "notify" } })).toMatchObject({ ok: true })
  for (let i = 0; i < 100 && !events.includes("release.available"); i++) await Bun.sleep(2)
  expect(events).toContain("release.available")
  expect(await client.releaseCheck()).toMatchObject({ ok: true, report: { latest: "v1.0.1", autoupdate: "notify" } })
  const laterEvents: string[] = []
  const later = createClient({ socketPath: daemon.socketPath, name: "B40 later terminal", onGlobal: (event) => { laterEvents.push(event.type) } })
  cleanups.push(() => later.close())
  await later.connect()
  for (let i = 0; i < 100 && !laterEvents.includes("release.available"); i++) await Bun.sleep(2)
  expect(laterEvents).toContain("release.available")
  expect(await client.send({ type: "settings.set", patch: { autoupdate: "invalid" } })).toMatchObject({ ok: false })
}, 20_000)

test("the automatic updater installs nothing on a machine without cosign: it never settles for the SHA256 check alone", async () => {
  const h = setup({ auto: true, target: "1.0.1", mode: "cosign" })
  const { UpgradeError } = await import("../../upgrade/src/errors")
  h.fake.ports.verifyProvenance = async () => { throw new UpgradeError("verifier-missing", "cosign is not installed") }
  h.service.wake()
  await Bun.sleep(200)
  await h.service.stop()
  expect(h.notices.some((notice) => notice.installed)).toBe(false)
  expect(existsSync(path.join(h.dataDir, "bin/mendcode-next"))).toBe(false)
}, 20_000)
