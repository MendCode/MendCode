import type { CommandReply } from "@mendcode/client"
import type { UsageReport } from "@mendcode/protocol"
import { usageFixture } from "./ui-5-harness"
import { appHarness, tempDir } from "./session-ui-harness"

export const B41_PROJECTS = ["/work/empty", "/work/mendcode", "/work/other"].map((id) => ({ id, directory: id }))
export function b41Harness(width = 100, height = 30) {
  const fixture = usageFixture()
  const h = appHarness({ width, height, dataDir: tempDir(), directory: "/work/mendcode/src", reply: (command) => {
    if (command.type !== "usage.query") return undefined
    const kind = command.scope ?? "global"
    const project = command.project ?? "/work/mendcode"
    const report: UsageReport = { ...fixture, from: command.from, to: command.to, projects: B41_PROJECTS,
      scope: { kind, ...(kind === "directory" ? { directory: "/work/mendcode/src" } : kind === "project" ? { directory: project, project } : {}) },
    }
    report.days = fixture.days.filter((d, i) => d.day >= command.from && d.day <= command.to &&
      (project !== "/work/empty") && (kind === "global" || i % (kind === "project" ? project === "/work/other" ? 3 : 2 : 4) === 0))
    const days = new Set(report.days.map((d) => d.day))
    report.activity = fixture.activity!.filter((a) => days.has(a.day))
    report.models = fixture.models.flatMap((m, index) => {
      const subset = report.days.filter((d, i) => i % fixture.models.length === index)
      return subset.length ? [{ ...m, input: subset.reduce((sum, d) => sum + d.input, 0), output: subset.reduce((sum, d) => sum + d.output, 0),
        calls: subset.reduce((sum, d) => sum + d.calls, 0), costMicros: subset.reduce((sum, d) => sum + d.costMicros, 0), costUnknownCalls: 0 }] : []
    })
    report.sessions = report.days.length ? kind === "global" ? 36 : kind === "project" ? 12 : 3 : 0
    report.tools = report.activity.length ? [{ tool: "read", calls: report.activity.length * 2, ms: report.activity.length * 100, errors: 0 },
      { tool: "shell", calls: report.activity.length, ms: report.activity.length * 3900, errors: 0 }] : []
    const session = fixture.insights!.topSessions[0]!
    const top = report.days.length ? [{ ...session, directory: kind === "directory" ? "/work/mendcode/src" : project,
      tokens: report.days.reduce((sum, d) => sum + d.input + d.output, 0), ms: report.activity.reduce((sum, a) => sum + a.aiMs + a.toolMs, 0) }] : []
    report.insights = { streak: { current: 0, longest: report.activity.length ? 1 : 0 }, efforts: [], skills: [], topSessions: top,
      ...(top[0] ? { longestSession: top[0] } : {}) }
    return { ok: true, result: report } as unknown as CommandReply
  } })
  h.app.applySettings({ onboarded: true })
  return h
}
