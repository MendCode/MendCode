import { homedir } from "node:os"
import { type ReleaseChannel, type ReleaseReport, type Settings } from "@mendcode/protocol"
import { createNodePorts } from "../../upgrade/src/io"
import { resolveDataDir } from "../../upgrade/src/install"
import type { UpgradePorts } from "../../upgrade/src/ports"
import { readRecovery, verifyRecovery } from "../../upgrade/src/recovery"
import { readState, writeState } from "../../upgrade/src/state"
import { resolveRepo, runUpgrade } from "../../upgrade/src/upgrade"
import { parseVersion } from "../../upgrade/src/releases"
import { DEV_VERSION } from "@mendcode/program"

export type ReleaseOptions = { ports?: UpgradePorts; env?: Record<string, string | undefined>; home?: string; version?: string; platform?: { os: string; arch: string } }

export function createReleaseControl(input: {
  dir: string
  settings(): Settings
  idle(): boolean
  notify(version: string, channel: ReleaseChannel, installed: boolean): void
  options?: ReleaseOptions
}) {
  const ports = input.options?.ports ?? createNodePorts()
  const home = input.options?.home ?? homedir()
  const dir = resolveDataDir({ dataDir: input.dir, home })
  const env = input.options?.env ?? process.env
  const current = input.options?.version ?? DEV_VERSION
  let checked: Pick<ReleaseReport, "status" | "latest" | "lastCheckAt"> | undefined
  let checking: Promise<ReleaseReport> | undefined
  let stopped = false
  let notified = ""
  let notice: { version: string; channel: ReleaseChannel; installed: boolean } | undefined
  let automatic: Promise<void> | undefined
  function notify(version: string, channel: ReleaseChannel, installed: boolean) {
    notice = { version, channel, installed }
    input.notify(version, channel, installed)
  }

  async function inspect(): Promise<ReleaseReport> {
    const state = await readState({ fs: ports.fs, dataDir: dir })
    const recovery = await readRecovery(ports.fs, dir)
    const verified = recovery?.previous ? await verifyRecovery(ports.fs, dir).then(() => true, () => false) : false
    return { channel: state.channel, current, autoupdate: input.settings().autoupdate ?? false, status: checked?.status ?? "unchecked", latest: checked?.latest ?? null, lastCheckAt: checked?.lastCheckAt ?? state.lastCheckAt, recovery: recovery ? { current: recovery.current.version, previous: verified ? recovery.previous!.version : null } : null }
  }
  async function set(channel: ReleaseChannel) {
    const release = await ports.fs.lock(dir)
    try {
      const state = await readState({ fs: ports.fs, dataDir: dir })
      await writeState({ fs: ports.fs, dataDir: dir, state: { ...state, channel } })
      checked = undefined
      notice = undefined
      notified = ""
    } finally { await release() }
    return inspect()
  }
  async function check() {
    if (checking) return checking
    checking = (async () => {
      const report = await inspect()
      const result = await runUpgrade({ dataDir: dir, home, repo: resolveRepo(env), currentVersion: current, platform: input.options?.platform ?? { os: process.platform, arch: process.arch }, channel: report.channel, check: true, force: false, rollback: false }, ports)
      // A channel change during the HTTP request invalidates its result.
      if ((await readState({ fs: ports.fs, dataDir: dir })).channel === report.channel) {
        checked = { status: result.status as ReleaseReport["status"], latest: result.latest, lastCheckAt: ports.now() }
        if (!stopped && result.status === "update-available" && result.latest && notified !== result.latest) {
          notified = result.latest
          notify(result.latest, report.channel, false)
        }
      }
      return inspect()
    })()
    try { return await checking } finally { checking = undefined }
  }
  function wake() {
    if (stopped) return
    if (!input.settings().autoupdate) { notice = undefined; return }
    if (automatic) return
    automatic = (async () => {
      const report = await check()
      if (stopped || input.settings().autoupdate !== true || !input.idle() || report.channel !== "stable" || report.status !== "update-available" || !report.latest) return
      const old = parseVersion(current), next = parseVersion(report.latest)
      if (!old || !next || old.beta !== null || old.nightly || old.major !== next.major || old.minor !== next.minor || next.patch <= old.patch) return
      const result = await runUpgrade({ dataDir: dir, home, repo: resolveRepo(env), channel: report.channel, target: report.latest, currentVersion: current, platform: input.options?.platform ?? { os: process.platform, arch: process.arch }, check: false, force: false, rollback: false, requireSignature: true, beforeActivate: async () => !stopped && input.settings().autoupdate === true && input.idle() && (await readState({ fs: ports.fs, dataDir: dir })).channel === report.channel }, ports)
      if (!stopped && result.status === "installed") {
        checked = { status: "installed", latest: result.latest, lastCheckAt: ports.now() }
        notify(result.latest!, report.channel, true)
      }
    })().catch(() => {}).finally(() => { automatic = undefined })
  }
  return { inspect, set, check, wake, notice: () => notice, async stop() { stopped = true; await automatic; await checking?.catch(() => {}) } }
}
