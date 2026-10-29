import { expect, test } from "bun:test"
import { createIdFactory, UsageQuery, UsageReport } from "../src"

test("usage scope and selectors are additive; old commands/reports still parse", () => {
  const ids = createIdFactory()
  const command = { type: "usage.query" as const, id: ids("command"), clientId: ids("client"), from: "2026-09-01", to: "2026-09-30" }
  expect(UsageQuery.parse(command)).toEqual(command)
  expect(UsageQuery.parse({ ...command, scope: "project", directory: "/work/repo/src", project: "/work/repo", toolLimit: 0 })).toMatchObject({ scope: "project", toolLimit: 0 })
  for (const invalid of [{ scope: "all" }, { project: "" }, { toolLimit: -1 }, { toolLimit: 10001 }, { toolLimit: 1.5 }]) expect(UsageQuery.safeParse({ ...command, ...invalid }).success).toBe(false)
  const report = { from: command.from, to: command.to, days: [], models: [], quotas: [] }
  expect(UsageReport.parse(report)).toEqual(report)
  expect(UsageReport.parse({ ...report, scope: { kind: "project", directory: "/work/repo", project: "/work/repo" }, projects: [{ id: "/work/repo", directory: "/work/repo" }] }).scope?.kind).toBe("project")
})
