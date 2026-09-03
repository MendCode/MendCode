import { describe, expect, test } from "bun:test"
import { sessionDescriptors } from "../../src/tool/peers"
import type { Session } from "../../src/session/session"
import type { SessionStatus } from "../../src/session/status"

function session(id: string, updated: number, title = id) {
  return {
    id,
    title,
    time: { created: updated - 1_000, updated },
    workspaceID: "workspace-a",
  } as Session.Info
}

describe("session directory", () => {
  test("returns bounded same-project descriptors without the current session", () => {
    const sessions = [session("current", 10), session("older", 20, "Older worker"), session("newer", 30, "New worker")]
    const statuses = new Map<string, SessionStatus.Info>([
      ["older", { type: "busy", message: "Inspecting files" }],
      ["newer", { type: "idle" }],
    ])

    expect(sessionDescriptors({ sessions, statuses, currentSessionID: "current", limit: 10 })).toEqual([
      {
        sessionID: "newer",
        title: "New worker",
        state: "idle",
        workspaceID: "workspace-a",
        updatedAt: 30,
      },
      {
        sessionID: "older",
        title: "Older worker",
        state: "busy",
        activity: "Inspecting files",
        workspaceID: "workspace-a",
        updatedAt: 20,
      },
    ])
  })

  test("caps the requested limit and activity text", () => {
    const longActivity = "x".repeat(300)
    const descriptors = sessionDescriptors({
      sessions: Array.from({ length: 40 }, (_, index) => session(`peer-${index}`, index)),
      statuses: new Map([["peer-39", { type: "busy", message: longActivity } as SessionStatus.Info]]),
      currentSessionID: "none",
      limit: 999,
    })

    expect(descriptors).toHaveLength(32)
    expect(descriptors.find((peer) => peer.sessionID === "peer-39")?.activity).toHaveLength(120)
  })
})
