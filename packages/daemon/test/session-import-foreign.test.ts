import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { isReadOnlyCommand, SessionTranscript } from "@mendcode/protocol"
import { boot, stop, say, type NativeHarness } from "./native-harness"
import { claudeCodeTranscript, codexTranscript, detectForeign } from "../src/session-import-foreign"
import { createSessionTransfer } from "../src/session-transfer"

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })
async function native() { const h = await boot({ steps: [stop("Continued")] }); cleanup.push(h.cleanup); return h }
function temp(prefix: string) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
const jsonl = (rows: unknown[]) => rows.map((row) => JSON.stringify(row)).join("\n") + "\n"
const secret = `sk-proj-${"A".repeat(40)}`
const ctx = { fallbackAt: 5_000, now: 9_000 }

const claudeRows = (cwd = "/work/app") => [
  { type: "summary", summary: "Fix the login bug", leafUuid: "x" },
  { type: "user", uuid: "u0", sessionId: "cc-1", cwd, isMeta: true, timestamp: "2026-09-01T10:00:00.000Z", message: { role: "user", content: "<local-command-caveat>ignore</local-command-caveat>" } },
  { type: "user", uuid: "u1", sessionId: "cc-1", cwd, timestamp: "2026-09-01T10:00:01.000Z", message: { role: "user", content: [{ type: "text", text: `Fix login. key ${secret}` }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }] } },
  { type: "assistant", uuid: "a1", sessionId: "cc-1", timestamp: "2026-09-01T10:00:02.000Z", message: { id: "m1", role: "assistant", model: "claude-opus", content: [{ type: "thinking", thinking: "look at auth" }, { type: "text", text: "Reading the file." }, { type: "tool_use", id: "tu1", name: "Read", input: { file_path: "/work/app/auth.ts" } }], usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3 } } },
  { type: "user", uuid: "u2", sessionId: "cc-1", timestamp: "2026-09-01T10:00:03.000Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: [{ type: "text", text: "export const login = 1" }] }] } },
  { type: "assistant", uuid: "a2", sessionId: "cc-1", timestamp: "2026-09-01T10:00:04.000Z", message: { id: "m2", role: "assistant", model: "claude-opus", content: [{ type: "text", text: "Fixed." }], usage: { input_tokens: 20, output_tokens: 7 } } },
  { type: "assistant", uuid: "side", isSidechain: true, sessionId: "cc-1", timestamp: "2026-09-01T10:00:04.500Z", message: { id: "m3", role: "assistant", model: "claude-opus", content: [{ type: "text", text: "sidechain noise" }] } },
  { type: "user", uuid: "u3", sessionId: "cc-1", timestamp: "2026-09-01T10:01:00.000Z", message: { role: "user", content: "Thanks, now add a test" } },
  { type: "assistant", uuid: "a3", sessionId: "cc-1", timestamp: "2026-09-01T10:01:02.000Z", message: { id: "m4", role: "assistant", model: "claude-opus", content: [{ type: "tool_use", id: "tu2", name: "Bash", input: { command: "bun test" } }] } },
]

const codexRows = (cwd = "/work/app") => [
  { timestamp: "2026-09-02T09:00:00.000Z", type: "session_meta", payload: { id: "cx-1", cwd, originator: "codex_cli_rs" } },
  { timestamp: "2026-09-02T09:00:00.100Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>cwd</environment_context>" }] } },
  { timestamp: "2026-09-02T09:00:01.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "List the files" }] } },
  { timestamp: "2026-09-02T09:00:02.000Z", type: "response_item", payload: { type: "reasoning", summary: [{ type: "summary_text", text: "Need ls" }], encrypted_content: "zzz" } },
  { timestamp: "2026-09-02T09:00:03.000Z", type: "response_item", payload: { type: "function_call", name: "shell", arguments: JSON.stringify({ command: ["ls"] }), call_id: "c1" } },
  { timestamp: "2026-09-02T09:00:04.000Z", type: "response_item", payload: { type: "function_call_output", call_id: "c1", output: JSON.stringify({ output: "a.ts\nb.ts", metadata: { exit_code: 0 } }) } },
  { timestamp: "2026-09-02T09:00:05.000Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Two files." }] } },
  { timestamp: "2026-09-02T09:00:05.500Z", type: "event_msg", payload: { type: "agent_message", message: "Two files." } },
]

test("Claude Code JSONL becomes a valid native transcript: turns, tool results, thinking, usage; sidechains and meta rows are dropped", () => {
  const text = jsonl(claudeRows())
  expect(detectForeign(text)).toBe("claude-code")
  const value = claudeCodeTranscript(text, ctx)
  expect(SessionTranscript.safeParse(value).success).toBe(true)
  expect(value).toMatchObject({ sessionId: "claude-code:cc-1", title: "Fix the login bug", directory: "/work/app", truncated: false })
  expect(value.turns).toHaveLength(2)
  const [first, second] = value.turns
  expect(first!.items.map((item) => item.kind)).toEqual(["user_message", "reasoning", "agent_message", "tool_call", "agent_message"])
  expect(first!.items[0]).toMatchObject({ attachments: [{ name: "image", mime: "image/png", bytes: 3 }], at: Date.parse("2026-09-01T10:00:01.000Z") })
  expect(first!.items[3]).toMatchObject({ tool: "Read", text: "export const login = 1", status: "ok", input: '{"file_path":"/work/app/auth.ts"}' })
  expect(first!.metadata).toEqual({ provider: "anthropic", model: "claude-opus", tokens: 42, input: 30, output: 12, cacheRead: 3, cacheWrite: 0 })
  expect(JSON.stringify(value)).not.toContain("sidechain noise")
  expect(second!.items[1]).toMatchObject({ kind: "tool_call", tool: "Bash", status: "unknown", text: "" })
})

test("Codex rollout JSONL (current and flat older rows) is translated; injected context is skipped", () => {
  const text = jsonl(codexRows())
  expect(detectForeign(text)).toBe("codex")
  const value = codexTranscript(text, ctx)
  expect(SessionTranscript.safeParse(value).success).toBe(true)
  expect(value).toMatchObject({ sessionId: "codex:cx-1", title: "List the files", directory: "/work/app" })
  expect(value.turns).toHaveLength(1)
  expect(value.turns[0]!.items.map((item) => item.kind)).toEqual(["user_message", "reasoning", "tool_call", "agent_message"])
  expect(value.turns[0]!.items[2]).toMatchObject({ tool: "shell", text: "a.ts\nb.ts", status: "ok", input: '{"command":["ls"]}' })
  const flat = jsonl([{ id: "old-1", timestamp: "2025-05-01T00:00:00Z", instructions: "x" }, { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }, { type: "message", role: "assistant", content: [{ type: "output_text", text: "hi" }] }])
  expect(detectForeign(flat)).toBe("codex")
  expect(codexTranscript(flat, ctx).turns[0]!.items.map((item) => item.text)).toEqual(["hello", "hi"])
  expect(detectForeign('{"hello":1}\n')).toBeUndefined()
})

test("limits keep the newest turns and say so; a long output is clipped and flagged", () => {
  const rows: unknown[] = []
  for (let i = 0; i < 1200; i++) rows.push({ type: "user", uuid: `u${i}`, sessionId: "big", timestamp: new Date(1_800_000_000_000 + i * 1000).toISOString(), message: { role: "user", content: `prompt ${i}` } })
  const value = claudeCodeTranscript(jsonl(rows), ctx)
  expect(value.turns).toHaveLength(1000)
  expect(value.truncated).toBe(true)
  expect(value.turns.at(-1)!.items[0]!.text).toBe("prompt 1199")
  expect(SessionTranscript.safeParse(value).success).toBe(true)
  const long = jsonl([
    { type: "user", sessionId: "s", message: { role: "user", content: "go" } },
    { type: "assistant", sessionId: "s", message: { id: "m", model: "claude", content: [{ type: "tool_use", id: "t", name: "Bash", input: { command: "x".repeat(9000) } }] } },
    { type: "user", sessionId: "s", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "y".repeat(70_000), is_error: true }] } },
  ])
  const clipped = claudeCodeTranscript(long, ctx).turns[0]!.items[1]!
  expect(clipped).toMatchObject({ status: "error", truncated: true })
  expect(clipped.text).toHaveLength(65_536)
  expect(clipped.input).toHaveLength(4_000)
})

async function importFile(h: NativeHarness, name: string, rows: unknown[], options: { from?: "auto" | "claude-code" | "codex" | "mendcode" } = {}) {
  const file = path.join(h.project, name)
  writeFileSync(file, jsonl(rows))
  return h.client.importSession(file, h.project, options)
}

test("import from a Claude Code file creates a session that the native engine resumes; credentials are redacted; tools never run", async () => {
  const h = await native()
  const imported = await importFile(h, "claude.jsonl", claudeRows())
  if (!imported.ok) throw new Error(imported.error.message)
  expect(imported.import).toMatchObject({ turns: 2, from: "claude-code", sourceSessionId: "claude-code:cc-1", attachmentFilesOmitted: 1 })
  const id = imported.import.sessionId
  expect(h.store.sessionInfo(id)).toMatchObject({ title: "Fix the login bug", directory: h.project })
  expect(JSON.stringify(h.store.readAfter(id, 0))).not.toContain(secret)
  const exported = await h.client.exportSession(id, { format: "markdown", toolDetails: true })
  if (!exported.ok) throw new Error(exported.error.message)
  expect(exported.export.text).toContain("Reading the file.")
  expect(exported.export.text).toContain("export const login = 1")
  await say(h, id, "Continue")
  expect(JSON.stringify(h.requests[0]?.messages)).toContain("Fixed.")
  expect(h.requests[0]?.messages.some((message) => message.role === "tool")).toBe(false)
})

test("import from a Codex file, sniffed without --from; wrong --from and unknown content fail without a partial session", async () => {
  const h = await native()
  const imported = await importFile(h, "codex.jsonl", codexRows())
  expect(imported).toMatchObject({ ok: true, import: { from: "codex", turns: 1 } })
  const count = h.store.listSessions({ roots: false }).length
  expect(await importFile(h, "weird.jsonl", [{ hello: "world" }])).toMatchObject({ ok: false, error: { message: expect.stringContaining("Unrecognized") } })
  expect(await importFile(h, "empty.jsonl", [{ type: "summary", summary: "only a title" }], { from: "claude-code" })).toMatchObject({ ok: false })
  expect(h.store.listSessions({ roots: false })).toHaveLength(count)
  expect(await h.client.importSession(undefined, h.project, {})).toMatchObject({ ok: false, error: { message: expect.stringContaining("file or URL") } })
  expect(await h.client.importSession("https://example.invalid/x.jsonl", h.project, { from: "codex" })).toMatchObject({ ok: false })
  symlinkSync(path.join(h.project, "codex.jsonl"), path.join(h.project, "link.jsonl"))
  expect(await h.client.importSession("link.jsonl", h.project)).toMatchObject({ ok: false })
})

test("--latest picks the newest transcript of the project from each tool's default location and ignores other projects", async () => {
  const h = await native()
  const claude = temp("mend-cc-home-")
  const codex = temp("mend-cx-home-")
  const projectDir = "/work/app"
  const folder = path.join(claude, "projects", projectDir.replace(/[^a-zA-Z0-9]/g, "-"))
  mkdirSync(folder, { recursive: true })
  const old = path.join(folder, "old.jsonl")
  writeFileSync(old, jsonl(claudeRows(projectDir)))
  utimesSync(old, 1_000, 1_000)
  writeFileSync(path.join(folder, "summary-only.jsonl"), jsonl([{ type: "summary", summary: "nothing" }]))
  const day = path.join(codex, "sessions", "2026", "09", "02")
  mkdirSync(day, { recursive: true })
  writeFileSync(path.join(day, "rollout-2026-09-02T09-00-00-cx-1.jsonl"), jsonl(codexRows(projectDir)))
  writeFileSync(path.join(day, "rollout-2026-09-02T10-00-00-other.jsonl"), jsonl(codexRows("/somewhere/else")))
  const transfer = createSessionTransfer({ store: h.store, homes: { claude, codex }, now: () => 9_000 })
  const auto = await transfer.import({ directory: projectDir, latest: true })
  expect(auto).toMatchObject({ ok: true, result: { from: "codex", sourceSessionId: "codex:cx-1" } })
  const onlyClaude = await transfer.import({ directory: projectDir, latest: true, from: "claude-code" })
  expect(onlyClaude).toMatchObject({ ok: true, result: { from: "claude-code", sourceSessionId: "claude-code:cc-1" } })
  expect(await transfer.import({ directory: "/work/none", latest: true })).toMatchObject({ ok: false, message: expect.stringContaining("No Claude Code or Codex session") })
  expect(await transfer.import({ directory: projectDir, latest: true, from: "mendcode" })).toMatchObject({ ok: false })
})

test("session.import and the Console-free share commands are never read-only remote commands", () => {
  for (const command of [{ type: "session.import", directory: "/x", source: "a.jsonl" }, { type: "session.share.static", sessionId: "s", target: "local", action: "create" }]) expect(isReadOnlyCommand(command as never)).toBe(false)
})
