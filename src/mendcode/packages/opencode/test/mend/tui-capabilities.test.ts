import { describe, expect, test } from "bun:test"
import {
  capabilityAllowed,
  getMendCapability,
  mendTuiCapabilityVersion,
  resolveCustomizationIntent,
  visibleCustomizationCapabilities,
} from "../../src/mend/tui/capabilities"
import { clearAllActiveCustomizations, listActiveCustomizations } from "../../src/mend/tui/customization-state"
import { clearMendStatus, listMendStatusEntries, setMendStatus } from "../../src/mend/tui/status"
import { clearMendOverlay, focusMendOverlay, listMendOverlays, readFocusedMendOverlayID, setMendOverlay } from "../../src/mend/tui/overlays"
import { clearMendWidget, focusMendWidget, listMendWidgets, mendWidgetRenderContext, notifyMendWidgetVisible, readFocusedMendWidgetID, setMendWidget } from "../../src/mend/tui/widgets"
import { getMendFooter, listMendFooterEntries, setMendFooter, setMendFooterEntry } from "../../src/mend/tui/footer"
import { readMendWorkingIndicator, setMendWorkingIndicator } from "../../src/mend/tui/working-indicator"
import { readMendEditorVisual, renderMendEditor, setMendEditor, setMendEditorVisual } from "../../src/mend/tui/editor-host"

describe("mend tui capabilities", () => {
  test("exposes available and blocked capability metadata", () => {
    expect(mendTuiCapabilityVersion()).toBe("2.0.0")
    expect(getMendCapability("footer.entry")?.status).toBe("available")
    expect(getMendCapability("status")?.id).toBe("footer.entry")
    expect(getMendCapability("widget.sessionBottomDock")?.id).toBe("session.bottomDock")
    expect(getMendCapability("prompt.parser.override")?.status).toBe("blocked")
    expect(capabilityAllowed("status")).toBe(true)
    expect(capabilityAllowed("prompt.parser.override")).toBe(false)
    expect(visibleCustomizationCapabilities().some((item) => item.id === "session.prompt.fullEditor")).toBe(true)
  })

  test("routes vague status-bar requests and blocks parser takeover", () => {
    const statusBar = resolveCustomizationIntent("add a widget to the status bar")
    const parser = resolveCustomizationIntent("override the prompt parser")
    const overlay = resolveCustomizationIntent("show a side chat overlay")

    expect(statusBar.surface).toBe("footer.entry")
    expect(statusBar.status).toBe("resolved")
    expect(parser.surface).toBe("prompt.parser.override")
    expect(parser.status).toBe("blocked")
    expect(parser.alternatives).toContain("session.prompt.visual")
    expect(overlay.surface).toBe("overlay.custom")
    expect(overlay.status).toBe("clarify")
  })

  test("status store is deterministic and removable", () => {
    clearAllActiveCustomizations()
    clearMendStatus("a")
    clearMendStatus("b")
    setMendStatus("b", "second", { order: 2 })
    setMendStatus("a", "first", { order: 1 })
    expect(listMendStatusEntries().map((item) => item.id)).toEqual(["a", "b"])
    expect(listActiveCustomizations().map((item) => item.surface)).toContain("footer.entry")
    clearMendStatus("a")
    clearMendStatus("b")
    expect(listMendStatusEntries()).toEqual([])
  })

  test("overlay replacement clears stale surface state and focus", () => {
    clearAllActiveCustomizations()
    clearMendOverlay("sidecar")

    setMendOverlay("sidecar", () => "first")
    expect(listMendOverlays()).toHaveLength(1)
    expect(listActiveCustomizations("overlay.custom")).toHaveLength(1)
    expect(focusMendOverlay("sidecar")).toBe(true)
    expect(readFocusedMendOverlayID()).toBe("sidecar")

    setMendOverlay("sidecar", () => "second", { nonCapturing: true })
    expect(listActiveCustomizations("overlay.custom")).toEqual([])
    expect(listActiveCustomizations("overlay.nonCapturing")).toHaveLength(1)
    expect(readFocusedMendOverlayID()).toBeUndefined()

    clearMendOverlay("sidecar")
    expect(listMendOverlays()).toEqual([])
    expect(listActiveCustomizations()).toEqual([])
  })

  test("widget store keeps placement ordering and cleanup", () => {
    clearAllActiveCustomizations()
    clearMendWidget("one")
    clearMendWidget("two")
    setMendWidget("two", () => "two", { placement: "belowEditor", order: 2 })
    setMendWidget("one", () => "one", { placement: "belowEditor", order: 1 })
    setMendWidget("dock", () => "dock", {
      placement: "sessionBottomDock",
      order: 0,
      title: "Dock",
      width: 28,
      minWidth: 20,
      maxWidth: 40,
      height: "auto",
      interactive: true,
    })
    setMendWidget("move", () => "above", { placement: "aboveEditor" })
    setMendWidget("move", () => "dock", { placement: "sessionBottomDock" })
    expect(listMendWidgets("belowEditor").map((item) => item.id)).toEqual(["one", "two"])
    expect(listMendWidgets("sessionBottomDock").map((item) => item.id)).toEqual(["dock", "move"])
    expect(listMendWidgets("sessionBottomDock")[0]).toMatchObject({
      title: "Dock",
      width: 28,
      minWidth: 20,
      maxWidth: 40,
      height: "auto",
      interactive: true,
    })
    expect(listActiveCustomizations().map((item) => item.surface)).toContain("editor.widget.below")
    expect(listActiveCustomizations().map((item) => item.surface)).toContain("session.bottomDock")
    expect(listActiveCustomizations("editor.widget.above")).toEqual([])
    clearMendWidget("one")
    clearMendWidget("two")
    clearMendWidget("dock")
    clearMendWidget("move")
    expect(listMendWidgets()).toEqual([])
    expect(listActiveCustomizations()).toEqual([])
  })

  test("interactive widgets activate on visible and focus", () => {
    clearAllActiveCustomizations()
    clearMendWidget("active")
    let visible = 0
    let focus = 0

    setMendWidget("active", () => "active", {
      placement: "sessionBottomDock",
      interactive: true,
      onVisible: () => {
        visible += 1
        return true
      },
      onFocus: () => {
        focus += 1
        return true
      },
    })

    expect(notifyMendWidgetVisible("active")).toBe(true)
    expect(focusMendWidget("active")).toBe(true)
    expect(visible).toBe(1)
    expect(focus).toBe(1)
    expect(readFocusedMendWidgetID()).toBe("active")

    clearMendWidget("active")
    expect(readFocusedMendWidgetID()).toBeUndefined()
  })

  test("widget activation errors do not poison focus state", () => {
    clearAllActiveCustomizations()
    clearMendWidget("broken-visible")
    clearMendWidget("broken-focus")

    setMendWidget("broken-visible", () => "broken", {
      placement: "sessionBottomDock",
      onVisible: () => {
        throw new Error("visible boom")
      },
    })
    setMendWidget("broken-focus", () => "broken", {
      placement: "sessionBottomDock",
      interactive: true,
      onFocus: () => {
        throw new Error("focus boom")
      },
    })

    expect(notifyMendWidgetVisible("broken-visible")).toBe(false)
    expect(focusMendWidget("broken-focus")).toBe(false)
    expect(readFocusedMendWidgetID()).toBeUndefined()

    clearMendWidget("broken-visible")
    clearMendWidget("broken-focus")
  })

  test("widget cleanup disposes previous entries and exposes render context", async () => {
    clearAllActiveCustomizations()
    clearMendWidget("disposable")
    const events: string[] = []

    setMendWidget(
      "disposable",
      ({ maxFps, requestRender }) => {
        events.push(`render:${maxFps}`)
        requestRender()
        return "first"
      },
      {
        placement: "aboveEditor",
        maxFps: 12,
        requestRender: () => {
          events.push("request")
        },
        dispose: () => {
          events.push("dispose:first")
        },
      },
    )

    const first = listMendWidgets("aboveEditor")[0]
    expect(first).toBeDefined()
    expect(mendWidgetRenderContext(first!).maxFps).toBe(12)
    first!.render(mendWidgetRenderContext(first!))
    expect(events).toEqual(["render:12", "request"])

    setMendWidget("disposable", () => "second", {
      placement: "sessionBottomDock",
      dispose: () => {
        events.push("dispose:second")
      },
    })
    await Promise.resolve()
    expect(events).toContain("dispose:first")

    clearMendWidget("disposable")
    await Promise.resolve()
    expect(events).toContain("dispose:second")
  })

  test("footer, working indicator, and editor contracts reset safely", () => {
    clearAllActiveCustomizations()
    setMendFooter(() => "footer")
    setMendFooterEntry("extra", () => "extra", { order: 1 })
    expect(typeof getMendFooter()).toBe("function")
    expect(listMendFooterEntries().map((item) => item.id)).toEqual(["extra"])
    setMendFooter()
    setMendFooterEntry("extra")
    expect(getMendFooter()).toBeUndefined()
    expect(listMendFooterEntries()).toEqual([])

    setMendWorkingIndicator({ frames: ["a", "b"], visible: false, intervalMs: 10 })
    expect(readMendWorkingIndicator().frames).toEqual(["a", "b"])
    expect(readMendWorkingIndicator().visible).toBe(false)
    setMendWorkingIndicator()
    expect(readMendWorkingIndicator().frames).toBeUndefined()
    expect(readMendWorkingIndicator().visible).toBeUndefined()

    setMendEditorVisual({ borderGlyph: "!", normalPrefix: "Compose..." })
    expect(readMendEditorVisual()?.borderGlyph).toBe("!")
    setMendEditorVisual()
    expect(readMendEditorVisual()).toBeUndefined()

    setMendEditor(() => {
      throw new Error("boom")
    })
    expect(renderMendEditor({ defaultEditor: () => "fallback" }) as unknown as string).toBe("fallback")
    setMendEditor()
  })
})
