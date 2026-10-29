import { expect, test } from "bun:test"
import { BUILTIN_TOOLS, browserTool, checkBrowserUrl, runTool, type BrowserInput, type BrowserOutcome, type BrowserPort } from "../src"

function fakePort(outcome: BrowserOutcome = { ok: true, text: "done", page: { url: "http://localhost:3000/", title: "App" } }) {
  const inputs: BrowserInput[] = []
  const port: BrowserPort = { async run(input) { inputs.push(input); return outcome } }
  return { port, inputs }
}
const context = (port?: BrowserPort) => ({ cwd: "/tmp", signal: new AbortController().signal, ...(port ? { browser: port } : {}) })

test("browser is opt-in: not a builtin tool", () => {
  expect(BUILTIN_TOOLS.some((tool) => tool.name === "browser")).toBe(false)
})

test("only looking at the open page is read; loading or acting on pages is execute", () => {
  const permission = (action: string) => browserTool.permissionFor!({ action } as never)
  for (const action of ["snapshot", "screenshot", "console", "close", "scroll", "wait"]) expect(permission(action)).toBe("read")
  for (const action of ["navigate", "click", "type", "press", "back"]) expect(permission(action)).toBe("execute")
})

test("URL check allows http(s) only and refuses credentials", () => {
  expect(checkBrowserUrl("http://localhost:3000/a?b=1")).toEqual({ ok: true, url: "http://localhost:3000/a?b=1" })
  expect(checkBrowserUrl("https://example.com")).toEqual({ ok: true, url: "https://example.com/" })
  for (const bad of ["file:///etc/passwd", "javascript:alert(1)", "chrome://settings", "data:text/html,x", "about:blank", "example.com", "https://u:p@example.com"]) expect(checkBrowserUrl(bad).ok).toBe(false)
})

test("without a port the tool says how to enable it", async () => {
  const result = await runTool(browserTool, { action: "snapshot" }, context())
  expect(result.isError).toBe(true)
  expect(result.output).toContain("MENDCODE_BROWSER=1")
})

test("argument and URL problems are refused before the port is called", async () => {
  const { port, inputs } = fakePort()
  for (const args of [{ action: "navigate" }, { action: "navigate", url: "file:///etc/hosts" }, { action: "click" }, { action: "type", ref: 1 }, { action: "press" }, { action: "wait" }, { action: "press", key: "F13" }, { action: "fly" }]) {
    expect((await runTool(browserTool, args, context(port))).isError).toBe(true)
  }
  expect(inputs).toHaveLength(0)
})

test("valid calls reach the port with normalized input and return page facts", async () => {
  const { port, inputs } = fakePort()
  const result = await runTool(browserTool, { action: "navigate", url: "http://localhost:3000" }, context(port))
  expect(result).toMatchObject({ isError: false, output: "done", meta: { url: "http://localhost:3000/", pageTitle: "App" } })
  await runTool(browserTool, { action: "type", ref: 2, text: "secret", submit: true }, context(port))
  await runTool(browserTool, { action: "wait", text: "Saved", ms: 500 }, context(port))
  expect(inputs).toEqual([
    { action: "navigate", url: "http://localhost:3000/" },
    { action: "type", ref: 2, text: "secret", submit: true },
    { action: "wait", ms: 500, text: "Saved" },
  ])
})

test("typed text never appears in the card title", async () => {
  const { port } = fakePort({ ok: true, text: "ok" })
  const result = await runTool(browserTool, { action: "type", ref: 2, text: "super-secret" }, context(port))
  expect(result.title).toBe("type [2]")
})

test("screenshots come back as images and port failures as errors", async () => {
  const image = fakePort({ ok: true, text: "shot", image: { mime: "image/png", bytes: new Uint8Array([1, 2, 3]) } })
  expect((await runTool(browserTool, { action: "screenshot" }, context(image.port))).images).toEqual([{ mime: "image/png", bytes: new Uint8Array([1, 2, 3]) }])
  const failing = fakePort({ ok: false, error: "no page is open; use navigate first" })
  expect(await runTool(browserTool, { action: "snapshot" }, context(failing.port))).toMatchObject({ isError: true, output: "no page is open; use navigate first" })
})

test("a cancelled turn does not reach the browser", async () => {
  const { port, inputs } = fakePort()
  const result = await runTool(browserTool, { action: "snapshot" }, { cwd: "/tmp", signal: AbortSignal.abort(), browser: port })
  expect(result.isError).toBe(true)
  expect(inputs).toHaveLength(0)
})
