import { describe, expect, test } from "bun:test"
import { createIdFactory, type SessionEvent } from "@mendcode/protocol"
import { createApp } from "../src/ui/app"
import { glyphs, type Line } from "../src/ui/theme"
import { explainApproval } from "../src/view/approval-explain"
import { approvalChoicesOf, approvalOptions, ruleOffer } from "../src/view/request-panel"

const ids = createIdFactory()
const NOW = 1_800_000_000_000
const plain = (line: Line) => line.map((span) => span.text).join("")

function harness(options: { mode?: "balanced" | "minimal"; width?: number; height?: number; send?: (command: Record<string, unknown>) => unknown } = {}) {
  const frames: Line[][] = []
  const sent: Array<Record<string, unknown>> = []
  const screen = { size: { width: options.width ?? 100, height: options.height ?? 30 }, draw: (rows: Line[]) => void frames.push(rows) } as unknown as Parameters<typeof createApp>[0]["screen"]
  const sessionId = ids("session")
  const turnId = ids("turn")
  const app = createApp({
    sessionId,
    screen,
    directory: "/work/app",
    exit() {},
    schedule: (fn) => fn(),
    glyphs: glyphs({}),
    now: () => NOW,
    random: () => 0,
    mode: options.mode ?? "balanced",
    send: (async (command: Record<string, unknown>) => {
      sent.push(command)
      return (await options.send?.(command)) ?? { ok: true }
    }) as never,
  })
  let seq = 0
  const ev = (patch: Record<string, unknown>) => app.onEvent({ sessionId, seq: ++seq, at: NOW, ...patch } as SessionEvent)
  const text = () => frames.at(-1)!.map(plain)
  const key = async (value: string) => {
    await app.onKey(value)
    await Bun.sleep(2)
  }
  const ask = (patch: Record<string, unknown> = {}) => {
    ev({ type: "turn.started", turnId, queueId: ids("queue") })
    const requestId = ids("request")
    ev({ type: "server.request", requestId, turnId, kind: "approval", title: "Run command", detail: "git status -s", tool: "shell", permission: "execute", permissionContext: { name: "bash", patterns: ["git status -s"], always: ["git status -s"] }, ...patch })
    app.render()
    return requestId
  }
  return { app, sent, ev, text, key, ask, sessionId }
}

const decisions = (h: { sent: Array<Record<string, unknown>> }) => h.sent.filter((command) => command.type === "request.resolve").map((command) => command.decision)

for (const mode of ["balanced", "minimal"] as const) test(`memory approval plain text, muted chips and actions (${mode})`, async () => {
  const h = harness({ mode, width: 100 })
  h.ask({ title: "Save to memory?", detail: "The user's name is Nora.\n[user] [preferences]", tool: "memory_graph", permission: "write", permissionContext: undefined })
  const rows = h.text().join("\n")
  expect(rows).toContain("Save to memory?")
  expect(rows).toContain("The user's name is Nora.")
  expect(rows).toContain("[user] [preferences]")
  expect(rows).toContain("Save and don't ask for memory again")
  expect(rows).toContain("Edit text")
  expect(rows).not.toContain("Edit files")
  await h.key("s")
  expect(decisions(h)).toEqual([{ kind: "approve", scope: "once", memoryAlways: true }])
})

test("memory approval edits and saves the exact text, escape keeps approval pending", async () => {
  const h = harness()
  h.ask({ title: "Save to memory?", detail: "Use pnpm\n[project] [commands]", tool: "memory", permissionContext: undefined })
  await h.key("e")
  expect(h.text().join("\n")).toContain("edit memory text")
  await h.key("\x1b")
  expect(decisions(h)).toHaveLength(0)
  await h.key("e")
  await h.key("\x01")
  await h.key("\x0b")
  await h.key("Use bun")
  await h.key("\r")
  expect(decisions(h)).toEqual([{ kind: "approve", scope: "once", memoryText: "Use bun" }])
})

describe("approval choices", () => {
  test("minimal approvals keep every action readable at 60x20", async () => {
    for (const title of ["Run command", "Review plan"]) {
      const h = harness({ mode: "minimal", width: 60, height: 20 })
      h.ask({ title })
      const rows = h.text().join("\n")
      expect(rows).toContain(title === "Review plan" ? "[c] comment" : "[?] explain")
      expect(rows).toContain(title === "Review plan" ? "[d] reject" : "[d] deny")
      await h.key("a")
      expect(decisions(h)).toEqual([{ kind: "approve", scope: "once" }])
    }
  })
  test("a command approval offers always-allow rows without letter keys; without a rule context it is unchanged", () => {
    const offer = ruleOffer({ title: "Run command", tool: "shell", permission: "execute", permissionContext: { name: "bash", patterns: ["git status -s"], always: [] } })
    expect(offer?.label).toBe("`git status *`")
    expect(approvalOptions("Run command", offer).map((option) => [option.choice, option.key])).toEqual([["once", "a"], ["session", "s"], ["project", ""], ["user", ""], ["deny", "d"], ["note", ""]])
    expect(approvalOptions("Run command").map((option) => option.key)).toEqual(["a", "s", "d"])
    expect(approvalOptions("Review plan", offer).map((option) => option.key)).toEqual(["a", "e", "c", "d"])
    expect(ruleOffer({ title: "Run command", permissionContext: { name: "bash", patterns: ["sudo rm x"], always: [] } })).toBeUndefined()
    expect(ruleOffer({ title: "Run command" })).toBeUndefined()
    expect(approvalChoicesOf(undefined)).toEqual([])
  })

  test("the panel shows the rows with the rule named, and picking one by digit saves it for the project", async () => {
    const h = harness({ send: (command) => command.type === "request.resolve" ? { ok: true, result: { remembered: { level: "project", label: "`git status *`" } } } : undefined })
    h.ask()
    const rows = h.text().join("\n")
    expect(rows).toContain("Always allow `git status *` in this project")
    expect(rows).toContain("Always allow `git status *` in all projects")
    expect(rows).toContain("Reject with a note")
    await h.key("3")
    expect(decisions(h)).toEqual([{ kind: "approve", scope: "once", remember: { level: "project" } }])
  })

  test("all projects saves at the user level; arrows and enter reach it too", async () => {
    const h = harness()
    h.ask()
    await h.key("\x1b[B")
    await h.key("\x1b[B")
    await h.key("\x1b[B")
    await h.key("\r")
    expect(decisions(h)).toEqual([{ kind: "approve", scope: "once", remember: { level: "user" } }])
  })

  test("a letter typed into the prompt never saves a rule", async () => {
    const h = harness()
    h.ask()
    await h.key("p")
    await h.key("u")
    await h.key("n")
    expect(decisions(h)).toEqual([])
    expect(h.app.editor.text).toBe("pun")
  })

  test("a refused save shows the daemon's message and the call stays unresolved by the UI", async () => {
    const h = harness({ send: (command) => command.type === "request.resolve" ? { ok: false, error: { code: "invalid_command", message: "[DAEMON]: this request cannot save a rule" } } : undefined })
    h.ask()
    await h.key("3")
    expect(h.text().join("\n")).toContain("this request cannot save a rule")
  })

  test("reject with a note types the reason and sends it as the denial", async () => {
    const h = harness()
    h.ask()
    await h.key("6")
    expect(decisions(h)).toEqual([])
    expect(h.text().join("\n")).toContain("type a note")
    for (const char of "use git diff instead") await h.key(char)
    await h.key("\r")
    expect(decisions(h)).toEqual([{ kind: "deny", reason: "use git diff instead" }])
  })

  test("? explains the request and hides again; it is not offered for a plan review", async () => {
    const h = harness()
    h.ask()
    expect(h.text().join("\n")).not.toContain("Why it asks")
    await h.key("?")
    h.app.render()
    const shown = h.text().join("\n")
    expect(shown).toContain("shell wants to run something on this machine")
    expect(shown).toContain("Why it asks: ask mode asks before every change or command")
    expect(shown).toContain("It matched bash: git status -s")
    expect(decisions(h)).toEqual([])
    await h.key("?")
    h.app.render()
    expect(h.text().join("\n")).not.toContain("Why it asks")
  })

  test("the one-line approval of minimal view names the explain key", () => {
    const h = harness({ mode: "minimal" })
    h.ask()
    expect(h.text().join("\n")).toContain("[?] explain")
  })

  test("the explanation says when no rule can be saved, and uses the daemon's reason in smart mode", () => {
    const none = explainApproval({ tool: "write", permission: "write", mode: "edits" })
    expect(none.join("\n")).toContain("no safe rule to save")
    const smart = explainApproval({ tool: "shell", permission: "execute", mode: "smart", why: "unlisted command (unlisted-command)", context: { name: "bash", patterns: ["a", "b", "c", "d"] } })
    expect(smart[1]).toBe("Why it asks: unlisted command (unlisted-command).")
    expect(smart.join("\n")).toContain("and 1 more")
  })
})

describe("/approve", () => {
  test("approves one retry through the daemon and says what to do next", async () => {
    const h = harness({ send: (command) => command.type === "permissions.retry" ? { ok: true, result: { tool: "shell", summary: "node push.js", reason: "looks like exfiltration" } } : undefined })
    await h.app.onInput("/approve")
    await h.key("\r")
    await Bun.sleep(5)
    expect(h.sent.filter((command) => command.type === "permissions.retry")).toEqual([{ type: "permissions.retry", sessionId: h.sessionId }])
    h.app.render()
    expect(h.text().join("\n")).toContain("retry approved for node push.js")
  })

  test("shows the daemon's answer when nothing was denied", async () => {
    const h = harness({ send: (command) => command.type === "permissions.retry" ? { ok: false, error: { code: "target_mismatch", message: "[DAEMON]: the permission reviewer has not denied a call in this session recently" } } : undefined })
    await h.app.onInput("/approve")
    await h.key("\r")
    await Bun.sleep(5)
    h.app.render()
    expect(h.text().join("\n")).toContain("has not denied a call in this session recently")
  })
})
