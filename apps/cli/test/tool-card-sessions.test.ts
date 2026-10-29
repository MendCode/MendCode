import { describe, expect, test } from "bun:test"
import { isCompactTool, parseToolTitle, renderToolCard, toolIcon } from "../src/view/tool-card"
import type { Line } from "../src/ui/theme"

const text = (rows: Line[]) => rows.map((row) => row.map((span) => span.text).join(""))
const base = { width: 70, expanded: false, frame: 0, tailLines: 4 }

describe("interactive session and model-tool cards", () => {
  test("shell_session draws as a block with its action and target in the head and the terminal output while running", () => {
    expect(parseToolTitle("shell_session: write pty_1")).toEqual({ name: "shell_session", detail: "write pty_1" })
    expect(isCompactTool("shell_session: start python3 repl.py")).toBe(false)
    expect(toolIcon("shell_session")).toBe("$")
    const running = text(renderToolCard({ ...base, title: "shell_session: start python3 repl.py", text: "pty_1 running 1s 80x24\n>>> ready", status: "running" }))
    expect(running[0]).toContain("Session start python3 repl.py")
    expect(running.join("\n")).toContain(">>> ready")
    const done = text(renderToolCard({ ...base, title: "shell_session: read pty_1", text: "pty_1 exited 0 after 3s\nbye", status: "ok" }))
    expect(done[0]).toContain("Session read pty_1")
  })

  test("a failed session call shows the error in the card", () => {
    const failed = text(renderToolCard({ ...base, title: "shell_session: write pty_9", text: "unknown session pty_9", status: "error" }))
    expect(failed.join("\n")).toContain("Session write pty_9")
  })

  test("sleep, monitor and notebook edits use the same inline and block patterns as their neighbours", () => {
    expect(isCompactTool("sleep: 5s · boot")).toBe(true)
    expect(text(renderToolCard({ ...base, title: "sleep: 5s · boot", text: "waited 5001 ms", status: "ok" }))[0]).toContain("Wait 5s · boot")
    expect(text(renderToolCard({ ...base, title: "shell_monitor: bg_1", text: "monitoring bg_1", status: "ok" }))[0]).toContain("Monitor")
    expect(isCompactTool("notebook_edit: analysis.ipynb")).toBe(false)
    expect(text(renderToolCard({ ...base, title: "notebook_edit: analysis.ipynb", text: "analysis.ipynb: deleted [0] code\n3 cells", status: "ok" }))[0]).toContain("Notebook")
  })
})
