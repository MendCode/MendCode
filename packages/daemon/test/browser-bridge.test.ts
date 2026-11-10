import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import net from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import { createUserBrowserTool, userBrowserInput } from "@mendcode/tools"
import { createFrameDecoder, createSiteStore, createUserBrowserBridge, encodeFrame, MAX_FRAME_BYTES, toWire } from "../src/browser-bridge"
import { bridgeFiles, extensionIdFor, installUserBrowser, readReceipt } from "../src/browser-bridge-install"

const roots: string[] = []
function sandbox() {
  const root = mkdtempSync(path.join(tmpdir(), "mendcode-bridge-"))
  roots.push(root)
  const home = path.join(root, "home")
  const dataDir = path.join(root, "data")
  mkdirSync(path.join(home, "Library/Application Support/Google/Chrome"), { recursive: true })
  mkdirSync(path.join(home, "Library/Application Support/BraveSoftware/Brave-Browser"), { recursive: true })
  return { root, home, dataDir }
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const signal = new AbortController().signal

describe("framing", () => {
  test("a frame round-trips and a split chunk waits for the rest", () => {
    const decoder = createFrameDecoder()
    const frame = encodeFrame({ id: 1, op: "tabs" })
    expect(frame.readUInt32LE(0)).toBe(frame.length - 4)
    expect(decoder.push(frame.subarray(0, 3))).toEqual([])
    expect(decoder.push(frame.subarray(3, 9))).toEqual([])
    expect(decoder.push(frame.subarray(9))).toEqual([{ id: 1, op: "tabs" }])
  })
  test("two frames in one chunk both come out", () => {
    expect(createFrameDecoder().push(Buffer.concat([encodeFrame({ a: 1 }), encodeFrame({ b: 2 })]))).toEqual([{ a: 1 }, { b: 2 }])
  })
  test("a length over the cap is an error", () => {
    const bad = Buffer.alloc(4)
    bad.writeUInt32LE(MAX_FRAME_BYTES + 1, 0)
    expect(() => createFrameDecoder().push(bad)).toThrow("[BRIDGE]")
    expect(() => encodeFrame({ text: "x".repeat(MAX_FRAME_BYTES) })).toThrow("[BRIDGE]")
  })
})

describe("tool calls become messages", () => {
  test("arguments map to port inputs and wire requests", () => {
    expect(userBrowserInput({ action: "open", url: "https://example.com/a" })).toEqual({ action: "open", url: "https://example.com/a" })
    expect(userBrowserInput({ action: "open", url: "file:///etc/passwd" })).toContain("only http and https")
    expect(userBrowserInput({ action: "allow_site", origin: "https://example.com/path?q=1" })).toEqual({ action: "allow_site", origin: "https://example.com" })
    expect(userBrowserInput({ action: "click", tabId: 3 })).toBe("click needs tabId and selector")
    expect(toWire({ action: "type", tabId: 3, selector: "#q", text: "hi", submit: true }, 7)).toEqual({ id: 7, op: "type", tabId: 3, selector: "#q", text: "hi", submit: true })
    expect(toWire({ action: "status" }, 1)).toBeUndefined()
  })
  test("looking is read, changing is execute", async () => {
    const tool = createUserBrowserTool({ port: { run: async () => ({ ok: true, text: "" }) } })
    expect(tool.permissionFor?.({ action: "status" } as never)).toBe("read")
    expect(tool.permissionFor?.({ action: "read" } as never)).toBe("read")
    for (const action of ["install", "allow_site", "open", "click", "type"]) expect(tool.permissionFor?.({ action } as never)).toBe("execute")
  })
})

describe("install", () => {
  test("writes the extension and one manifest per detected browser, only under the given dirs", () => {
    const { home, dataDir } = sandbox()
    const result = installUserBrowser({ dataDir, home, platform: "darwin", execPath: "/opt/mendcode" })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.browsers).toEqual(["Chrome", "Brave"])
    for (const file of result.written) expect(file.startsWith(home) || file.startsWith(dataDir)).toBe(true)
    const manifest = JSON.parse(readFileSync(path.join(home, "Library/Application Support/Google/Chrome/NativeMessagingHosts/com.mendcode.browser.json"), "utf8"))
    expect(manifest).toMatchObject({ name: "com.mendcode.browser", type: "stdio", path: bridgeFiles(dataDir).hostScript, allowed_origins: [`chrome-extension://${result.extensionId}/`] })
    const extension = JSON.parse(readFileSync(path.join(result.extensionDir, "manifest.json"), "utf8"))
    expect(extension.manifest_version).toBe(3)
    expect(extension.permissions).not.toContain("cookies")
    expect(extensionIdFor(Buffer.from(extension.key, "base64"))).toBe(result.extensionId)
    expect(result.extensionId).toMatch(/^[a-p]{32}$/)
    expect(readFileSync(bridgeFiles(dataDir).hostScript, "utf8")).toContain("/opt/mendcode")
    expect(statSync(bridgeFiles(dataDir).hostScript).mode & 0o111).not.toBe(0)
    expect(readReceipt(dataDir)?.manifests).toHaveLength(2)
    // The token the extension carries is the one the daemon checks.
    expect(JSON.parse(readFileSync(path.join(result.extensionDir, "config.json"), "utf8")).token).toBe(readReceipt(dataDir)?.token)
  })
  test("a second install keeps the extension id and token", () => {
    const { home, dataDir } = sandbox()
    const first = installUserBrowser({ dataDir, home, platform: "darwin" })
    const token = readReceipt(dataDir)?.token
    const second = installUserBrowser({ dataDir, home, platform: "darwin" })
    expect(first.ok && second.ok && first.extensionId === second.extensionId).toBe(true)
    expect(readReceipt(dataDir)?.token).toBe(token)
  })
  test("no browser profile folder: nothing is written", () => {
    const root = mkdtempSync(path.join(tmpdir(), "mendcode-bridge-"))
    roots.push(root)
    const result = installUserBrowser({ dataDir: path.join(root, "data"), home: path.join(root, "home"), platform: "darwin" })
    expect(result.ok).toBe(false)
    expect(existsSync(path.join(root, "data"))).toBe(false)
  })
  test("Windows is refused", () => {
    const { home, dataDir } = sandbox()
    expect(installUserBrowser({ dataDir, home, platform: "win32" }).ok).toBe(false)
  })
})

describe("site permissions", () => {
  test("open needs an allowed origin and tab operations need a tab MendCode opened", async () => {
    const { home, dataDir } = sandbox()
    const bridge = createUserBrowserBridge({ enabled: true, dataDir, home, platform: "darwin" })
    expect(await bridge.port().run({ action: "allow_site", origin: "https://a.test" }, signal)).toMatchObject({ ok: false })
    installUserBrowser({ dataDir, home, platform: "darwin" })
    expect(await bridge.port().run({ action: "open", url: "https://a.test/x" }, signal)).toMatchObject({ ok: false, error: expect.stringContaining("allow_site") })
    expect(await bridge.port().run({ action: "allow_site", origin: "https://a.test" }, signal)).toMatchObject({ ok: true })
    expect(await bridge.port().run({ action: "open", url: "https://b.test/" }, signal)).toMatchObject({ ok: false })
    expect(await bridge.port().run({ action: "open", url: "https://a.test/x" }, signal)).toMatchObject({ ok: false, error: expect.stringContaining("not connected") })
    expect(await bridge.port().run({ action: "read", tabId: 9 }, signal)).toMatchObject({ ok: false, error: expect.stringContaining("not one MendCode opened") })
    expect(createSiteStore(bridgeFiles(dataDir).sitesFile).allows("https://a.test/deep")).toBe(true)
    expect(createSiteStore(bridgeFiles(dataDir).sitesFile).allows("http://a.test/")).toBe(false)
  })
})

describe("disabled", () => {
  test("nothing listens, nothing is written, every action says it is off", async () => {
    const { home, dataDir } = sandbox()
    const bridge = createUserBrowserBridge({ enabled: false, dataDir, home, platform: "darwin" })
    bridge.start()
    expect(bridge.listening()).toBe(false)
    expect(await bridge.port().run({ action: "install" }, signal)).toMatchObject({ ok: false, error: expect.stringContaining("/tier browser_extension on") })
    expect(existsSync(dataDir)).toBe(false)
  })
  test("enabled but not installed still listens on nothing", () => {
    const { home, dataDir } = sandbox()
    const bridge = createUserBrowserBridge({ enabled: true, dataDir, home })
    bridge.start()
    expect(bridge.listening()).toBe(false)
  })
})

describe("bridge with a fake extension", () => {
  async function connect(socketPath: string, token: string) {
    const socket = net.connect(socketPath)
    await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject) })
    const decoder = createFrameDecoder()
    const inbox: Array<Record<string, unknown>> = []
    const waiters: Array<() => void> = []
    socket.on("data", (chunk: Buffer) => { inbox.push(...(decoder.push(chunk) as Array<Record<string, unknown>>)); waiters.splice(0).forEach((wake) => wake()) })
    const next = async () => {
      while (!inbox.length) await new Promise<void>((resolve) => waiters.push(resolve))
      return inbox.shift()!
    }
    socket.write(encodeFrame({ type: "hello", token, version: 1 }))
    return { socket, next }
  }

  test("a wrong token is dropped; the right one gets the allowed sites and answers requests", async () => {
    const { home, dataDir } = sandbox()
    const bridge = createUserBrowserBridge({ enabled: true, dataDir, home, platform: "darwin" })
    installUserBrowser({ dataDir, home, platform: "darwin" })
    bridge.start()
    await Bun.sleep(30)
    expect(bridge.listening()).toBe(true)
    const files = bridgeFiles(dataDir)
    expect((statSync(files.socket).mode & 0o077)).toBe(0)

    const bad = await connect(files.socket, "wrong")
    await new Promise<void>((resolve) => bad.socket.once("close", () => resolve()))

    const token = readReceipt(dataDir)!.token
    await bridge.port().run({ action: "allow_site", origin: "https://a.test" }, signal)
    const extension = await connect(files.socket, token)
    expect(await extension.next()).toEqual({ type: "sites", sites: ["https://a.test"] })

    const opening = bridge.port().run({ action: "open", url: "https://a.test/page" }, signal)
    const request = await extension.next()
    expect(request).toMatchObject({ op: "open", url: "https://a.test/page" })
    extension.socket.write(encodeFrame({ id: request.id, ok: true, data: { tabId: 5, url: "https://a.test/page", title: "A" } }))
    expect(await opening).toMatchObject({ ok: true, text: expect.stringContaining("tab 5") })

    const reading = bridge.port().run({ action: "read", tabId: 5 }, signal)
    const readRequest = await extension.next()
    extension.socket.write(encodeFrame({ id: readRequest.id, ok: true, data: { url: "https://a.test/page", title: "A", text: "hello" } }))
    const page = await reading
    expect(page.ok && page.text.includes("hello") && page.text.includes("untrusted web content")).toBe(true)

    const failing = bridge.port().run({ action: "click", tabId: 5, selector: "#x" }, signal)
    const clickRequest = await extension.next()
    extension.socket.write(encodeFrame({ id: clickRequest.id, ok: false, error: "no element matches #x" }))
    expect(await failing).toEqual({ ok: false, error: "extension: no element matches #x" })

    // Removing the site from MendCode's list stops operations on its tabs even though the tab is known.
    rmSync(files.sitesFile)
    expect(await bridge.port().run({ action: "read", tabId: 5 }, signal)).toMatchObject({ ok: false, error: expect.stringContaining("no longer an allowed site") })

    extension.socket.destroy()
    bridge.stop()
    expect(existsSync(files.socket)).toBe(false)
  })
})
