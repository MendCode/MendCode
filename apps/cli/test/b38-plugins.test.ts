import { afterEach, expect, test } from "bun:test"
import type { Client } from "@mendcode/client"
import { parseAutomation } from "../src/automation"
import { parseGlobalOptions } from "../src/global-options"
import { pluginLogin } from "../src/plugin-auth"
import { b38Harness } from "./b38-harness"
import { textWidth } from "../src/view/wrap"
import { createExtensionRuntime } from "../src/extensions/runtime"
import path from "node:path"

const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })

test("plugin/plug flags and global pure parsing preserve existing options", () => {
  expect(parseAutomation(["plug", "demo@1.0.0", "-g", "-f"])).toEqual({ ok: true, command: { kind: "plugin.install", json: false, spec: "demo@1.0.0", global: true, force: true } })
  expect(parseAutomation(["plugin", "file:///tmp/local.ts"])).toMatchObject({ ok: true, command: { global: false, force: false } })
  expect(parseAutomation(["plugin"])).toMatchObject({ ok: false })
  expect(parseAutomation(["plugin", "one", "two"])).toMatchObject({ ok: false })
  expect(parseAutomation(["plugin-auth", "fake", "1"])).toMatchObject({ ok: true, command: { kind: "plugin.auth", provider: "fake", method: 1 } })
  expect(parseGlobalOptions(["--print-logs", "--log-level=ERROR", "run", "--", "--pure"])).toEqual({ args: ["run", "--", "--pure"], printLogs: true, logLevel: "ERROR" })
  expect(parseGlobalOptions(["--pure", "plugin", "demo"])).toEqual({ args: ["plugin", "demo"], printLogs: false, pure: true })
  expect(parseGlobalOptions(["--pure", "--pure=false"])).toEqual({ args: [], printLogs: false })
})

test("API login hides the key input and outputs no credentials", async () => {
  const sent: Array<Record<string, unknown>> = []
  const client = { async send(command: Record<string, unknown>) {
    sent.push(command)
    return { ok: true, result: command.type === "plugins.auth-methods" ? { providers: [{ provider: "fake", methods: [{ type: "api", label: "Key", prompts: [] }] }] } : { authenticated: true } }
  } } as unknown as Pick<Client, "send">
  const prompts: unknown[] = []
  const output: string[] = []
  const result = await pluginLogin(client, "/work", "fake", 0, async (input) => { prompts.push(input); return "secret-input" }, (text) => { output.push(text) })
  expect(prompts).toEqual([{ title: "Key", label: "API key", secret: true }])
  expect(sent[1]).toMatchObject({ type: "plugins.auth-start", inputs: { key: "secret-input" } })
  expect(JSON.stringify(result) + output.join(" ")).not.toContain("secret-input")
})

test("OAuth login prints instructions, collects a private code and completes one flow", async () => {
  const calls: Array<Record<string, unknown>> = []
  const client = { async send(command: Record<string, unknown>) {
    calls.push(command)
    return { ok: true, result: command.type === "plugins.auth-methods" ? { providers: [{ provider: "fake", methods: [{ type: "oauth", label: "OAuth", prompts: [] }] }] } : command.type === "plugins.auth-start" ? { flowId: "fake-flow", url: "https://example.invalid", instructions: "Use local code", method: "code" } : { authenticated: true } }
  } } as unknown as Pick<Client, "send">
  const output: string[] = []
  expect(await pluginLogin(client, "/work", "fake", 0, async (input) => { expect(input.secret).toBe(true); return "private-code" }, (text) => { output.push(text) })).toEqual({ provider: "fake", authenticated: true })
  expect(calls.at(-1)).toMatchObject({ type: "plugins.auth-complete", code: "private-code", flowId: "fake-flow" })
  expect(output.join(" ")).toContain("Use local code")
  expect(output.join(" ")).not.toContain("private-code")
})

test("row SDK modules register slots, aliases, keys, routes and daemon metadata", async () => {
  const h = await b38Harness()
  cleanup.push(h.cleanup)
  expect(h.sent.some((command) => command.type === "plugins.metadata" && command.operation === "get" && command.plugin === "review")).toBe(true)
  expect(h.text()).toContain("Fake local · review")
  await h.type("/review-plugin\r")
  expect(h.text()).toContain("Fake local")
  expect(h.text()).toContain("State")
  expect(h.text()).toContain("┌")
  expect(h.text()).toContain("esc back")
  await h.key("\x1b")
  await h.key("\x07")
  expect(h.text()).toContain("Fake local")
  await h.key("\x1b")
  await h.type("/extensions\r")
  await h.key("\r")
  expect(h.text()).toContain("v1-adapter")
  expect(h.text()).toContain("auth  fake")
})

test("new row SDK page remains bounded in compact, medium and wide grids", async () => {
  for (const [width, height] of [[60, 20], [100, 30], [160, 45], [180, 50], [220, 60]]) {
    const h = await b38Harness(width, height)
    try {
      await h.type("/plugin-review\r")
      const rows = h.rows()
      expect(rows).toHaveLength(height!)
      expect(rows.every((row) => textWidth(row) <= width! && !row.includes("\x1b"))).toBe(true)
      expect(h.text()).toContain("Fake local")
    } finally { await h.cleanup() }
  }
})

test("route registration disposer stops stale rendering after SDK disposal", async () => {
  const runtime = createExtensionRuntime({ redraw() {}, importModule: async () => ({ default: { id: "local", activate(api: { route: { register(input: unknown[]): () => void } }) { const off = api.route.register([{ name: "local", render: () => [[{ text: "visible" }]] }]); off() } } }) })
  await runtime.load([{ file: "/tmp/virtual-local.ts", dir: "/tmp", source: "user", plugin: { kind: "tui", spec: "./virtual-local.ts", options: {} } }])
  expect(runtime.problems).toEqual([])
  runtime.dispose()
})

test("plugin discovery and row SDK keep the startup module graph schema-free", () => {
  const script = `await import("./src/ui/app"); await import("./src/extensions/discover"); await import("./src/extensions/plugin-adapter"); const files = Object.keys(require.cache); console.log(JSON.stringify(files.filter(file => file.includes("/zod/") || /protocol\\/src\\/(commands|queries|events|frames)\\.ts$/.test(file))))`
  const result = Bun.spawnSync([process.execPath, "-e", script], { cwd: path.join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" })
  expect(result.exitCode).toBe(0)
  expect(result.stderr.toString()).toBe("")
  expect(JSON.parse(result.stdout.toString())).toEqual([])
})
