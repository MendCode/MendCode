import { describe, expect, test } from "bun:test"
import { routeReturnTarget, type Route } from "../../../src/cli/cmd/tui/context/route"
import { commandDeckLayout, commandDeckRouteTarget } from "../../../src/cli/cmd/tui/component/command-deck"

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
    expect(commandDeckLayout({ width: 140, height: 40 })).toMatchObject({ wide: true, railWidth: 25, contextWidth: 33 })
    expect(commandDeckLayout({ width: 180, height: 40 }).contextWidth).toBe(42)
    expect(commandDeckLayout({ width: 100, height: 30 }).wide).toBe(false)
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
