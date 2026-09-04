/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { createSignal } from "solid-js"
import { AgentCommandPanel } from "@/cli/cmd/tui/component/agent-command-panel"
import type { AgentViewCommand } from "@/cli/cmd/tui/util/agent-view"

const theme = {
  text: RGBA.fromHex("#f0f0f0"),
  textMuted: RGBA.fromHex("#999999"),
  accent: RGBA.fromHex("#66ccff"),
  error: RGBA.fromHex("#ff6666"),
}

function command(id: string, state: AgentViewCommand["state"]): AgentViewCommand {
  return {
    id,
    state,
    type: "peer_message",
    sourceSessionID: "source",
    targetSessionID: "target",
    payload: { sourceTitle: "Cache worker", text: "Delayed progress" },
    time: { created: 1, updated: 1 },
  }
}

async function settle(app: Awaited<ReturnType<typeof testRender>>) {
  await app.renderOnce()
  await app.renderOnce()
}

test("collapses historical commands to one row and exposes failure details on demand", async () => {
  const app = await testRender(
    () => (
      <AgentCommandPanel
        sessionID="target"
        commands={[
          { ...command("failed", "failed"), error: "Session stopped by the user." },
          command("expired", "expired"),
          command("completed", "completed"),
        ]}
        width={90}
        theme={theme}
        onUpdate={() => {
          throw new Error("Historical command must not be actionable")
        }}
      />
    ),
    { width: 90, height: 12 },
  )
  try {
    await settle(app)
    expect(app.captureCharFrame().trim()).toBe("▸ Commands · 3 past")
    const toggle = app.renderer.root.findDescendantById("agent-command-history-toggle")!
    await app.mockMouse.click(toggle.x + 1, toggle.y)
    await settle(app)
    const frame = app.captureCharFrame()
    expect(frame).toContain("▾ Commands · 3 past")
    expect(frame).toContain("Cache worker")
    expect(frame).toContain("Session stopped by the user.")
    expect(frame.match(/failed/g)).toHaveLength(1)
    expect(frame).not.toContain("[accept]")
    await app.mockMouse.click(toggle.x + 1, toggle.y)
    await settle(app)
    expect(app.captureCharFrame().trim()).toBe("▸ Commands · 3 past")
  } finally {
    app.renderer.destroy()
  }
})

test("offers a direct button to open the related session", async () => {
  const opened: string[] = []
  const updates: string[] = []
  const app = await testRender(
    () => (
      <AgentCommandPanel
        sessionID="target"
        commands={[command("pending", "pending")]}
        width={60}
        height={7}
        theme={theme}
        onUpdate={(item, state) => updates.push(`${item.id}:${state}`)}
        onOpenSession={(sessionID) => opened.push(sessionID)}
      />
    ),
    { width: 60, height: 8 },
  )
  try {
    await settle(app)
    const open = app.renderer.root.findDescendantById("agent-command-open-pending")!
    const accept = app.renderer.root.findDescendantById("agent-command-accept-pending")!
    const reject = app.renderer.root.findDescendantById("agent-command-reject-pending")!
    expect(open.x + open.width).toBeLessThanOrEqual(60)
    expect(accept.x + accept.width).toBeLessThanOrEqual(60)
    expect(reject.x + reject.width).toBeLessThanOrEqual(60)
    await app.mockMouse.click(open.x + 1, open.y)
    expect(opened).toEqual(["source"])
    await app.mockMouse.click(accept.x + 1, accept.y)
    expect(updates).toEqual(["pending:accepted"])
  } finally {
    app.renderer.destroy()
  }
})

for (const width of [42, 100]) {
  test(`keeps pending actions visible at ${width} columns and reacts to completion`, async () => {
    const [commands, setCommands] = createSignal([command("pending", "pending"), command("old", "failed")])
    const updates: string[] = []
    const app = await testRender(
      () => (
        <AgentCommandPanel
          commands={commands()}
          sessionID="target"
          width={width}
          theme={theme}
          onUpdate={(item, state) => {
            updates.push(`${item.id}:${state}`)
            setCommands((items) =>
              items.map((entry) => (entry.id === item.id ? { ...entry, state: "completed" } : entry)),
            )
          }}
        />
      ),
      { width, height: 8 },
    )
    try {
      await settle(app)
      expect(app.captureCharFrame()).toContain("[accept] [reject]")
      const accept = app.renderer.root.findDescendantById("agent-command-accept-pending")!
      expect(accept.x + accept.width).toBeLessThanOrEqual(width)
      await app.mockMouse.click(accept.x + 1, accept.y)
      await settle(app)
      expect(updates).toEqual(["pending:accepted"])
      expect(app.captureCharFrame().trim()).toBe("▸ Commands · 2 past")
    } finally {
      app.renderer.destroy()
    }
  })
}
