import { afterEach, expect, test } from "bun:test"
import type { CommandInput } from "@mendcode/client"
import { createConsoleAutomation } from "../src/console-automation"
import { parseAutomation } from "../src/automation"
import { consoleOptions } from "../src/view/console-options"
import { textWidth } from "../src/view/wrap"
import { b74Harness } from "./b74-fixtures"
import { cleanTemps } from "./session-ui-harness"

afterEach(cleanTemps)

test("B74.1 org aliases search names/accounts/hosts, select without mutation on Tab, and close on active or switched org", async () => {
  const h = b74Harness()
  try {
    await h.type("/org research\r")
    expect(h.text().join("\n")).toContain("Organizations · 1")
    expect(h.text().join("\n")).not.toContain("Engineering · active")
    await h.keys("\t")
    expect(h.sentOf("console.switchOrg")).toHaveLength(0)
    await h.keys("\r")
    expect(h.sentOf("console.switchOrg").at(-1)).toMatchObject({ accountID: "local-account", orgID: "research" })
    expect(h.sentOf("models.list").length).toBeGreaterThan(0)
    expect(h.text()[0]).not.toContain("Switch org")
    await h.type("/org\r")
    expect(h.text().join("\n")).toContain("› Research · active")
    const count = h.sentOf("console.switchOrg").length
    await h.keys("\r")
    expect(h.sentOf("console.switchOrg")).toHaveLength(count)
    await h.type("/org\r")
    await h.type("absent")
    expect(h.text().join("\n")).toContain("No matching orgs")
    await h.keys("\x7f", "\x15")
    await h.type("dev@local.test")
    expect(h.text().join("\n")).toContain("Organizations · 2")
    await h.keys("\x15")
    await h.type("127.0.0.1")
    expect(h.text().join("\n")).toContain("Organizations · 2")
  } finally { await h.app.onKey("\x03") }
})

test("B74.1 failed switch stays in the picker with its query and account grouping is stable", async () => {
  const h = b74Harness()
  try {
    await h.type("/org research\r"); h.failNext(); await h.keys("\r")
    expect(h.text().join("\n")).toContain("Console returned HTTP 503")
    expect(h.text().join("\n")).toContain("Search research")
    await h.keys("\r")
    expect(h.sentOf("console.switchOrg")).toHaveLength(2)
    const report = h.getReport()
    report.orgs = [report.orgs[1]!, { ...report.orgs[0]!, accountID: "second", accountEmail: "other@local.test", active: false }]
    expect(consoleOptions(report)[0]?.active).toBe(true)
  } finally { await h.app.onKey("\x03") }
})

test("B74.1 Console shows partial account and metadata failures, clears them on refresh, and keeps confirmation/local-only control", async () => {
  const h = b74Harness()
  try {
    h.patchReport({ metadataError: "Console metadata unavailable", unavailableAccountIDs: ["offline"] })
    await h.type("/console\r")
    expect(h.text().join("\n")).toContain("Console metadata unavailable")
    expect(h.text().join("\n")).toContain("1 accounts unavailable")
    await h.keys("d", "n")
    expect(h.sentOf("console.logout")).toHaveLength(0)
    h.patchReport({ metadataError: undefined, unavailableAccountIDs: [] })
    await h.keys("r")
    expect(h.text().join("\n")).not.toContain("metadata unavailable")
  } finally { await h.app.onKey("\x03") }
})

test("B74.1 org picker keeps the final selection visible and clamps arrows at each required terminal size", async () => {
  for (const [width, height] of [[60, 20], [100, 30], [160, 45], [180, 50], [220, 60]]) {
    const h = b74Harness({ width, height })
    try {
      const sample = h.getReport().orgs[0]!
      h.patchReport({ orgs: Array.from({ length: 60 }, (_, i) => ({ ...sample, orgID: `org-${i}`, orgName: `Organization ${String(i).padStart(2, "0")}`, active: i === 0 })) })
      await h.type("/org\r")
      await h.keys(...Array.from({ length: 65 }, () => "\x1b[B"))
      expect(h.text().join("\n")).toContain("› Organization 59")
      const frame = h.frames.at(-1)!
      expect(frame).toHaveLength(height!)
      expect(frame.every((row) => textWidth(row.map((span) => span.text).join("")) <= width!)).toBe(true)
      expect(h.text()[0]).toContain("esc")
      expect(h.text().join("\n")).toContain("┌")
      await h.keys("\r")
      expect(h.sentOf("console.switchOrg").at(-1)).toMatchObject({ orgID: "org-59" })
    } finally { await h.app.onKey("\x03") }
  }
})

test("B74.1 CLI setup accepts enterprise default and logout/orgs/switch avoid metadata calls", async () => {
  expect(parseAutomation(["console", "setup", "--token-file", "/tmp/private-token", "--dir", "/tmp/data"])).toMatchObject({ ok: true, command: { kind: "console", operation: "setup", tokenFile: "/tmp/private-token" } })
  const h = b74Harness(), sent: CommandInput[] = [], output: string[] = []
  const run = createConsoleAutomation({ client: {} as never, listen: () => {}, onInterrupt: () => {}, now: () => 0, cwd: "/tmp", out: { write: (value) => output.push(value) }, err: { write: () => {} }, request: async (command) => {
    sent.push(command)
    if (command.type === "console.get") throw new Error("Metadata should not be fetched")
    return { ok: true, result: command.type === "console.listOrgs" ? { orgs: h.getReport().orgs } : h.getReport() as unknown as Record<string, unknown> }
  }, result: (_data, human) => { output.push(human); return 0 }, fail: (message) => { throw new Error(message) } })
  try {
    expect(await run({ kind: "console", operation: "setup", tokenFile: "/tmp/private-token", json: false })).toBe(0)
    expect(sent[0]).toEqual({ type: "console.configure", enabled: true, tokenFile: "/tmp/private-token" })
    expect(await run({ kind: "console", operation: "logout", argument: "dev@local.test", json: false })).toBe(0)
    expect(sent.at(-2)?.type).toBe("console.accounts")
    expect(await run({ kind: "console", operation: "orgs", json: false })).toBe(0)
    expect(output.at(-1)).toContain("Engineering  dev@local.test  http://127.0.0.1:8788  engineering")
    expect(await run({ kind: "console", operation: "switch", argument: "research", json: false })).toBe(0)
    expect(sent.at(-1)).toMatchObject({ type: "console.switchOrg", accountID: "local-account", orgID: "research" })
  } finally { await h.app.onKey("\x03") }
})
