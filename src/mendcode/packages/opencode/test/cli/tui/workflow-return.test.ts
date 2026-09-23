import { expect, test } from "bun:test"
import { preserveWorkflowReturn } from "../../../src/cli/cmd/tui/context/workflow-return"
import { routeReturnTarget } from "../../../src/cli/cmd/tui/context/route-return"
import type { Route } from "../../../src/cli/cmd/tui/context/route"

test("workflow transcript detours retain the original chat and selected run", () => {
  const origin = { type: "session", sessionID: "origin" } as const
  let route: Route = { type: "workflows", selectedID: "run", returnTo: origin }
  for (let index = 0; index < 3; index++) {
    route = preserveWorkflowReturn(route, { type: "session", sessionID: "worker" })
    route = preserveWorkflowReturn(route, {
      type: "workflows",
      returnTo: { type: "session", sessionID: "worker" },
    })
    expect(routeReturnTarget(route)).toEqual(origin)
    expect(route.type === "workflows" && route.selectedID).toBe("run")
  }
})

test("home-origin workflow returns home after a transcript detour", () => {
  const transcript = preserveWorkflowReturn({ type: "workflows" }, { type: "session", sessionID: "worker" })
  const monitor = preserveWorkflowReturn(transcript, {
    type: "workflows", returnTo: { type: "session", sessionID: "worker" },
  })
  expect(routeReturnTarget(monitor)).toEqual({ type: "home" })
})

test("ordinary session navigation does not retain another workflow origin", () => {
  const transcript = preserveWorkflowReturn({ type: "workflows" }, { type: "session", sessionID: "worker" })
  const other = preserveWorkflowReturn(transcript, { type: "session", sessionID: "other" })
  expect(other).toEqual({ type: "session", sessionID: "other" })
})
