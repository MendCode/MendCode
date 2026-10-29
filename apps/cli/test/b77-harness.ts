import type { CommandReply } from "@mendcode/client"
import type { UsageReport, UsageWeatherReport } from "@mendcode/protocol"
import { DEFAULT_TUI_PROFILE, writeTuiProfile, type TuiProfile } from "../src/view/tui-profile"
import { appHarness, tempDir, NOW } from "./session-ui-harness"
import { usageFixture } from "./ui-5-harness"

export function b77Harness(options: { width?: number; height?: number; dataDir?: string; profile?: Partial<TuiProfile>; empty?: boolean; weather?: (region: string) => UsageWeatherReport | Promise<UsageWeatherReport> } = {}) {
  const dataDir = options.dataDir ?? tempDir("mend-b77-")
  if (options.profile) writeTuiProfile(dataDir, { ...DEFAULT_TUI_PROFILE, ...options.profile })
  const h = appHarness({ width: options.width ?? 100, height: options.height ?? 30, dataDir, directory: "/work/mendcode", reply: async (command) => {
    if (command.type === "usage.weather.query") return { ok: true, result: await (options.weather?.(command.region ?? "") ?? { status: "ready", region: command.region!, reading: { location: command.region!, label: "Clear", temperatureC: 23, windKmh: 8, code: 0, observedAt: NOW } }) } as unknown as CommandReply
    if (command.type !== "usage.query") return { ok: true }
    const report: UsageReport = { ...usageFixture(), from: command.from, to: command.to,
      scope: { kind: command.scope ?? "global", ...(command.scope === "global" ? {} : { directory: "/work/mendcode", project: "/work/mendcode" }) },
      agents: [{ name: "build", turns: 42 }, { name: "plan", turns: 7 }],
      outcomes: { changedFiles: 14, sessionsWithCodeChanges: 6, coverage: "retained-snapshots" },
    }
    if (options.empty) { report.days = []; report.models = []; report.activity = []; report.tools = []; report.agents = []; report.sessions = 0; report.outcomes = { changedFiles: 0, sessionsWithCodeChanges: 0, coverage: "retained-snapshots" }; report.insights = { streak: { current: 0, longest: 0 }, efforts: [], skills: [], topSessions: [] } }
    return { ok: true, result: report } as unknown as CommandReply
  } })
  h.app.applySettings({ onboarded: true })
  return { ...h, dataDir }
}
