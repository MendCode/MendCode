import { expect, test } from "bun:test"
import type { CommandInput, CommandReply } from "@mendcode/client"
import type { CacheStatus } from "@mendcode/protocol"
import { helpText, parseAutomation, runAutomation, type AutomationDeps } from "../src/automation"
import { cacheText } from "../src/cache-automation"
import { completionScript } from "../src/support-output"

const report: CacheStatus = { project: "/work/repo", mode: "smart", scope: "project", source: "model", reason: "the provider is selected", configured: { providers: { openai: { models: ["exact"], scope: "project" } } }, local: null, global: null, activeKeeper: false }
const parsed = (args: string[]) => { const result = parseAutomation(args); if (result.ok !== true) throw new Error(JSON.stringify(result)); return result.command }
function harness(reply: CommandReply = { ok: true, result: report }) {
  const sent: CommandInput[] = [], out: string[] = [], err: string[] = []
  const deps: AutomationDeps = { client: { send: async (command) => { sent.push(command); return reply }, subscribe: async () => ({ ok: true }) }, cwd: "/work/repo", now: () => 0, listen: () => {}, onInterrupt: () => {}, out: { write: (text) => out.push(text) }, err: { write: (text) => err.push(text) } }
  return { sent, out, err, run: (args: string[]) => runAutomation(parsed(args), deps) }
}
test("B49 parser accepts all eight flags, aliases and rejects conflicting targets", () => {
  expect(parsed(["--dir", "/tmp/data", "cache", "enable", "--global", "--provider", "openai", "--model", "exact", "--scope", "project", "--format", "json"])).toMatchObject({ kind: "cache", operation: "enable", dir: "/tmp/data", json: true, target: { global: true, provider: "openai", model: "exact", scope: "project" } })
  expect(parsed(["cache", "on", "--session=s", "--json"])).toMatchObject({ operation: "enable", json: true, target: { session: "s" } })
  expect(parsed(["cache", "off", "--global", "--project-path=../other", "--format=text"])).toMatchObject({ operation: "disable", json: false, target: { projectPath: "../other" } })
  expect(parsed(["cache", "status", "--global=false"])).toMatchObject({ target: {} })
  expect(parsed(["cache", "--help"])).toMatchObject({ kind: "help", topic: "cache" })
  expect(helpText()).toContain("cache <status|enable")
  expect(completionScript("bash")).toContain("cache) words='status enable on disable off'")
  for (const args of [["enable", "--model", "m"], ["enable", "--project-path", "/tmp/x"], ["disable", "--session", "s", "--provider", "p"], ["status", "--scope", "global"], ["status", "--format", "table"], ["status", "--json=bad"], ["status", "--unknown"], ["enable", "--provider"], ["status", "extra"]]) expect(parseAutomation(["cache", ...args]).ok).toBe(false)
  expect(parsed(["session", "rename", "ses_x", "cache"])).toMatchObject({ kind: "session.rename", title: "cache" })
})
test("B49 CLI delegates scoped mutations, resolves project paths and emits the normal JSON envelope", async () => {
  const h = harness()
  expect(await h.run(["cache", "enable", "--global", "--project-path", "../other", "--scope", "project", "--json"])).toBe(0)
  expect(h.sent).toEqual([{ type: "cache.set", input: { directory: "/work/repo", action: "enable", global: true, projectPath: "/work/other", scope: "project" } }])
  expect(JSON.parse(h.out[0]!)).toMatchObject({ schema: "mendcode-next.cli.v1", kind: "result", command: "cache", data: report })
  expect(h.err).toEqual([])
})
test("B49 status is text or JSON without mutations; daemon errors remain failures", async () => {
  const h = harness()
  expect(await h.run(["cache", "status", "--provider", "openai", "--model", "exact"])).toBe(0)
  expect(h.sent).toEqual([{ type: "cache.status", directory: "/work/repo", provider: "openai", model: "exact" }])
  expect(h.out.join("")).toBe(cacheText(report))
  expect(h.out[0]).toContain("Scope: project")
  const failed = harness({ ok: false, error: { code: "invalid_command", message: "invalid cache policy" } })
  expect(await failed.run(["cache", "disable", "--json"])).toBe(1)
  expect(JSON.parse(failed.out[0]!)).toMatchObject({ kind: "error", error: { code: "invalid_command", message: "invalid cache policy" } })
})
test("B49 thin CLI cache modules do not import runtime protocol schemas", () => {
  const result = Bun.spawnSync(["bun", "-e", 'await import("./apps/cli/src/automation"); await import("./apps/cli/src/cache-automation"); const keys=Object.keys(require.cache); console.log(JSON.stringify(keys.filter((key)=>key.includes("/zod/")||/protocol\\/src\\/(cache|commands|queries)\\.ts$/.test(key))))'], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" })
  expect(result.exitCode).toBe(0)
  expect(result.stderr.toString()).toBe("")
  expect(JSON.parse(result.stdout.toString())).toEqual([])
})
