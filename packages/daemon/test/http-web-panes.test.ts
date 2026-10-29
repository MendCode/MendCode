import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { HTTP_WEB } from "../src/http-web"

type Fake = Record<string, any>
const sha = (text: string) => createHash("sha256").update(text).digest("hex")
const wsId = `ws_${"a".repeat(24)}`
const ptyId = `pty_${"b".repeat(32)}`

function harness({ readOnly = false, editEnabled = true, workspaces = true }: { readOnly?: boolean; editEnabled?: boolean; workspaces?: boolean } = {}) {
  const elements = new Map<string, Fake>()
  const make = (): Fake => ({ value: "", textContent: "", disabled: true, hidden: false, dataset: {}, children: [] as Fake[], scrollTop: 0, scrollHeight: 0, clientWidth: 680, replaceChildren() { this.children = [] }, append(item: Fake) { this.children.push(item) }, setAttribute(name: string, value: string) { this.attrs = { ...this.attrs, [name]: value } }, removeAttribute() {} })
  const el = (id: string) => { if (!elements.has(id)) elements.set(id, make()); return elements.get(id)! }
  const calls: Array<{ method: string; url: string; headers: Record<string, string>; body?: any }> = []
  const files = new Map([["a.txt", "hello\n"]])
  const sockets: Array<Fake> = []
  class FakeSocket {
    sent: string[] = []; closed = false; binaryType = ""
    constructor(public url: string) { sockets.push(this) }
    send(data: string) { this.sent.push(data) }
    close() { this.closed = true; ;(this as Fake).onclose?.() }
  }
  const fetcher = async (url: string, init: RequestInit & { headers: Record<string, string> }) => {
    const method = init.method ?? "GET"
    const body = init.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, url, headers: init.headers, ...(body ? { body } : {}) })
    const fail = (status: number, message: string) => Response.json({ error: { message } }, { status })
    if (url === "/event" && body?.hello) return Response.json({ directory: "/work", remote: { readOnly } })
    if (url === "/event") return new Response(new ReadableStream({ start(controller) { init.signal?.addEventListener("abort", () => controller.error(Object.assign(new Error("aborted"), { name: "AbortError" }))) } }))
    if (url === "/experimental/workspace") return workspaces && !readOnly ? Response.json({ workspaces: [{ id: wsId, name: "api", directory: "/api", type: "local" }] }) : fail(403, "Full token required")
    if (url.startsWith("/file/content")) return Response.json({ type: "text", content: "hello" })
    if (url.startsWith("/file?")) return Response.json(url.includes("path=src") ? [{ name: "b.ts", path: "src/b.ts", absolute: "/work/src/b.ts", type: "file", ignored: false }] : [{ name: "src", path: "src", absolute: "/work/src", type: "directory", ignored: false }, { name: "a.txt", path: "a.txt", absolute: "/work/a.txt", type: "file", ignored: false }])
    if (url === "/pty" && method === "POST") return Response.json({ id: ptyId })
    if (url === `/pty/${ptyId}/connect-token`) return Response.json({ ticket: "tkt_1", expires_in: 60 })
    if (url === `/pty/${ptyId}`) return Response.json(method === "DELETE" ? true : {})
    if (url !== "/command") return fail(404, "unknown")
    const work = init.headers["x-mendcode-workspace"] ? "ws" : "main"
    if (body.type === "session.list") return Response.json({ sessions: [{ sessionId: `ses_${work}`, title: `${work} session` }] })
    if (body.type === "session.events") return Response.json({ events: [] })
    if (body.type === "session.create") return Response.json({ sessionId: `ses_${work}` })
    if (body.type === "file.edit") {
      if (!editEnabled) return fail(501, "File editing disabled; start the server with --edit")
      const { operation, path: file, content, expected } = body.input
      const current = files.get(file)
      const digest = current === undefined ? null : sha(current)
      if (operation === "read") return Response.json({ path: file, content: current ?? "", sha256: digest, bytes: current?.length ?? 0 })
      if (expected !== digest) return fail(400, "File changed on disk; reload before saving")
      files.set(file, content)
      return Response.json({ path: file, sha256: sha(content), bytes: content.length })
    }
    return Response.json({})
  }
  const script = HTTP_WEB.match(/<script>([\s\S]*)<\/script>/)![1]!
  new Function("document", "fetch", "crypto", "location", "WebSocket", script)({ getElementById: el, createElement: () => make() }, fetcher, crypto, { origin: "http://127.0.0.1:4096" }, FakeSocket)
  return { el, calls, files, sockets }
}
const connect = async (options?: Parameters<typeof harness>[0]) => {
  const h = harness(options)
  h.el("token").value = "full"
  await h.el("login").onsubmit({ preventDefault() {} })
  return h
}
const names = (list: Fake) => (list.children as Fake[]).map((child) => child.textContent)
const submit = (form: Fake) => form.onsubmit({ preventDefault() {} })

test("workspace switcher retargets sessions and commands with the workspace header", async () => {
  const h = await connect()
  expect(names(h.el("workspace"))).toEqual(["Project", "api"])
  expect(h.el("workspace").disabled).toBe(false)
  expect(h.el("title").textContent).toBe("main session")
  h.el("workspace").value = wsId
  await h.el("workspace").onchange()
  await Bun.sleep(5)
  expect(h.el("title").textContent).toBe("ws session")
  expect(h.calls.filter((call) => call.body?.type === "session.list").map((call) => call.headers["x-mendcode-workspace"])).toEqual([undefined, wsId])
  await h.el("new").onclick()
  expect(h.calls.findLast((call) => call.body?.type === "session.create")!.body.directory).toBe("/api")
  h.el("workspace").value = ""
  await h.el("workspace").onchange()
  await h.el("new").onclick()
  expect(h.calls.findLast((call) => call.body?.type === "session.create")!.body.directory).toBe("/work")
})

test("workspace list failures leave the single project selectable and disabled", async () => {
  const h = await connect({ workspaces: false })
  expect(names(h.el("workspace"))).toEqual(["Project"])
  expect(h.el("workspace").disabled).toBe(true)
  expect(h.el("title").textContent).toBe("main session")
})

test("tabs show one pane at a time and arrow keys move between them", async () => {
  const h = await connect()
  expect([h.el("pane-chat").hidden, h.el("pane-files").hidden, h.el("pane-terminal").hidden]).toEqual([false, false, false])
  h.el("tab-files").onclick()
  expect([h.el("pane-chat").hidden, h.el("pane-files").hidden, h.el("pane-terminal").hidden]).toEqual([true, false, true])
  expect(h.el("tab-files").attrs["aria-selected"]).toBe("true")
  h.el("tabs").onkeydown({ key: "ArrowRight", preventDefault() {} })
  expect([h.el("pane-files").hidden, h.el("pane-terminal").hidden]).toEqual([true, false])
  h.el("tabs").onkeydown({ key: "ArrowRight", preventDefault() {} })
  expect(h.el("pane-chat").hidden).toBe(false)
})

test("editor lists the project, opens a file, saves with the expected hash and reports conflicts", async () => {
  const h = await connect()
  h.el("tab-files").onclick()
  await Bun.sleep(5)
  expect(names(h.el("entries"))).toEqual(["src/", "a.txt"])
  await h.el("entries").children[1].onclick()
  expect(h.el("editor").value).toBe("hello\n")
  expect(h.el("editor").readOnly).toBe(false)
  expect(h.el("editState").textContent).toBe("a.txt")
  h.el("editor").value = "hello world\n"
  h.el("editor").oninput()
  expect(h.el("editState").textContent).toBe("a.txt (unsaved)")
  expect(h.el("save").disabled).toBe(false)
  await h.el("entries").children[1].onclick()
  expect(h.el("error").textContent).toContain("Unsaved changes")
  expect(h.el("editor").value).toBe("hello world\n")
  await h.el("save").onclick()
  await Bun.sleep(5)
  expect(h.files.get("a.txt")).toBe("hello world\n")
  expect(h.el("fileNote").textContent).toBe("Saved 12 bytes")
  expect(h.el("save").disabled).toBe(true)
  const write = h.calls.findLast((call) => call.body?.input?.operation === "write")!
  expect(write.body.input.expected).toBe(sha("hello\n"))
  h.files.set("a.txt", "changed elsewhere\n")
  h.el("editor").value = "mine\n"
  h.el("editor").oninput()
  await h.el("save").onclick()
  await Bun.sleep(5)
  expect(h.el("error").textContent).toContain("changed on disk")
  expect(h.el("fileNote").textContent).toBe("Not saved")
  expect(h.files.get("a.txt")).toBe("changed elsewhere\n")
  await h.el("reload").onclick()
  await Bun.sleep(5)
  expect(h.el("editor").value).toBe("changed elsewhere\n")
})

test("editor creates a new file and navigates directories", async () => {
  const h = await connect()
  h.el("tab-files").onclick()
  await Bun.sleep(5)
  await h.el("entries").children[0].onclick()
  expect(names(h.el("entries"))).toEqual(["b.ts"])
  h.el("path").value = "docs/new.md"
  await submit(h.el("fileForm"))
  await Bun.sleep(5)
  expect(h.el("fileNote").textContent).toContain("New file")
  h.el("editor").value = "# new\n"
  h.el("editor").oninput()
  await h.el("save").onclick()
  await Bun.sleep(5)
  expect(h.files.get("docs/new.md")).toBe("# new\n")
  expect(h.calls.findLast((call) => call.body?.input?.operation === "write")!.body.input.expected).toBeNull()
  await h.el("up").onclick()
  expect(names(h.el("entries"))).toEqual(["src/", "a.txt"])
})

test("editor falls back to a read-only viewer when the server did not enable edit", async () => {
  const h = await connect({ editEnabled: false })
  h.el("tab-files").onclick()
  await Bun.sleep(5)
  await h.el("entries").children[1].onclick()
  expect(h.el("editor").value).toBe("hello")
  expect(h.el("editor").readOnly).toBe(true)
  expect(h.el("fileNote").textContent).toContain("--edit")
  h.el("editor").oninput()
  expect(h.el("save").disabled).toBe(true)
})

test("read-only tokens get no editor, terminal or file requests", async () => {
  const h = await connect({ readOnly: true })
  h.el("tab-files").onclick()
  await Bun.sleep(5)
  for (const name of ["path", "open", "up", "termOpen"]) expect(h.el(name).disabled).toBe(true)
  expect(h.calls.some((call) => call.url.startsWith("/file"))).toBe(false)
})

test("terminal starts a PTY, connects with a one-use ticket and renders line output", async () => {
  const h = await connect()
  await h.el("termOpen").onclick()
  await Bun.sleep(5)
  const create = h.calls.find((call) => call.url === "/pty")!
  expect(create.method).toBe("POST")
  expect(h.calls.find((call) => call.url.endsWith("/connect-token"))!.headers["x-mendcode-ticket"]).toBe("1")
  const socket = h.sockets[0]!
  expect(socket.url).toBe(`ws://127.0.0.1:4096/pty/${ptyId}/connect?ticket=tkt_1&cursor=0`)
  expect(JSON.stringify(h.calls)).not.toContain("tkt_1\"}")
  socket.onopen()
  expect(h.el("termState").textContent).toBe("connected")
  expect(h.el("termLine").disabled).toBe(false)
  expect(h.calls.find((call) => call.method === "PUT")!.body.size.rows).toBe(24)
  socket.onmessage({ data: "\u001b[32mbuild\u001b[0m: 10%\r\u001b[Kdone\r\n$ ls\r\na\tb\r\n" })
  socket.onmessage({ data: new Uint8Array([0, ...new TextEncoder().encode('{"cursor":40}')]).buffer })
  expect(h.el("term").textContent).toBe("done\n$ ls\na       b\n")
  h.el("termLine").value = "echo hi"
  await submit(h.el("termForm"))
  h.el("termInt").onclick()
  h.el("termEof").onclick()
  expect(socket.sent).toEqual(["echo hi\r", "\u0003", "\u0004"])
  expect(h.el("termLine").value).toBe("")
})

test("terminal reconnects from the last cursor and close deletes the PTY", async () => {
  const h = await connect()
  await h.el("termOpen").onclick()
  await Bun.sleep(5)
  h.sockets[0]!.onopen()
  h.sockets[0]!.onmessage({ data: "abc" })
  h.sockets[0]!.onclose()
  expect(h.el("termState").textContent).toBe("disconnected")
  expect(h.el("termOpen").textContent).toBe("Reconnect")
  expect(h.el("termLine").disabled).toBe(true)
  await h.el("termOpen").onclick()
  await Bun.sleep(5)
  expect(h.sockets[1]!.url).toContain("cursor=3")
  expect(h.calls.filter((call) => call.url === "/pty" && call.method === "POST")).toHaveLength(1)
  await h.el("termClose").onclick()
  await Bun.sleep(5)
  expect(h.sockets[1]!.closed).toBe(true)
  expect(h.calls.some((call) => call.method === "DELETE" && call.url === `/pty/${ptyId}`)).toBe(true)
  expect(h.el("termOpen").textContent).toBe("Start")
})

test("terminal start failure shows the server message and disconnect cleans up the PTY", async () => {
  const h = await connect()
  await h.el("termOpen").onclick()
  await Bun.sleep(5)
  h.sockets[0]!.onopen()
  h.el("disconnect").onclick()
  await Bun.sleep(5)
  expect(h.sockets[0]!.closed).toBe(true)
  expect(h.calls.some((call) => call.method === "DELETE" && call.headers.Authorization === "Bearer full")).toBe(true)
  for (const name of ["termLine", "termSend", "path", "editor"]) expect(h.el(name).disabled).toBe(true)
  expect(h.el("workspace").disabled).toBe(true)
})

test("browser client never writes server content as HTML", () => {
  expect(HTTP_WEB).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/)
})
