/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { onMount } from "solid-js"
import { Global } from "@mendcode/core/global"
import { ArgsProvider } from "../../../../src/cli/cmd/tui/context/args"
import { ExitProvider } from "../../../../src/cli/cmd/tui/context/exit"
import { KVProvider, useKV } from "../../../../src/cli/cmd/tui/context/kv"
import { ProjectProvider } from "../../../../src/cli/cmd/tui/context/project"
import { SDKProvider, type EventSource } from "../../../../src/cli/cmd/tui/context/sdk"
import type { GlobalEvent } from "@mendcode/sdk/v2"
import {
  COMPACTED_TOOL_CALLS_KV_KEY,
  SyncProvider,
  TUI_SESSION_MESSAGE_STORE_LIMIT,
  TUI_SESSION_MESSAGE_SYNC_LIMIT,
  useSync,
} from "../../../../src/cli/cmd/tui/context/sync"
import { SyncProviderV2, useSyncV2 } from "../../../../src/cli/cmd/tui/context/sync-v2"
import { tmpdir } from "../../../fixture/fixture"

const worktree = "/tmp/opencode"
const directory = `${worktree}/packages/opencode`

async function wait(fn: () => boolean, timeout = 2000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

function json(data: unknown) {
  return new Response(JSON.stringify(data), {
    headers: { "content-type": "application/json" },
  })
}

function messageIndexFromCursor(value: string | null) {
  if (!value) return undefined
  if (/^\d+$/.test(value)) return Number(value)
  const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as { id?: string }
  const id = decoded.id ?? ""
  return Number(id.slice(id.lastIndexOf("_") + 1))
}

function eventSource(input?: { onSubscribe?: (handler: (event: GlobalEvent) => void) => void }): EventSource {
  return {
    subscribe: async (handler) => {
      input?.onSubscribe?.(handler)
      return () => {}
    },
  }
}

function createFetch(overrides: Record<string, Response | unknown | ((url: URL) => Response | unknown)> = {}) {
  const session = [] as URL[]
  const fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.pathname === "/session") session.push(url)
    const override = overrides[url.pathname]
    if (override) {
      const value = await (typeof override === "function" ? override(url) : override)
      return value instanceof Response ? value : json(value)
    }

    switch (url.pathname) {
      case "/agent":
      case "/command":
      case "/experimental/workspace":
      case "/experimental/workspace/status":
      case "/formatter":
      case "/lsp":
        return json([])
      case "/config":
      case "/experimental/resource":
      case "/mcp":
      case "/provider/auth":
      case "/session/status":
        return json({})
      case "/config/providers":
        return json({ providers: {}, default: {} })
      case "/experimental/console":
        return json({ consoleManagedProviders: [], switchableOrgCount: 0 })
      case "/path":
        return json({ home: "", state: "", config: "", worktree, directory })
      case "/project/current":
        return json({ id: "proj_test" })
      case "/provider":
        return json({ all: [], default: {}, connected: [] })
      case "/session":
        return json([])
      case "/vcs":
        return json({ branch: "main" })
    }

    throw new Error(`unexpected request: ${url.pathname}`)
  }) as typeof globalThis.fetch

  return { fetch, session }
}

async function mount(
  overrides: Record<string, Response | unknown | ((url: URL) => Response | unknown)> = {},
  options: { events?: EventSource } = {},
) {
  const calls = createFetch(overrides)
  let sync!: ReturnType<typeof useSync>
  let kv!: ReturnType<typeof useKV>
  let done!: () => void
  const ready = new Promise<void>((resolve) => {
    done = resolve
  })

  const app = await testRender(() => (
    <ArgsProvider>
      <ExitProvider>
        <KVProvider>
          <SDKProvider
            url="http://test"
            directory={directory}
            fetch={calls.fetch}
            events={options.events ?? eventSource()}
          >
            <ProjectProvider>
              <SyncProvider>
                <Probe
                  onReady={(ctx) => {
                    sync = ctx.sync
                    kv = ctx.kv
                    done()
                  }}
                />
              </SyncProvider>
            </ProjectProvider>
          </SDKProvider>
        </KVProvider>
      </ExitProvider>
    </ArgsProvider>
  ))

  await ready
  await wait(() => sync.status === "complete")
  return { app, kv, sync, session: calls.session }
}

function Probe(props: { onReady: (ctx: { kv: ReturnType<typeof useKV>; sync: ReturnType<typeof useSync> }) => void }) {
  const kv = useKV()
  const sync = useSync()

  onMount(() => {
    props.onReady({ kv, sync })
  })

  return <box />
}

async function mountV2(
  overrides: Record<string, Response | unknown | ((url: URL) => Response | unknown)> = {},
  options: { events?: EventSource } = {},
) {
  const calls = createFetch(overrides)
  let sync!: ReturnType<typeof useSyncV2>
  let done!: () => void
  const ready = new Promise<void>((resolve) => {
    done = resolve
  })

  const app = await testRender(() => (
    <SDKProvider url="http://test" directory={directory} fetch={calls.fetch} events={options.events ?? eventSource()}>
      <ProjectProvider>
        <SyncProviderV2>
          <ProbeV2
            onReady={(ctx) => {
              sync = ctx.sync
              done()
            }}
          />
        </SyncProviderV2>
      </ProjectProvider>
    </SDKProvider>
  ))

  await ready
  return { app, sync }
}

function ProbeV2(props: { onReady: (ctx: { sync: ReturnType<typeof useSyncV2> }) => void }) {
  const sync = useSyncV2()

  onMount(() => {
    props.onReady({ sync })
  })

  return <box />
}

describe("tui sync", () => {
  test("refresh scopes sessions by default and lists project sessions when disabled", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, kv, sync, session } = await mount({
      "/session": (url: URL) => {
        if (url.searchParams.get("path") === "packages/opencode") return [{ id: "ses_scoped" }]
        if (url.searchParams.get("scope") === "project") return [{ id: "ses_project" }]
        return []
      },
    })

    try {
      expect(kv.get("session_directory_filter_enabled", true)).toBe(true)
      expect(session.at(-1)?.searchParams.get("scope")).toBeNull()
      expect(session.at(-1)?.searchParams.get("path")).toBe("packages/opencode")

      kv.set("session_directory_filter_enabled", false)
      await sync.session.refresh()

      expect(session.at(-1)?.searchParams.get("scope")).toBe("project")
      expect(session.at(-1)?.searchParams.get("path")).toBeNull()
    } finally {
      app.renderer.destroy()
      Global.Path.state = previous
    }
  })

  test("stale session refresh cannot remove a submitted user message after the turn completes", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")

    const sessionID = "ses_pinned_prompt"
    const info = {
      id: sessionID,
      projectID: "proj_test",
      directory,
      title: "Pinned prompt",
      version: "test",
      time: { created: 1, updated: 3 },
    }
    const first = {
      info: {
        id: "msg_001",
        sessionID,
        role: "assistant",
        agent: "build",
        providerID: "openai",
        modelID: "gpt-test",
        tokens: {},
        time: { created: 1, completed: 1 },
      },
      parts: [],
    }
    const user = {
      info: {
        id: "msg_002",
        sessionID,
        role: "user",
        agent: "build",
        model: { providerID: "openai", modelID: "gpt-test" },
        time: { created: 2 },
      },
      parts: [{ id: "prt_002", messageID: "msg_002", sessionID, type: "text", text: "keep me visible" }],
    }
    const last = {
      info: {
        id: "msg_003",
        sessionID,
        role: "assistant",
        agent: "build",
        providerID: "openai",
        modelID: "gpt-test",
        tokens: {},
        time: { created: 3 },
      },
      parts: [],
    }
    const final = {
      ...last,
      info: {
        ...last.info,
        parentID: user.info.id,
        finish: "stop",
        time: { created: 3, completed: 4 },
      },
    }
    let emit!: (event: GlobalEvent) => void
    let page: Array<typeof first | typeof user | typeof last | typeof final> = [first, last]
    const { app, sync } = await mount(
      {
        [`/session/${sessionID}`]: info,
        [`/session/${sessionID}/message`]: () => page,
        [`/session/${sessionID}/todo`]: [],
        [`/session/${sessionID}/diff`]: [],
      },
      {
        events: eventSource({
          onSubscribe: (handler) => {
            emit = handler
          },
        }),
      },
    )

    try {
      sync.set("message", sessionID, [first.info, user.info] as any)
      sync.set("part", user.info.id, user.parts as any)
      sync.session.pinMessage(sessionID, user.info.id)

      await sync.session.sync(sessionID, { force: true })
      expect(sync.data.message[sessionID]?.map((message) => message.id)).toEqual(["msg_001", "msg_002", "msg_003"])
      expect(sync.data.part[user.info.id]?.[0]).toMatchObject({ type: "text", text: "keep me visible" })

      page = [first, user, last]
      await sync.session.sync(sessionID, { force: true })
      page = [first, last]
      await sync.session.sync(sessionID, { force: true })

      expect(sync.data.message[sessionID]?.map((message) => message.id)).toEqual(["msg_001", "msg_002", "msg_003"])

      page = [first, user, final]
      await sync.session.sync(sessionID, { force: true })
      emit({
        directory,
        project: "proj_test",
        payload: {
          id: "evt_pinned_prompt_idle",
          type: "session.status",
          properties: { sessionID, status: { type: "idle" } },
        },
      } as GlobalEvent)
      page = [first, final]
      await sync.session.sync(sessionID, { force: true })

      expect(sync.data.message[sessionID]?.map((message) => message.id)).toEqual(["msg_001", "msg_002", "msg_003"])
      expect(sync.data.part[user.info.id]?.[0]).toMatchObject({ type: "text", text: "keep me visible" })
    } finally {
      app.renderer.destroy()
      Global.Path.state = previous
    }
  })

  test("stale session refresh cannot hide completed assistant output", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")

    const sessionID = "ses_completed_output"
    const messageID = "msg_completed_output"
    const info = {
      id: sessionID,
      projectID: "proj_test",
      directory,
      title: "Completed output",
      version: "test",
      time: { created: 1, updated: 3 },
    }
    const message = {
      id: messageID,
      sessionID,
      parentID: "msg_user",
      role: "assistant",
      agent: "build",
      providerID: "openai",
      modelID: "gpt-test",
      finish: "stop",
      tokens: {},
      time: { created: 2, completed: 3 },
    }
    const part = {
      id: "prt_completed_output",
      messageID,
      sessionID,
      type: "text",
      text: "keep completed output visible",
      time: { start: 2, end: 3 },
    }
    const staleMessage = {
      ...message,
      finish: undefined,
      time: { created: 2 },
    }
    const { app, sync } = await mount({
      [`/session/${sessionID}`]: info,
      [`/session/${sessionID}/message`]: [{ info: staleMessage, parts: [] }],
      [`/session/${sessionID}/todo`]: [],
      [`/session/${sessionID}/diff`]: [],
    })

    try {
      sync.set("message", sessionID, [message as any])
      sync.set("part", messageID, [part as any])

      await sync.session.sync(sessionID, { force: true })

      expect(sync.data.part[messageID]?.[0]).toMatchObject({
        type: "text",
        text: "keep completed output visible",
      })
      expect(sync.data.message[sessionID]?.[0]).toMatchObject({
        finish: "stop",
        time: { created: 2, completed: 3 },
      })

    } finally {
      app.renderer.destroy()
      Global.Path.state = previous
    }
  })

  test("sparse compacted refresh keeps mounted turns and parts", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")

    const sessionID = "ses_sparse_assistant_refresh"
    const oldUser = {
      info: {
        id: "msg_001",
        sessionID,
        role: "user",
        agent: "build",
        model: { providerID: "openai", modelID: "gpt-test" },
        time: { created: 1 },
      },
      parts: [{ id: "prt_001", messageID: "msg_001", sessionID, type: "text", text: "run tools" }],
    }
    const toolAssistant = {
      info: {
        id: "msg_002",
        sessionID,
        parentID: "msg_001",
        role: "assistant",
        agent: "build",
        providerID: "openai",
        modelID: "gpt-test",
        finish: "tool-calls",
        tokens: {},
        time: { created: 2, completed: 2 },
      },
      parts: [
        {
          id: "prt_002",
          messageID: "msg_002",
          sessionID,
          type: "tool",
          callID: "call_002",
          tool: "bash",
          state: { status: "completed", input: {}, output: "done", title: "tool" },
        },
      ],
    }
    const finalAssistant = {
      info: {
        id: "msg_003",
        sessionID,
        parentID: "msg_001",
        role: "assistant",
        agent: "build",
        providerID: "openai",
        modelID: "gpt-test",
        finish: "stop",
        tokens: {},
        time: { created: 3, completed: 3 },
      },
      parts: [{ id: "prt_003", messageID: "msg_003", sessionID, type: "text", text: "finished" }],
    }
    const newUser = {
      info: {
        id: "msg_004",
        sessionID,
        role: "user",
        agent: "build",
        model: { providerID: "openai", modelID: "gpt-test" },
        time: { created: 4 },
      },
      parts: [{ id: "prt_004", messageID: "msg_004", sessionID, type: "text", text: "next" }],
    }
    const nextAssistant = {
      info: {
        id: "msg_005",
        sessionID,
        parentID: newUser.info.id,
        role: "assistant",
        agent: "build",
        providerID: "openai",
        modelID: "gpt-test",
        finish: "stop",
        tokens: {},
        time: { created: 5, completed: 5 },
      },
      parts: [{ id: "prt_005", messageID: "msg_005", sessionID, type: "text", text: "next finished" }],
    }
    let page = [oldUser, toolAssistant, finalAssistant, newUser, nextAssistant]
    const { app, sync } = await mount({
      [`/session/${sessionID}`]: {
        id: sessionID,
        projectID: "proj_test",
        directory,
        title: "Sparse assistant refresh",
        version: "test",
        time: { created: 1, updated: 4 },
      },
      [`/session/${sessionID}/message`]: () =>
        new Response(JSON.stringify(page), {
          headers: { "content-type": "application/json", "X-Message-View-Sparse": "true" },
        }),
      [`/session/${sessionID}/todo`]: [],
      [`/session/${sessionID}/diff`]: [],
    })

    try {
      await sync.session.sync(sessionID, { force: true })
      const assistant = sync.data.message[sessionID]?.find((message) => message.id === toolAssistant.info.id)
      const tool = sync.data.part[toolAssistant.info.id]?.[0]

      page = [oldUser, finalAssistant, nextAssistant]
      await sync.session.sync(sessionID, { force: true })

      expect(sync.data.message[sessionID]?.map((message) => message.id)).toEqual([
        oldUser.info.id,
        toolAssistant.info.id,
        finalAssistant.info.id,
        newUser.info.id,
        nextAssistant.info.id,
      ])
      expect(sync.data.message[sessionID]?.find((message) => message.id === toolAssistant.info.id)).toBe(assistant)
      expect(sync.data.part[toolAssistant.info.id]?.[0]).toBe(tool)
      expect(sync.data.part[newUser.info.id]?.[0]).toMatchObject({ type: "text", text: "next" })
    } finally {
      app.renderer.destroy()
      Global.Path.state = previous
    }
  })

  test("compacted tool-call preference reloads the selected history view", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")

    const sessionID = "ses_compacted_view"
    const views: string[] = []
    const { app, kv, sync } = await mount({
      [`/session/${sessionID}`]: {
        id: sessionID,
        projectID: "proj_test",
        directory,
        title: "Compacted view",
        version: "test",
        time: { created: 1, updated: 1 },
      },
      [`/session/${sessionID}/message`]: (url: URL) => {
        views.push(url.searchParams.get("view") ?? "")
        return []
      },
      [`/session/${sessionID}/todo`]: [],
      [`/session/${sessionID}/diff`]: [],
    })

    try {
      kv.set(COMPACTED_TOOL_CALLS_KV_KEY, true)
      await sync.session.sync(sessionID, { force: true })
      expect(views.at(-1)).toBe("tui-all")

      kv.set(COMPACTED_TOOL_CALLS_KV_KEY, false)
      await sync.session.reloadMessages(sessionID)
      expect(views.at(-1)).toBe("tui")
    } finally {
      kv.set(COMPACTED_TOOL_CALLS_KV_KEY, false)
      app.renderer.destroy()
      Global.Path.state = previous
    }
  })

  test("session sync hydrates normal sessions up to the bounded store limit", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")

    const sessionID = "ses_full_history"
    const info = {
      id: sessionID,
      projectID: "proj_test",
      directory,
      title: "Full history",
      version: "test",
      time: { created: 1, updated: 60 },
    }
    const messages = Array.from({ length: TUI_SESSION_MESSAGE_SYNC_LIMIT + 5 }, (_, index) => ({
      info: {
        id: `msg_${index.toString().padStart(3, "0")}`,
        sessionID,
        role: index % 2 === 0 ? "user" : "assistant",
        agent: "build",
        model: { providerID: "openai", modelID: "gpt-test" },
        tokens: {},
        time: { created: index + 1, completed: index + 1 },
      },
      parts: [],
    }))
    const messageQueries: URL[] = []

    const { app, sync } = await mount({
      [`/session/${sessionID}`]: info,
      [`/session/${sessionID}/message`]: (url: URL) => {
        messageQueries.push(url)
        const before = url.searchParams.get("before")
        if (before) return messages.slice(0, 5)
        return new Response(JSON.stringify(messages.slice(-Number(url.searchParams.get("limit") ?? messages.length))), {
          headers: { "content-type": "application/json", "X-Next-Cursor": "cursor_005" },
        })
      },
      [`/session/${sessionID}/todo`]: [],
      [`/session/${sessionID}/diff`]: [],
    })

    try {
      await sync.session.sync(sessionID, { force: true })

      expect(messageQueries.map((url) => url.searchParams.get("before"))).toEqual([null, expect.any(String)])
      expect(messageQueries[0]?.searchParams.get("limit")).toBe(String(TUI_SESSION_MESSAGE_SYNC_LIMIT))
      expect(sync.data.message[sessionID]?.length).toBe(messages.length)
      expect(sync.data.message[sessionID]?.[0]?.id).toBe("msg_000")
      expect(sync.data.message[sessionID]?.at(-1)?.id).toBe("msg_054")
    } finally {
      app.renderer.destroy()
      Global.Path.state = previous
    }
  })

  test("session sync pages older history progressively and keeps the loaded store bounded", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")

    const sessionID = "ses_paged_history"
    const info = {
      id: sessionID,
      projectID: "proj_test",
      directory,
      title: "Paged history",
      version: "test",
      time: { created: 1, updated: 600 },
    }
    const messages = Array.from({ length: 600 }, (_, index) => ({
      info: {
        id: `msg_${index.toString().padStart(3, "0")}`,
        sessionID,
        role: index % 2 === 0 ? "user" : "assistant",
        agent: "build",
        model: { providerID: "openai", modelID: "gpt-test" },
        tokens: {},
        time: { created: index + 1, completed: index + 1 },
      },
      parts: [
        {
          id: `prt_${index.toString().padStart(3, "0")}`,
          messageID: `msg_${index.toString().padStart(3, "0")}`,
          sessionID,
          type: "text",
          text: `message ${index}`,
          time: { start: index + 1, end: index + 1 },
        },
      ],
    }))
    const page = (start: number, cursor?: string) =>
      new Response(JSON.stringify(messages.slice(start, start + TUI_SESSION_MESSAGE_SYNC_LIMIT)), {
        headers: {
          "content-type": "application/json",
          ...(cursor ? { "X-Next-Cursor": cursor } : {}),
        },
      })
    const starts: number[] = []
    const directions: string[] = []

    const { app, sync } = await mount({
      [`/session/${sessionID}`]: info,
      [`/session/${sessionID}/message`]: (url: URL) => {
        const before = url.searchParams.get("before")
        const after = url.searchParams.get("after")
        const start = after
          ? Math.min(messages.length, (messageIndexFromCursor(after) ?? -1) + 1)
          : before
            ? Math.max(0, (messageIndexFromCursor(before) ?? 0) - TUI_SESSION_MESSAGE_SYNC_LIMIT)
            : 550
        starts.push(start)
        directions.push(after ? "newer" : "older")
        return page(
          start,
          after
            ? start + TUI_SESSION_MESSAGE_SYNC_LIMIT < messages.length
              ? String(start + TUI_SESSION_MESSAGE_SYNC_LIMIT - 1)
              : undefined
            : start > 0
              ? String(start)
              : undefined,
        )
      },
      [`/session/${sessionID}/todo`]: [],
      [`/session/${sessionID}/diff`]: [],
    })

    try {
      await sync.session.sync(sessionID, { force: true })
      expect(sync.session.history(sessionID)).toMatchObject({
        hasMoreOlder: true,
        hasMoreNewer: false,
        loaded: TUI_SESSION_MESSAGE_STORE_LIMIT,
      })
      expect(sync.data.message[sessionID]?.[0]?.id).toBe("msg_450")
      expect(sync.data.session_latest_assistant[sessionID]?.id).toBe("msg_599")

      for (let index = 0; index < 9; index++) await sync.session.loadOlder(sessionID)

      expect(starts).toEqual([550, 500, 450, 400, 350, 300, 250, 200, 150, 100, 50, 0])
      expect(directions).toEqual([
        "older",
        "older",
        "older",
        "older",
        "older",
        "older",
        "older",
        "older",
        "older",
        "older",
        "older",
        "older",
      ])
      expect(sync.data.message[sessionID]?.length).toBe(TUI_SESSION_MESSAGE_STORE_LIMIT)
      expect(sync.data.message[sessionID]?.[0]?.id).toBe("msg_000")
      expect(sync.data.message[sessionID]?.at(-1)?.id).toBe("msg_149")
      expect(sync.data.part.msg_000).toBeDefined()
      expect(sync.data.part.msg_599).toBeUndefined()
      expect(sync.data.session_latest_assistant[sessionID]?.id).toBe("msg_599")
      expect(sync.session.history(sessionID)).toMatchObject({
        hasMoreOlder: false,
        hasMoreNewer: true,
        loaded: TUI_SESSION_MESSAGE_STORE_LIMIT,
      })

      for (let index = 0; index < 9; index++) await sync.session.loadNewer(sessionID)

      expect(starts.slice(-9)).toEqual([150, 200, 250, 300, 350, 400, 450, 500, 550])
      expect(directions.slice(-9)).toEqual([
        "newer",
        "newer",
        "newer",
        "newer",
        "newer",
        "newer",
        "newer",
        "newer",
        "newer",
      ])
      expect(sync.data.message[sessionID]?.length).toBe(TUI_SESSION_MESSAGE_STORE_LIMIT)
      expect(sync.data.message[sessionID]?.[0]?.id).toBe("msg_450")
      expect(sync.data.message[sessionID]?.at(-1)?.id).toBe("msg_599")
      expect(sync.data.part.msg_000).toBeUndefined()
      expect(sync.data.part.msg_599).toBeDefined()
      expect(sync.session.history(sessionID)).toMatchObject({
        hasMoreOlder: true,
        hasMoreNewer: false,
        loaded: TUI_SESSION_MESSAGE_STORE_LIMIT,
      })
    } finally {
      app.renderer.destroy()
      Global.Path.state = previous
    }
  })

  test("stale compacted-history paging cannot remove a submitted turn after latest-window sync", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")

    const sessionID = "ses_stale_older_page"
    const info = {
      id: sessionID,
      projectID: "proj_test",
      directory,
      title: "Stale compacted page",
      version: "test",
      time: { created: 1, updated: 600 },
    }
    const messages = Array.from({ length: 600 }, (_, index) => ({
      info: {
        id: `msg_${index.toString().padStart(3, "0")}`,
        sessionID,
        role: index % 2 === 0 ? "user" : "assistant",
        agent: "build",
        model: { providerID: "openai", modelID: "gpt-test" },
        tokens: {},
        time: { created: index + 1, completed: index + 1 },
      },
      parts: [],
    }))
    const page = (start: number, cursor?: string) =>
      new Response(JSON.stringify(messages.slice(start, start + TUI_SESSION_MESSAGE_SYNC_LIMIT)), {
        headers: {
          "content-type": "application/json",
          "X-Message-View-Sparse": "true",
          ...(cursor ? { "X-Next-Cursor": cursor } : {}),
        },
      })
    let delayOlder = false
    let releaseOlder!: () => void
    const olderReleased = new Promise<void>((resolve) => {
      releaseOlder = resolve
    })

    const { app, sync } = await mount({
      [`/session/${sessionID}`]: info,
      [`/session/${sessionID}/message`]: async (url: URL) => {
        const before = url.searchParams.get("before")
        const start = before
          ? Math.max(0, (messageIndexFromCursor(before) ?? 0) - TUI_SESSION_MESSAGE_SYNC_LIMIT)
          : 550
        if (delayOlder && before) {
          delayOlder = false
          await olderReleased
        }
        return page(start, start > 0 ? String(start) : undefined)
      },
      [`/session/${sessionID}/todo`]: [],
      [`/session/${sessionID}/diff`]: [],
    })

    try {
      await sync.session.sync(sessionID, { force: true })
      const submitted = {
        id: "msg_600",
        sessionID,
        role: "user",
        agent: "build",
        model: { providerID: "openai", modelID: "gpt-test" },
        time: { created: 601 },
      }
      sync.session.pinMessage(sessionID, submitted.id)
      sync.set("message", sessionID, [...(sync.data.message[sessionID] ?? []), submitted] as any)
      sync.set("part", submitted.id, [
        {
          id: "prt_600",
          messageID: submitted.id,
          sessionID,
          type: "text",
          text: "new submitted turn",
        } as any,
      ])

      delayOlder = true
      const staleOlder = sync.session.loadOlder(sessionID)
      await wait(() => !delayOlder)
      await sync.session.sync(sessionID, { force: true })
      sync.session.unpinMessage(sessionID, submitted.id)
      releaseOlder()

      expect(await staleOlder).toBe(false)
      expect(sync.data.message[sessionID]?.at(-1)?.id).toBe(submitted.id)
      expect(sync.data.part[submitted.id]?.[0]).toMatchObject({ type: "text", text: "new submitted turn" })
      expect(sync.session.history(sessionID)).toMatchObject({ hasMoreOlder: true, hasMoreNewer: false })
    } finally {
      releaseOlder()
      app.renderer.destroy()
      Global.Path.state = previous
    }
  })

  test("session sync stops older paging when the server cursor does not advance", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")

    const sessionID = "ses_stuck_cursor"
    const info = {
      id: sessionID,
      projectID: "proj_test",
      directory,
      title: "Stuck cursor",
      version: "test",
      time: { created: 1, updated: 1 },
    }
    const messages = Array.from({ length: 120 }, (_, index) => ({
      info: {
        id: `msg_${index.toString().padStart(3, "0")}`,
        sessionID,
        role: index % 2 === 0 ? "user" : "assistant",
        agent: "build",
        model: { providerID: "openai", modelID: "gpt-test" },
        tokens: {},
        time: { created: index + 1, completed: index + 1 },
      },
      parts: [],
    }))
    let calls = 0

    const { app, sync } = await mount({
      [`/session/${sessionID}`]: info,
      [`/session/${sessionID}/message`]: (url: URL) => {
        calls++
        const before = url.searchParams.get("before")
        return new Response(JSON.stringify(messages), {
          headers: {
            "content-type": "application/json",
            "X-Next-Cursor": before ?? "msg_000",
          },
        })
      },
      [`/session/${sessionID}/todo`]: [],
      [`/session/${sessionID}/diff`]: [],
    })

    try {
      await sync.session.sync(sessionID, { force: true })
      expect(sync.session.history(sessionID)).toMatchObject({ hasMoreOlder: false, loadingOlder: false })

      await sync.session.loadOlder(sessionID)
      await sync.session.loadOlder(sessionID)

      expect(calls).toBe(2)
      expect(sync.session.history(sessionID)).toMatchObject({ hasMoreOlder: false, loadingOlder: false })
    } finally {
      app.renderer.destroy()
      Global.Path.state = previous
    }
  })

  test("session sync returns false for empty newer pages and clears the newer boundary", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")

    const sessionID = "ses_empty_newer"
    const info = {
      id: sessionID,
      projectID: "proj_test",
      directory,
      title: "Empty newer page",
      version: "test",
      time: { created: 1, updated: 1 },
    }
    const messages = Array.from({ length: 600 }, (_, index) => ({
      info: {
        id: `msg_${index.toString().padStart(3, "0")}`,
        sessionID,
        role: index % 2 === 0 ? "user" : "assistant",
        agent: "build",
        model: { providerID: "openai", modelID: "gpt-test" },
        tokens: {},
        time: { created: index + 1, completed: index + 1 },
      },
      parts: [],
    }))

    const { app, sync } = await mount({
      [`/session/${sessionID}`]: info,
      [`/session/${sessionID}/message`]: (url: URL) => {
        const before = url.searchParams.get("before")
        const after = url.searchParams.get("after")
        if (after) return page([], undefined)
        const start = before ? Math.max(0, (messageIndexFromCursor(before) ?? 0) - TUI_SESSION_MESSAGE_SYNC_LIMIT) : 550
        return page(
          messages.slice(start, start + TUI_SESSION_MESSAGE_SYNC_LIMIT),
          start > 0 ? String(start) : undefined,
        )
      },
      [`/session/${sessionID}/todo`]: [],
      [`/session/${sessionID}/diff`]: [],
    })

    function page(items: typeof messages, cursor?: string) {
      return new Response(JSON.stringify(items), {
        headers: {
          "content-type": "application/json",
          ...(cursor ? { "X-Next-Cursor": cursor } : {}),
        },
      })
    }

    try {
      await sync.session.sync(sessionID, { force: true })
      for (let index = 0; index < 9; index++) await sync.session.loadOlder(sessionID)

      expect(sync.data.message[sessionID]?.[0]?.id).toBe("msg_000")
      expect(sync.data.message[sessionID]?.at(-1)?.id).toBe("msg_149")
      expect(sync.session.history(sessionID)).toMatchObject({ hasMoreOlder: false, hasMoreNewer: true })

      const loaded = await sync.session.loadNewer(sessionID)

      expect(loaded).toBe(false)
      expect(sync.data.message[sessionID]?.[0]?.id).toBe("msg_000")
      expect(sync.data.message[sessionID]?.at(-1)?.id).toBe("msg_149")
      expect(sync.session.history(sessionID)).toMatchObject({
        hasMoreOlder: false,
        hasMoreNewer: false,
        loadingNewer: false,
      })
    } finally {
      app.renderer.destroy()
      Global.Path.state = previous
    }
  })

  test("force sync preserves already loaded older pages outside the refreshed latest page", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")

    const sessionID = "ses_preserve_older"
    const info = {
      id: sessionID,
      projectID: "proj_test",
      directory,
      title: "Preserve older",
      version: "test",
      time: { created: 1, updated: 500 },
    }
    const messages = Array.from({ length: 500 }, (_, index) => ({
      info: {
        id: `msg_${index.toString().padStart(3, "0")}`,
        sessionID,
        role: index % 2 === 0 ? "user" : "assistant",
        agent: "build",
        model: { providerID: "openai", modelID: "gpt-test" },
        tokens: {},
        time: { created: index + 1, completed: index + 1 },
      },
      parts: [],
    }))

    const { app, sync } = await mount({
      [`/session/${sessionID}`]: info,
      [`/session/${sessionID}/message`]: () =>
        new Response(JSON.stringify(messages.slice(380)), {
          headers: { "content-type": "application/json", "X-Next-Cursor": "380" },
        }),
      [`/session/${sessionID}/todo`]: [],
      [`/session/${sessionID}/diff`]: [],
    })

    try {
      sync.set(
        "message",
        sessionID,
        messages.slice(260, 500).map((item) => item.info as any),
      )
      await sync.session.sync(sessionID, { force: true })

      expect(sync.data.message[sessionID]?.[0]?.id).toBe("msg_350")
      expect(sync.data.message[sessionID]?.at(-1)?.id).toBe("msg_499")
      expect(sync.data.message[sessionID]?.length).toBe(TUI_SESSION_MESSAGE_STORE_LIMIT)
    } finally {
      app.renderer.destroy()
      Global.Path.state = previous
    }
  })

  test("remove events tolerate unloaded messages and clean removed message parts", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")

    let emit!: (event: GlobalEvent) => void
    const sessionID = "ses_removed"
    const messageID = "msg_removed"
    const partID = "prt_removed"
    const { app, sync } = await mount(
      {},
      {
        events: eventSource({
          onSubscribe: (handler) => {
            emit = handler
          },
        }),
      },
    )

    try {
      emit({
        directory,
        project: "proj_test",
        payload: {
          id: "evt_missing_message_removed",
          type: "message.removed",
          properties: { sessionID, messageID: "msg_missing" },
        },
      } as GlobalEvent)
      emit({
        directory,
        project: "proj_test",
        payload: {
          id: "evt_missing_part_removed",
          type: "message.part.removed",
          properties: { sessionID, messageID: "msg_missing", partID },
        },
      } as GlobalEvent)

      sync.set("message", sessionID, [
        { id: messageID, sessionID, role: "user", agent: "build", time: { created: 1, completed: 1 } } as any,
      ])
      sync.set("part", messageID, [
        { id: partID, messageID, sessionID, type: "text", text: "hello", time: { start: 1, end: 1 } } as any,
      ])
      emit({
        directory,
        project: "proj_test",
        payload: {
          id: "evt_message_removed",
          type: "message.removed",
          properties: { sessionID, messageID },
        },
      } as GlobalEvent)

      await wait(() => sync.data.message[sessionID]?.length === 0)
      expect(sync.data.message[sessionID]).toEqual([])
      expect(sync.data.part[messageID]).toBeUndefined()
    } finally {
      app.renderer.destroy()
      Global.Path.state = previous
    }
  })

  test("session sync keeps live append-only text over stale fetched snapshots", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")

    const sessionID = "ses_live"
    const messageID = "msg_live"
    const partID = "prt_live"
    const info = {
      id: sessionID,
      projectID: "proj_test",
      directory,
      title: "Live",
      version: "test",
      time: { created: 1, updated: 1 },
    }
    const message = {
      id: messageID,
      sessionID,
      role: "assistant",
      agent: "build",
      model: { providerID: "openai", modelID: "gpt-test" },
      tokens: {},
      time: { created: 1 },
    }
    const livePart = {
      id: partID,
      messageID,
      sessionID,
      type: "text",
      text: "hola soy una IA como te va",
      time: { start: 1 },
    }
    const stalePart = {
      ...livePart,
      text: "hola soy una IA",
    }

    const { app, sync } = await mount({
      [`/session/${sessionID}`]: info,
      [`/session/${sessionID}/message`]: [{ info: message, parts: [stalePart] }],
      [`/session/${sessionID}/todo`]: [],
      [`/session/${sessionID}/diff`]: [],
    })

    try {
      sync.set("session", [info as any])
      sync.set("message", sessionID, [message as any])
      sync.set("part", messageID, [livePart as any])

      await sync.session.sync(sessionID, { force: true })

      expect(sync.data.part[messageID]?.[0]).toMatchObject({
        id: partID,
        type: "text",
        text: livePart.text,
      })
    } finally {
      app.renderer.destroy()
      Global.Path.state = previous
    }
  })

  test("session sync previews long live text with latest tail", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")

    const sessionID = "ses_long_preview_tail"
    const messageID = "msg_long_preview_tail"
    const partID = "prt_long_preview_tail"
    const text = ["BEGIN PREVIEW", "middle chunk ".repeat(12000), "LATEST TAIL"].join("\n")
    const info = {
      id: sessionID,
      projectID: "proj_test",
      directory,
      title: "Long preview tail",
      version: "test",
      time: { created: 1, updated: 2 },
    }
    const message = {
      id: messageID,
      sessionID,
      role: "assistant",
      agent: "build",
      model: { providerID: "openai", modelID: "gpt-test" },
      tokens: {},
      time: { created: 1 },
    }
    const part = {
      id: partID,
      messageID,
      sessionID,
      type: "text",
      text,
      time: { start: 1 },
    }

    const { app, sync } = await mount({
      [`/session/${sessionID}`]: info,
      [`/session/${sessionID}/message`]: [{ info: message, parts: [part] }],
      [`/session/${sessionID}/todo`]: [],
      [`/session/${sessionID}/diff`]: [],
    })

    try {
      await sync.session.sync(sessionID, { force: true })
      const preview = (sync.data.part[messageID]?.[0] as { text?: string } | undefined)?.text
      expect(preview?.startsWith("BEGIN PREVIEW")).toBe(true)
      expect(preview).toContain("text part preview truncated")
      expect(preview).toContain("LATEST TAIL")
      expect(preview!.length).toBeLessThanOrEqual(128 * 1024)
    } finally {
      app.renderer.destroy()
      Global.Path.state = previous
    }
  })

  test("session sync keeps newer live messages over stale fetched snapshots", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")

    const sessionID = "ses_live_messages"
    const staleMessage = {
      id: "msg_001",
      sessionID,
      role: "assistant",
      agent: "build",
      model: { providerID: "openai", modelID: "gpt-test" },
      tokens: {},
      time: { created: 1, completed: 1 },
    }
    const liveMessage = {
      id: "msg_002",
      sessionID,
      role: "assistant",
      agent: "build",
      model: { providerID: "openai", modelID: "gpt-test" },
      tokens: {},
      time: { created: 2 },
    }
    const deletedMessage = {
      ...liveMessage,
      id: "msg_003",
      time: { created: 3, completed: 3 },
    }
    const info = {
      id: sessionID,
      projectID: "proj_test",
      directory,
      title: "Live messages",
      version: "test",
      time: { created: 1, updated: 2 },
    }

    const { app, sync } = await mount({
      [`/session/${sessionID}`]: info,
      [`/session/${sessionID}/message`]: [{ info: staleMessage, parts: [] }],
      [`/session/${sessionID}/todo`]: [],
      [`/session/${sessionID}/diff`]: [],
    })

    try {
      sync.set("session", [info as any])
      sync.set("message", sessionID, [staleMessage as any, liveMessage as any, deletedMessage as any])

      await sync.session.sync(sessionID, { force: true })

      expect(sync.data.message[sessionID]?.map((message) => message.id)).toEqual([staleMessage.id, liveMessage.id])
    } finally {
      app.renderer.destroy()
      Global.Path.state = previous
    }
  })

  test("force sync keeps a newer live user message outside the refreshed latest page", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")

    const sessionID = "ses_live_user_message"
    const staleAssistant = {
      id: "msg_001",
      sessionID,
      role: "assistant",
      agent: "build",
      model: { providerID: "openai", modelID: "gpt-test" },
      tokens: {},
      time: { created: 1, completed: 1 },
    }
    const liveUser = {
      id: "msg_002",
      sessionID,
      role: "user",
      agent: "build",
      time: { created: 2, completed: 2 },
    }
    const info = {
      id: sessionID,
      projectID: "proj_test",
      directory,
      title: "Live user message",
      version: "test",
      time: { created: 1, updated: 2 },
    }

    const { app, sync } = await mount({
      [`/session/${sessionID}`]: info,
      [`/session/${sessionID}/message`]: [{ info: staleAssistant, parts: [] }],
      [`/session/${sessionID}/todo`]: [],
      [`/session/${sessionID}/diff`]: [],
    })

    try {
      sync.set("session", [info as any])
      sync.set("message", sessionID, [staleAssistant as any, liveUser as any])

      await sync.session.sync(sessionID, { force: true })

      expect(sync.data.message[sessionID]?.map((message) => message.id)).toEqual([staleAssistant.id, liveUser.id])
    } finally {
      app.renderer.destroy()
      Global.Path.state = previous
    }
  })

  test("force sync preserves optimistic messages when the refreshed page is temporarily empty", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")

    const sessionID = "ses_empty_refresh"
    const messageID = "msg_002"
    const info = {
      id: sessionID,
      projectID: "proj_test",
      directory,
      title: "Empty refresh",
      version: "test",
      time: { created: 1, updated: 2 },
    }
    const optimisticUser = {
      id: messageID,
      sessionID,
      role: "user",
      agent: "build",
      time: { created: 2 },
    }

    const { app, sync } = await mount({
      [`/session/${sessionID}`]: info,
      [`/session/${sessionID}/message`]: [],
      [`/session/${sessionID}/todo`]: [],
      [`/session/${sessionID}/diff`]: [],
    })

    try {
      sync.set("session", [info as any])
      sync.set("message", sessionID, [optimisticUser as any])

      await sync.session.sync(sessionID, { force: true })

      expect(sync.data.message[sessionID]?.map((message) => message.id)).toEqual([messageID])
    } finally {
      app.renderer.destroy()
      Global.Path.state = previous
    }
  })

  test("live message events keep full synced transcript history", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")

    let emit!: (event: GlobalEvent) => void
    const sessionID = "ses_full_history"
    const initialMessages = Array.from({ length: 120 }, (_, index) => ({
      id: `msg_${String(index).padStart(3, "0")}`,
      sessionID,
      role: index % 2 === 0 ? "user" : "assistant",
      agent: "build",
      model: { providerID: "openai", modelID: "gpt-test" },
      tokens: {},
      time: { created: index + 1, ...(index % 2 === 0 ? { completed: index + 1 } : {}) },
    }))
    const nextMessage = {
      id: "msg_120",
      sessionID,
      role: "assistant",
      agent: "build",
      model: { providerID: "openai", modelID: "gpt-test" },
      tokens: {},
      time: { created: 121 },
    }
    const info = {
      id: sessionID,
      projectID: "proj_test",
      directory,
      title: "Full history",
      version: "test",
      time: { created: 1, updated: 121 },
    }
    const { app, sync } = await mount(
      {
        [`/session/${sessionID}`]: info,
        [`/session/${sessionID}/message`]: initialMessages.map((message) => ({ info: message, parts: [] })),
        [`/session/${sessionID}/todo`]: [],
        [`/session/${sessionID}/diff`]: [],
      },
      {
        events: eventSource({
          onSubscribe: (handler) => {
            emit = handler
          },
        }),
      },
    )

    try {
      await sync.session.sync(sessionID, { force: true })
      emit({
        directory,
        project: "proj_test",
        payload: {
          id: "evt_message_updated",
          type: "message.updated",
          properties: { sessionID, info: nextMessage },
        },
      } as GlobalEvent)

      expect(sync.data.message[sessionID]?.length).toBe(121)
      expect(sync.data.message[sessionID]?.[0]?.id).toBe(initialMessages[0]?.id)
      expect(sync.data.message[sessionID]?.at(-1)?.id).toBe(nextMessage.id)
    } finally {
      app.renderer.destroy()
      Global.Path.state = previous
    }
  })

  test("live message trimming keeps the optimistic user turn pinned", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")

    let emit!: (event: GlobalEvent) => void
    const sessionID = "ses_loaded_history"
    const initialMessages = Array.from({ length: TUI_SESSION_MESSAGE_STORE_LIMIT }, (_, index) => ({
      id: `msg_${String(index).padStart(3, "0")}`,
      sessionID,
      role: index % 2 === 0 ? "user" : "assistant",
      agent: "build",
      model: { providerID: "openai", modelID: "gpt-test" },
      tokens: {},
      time: { created: index + 1, ...(index % 2 === 0 ? { completed: index + 1 } : {}) },
    }))
    const nextMessage = {
      id: `msg_${String(TUI_SESSION_MESSAGE_STORE_LIMIT).padStart(3, "0")}`,
      sessionID,
      role: "assistant",
      agent: "build",
      model: { providerID: "openai", modelID: "gpt-test" },
      tokens: {},
      time: { created: TUI_SESSION_MESSAGE_STORE_LIMIT + 1 },
    }
    const pinnedMessageID = initialMessages[0]!.id

    const { app, sync } = await mount(
      {},
      {
        events: eventSource({
          onSubscribe: (handler) => {
            emit = handler
          },
        }),
      },
    )

    try {
      sync.set("message", sessionID, initialMessages as any)
      sync.session.pinMessage(sessionID, pinnedMessageID)

      emit({
        directory,
        project: "proj_test",
        payload: {
          id: "evt_message_updated_no_trim",
          type: "message.updated",
          properties: { sessionID, info: nextMessage },
        },
      } as GlobalEvent)

      expect(sync.data.message[sessionID]?.length).toBe(TUI_SESSION_MESSAGE_STORE_LIMIT)
      expect(sync.data.message[sessionID]?.slice(0, 2).map((message) => message.id)).toEqual([
        pinnedMessageID,
        "msg_002",
      ])
      expect(sync.data.message[sessionID]?.at(-1)?.id).toBe(nextMessage.id)
    } finally {
      app.renderer.destroy()
      Global.Path.state = previous
    }
  })

  test("live message events do not replace an older paged window with a tail message", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")

    let emit!: (event: GlobalEvent) => void
    const sessionID = "ses_paged_history_live"
    const info = {
      id: sessionID,
      projectID: "proj_test",
      directory,
      title: "Paged history live",
      version: "test",
      time: { created: 1, updated: 600 },
    }
    const messages = Array.from({ length: 600 }, (_, index) => ({
      info: {
        id: `msg_${index.toString().padStart(3, "0")}`,
        sessionID,
        role: index % 2 === 0 ? "user" : "assistant",
        agent: "build",
        model: { providerID: "openai", modelID: "gpt-test" },
        tokens: {},
        time: { created: index + 1, completed: index + 1 },
      },
      parts: [],
    }))
    const page = (start: number, cursor?: string) =>
      new Response(JSON.stringify(messages.slice(start, start + TUI_SESSION_MESSAGE_SYNC_LIMIT)), {
        headers: {
          "content-type": "application/json",
          ...(cursor ? { "X-Next-Cursor": cursor } : {}),
        },
      })
    const nextMessage = {
      id: "msg_600",
      sessionID,
      role: "assistant",
      agent: "build",
      model: { providerID: "openai", modelID: "gpt-test" },
      tokens: {},
      time: { created: 601 },
    }

    const { app, sync } = await mount(
      {
        [`/session/${sessionID}`]: info,
        [`/session/${sessionID}/message`]: (url: URL) => {
          const before = url.searchParams.get("before")
          const after = url.searchParams.get("after")
          const start = after
            ? Math.min(messages.length, (messageIndexFromCursor(after) ?? -1) + 1)
            : before
              ? Math.max(0, (messageIndexFromCursor(before) ?? 0) - TUI_SESSION_MESSAGE_SYNC_LIMIT)
              : 550
          return page(
            start,
            after
              ? start + TUI_SESSION_MESSAGE_SYNC_LIMIT < messages.length
                ? String(start + TUI_SESSION_MESSAGE_SYNC_LIMIT - 1)
                : undefined
              : start > 0
                ? String(start)
                : undefined,
          )
        },
        [`/session/${sessionID}/todo`]: [],
        [`/session/${sessionID}/diff`]: [],
      },
      {
        events: eventSource({
          onSubscribe: (handler) => {
            emit = handler
          },
        }),
      },
    )

    try {
      await sync.session.sync(sessionID, { force: true })
      for (let index = 0; index < 9; index++) await sync.session.loadOlder(sessionID)

      expect(sync.data.message[sessionID]?.[0]?.id).toBe("msg_000")
      expect(sync.data.message[sessionID]?.at(-1)?.id).toBe("msg_149")
      expect(sync.session.history(sessionID)).toMatchObject({ hasMoreOlder: false, hasMoreNewer: true })

      emit({
        directory,
        project: "proj_test",
        payload: {
          id: "evt_message_updated_paged_window",
          type: "message.updated",
          properties: { sessionID, info: nextMessage },
        },
      } as GlobalEvent)

      expect(sync.data.message[sessionID]?.length).toBe(TUI_SESSION_MESSAGE_STORE_LIMIT)
      expect(sync.data.message[sessionID]?.[0]?.id).toBe("msg_000")
      expect(sync.data.message[sessionID]?.at(-1)?.id).toBe("msg_149")
      expect(sync.data.session_latest_assistant[sessionID]?.id).toBe(nextMessage.id)
      expect(sync.session.history(sessionID)).toMatchObject({ hasMoreOlder: false, hasMoreNewer: true })
    } finally {
      app.renderer.destroy()
      Global.Path.state = previous
    }
  })

  test("session.created events add new sessions to live sync state", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")

    let emit!: (event: GlobalEvent) => void
    const info = {
      id: "ses_created",
      projectID: "proj_test",
      directory,
      title: "Created elsewhere",
      version: "test",
      time: { created: 1, updated: 1 },
    }

    const { app, sync } = await mount(
      {},
      {
        events: eventSource({
          onSubscribe: (handler) => {
            emit = handler
          },
        }),
      },
    )

    try {
      emit({
        directory,
        project: "proj_test",
        payload: {
          id: "evt_created",
          type: "session.created",
          properties: { sessionID: info.id, info },
        },
      } as GlobalEvent)

      await wait(() => sync.data.session.some((session) => session.id === info.id))
      expect(sync.data.session.find((session) => session.id === info.id)).toMatchObject(info)
    } finally {
      app.renderer.destroy()
      Global.Path.state = previous
    }
  })

  test("stale running shell snapshots do not replace newer live output", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")

    let emit!: (event: GlobalEvent) => void
    const sessionID = "ses_shell_output"
    const messageID = "msg_shell_output"
    const partID = "prt_shell_output"
    const callID = "call_shell_output"
    const part = {
      id: partID,
      messageID,
      sessionID,
      type: "tool",
      tool: "bash",
      callID,
      state: {
        status: "running",
        input: { command: "long-command" },
        time: { start: 1 },
        metadata: { output: "old output\n" },
      },
    }
    const { app, sync } = await mount(
      {},
      {
        events: eventSource({
          onSubscribe: (handler) => {
            emit = handler
          },
        }),
      },
    )

    try {
      sync.set("message", sessionID, [
        {
          id: messageID,
          sessionID,
          role: "assistant",
          agent: "build",
          model: { providerID: "openai", modelID: "gpt-test" },
          tokens: {},
          time: { created: 1 },
        } as any,
      ])
      sync.set("part", messageID, [part as any])

      emit({
        directory,
        project: "proj_test",
        payload: {
          id: "evt_shell_delta",
          type: "session.next.shell.output",
          properties: { sessionID, callID, delta: "new output\n" },
        },
      } as GlobalEvent)
      emit({
        directory,
        project: "proj_test",
        payload: {
          id: "evt_stale_shell_part",
          type: "message.part.updated",
          properties: { sessionID, part: part as any, time: 2 },
        },
      } as GlobalEvent)

      expect(sync.data.part[messageID]?.[0]).toMatchObject({
        state: { status: "running", metadata: { output: "old output\nnew output\n" } },
      })
    } finally {
      app.renderer.destroy()
      Global.Path.state = previous
    }
  })

  test("sync payload message part updates feed live session state", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")

    let emit!: (event: GlobalEvent) => void
    const sessionID = "ses_sync_live"
    const messageID = "msg_sync_live"
    const partID = "prt_sync_live"
    const initialPart = {
      id: partID,
      messageID,
      sessionID,
      type: "text",
      text: "hel",
      time: { start: 1 },
    }
    const updatedPart = {
      ...initialPart,
      text: "hello from loop",
    }

    const { app, sync } = await mount(
      {},
      {
        events: eventSource({
          onSubscribe: (handler) => {
            emit = handler
          },
        }),
      },
    )

    try {
      sync.set("part", messageID, [initialPart as any])

      emit({
        directory,
        project: "proj_test",
        payload: {
          type: "sync",
          syncEvent: {
            id: "evt_sync_part",
            seq: 1,
            aggregateID: sessionID,
            type: "message.part.updated.1",
            data: { sessionID, part: updatedPart, time: 2 },
          },
        },
      } as unknown as GlobalEvent)

      await wait(() => (sync.data.part[messageID]?.[0] as { text?: string } | undefined)?.text === updatedPart.text)
      expect(sync.data.part[messageID]?.[0]).toMatchObject(updatedPart)
    } finally {
      app.renderer.destroy()
      Global.Path.state = previous
    }
  })

  test("v2 message sync previews long text with latest tail", async () => {
    const sessionID = "ses_v2_long_preview_tail"
    const text = ["BEGIN V2 PREVIEW", "middle chunk ".repeat(12000), "LATEST V2 TAIL"].join("\n")
    const messages = [
      {
        id: "msg_v2_long_preview_tail",
        type: "assistant",
        agent: "build",
        model: { id: "gpt-test", providerID: "openai", variant: "test" },
        time: { created: 1 },
        content: [{ type: "text", text }],
      },
    ]

    const { app, sync } = await mountV2({
      [`/api/session/${sessionID}/message`]: () => ({ items: messages }),
    })

    try {
      await sync.session.message.sync(sessionID)
      const preview = (sync.data.messages[sessionID]?.[0] as { content?: Array<{ text?: string }> } | undefined)
        ?.content?.[0]?.text
      expect(preview?.startsWith("BEGIN V2 PREVIEW")).toBe(true)
      expect(preview).toContain("Preview truncated")
      expect(preview).toContain("LATEST V2 TAIL")
      expect(preview!.length).toBeLessThanOrEqual(128 * 1024)
    } finally {
      app.renderer.destroy()
    }
  })

  test("v2 message sync refetches known sessions after reconnect", async () => {
    let emit!: (event: GlobalEvent) => void
    const sessionID = "ses_v2_reconnect"
    let fetchCount = 0
    const messages = [
      [{ id: "msg_before", type: "user", text: "before", time: { created: 1 } }],
      [{ id: "msg_after", type: "user", text: "after", time: { created: 2 } }],
    ]

    const { app, sync } = await mountV2(
      {
        [`/api/session/${sessionID}/message`]: () => ({ items: messages[Math.min(fetchCount++, messages.length - 1)] }),
      },
      {
        events: eventSource({
          onSubscribe: (handler) => {
            emit = handler
          },
        }),
      },
    )

    try {
      await sync.session.message.sync(sessionID)
      expect(sync.data.messages[sessionID]?.[0]).toMatchObject({ id: "msg_before", text: "before" })

      emit({
        directory,
        project: "proj_test",
        payload: {
          id: "evt_connected",
          type: "server.connected",
          properties: {},
        },
      } as GlobalEvent)

      await wait(() => sync.data.messages[sessionID]?.[0]?.id === "msg_after")
      expect(sync.data.messages[sessionID]?.[0]).toMatchObject({ id: "msg_after", text: "after" })
    } finally {
      app.renderer.destroy()
    }
  })
})
