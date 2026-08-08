import { describe, expect, test } from "bun:test"
import { routeReturnTarget, type Route } from "../../../src/cli/cmd/tui/context/route"
import { commandDeckLayout, commandDeckRouteTarget } from "../../../src/cli/cmd/tui/component/command-deck"
import { loopDetailHeaderLayout, loopRouteKeyHint, loopRouteSelectionOffset, loopSchedulerState } from "../../../src/cli/cmd/tui/routes/loops"

describe("tui route helpers", () => {
  test("setup and stats return to the originating session when present", () => {
    const session = { type: "session", sessionID: "ses_active" } as const

    expect(routeReturnTarget({ type: "setup", returnTo: session })).toEqual(session)
    expect(routeReturnTarget({ type: "stats", scope: "global", returnTo: session })).toEqual(session)
  })

  test("setup and stats fall back to home without a return route", () => {
    expect(routeReturnTarget({ type: "setup" })).toEqual({ type: "home" })
    expect(routeReturnTarget({ type: "stats", scope: "project" })).toEqual({ type: "home" })
  })

  test("normal routes return home", () => {
    const route: Route = { type: "session", sessionID: "ses_active" }

    expect(routeReturnTarget(route)).toEqual({ type: "home" })
  })

  test("command deck only activates its three-column layout on wide terminals", () => {
    expect(commandDeckLayout({ width: 140, height: 40 })).toMatchObject({ wide: true, railWidth: 28, contextWidth: 33 })
    expect(commandDeckLayout({ width: 180, height: 40 })).toMatchObject({ railWidth: 36, contextWidth: 43 })
    expect(commandDeckLayout({ width: 300, height: 40 })).toMatchObject({ railWidth: 48, contextWidth: 50 })
    expect(commandDeckLayout({ width: 100, height: 30 }).wide).toBe(false)
  })

  test("loop dashboard keeps arrow navigation inside the workflow list", () => {
    expect(loopRouteSelectionOffset("down")).toBe(1)
    expect(loopRouteSelectionOffset("j")).toBe(1)
    expect(loopRouteSelectionOffset("up")).toBe(-1)
    expect(loopRouteSelectionOffset("k")).toBe(-1)
    expect(loopRouteSelectionOffset("o")).toBeUndefined()
    expect(loopRouteKeyHint({ width: 44, narrow: true, compact: true })).toStartWith("↑↓ select")
  })

  test("loop detail uses spare width to preserve the workflow id", () => {
    expect(loopDetailHeaderLayout(120, 32)).toEqual({ idWidth: 32, titleWidth: 87 })
    expect(loopDetailHeaderLayout(40, 32)).toEqual({ idWidth: 12, titleWidth: 27 })
  })

  test("loop scheduler labels overdue workflows without claiming service health", () => {
    const now = Date.now()
    expect(loopSchedulerState({ state: "sleeping", nextWakeup: now - 3 * 60_000, scheduler: {} }, now)).toBe("overdue")
    expect(loopSchedulerState({ state: "sleeping", nextWakeup: now, scheduler: {} }, now)).toBe("ready")
    expect(loopSchedulerState({ state: "sleeping", scheduler: { degraded: true } }, now)).toBe("degraded")
    expect(loopSchedulerState({ state: "draft" }, now)).toBe("unknown")
  })

  test("command deck route navigation preserves the originating return route", () => {
    const session = { type: "session", sessionID: "ses_active" } as const
    expect(commandDeckRouteTarget({ type: "home" }, "setup")).toEqual({ type: "setup" })
    expect(commandDeckRouteTarget({ type: "loops", returnTo: session }, "changes")).toEqual({
      type: "changes",
      returnTo: session,
    })
    expect(commandDeckRouteTarget({ type: "stats", scope: "project" }, "stats")).toEqual({
      type: "stats",
      scope: "project",
    })
  })
})
