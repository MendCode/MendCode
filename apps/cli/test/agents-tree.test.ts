import { afterAll, describe, expect, test } from "bun:test"
import type { SessionTreeNode } from "@mendcode/protocol"
import { glyphs } from "../src/ui/theme"
import type { Line } from "../src/ui/theme"
import { agentsTreeCard, type AgentNode } from "../src/view/sidebar-cards"
import { DEFAULT_TUI_PROFILE, writeTuiProfile } from "../src/view/tui-profile"
import { textWidth } from "../src/view/wrap"
import { appHarness, cleanTemps, ids, NOW, tempDir } from "./session-ui-harness"

afterAll(cleanTemps)

const g = glyphs({})
const plain = (line: Line) => line.map((span) => span.text).join("")
const node = (input: Partial<AgentNode> & Pick<AgentNode, "sessionId" | "title">): AgentNode => ({ kind: "task", ...input })

describe("agents tree card", () => {
  test("bridge-created ACP children use the existing task rows for model, idle state and result", () => {
    const nodes = [
      node({ sessionId: "root", title: "Main", kind: "fork" }),
      node({ sessionId: "idle", parentId: "root", title: "bridge child", model: "acp:demo", state: "idle" }),
      node({ sessionId: "done", parentId: "idle", title: "delegated child", agent: "general", model: "acp:other", state: "completed", headline: "Checked the project" }),
    ]
    const rows = agentsTreeCard({ nodes, rootId: "root", width: 60, glyphs: g }).map(plain).join("\n")
    expect(rows).toContain("acp:demo · idle")
    expect(rows).toContain("general · acp:other · done")
    expect(rows).toContain("Checked the project")
  })
  const nodes: AgentNode[] = [
    node({ sessionId: "root", title: "Main", kind: "fork", state: "idle" }),
    node({ sessionId: "a", parentId: "root", title: "scan the repo", agent: "explore", model: "claude-haiku", state: "completed", headline: "Found 3 entry points" }),
    node({ sessionId: "b", parentId: "root", title: "fix the parser", agent: "general", model: "gpt-6-luna", state: "failed", headline: "tests still red" }),
    node({ sessionId: "c", parentId: "b", title: "read the lexer", agent: "explore", model: "gpt-6-luna", state: "running", headline: "partial output" }),
    node({ sessionId: "d", parentId: "root", title: "fork: try B", kind: "fork", model: "claude-opus", state: "idle", unmerged: 2 }),
  ]

  test("counts what runs, then each sub-agent and fork with model and state; a finished one shows its result, a running one does not", () => {
    const rows = agentsTreeCard({ nodes, rootId: "root", width: 44, glyphs: g }).map(plain)
    expect(rows[0]).toBe("1 running · 1 done · 1 failed")
    expect(rows).toContain(`├─ ${g.ok} scan the repo`)
    expect(rows).toContain("│    explore · claude-haiku · done")
    expect(rows).toContain("│    Found 3 entry points")
    expect(rows).toContain(`├─ ${g.fail} fix the parser`)
    expect(rows.some((row) => row.includes(`${g.running} read the lexer`))).toBe(true)
    expect(rows.some((row) => row.includes("explore · gpt-6-luna · running"))).toBe(true)
    expect(rows.join("\n")).not.toContain("partial output")
    expect(rows).toContain("     fork · claude-opus · idle · +2 unmerged")
  })

  test("only what is below the open session shows, an empty lineage says so, long trees stop at the limit and every row fits", () => {
    expect(agentsTreeCard({ nodes, rootId: "b", width: 30, glyphs: g }).map(plain).join("\n")).toContain("read the lexer")
    expect(agentsTreeCard({ nodes, rootId: "b", width: 30, glyphs: g }).map(plain).join("\n")).not.toContain("scan the repo")
    expect(agentsTreeCard({ nodes, rootId: "c", width: 30, glyphs: g }).map(plain)).toEqual(["No sub-agents"])
    const many = Array.from({ length: 12 }, (_, index) => node({ sessionId: `n${index}`, parentId: "root", title: `sub-agent number ${index} with a long name`, state: "completed", model: "some-very-long-model-name" }))
    const rows = agentsTreeCard({ nodes: many, rootId: "root", width: 24, glyphs: g }).map(plain)
    expect(rows.at(-1)).toBe("+4 more · /tree")
    for (const row of rows) expect(textWidth(row), row).toBeLessThanOrEqual(24)
  })
})

describe("agents widget", () => {
  test("draws the lineage from session.tree and asks again when a sub-agent changes", async () => {
    const sessionId = ids("session"), child = ids("session")
    const dataDir = tempDir()
    writeTuiProfile(dataDir, { ...DEFAULT_TUI_PROFILE, sidebarWidgets: [{ type: "agents", options: {} }], rightSidebar: true })
    let state = "running"
    const tree = (): SessionTreeNode[] => [
      { sessionId, title: "Main", directory: "/project", createdAt: NOW - 1000, updatedAt: NOW, archived: false, current: true, labels: [], kind: "fork", model: "gpt-6-luna", state: "idle" },
      { sessionId: child, parentId: sessionId, title: "scan the repo", directory: "/project", createdAt: NOW - 500, updatedAt: NOW, archived: false, current: false, labels: [], kind: "task", agent: "explore", model: "claude-haiku", state, ...(state === "completed" ? { headline: "Found 3 entry points" } : {}) },
    ]
    const h = appHarness({ width: 150, height: 40, dataDir, directory: tempDir(), sessionId, reply: (command) => command.type === "session.tree" ? { ok: true, result: { current: sessionId, nodes: tree() } } : undefined })
    h.app.applySettings({ onboarded: true })
    h.app.render()
    await Bun.sleep(10)
    h.app.render()
    let frame = h.text().join("\n")
    expect(frame).toContain("1 running")
    expect(frame).toContain("explore · Haiku · running")
    expect(frame).not.toContain("claude-haiku")
    const asked = h.sentOf("session.tree").length
    state = "completed"
    h.app.onGlobal({ type: "task.changed", gseq: 1, at: NOW, sessionId: child, parentId: sessionId })
    await Bun.sleep(10)
    h.app.render()
    frame = h.text().join("\n")
    expect(h.sentOf("session.tree").length).toBeGreaterThan(asked)
    expect(frame).toContain("explore · Haiku · done")
    expect(frame).toContain("Found 3 entry points")
  })
})
