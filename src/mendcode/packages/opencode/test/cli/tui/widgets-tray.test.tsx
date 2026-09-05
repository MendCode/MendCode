/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { RGBA, type ScrollBoxRenderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { createSignal } from "solid-js"
import { SessionWidgetTray } from "@/mend/tui/widgets-tray"

const theme = { backgroundElement: RGBA.fromHex("#000000"), border: RGBA.fromHex("#999999") }

test("focused widget tray scrolls horizontally without moving the transcript and reacts to resize", async () => {
  const [width, setWidth] = createSignal(40)
  let focused = 0
  const app = await testRender(
    () => (
      <box flexDirection="column">
        <scrollbox id="transcript" height={2}>
          <text>{Array.from({ length: 20 }, (_, index) => `Transcript line ${index}`).join("\n")}</text>
        </scrollbox>
        <SessionWidgetTray
          width={width()}
          contentWidth={100}
          height={3}
          theme={theme}
          autoFocus
          onAutoFocus={() => {
            focused++
          }}
        >
          <box flexDirection="row" width={100} height={3}>
            <box width={50} flexShrink={0}>
              <text>Commands</text>
            </box>
            <box width={50} flexShrink={0}>
              <text>Second widget</text>
            </box>
          </box>
        </SessionWidgetTray>
        <input id="preserved-input" value="Unsent draft" />
      </box>
    ),
    { width: 110, height: 10 },
  )
  try {
    await app.renderOnce()
    await app.renderOnce()
    const tray = app.renderer.root.findDescendantById("session-widget-tray") as ScrollBoxRenderable
    const transcript = app.renderer.root.findDescendantById("transcript") as ScrollBoxRenderable
    transcript.scrollTo(10)
    await app.renderOnce()
    const transcriptOffset = transcript.scrollTop
    expect(transcriptOffset).toBeGreaterThan(0)
    expect(focused).toBe(1)
    expect(tray.focused).toBe(true)
    expect(app.captureCharFrame()).not.toContain("Second widget")
    for (let i = 0; i < 4; i++) app.mockInput.pressArrow("right")
    await app.renderOnce()
    expect(tray.scrollLeft).toBeGreaterThan(0)
    expect(app.captureCharFrame()).toContain("Second widget")
    expect(transcript.scrollTop).toBe(transcriptOffset)
    expect(app.captureCharFrame()).toContain("Transcript line 10")
    expect(app.captureCharFrame()).toContain("Unsent draft")
    setWidth(100)
    await app.renderOnce()
    await app.renderOnce()
    expect(tray.scrollLeft).toBe(0)
    expect(app.captureCharFrame()).toContain("Commands")
    expect(app.captureCharFrame()).toContain("Second widget")
    expect(focused).toBe(1)
  } finally {
    app.renderer.destroy()
  }
})
