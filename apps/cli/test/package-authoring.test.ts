import { afterEach, expect, test } from "bun:test"
import { parseAutomation, runAutomation, type AutomationDeps } from "../src/automation"
import { packageAuthoringHarness } from "./package-authoring-harness"
import { cleanTemps } from "./session-ui-harness"
import { textWidth } from "../src/view/wrap"
import path from "node:path"

afterEach(cleanTemps)
function parse(...argv: string[]) { const result = parseAutomation(argv); if (result.ok !== true) throw new Error(JSON.stringify(result)); return result.command }

test("authoring CLI aliases preserve all v1 metadata flags, repeated filters and package --version", () => {
  for (const prefix of [["package"], ["packages"], ["marketplace"], ["control-plane", "packages"], ["control-plane", "marketplace"]]) {
    expect(parse("--dir", "/tmp/data", ...prefix, "create", "--id", "review", "--name", "Review Kit", "--description", "Review helpers", "--version", "1.2.3", "--kind", "bundle", "--channel", "local", "--source-type", "local", "--source-url", "./review", "--compat-mendcode", "^2", "--compat-runtime-pack", "^0", "--include", "commands,skills", "--include", "models", "--exclude", "models", "--exclude", "tuiProfile", "--json")).toMatchObject({
      kind: "package.catalog", dir: "/tmp/data", json: true, request: { type: "packages.create", metadata: { id: "review", title: "Review Kit", description: "Review helpers", version: "1.2.3", kind: "bundle", channel: "local", sourceType: "local", sourceURL: "./review", compatMendcode: "^2", compatRuntimePack: "^0" }, include: ["commands", "skills", "models"], exclude: ["models", "tuiProfile"] },
    })
    expect(parse(...prefix, "update", "--version=2")).toMatchObject({ request: { type: "packages.update", metadata: { version: "2" } } })
    expect(parse(...prefix, "delete-local")).toMatchObject({ request: { type: "packages.delete-local" } })
  }
  expect(parse("--version").kind).toBe("version")
  expect(parse("packages", "status", "--dir", "create")).toMatchObject({ kind: "package.list", dir: "create" })
  for (const args of [["create", "--version"], ["create", "--include", "unknown"], ["create", "--exclude", ","], ["create", "--id", "../escape"], ["create", "unexpected"], ["delete-local", "unexpected"]]) expect(parseAutomation(["packages", ...args])).toMatchObject({ ok: false })
})

test("authoring automation sends only protocol requests and keeps the stable result/error envelope", async () => {
  const sent: unknown[] = [], out: string[] = [], err: string[] = []
  const report = { action: "create", name: "review", version: "1.0.0", packagePath: ".mendcode/package-local", manifestPath: ".mendcode/package-local/mendcode-package.json", artifacts: ["commands/review.md"], settings: [] }
  const deps: AutomationDeps = { cwd: "/tmp/project", client: { send: async (command) => { sent.push(command); return { ok: true, result: report } }, subscribe: async () => ({ ok: true }) }, listen() {}, out: { write: (text) => out.push(text) }, err: { write: (text) => err.push(text) }, now: () => 1, onInterrupt() {} }
  expect(await runAutomation(parse("control-plane", "packages", "create", "--id", "review", "--json"), deps)).toBe(0)
  expect(sent).toEqual([{ type: "packages.create", directory: "/tmp/project", metadata: { id: "review" } }])
  expect(JSON.parse(out[0]!)).toMatchObject({ kind: "result", data: report })
  out.length = 0
  expect(await runAutomation(parse("packages", "create"), deps)).toBe(0)
  expect(out.join("")).toContain("create review@1.0.0\nPackage: .mendcode/package-local")
  deps.client.send = async () => ({ ok: false, error: { code: "invalid_command", message: "selected artifact contains credentials" } })
  expect(await runAutomation(parse("packages", "update", "--json"), deps)).toBe(1)
  expect(JSON.parse(out.at(-1)!)).toMatchObject({ kind: "error", error: { code: "invalid_command", message: "selected artifact contains credentials" } })
  expect(err).toEqual([])
})

test("app marketplace reflects locally authored revisions, previews audited assets and removes only the authored entry", async () => {
  for (const [width, height] of [[60, 20], [100, 30], [160, 45], [180, 50], [220, 60]] as const) {
    const h = packageAuthoringHarness(width, height)
    h.author("create")
    await h.type("/marketplace\r")
    expect(h.text().join("\n")).toContain("review-kit")
    expect(h.text().join("\n")).toContain("1.0.0")
    await h.app.onKey("\r")
    expect(h.text().join("\n")).toContain("Preview")
    expect(h.text().join("\n")).toContain("1 skill, 1 command")
    expect(h.sent.some((command) => command.type === "packages.install-catalog")).toBe(false)
    await h.app.onKey("\x1b")
    h.author("update", "2.0.0")
    await h.app.onKey("r")
    await Bun.sleep(5)
    expect(h.text().join("\n")).toContain("2.0.0")
    h.deleteLocal()
    await h.app.onKey("r")
    await Bun.sleep(5)
    expect(h.text().join("\n")).not.toContain("review-kit")
    expect(h.text().join("\n")).toContain("0 packages")
    h.app.render()
    expect(h.frames.at(-1)).toHaveLength(height)
    expect(h.frames.at(-1)!.every((row) => textWidth(row.map((span) => span.text).join("")) <= width)).toBe(true)
    await h.app.onKey("\x03")
  }
})

test("authoring argument parsing keeps the CLI startup graph free of package code and protocol schemas", () => {
  const result = Bun.spawnSync(["bun", "-e", `await import("./src/ui/app"); await import("./src/automation"); await import("@mendcode/client");
const keys = Object.keys(require.cache);
console.log(JSON.stringify({ zod: keys.filter((key) => key.includes("/zod/")).length, packages: keys.filter((key) => key.includes("/packages/packages/")).length, schemas: keys.filter((key) => /protocol\\/src\\/(commands|queries|package-authoring)\\.ts$/.test(key)).length }))`], { cwd: path.join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" })
  expect(result.exitCode).toBe(0)
  expect(result.stderr.toString()).toBe("")
  expect(JSON.parse(result.stdout.toString())).toEqual({ zod: 0, packages: 0, schemas: 0 })
})
