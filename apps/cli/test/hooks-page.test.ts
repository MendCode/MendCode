import { describe, expect, test } from "bun:test"
import type { HooksReport } from "@mendcode/protocol"
import { parseGlobalOptions } from "../src/global-options"
import { createHooksPageState, hooksPageKey, renderHooksPage } from "../src/view/hooks-page"
import { lineWidth } from "../src/view/deck"
import { appHarness } from "./extensions-harness"

const REPORT: HooksReport = {
  directory: "/work/app",
  enabled: true,
  trusted: false,
  hooks: [
    { event: "PreToolUse", matcher: "bash|write", command: "./guard.sh --strict", timeoutMs: 10_000, source: "user", file: "/data/hooks.json", active: true },
    { event: "Stop", command: "npm test", timeoutMs: 15_000, source: "project", file: "/work/app/.mendcode/hooks.json", active: false },
  ],
  runs: [
    { at: 1_800_000_000_000, event: "PreToolUse", tool: "bash", source: "user", command: "./guard.sh --strict", outcome: "blocked", exitCode: 2, durationMs: 42, message: "no rm -rf" },
    { at: 1_799_999_990_000, event: "PreToolUse", tool: "write", source: "user", command: "./guard.sh --strict", outcome: "timeout", durationMs: 10_000, message: "timed out after 10000 ms" },
  ],
  problems: ["/work/app/.mendcode/hooks.json: unknown event Bogus"],
  pending: { hooks: 1, tools: 2, extensions: 0 },
}

const answer = (report: HooksReport | Partial<HooksReport> = REPORT, trusted: Partial<HooksReport> = {}) => (command: Record<string, unknown>) =>
  command.type === "hooks.list" ? { ok: true, result: { ...REPORT, ...report, ...trusted } } : command.type === "tools.trust" ? { ok: true, result: { directory: "/work/app", tools: [], issues: [] } } : undefined

const plainRows = (rows: ReturnType<typeof renderHooksPage>) => rows.map((line) => line.map((span) => span.text).join(""))

describe("hooks page view", () => {
  test("lists hooks with state, runs with outcome, problems and the not-trusted warning; every row fits the width", () => {
    for (const [width, height] of [[40, 12], [80, 24], [140, 40]] as const) {
      const hooks = renderHooksPage({ report: REPORT, state: createHooksPageState(), now: 1_800_000_000_000, width, height })
      expect(hooks).toHaveLength(height)
      for (const line of hooks) expect(lineWidth(line)).toBeLessThanOrEqual(width)
      const runs = renderHooksPage({ report: REPORT, state: { ...createHooksPageState(), tab: "runs" }, now: 1_800_000_000_000, width, height })
      expect(runs).toHaveLength(height)
      for (const line of runs) expect(lineWidth(line)).toBeLessThanOrEqual(width)
    }
    const text = plainRows(renderHooksPage({ report: REPORT, state: createHooksPageState(), now: 1_800_000_000_000, width: 100, height: 28 })).join("\n")
    expect(text).toContain("PreToolUse")
    expect(text).toContain("bash|write")
    expect(text).toContain("not trusted")
    expect(text).toContain("unknown event Bogus")
    const runs = plainRows(renderHooksPage({ report: REPORT, state: { ...createHooksPageState(), tab: "runs" }, now: 1_800_000_000_000, width: 100, height: 28 })).join("\n")
    expect(runs).toMatch(/blocked 2/)
    expect(runs).toContain("no rm -rf")
    expect(runs).toMatch(/timeout/)
  })

  test("shows the layer and kind of each hook, and why an http hook does not run", () => {
    const report: HooksReport = {
      ...REPORT,
      trusted: true,
      hooks: [
        { event: "PostToolUseFailure", command: "./lint.sh", timeoutMs: 15_000, source: "user", pkg: "lint-kit", file: "/data/packages/lint-kit/hooks.json", active: true, kind: "command", layer: "user package lint-kit" },
        { event: "Notification", matcher: "question", command: "POST https://hooks.example.test/n", timeoutMs: 15_000, source: "user", file: "/data/hooks.json", active: false, kind: "http", layer: "user", inactiveReason: "url is not in allowedHttpHookUrls" },
        { event: "PreCompact", command: "prompt: keep the plan", timeoutMs: 15_000, source: "project", file: "/work/app/.mendcode/hooks.json", active: true, kind: "prompt", layer: "project" },
      ],
      pending: { hooks: 0, tools: 0, extensions: 0 },
    }
    const page = (selected: number) => plainRows(renderHooksPage({ report, state: { ...createHooksPageState(), selected }, now: 1_800_000_000_000, width: 110, height: 30 })).join("\n")
    const first = page(0)
    expect(first).toContain("PostToolUseFailure")
    expect(first).toContain("user packag")
    expect(first).toContain("layer user package lint-kit")
    expect(first).toContain("command")
    const second = page(1)
    expect(second).toContain("not allowed")
    expect(second).toContain("posts POST https://hooks.example.test/n")
    expect(second).toContain("add this url to the allowedHttpHookUrls setting")
    expect(second).not.toContain("press t to let this project")
    expect(page(2)).toContain("asks  prompt: keep the plan")
    for (const [width, height] of [[40, 14], [80, 24]] as const) for (const line of renderHooksPage({ report, state: createHooksPageState(), now: 1_800_000_000_000, width, height })) expect(lineWidth(line)).toBeLessThanOrEqual(width)
  })

  test("an empty project shows how to add hooks; disabled hooks say why", () => {
    const empty = plainRows(renderHooksPage({ report: { ...REPORT, hooks: [], runs: [], problems: [], pending: { hooks: 0, tools: 0, extensions: 0 }, enabled: false }, state: createHooksPageState(), now: 0, width: 90, height: 24 })).join("\n")
    expect(empty).toContain("no hooks")
    expect(empty).toContain("MENDCODE_HOOKS=0")
    expect(empty).toContain("PreToolUse")
  })

  test("keys: tab switches, arrows move, t toggles trust, y/n answer the prompt and nothing else does", () => {
    const state = createHooksPageState()
    expect(hooksPageKey(state, "\t", REPORT).state.tab).toBe("runs")
    expect(hooksPageKey(state, "j", REPORT).state.selected).toBe(1)
    expect(hooksPageKey(state, "j", REPORT).state).not.toBe(state)
    expect(hooksPageKey(state, "k", REPORT).state).toBe(state)
    expect(hooksPageKey(state, "t", REPORT).action).toEqual({ type: "trust", trusted: true })
    expect(hooksPageKey(state, "t", { ...REPORT, trusted: true }).action).toEqual({ type: "trust", trusted: false })
    expect(hooksPageKey(state, "r", REPORT).action).toEqual({ type: "refresh" })
    expect(hooksPageKey(state, "\x1b", REPORT).action).toEqual({ type: "close" })
    const prompt = createHooksPageState(true)
    expect(hooksPageKey(prompt, "y", REPORT).action).toEqual({ type: "trust", trusted: true })
    expect(hooksPageKey(prompt, "n", REPORT).action).toEqual({ type: "close" })
    expect(hooksPageKey(prompt, "t", REPORT).action).toEqual({ type: "none" })
    expect(hooksPageKey(prompt, "r", REPORT).action).toEqual({ type: "none" })
    const text = plainRows(renderHooksPage({ report: REPORT, state: prompt, now: 0, width: 90, height: 24 })).join("\n")
    expect(text).toContain("Trust the code in this project?")
    expect(text).toContain("1 shell hook, 2 custom tools")
    expect(text).toContain("y trust this project")
  })
})

describe("/hooks and /trust in the app", () => {
  test("/hooks asks the daemon for this project's report and shows it; t trusts, r refreshes, esc leaves", async () => {
    const h = await appHarness({ width: 110, height: 34, reply: answer() })
    await h.start({ onboarded: true })
    h.sent.length = 0
    await h.type("/hooks")
    await h.key("\r")
    await Bun.sleep(5)
    h.app.render()
    expect(h.app.page).toBe("hooks")
    expect(h.sent.find((command) => command.type === "hooks.list")).toEqual({ type: "hooks.list", directory: "/work/app" })
    expect(h.text()).toContain("guard.sh")
    await h.key("t")
    await Bun.sleep(5)
    expect(h.sent.find((command) => command.type === "tools.trust")).toEqual({ type: "tools.trust", directory: "/work/app", trusted: true })
    expect(h.sent.filter((command) => command.type === "hooks.list")).toHaveLength(2)
    await h.key("r")
    await Bun.sleep(5)
    expect(h.sent.filter((command) => command.type === "hooks.list")).toHaveLength(3)
    await h.key("\x1b")
    expect(h.app.page).toBe("chat")
  })

  test("an older daemon's refusal is shown instead of a blank page", async () => {
    const h = await appHarness({ width: 100, height: 30, reply: (command) => command.type === "hooks.list" ? { ok: false, error: { code: "invalid_command", message: "unknown command" } } : undefined })
    await h.start({ onboarded: true })
    await h.type("/hooks")
    await h.key("\r")
    await Bun.sleep(5)
    h.app.render()
    expect(h.text()).toContain("older than this terminal")
  })

  test("/trust asks first when something waits, /trust on and off set trust directly, usage is explained", async () => {
    const h = await appHarness({ width: 100, height: 30, reply: answer() })
    await h.start({ onboarded: true })
    await h.type("/trust")
    await h.key("\r")
    await Bun.sleep(5)
    h.app.render()
    expect(h.app.page).toBe("hooks")
    expect(h.text()).toContain("Trust the code in this project?")
    h.sent.length = 0
    await h.key("n")
    expect(h.app.page).toBe("chat")
    expect(h.sent.some((command) => command.type === "tools.trust")).toBe(false)

    await h.type("/trust")
    await h.key("\r")
    await Bun.sleep(5)
    await h.key("y")
    await Bun.sleep(5)
    expect(h.sent.find((command) => command.type === "tools.trust")).toEqual({ type: "tools.trust", directory: "/work/app", trusted: true })
    expect(h.app.page).toBe("chat")

    h.sent.length = 0
    await h.type("/trust off")
    await h.key("\r")
    await Bun.sleep(5)
    expect(h.sent.find((command) => command.type === "tools.trust")).toMatchObject({ trusted: false })
    await h.type("/trust nonsense")
    await h.key("\r")
    await Bun.sleep(5)
    h.app.render()
    expect(h.text()).toContain("usage: /trust [on|off|status]")
  })

  test("/trust status never opens a prompt", async () => {
    const h = await appHarness({ width: 100, height: 30, reply: answer({}, { trusted: true, pending: { hooks: 0, tools: 0, extensions: 0 } }) })
    await h.start({ onboarded: true })
    await h.type("/trust status")
    await h.key("\r")
    await Bun.sleep(5)
    h.app.render()
    expect(h.app.page).toBe("chat")
    expect(h.text()).toContain("this project is trusted")
  })
})

describe("startup trust prompt", () => {
  test("a project with hooks, tools or extensions waiting for trust asks once the app starts; nothing waiting or --no-approve does not", async () => {
    const asked = await appHarness({ width: 100, height: 30, reply: answer() })
    await asked.start({ onboarded: true })
    await asked.app.start()
    await Bun.sleep(10)
    asked.app.render()
    expect(asked.app.page).toBe("hooks")
    expect(asked.text()).toContain("Trust the code in this project?")

    const nothing = await appHarness({ width: 100, height: 30, reply: answer({}, { pending: { hooks: 0, tools: 0, extensions: 0 } }) })
    await nothing.start({ onboarded: true })
    await nothing.app.start()
    await Bun.sleep(10)
    expect(nothing.app.page).toBe("chat")

    const declined = await appHarness({ width: 100, height: 30, trustPrompt: false, reply: answer() })
    await declined.start({ onboarded: true })
    declined.sent.length = 0
    await declined.app.start()
    await Bun.sleep(10)
    expect(declined.app.page).toBe("chat")
    expect(declined.sent.some((command) => command.type === "hooks.list")).toBe(false)
  })
})

describe("--approve and --no-approve", () => {
  test("are global flags that leave the command and literal arguments alone; --approve also still reaches the command", () => {
    expect(parseGlobalOptions(["--approve", "run", "fix it"])).toMatchObject({ approve: true, args: ["--approve", "run", "fix it"] })
    expect(parseGlobalOptions(["session", "send", "ses_1", "hi", "--approve"])).toMatchObject({ approve: true, args: ["session", "send", "ses_1", "hi", "--approve"] })
    expect(parseGlobalOptions(["--no-approve"])).toMatchObject({ approve: false, args: [] })
    expect(parseGlobalOptions(["--approve", "--no-approve"]).approve).toBe(false)
    expect(parseGlobalOptions(["run", "--", "--approve"])).toMatchObject({ args: ["run", "--", "--approve"] })
    expect("approve" in parseGlobalOptions(["session", "list"])).toBe(false)
    expect(() => parseGlobalOptions(["--approve=yes"])).toThrow("--no-approve")
  })
})
