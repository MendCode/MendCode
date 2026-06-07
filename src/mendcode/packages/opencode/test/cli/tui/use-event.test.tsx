/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import type { Event, GlobalEvent } from "@mendcode/sdk/v2"
import { onMount } from "solid-js"
import { ProjectProvider, useProject } from "../../../src/cli/cmd/tui/context/project"
import { SDKProvider, useSDK } from "../../../src/cli/cmd/tui/context/sdk"
import { useEvent } from "../../../src/cli/cmd/tui/context/event"

async function wait(fn: () => boolean, timeout = 2000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

function event(payload: Event, input: { directory: string; workspace?: string }): GlobalEvent {
  return {
    directory: input.directory,
    workspace: input.workspace,
    payload,
  }
}

function vcs(branch: string): Event {
  return {
    id: `evt_vcs_${branch}`,
    type: "vcs.branch.updated",
    properties: {
      branch,
    },
  }
}

function update(version: string): Event {
  return {
    id: `evt_update_${version}`,
    type: "installation.update-available",
    properties: {
      version,
    },
  }
}

function createSource() {
  let fn: ((event: GlobalEvent) => void) | undefined

  return {
    source: {
      subscribe: async (handler: (event: GlobalEvent) => void) => {
        fn = handler
        return () => {
          if (fn === handler) fn = undefined
        }
      },
    },
    emit(evt: GlobalEvent) {
      if (!fn) throw new Error("event source not ready")
      fn(evt)
    },
  }
}

async function mount() {
  const source = createSource()
  const seen: Event[] = []
  let project!: ReturnType<typeof useProject>
  let done!: () => void
  const ready = new Promise<void>((resolve) => {
    done = resolve
  })

  const app = await testRender(() => (
    <SDKProvider url="http://test" directory="/tmp/root" events={source.source}>
      <ProjectProvider>
        <Probe
          onReady={(ctx) => {
            project = ctx.project
            done()
          }}
          seen={seen}
        />
      </ProjectProvider>
    </SDKProvider>
  ))

  await ready
  return { app, emit: source.emit, project, seen }
}

function Probe(props: { seen: Event[]; onReady: (ctx: { project: ReturnType<typeof useProject> }) => void }) {
  const project = useProject()
  const event = useEvent()

  onMount(() => {
    event.subscribe((evt) => {
      props.seen.push(evt)
    })
    props.onReady({ project })
  })

  return <box />
}

function sseEvent(payload: unknown) {
  return new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`)
}

function connectedEvent() {
  return {
    payload: {
      id: "evt_connected",
      type: "server.connected",
      properties: {},
    },
  }
}

function heartbeatEvent() {
  return {
    payload: {
      id: "evt_heartbeat",
      type: "server.heartbeat",
      properties: {},
    },
  }
}

function sessionStatusEvent() {
  return {
    payload: {
      id: "evt_session_status",
      type: "session.status",
      properties: {
        sessionID: "ses_test",
        status: { type: "busy" },
      },
    },
  }
}

function createSseFetch() {
  const controllers: ReadableStreamDefaultController<Uint8Array>[] = []
  const handle = async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controllers.push(controller)
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    )
  const fetch = Object.assign(handle, {
    preconnect: globalThis.fetch.preconnect.bind(globalThis.fetch),
  }) as typeof globalThis.fetch

  return { fetch, controllers }
}

async function mountSSE(input?: { reconnect?: Parameters<typeof SDKProvider>[0]["reconnect"] }) {
  const source = createSseFetch()
  let sdk!: ReturnType<typeof useSDK>
  let done!: () => void
  const ready = new Promise<void>((resolve) => {
    done = resolve
  })

  const app = await testRender(() => (
    <SDKProvider url="http://test" directory="/tmp/root" fetch={source.fetch} reconnect={input?.reconnect}>
      <SDKProbe
        onReady={(ctx) => {
          sdk = ctx.sdk
          done()
        }}
      />
    </SDKProvider>
  ))

  await ready
  await wait(() => source.controllers.length === 1)
  return { app, sdk, ...source }
}

function SDKProbe(props: { onReady: (ctx: { sdk: ReturnType<typeof useSDK> }) => void }) {
  const sdk = useSDK()

  onMount(() => {
    props.onReady({ sdk })
  })

  return <box />
}

describe("useEvent", () => {
  test("delivers matching directory events without an active workspace", async () => {
    const { app, emit, seen } = await mount()

    try {
      emit(event(vcs("main"), { directory: "/tmp/root" }))

      await wait(() => seen.length === 1)

      expect(seen).toEqual([vcs("main")])
    } finally {
      app.renderer.destroy()
    }
  })

  test("ignores non-matching directory events without an active workspace", async () => {
    const { app, emit, seen } = await mount()

    try {
      emit(event(vcs("other"), { directory: "/tmp/other" }))
      await Bun.sleep(30)

      expect(seen).toHaveLength(0)
    } finally {
      app.renderer.destroy()
    }
  })

  test("delivers matching workspace events when a workspace is active", async () => {
    const { app, emit, project, seen } = await mount()

    try {
      project.workspace.set("ws_a")
      emit(event(vcs("ws"), { directory: "/tmp/other", workspace: "ws_a" }))

      await wait(() => seen.length === 1)

      expect(seen).toEqual([vcs("ws")])
    } finally {
      app.renderer.destroy()
    }
  })

  test("ignores non-matching workspace events when a workspace is active", async () => {
    const { app, emit, project, seen } = await mount()

    try {
      project.workspace.set("ws_a")
      emit(event(vcs("ws"), { directory: "/tmp/root", workspace: "ws_b" }))
      await Bun.sleep(30)

      expect(seen).toHaveLength(0)
    } finally {
      app.renderer.destroy()
    }
  })

  test("delivers truly global events even when a workspace is active", async () => {
    const { app, emit, project, seen } = await mount()

    try {
      project.workspace.set("ws_a")
      emit(event(update("1.2.3"), { directory: "global" }))

      await wait(() => seen.length === 1)

      expect(seen).toEqual([update("1.2.3")])
    } finally {
      app.renderer.destroy()
    }
  })

  test("SDK event stream reports reconnecting and reconnects after a dropped stream", async () => {
    const { app, sdk, controllers } = await mountSSE()

    try {
      controllers[0].enqueue(sseEvent(connectedEvent()))
      await wait(() => sdk.connection.status === "connected")

      controllers[0].close()
      await wait(() => sdk.connection.status === "reconnecting")
      expect(sdk.connection.attempt).toBe(1)

      await wait(() => controllers.length === 2, 1500)
      controllers[1].enqueue(sseEvent(connectedEvent()))
      await wait(() => sdk.connection.status === "connected")
      expect(sdk.connection.attempt).toBe(0)
      expect(sdk.connection.recoveringSince).toBeNumber()

      controllers[1].enqueue(sseEvent(sessionStatusEvent()))
      await wait(() => sdk.connection.recoveringSince === undefined)
      expect(sdk.connection.lastApplicationEventAt).toBeNumber()
    } finally {
      app.renderer.destroy()
    }
  })

  test("SDK event stream marks an open but silent stream as reconnecting", async () => {
    const { app, sdk, controllers } = await mountSSE({
      reconnect: {
        staleDelay: 500,
      },
    })

    try {
      controllers[0].enqueue(sseEvent(connectedEvent()))
      await wait(() => sdk.connection.status === "connected")

      await wait(() => sdk.connection.status === "reconnecting", 2000)
      expect(sdk.connection.error).toBe("Event stream stalled")

      controllers[0].enqueue(sseEvent(heartbeatEvent()))
      await wait(() => sdk.connection.status === "connected")
      expect(sdk.connection.recoveringSince).toBeNumber()

      controllers[0].enqueue(sseEvent(sessionStatusEvent()))
      await wait(() => sdk.connection.recoveringSince === undefined)
    } finally {
      app.renderer.destroy()
    }
  })

  test("SDK event stream stops reconnecting after max attempts", async () => {
    const { app, sdk, controllers } = await mountSSE({
      reconnect: {
        maxAttempts: 2,
        retryDelay: 1,
        maxRetryDelay: 1,
      },
    })

    try {
      controllers[0].close()
      await wait(() => sdk.connection.status === "reconnecting")
      expect(sdk.connection.attempt).toBe(1)

      await wait(() => controllers.length === 2)
      controllers[1].close()
      await wait(() => sdk.connection.status === "reconnecting" && sdk.connection.attempt === 2)

      await wait(() => controllers.length === 3)
      controllers[2].close()
      await wait(() => sdk.connection.status === "failed")
      expect(sdk.connection.attempt).toBe(2)
    } finally {
      app.renderer.destroy()
    }
  })
})
