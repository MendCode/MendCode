import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Settings } from "@mendcode/protocol"
import { configLayers } from "../src/config-layers"
import { bypassesProxy, createProxyFetch } from "../src/network-policy"
import { instructionControls } from "../src/project-control"
import { boot } from "./native-harness"

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })
const temp = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

describe(".claude and .agents resources in the daemon", () => {
  test("commands of a project's .claude/commands list, and the foreignResources setting turns them off", async () => {
    const h = await boot({ steps: [] })
    cleanup.push(h.cleanup)
    mkdirSync(path.join(h.project, ".claude", "commands"), { recursive: true })
    writeFileSync(path.join(h.project, ".claude", "commands", "ship-it.md"), "---\ndescription: Ship it\n---\nShip $ARGUMENTS")
    const names = async () => {
      const reply = await h.client.send({ type: "commands.list", directory: h.project })
      if (!reply.ok) throw new Error(reply.error.message)
      return (reply.result as { commands: Array<{ name: string }> }).commands.map((command) => command.name)
    }
    expect(await names()).toContain("ship-it")
    await h.client.send({ type: "settings.set", patch: { foreignResources: false } })
    expect(await names()).not.toContain("ship-it")
    await h.client.send({ type: "settings.set", patch: { foreignResources: null } })
    expect(await names()).toContain("ship-it")
  })
})

describe("instruction controls", () => {
  test("settings feed fallback names and root markers, with .git as the default marker", () => {
    expect(instructionControls(() => ({})).fallbacks()).toEqual([])
    expect(instructionControls(() => ({})).rootMarkers()).toEqual([".git"])
    const set = instructionControls(() => ({ instructionFallbacks: ["TEAM.md"], projectRootMarkers: ["go.work"] }))
    expect([set.fallbacks(), set.rootMarkers()]).toEqual([["TEAM.md"], ["go.work"]])
  })

  test("the new settings validate: names without separators, enum inherit, http proxy only", () => {
    expect(Settings.safeParse({ instructionFallbacks: ["TEAM.md"], projectRootMarkers: [".hg", "go.work"], loginShell: true, shellCommandPrefix: "set -u" }).success).toBe(true)
    expect(Settings.safeParse({ instructionFallbacks: ["a/b.md"] }).success).toBe(false)
    expect(Settings.safeParse({ shellEnvironment: { inherit: "core", exclude: ["AWS_*"], set: { CI: "1" } } }).success).toBe(true)
    expect(Settings.safeParse({ shellEnvironment: { inherit: "some" } }).success).toBe(false)
    expect(Settings.safeParse({ shellEnvironment: { set: { "BAD NAME": "x" } } }).success).toBe(false)
    expect(Settings.safeParse({ proxy: { url: "http://proxy.local:3128", noProxy: ["internal.corp"], caFile: "/etc/ca.pem" } }).success).toBe(true)
    expect(Settings.safeParse({ proxy: { url: "socks5://proxy.local:1080" } }).success).toBe(false)
    expect(Settings.safeParse({ web: { allowDomains: ["example.com"], blockDomains: ["bad.com"] } }).success).toBe(true)
    expect(Settings.safeParse({ web: { allow: ["example.com"] } }).success).toBe(false)
  })
})

describe("startup problems", () => {
  test("invalid saved settings and an unreadable project file are problems; advisory warnings are not", () => {
    const project = temp("mend-problems-")
    mkdirSync(path.join(project, ".mendcode"))
    writeFileSync(path.join(project, ".mendcode", "project.json"), "{ nope")
    const report = configLayers({ dir: temp("mend-problems-data-"), directory: project, settings: { serviceTier: "fast" } as Settings, environment: {}, invalidSettings: ["unknown setting nonsense: ignored"] })
    expect(report.problems).toHaveLength(2)
    expect(report.problems[0]).toBe("unknown setting nonsense: ignored")
    expect(report.problems[1]).toStartWith(".mendcode/project.json")
    expect(report.warnings.slice(0, 2)).toEqual(report.problems)
    expect(report.warnings.some((line) => line.includes("service tier fast"))).toBe(true)
    expect(report.problems.some((line) => line.includes("service tier"))).toBe(false)
  })

  test("a clean configuration has no problems, and the proxy settings never print their values", () => {
    const project = temp("mend-clean-")
    const settings = { proxy: { url: "http://user:hunter2@proxy.local:3128", caFile: "/x.pem" }, shellEnvironment: { set: { TOKEN: "abc" } } } as unknown as Settings
    const report = configLayers({ dir: temp("mend-clean-data-"), directory: project, settings, environment: {} })
    expect(report.problems).toEqual([])
    expect(JSON.stringify(report.layers)).not.toContain("hunter2")
    expect(JSON.stringify(report.layers)).not.toContain("abc")
  })

  test("system.query config-layers reports saved-setting problems to a local client", async () => {
    const h = await boot({ steps: [] })
    cleanup.push(h.cleanup)
    const reply = await h.client.send({ type: "system.query", directory: h.project, operation: "config-layers" })
    if (!reply.ok) throw new Error(reply.error.message)
    expect((reply.result as { facts: { problems: string[] } }).facts.problems).toEqual([])
  })
})

describe("proxy fetch", () => {
  function recorder() {
    const calls: Array<{ url: string; init: Record<string, unknown> | undefined }> = []
    const base = (async (input: unknown, init?: Record<string, unknown>) => {
      calls.push({ url: String(input), init })
      return new Response("ok")
    }) as unknown as typeof fetch
    return { calls, base }
  }

  test("without a proxy setting the request is untouched", async () => {
    const { calls, base } = recorder()
    await createProxyFetch({ settings: () => ({}), base })("https://api.example.com/v1", { method: "POST" })
    expect(calls[0]!.init).toEqual({ method: "POST" })
  })

  test("a proxy URL is applied per request except for loopback and noProxy hosts", async () => {
    const { calls, base } = recorder()
    const proxied = createProxyFetch({ settings: () => ({ proxy: { url: "http://proxy.local:3128", noProxy: ["internal.corp", ".lan"] } }), base })
    await proxied("https://api.example.com/v1")
    await proxied("http://localhost:11434/api")
    await proxied("https://git.internal.corp/x")
    await proxied(new URL("https://box.lan/y"))
    await proxied(new Request("https://other.dev/z"))
    expect(calls.map((call) => call.init?.proxy)).toEqual(["http://proxy.local:3128", undefined, undefined, undefined, "http://proxy.local:3128"])
  })

  test("an extra CA file is added to the system roots, and a missing file fails the request instead of skipping verification", async () => {
    const dir = temp("mend-ca-")
    const file = path.join(dir, "corp.pem")
    writeFileSync(file, "-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----\n")
    const { calls, base } = recorder()
    await createProxyFetch({ settings: () => ({ proxy: { caFile: file } }), base })("https://api.example.com/")
    const ca = (calls[0]!.init as { tls: { ca: string[] } }).tls.ca
    expect(ca.length).toBeGreaterThan(10)
    expect(ca.at(-1)).toContain("TEST")
    expect(calls[0]!.init?.proxy).toBeUndefined()
    await expect(createProxyFetch({ settings: () => ({ proxy: { caFile: path.join(dir, "missing.pem") } }), base })("https://api.example.com/")).rejects.toThrow()
    expect(calls).toHaveLength(1)
  })

  test("noProxy matching", () => {
    expect(bypassesProxy("127.0.0.1", undefined)).toBe(true)
    expect(bypassesProxy("a.b.corp", ["*.corp"])).toBe(true)
    expect(bypassesProxy("corp", [".corp"])).toBe(true)
    expect(bypassesProxy("notcorp.com", ["corp"])).toBe(false)
    expect(bypassesProxy("anything.io", ["*"])).toBe(true)
  })
})
