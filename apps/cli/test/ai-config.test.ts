import { afterEach, expect, test } from "bun:test"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { createIdFactory, type AIConfigPlan } from "@mendcode/protocol"
import { createAIConfigAutomation } from "../src/ai-config-automation"
import { parseAIConfig } from "../src/ai-config-args"
import { parseAutomation } from "../src/automation"
import { textWidth } from "../src/view/wrap"
import { b70Harness } from "./b70-harness"
import { cleanTemps } from "./session-ui-harness"

afterEach(cleanTemps)
const planCommand = '/ai-config plan {"intent":"economical","taskKind":"repair","candidates":[{"role":"main"},{"role":"small"}]}\r'

test("B70 CLI parser is scoped and apply requires explicit yes and a JSON input", () => {
  expect(parseAutomation(["--dir", "/tmp/B70", "ai-config", "inspect", "--json"])).toMatchObject({ ok: true, command: { kind: "ai.config", action: "inspect", dir: "/tmp/B70", json: true } })
  expect(parseAIConfig(["ai-config", "apply", "--file", "preview.json"])).toMatchObject({ ok: false })
  for (const args of [["ai-config", "plan"], ["ai-config", "plan", "--input", "{}", "--scope", "outside"], ["ai-config", "inspect", "--unexpected"], ["ai-config", "validate", "--input", "{}", "--file", "preview.json"]]) expect(parseAIConfig(args)).toMatchObject({ ok: false })
  expect(parseAutomation(["session", "list"])).toMatchObject({ ok: true })
})

test("B70 Tab completes without opening the page; plan and cancel never write", async () => {
  const h = b70Harness()
  await h.type("/ai-con\t")
  expect(h.app.page).toBe("chat")
  expect(h.sentOf("ai.config")).toEqual([])
  await h.app.onKey("\r")
  expect(h.app.page).toBe("ai-config")
  await h.app.onKey("p")
  const plan = h.service.run(h.directory, { action: "plan", intent: "balanced", taskKind: "general", candidates: [{ model: "local:main" }] }) as AIConfigPlan
  expect(existsSync(plan.target.path)).toBe(false)
  await h.app.onKey("a")
  expect(h.text().join("\n")).toContain("Save this exact recipe?")
  await h.app.onKey("\x1b")
  expect(h.sentOf("ai.config").some((command) => command.type === "ai.config" && command.input.action === "apply")).toBe(false)
  expect(existsSync(plan.target.path)).toBe(false)
})

test("B70 alternatives refresh their diff; validation precedes save and stale preview is refused", async () => {
  const h = b70Harness()
  const settings = JSON.stringify(h.settings)
  await h.type(planCommand)
  expect(h.text().join("\n")).toContain("local:small")
  expect(h.text().join("\n")).not.toContain("blocked: B24")
  await h.app.onKey("]")
  const checked = h.sentOf("ai.config").at(-1)
  expect(checked).toMatchObject({ input: { action: "validate", patch: { roles: { main: { model: "local:main", effort: "medium" } } } } })
  await h.app.onKey("a")
  await h.app.onKey("\r")
  expect(h.text().join("\n")).toContain("Recipe saved")
  expect(h.text().join("\n")).toContain("Session model unchanged")
  expect(JSON.stringify(h.settings)).toBe(settings)
  await h.app.onKey("a")
  expect(h.text().join("\n")).toContain("changed since preview")
  expect(h.text().join("\n")).toContain("Invalid")
  expect(h.sentOf("ai.config").filter((command) => command.type === "ai.config" && command.input.action === "apply")).toHaveLength(1)
})

for (const [width, height] of [[60, 20], [100, 30], [160, 45], [180, 50], [220, 60]]) test(`B70 app frames fit ${width}x${height}; header hints, panels and compact tabs remain accessible`, async () => {
  const h = b70Harness(width!, height!)
  await h.type(planCommand)
  if (width! < 70) await h.app.onKey("2")
  h.app.render()
  expect(h.text()).toHaveLength(height!)
  expect(h.text().every((row) => textWidth(row) <= width! && !/\x1b/.test(row))).toBe(true)
  expect(h.text()[0]).toContain("p plan")
  expect(h.text().join("\n")).toContain("Preview")
  expect(h.text().join("\n")).toContain("┌")
  expect(h.text().at(-1)).not.toContain("ready")
  await h.app.onKey("a")
  expect(h.text().join("\n")).toContain("Save this exact recipe?")
})

test("B70 read-only peer cannot save or accidentally request an apply", async () => {
  const h = b70Harness(100, 30, true)
  await h.type("/ai-config\r")
  expect(h.text().join("\n")).toContain("full-access connection")
  await h.app.onKey("a")
  await h.app.onKey("\r")
  expect(h.sentOf("ai.config").some((command) => command.type === "ai.config" && command.input.action === "apply")).toBe(false)
})

test("B70 CLI saved preview roundtrip validates and creates its own causal session before writing", async () => {
  const h = b70Harness()
  const ids = createIdFactory()
  const preview = h.request({ action: "plan", intent: "balanced", taskKind: "general", candidates: [{ model: "local:main" }], scope: "project" }) as AIConfigPlan
  const file = path.join(h.directory, "preview.json")
  writeFileSync(file, JSON.stringify(preview))
  const order: string[] = []
  const output: Record<string, unknown>[] = []
  const automation = createAIConfigAutomation({ directory: h.directory, request: async (command) => {
    if (command.type === "session.create") { order.push("session.create"); return { ok: true, result: { sessionId: ids("session") } } }
    if (command.type !== "ai.config") throw new Error("unexpected command")
    order.push(command.input.action)
    const report = h.service.run(h.directory, command.input.action === "apply" ? { ...command.input, sessionId: h.sessionId } : command.input)
    return { ok: true, result: report }
  }, result: (data) => { output.push(data); return 0 }, fail: (message) => { throw new Error(message) } })
  expect(await automation({ kind: "ai.config", action: "apply", json: true, file, yes: true })).toBe(0)
  expect(order).toEqual(["validate", "session.create", "apply"])
  expect(output[0]).toMatchObject({ action: "apply", changed: true })
  expect(JSON.parse(readFileSync(preview.target.path, "utf8"))).toEqual(preview.patch)
})

test("B70 startup and lazy page graphs stay free of schemas and zod", () => {
  const script = 'await import("./apps/cli/src/ui/app"); const before = Object.keys(require.cache).some(k => k.endsWith("/view/ai-config-page.ts")); await (await import("./apps/cli/src/ui/lazy-pages")).preload("ai-config"); const keys = Object.keys(require.cache); console.log(JSON.stringify({ before, after: keys.some(k => k.endsWith("/view/ai-config-page.ts")), zod: keys.some(k => k.includes("/zod/")), schemas: keys.some(k => /protocol\\/src\\/(commands|queries|ai-config)\\.ts$/.test(k)) }))'
  const probe = Bun.spawnSync(["bun", "-e", script], { cwd: path.resolve(import.meta.dir, "../../.."), stdout: "pipe", stderr: "pipe" })
  expect(probe.stderr.toString()).toBe("")
  expect(probe.exitCode).toBe(0)
  expect(JSON.parse(probe.stdout.toString())).toEqual({ before: false, after: true, zod: false, schemas: false })
})
