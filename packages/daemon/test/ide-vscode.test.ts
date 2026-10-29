import { afterEach, expect, mock, test } from "bun:test"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { startDaemon } from "../src"
import { createIdeBridge } from "../src/ide"
import { readVscodeSelection, vscodeLauncher, VSCODE_STALE_MS } from "../src/ide-vscode"

type Range = { text: string; start: { line: number; character: number }; end: { line: number; character: number } }
type BridgeLib = {
  bridgeFile(dataDir: string, workspace: string): string
  buildRecord(input: { app?: string; workspace: string; filePath?: string; ranges?: Range[]; now: number }): Record<string, unknown>
  writeRecord(file: string, record: Record<string, unknown>): void
  removeRecord(file: string): void
  mention(relativePath: string, range?: { start: number; end: number }): string
}
const require = createRequire(import.meta.url)
const extensionDir = path.resolve(import.meta.dir, "../../../editors/vscode")
const lib = require(path.join(extensionDir, "lib/bridge.js")) as BridgeLib

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
function fixture() {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mend-vscode-")))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const directory = path.join(dir, "project")
  mkdirSync(directory)
  const file = path.join(directory, "app.ts")
  writeFileSync(file, "const a = 1\nconst b = 2\n")
  const cursor = (line: number, character: number) => ({ line, character })
  const publish = (overrides: { workspace?: string; filePath?: string; ranges?: Range[]; now?: number; app?: string } = {}) => {
    const workspace = overrides.workspace ?? directory
    lib.writeRecord(lib.bridgeFile(dir, workspace), lib.buildRecord({ app: overrides.app ?? "Visual Studio Code", workspace, filePath: overrides.filePath ?? file,
      ranges: overrides.ranges ?? [{ text: "const b = 2", start: cursor(1, 0), end: cursor(1, 11) }], now: overrides.now ?? Date.now() }))
  }
  return { dir, directory, file, publish, cursor }
}

test("what the extension publishes is what the daemon reads: one-based ranges, project file, source vscode", async () => {
  const h = fixture()
  h.publish()
  expect(await readVscodeSelection(h.dir, h.directory)).toEqual({ status: "connected", selection: { filePath: h.file, source: "vscode", ranges: [
    { text: "const b = 2", selection: { start: { line: 2, character: 1 }, end: { line: 2, character: 12 } } },
  ] } })
  const files = readdirSync(path.join(h.dir, "ide", "vscode"))
  expect(files).toHaveLength(1)
  expect(statSync(path.join(h.dir, "ide", "vscode", files[0]!)).mode & 0o777).toBe(0o600)
})

test("missing publisher, other projects, heartbeat-only records and stale records are explicit", async () => {
  const h = fixture()
  expect(await readVscodeSelection(h.dir, h.directory)).toMatchObject({ status: "unavailable", message: expect.stringContaining("extension") })
  h.publish({ ranges: [], filePath: undefined as never })
  expect(await readVscodeSelection(h.dir, h.directory)).toEqual({ status: "empty" })
  expect(await readVscodeSelection(h.dir, path.join(h.dir, "elsewhere"))).toEqual({ status: "empty" })
  h.publish({ now: 1_000 })
  expect(await readVscodeSelection(h.dir, h.directory, 1_000 + VSCODE_STALE_MS + 1)).toMatchObject({ status: "unavailable", message: expect.stringContaining("stopped publishing") })
  expect((await readVscodeSelection(h.dir, h.directory, 1_000 + VSCODE_STALE_MS)).status).toBe("connected")
})

test("a file outside the project, an escaping symlink and an unsaved buffer never attach", async () => {
  const h = fixture()
  const outside = path.join(h.dir, "outside.ts")
  writeFileSync(outside, "private")
  h.publish({ filePath: outside })
  expect(await readVscodeSelection(h.dir, h.directory)).toEqual({ status: "empty" })
  symlinkSync(outside, path.join(h.directory, "link.ts"))
  h.publish({ filePath: path.join(h.directory, "link.ts") })
  expect(await readVscodeSelection(h.dir, h.directory)).toEqual({ status: "empty" })
  h.publish({ filePath: path.join(h.directory, "unsaved.ts") })
  expect(await readVscodeSelection(h.dir, h.directory)).toEqual({ status: "empty" })
})

test("oversized selections and range counts fail explicitly, corrupt files are ignored", async () => {
  const h = fixture()
  const cursor = h.cursor(0, 0)
  h.publish({ ranges: [{ text: "x".repeat(33_000), start: cursor, end: h.cursor(0, 5) }] })
  expect(await readVscodeSelection(h.dir, h.directory)).toMatchObject({ status: "unavailable", message: expect.stringContaining("32 KiB") })
  h.publish({ ranges: Array.from({ length: 65 }, () => ({ text: "", start: cursor, end: cursor })) })
  expect(await readVscodeSelection(h.dir, h.directory)).toMatchObject({ status: "unavailable", message: expect.stringContaining("64 ranges") })
  writeFileSync(path.join(h.dir, "ide", "vscode", "broken.json"), "{")
  expect(await readVscodeSelection(h.dir, h.directory)).toMatchObject({ status: "unavailable" })
  rmSync(path.join(h.dir, "ide", "vscode", "broken.json"))
  h.publish({ ranges: [{ text: "x".repeat(2_000_000), start: cursor, end: h.cursor(0, 5) }] })
  // Past 1 MiB the extension drops the text and publishes the open file only.
  expect(await readVscodeSelection(h.dir, h.directory)).toMatchObject({ status: "connected", selection: { ranges: [{ text: "" }] } })
})

test("the most specific workspace wins over a newer broad one; a nested workspace folder still matches", async () => {
  const h = fixture()
  const sub = path.join(h.directory, "pkg")
  mkdirSync(sub)
  const nested = path.join(sub, "inner.ts")
  writeFileSync(nested, "inner")
  h.publish({ workspace: h.dir, filePath: h.file, now: Date.now() })
  h.publish({ workspace: h.directory, filePath: nested, ranges: [{ text: "inner", start: h.cursor(0, 0), end: h.cursor(0, 5) }], now: Date.now() - 5_000 })
  expect((await readVscodeSelection(h.dir, h.directory)).selection?.filePath).toBe(nested)
  h.publish({ workspace: sub, filePath: nested, ranges: [{ text: "inner", start: h.cursor(0, 0), end: h.cursor(0, 5) }] })
  expect((await readVscodeSelection(h.dir, h.directory)).selection?.filePath).toBe(nested)
})

test("launcher follows the editor family", () => {
  expect([vscodeLauncher("Visual Studio Code"), vscodeLauncher("Cursor"), vscodeLauncher("VSCodium"), vscodeLauncher("Windsurf"), vscodeLauncher("Visual Studio Code - Insiders"), vscodeLauncher(undefined)])
    .toEqual(["code", "cursor", "codium", "windsurf", "code-insiders", "code"])
})

test("bridge: vscode is opt-in, persisted privately, drops a Zed database path and opens through its own adapter", async () => {
  const h = fixture()
  const opened: Array<[string, string, number, number]> = []
  const zed = { selection: async () => ({ status: "empty" as const }), open: async () => ({ opened: true }) }
  const bridge = createIdeBridge(h.dir, { ...zed, vscode: { selection: (directory) => readVscodeSelection(h.dir, directory), open: async (directory, file, line, character) => { opened.push([directory, file, line, character]); return { opened: true } } } })
  h.publish()
  expect(await bridge.query(h.directory)).toEqual({ editor: "zed", enabled: false, status: "off" })
  await bridge.configure(h.directory, true, "/tmp/zed.sqlite")
  expect(await bridge.configure(h.directory, true, undefined, "vscode")).toMatchObject({ editor: "vscode", enabled: true, status: "connected", selection: { source: "vscode" } })
  const config = readdirSync(path.join(h.dir, "ide")).find((name) => name.endsWith(".json"))!
  const stored = JSON.parse(readFileSync(path.join(h.dir, "ide", config), "utf8"))
  expect(stored).toEqual({ enabled: true, editor: "vscode" })
  expect(readFileSync(path.join(h.dir, "ide", config), "utf8")).not.toContain("const b")
  expect(await bridge.open(h.directory, "app.ts", 2, 3)).toEqual({ opened: true })
  expect(opened).toEqual([[h.directory, h.file, 2, 3]])
  expect(await bridge.open(h.directory, "../outside.ts")).toMatchObject({ opened: false })
  await expect(bridge.configure(h.directory, true, "/tmp/zed.sqlite", "vscode")).rejects.toThrow("only applies to Zed")
  expect(await bridge.configure(h.directory, false)).toEqual({ editor: "vscode", enabled: false, status: "off" })
  expect(await bridge.configure(h.directory, true, undefined, "zed")).toMatchObject({ editor: "zed", status: "empty" })
})

test("typed client reaches the vscode adapter through the real daemon, local only", async () => {
  const h = fixture()
  h.publish()
  const daemon = await startDaemon({ dir: h.dir, socketPath: path.join(h.dir, "daemon.sock"), engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }) })
  cleanups.push(() => daemon.stop())
  const client = createClient({ socketPath: daemon.socketPath, name: "vscode-test", reconnect: false })
  await client.connect()
  cleanups.push(() => client.close())
  expect(await client.configureIde(h.directory, true, undefined, "vscode")).toMatchObject({ ok: true, report: { editor: "vscode", status: "connected", selection: { filePath: h.file, source: "vscode" } } })
  expect(await client.ideContext(h.directory)).toMatchObject({ ok: true, report: { editor: "vscode", selection: { ranges: [{ text: "const b = 2" }] } } })
})

// The extension itself, against a fake `vscode` module: no editor, no terminal process, temp data dir.
function fakeVscode(dataDir: string, workspace: string, file: string, shareContext: boolean) {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const listeners: Array<(...args: unknown[]) => unknown> = []
  const sent: Array<{ name: string; text: string; submit: boolean }> = []
  const created: Array<Record<string, unknown>> = []
  const messages: string[] = []
  const config: Record<string, unknown> = { command: "mendcode", args: [], dataDir, terminalLocation: "panel", shareContext }
  const pos = (line: number, character: number) => ({ line, character })
  const selection = { isEmpty: false, start: pos(2, 4), end: pos(5, 0) }
  const document = { uri: { scheme: "file", fsPath: file }, isUntitled: false, isClosed: false, getText: () => "picked text" }
  const editor = { document, selection, selections: [selection] }
  const subscribe = () => { const sub = (listener: (...args: unknown[]) => unknown) => { listeners.push(listener); return { dispose() {} } }; return sub }
  const terminals: Array<{ name: string; exitStatus: undefined; show(): void; sendText(text: string, submit: boolean): void }> = []
  const vscode = {
    workspace: {
      workspaceFolders: [{ uri: { scheme: "file", fsPath: workspace } }],
      getConfiguration: () => ({ get: (key: string) => config[key], update: async (key: string, value: unknown) => { config[key] = value } }),
      getWorkspaceFolder: (uri: { fsPath: string }) => uri.fsPath.startsWith(workspace) ? { uri: { scheme: "file", fsPath: workspace } } : undefined,
      onDidChangeWorkspaceFolders: subscribe(), onDidCloseTextDocument: subscribe(), onDidChangeConfiguration: subscribe(),
    },
    window: {
      activeTextEditor: editor, visibleTextEditors: [editor], terminals,
      createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
      createStatusBarItem: () => ({ show() {}, dispose() {}, text: "", tooltip: "", command: "" }),
      createTerminal: (options: Record<string, unknown>) => {
        created.push(options)
        const terminal = { name: String(options.name), exitStatus: undefined, show() {}, sendText(text: string, submit: boolean) { sent.push({ name: terminal.name, text, submit }) } }
        terminals.push(terminal)
        return terminal
      },
      showWarningMessage: (message: string) => { messages.push(message) }, showInformationMessage: (message: string) => { messages.push(message) },
      showQuickPick: async () => undefined,
      onDidChangeTextEditorSelection: subscribe(), onDidChangeActiveTextEditor: subscribe(),
    },
    commands: { registerCommand: (name: string, handler: (...args: unknown[]) => unknown) => { handlers.set(name, handler); return { dispose() {} } } },
    languages: { getDiagnostics: () => [{ severity: 0, range: { start: pos(3, 0) }, message: "Type 'string'\nis not assignable" }, { severity: 3, range: { start: pos(4, 0) }, message: "hint" }] },
    env: { appName: "Cursor" },
    StatusBarAlignment: { Right: 2 }, TerminalLocation: { Panel: 1, Editor: 2 }, ConfigurationTarget: { Global: 1 }, DiagnosticSeverity: { Error: 0, Warning: 1 },
  }
  return { vscode, handlers, listeners, sent, created, messages, config, terminals }
}

test("extension: publishes only with shareContext, mentions go into the prompt unsent, shell-free terminal, cleanup on dispose", async () => {
  const h = fixture()
  const fake = fakeVscode(h.dir, h.directory, h.file, false)
  mock.module("vscode", () => fake.vscode)
  const extensionPath = path.join(extensionDir, "extension.js")
  delete require.cache[extensionPath]
  const extension = require(extensionPath) as { activate(context: { subscriptions: Array<{ dispose(): void }> }): void }
  const context = { subscriptions: [] as Array<{ dispose(): void }> }
  cleanups.push(() => { for (const item of context.subscriptions) item.dispose() })
  extension.activate(context)
  const published = path.join(h.dir, "ide", "vscode")
  expect(() => readdirSync(published)).toThrow()
  expect([...fake.handlers.keys()].sort()).toEqual(["mendcode.addFile", "mendcode.addSelection", "mendcode.connect", "mendcode.controlCenter", "mendcode.fixProblems", "mendcode.newSession", "mendcode.open", "mendcode.toggleShare"])

  fake.handlers.get("mendcode.addSelection")!()
  expect(fake.created[0]).toMatchObject({ name: "MendCode", cwd: h.directory, shellPath: "mendcode", shellArgs: ["--dir", h.dir] })
  await Bun.sleep(1_600)
  expect(fake.sent).toEqual([{ name: "MendCode", text: "@app.ts?start=3&end=5 ", submit: false }])
  fake.handlers.get("mendcode.addFile")!({ scheme: "file", fsPath: path.join(h.directory, "my dir", "a b.ts") })
  fake.handlers.get("mendcode.fixProblems")!()
  expect(fake.sent[1]).toEqual({ name: "MendCode", text: '@"my dir/a b.ts" ', submit: false })
  expect(fake.sent[2]).toEqual({ name: "MendCode", text: "Fix these problems in @app.ts: line 4: Type 'string' is not assignable", submit: false })
  expect(fake.created).toHaveLength(1)

  await fake.handlers.get("mendcode.connect")!()
  expect(fake.config.shareContext).toBe(true)
  expect(fake.sent[3]).toEqual({ name: "MendCode", text: "/ide on vscode", submit: false })
  expect(await readVscodeSelection(h.dir, h.directory)).toMatchObject({ status: "connected", selection: { source: "vscode", filePath: h.file, ranges: [{ text: "picked text", selection: { start: { line: 3, character: 5 } } }] } })
  for (const item of context.subscriptions.splice(0)) item.dispose()
  expect(readdirSync(published)).toEqual([])
})
