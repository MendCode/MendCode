import { afterEach, expect, test } from "bun:test"
import { existsSync, linkSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { createNativeEngine, memoryHistory } from "@mendcode/engine-native"
import type { SessionId } from "@mendcode/protocol"
import { tuiProblems } from "@mendcode/protocol/wire"
import { appHarness, scratch } from "../../../apps/cli/test/extensions-harness"
import { examples } from "../../../apps/cli/test/fixtures/ui10-examples"
import { callTool, scriptedProvider, stop, turn } from "../../engine-native/test/harness"
import { createCustomizeUiTool, createUiReload, CustomizeUiArgs, outsideProject, writeUiExtension } from "../src/customize-ui"
import { startDaemon } from "../src/daemon"
import { budgetMs } from "../../../scripts/test-budget"

const cleanups: Array<() => unknown> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
function sandbox() { const temp = scratch(); cleanups.push(temp.cleanup); return temp }
const pending = async () => ({ revision: 1, errors: [], terminalValidation: "pending" as const })
const context = (cwd: string) => ({ cwd, signal: new AbortController().signal })
/**
 * `again` repeats the action every 250 ms: macOS starts a native watch on another thread, so a write made right after arming can
 * precede it. Slower than the reload debounce (80 ms, restarted by every event), or the repeats would keep postponing the reload.
 */
async function until(predicate: () => boolean, again?: () => void) {
  const end = Date.now() + budgetMs(2000)
  let last = Date.now()
  while (!predicate() && Date.now() < end) {
    if (again && Date.now() - last >= 250) { again(); last = Date.now() }
    await Bun.sleep(5)
  }
  expect(predicate()).toBe(true)
}

test("customize_ui confines writes and literal edits to flat user extension files", async () => {
  const temp = sandbox()
  const tool = createCustomizeUiTool(temp.dataDir, pending, () => {})
  expect(tool.permission).toBe("write")
  expect(tool.description).toContain("api.renderMessage")
  for (const file of ["../escape.ts", "/tmp/escape.ts", "nested/look.ts", "a\\b.ts", "x.d.ts", ".hidden.ts", "look.json"]) {
    expect(() => writeUiExtension(temp.dataDir, file, "code")).toThrow()
  }
  const target = writeUiExtension(temp.dataDir, "look.ts", "export default {name:'first'}")
  writeUiExtension(temp.dataDir, "look.ts", "", { old: "first", new: "second" })
  expect(readFileSync(target, "utf8")).toContain("second")
  expect(() => writeUiExtension(temp.dataDir, "look.ts", "", { old: "missing", new: "bad" })).toThrow("exactly once")
  expect(() => writeUiExtension(temp.dataDir, "absent.ts", "", { old: "old", new: "new" })).toThrow("missing")
  expect(() => writeUiExtension(temp.dataDir, "huge.ts", "🌱".repeat(20000))).toThrow("64 KiB")
  expect(CustomizeUiArgs.safeParse({ action: "settings", values: { injected: true } }).success).toBe(false)
  expect(tuiProblems(JSON.parse('{"__proto__":{"username":"Wrong"}}'))).toEqual([expect.stringMatching(/^unknown field: __proto__[;( ]/)])
  expect(CustomizeUiArgs.parse({ action: "settings", values: JSON.parse('{"__proto__":{"username":"Wrong"}}') })).toEqual({ action: "settings", values: {} })
  const invalid = await tool.execute({ action: "settings", values: { messageRenderer: "bad" } }, context(temp.project))
  expect(invalid.isError).toBe(true)
  expect(existsSync(path.join(temp.dataDir, "tui/profile.json"))).toBe(false)
  const projectTool = createCustomizeUiTool(temp.project, pending, () => {})
  expect((await projectTool.execute({ action: "write", file: "bad.ts", content: "code" }, context(temp.project))).isError).toBe(true)
  expect(existsSync(path.join(temp.project, "extensions"))).toBe(false)
})

test("symlinks, dangling links and hardlinks cannot redirect extension or settings writes", async () => {
  for (const kind of ["directory", "file", "dangling", "hardlink", "profile"] as const) {
    const temp = sandbox()
    const outside = temp.write("project/outside.ts", "untouched")
    if (kind === "directory") symlinkSync(temp.project, path.join(temp.dataDir, "extensions"))
    else if (kind === "profile") {
      mkdirSync(path.join(temp.dataDir, "tui"))
      symlinkSync(outside, path.join(temp.dataDir, "tui/profile.json"))
    } else {
      mkdirSync(path.join(temp.dataDir, "extensions"))
      const target = path.join(temp.dataDir, "extensions/look.ts")
      if (kind === "hardlink") linkSync(outside, target)
      else symlinkSync(kind === "dangling" ? outside + ".missing" : outside, target)
    }
    const tool = createCustomizeUiTool(temp.dataDir, pending, () => {})
    const action = kind === "profile" ? { action: "settings" as const, values: { username: "Look" } } : { action: "write" as const, file: "look.ts", content: "changed" }
    expect((await tool.execute(action, context(temp.project))).isError).toBe(true)
    expect(readFileSync(outside, "utf8")).toBe("untouched")
  }
})

test("reload reports terminal errors, supports correction and marks an unattached terminal pending", async () => {
  const temp = sandbox()
  const client = {}
  let errors = ["look: bad renderer"]
  const service = createUiReload({ dir: temp.dataDir, load: async () => [], emit: (event) => {
    if (event.type === "extensions.changed") service.report(client, event.revision, errors)
  } })
  cleanups.push(service.stop)
  service.report(client, 0, [])
  expect(await service.reload(temp.project)).toMatchObject({ terminalValidation: "complete", errors })
  errors = []
  expect(await service.reload(temp.project)).toMatchObject({ terminalValidation: "complete", errors: [] })
  service.forget(client)
  expect(await service.reload(temp.project)).toMatchObject({ terminalValidation: "pending" })
})

test("daemon watcher reloads added and edited modules without watching from the terminal", async () => {
  const temp = sandbox()
  let changes = 0
  const service = createUiReload({ dir: temp.dataDir, load: async () => [], emit: () => { changes++ } })
  cleanups.push(service.stop)
  service.start()
  writeUiExtension(temp.dataDir, "look.ts", "export default {name:'look'}")
  await until(() => changes > 0, () => writeUiExtension(temp.dataDir, "look.ts", "export default {name:'look'}"))
  await Bun.sleep(200)
  const before = changes
  writeFileSync(path.join(temp.dataDir, "extensions/look.ts"), "export default {name:'edited'}")
  await until(() => changes > before)
  const exported = await service.exportLook(temp.project)
  expect(exported.file).toStartWith(path.join(temp.dataDir, "extensions/look-"))
  expect(readFileSync(exported.file, "utf8")).toContain("api.settings.set")
})

test("the real native writing gate denies customize_ui before execution and returns its contract to the model", async () => {
  const temp = sandbox()
  const tool = createCustomizeUiTool(temp.dataDir, pending, () => {})
  for (const mode of ["ask", "plan"] as const) {
    const { provider, requests } = scriptedProvider([callTool("customize_ui", { action: "write", file: "look.ts", content: examples.messages }), stop("Denied")])
    const engine = createNativeEngine({ provider, tools: [tool], history: memoryHistory(), cwdFor: () => temp.project, system: () => "test", compactionPrompt: "test" })
    const input = turn({ text: "make my messages look like Matrix", mode: () => mode })
    await engine.runTurn(input.input)
    expect(existsSync(path.join(temp.dataDir, "extensions/look.ts"))).toBe(false)
    expect(requests[0]?.tools[0]?.description).toContain("api.settings.set")
    expect(input.asked.length).toBe(mode === "ask" ? 1 : 0)
  }
})

test("faux agent requests write a look, live-reload chat, get errors and repair their extension end to end", async () => {
  const temp = sandbox()
  let result = ""
  let done = 0
  const daemon = await startDaemon({ dir: temp.dataDir, socketPath: path.join(temp.dataDir, "daemon.sock"), engine: ({ clock, extensions, emitGlobal }) => {
    const faux = createFauxEngine({ clock, deltaMs: 1 })
    const tool = createCustomizeUiTool(temp.dataDir, extensions.reload, emitGlobal)
    return { ...faux, async runTurn(input) {
      const args = input.text.includes("metadata") ? { action: "settings" as const, values: { messageMeta: "off" as const, userIcon: "◆" } } : input.text.includes("footer") ? { action: "write" as const, file: "footer.ts", content: examples.footer } : input.text.includes("repair") ? { action: "edit" as const, file: "look.ts", old: 'throw Error("fix me")', new: examples.messages.match(/tui\(api\) \{([\s\S]*)\n  \},/)![1]! } : { action: "write" as const, file: "look.ts", content: 'export default {name:"matrix-messages",tui(api){throw Error("fix me")}}' }
      if (input.permissionMode() === "plan") return { status: "ok" }
      const answer = await input.ask({ kind: "approval", title: "customize_ui", detail: "Write user UI extension" })
      if (answer.kind !== "approve") return { status: "ok" }
      result = (await tool.execute(args, context(temp.project))).output
      const outcome = await faux.runTurn({ ...input, text: result })
      done++
      return outcome
    } }
  } })
  cleanups.push(() => daemon.stop())
  let harness: Awaited<ReturnType<typeof appHarness>> | undefined
  const client = createClient({ socketPath: daemon.socketPath, name: "UI-10", onGlobal: (event) => harness?.app.onGlobal(event), onEvent: (event) => {
    harness?.app.onEvent(event)
    if (event.type === "server.request") void client.send({ type: "request.resolve", sessionId: event.sessionId, requestId: event.requestId, decision: { kind: "approve", scope: "once" } })
  } })
  cleanups.push(() => client.close())
  await client.connect()
  const created = await client.send({ type: "session.create", directory: temp.project, title: "UI-10" })
  if (!created.ok) throw new Error(created.error.message)
  const sessionId = created.result?.sessionId as SessionId
  harness = await appHarness({ sessionId, dataDir: temp.dataDir, directory: temp.project, reply: (command) => client.send(command as never) })
  await harness.start({ onboarded: true })
  await client.subscribe(sessionId, 0)
  expect((await client.send({ type: "session.permission.set", sessionId, mode: "ask" })).ok).toBe(true)
  for (const [index, text] of ["remove message metadata", "make my messages look like Matrix", "repair the returned error", "put the time and branch in my footer"].entries()) {
    expect((await client.send({ type: "user.submit", sessionId, text, attachments: [] })).ok).toBe(true)
    await until(() => done > index)
    const report = JSON.parse(result)
    expect(report.terminalValidation).toBe("complete")
    if (index === 1) expect(report.errors.join("\n")).toContain("fix me")
    else expect(report.errors).toEqual([])
  }
  await harness.app.extensionsReady
  harness.app.render()
  expect(harness.text()).toContain("UTC")
  expect(harness.text()).toContain("MEND · Matrix workspace")
  expect(JSON.parse(readFileSync(path.join(temp.dataDir, "tui/profile.json"), "utf8"))).toMatchObject({ messageMeta: "off", userIcon: "◆" })
  await harness.key("\x1b"); await harness.key("\x03"); await harness.key("\x03")
})

test("a session in the home folder may customize the UI; a project that holds the data directory may not", () => {
  const dir = sandbox().dataDir
  const home = path.join(dir, "home"), data = path.join(home, ".data"), project = path.join(home, "code", "app"), nested = path.join(project, ".data")
  for (const folder of [data, nested]) mkdirSync(folder, { recursive: true })
  expect(() => outsideProject(data, home, home)).not.toThrow()
  expect(() => outsideProject(data, dir, home)).not.toThrow()
  expect(() => outsideProject(data, project, home)).not.toThrow()
  expect(() => outsideProject(nested, project, home)).toThrow("outside the project directory")
})

test("keys: a few words for a part return its keys, with what each changes and the values now, and never ask for approval", async () => {
  const temp = sandbox()
  const tool = createCustomizeUiTool(temp.dataDir, pending, () => {})
  expect(tool.permissionFor?.({ action: "keys", query: "footer" })).toBe("read")
  expect(tool.permissionFor?.({ action: "settings", values: {} })).toBe("write")
  await tool.execute({ action: "settings", values: { showStatus: false } }, context(temp.project))
  const found = JSON.parse((await tool.execute({ action: "keys", query: "footer" }, context(temp.project))).output)
  expect(found.keys[0]).toMatchObject({ key: "showStatus", type: "boolean", default: true, now: false })
  expect(found.keys[0].what).toContain("footer")
  const all = JSON.parse((await tool.execute({ action: "keys" }, context(temp.project))).output)
  expect(all.names).toContain("showTopbar")
  expect(all.names).toContain("sidebarHeader")
  const none = JSON.parse((await tool.execute({ action: "keys", query: "qqqq" }, context(temp.project))).output)
  expect(none.none).toContain("qqqq")
  // In ask mode a lookup runs without a prompt; a change still asks.
  const { provider } = scriptedProvider([callTool("customize_ui", { action: "keys", query: "top bar" }), callTool("customize_ui", { action: "settings", values: { showTopbar: false } }), stop("done")])
  const engine = createNativeEngine({ provider, tools: [tool], history: memoryHistory(), cwdFor: () => temp.project, system: () => "test", compactionPrompt: "test" })
  const input = turn({ text: "remove the bar above the session", mode: () => "ask" })
  await engine.runTurn(input.input)
  expect(input.asked.length).toBe(1)
})

test("the description says what the tool is for before the extension contract, and fits a tool_search result whole", () => {
  const tool = createCustomizeUiTool(sandbox().dataDir, pending, () => {})
  // It is in every balanced and full request: about 1,600 characters and the schema are its whole cost (docs/tool-discovery.md).
  expect(tool.description.length).toBeLessThanOrEqual(1600)
  expect(tool.description).toStartWith("Change what the user sees in this MendCode terminal")
  expect(tool.description.indexOf("keys:")).toBeLessThan(tool.description.indexOf("Contract:"))
  expect(tool.description).toContain("never tell the user to do it")
  expect(tool.description).toContain("docs extensions")
})
