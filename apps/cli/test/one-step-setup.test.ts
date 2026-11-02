import { afterEach, expect, test } from "bun:test"
import type { Settings } from "@mendcode/protocol"
import { appHarness, cleanTemps, tempDir } from "./session-ui-harness"
import { parseAutomation, runAutomation, type AutomationDeps } from "../src/automation"
import { textWidth } from "../src/view/wrap"

afterEach(cleanTemps)
const preview = { digest: "a".repeat(64), text: "PR setup\nEnable reviewer\nAllow publishing reviews to GitHub", changes: ["enable", "publish"], problems: [] as string[] }
test("PR setup waits for one key; cancel and blocked previews never apply", async () => {
  for (const cancel of [false, true]) {
    const h = appHarness({ width: 80, reply: (command) => command.type === "pr.review" ? { ok: true, result: command.action === "setup-preview" ? { setup: preview } : { text: "Setup complete. Watching acme/app" } } : undefined })
    await h.type("/pr setup requested\r")
    expect(h.sentOf("pr.review")).toHaveLength(1)
    expect(h.text().join("\n")).toContain("GitHub")
    expect(h.text().every((line) => textWidth(line) <= 80)).toBe(true)
    await h.type(cancel ? "\x1b" : "\r")
    expect(h.sentOf("pr.review")).toHaveLength(cancel ? 1 : 2)
    if (!cancel) { expect(h.sentOf("pr.review")[1]).toMatchObject({ action: "setup-apply", reason: preview.digest, role: "requested" }); expect(h.text().join("\n")).toContain("PR repositories") }
  }
  const blocked = appHarness({ reply: (command) => command.type === "pr.review" ? { ok: true, result: { setup: { ...preview, problems: ["logged out"], text: "Run gh auth login" } } } : undefined })
  await blocked.type("/pr setup\r"); await blocked.type("\r")
  expect(blocked.sentOf("pr.review")).toHaveLength(1)
})
test("voice setup confirms uploads, preserves provider settings and never records", async () => {
  let settings: Settings = { tier: "full", voice: { provider: "openai", language: "es", enabled: false } }
  const h = appHarness({ width: 80, reply: (command) => {
    if (command.type === "settings.get") return { ok: true, result: { settings } }
    if (command.type === "settings.set") { settings = { ...settings, ...command.patch } as Settings; return { ok: true, result: { settings } } }
    if (command.type === "voice.control") return { ok: true, result: { enabled: settings.voice?.enabled, ready: settings.voice?.enabled, provider: "openai", model: "transcribe", maxSeconds: 60, recording: false, issue: settings.voice?.enabled ? undefined : "voice dictation is off" } }
    return undefined
  } })
  h.app.applySettings(settings)
  await h.type("/voice setup\r")
  expect(h.text().join("\n")).toContain("uploaded")
  expect(h.sentOf("settings.set")).toHaveLength(0)
  await h.type("\r")
  expect(settings.voice).toEqual({ provider: "openai", language: "es", enabled: true })
  expect(h.sentOf("voice.control").every((call) => "action" in call && call.action === "status")).toBe(true)
  expect(h.text().join("\n")).toContain("Voice ready")
})
test("graph setup builds only after confirmation and preserves global settings", async () => {
  const directory = tempDir()
  let settings: Settings = { tier: "balanced", codegraph_index: "off", projectConfig: { "/other": { codegraph_index: "off" } } }
  const h = appHarness({ directory, width: 80, reply: (command) => {
    if (command.type === "settings.get") return { ok: true, result: { settings } }
    if (command.type === "settings.set") { settings = { ...settings, ...command.patch } as Settings; return { ok: true, result: { settings } } }
    if (command.type === "codegraph.overview") return { ok: true, result: { state: "ready", total: { files: 2, symbols: 4 } } }
    return undefined
  } })
  h.app.applySettings(settings)
  await h.type("/graph setup\r")
  expect(h.sentOf("codegraph.overview")).toHaveLength(0)
  await h.type("\r")
  expect(h.sentOf("codegraph.overview")).toHaveLength(1)
  expect(settings.codegraph_index).toBe("off"); expect(settings.projectConfig?.["/other"]?.codegraph_index).toBe("off")
  expect(settings.projectConfig?.[directory]?.codegraph_index).toBe("on")
  expect(h.text().join("\n")).toContain("Graph ready")
})
test("headless setup parser and runner require explicit publishing consent", async () => {
  expect(parseAutomation(["pr", "setup"])).toMatchObject({ ok: false })
  const calls: string[] = []; let output = ""
  const deps = { client: { send: async (command: { action: string }) => { calls.push(command.action); return { ok: true, result: command.action === "setup-preview" ? { setup: preview } : { text: "Setup complete" } } } }, out: { write: (text: string) => { output += text } }, err: { write() {} }, cwd: "/project", now: Date.now, listen() {}, onInterrupt() {} } as unknown as AutomationDeps
  for (const yes of [false, true]) {
    calls.length = 0; output = ""
    const parsed = parseAutomation(["pr", "setup", "requested", "--session", "s_test", "--json", ...(yes ? ["--yes"] : [])])
    expect(parsed.ok).toBe(true); if (parsed.ok !== true) throw new Error("parser")
    expect(await runAutomation(parsed.command, deps)).toBe(yes ? 0 : 4)
    expect(calls).toEqual(yes ? ["setup-preview", "setup-apply"] : ["setup-preview"])
    expect(JSON.parse(output).schema).toBe("mendcode-next.cli.v1")
  }
})
