import { describe, expect, test } from "bun:test"
import { automationEnvelope, automationJSONRequested, redactAutomationData } from "../../src/cli/automation"
import { deriveSessionState } from "../../src/cli/cmd/session"
import type { MessageV2 } from "../../src/session/message-v2"

const emptyPending = {
  questions: [],
  permissions: [],
  planReviews: [],
}

function state(input: Partial<Parameters<typeof deriveSessionState>[0]> = {}) {
  return deriveSessionState({
    sessionID: "ses_test",
    status: { type: "idle" },
    messages: [],
    ...emptyPending,
    ...input,
  })
}

describe("automation protocol", () => {
  test("emits versioned envelopes and preserves non-secret usage fields", () => {
    const envelope = automationEnvelope({
      kind: "result",
      event: "session.completed",
      sessionID: "ses_test",
      timestamp: 123,
      data: {
        tokens: { input: 4, output: 2 },
        apiKey: "do-not-export",
        nested: { authorization: "Bearer do-not-export" },
      },
    })

    expect(envelope).toMatchObject({
      protocol: "mendcode.cli.v1",
      kind: "result",
      event: "session.completed",
      sessionID: "ses_test",
      timestamp: 123,
      data: {
        tokens: { input: 4, output: 2 },
        apiKey: "[REDACTED]",
        nested: { authorization: "[REDACTED]" },
      },
    })
    expect(envelope.eventID).toMatch(/^evt_/)
  })

  test("recognizes split and inline JSON flags", () => {
    expect(automationJSONRequested(["session", "inspect", "--format", "json"])).toBe(true)
    expect(automationJSONRequested(["session", "inspect", "--format=json"])).toBe(true)
    expect(automationJSONRequested(["session", "inspect"])).toBe(false)
  })

  test("redacts secrets without hiding token usage", () => {
    expect(
      redactAutomationData({
        tokens: 10,
        token: "secret",
        OPENAI_API_KEY: "secret",
        nested: [{ password: "secret" }],
      }),
    ).toEqual({
      tokens: 10,
      token: "[REDACTED]",
      OPENAI_API_KEY: "[REDACTED]",
      nested: [{ password: "[REDACTED]" }],
    })
  })
})

describe("session automation state", () => {
  test("maps pending input, approvals, waits, and terminal messages", () => {
    expect(state({ questions: [{ sessionID: "ses_test" }] })).toBe("waiting_for_input")
    expect(state({ permissions: [{ sessionID: "ses_test" }] })).toBe("waiting_for_approval")
    expect(state({ status: { type: "busy", kind: "mflow-wait" } })).toBe("waiting_for_lock")
    expect(state({ status: { type: "busy", kind: "subagent-wait" } })).toBe("waiting_for_subagent")
    expect(state({ status: { type: "retry", attempt: 1, message: "retry", next: 10 } })).toBe("retrying")

    const userMessage = {
      info: { role: "user" },
    } as unknown as MessageV2.WithParts
    expect(state({ messages: [userMessage] })).toBe("running")
    expect(state()).toBe("idle")
  })
})
