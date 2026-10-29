import { afterEach, expect, test } from "bun:test"
import type { BrowserInput } from "@mendcode/tools"
import { browserLaunchArgs, connectCdp, findBrowserExecutable, type BrowserDriver, type CdpConnection, type CdpEvent } from "../src/browser-cdp"
import { createBrowserControl } from "../src/browser"

type Call = { method: string; params: Record<string, unknown>; sessionId?: string | undefined }

/** A scripted DevTools endpoint: a page with a few elements, no real browser. */
function fakeDriver(options: { snapshot?: Record<string, unknown>; clickError?: Record<string, unknown>; navigateError?: string } = {}) {
  const calls: Call[] = []
  const listeners = new Set<(event: CdpEvent) => void>()
  let contexts = 0
  let killed = 0
  let launches = 0
  let url = "about:blank"
  let closeConnection!: () => void
  const closed = new Promise<void>((resolve) => { closeConnection = resolve })
  const emit = (event: CdpEvent) => { for (const listener of listeners) listener(event) }
  const connection: CdpConnection = {
    async send(method, params = {}, sessionId) {
      calls.push({ method, params, sessionId })
      switch (method) {
        case "Target.createBrowserContext": return { browserContextId: `ctx${++contexts}` }
        case "Target.createTarget": return { targetId: `target-${params.browserContextId}` }
        case "Target.attachToTarget": return { sessionId: `cdp-${params.targetId}` }
        case "Page.navigate":
          if (options.navigateError) return { errorText: options.navigateError }
          url = String(params.url)
          return { frameId: "f" }
        case "Page.captureScreenshot": return { data: Buffer.from("png-bytes").toString("base64") }
        case "Page.getNavigationHistory": return { currentIndex: 1, entries: [{ id: 7 }, { id: 8 }] }
        case "Runtime.evaluate": {
          const expression = String(params.expression)
          if (expression === "document.readyState") return { result: { value: "complete" } }
          if (expression.startsWith("({ url: location.href")) return { result: { value: { url, title: "Fake page", ready: "complete" } } }
          if (expression.includes("const maxElements")) return { result: { value: options.snapshot ?? { url, title: "Fake page", text: "Hello world", textCut: false, lines: ['[0] button "Save"', '[1] input:text "Email" value="a@b.c"'], total: 2 } } }
          if (expression.includes("elementFromPoint")) return { result: { value: options.clickError ?? { x: 10, y: 20 } } }
          if (expression.includes("el.focus()")) return { result: { value: { kind: "text" } } }
          if (expression.includes("window.scrollBy")) return { result: { value: { y: 640, max: 2000 } } }
          return { result: { value: true } }
        }
        default: return {}
      }
    },
    onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    closed,
    close: () => closeConnection(),
  }
  const driver: BrowserDriver = {
    async launch() {
      launches++
      return { connection, async kill() { killed++ } }
    },
  }
  return { driver, calls, emit, killed: () => killed, launches: () => launches, methods: (name: string) => calls.filter((call) => call.method === name) }
}

const live: Array<ReturnType<typeof createBrowserControl>> = []
test("tabs are bounded and private to their chat; select and close retain the other tabs", async () => {
  const h = setup({}, { limits: { maxTabs: 2 } })
  expect(await h.run("s1", { action: "tabs" })).toMatchObject({ ok: true, text: "No tabs open." })
  expect(h.fake.launches()).toBe(0)
  await h.run("s1", { action: "navigate", url: "https://example.test/one" })
  await h.run("s1", { action: "open_tab", url: "https://example.test/two" })
  const tabs = await h.run("s1", { action: "tabs" })
  expect(tabs.ok && tabs.text).toContain("default")
  expect(tabs.ok && tabs.text).toContain("tab1 active")
  expect(h.control.count()).toBe(2)
  expect(await h.run("s2", { action: "select_tab", tabId: "tab1" })).toMatchObject({ ok: false })
  expect(await h.run("s1", { action: "open_tab", url: "https://example.test/three" })).toMatchObject({ ok: false })
  expect(await h.run("s1", { action: "select_tab", tabId: "default" })).toMatchObject({ ok: true })
  await h.run("s1", { action: "snapshot" })
  expect(h.fake.methods("Runtime.evaluate").at(-1)?.sessionId).toBe("cdp-target-ctx1")
  await h.run("s1", { action: "close_tab", tabId: "default" })
  expect(h.control.count()).toBe(1)
  await h.run("s1", { action: "close" })
  expect(h.control.count()).toBe(0)
  expect(h.fake.killed()).toBe(1)
})

test("invalid new-tab URLs launch nothing; forgetting a chat disposes every tab", async () => {
  const h = setup()
  expect(await h.run("s1", { action: "open_tab", url: "file:///secret" })).toMatchObject({ ok: false })
  expect(h.fake.launches()).toBe(0)
  await h.run("s1", { action: "open_tab", url: "https://example.test/" })
  await h.run("s1", { action: "open_tab", url: "https://example.test/" })
  await h.control.forget("s1")
  expect(h.fake.methods("Target.disposeBrowserContext")).toHaveLength(2)
  expect(h.control.count()).toBe(0)
})
afterEach(async () => { for (const control of live.splice(0)) await control.stop() })
function setup(options: Parameters<typeof fakeDriver>[0] = {}, extra: Partial<Parameters<typeof createBrowserControl>[0]> = {}) {
  const fake = fakeDriver(options)
  const control = createBrowserControl({ enabled: true, driver: fake.driver, ...extra })
  live.push(control)
  const run = (sessionId: string, input: BrowserInput) => control.port(sessionId).run(input, AbortSignal.timeout(5_000))
  return { fake, control, run }
}

test("is off by default: nothing is launched and the model is told how to opt in", async () => {
  const fake = fakeDriver()
  const control = createBrowserControl({ driver: fake.driver })
  live.push(control)
  const outcome = await control.port("s1").run({ action: "navigate", url: "http://localhost:3000/" }, AbortSignal.timeout(1_000))
  expect(outcome).toEqual({ ok: false, error: expect.stringContaining("MENDCODE_BROWSER=1") })
  expect(fake.launches()).toBe(0)
})

test("navigate opens an isolated context and page, refuses non-web schemes and reports failures", async () => {
  const { fake, run } = setup()
  expect(await run("s1", { action: "navigate", url: "file:///etc/passwd" })).toMatchObject({ ok: false })
  expect(await run("s1", { action: "navigate", url: "javascript:alert(1)" })).toMatchObject({ ok: false })
  expect(await run("s1", { action: "navigate", url: "http://user:pw@localhost/" })).toMatchObject({ ok: false })
  expect(fake.launches()).toBe(0)
  const opened = await run("s1", { action: "navigate", url: "http://localhost:3000/app" })
  expect(opened).toMatchObject({ ok: true, page: { url: "http://localhost:3000/app", title: "Fake page" } })
  expect(fake.methods("Target.createBrowserContext")).toHaveLength(1)
  expect(fake.methods("Browser.setDownloadBehavior")[0]!.params.behavior).toBe("deny")
  expect(fake.methods("Emulation.setDeviceMetricsOverride")).toHaveLength(1)
  const failing = setup({ navigateError: "net::ERR_CONNECTION_REFUSED" })
  expect(await failing.run("s1", { action: "navigate", url: "http://localhost:1/" })).toEqual({ ok: false, error: "navigation failed: net::ERR_CONNECTION_REFUSED" })
})

test("actions need an open page; chat sessions get separate browser contexts", async () => {
  const { fake, run } = setup()
  expect(await run("s1", { action: "snapshot" })).toEqual({ ok: false, error: "no page is open; use navigate first" })
  await run("s1", { action: "navigate", url: "http://localhost:3000/" })
  await run("s2", { action: "navigate", url: "http://localhost:3000/" })
  expect(fake.launches()).toBe(1)
  const contexts = fake.methods("Target.createBrowserContext")
  expect(contexts).toHaveLength(2)
  expect(new Set(fake.methods("Page.navigate").map((call) => call.sessionId)).size).toBe(2)
})

test("snapshot lists text and numbered elements and labels web content as untrusted", async () => {
  const { run } = setup()
  await run("s1", { action: "navigate", url: "http://localhost:3000/" })
  const outcome = await run("s1", { action: "snapshot" })
  expect(outcome.ok).toBe(true)
  if (!outcome.ok) return
  expect(outcome.text).toContain("untrusted web content")
  expect(outcome.text).toContain("Hello world")
  expect(outcome.text).toContain('[0] button "Save"')
})

test("click presses at the element, and reports stale or covered elements instead of clicking", async () => {
  const { fake, run } = setup()
  await run("s1", { action: "navigate", url: "http://localhost:3000/" })
  expect(await run("s1", { action: "click", ref: 0 })).toMatchObject({ ok: true })
  expect(fake.methods("Input.dispatchMouseEvent").map((call) => call.params.type)).toEqual(["mouseMoved", "mousePressed", "mouseReleased"])
  const stale = setup({ clickError: { error: "stale" } })
  await stale.run("s1", { action: "navigate", url: "http://localhost:3000/" })
  expect(await stale.run("s1", { action: "click", ref: 4 })).toEqual({ ok: false, error: "ref 4 is not on the current page; take a new snapshot" })
  const covered = setup({ clickError: { error: "covered", by: "div" } })
  await covered.run("s1", { action: "navigate", url: "http://localhost:3000/" })
  expect(await covered.run("s1", { action: "click", ref: 0 })).toMatchObject({ ok: false, error: expect.stringContaining("covered") })
  expect(covered.fake.methods("Input.dispatchMouseEvent")).toHaveLength(0)
})

test("type inserts text and optionally presses Enter, without echoing the text back", async () => {
  const { fake, run } = setup()
  await run("s1", { action: "navigate", url: "http://localhost:3000/" })
  const typed = await run("s1", { action: "type", ref: 1, text: "hunter2-secret", submit: true })
  expect(typed.ok).toBe(true)
  if (!typed.ok) return
  expect(typed.text).not.toContain("hunter2-secret")
  expect(typed.text).toContain("14 characters")
  expect(fake.methods("Input.insertText")[0]!.params.text).toBe("hunter2-secret")
  expect(fake.methods("Input.dispatchKeyEvent").map((call) => `${call.params.type}:${call.params.key}`)).toEqual(["keyDown:Enter", "keyUp:Enter"])
})

test("press, scroll, back, wait and screenshot work on the open page", async () => {
  const { fake, run } = setup()
  await run("s1", { action: "navigate", url: "http://localhost:3000/" })
  expect(await run("s1", { action: "press", key: "Tab" })).toMatchObject({ ok: true })
  expect(await run("s1", { action: "scroll", direction: "down" })).toMatchObject({ ok: true, text: expect.stringContaining("y=640 of 2000") })
  expect(await run("s1", { action: "back" })).toMatchObject({ ok: true })
  expect(fake.methods("Page.navigateToHistoryEntry")[0]!.params.entryId).toBe(7)
  expect(await run("s1", { action: "wait", ms: 5 })).toMatchObject({ ok: true })
  expect(await run("s1", { action: "wait", text: "ready", ms: 200 })).toMatchObject({ ok: true })
  const shot = await run("s1", { action: "screenshot" })
  expect(shot.ok && shot.image?.mime).toBe("image/png")
  expect(shot.ok && new TextDecoder().decode(shot.image!.bytes)).toBe("png-bytes")
})

test("console collects page output and errors once, dialogs are dismissed", async () => {
  const { fake, run } = setup()
  await run("s1", { action: "navigate", url: "http://localhost:3000/" })
  const cdp = fake.methods("Target.attachToTarget")[0]!
  const sessionId = `cdp-${cdp.params.targetId}`
  fake.emit({ method: "Runtime.consoleAPICalled", sessionId, params: { type: "log", args: [{ value: "hello" }, { description: "Object" }] } })
  fake.emit({ method: "Runtime.exceptionThrown", sessionId, params: { exceptionDetails: { exception: { description: "TypeError: x is undefined\n at app.js" } } } })
  fake.emit({ method: "Log.entryAdded", sessionId, params: { entry: { level: "error", text: "Failed to load resource: 404", url: "http://localhost:3000/a.js" } } })
  fake.emit({ method: "Page.javascriptDialogOpening", sessionId, params: { type: "confirm", message: "Sure?" } })
  fake.emit({ method: "Runtime.consoleAPICalled", sessionId: "someone-else", params: { type: "log", args: [{ value: "not mine" }] } })
  const first = await run("s1", { action: "console" })
  expect(first.ok && first.text).toBe("[log] hello Object\n[error] TypeError: x is undefined\n[error] Failed to load resource: 404 (http://localhost:3000/a.js)\n[dialog] confirm: Sure? (dismissed)")
  expect(fake.methods("Page.handleJavaScriptDialog")[0]!.params.accept).toBe(false)
  const second = await run("s1", { action: "console" })
  expect(second.ok && second.text).toContain("no console output")
})

test("close and forget dispose the context; the browser process stops with its last page", async () => {
  const { fake, control, run } = setup()
  await run("s1", { action: "navigate", url: "http://localhost:3000/" })
  await run("s2", { action: "navigate", url: "http://localhost:3000/" })
  expect(await run("s1", { action: "close" })).toMatchObject({ ok: true, text: "Browser closed." })
  expect(fake.methods("Target.disposeBrowserContext")).toHaveLength(1)
  expect(fake.killed()).toBe(0)
  await control.forget("s2")
  expect(fake.methods("Target.disposeBrowserContext")).toHaveLength(2)
  expect(fake.killed()).toBe(1)
  expect(control.count()).toBe(0)
  expect(await run("s1", { action: "close" })).toMatchObject({ ok: true, text: "No browser was open." })
})

test("a daemon-wide cap on browser chats refuses the next one until a page closes", async () => {
  const { run } = setup({}, { limits: { maxSessions: 2 } })
  await run("a", { action: "navigate", url: "http://localhost:3000/" })
  await run("b", { action: "navigate", url: "http://localhost:3000/" })
  expect(await run("c", { action: "navigate", url: "http://localhost:3000/" })).toMatchObject({ ok: false, error: expect.stringContaining("too many") })
  await run("a", { action: "close" })
  expect(await run("c", { action: "navigate", url: "http://localhost:3000/" })).toMatchObject({ ok: true })
})

test("unknown sessions and a cancelled call are refused without touching the page", async () => {
  const { fake, control } = setup({}, { hasSession: (id) => id === "known" })
  expect(await control.port("ghost").run({ action: "navigate", url: "http://localhost:3000/" }, AbortSignal.timeout(1_000))).toEqual({ ok: false, error: "unknown session" })
  const aborted = AbortSignal.abort()
  expect(await control.port("known").run({ action: "navigate", url: "http://localhost:3000/" }, aborted)).toEqual({ ok: false, error: "cancelled" })
  expect(fake.methods("Page.navigate")).toHaveLength(0)
})

test("a browser that dies mid-session is relaunched on the next call", async () => {
  const fake = fakeDriver()
  let current = fake
  const control = createBrowserControl({ enabled: true, driver: { launch: (signal) => current.driver.launch(signal) } })
  live.push(control)
  await control.port("s1").run({ action: "navigate", url: "http://localhost:3000/" }, AbortSignal.timeout(2_000))
  expect(control.count()).toBe(1)
  fake.driver.launch(AbortSignal.timeout(100)).then((started) => started.connection.close())
  await Bun.sleep(10)
  expect(control.count()).toBe(0)
  current = fakeDriver()
  const again = await control.port("s1").run({ action: "navigate", url: "http://localhost:3000/" }, AbortSignal.timeout(2_000))
  expect(again.ok).toBe(true)
  expect(current.launches()).toBe(1)
})

test("browser discovery honours an explicit path, then known app locations and PATH names", () => {
  expect(findBrowserExecutable({ explicit: "/opt/x/chrome", exists: (file) => file === "/opt/x/chrome" })).toBe("/opt/x/chrome")
  expect(findBrowserExecutable({ explicit: "/opt/missing", exists: () => false, which: () => "/usr/bin/chromium" })).toBeUndefined()
  expect(findBrowserExecutable({ platform: "darwin", exists: (file) => file === "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser", which: () => null })).toBe("/Applications/Brave Browser.app/Contents/MacOS/Brave Browser")
  expect(findBrowserExecutable({ platform: "linux", exists: () => false, which: (name) => (name === "chromium" ? "/usr/bin/chromium" : null) })).toBe("/usr/bin/chromium")
  expect(findBrowserExecutable({ platform: "linux", exists: () => false, which: () => null })).toBeUndefined()
})

test("launch arguments bind the debugger to loopback with a throwaway profile; sandbox only drops for root", () => {
  const normal = browserLaunchArgs({ profile: "/tmp/p", root: false })
  expect(normal).toContain("--remote-debugging-address=127.0.0.1")
  expect(normal).toContain("--user-data-dir=/tmp/p")
  expect(normal).toContain("--headless=new")
  expect(normal).not.toContain("--no-sandbox")
  expect(browserLaunchArgs({ profile: "/tmp/p", root: true })).toContain("--no-sandbox")
})

test("the DevTools connection matches replies by id, delivers events, times out and ends cleanly", async () => {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request, srv) => (srv.upgrade(request) ? undefined : new Response("no", { status: 400 })),
    websocket: {
      message(socket, raw) {
        const message = JSON.parse(String(raw)) as { id: number; method: string }
        if (message.method === "Slow.never") return
        if (message.method === "Bad.call") {
          socket.send(JSON.stringify({ id: message.id, error: { message: "nope" } }))
          return
        }
        socket.send(JSON.stringify({ method: "Page.loadEventFired", params: { n: 1 }, sessionId: "s" }))
        socket.send(JSON.stringify({ id: message.id, result: { echoed: message.method } }))
      },
    },
  })
  try {
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}`)
    await new Promise<void>((resolve) => socket.addEventListener("open", () => resolve(), { once: true }))
    const connection = connectCdp(socket, 150)
    const events: CdpEvent[] = []
    connection.onEvent((event) => events.push(event))
    expect(await connection.send("Foo.bar", {}, "s")).toEqual({ echoed: "Foo.bar" })
    expect(events[0]).toEqual({ method: "Page.loadEventFired", params: { n: 1 }, sessionId: "s" })
    await expect(connection.send("Bad.call")).rejects.toThrow("nope")
    await expect(connection.send("Slow.never")).rejects.toThrow("timed out")
    await expect(connection.send("Slow.never", {}, undefined, AbortSignal.abort())).rejects.toThrow("cancelled")
    connection.close()
    await connection.closed
    await expect(connection.send("Foo.bar")).rejects.toThrow("closed")
  } finally {
    server.stop(true)
  }
})
