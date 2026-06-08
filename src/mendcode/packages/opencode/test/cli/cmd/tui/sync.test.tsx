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
import { SyncProvider, useSync } from "../../../../src/cli/cmd/tui/context/sync"
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

function eventSource(): EventSource {
  return {
    subscribe: async () => () => {},
  }
}

function createFetch(overrides: Record<string, unknown | ((url: URL) => unknown)> = {}) {
  const session = [] as URL[]
  const fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.pathname === "/session") session.push(url)
    const override = overrides[url.pathname]
    if (override) return json(typeof override === "function" ? override(url) : override)

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

async function mount(overrides: Record<string, unknown | ((url: URL) => unknown)> = {}) {
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
          <SDKProvider url="http://test" directory={directory} fetch={calls.fetch} events={eventSource()}>
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

describe("tui sync", () => {
  test("refresh scopes sessions by default and lists project sessions when disabled", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, kv, sync, session } = await mount()

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
})
