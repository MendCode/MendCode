import { expect, test } from "bun:test"
import { parseAutomation, runAutomation, type Automation, type AutomationDeps } from "../src/automation"

function parse(...args: string[]): Automation { const parsed = parseAutomation(args); if (parsed.ok !== true) throw new Error(JSON.stringify(parsed)); return parsed.command }

test("package status/use/source/deselect aliases and runtime registry resolve to v2 commands", () => {
  for (const prefix of [["packages"], ["marketplace"], ["control-plane", "packages"], ["control-plane", "marketplace"]]) {
    expect(parse(...prefix, "status")).toMatchObject({ kind: "package.list" })
    expect(parse(...prefix, "use", "review", "team", "--project")).toMatchObject({ kind: "package.catalog", request: { type: "packages.install-catalog", name: "review", sourceId: "team", scope: "project" } })
    expect(parse(...prefix, "use-source", "team")).toMatchObject({ request: { type: "packages.install-source", sourceId: "team" } })
    expect(parse(...prefix, "deselect", "project:review")).toMatchObject({ kind: "package.enable", name: "review", scope: "project", enabled: false })
    expect(parse(...prefix, "deselect-all")).toMatchObject({ request: { type: "packages.disable-all" } })
  }
  for (const prefix of [["runtime", "registry"], ["control-plane", "runtime", "registry"]]) {
    expect(parse(...prefix, "status")).toMatchObject({ request: { type: "packages.sources" } })
    expect(parse(...prefix, "add", "team", "--type", "local", "--url", "/tmp/team", "--enable")).toMatchObject({ request: { type: "packages.add-source", sourceId: "team", location: "/tmp/team", enabled: true } })
    expect(parse(...prefix, "preview", "team")).toMatchObject({ request: { type: "packages.preview", sourceId: "team" } })
    expect(parse(...prefix, "apply", "team")).toMatchObject({ request: { type: "packages.install-source", sourceId: "team" } })
  }
  expect(parseAutomation(["packages", "add-source", "x", "--type", "github", "--url", "https://example.test"])).toMatchObject({ ok: false })
  expect(parseAutomation(["packages", "show"])).toMatchObject({ ok: false })
  expect(parse("control-plane", "packages", "status", "--dir", "control-plane")).toMatchObject({ kind: "package.list", dir: "control-plane" })
})

test("remote catalogs, npm installs and resource switches resolve to protocol commands", async () => {
  expect(parse("packages", "add-source", "hub", "https://hub.example/index.json", "--type", "remote", "--enable")).toMatchObject({ request: { type: "packages.add-source", sourceId: "hub", location: "https://hub.example/index.json", enabled: true } })
  expect(parse("packages", "add-source", "hub", "--url", "https://hub.example/index.json")).toMatchObject({ request: { type: "packages.add-source", enabled: false } })
  expect(parse("packages", "refresh", "hub")).toMatchObject({ request: { type: "packages.refresh", sourceId: "hub" } })
  expect(parseAutomation(["packages", "refresh"])).toMatchObject({ ok: false })
  expect(parse("packages", "install", "npm:acme@1.2.3", "--project")).toMatchObject({ kind: "package.install", source: "npm:acme@1.2.3", scope: "project" })
  expect(parse("packages", "config")).toMatchObject({ request: { type: "packages.config" } })
  expect(parse("packages", "config", "acme")).toMatchObject({ request: { type: "packages.config", key: "user:acme" } })
  expect(parse("packages", "config", "acme", "--project")).toMatchObject({ request: { key: "project:acme" } })
  expect(parse("packages", "config", "project:acme", "disable", "skills/deploy")).toMatchObject({ request: { type: "packages.resource", key: "project:acme", resource: "skills/deploy", enabled: false } })
  expect(parse("packages", "config", "acme", "enable", "commands/review")).toMatchObject({ request: { type: "packages.resource", key: "user:acme", resource: "commands/review", enabled: true } })
  for (const bad of [["config", "acme", "disable"], ["config", "acme", "toggle", "skills/a"]]) expect(parseAutomation(["packages", ...bad])).toMatchObject({ ok: false })
  const out: string[] = []
  const config = { directory: "/p", packages: [{ key: "user:acme", name: "acme", source: "user", resources: [{ id: "skills/deploy", kind: "skills", name: "deploy", enabled: false }, { id: "commands/review", kind: "commands", name: "review", enabled: true }] }, { key: "user:empty", name: "empty", source: "user", resources: [] }] }
  const deps: AutomationDeps = { cwd: "/tmp/project", client: { send: async () => ({ ok: true, result: config }), subscribe: async () => ({ ok: true }) }, listen() {}, out: { write: (text) => out.push(text) }, err: { write() {} }, now: () => 1, onInterrupt() {} }
  expect(await runAutomation(parse("packages", "config"), deps)).toBe(0)
  expect(out.join("")).toBe("user:acme\n  off skills/deploy\n  on  commands/review\nuser:empty\n  no resources\n")
  out.length = 0
  deps.client.send = async () => ({ ok: true, result: { sources: [{ id: "local", location: "/p", enabled: true, builtin: true }, { id: "hub", location: "https://hub.example/index.json", enabled: true, builtin: false, remote: true, fetchedAt: Date.UTC(2026, 9, 3, 12, 30) }], entries: 3 } })
  await runAutomation(parse("packages", "refresh", "hub"), deps)
  expect(out.join("")).toBe("fetched 3 packs\nlocal\ton\t/p\nhub\ton\thttps://hub.example/index.json\tremote, fetched 2026-10-03 12:30\n")
})

test("catalog automation crosses only the protocol boundary and keeps stable JSON/error output", async () => {
  const sent: unknown[] = [], out: string[] = [], err: string[] = []
  const report = { entries: [{ name: "review", version: "1", sourceId: "team", state: "available", description: "Review" }], issues: [], query: "review" }
  const deps: AutomationDeps = { cwd: "/tmp/project", client: { send: async (command) => { sent.push(command); return { ok: true, result: report } }, subscribe: async () => ({ ok: true }) }, listen() {}, out: { write: (text) => out.push(text) }, err: { write: (text) => err.push(text) }, now: () => 1, onInterrupt() {} }
  expect(await runAutomation(parse("packages", "search", "review", "team", "--json"), deps)).toBe(0)
  expect(sent).toEqual([{ type: "packages.search", directory: "/tmp/project", query: "review", sourceId: "team" }])
  expect(JSON.parse(out[0]!)).toMatchObject({ kind: "result", data: report })
  out.length = 0
  await runAutomation(parse("packages", "search", "review", "team"), deps)
  expect(out.join("")).toBe("team:review\t1\tavailable\tReview\n")
  deps.client.send = async () => ({ ok: false, error: { code: "invalid_command", message: "disabled source" } })
  expect(await runAutomation(parse("packages", "show", "review"), deps)).toBe(1)
  expect(err.join("")).toContain("disabled source")
})
