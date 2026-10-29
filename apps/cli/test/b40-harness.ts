import type { ReleaseReport } from "@mendcode/protocol/wire"
import { appHarness, NOW, tempDir } from "./session-ui-harness"

export const B40_REPORT: ReleaseReport = { channel: "stable", current: "0.0.1", latest: null, lastCheckAt: null, autoupdate: false, status: "unchecked", recovery: null }
export function b40Harness(width = 100, height = 30, readOnly = false) {
  let report = { ...B40_REPORT }
  let error = ""
  const h = appHarness({ width, height, dataDir: tempDir(), directory: "/work/mendcode", version: "0.0.1", ...(readOnly ? { remote: { host: "127.0.0.1:4040", readOnly: true } } : {}), reply: (command) => {
    if (command.type === "release.inspect" || command.type === "release.set" || command.type === "release.check") {
      if (error) return { ok: false, error: { code: "invalid_command", message: error } }
      if (command.type === "release.set") report = { ...report, channel: command.channel, latest: null, status: "unchecked" }
      if (command.type === "release.check") report = { ...report, latest: "v0.0.2", lastCheckAt: NOW, status: "update-available" }
      return { ok: true, result: report }
    }
    if (command.type === "settings.set" && "autoupdate" in command.patch) {
      report = { ...report, autoupdate: command.patch.autoupdate as ReleaseReport["autoupdate"] }
      return { ok: true, result: { settings: { onboarded: true, autoupdate: report.autoupdate } } }
    }
    return { ok: true }
  } })
  h.app.applySettings({ onboarded: true })
  return { ...h, report: () => report, setReport(value: ReleaseReport) { report = value }, error(value: string) { error = value } }
}
