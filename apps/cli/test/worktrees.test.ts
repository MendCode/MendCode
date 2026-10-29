import { afterEach, describe, expect, test } from "bun:test"
import { parseAutomation, runAutomation, EXIT, helpText } from "../src/automation"
import { preload } from "../src/ui/lazy-pages"
import { renderWorktreesPage } from "../src/view/worktrees-page"
import { textWidth } from "../src/view/wrap"
import { b30Harness, b30Report, warpHarness } from "./b30-fixtures"
import { cleanTemps } from "./session-ui-harness"

afterEach(cleanTemps)
describe("B30 automation", () => {
  test("standalone/control-plane parse all operations and preserve project/data and create flags", () => {
    for (const prefix of [[], ["control-plane"]]) {
      for (const operation of ["status", "doctor", "plan", "create", "open", "adopt", "remove", "reset"]) {
        const target = ["status", "doctor"].includes(operation) ? [] : ["client"]
        const parsed = parseAutomation(["--dir", "/tmp/data", ...prefix, "worktree", operation, ...target, "--project", "/tmp/project", "--json"])
        expect(parsed).toMatchObject({ ok: true, command: { kind: "worktree", dir: "/tmp/data", projectDir: "/tmp/project", json: true } })
      }
    }
    expect(parseAutomation(["control-plane", "worktree", "create", "client", "--branch", "mend/custom", "--base=main", "--path", "../custom", "--focus", "claude"])).toMatchObject({ ok: true, command: { request: { change: { input: { name: "client", branch: "mend/custom", base: "main", path: "../custom", focus: "claude" } } } } })
    expect(helpText("worktree")).toContain("preview")
    expect(parseAutomation(["worktree", "--help"])).toMatchObject({ ok: true, command: { kind: "help", topic: "worktree" } })
  })
  test("invalid arguments cannot request execution or silently drop destructive flags", () => {
    for (const args of [["create"], ["open"], ["remove", "target", "--force"], ["create", "name", "--execute"], ["status", "unexpected"], ["status", "--base", "main"], ["create", "x".repeat(101)], ["open", "unsafe\n"], ["typo", "target"], ["create", "name", "--branch"]]) expect(parseAutomation(["worktree", ...args]).ok).toBe(false)
  })
  test("runner emits the existing JSON envelope and exits 1 for blocked reports", async () => {
    for (const operation of ["status", "doctor", "plan", "create", "open", "adopt", "remove", "reset"]) {
      const parsed = parseAutomation(["control-plane", "worktree", operation, ...(["status", "doctor"].includes(operation) ? [] : ["client"]), "--json", "--project", "/tmp/project"])
      if (parsed.ok !== true) throw new Error("Parse failed")
      let output = "", error = ""
      const report = b30Report()
      report.ok = operation !== "remove" && operation !== "reset"
      const sent: string[] = []
      const code = await runAutomation(parsed.command, { cwd: "/tmp/other", now: () => 0, onInterrupt() {}, listen() {}, out: { write: (text) => { output += text } }, err: { write: (text) => { error += text } }, client: { send: async (command) => { expect(command).toMatchObject({ directory: "/tmp/project" }); sent.push(command.type); return { ok: true, result: report } }, subscribe: async () => ({ ok: true }) } })
      expect(code).toBe(report.ok ? EXIT.ok : EXIT.failed)
      expect(JSON.parse(output)).toMatchObject({ kind: "result", command: "worktree", data: { ok: report.ok } })
      expect(sent).toEqual([["plan", "create", "adopt"].includes(operation) ? "worktree.change" : "worktree.query"])
      expect(error).toBe("")
    }
  })
})
describe("B30 app factories and panels", () => {
  test("Tab only completes; manager opens lazily, refreshes and preserves the session", async () => {
    const harness = b30Harness()
    try {
      await harness.type("/worktr\t")
      expect(harness.sentOf("worktree.query")).toHaveLength(0)
      await harness.type("\r")
      expect(harness.text().join("\n")).toContain("Worktrees · 3")
      await harness.type("\x1b[B\r")
      expect(harness.text().join("\n")).toContain("Session switching blocked")
      expect(harness.sentOf("session.create")).toHaveLength(0)
      expect(harness.sentOf("session.get")).toHaveLength(0)
      await harness.keys("\x1b", "r", "d")
      expect(harness.text().join("\n")).toContain("Doctor")
    } finally { await harness.app.onKey("\x03") }
  })
  test("create fields edit locally; Enter saves a preview, never creates a session", async () => {
    const harness = b30Harness()
    try {
      await harness.type("/worktrees\r")
      await harness.type("c")
      await harness.type("\r")
      expect(harness.text().join("\n")).toContain("Name required")
      await harness.type("clint\x1b[D\x1b[De")
      await harness.type("\x01")
      await harness.type("\x05")
      await harness.type("\t")
      await harness.type("mend/custom")
      await harness.type("\tmain\t/tmp/b30-data/custom\tclaude\r")
      expect(harness.sentOf("worktree.change")).toHaveLength(1)
      expect(harness.sentOf("worktree.change")[0]).toMatchObject({ change: { operation: "create", input: { name: "client", branch: "mend/custom", base: "main", path: "/tmp/b30-data/custom", focus: "claude" } } })
      expect(harness.text().join("\n")).toContain("Git execution: off")
      expect(harness.report().plans).toHaveLength(1)
      expect(harness.sentOf("session.create")).toHaveLength(0)
    } finally { await harness.app.onKey("\x03") }
  })
  test("adopt updates ownership; remove/reset show gates rather than execute", async () => {
    const harness = b30Harness()
    try {
      await harness.type("/worktrees\r\x1b[Bx")
      expect(harness.text().join("\n")).toContain("Target is external")
      await harness.keys("\x1b", "a")
      expect(harness.text().join("\n")).toContain("adopted")
      await harness.type("x")
      expect(harness.text().join("\n")).toContain("Force confirmation: /work/client")
      await harness.keys("\x1b", "z")
      expect(harness.text().join("\n")).toContain("reset --hard")
      expect(harness.sentOf("worktree.change")).toHaveLength(1)
    } finally { await harness.app.onKey("\x03") }
  })
  test("warp lists workspaces from project.rest and moves the session family on Enter", async () => {
    const harness = warpHarness()
    try {
      await harness.type("/warp\r")
      const screen = harness.text().join("\n")
      expect(screen).toContain("Available workspaces · 1")
      expect(screen).toContain("review · mend/review")
      expect(screen).toContain("Local project · current")
      expect(harness.calls.map((call) => call.operation)).toEqual(expect.arrayContaining(["workspace-list", "workspace-status", "current"]))
      await harness.keys("\x1b[B", "\r")
      expect(harness.text().join("\n")).toContain("Local project is already active")
      expect(harness.warps()).toHaveLength(0)
      await harness.keys("\x1b[B", "\r")
      expect(harness.warps()).toEqual([{ operation: "workspace-warp", input: { id: `ws_${"a".repeat(24)}`, sessionID: harness.sessionId } }])
      expect(harness.text().join("\n")).not.toContain("Available workspaces")
    } finally { await harness.app.onKey("\x03") }
  })
  test("warp to the project root sends a null workspace; /warp NAME moves directly", async () => {
    const harness = warpHarness()
    try {
      await harness.type("/warp review\r")
      expect(harness.warps()).toEqual([{ operation: "workspace-warp", input: { id: `ws_${"a".repeat(24)}`, sessionID: harness.sessionId } }])
      await harness.type("/warp local\r")
      expect(harness.warps().at(-1)).toEqual({ operation: "workspace-warp", input: { id: null, sessionID: harness.sessionId } })
      await harness.type("/warp nowhere\r")
      expect(harness.text().join("\n")).toContain('No workspace matches "nowhere"')
      expect(harness.warps()).toHaveLength(2)
    } finally { await harness.app.onKey("\x03") }
  })
  test("new workspace creates a worktree, or registers a directory, then warps into it", async () => {
    const harness = warpHarness()
    try {
      await harness.type("/warp\r")
      await harness.type("\r")
      expect(harness.text().join("\n")).toContain("New workspace")
      await harness.type("\r")
      expect(harness.text().join("\n")).toContain("Name required")
      expect(harness.calls.filter((call) => call.operation === "workspace-create")).toHaveLength(0)
      await harness.type("feature")
      await harness.type("\r")
      expect(harness.calls.find((call) => call.operation === "workspace-create")).toEqual({ operation: "workspace-create", input: { type: "worktree", branch: null, extra: { name: "feature" } } })
      expect(harness.warps()).toEqual([{ operation: "workspace-warp", input: { id: `ws_${"b".repeat(24)}`, sessionID: harness.sessionId } }])
      await harness.type("/warp\r")
      await harness.keys("c", "\t")
      await harness.type("/work/other")
      await harness.type("\r")
      expect(harness.calls.filter((call) => call.operation === "workspace-create").at(-1)).toEqual({ operation: "workspace-create", input: { type: "local", branch: null, extra: { directory: "/work/other" } } })
      expect(harness.warps()).toHaveLength(2)
    } finally { await harness.app.onKey("\x03") }
  })
  test("warp errors from the daemon stay on the page; remove needs a second x", async () => {
    const blocked = warpHarness({ failWarp: "Session or child is busy" })
    try {
      await blocked.type("/warp\r")
      await blocked.keys("\x1b[B", "\x1b[B", "\r")
      expect(blocked.text().join("\n")).toContain("Session or child is busy")
      expect(blocked.text().join("\n")).toContain("Available workspaces")
    } finally { await blocked.app.onKey("\x03") }
    const harness = warpHarness()
    try {
      await harness.type("/warp\r")
      await harness.keys("\x1b[B", "\x1b[B", "x")
      expect(harness.text().join("\n")).toContain("x again removes this workspace")
      expect(harness.calls.filter((call) => call.operation === "workspace-remove")).toHaveLength(0)
      await harness.type("x")
      expect(harness.calls.filter((call) => call.operation === "workspace-remove")).toEqual([{ operation: "workspace-remove", id: `ws_${"a".repeat(24)}` }])
      expect(harness.text().join("\n")).toContain("Available workspaces · 0")
    } finally { await harness.app.onKey("\x03") }
  })
  test("read-only peers never send project.rest from /warp", async () => {
    const harness = warpHarness({ readOnly: true })
    try {
      await harness.type("/warp\r")
      expect(harness.text().join("\n")).toContain("Workspaces unavailable in read-only mode")
      await harness.keys("c", "\x1b[B", "\x1b[B", "\r")
      expect(harness.sentOf("project.rest")).toHaveLength(0)
    } finally { await harness.app.onKey("\x03") }
  })
  test("read-only peers cannot adopt or save create plans", async () => {
    const harness = b30Harness(100, 30, true)
    try {
      await harness.type("/worktrees\r\x1b[Ba")
      expect(harness.text().join("\n")).toContain("Registry writes disabled in read-only mode")
      await harness.type("c")
      expect(harness.sentOf("worktree.change")).toHaveLength(0)
      expect(harness.text().join("\n")).not.toContain("New worktree · preview")
    } finally { await harness.app.onKey("\x03") }
  })
  test("all breakpoints use bounded frames, header hints and visible panel borders", async () => {
    await preload("worktrees")
    for (const [width, height] of [[60, 20], [100, 30], [160, 45], [180, 50], [220, 60]]) {
      for (const mode of ["manager", "warp"] as const) {
        const rows = renderWorktreesPage({ state: { mode, selected: 0, scroll: 0, readOnly: false, report: b30Report() }, width: width!, height: height! })
        expect(rows).toHaveLength(height!)
        expect(rows.every((line) => textWidth(line.map((span) => span.text).join("")) === width)).toBe(true)
        const plain = rows.map((line) => line.map((span) => span.text).join(""))
        expect(plain[0]).toContain("esc")
        expect(plain.at(-1)).toContain("┘")
        expect(plain.join("\n")).not.toMatch(/ready|start of session/)
      }
    }
  })
  test("compact details scroll independently; errors remain visible before long state", async () => {
    const harness = b30Harness(60, 20)
    try {
      await harness.type("/worktrees\r\td")
      await harness.type("\x1b[6~")
      expect(harness.text().join("\n")).toContain("Git checkout: available")
      harness.error("Registry unavailable")
      await harness.type("r")
      expect(harness.text().join("\n")).toContain("Registry unavailable")
    } finally { await harness.app.onKey("\x03") }
  })
})
