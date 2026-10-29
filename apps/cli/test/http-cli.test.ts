import { afterEach, expect, test } from "bun:test"
import { existsSync, writeFileSync } from "node:fs"
import path from "node:path"
import { HTTP_USAGE, normalizeAttach, parseServerCommand } from "../src/http-cli"
import { parseRemoteFlags, remoteTransport } from "../src/remote"
import { parseStartup, prepareStartup } from "../src/startup"
import { appHarness, cleanTemps, conversation, ids, tempDir } from "./session-ui-harness"
import { textWidth } from "../src/view/wrap"
import type { CommandInput } from "@mendcode/client"

afterEach(cleanTemps)
test("serve/web flags are opt-in, explicit-dir, loopback with precise ports and CORS", () => {
  expect(parseServerCommand(["--dir", "/tmp/server", "serve", "--port=4096", "--hostname", "::1", "--cors", "https://one.example", "--cors=https://two.example"])).toMatchObject({ kind: "serve", dir: "/tmp/server", port: 4096, hostname: "::1", cors: ["https://one.example", "https://two.example"], open: false })
  expect(parseServerCommand(["web", "--data-dir", "/tmp/data", "--no-open", "--port", "0"])).toMatchObject({ kind: "web", port: 0, open: false })
  expect(HTTP_USAGE).not.toContain("--mdns")
  for (const flag of ["--mdns", "--no-mdns", "--mdns-domain"]) expect(() => parseServerCommand(["serve", "--dir", "/tmp/server", flag])).toThrow("unknown server flag")
  expect(parseServerCommand(["serve", "--help"])?.help).toBe(true)
  expect(parseServerCommand(["web", "--dir", "/tmp/d"])?.edit).toBeUndefined()
  expect(parseServerCommand(["web", "--dir", "/tmp/d", "--edit", "--pty"])).toMatchObject({ edit: true, pty: true })
  expect(parseServerCommand(["web", "--dir", "/tmp/d", "--no-edit"])?.edit).toBe(false)
  expect(() => parseServerCommand(["web", "--dir", "/tmp/d", "--edit=1"])).toThrow("takes no value")
  expect(parseServerCommand(["--port", "4096", "serve", "--dir", "/tmp/data"])?.port).toBe(4096)
  expect(parseServerCommand(["run", "serve"])).toBeUndefined()
  for (const args of [["serve"], ["serve", "--dir", "/tmp/d", "--port", "-1"], ["serve", "--dir", "/tmp/d", "--port", "65536"], ["serve", "--dir", "/tmp/d", "--hostname", "0.0.0.0"], ["serve", "--dir", "/tmp/d", "--cors", "*"], ["serve", "--dir", "/tmp/d", "--mdns-domain", "bad"], ["web", "--dir", "/tmp/d", "--password", "secret"]]) expect(() => parseServerCommand(args)).toThrow()
})

test("attach forwards remote --dir unchanged, aliases, fork/continue/session/diagnostics and Basic token credentials", () => {
  const target = ids("session")
  const parsed = parseRemoteFlags(["attach", "http://localhost:4096", "--dir", "/missing/on/client", "--continue", "--session", target, "--fork", "--diagnostics", "-p", "private-token", "-u", "mendcode"])
  expect(parsed.remote).toMatchObject({ httpUrl: "http://localhost:4096/", directory: "/missing/on/client", username: "mendcode", password: "private-token" })
  expect(parseStartup(parsed.args)).toMatchObject({ kind: "tui", continue: true, session: target, fork: true, diagnostics: true })
  expect(parsed.args).not.toContain("private-token")
  expect(remoteTransport(parsed.remote!, {})).toMatchObject({ httpUrl: "http://localhost:4096/", directory: "/missing/on/client", username: "mendcode", token: "private-token" })
  expect(() => parseStartup(parseRemoteFlags(["attach", "http://127.0.0.1:4096", "--fork"]).args)).toThrow("requires")
  expect(normalizeAttach(["--dir=/remote/project", "attach", "https://server.example"])).toEqual({ args: ["--connect", "https://server.example"], directory: "/remote/project" })
  expect(parseRemoteFlags(["--password", "private-token", "attach", "http://127.0.0.1:4096"]).remote?.password).toBe("private-token")
})

test("HTTP URLs never accept inline secrets, insecure hosts, paths or transport changes", () => {
  for (const url of ["http://user:private-secret@localhost:4096", "http://server.example:4096", "http://localhost:4096/path", "http://localhost:4096?token=private-secret", "http://localhost:4096#private-secret"]) {
    try { parseRemoteFlags(["attach", url]); throw new Error("accepted") } catch (error) { expect(String(error)).not.toContain("private-secret"); expect(String(error)).not.toContain("accepted") }
  }
  expect(() => parseRemoteFlags(["attach"])).toThrow("HTTP URL")
  expect(() => parseRemoteFlags(["attach", "localhost:4096"])).toThrow("HTTP URL")
  expect(() => parseRemoteFlags(["attach", "http://localhost:0"])).toThrow("nonzero port")
  expect(() => parseRemoteFlags(["attach", "http://localhost:4096", "--engine", "faux"])).toThrow("local daemon")
  expect(() => parseRemoteFlags(["attach", "http://localhost:4096", "--engine=faux"])).toThrow("local daemon")
  expect(() => parseRemoteFlags(["attach", "http://localhost:4096", "--ca", "/ca"])).toThrow("HTTPS")
  expect(() => parseRemoteFlags(["--connect", "127.0.0.1:4096", "--password", "private-secret"])).toThrow("HTTP attach")
  expect(parseRemoteFlags(["--server-url", "https://server.example:443"]).remote).toMatchObject({ tls: true, port: 443 })
})

test("token file overrides attach password, then v2 env, with v1 env fallback only for HTTP", () => {
  const file = path.join(tempDir(), "token")
  writeFileSync(file, "file-token\n", { mode: 0o600 })
  const parsed = parseRemoteFlags(["attach", "http://127.0.0.1:4096", "--password", "argument-token", "--token-file", file])
  expect(remoteTransport(parsed.remote!, { MENDCODE_TOKEN: "env-token" }).token).toBe("file-token")
  const flags = parseRemoteFlags(["attach", "http://127.0.0.1:4096"]).remote!
  expect(remoteTransport(flags, { OPENCODE_SERVER_PASSWORD: "legacy-token", OPENCODE_SERVER_USERNAME: "custom" })).toMatchObject({ token: "legacy-token", username: "custom" })
})

test("attach startup uses server project, explicit session takes precedence, then forks before opening app", async () => {
  const original = ids("session"), fork = ids("session")
  const sent: CommandInput[] = []
  const client = { send: async (command: CommandInput) => {
    sent.push(command)
    return { ok: true as const, result: command.type === "session.list" ? { sessions: [{ sessionId: original, title: "Original" }] } : command.type === "session.get" ? { session: { directory: "/remote/project" } } : command.type === "session.fork" ? { sessionId: fork } : {} }
  } }
  const startup = parseStartup(parseRemoteFlags(["attach", "http://127.0.0.1:4096", "--continue", "--fork"]).args)
  expect(await prepareStartup(client, startup, "/remote/project", "", { readOnly: false })).toEqual({ sessionId: fork, directory: "/remote/project" })
  expect(sent.map((command) => command.type)).toEqual(["session.list", "session.get", "session.fork"])
  sent.length = 0
  await prepareStartup(client, parseStartup(["--session", original, "--continue"]), "/remote/project", "", { readOnly: false })
  expect(sent[0]?.type).toBe("session.get")
})

for (const [width, height] of [[60, 20], [100, 30], [160, 45], [180, 50], [220, 60]]) test(`HTTP remote app and opt-in diagnostics fit ${width}×${height}, no local persistence`, async () => {
  const dataDir = path.join(tempDir(), "uncreated")
  const memory = { rss: 1048576, heapTotal: 1048576, heapUsed: 500000, external: 0, arrayBuffers: 0 }
  const h = appHarness({ width, height, dataDir, directory: "/remote/project", remote: { host: "127.0.0.1", readOnly: false }, diagnostics: { memory: () => memory, snapshot: async () => { throw new Error("unused") } }, reply: (command) => command.type === "diagnostics.resources" ? { ok: true, result: { memory, connections: 1, actors: 1, jobs: 0, scopes: 1, timers: 0, disposers: 0 } } : undefined })
  conversation(h.sessionId, (event) => h.app.onEvent(event)).exchange("Review the server", "HTTP requests use the same daemon commands.")
  h.app.render()
  expect(h.text()).toHaveLength(height)
  await h.type("/diagnostics\r")
  expect(h.text().join("\n")).toContain("Diagnostics")
  expect(h.text().every((row) => textWidth(row) <= width && !row.includes("\x1b"))).toBe(true)
  expect(h.sentOf("diagnostics.resources")).toHaveLength(1)
  expect(existsSync(dataDir)).toBe(false)
  await h.app.onKey("\x03")
})

test("serve/web help uses the real CLI without daemon, socket or database", () => {
  for (const kind of ["serve", "web"]) {
    const dir = path.join(tempDir(), "uncreated")
    const process = Bun.spawnSync(["bun", path.join(import.meta.dir, "../src/entry.ts"), "--dir", dir, kind, "--help"], { stdout: "pipe", stderr: "pipe" })
    expect(process.exitCode).toBe(0)
    expect(process.stdout.toString()).toBe(HTTP_USAGE)
    expect(process.stderr.toString()).toBe("")
    expect(existsSync(dir)).toBe(false)
  }
}, 15_000)
