import { afterAll, describe, expect, test } from "bun:test"
import path from "node:path"
import type { CommandInput, CommandReply } from "@mendcode/client"
import { parseAutomation, type Automation } from "../src/automation"
import { jobAliases } from "../src/job-aliases"
import { completionScript, systemText } from "../src/support-output"
import { parseStartup } from "../src/startup"
import { SLASH_COMMANDS, parseSlash } from "../src/view/commands"
import { appHarness, cleanTemps, tempDir } from "./session-ui-harness"
import { answer, boot, until } from "../../../packages/daemon/test/native-harness"

afterAll(cleanTemps)
const reply = (value: unknown) => value as CommandReply
const parsed = (...args: string[]): Automation => { const p = parseAutomation(args); if (p.ok !== true) throw new Error(JSON.stringify(p)); return p.command }

describe("background jobs: ps, logs, kill, attach, run --bg", () => {
  test("ps, logs and kill are shorthands over session list --active, events and cancel", () => {
    expect(jobAliases(["ps"])).toEqual(["session", "list", "--active"])
    expect(jobAliases(["--dir", "/tmp/d", "ps", "--all-projects"])).toEqual(["--dir", "/tmp/d", "session", "list", "--active", "--all-projects"])
    expect(jobAliases(["logs", "ses_1", "-f"])).toEqual(["session", "events", "ses_1", "--follow"])
    expect(jobAliases(["kill", "ses_1"])).toEqual(["session", "cancel", "ses_1"])
    expect(jobAliases(["session", "list"])).toEqual(["session", "list"])
    expect(jobAliases(["run", "ps"])).toEqual(["run", "ps"])
    expect(parsed("ps")).toMatchObject({ kind: "session.list", active: true })
    expect(parsed("logs", "ses_1", "-f")).toMatchObject({ kind: "session.events", id: "ses_1", follow: true })
    expect(parsed("logs", "ses_1", "--after", "5", "--limit", "20")).toMatchObject({ kind: "session.events", after: 5, follow: false, limit: 20 })
    expect(parsed("kill", "ses_1")).toMatchObject({ kind: "session.cancel", id: "ses_1" })
    expect(parseAutomation(["kill"]).ok).toBe(false)
    expect(parseAutomation(["logs"]).ok).toBe(false)
  })

  test("run --bg parses; attach opens the TUI on a session; misuse is refused", () => {
    expect(parseStartup(["run", "--bg", "fix the build"])).toMatchObject({ kind: "run", background: true, words: ["fix the build"] })
    expect(parseStartup(["run", "fix the build"]).background).toBeUndefined()
    expect(parseStartup(["attach", "ses_abc"])).toMatchObject({ kind: "tui", session: "ses_abc", words: [] })
    expect(() => parseStartup(["--bg"])).toThrow("--bg requires run")
    for (const flag of [["--ephemeral"], ["--approve"], ["--thinking"], ["-o", "out.txt"], ["--dangerously-skip-permissions"]]) expect(() => parseStartup(["run", "--bg", ...flag, "x"])).toThrow("--bg returns at once")
    expect(() => parseStartup(["attach"])).toThrow("attach needs one session id")
    expect(() => parseStartup(["attach", "a", "b"])).toThrow("attach needs one session id")
    expect(() => parseStartup(["attach", "a", "--session", "b"])).toThrow("do not combine")
    expect(parseStartup(["run", "--bg", "--permission", "plan", "x"])).toMatchObject({ background: true, permission: "plan" })
  })
})

describe("precedence from the CLI", () => {
  test("control-plane system precedence parses and renders which layer is in force and what it overrides", () => {
    expect(parsed("control-plane", "system", "precedence")).toMatchObject({ kind: "system", operation: "precedence" })
    const claims = [
      { surface: "skills", name: "review", layer: "user", rank: 1 },
      { surface: "skills", name: "review", layer: "package user:kit", rank: 0 },
      { surface: "skills", name: "review", layer: "project", rank: 3 },
    ]
    const text = systemText({ operation: "precedence", ok: true, checks: [], failures: [], facts: { claims, layers: ["package user:kit", "user", "project"], truncated: false } })
    expect(text).toContain("Skills")
    expect(text).toContain("- review: project · overrides user, package user:kit")
    expect(completionScript("bash")).toContain("precedence")
  })
})

describe("config layers from the CLI", () => {
  test("control-plane system config-layers parses and renders layers and warnings as text", () => {
    expect(parsed("control-plane", "system", "config-layers")).toMatchObject({ kind: "system", operation: "config-layers" })
    const text = systemText({ operation: "config-layers", ok: true, checks: [], failures: [], facts: { layers: [{ label: "User settings", source: "/d/mendd.db#settings", present: true, entries: ["theme = fjord"] }, { label: "Project file", source: "/p/.mendcode/project.json", present: false, entries: [], note: "ignored: unreadable" }], warnings: ["experimental flags on: code_mode"] } })
    expect(text).toContain("User settings · present")
    expect(text).toContain("  - theme = fjord")
    expect(text).toContain("Project file · not set")
    expect(text).toContain("ignored: unreadable")
    expect(text.indexOf("Warnings")).toBeGreaterThan(text.indexOf("Project file"))
    expect(completionScript("bash")).toContain("config-layers")
    for (const word of ["ps", "logs", "kill", "attach"]) expect(completionScript("zsh")).toContain(word)
  })
})

describe("run --bg against a real daemon", () => {
  test("hands the turn over, prints the session id, and logs and kill see it afterwards", async () => {
    const h = await boot({ steps: [answer("background answer", { input: 10, output: 3 })] })
    try {
      const cli = async (...args: string[]) => {
        const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "../src/entry.ts"), "--dir", h.dir, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, HOME: h.dir, CODEX_HOME: h.dir, MENDCODE_V2_DIR: h.dir, MENDCODE_TRACE: "0" } })
        const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
        return { out, err, code }
      }
      const started = await cli("run", "--bg", "--json", "work in the background", "--cwd", h.project)
      expect(started.code).toBe(0)
      const { sessionId, status } = JSON.parse(started.out) as { sessionId: string; status: string }
      expect(status).toBe("started")
      expect(sessionId).toMatch(/^ses_/)
      await until(() => h.store.turns.list(sessionId as never).some((turn) => turn.status === "completed"))
      const logs = await cli("logs", sessionId)
      expect(logs.code).toBe(0)
      expect(logs.out).toContain("background answer")
      const killed = await cli("kill", sessionId)
      expect(killed.code).toBe(0)
      expect(killed.out).toContain("no active turn")
      const ps = await cli("ps", "--json", "--dir", h.project)
      expect(ps.code).toBe(0)
      expect(JSON.stringify(JSON.parse(ps.out))).not.toContain(sessionId)
      const refused = await cli("run", "--bg", "--approve", "second", "--cwd", h.project)
      expect(refused.code).toBe(64)
      expect(refused.err).toContain("--bg returns at once")
    } finally { await h.cleanup() }
  }, 30_000)
})

describe("slash commands", () => {
  function app(options: { reply?: (command: CommandInput) => unknown; remote?: boolean; settings?: Record<string, unknown>; directory?: string } = {}) {
    const directory = options.directory ?? tempDir("mendcode-b17-")
    const h = appHarness({
      directory,
      ...(options.remote ? { remote: { host: "test.invalid", readOnly: false } } : {}),
      reply: (command) => {
        if (command.type === "settings.get") return reply({ ok: true, result: { settings: options.settings ?? {} } })
        if (command.type === "settings.set") return reply({ ok: true, result: { settings: { ...options.settings, ...(command as { patch: Record<string, unknown> }).patch } } })
        return options.reply ? reply(options.reply(command)) : undefined
      },
    })
    return { h, directory }
  }
  const screen = (h: ReturnType<typeof app>["h"]) => h.text().join("\n")

  test("the commands are listed and resolve to their names; the old aliases do not resolve", () => {
    for (const name of ["fast", "output-style", "experimental", "debug-config", "cd", "pwd"]) expect(parseSlash(`/${name}`)?.command.name).toBe(name)
    expect(parseSlash("/features")).toBeUndefined()
    expect(parseSlash("/warnings")).toBeUndefined()
  })

  test("/fast toggles the priority tier through settings and says it costs more", async () => {
    const { h } = app()
    await h.type("/fast\r")
    expect(h.sentOf("settings.set")[0]).toMatchObject({ patch: { serviceTier: "fast" } })
    expect(screen(h)).toContain("fast mode on")
    await h.type("/fast off\r")
    expect(h.sentOf("settings.set")[1]).toMatchObject({ patch: { serviceTier: null } })
    expect(screen(h)).toContain("fast mode off")
    await h.type("/fast maybe\r")
    expect(h.sentOf("settings.set")).toHaveLength(2)
    expect(screen(h)).toContain("usage: /fast")
  })

  test("/fast on and /fast status say whether it reaches the session's model, and why when it does not", async () => {
    const models = { ok: true, result: { engine: "native", effective: { model: "claude-sonnet-5-5" }, models: [{ id: "claude-sonnet-5-5", name: "Sonnet 5.5", engine: "claude" }] } }
    const fastOn = { ok: true, result: { ...models.result, session: { model: "claude-sonnet-5-5", fast: true }, effective: { model: "claude-sonnet-5-5", fast: true } } }
    const { h } = app({ reply: (command) => (command.type === "models.list" ? models : command.type === "session.model.set" ? fastOn : undefined) })
    h.app.applySettings({ onboarded: true })
    await Bun.sleep(5)
    await h.type("/fast on\r")
    // This terminal's session only: its own choice carries fast, the global setting stays as it was.
    expect(h.sentOf("session.model.set")[0]).toMatchObject({ choice: { model: "claude-sonnet-5-5", fast: true } })
    expect(h.sentOf("settings.set")).toHaveLength(0)
    expect(screen(h)).toContain("fast mode on · not applied to Sonnet 5.5 (Claude")
    // The footer says the same: the mark is there, muted, with n/a.
    expect(screen(h)).toContain("Sonnet 5.5 fast n/a")
    await h.type("/fast status\r")
    expect(screen(h)).toContain("fast mode on · not applied to Sonnet 5.5 (Claude")
  })

  test("/output-style lists, sets and clears the preset", async () => {
    const { h } = app()
    await h.type("/output-style\r")
    expect(screen(h)).toContain("output style: default")
    await h.type("/output-style terse\r")
    expect(h.sentOf("settings.set")[0]).toMatchObject({ patch: { outputStyle: "terse" } })
    await h.type("/output-style default\r")
    expect(h.sentOf("settings.set")[1]).toMatchObject({ patch: { outputStyle: null } })
    await h.type("/output-style loud\r")
    expect(h.sentOf("settings.set")).toHaveLength(2)
    expect(screen(h)).toContain("usage: /output-style")
  })

  test("/experimental lists every flag and toggles one without dropping the others", async () => {
    const { h } = app({ settings: { experimental: { code_mode: true, primary_tools: ["read"] } } })
    await h.type("/experimental\r")
    expect(screen(h)).toContain("Experimental features")
    expect(screen(h)).toMatch(/on\s+code_mode/)
    expect(screen(h)).toMatch(/off\s+async_tools/)
    await h.type("\x1b")
    await h.type("/experimental async_tools on\r")
    expect(h.sentOf("settings.set")[0]).toMatchObject({ patch: { experimental: { code_mode: true, primary_tools: ["read"], async_tools: true } } })
    await h.type("/experimental code_mode\r")
    expect(h.sentOf("settings.set")[1]).toMatchObject({ patch: { experimental: { primary_tools: ["read"] } } })
    expect((h.sentOf("settings.set")[1] as { patch: { experimental: Record<string, unknown> } }).patch.experimental.code_mode).toBeUndefined()
    await h.type("/experimental nonsense on\r")
    expect(h.sentOf("settings.set")).toHaveLength(2)
    expect(screen(h)).toContain("unknown flag nonsense")
  })

  test("/debug-config shows the layers, warnings first, and nothing secret", async () => {
    const { h, directory } = app({
      reply: (command) => command.type === "system.query" ? { ok: true, result: { operation: "config-layers", ok: true, checks: [], failures: [], facts: {
        warnings: ["experimental flags on: code_mode"],
        layers: [
          { id: "defaults", label: "Built-in defaults", source: "MendCode", present: true, entries: [] },
          { id: "user", label: "User settings", source: "/data/mendd.db#settings", present: true, entries: ["theme = fjord", "provider · hidden"] },
          { id: "project", label: "Project file", source: "/p/.mendcode/project.json", present: false, entries: [] },
        ],
      } } } : undefined,
    })
    await h.type("/debug-config\r")
    expect(h.sentOf("system.query")[0]).toEqual({ type: "system.query", directory, operation: "config-layers" })
    const text = screen(h)
    expect(text).toContain("Config layers")
    expect(text.indexOf("Warnings")).toBeLessThan(text.indexOf("User settings"))
    expect(text).toContain("theme = fjord")
    expect(text).toContain("not set")
  })

  test("/cd sends the move and /pwd shows the directory; a remote terminal is refused before sending", async () => {
    const { h } = app({ directory: "/work/here", reply: (command) => command.type === "session.cd" ? { ok: true, result: { directory: "/work/other", previous: "/work/here" } } : undefined })
    await h.type("/pwd\r")
    expect(h.text().filter((row) => row.includes("/work/here")).length).toBeGreaterThan(1)
    await h.type("/cd ../other\r")
    expect(h.sentOf("session.cd")[0]).toEqual({ type: "session.cd", sessionId: h.sessionId, path: "../other" })
    expect(screen(h)).toContain("now in /work/other")
    const refused = app({ reply: (command) => command.type === "session.cd" ? { ok: false, error: { code: "busy", message: "[DAEMON]: Session or child is busy" } } : undefined })
    await refused.h.type("/cd /tmp\r")
    expect(screen(refused.h)).toContain("Session or child is busy")
    const remote = app({ remote: true })
    await remote.h.type("/cd /tmp\r")
    await remote.h.type("/debug-config\r")
    expect(remote.h.sentOf("session.cd")).toHaveLength(0)
    expect(remote.h.sentOf("system.query")).toHaveLength(0)
  })
})
