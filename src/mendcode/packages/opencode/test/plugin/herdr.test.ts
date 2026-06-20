import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import fs from "fs/promises"
import net from "node:net"
import path from "path"
import { Global } from "@mendcode/core/global"
import {
  HerdrAgentStatePlugin,
  type HerdrPluginState,
  herdrActionForEvent,
  shouldEnableHerdrAgentStatePlugin,
} from "../../src/plugin/herdr"

const originalEnv = {
  HERDR_ENV: process.env.HERDR_ENV,
  HERDR_SOCKET_PATH: process.env.HERDR_SOCKET_PATH,
  HERDR_PANE_ID: process.env.HERDR_PANE_ID,
  MENDCODE_DISABLE_HERDR_REPORTING: process.env.MENDCODE_DISABLE_HERDR_REPORTING,
}

afterEach(async () => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await fs.rm(path.join(Global.Path.config, "plugins", "herdr-agent-state.js"), { force: true })
  mock.restore()
})

function captureHerdrRequests() {
  const requests: Array<{ method: string; params: Record<string, unknown> }> = []

  spyOn(net, "createConnection").mockImplementation(((...args: any[]) => {
    const onConnect = typeof args[1] === "function" ? args[1] : undefined
    const listeners = new Map<string, Array<(...listenerArgs: any[]) => void>>()
    const socket = {
      write(payload: string) {
        requests.push(JSON.parse(payload))
        for (const listener of listeners.get("data") ?? []) listener(Buffer.from("ok"))
      },
      destroy() {},
      setTimeout(_ms: number, _listener?: () => void) {
        return socket
      },
      on(event: string, listener: (...listenerArgs: any[]) => void) {
        listeners.set(event, [...(listeners.get(event) ?? []), listener])
        return socket
      },
    }

    queueMicrotask(() => onConnect?.())
    return socket as any
  }) as any)

  return requests
}

describe("plugin.herdr", () => {
  test("maps MendCode session status objects to Herdr semantic states", () => {
    expect(
      herdrActionForEvent({
        type: "session.status",
        properties: {
          sessionID: "ses_busy",
          status: { type: "busy", kind: "memory-extract", message: "extracting memory" },
        },
      }),
    ).toEqual({
      kind: "report",
      state: "working",
      sessionID: "ses_busy",
      message: "extracting memory",
      customStatus: "memory extract",
    })

    expect(
      herdrActionForEvent({
        type: "session.status",
        properties: {
          sessionID: "ses_retry",
          status: { type: "retry", message: "approval needed" },
        },
      }),
    ).toEqual({
      kind: "report",
      state: "blocked",
      sessionID: "ses_retry",
      message: "approval needed",
      customStatus: "retry",
    })

    expect(
      herdrActionForEvent({
        type: "session.status",
        properties: {
          sessionID: "ses_idle",
          status: { type: "idle" },
        },
      }),
    ).toEqual({
      kind: "report",
      state: "idle",
      sessionID: "ses_idle",
    })
  })

  test("marks MendCode approval-style events as blocked", () => {
    expect(
      herdrActionForEvent({
        type: "permission.asked",
        properties: { sessionID: "ses_perm" },
      }),
    ).toEqual({
      kind: "report",
      state: "blocked",
      sessionID: "ses_perm",
      customStatus: "needs approval",
    })

    expect(
      herdrActionForEvent({
        type: "question.asked",
        properties: { sessionID: "ses_question" },
      }),
    ).toEqual({
      kind: "report",
      state: "blocked",
      sessionID: "ses_question",
      customStatus: "needs input",
    })

    expect(
      herdrActionForEvent({
        type: "plan_review.asked",
        properties: { sessionID: "ses_review" },
      }),
    ).toEqual({
      kind: "report",
      state: "blocked",
      sessionID: "ses_review",
      customStatus: "plan pending",
    })
  })

  test("ignores global errors and only releases the tracked MendCode session", () => {
    const state: HerdrPluginState = {}

    expect(
      herdrActionForEvent(
        {
          type: "session.error",
          properties: {
            error: {
              name: "UnknownError",
            },
          },
        },
        state,
      ),
    ).toBeUndefined()

    expect(
      herdrActionForEvent(
        {
          type: "tui.session.select",
          properties: { sessionID: "ses_current" },
        },
        state,
      ),
    ).toEqual({
      kind: "session",
      sessionID: "ses_current",
    })

    expect(
      herdrActionForEvent(
        {
          type: "session.deleted",
          properties: { sessionID: "ses_other" },
        },
        state,
      ),
    ).toBeUndefined()
    expect(state.currentSessionID).toBe("ses_current")

    expect(
      herdrActionForEvent(
        {
          type: "session.error",
          properties: {
            sessionID: "ses_current",
            error: {
              data: {
                message: "provider failed",
              },
            },
          },
        },
        state,
      ),
    ).toEqual({
      kind: "report",
      state: "blocked",
      sessionID: "ses_current",
      message: "provider failed",
      customStatus: "error",
    })

    expect(
      herdrActionForEvent(
        {
          type: "session.deleted",
          properties: { sessionID: "ses_current" },
        },
        state,
      ),
    ).toEqual({
      kind: "release",
    })
    expect(state.currentSessionID).toBeUndefined()
  })

  test("enables built-in reporting only inside Herdr without the official external plugin", async () => {
    process.env.HERDR_ENV = "1"
    process.env.HERDR_SOCKET_PATH = "/tmp/herdr.sock"
    process.env.HERDR_PANE_ID = "w1:p1"
    delete process.env.MENDCODE_DISABLE_HERDR_REPORTING

    expect(shouldEnableHerdrAgentStatePlugin()).toBe(true)

    const pluginPath = path.join(Global.Path.config, "plugins", "herdr-agent-state.js")
    await fs.mkdir(path.dirname(pluginPath), { recursive: true })
    await fs.writeFile(pluginPath, "// official herdr plugin\n")

    expect(shouldEnableHerdrAgentStatePlugin()).toBe(false)
  })

  test("returns no-op hooks outside Herdr panes", async () => {
    delete process.env.HERDR_ENV
    delete process.env.HERDR_SOCKET_PATH
    delete process.env.HERDR_PANE_ID

    expect(await HerdrAgentStatePlugin({} as any)).toEqual({})
  })

  test("registers direct tool hooks when running inside Herdr", async () => {
    process.env.HERDR_ENV = "1"
    process.env.HERDR_SOCKET_PATH = "/tmp/herdr.sock"
    process.env.HERDR_PANE_ID = "w1:p1"
    delete process.env.MENDCODE_DISABLE_HERDR_REPORTING

    const hooks = await HerdrAgentStatePlugin({} as any)

    expect(typeof hooks["chat.message"]).toBe("function")
    expect(typeof hooks["tool.execute.before"]).toBe("function")
    expect(typeof hooks["tool.execute.after"]).toBe("function")
    expect(typeof hooks.event).toBe("function")
  })

  test("syncs the live MendCode session state when selecting an already-active session", async () => {
    process.env.HERDR_ENV = "1"
    process.env.HERDR_SOCKET_PATH = "/tmp/herdr.sock"
    process.env.HERDR_PANE_ID = "w1:p1"
    delete process.env.MENDCODE_DISABLE_HERDR_REPORTING

    const requests = captureHerdrRequests()
    const status = mock(async () => ({
      data: {
        ses_busy: {
          type: "busy",
          message: "thinking",
        },
      },
    }))

    const hooks = await HerdrAgentStatePlugin({
      client: {
        session: {
          status,
        },
      },
    } as any)

    await hooks.event?.({
      event: {
        type: "tui.session.select",
        properties: { sessionID: "ses_busy" },
      },
    } as any)

    expect(status).toHaveBeenCalledTimes(1)
    expect(
      requests.some(
        (request) =>
          request.method === "pane.report_agent_session" &&
          request.params.source === "herdr:opencode" &&
          request.params.agent === "opencode" &&
          request.params.agent_session_id === "ses_busy",
      ),
    ).toBe(true)
    expect(
      requests.some(
        (request) =>
          request.method === "pane.report_agent" &&
          request.params.source === "mendcode:state" &&
          request.params.agent === "mendcode" &&
          !("agent_session_id" in request.params) &&
          request.params.state === "working" &&
          request.params.message === "thinking",
      ),
    ).toBe(true)
    expect(
      requests.filter(
        (request) =>
          request.method === "pane.report_agent_session" &&
          request.params.source === "herdr:opencode" &&
          request.params.agent === "opencode" &&
          request.params.agent_session_id === "ses_busy",
      ).length,
    ).toBeGreaterThanOrEqual(2)
  })

  test("falls back to idle when the selected MendCode session has no explicit live status", async () => {
    process.env.HERDR_ENV = "1"
    process.env.HERDR_SOCKET_PATH = "/tmp/herdr.sock"
    process.env.HERDR_PANE_ID = "w1:p1"
    delete process.env.MENDCODE_DISABLE_HERDR_REPORTING

    const requests = captureHerdrRequests()

    const hooks = await HerdrAgentStatePlugin({
      client: {
        session: {
          status: async () => ({ data: {} }),
        },
      },
    } as any)

    await hooks.event?.({
      event: {
        type: "tui.session.select",
        properties: { sessionID: "ses_idle" },
      },
    } as any)

    expect(
      requests.some(
        (request) =>
          request.method === "pane.report_agent" &&
          request.params.source === "mendcode:state" &&
          request.params.agent === "mendcode" &&
          !("agent_session_id" in request.params) &&
          request.params.state === "idle",
      ),
    ).toBe(true)
    expect(
      requests.some(
        (request) =>
          request.method === "pane.report_agent_session" &&
          request.params.source === "herdr:opencode" &&
          request.params.agent === "opencode" &&
          request.params.agent_session_id === "ses_idle",
      ),
    ).toBe(true)
  })

  test("reports MendCode-branded state while preserving the official OpenCode session identity", async () => {
    process.env.HERDR_ENV = "1"
    process.env.HERDR_SOCKET_PATH = "/tmp/herdr.sock"
    process.env.HERDR_PANE_ID = "w1:p1"
    delete process.env.MENDCODE_DISABLE_HERDR_REPORTING

    const requests = captureHerdrRequests()
    const hooks = await HerdrAgentStatePlugin({} as any)

    await hooks["chat.message"]?.(
      {
        sessionID: "ses_chat",
      } as any,
      {
        message: {} as any,
        parts: [],
      },
    )

    expect(
      requests.some(
        (request) =>
          request.method === "pane.report_agent" &&
          request.params.source === "mendcode:state" &&
          request.params.agent === "mendcode" &&
          request.params.state === "working",
      ),
    ).toBe(true)
    expect(
      requests.some(
        (request) =>
          request.method === "pane.report_agent_session" &&
          request.params.source === "herdr:opencode" &&
          request.params.agent === "opencode" &&
          request.params.agent_session_id === "ses_chat",
      ),
    ).toBe(true)
  })
})
