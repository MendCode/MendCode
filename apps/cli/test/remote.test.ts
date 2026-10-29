import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createIdFactory } from "@mendcode/protocol/wire"
import { parseRemoteFlags, parseTokenCommand, remoteTransport, REMOTE_DISABLED_NOTE, runTokenCommand } from "../src/remote"
import { parseAutomation } from "../src/automation"
import { createApp } from "../src/ui/app"
import { glyphs, type Line } from "../src/ui/theme"

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function tempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "mendcode-remote-cli-"))
  dirs.push(dir)
  return dir
}

test("transport parsing: loopback, IPv6, TLS defaults, CA, no insecure or token arguments", () => {
  expect(parseRemoteFlags(["--connect", "127.0.0.1:9876"]).remote).toEqual({ hostname: "127.0.0.1", port: 9876, tls: false })
  expect(parseRemoteFlags(["--connect", "[::1]:9876", "--tls"]).remote?.tls).toBe(true)
  expect(parseRemoteFlags(["--connect=server.example:443"]).remote?.tls).toBe(true)
  expect(parseRemoteFlags(["--connect", "localhost:443"]).remote?.tls).toBe(true)
  expect(parseRemoteFlags(["--connect", "127.0.0.1:9876", "--ca", "/custom.pem"]).remote).toMatchObject({ tls: true, caFile: "/custom.pem" })
  expect(parseRemoteFlags(["--socket", "/tmp/tunnel.sock"])).toEqual({ args: [], socketPath: "/tmp/tunnel.sock" })
  for (const args of [["--token", "secret"], ["--token=secret"], ["--insecure"], ["--ca", "x"], ["--connect"], ["--connect", "bad"], ["--connect", "host:0"], ["--socket", "x", "--tls"], ["--connect", "host:123", "--restart-daemon"]]) expect(() => parseRemoteFlags(args)).toThrow()
  const parsed = parseRemoteFlags(["--connect", "127.0.0.1:9876", "--token-file", "/private/token", "--dir", "/tmp/test", "session", "list", "--all"])
  expect(parseAutomation(parsed.args)).toMatchObject({ ok: true, command: { kind: "session.list", dir: "/tmp/test" } })
})

test("token source is env or file (file takes precedence); errors never contain token contents", () => {
  const dir = tempDir()
  const tokenFile = path.join(dir, "token")
  const caFile = path.join(dir, "ca.pem")
  writeFileSync(tokenFile, "file-secret\n", { mode: 0o600 })
  writeFileSync(caFile, "CA PEM")
  const envFlags = parseRemoteFlags(["--connect", "127.0.0.1:9876"]).remote!
  expect(remoteTransport(envFlags, { MENDCODE_TOKEN: "env-secret" }).token).toBe("env-secret")
  const fileFlags = parseRemoteFlags(["--connect", "host:9876", "--token-file", tokenFile, "--ca", caFile]).remote!
  expect(remoteTransport(fileFlags, { MENDCODE_TOKEN: "env-secret" })).toMatchObject({ token: "file-secret", ca: "CA PEM", tls: true })
  expect(() => remoteTransport(envFlags, {})).toThrow("MENDCODE_TOKEN or --token-file")
  expect(() => remoteTransport({ ...envFlags, tokenFile: path.join(dir, "absent") }, {})).toThrow("cannot read remote token file or CA")
})

test("token subcommand: explicit dir, create/list/revoke, no token or hash in list", async () => {
  const dir = tempDir()
  expect(() => parseTokenCommand(["remote", "token", "create"])).toThrow("explicit --dir")
  expect(parseTokenCommand(["session", "list"])).toBeUndefined()
  const command = parseTokenCommand(["remote", "token", "create", "--dir", dir, "--read-only", "--name", "viewer"])!
  expect(command).toEqual({ action: "create", dir, readOnly: true, name: "viewer" })
  let output = ""
  const out = { write: (text: string) => { output += text } }
  await runTokenCommand(command, out)
  const token = output.trim()
  expect(token.length).toBe(43)
  output = ""
  await runTokenCommand(parseTokenCommand(["remote", "token", "list", "--dir", dir])!, out)
  expect(output).toContain("viewer\tread-only")
  expect(output).not.toContain(token)
  const disk = JSON.parse(readFileSync(path.join(dir, "remote-tokens.json"), "utf8"))
  expect(output).not.toContain(disk[0].hash)
  await runTokenCommand(parseTokenCommand(["remote", "token", "revoke", "viewer", "--dir", dir])!, out)
  expect(JSON.parse(readFileSync(path.join(dir, "remote-tokens.json"), "utf8"))).toEqual([])
})

function harness(readOnly = false, width = 100) {
  const sent: Array<Record<string, unknown>> = []
  const frames: Line[][] = []
  let launched = false
  const screen = { size: { width, height: 24 }, draw: (rows: Line[]) => { frames.push(rows) }, write() {} } as unknown as Parameters<typeof createApp>[0]["screen"]
  const dataDir = tempDir()
  writeFileSync(path.join(dataDir, "keybindings.json"), JSON.stringify({ "ctrl+g": "editor.open" }))
  const app = createApp({
    sessionId: createIdFactory()("session"), screen, directory: "/remote/project", dataDir,
    remote: { host: "vps.example", readOnly }, notice: REMOTE_DISABLED_NOTE, reducedMotion: true,
    editorLauncher: async () => { launched = true; throw new Error("must not launch") },
    send: async (command) => {
      sent.push(command)
      if (command.type === "files.search") return { ok: true, result: { files: [{ path: "src/remote.ts", kind: "file" }] } }
      if (command.type === "session.list") return { ok: true, result: { sessions: [] } }
      return { ok: true }
    },
    exit() {}, schedule: (fn) => fn(), glyphs: glyphs({}), now: () => 1_800_000_000_000,
  })
  return { app, sent, launched: () => launched, text: () => frames.at(-1)?.map((row) => row.map((s) => s.text).join("")).join("\n") ?? "" }
}
async function type(app: ReturnType<typeof createApp>, text: string) { for (const key of text) await app.onKey(key) }

test("remote app disables attachments, clipboard, editor and export files with notes", async () => {
  const h = harness()
  await type(h.app, "/attach /tmp/local.png")
  await h.app.onKey("\r")
  expect(h.text()).toContain("path attachments disabled while remote")
  await h.app.onKey("\x16")
  expect(h.text()).toContain("clipboard images disabled while remote")
  await h.app.onKey("\x18")
  await h.app.onKey("e")
  expect(h.text()).toContain("external editor disabled while remote")
  expect(h.launched()).toBe(false)
  await h.app.onKey("\x03")
  await type(h.app, "/export markdown")
  await h.app.onKey("\r")
  expect(h.text()).toContain("remote export needs --copy")
  expect(h.sent.some((c) => String(c.type).startsWith("attachment."))).toBe(false)
  expect(h.sent.some((c) => c.type === "session.export")).toBe(false)
  await type(h.app, "/export")
  await h.app.onKey("\r")
  expect(h.text()).toContain("Export Options")
  expect(h.text()).toContain("Destination: clipboard")
  expect(h.text()).not.toContain("remote export needs --copy")
  expect(h.launched()).toBe(false)
})

test("remote mentions stay daemon-side; topbar and home report the host and scope", async () => {
  for (const readOnly of [false, true]) {
    const h = harness(readOnly)
    await type(h.app, "@src")
    await Bun.sleep(0)
    expect(h.sent).toContainEqual({ type: "files.search", directory: "/remote/project", query: "src", limit: 50 })
    expect(h.text()).toContain("remote vps.example")
    if (readOnly) expect(h.text()).toContain("read-only")
    expect(h.text()).toContain("@src/remote.ts")
  }
})

test("remote parsing and token administration stay outside the startup schema graph", () => {
  const probe = Bun.spawnSync(["bun", "-e", 'await import("./src/remote"); console.log(JSON.stringify(Object.keys(require.cache).filter((k) => k.includes("/zod/") || /protocol\\/src\\/(frames|commands|queries|events)\\.ts$/.test(k))))'], { cwd: path.join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" })
  expect(probe.exitCode).toBe(0)
  expect(JSON.parse(probe.stdout.toString())).toEqual([])
})


test("remote workflow files are blocked and the supplied local keybinding file is ignored", async () => {
  const h = harness()
  await h.app.onKey("\x07")
  expect(h.launched()).toBe(false)
  await h.app.onKey("\x03")
  await type(h.app, "/workflows plan.json")
  await h.app.onKey("\r")
  expect(h.text()).toContain("workflow files disabled while remote")
  expect(h.sent.some((c) => c.type === "workflow.preview")).toBe(false)
  expect(REMOTE_DISABLED_NOTE).toContain("TUI extensions")
  expect(REMOTE_DISABLED_NOTE).toContain("local TUI files")
})


test("remote goal-file editing is blocked before reading the local file", async () => {
  const h = harness()
  const file = path.join(tempDir(), "objective.md")
  writeFileSync(file, "local objective must never be loaded")
  const sessionId = h.app.sessionId
  h.app.onEvent({ sessionId, seq: 1, at: 1_800_000_000_000, type: "goal.changed", change: "created", by: "user", goal: { goalId: createIdFactory()("goal"), sessionId, objective: "remote objective", objectiveFile: file, status: "active", tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1 } })
  await type(h.app, "/goal edit")
  await h.app.onKey("\r")
  expect(h.text()).toContain("goal file editing disabled while remote")
  expect(h.app.editor.text).not.toContain("local objective")
})
