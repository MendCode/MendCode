import { afterEach, expect, test } from "bun:test"
import path from "node:path"
import { ideContext, ideSelectionKey } from "@mendcode/protocol/wire"
import { textWidth } from "../src/view/wrap"
import { B79_SELECTION, b79Harness } from "./b79-harness"
import { cleanTemps } from "./session-ui-harness"

const apps: Array<ReturnType<typeof b79Harness>> = []
afterEach(async () => { for (const app of apps.splice(0)) { await app.close(); await app.close() }; cleanTemps() })
function boot(options: Parameters<typeof b79Harness>[0] = {}) { const h = b79Harness(options); apps.push(h); return h }

test("incidental renders before settings do not start IDE discovery, and an off bridge schedules no background frame", async () => {
  let scheduled = 0
  const sent: string[] = []
  const { createApp } = await import("../src/ui/app")
  const { glyphs } = await import("../src/ui/theme")
  const app = createApp({ sessionId: "sess_ide_audit" as never, directory: "/work/project", exit() {}, glyphs: glyphs({}),
    screen: { size: { width: 100, height: 30 }, draw() {} } as never,
    schedule: () => { scheduled++ },
    send: async (command) => { sent.push(command.type); return { ok: true, ...(command.type === "ide.query" ? { result: { editor: "zed", enabled: false, status: "off" } } : {}) } },
  })
  app.render()
  await app.openSetupIfFirstRun({ onboarded: true })
  expect(sent).toEqual([])
  app.applySettings({ onboarded: true })
  await Bun.sleep(0)
  app.render()
  scheduled = 0
  await Bun.sleep(0)
  expect(sent.filter((type) => type === "ide.query")).toHaveLength(1)
  expect(scheduled).toBe(0)
  await app.onKey("\x03")
})

test("IDE page is off by default; Tab only completes; e opt-in and o open use daemon commands", async () => {
  const h = boot()
  await h.type("/ide\t")
  expect(h.sentOf("ide.configure")).toHaveLength(0)
  expect(h.text().join("\n")).not.toContain("Bridge: off")
  await h.type("\r")
  expect(h.text().join("\n")).toContain("Bridge: off")
  await h.app.onKey("e")
  expect(h.sentOf("ide.configure").at(-1)).toMatchObject({ enabled: true })
  expect(h.text().join("\n")).toContain("Editor context · pending")
  await h.app.onKey("o")
  expect(h.sentOf("ide.open").at(-1)).toMatchObject({ filePath: B79_SELECTION.filePath, line: 12, character: 1 })
  await h.app.onKey("e")
  expect(h.text().join("\n")).toContain("Bridge: off")
})

test("selected context is sent once, hides behind displayText and changes become pending", async () => {
  const h = boot()
  await h.type("/ide on\r")
  expect(h.text().join("\n")).toContain("auth.ts · pending")
  await h.type("fix this\r")
  expect(h.sentOf("user.submit").at(-1)).toMatchObject({ text: ideContext(B79_SELECTION) + "fix this", displayText: "fix this" })
  expect(h.text().join("\n")).toContain("auth.ts · sent")
  await h.type("next question\r")
  expect(h.sentOf("user.submit").at(-1)).toMatchObject({ text: "next question" })
  h.control.report.selection!.ranges[0]!.text = "changed unsaved code"
  await h.type("explain change\r")
  expect(h.sentOf("user.submit").at(-1)).toMatchObject({ text: expect.stringContaining("changed unsaved code"), displayText: "explain change" })
})

test("clear dismisses the current selection until it changes; off removes it immediately", async () => {
  const h = boot({ enabled: true })
  await h.type("/ide clear\r")
  expect(h.text().join("\n")).not.toContain("auth.ts · pending")
  await h.type("without context\r")
  expect(h.sentOf("user.submit").at(-1)).toMatchObject({ text: "without context" })
  h.control.report.selection!.ranges[0]!.selection.start.line++
  await h.type("/ide refresh\r")
  expect(h.text().join("\n")).toContain("auth.ts · pending")
  await h.type("/ide off\r")
  expect(h.text().join("\n")).not.toContain("auth.ts ·")
  await h.type("bridge disabled\r")
  expect(h.sentOf("user.submit").at(-1)).toMatchObject({ text: "bridge disabled" })
})

test("failed submissions preserve the draft and pending context; retry sends it", async () => {
  const h = boot({ enabled: true })
  h.control.submitError = true
  await h.type("fix this\r")
  expect(h.text().join("\n")).toContain("auth.ts · pending")
  expect(h.text().join("\n")).toContain("fix this")
  h.control.submitError = false
  await h.type("\r")
  expect(h.sentOf("user.submit").at(-1)).toMatchObject({ text: ideContext(B79_SELECTION) + "fix this" })
  expect(h.text().join("\n")).toContain("auth.ts · sent")
})

test("transient database failure retains preview but never submits stale contents", async () => {
  const h = boot({ enabled: true })
  await h.type("/ide\r")
  h.control.report = { editor: "zed", enabled: true, status: "unavailable", message: "Zed database cannot be read" }
  await h.app.onKey("r")
  expect(h.text().join("\n")).toContain("Zed database cannot be read")
  expect(h.text().join("\n")).toContain("authorize(token")
  await h.app.onKey("\x1b")
  await h.type("retry later\r")
  expect(h.sentOf("user.submit").at(-1)).toMatchObject({ text: "retry later" })
  h.control.report = { editor: "zed", enabled: true, status: "empty" }
  await h.type("/ide refresh\r")
  expect(h.text().join("\n")).not.toContain("auth.ts ·")
})

test("explicit database and open paths preserve spaces; open failures stay on the IDE page", async () => {
  const h = boot()
  await h.type('/ide on "/tmp/Zed data/db.sqlite"\r')
  expect(h.sentOf("ide.configure").at(-1)).toMatchObject({ dbPath: "/tmp/Zed data/db.sqlite" })
  await h.type('/ide open "src/a b.ts:9:4"\r')
  expect(h.sentOf("ide.open").at(-1)).toMatchObject({ filePath: "src/a b.ts", line: 9, character: 4 })
  await h.type("/ide\r")
  h.control.openError = true
  await h.app.onKey("o")
  expect(h.text().join("\n")).toContain("zed is not installed")
})

test("/ide on vscode picks the editor, a database path pins Zed, and the page names the editor", async () => {
  const h = boot()
  await h.type("/ide on vscode\r")
  expect(h.sentOf("ide.configure").at(-1)).toEqual(expect.objectContaining({ enabled: true, editor: "vscode" }))
  expect(h.sentOf("ide.configure").at(-1)).not.toHaveProperty("dbPath")
  await h.type("/ide on /tmp/zed.sqlite\r")
  expect(h.sentOf("ide.configure").at(-1)).toMatchObject({ editor: "zed", dbPath: "/tmp/zed.sqlite" })
  h.control.report = { ...h.control.report, editor: "vscode", selection: { ...h.control.report.selection!, source: "vscode" } }
  await h.type("/ide\r")
  expect(h.text().join("\n")).toContain("VS Code")
  h.control.openError = false
  await h.app.onKey("o")
  expect(h.text().join("\n")).toContain("Opened in VS Code")
})

test("late IDE replies cannot clear or submit an edited draft", async () => {
  const h = boot({ enabled: true })
  await h.type("/ide refresh\r")
  let resolve!: () => void
  h.control.queryGate = new Promise<void>((done) => { resolve = done })
  await h.type("first draft")
  const submit = h.app.onKey("\r")
  await Bun.sleep(1)
  await h.app.onKey("x")
  resolve()
  await submit
  expect(h.sentOf("user.submit")).toHaveLength(0)
  expect(h.text().join("\n")).toContain("first draftx")
})

test("remote clients do not query editor content or configure a local editor", async () => {
  const h = boot({ remote: true })
  await h.type("/ide on\r")
  for (const type of ["ide.query", "ide.configure", "ide.open"]) expect(h.sentOf(type)).toHaveLength(0)
  expect(h.text().join("\n")).toContain("IDE bridge is local only")
})

test("IDE page and context prompt stay bounded at all contracted terminal sizes", async () => {
  for (const [width, height] of [[60, 20], [100, 30], [160, 45], [180, 50], [220, 60]]) {
    const h = boot({ enabled: true, width, height })
    await h.type("/ide\r")
    const frame = h.frames.at(-1)!
    expect(frame).toHaveLength(height!)
    expect(frame.every((row) => textWidth(row.map((span) => span.text).join("")) <= width!)).toBe(true)
    expect(h.text().join("\n")).toContain("Context: pending")
    expect(h.text().join("\n")).toContain("auth.ts")
    await h.app.onKey("\x1b")
    expect(h.frames.at(-1)!.every((row) => textWidth(row.map((span) => span.text).join("")) <= width!)).toBe(true)
  }
})

test("fenced IDE text cannot close its context fence and selection identity includes text/positions", () => {
  const selection = structuredClone(B79_SELECTION)
  selection.ranges[0]!.text = "```ts\ncode\n```"
  expect(ideContext(selection)).toContain("\n````\n```ts")
  expect(ideSelectionKey(selection)).not.toBe(ideSelectionKey(B79_SELECTION))
})

test("IDE preview preserves code indentation, scrolls with a cue and clamps repeated navigation", async () => {
  const h = boot({ enabled: true, width: 60, height: 20 })
  await h.type("/ide\r")
  for (let index = 0; index < 100; index++) await h.app.onKey("\x1b[B")
  expect(h.text().join("\n")).toContain("authorize(request.token)")
  expect(h.text().join("\n")).toContain("█")
  await h.app.onKey("\x1b[A")
  expect(h.text().join("\n")).toContain("Range 2")
  const wide = boot({ enabled: true, width: 100, height: 30 })
  await wide.type("/ide\r")
  expect(wide.text().join("\n")).toContain("  return token.length")
})

test("IDE view is lazy; startup and page opening never load zod, daemon or protocol schemas", () => {
  const script = `await import("./src/ui/app"); const pages = await import("./src/ui/lazy-pages");
const loaded = () => Object.keys(require.cache).some((key) => key.endsWith("/view/ide-page.ts"));
const before = loaded(); await pages.preload("ide");
const keys = Object.keys(require.cache); console.log(JSON.stringify({ before, after: loaded(),
forbidden: keys.filter((key) => key.includes("/zod/") || key.includes("/packages/daemon/") || /protocol\\/src\\/(ide|commands|queries|events|frames)\\.ts$/.test(key)) }));`
  const result = Bun.spawnSync(["bun", "-e", script], { cwd: path.join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" })
  expect(result.exitCode).toBe(0)
  expect(result.stderr.toString()).toBe("")
  expect(JSON.parse(result.stdout.toString())).toEqual({ before: false, after: true, forbidden: [] })
})
