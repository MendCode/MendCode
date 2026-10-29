import { afterEach, expect, test } from "bun:test"
import { parseAutomation, runAutomation, type Automation } from "../src/automation"
import { createConsoleAutomation } from "../src/console-automation"
import { SLASH_COMMANDS } from "../src/view/commands"
import { textWidth } from "../src/view/wrap"
import { b74Harness } from "./b74-fixtures"
import { cleanTemps } from "./session-ui-harness"
import type { CommandInput } from "@mendcode/client"

afterEach(cleanTemps)
function parsed(...args: string[]): Automation { const result = parseAutomation(args); if (result.ok !== true) throw new Error(JSON.stringify(result)); return result.command }

test("B74 CLI login/logout/switch/orgs/open aliases, setup and policy validate without printing token values", () => {
  for (const name of ["login", "logout", "switch", "orgs", "open"]) expect(parsed(name)).toMatchObject({ kind: "console", operation: name })
  expect(parsed("console")).toMatchObject({ kind: "console", operation: "status" })
  expect(parsed("console", "setup", "http://127.0.0.1:8788", "--token-file", "/tmp/private-token", "--dir", "/tmp/data", "--json")).toMatchObject({ kind: "console", operation: "setup", tokenFile: "/tmp/private-token", dir: "/tmp/data", json: true })
  for (const args of [["console", "setup"], ["console", "login", "https://example.com"], ["console", "open", "extra"], ["console", "login", "--token", "fake-secret"], ["share", "policy", "on"]]) {
    const result = parseAutomation(args); expect(result.ok).toBe(false); expect(JSON.stringify(result)).not.toContain("fake-secret")
  }
  for (const policy of ["manual", "auto", "disabled"]) expect(parsed("share", "policy", policy)).toMatchObject({ kind: "share", request: { type: "settings.set", patch: { share: policy } } })
  expect(SLASH_COMMANDS.find((command) => command.name === "org")?.aliases).toEqual([])
})

test("Console selector switches org, refreshes catalog, confirms logout, and setup supports cursor/paste", async () => {
  const h = b74Harness()
  try {
    await h.type("/console\r")
    expect(h.text().join("\n")).toContain("Engineering · active")
    await h.keys("\x1b[B", "\r")
    expect(h.sentOf("console.switchOrg")).toHaveLength(1)
    expect(h.text().join("\n")).toContain("Research · active")
    expect(h.sentOf("models.list").length).toBeGreaterThan(0)
    await h.keys("d")
    expect(h.text().join("\n")).toContain("Log out?")
    expect(h.sentOf("console.logout")).toHaveLength(0)
    await h.keys("n", "s", "\t")
    await h.type("\x1b[200~/tmp/token\x1b[201~")
    await h.keys("\x01", "X", "\x7f", "\r")
    expect(h.sentOf("console.configure").at(-1)).toMatchObject({ enabled: true, tokenFile: "/tmp/token" })
    await h.keys("d", "y")
    expect(h.sentOf("console.logout")).toHaveLength(1)
    expect(h.text().join("\n")).toContain("Not logged in")
  } finally { await h.app.onKey("\x03") }
})

test("login code screen polls, opens a validated link and Escape cancels without leaving timers", async () => {
  const h = b74Harness()
  try {
    await h.type("/console\r"); await h.keys("l")
    expect(h.text().join("\n")).toContain("ABCD-EFGH")
    expect(h.sentOf("console.open").at(-1)).toMatchObject({ loginID: "local-login" })
    await h.keys("p")
    expect(h.text().join("\n")).toContain("Logged in as dev@local.test")
    await h.keys("l", "\x1b")
    expect(h.sentOf("console.cancel")).toHaveLength(1)
    expect(h.text().join("\n")).not.toContain("ABCD-EFGH")
  } finally { await h.app.onKey("\x03") }
})

test("share defaults off, policy opt-in, create/sync/copy and unshare confirmation persist through reopen", async () => {
  const h = b74Harness()
  try {
    await h.type("/share\r"); await h.keys("\r")
    expect(h.text().join("\n")).toContain("Sharing is disabled")
    await h.keys("m", "\r")
    expect(h.text().join("\n")).toContain("http://127.0.0.1:8788/share/local-session")
    await h.keys("s", "c", "\x1b")
    expect(h.written.join("")).toContain("\x1b]52;")
    await h.type("/unshare\r")
    expect(h.text().join("\n")).toContain("Unshare this session?")
    expect(h.sentOf("session.unshare")).toHaveLength(0)
    await h.keys("y", "\x1b")
    await h.type("/share\r")
    expect(h.text().join("\n")).toContain("Not shared")
  } finally { await h.app.onKey("\x03") }
})

test("Console errors and remote restrictions remain page-local", async () => {
  const h = b74Harness()
  try { h.failNext(); await h.type("/console\r"); expect(h.text().join("\n")).toContain("HTTP 503"); await h.keys("r"); expect(h.text().join("\n")).not.toContain("HTTP 503") }
  finally { await h.app.onKey("\x03") }
  const remote = b74Harness({ remote: { host: "127.0.0.1", readOnly: false } })
  try { await remote.type("/org\r"); await remote.keys("l", "o"); expect(remote.sentOf("console.get")).toHaveLength(0); expect(remote.sentOf("console.login")).toHaveLength(0); expect(remote.text().join("\n")).toContain("local only") }
  finally { await remote.app.onKey("\x03") }
})

test("Console/share app frames stay within all contracted sizes with header hints and shared grid borders", async () => {
  for (const [width, height] of [[60, 20], [100, 30], [160, 45], [180, 50], [220, 60]]) {
    const h = b74Harness({ width, height })
    try {
      for (const screen of ["/org", "/share"]) {
        await h.type(screen + "\r")
        const frame = h.frames.at(-1)!
        expect(frame).toHaveLength(height!)
        expect(frame.every((row) => textWidth(row.map((span) => span.text).join("")) <= width!)).toBe(true)
        expect(h.text().some((line) => line.includes("┌") || line.includes("╭"))).toBe(true)
        expect(h.text().find((line) => line.includes(screen === "/org" ? "Switch org" : "Share"))).toContain("esc")
        await h.keys("\x1b")
      }
    } finally { await h.app.onKey("\x03") }
  }
})

test("Console automation uses account/org prompts and polls a fake login with its interval, no network", async () => {
  const sent: CommandInput[] = [], output: string[] = []
  const h = b74Harness(), report = h.getReport()
  const run = createConsoleAutomation({ client: {} as never, listen: () => {}, onInterrupt: () => {}, now: () => 0, cwd: "/tmp", out: { write: (value) => output.push(value) }, err: { write: () => {} }, prompt: async (request) => request.options.at(-1)?.value, setTimer: (ms, callback) => { expect(ms).toBe(2000); queueMicrotask(callback); return { cancel: () => {} } }, request: async (command) => {
    sent.push(command)
    if (command.type === "console.login") return { ok: true, result: { loginID: "login", userCode: "CODE", url: "http://127.0.0.1/device", expiresAt: 99999, intervalMs: 2000 } }
    if (command.type === "console.poll") return { ok: true, result: { status: "success", accountEmail: "dev@local.test" } }
    return { ok: true, result: report as unknown as Record<string, unknown> }
  }, result: (_data, text) => { output.push(text); return 0 }, fail: (message) => { throw new Error(message) } })
  try {
    expect(await run({ kind: "console", operation: "login", json: false })).toBe(0)
    expect(output.join("\n")).toContain("Logged in as")
    expect(await run({ kind: "console", operation: "switch", json: false })).toBe(0)
    expect(sent.at(-1)).toMatchObject({ type: "console.switchOrg", orgID: "research" })
    expect(await run({ kind: "console", operation: "logout", json: false })).toBe(0)
    expect(sent.at(-1)).toMatchObject({ type: "console.logout", accountID: "local-account" })
  } finally { await h.app.onKey("\x03") }
})

test("headless console/share paths enter the CLI automation factory", async () => {
  const h = b74Harness(), report = h.getReport(), output: string[] = []
  try {
    const code = await runAutomation(parsed("console", "status"), { client: { send: async () => ({ ok: true, result: report as unknown as Record<string, unknown> }), subscribe: async () => ({ ok: true }) }, cwd: "/tmp", now: () => 0, listen: () => {}, onInterrupt: () => {}, out: { write: (value) => output.push(value) }, err: { write: () => {} } })
    expect(code).toBe(0); expect(output.join("")).toContain("Engineering")
  } finally { await h.app.onKey("\x03") }
})

test("B74 Console view is lazy and all new client paths stay free of runtime protocol schemas", () => {
  const script = `await import("./apps/cli/src/ui/app"); await import("./apps/cli/src/automation"); await import("@mendcode/client");
const has = () => Object.keys(require.cache).some((name) => name.endsWith("/view/console-page.ts"));
const before = has(); const pages = await import("./apps/cli/src/ui/lazy-pages"); await pages.preload("console");
console.log(JSON.stringify({ before, after: has(), zod: Object.keys(require.cache).filter((name) => name.includes("/zod/")).length }))`
  const probe = Bun.spawnSync(["bun", "-e", script], { cwd: new URL("../../..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe" })
  expect(probe.exitCode).toBe(0)
  expect(JSON.parse(probe.stdout.toString())).toEqual({ before: false, after: true, zod: 0 })
})
