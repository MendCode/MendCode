import { afterEach, describe, expect, test } from "bun:test"
import { b78Harness, B78_SCREENS } from "./b78-harness"
import { cleanTemps } from "./session-ui-harness"
import { createWorkflowsPageState, workflowsPageKey } from "../src/view/workflows-page"
import { textWidth } from "../src/view/wrap"

afterEach(cleanTemps)

describe("B78 workflows app frames and keys", () => {
  test("real app factory renders phase/map/queue/blocked/preview at required and compact dimensions", async () => {
    for (const [width, height] of [[60, 20], [100, 30], [160, 45], [180, 50], [220, 60]]) for (const screen of B78_SCREENS) {
      const current = b78Harness(width!, height!, screen)
      await current.type(screen === "preview" ? "/workflows b78\r" : "/workflows\r")
      if (screen !== "preview") {
        expect(current.text().slice(0, 3).join("\n")).toContain("esc back")
        await current.app.onKey("\r")
      }
      const frame = current.frames.at(-1)!
      expect(frame).toHaveLength(height!)
      expect(frame.every((line) => textWidth(line.map((span) => span.text).join("")) <= width!)).toBe(true)
      const text = current.text().join("\n")
      expect(text).not.toContain("\x1b")
      if (screen !== "preview") {
        expect(text).toMatch(/Discover ─+ . Inspect ─+ . Report|Discover─.─.|─/)
        expect(text).toContain("esc list")
        if (screen === "queue") expect(text).toContain("waits for")
        else if (screen === "barrier") expect(text).toContain("Stopped in Discover: source failed")
        else expect(text).toContain("1/2 items")
        if (screen === "barrier") expect(text).not.toMatch(/✗ Inspect/)
        if (screen === "queue") expect(text).toContain("phase 1 of 3")
        await current.app.onKey("\x1b")
      } else {
        expect(text).toContain("overlap queue")
        expect(current.sentOf("workflow.start")).toHaveLength(0)
      }
      await current.app.onKey("\x1b")
    }
  })

  test("queued stop works, accept is disabled, and phase details follow task focus", async () => {
    const current = b78Harness(180, 50, "queue")
    const state = createWorkflowsPageState()
    expect(workflowsPageKey(state, "a", [current.summary]).action.type).toBe("none")
    const confirm = workflowsPageKey(state, "x", [current.summary])
    expect(workflowsPageKey(confirm.state, "y", [current.summary]).action).toMatchObject({ type: "control", action: "stop" })
    const map = b78Harness(180, 50)
    await map.type("/workflows\r")
    await map.app.onKey("\r")
    await map.app.onKey("i")
    map.app.render()
    // The phase in progress, with when it counts as done.
    expect(map.text().join("\n")).toMatch(/barrier +Inspect · all/)
    await map.app.onKey("\x1b")
    await map.app.onKey("\x1b")
  })

  test("confirmed slash start uses existing command and shows persisted queue state", async () => {
    const current = b78Harness(100, 30, "queue")
    await current.type("/workflows b78 --yes\r")
    expect(current.sentOf("workflow.start")).toHaveLength(1)
    expect(current.sentOf("workflow.start")[0]).toMatchObject({ directory: current.run.directory, plan: { ref: "b78" } })
    expect(current.text().join("\n")).toContain("queued")
    await current.app.onKey("\x1b")
  })
})
