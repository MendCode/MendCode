import { describe, expect, test } from "bun:test"
import { routeReturnTarget, type Route } from "../../../src/cli/cmd/tui/context/route"

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
})
