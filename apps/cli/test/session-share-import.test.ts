import { afterAll, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import type { CommandInput, CommandReply } from "@mendcode/client"
import { parseAutomation, type Automation } from "../src/automation"
import { defaultExportName, parseExportArgs } from "../src/ui/export-file"
import { appHarness, cleanTemps, ids, tempDir } from "./session-ui-harness"

afterAll(cleanTemps)
const asReply = (reply: unknown) => reply as CommandReply
const parsed = (...args: string[]): Automation => { const p = parseAutomation(args); if (p.ok !== true) throw new Error(JSON.stringify(p)); return p.command }
const rejected = (...args: string[]) => parseAutomation(args).ok === false

describe("html export arguments", () => {
  test("/export and the CLI accept html; the default name takes .html", () => {
    expect(parseExportArgs("html notes/run.html --tools")).toMatchObject({ format: "html", path: "notes/run.html", toolDetails: true })
    expect(parseExportArgs("markdown")).toMatchObject({ format: "markdown" })
    expect(defaultExportName("Fix the flaky reconnect!", "html")).toBe("fix-the-flaky-reconnect.html")
    expect(parsed("export", "ses_1", "--format", "html")).toMatchObject({ kind: "session.export", outputFormat: "html" })
    expect(parsed("session", "export", "ses_1", "--format", "html")).toMatchObject({ outputFormat: "html" })
    expect(rejected("export", "--format", "html", "--json")).toBe(true)
    expect(rejected("export", "--format", "pdf")).toBe(true)
  })
})

describe("import and share arguments", () => {
  test("import takes a file or --latest, optionally with --from", () => {
    expect(parsed("import", "chat.jsonl", "--from", "claude-code")).toMatchObject({ kind: "session.import", source: "chat.jsonl", from: "claude-code" })
    expect(parsed("import", "--latest", "--from", "codex")).toMatchObject({ kind: "session.import", latest: true, from: "codex" })
    expect(parsed("import", "--latest")).toEqual(expect.objectContaining({ latest: true }))
    for (const args of [["import"], ["import", "a.json", "--latest"], ["import", "a.json", "b.json"], ["import", "a.json", "--from", "vim"], ["import", "--latest", "--from", "mendcode"]]) expect(rejected(...args)).toBe(true)
  })

  test("share local and share gist build the static-share command; a gist needs --yes", () => {
    expect(parsed("share", "local", "ses_1")).toMatchObject({ kind: "share", request: { type: "session.share.static", sessionId: "ses_1", target: "local", action: "create" } })
    expect(parsed("share", "local", "ses_1", "--remove")).toMatchObject({ request: { target: "local", action: "remove" } })
    expect(parsed("share", "gist", "ses_1", "--yes")).toMatchObject({ request: { target: "gist", action: "create", confirm: true } })
    expect(parsed("share", "gist", "ses_1", "--remove")).toMatchObject({ request: { target: "gist", action: "remove" } })
    expect(rejected("share", "gist", "ses_1")).toBe(true)
    expect(rejected("share", "local")).toBe(true)
    expect(rejected("share", "status", "ses_1", "--yes")).toBe(true)
  })
})

describe("terminal commands", () => {
  function app(options: { reply?: (command: CommandInput) => unknown; remote?: boolean } = {}) {
    const directory = tempDir("mendcode-import-")
    const h = appHarness({
      directory,
      ...(options.remote ? { remote: { host: "test.invalid", readOnly: false } } : {}),
      reply: (command) => {
        if (command.type === "session.export") return asReply({ ok: true, result: { format: command.format, text: "<!doctype html><title>x</title>", turns: 1, truncated: false } })
        return options.reply ? asReply(options.reply(command)) : undefined
      },
    })
    return { h, directory }
  }

  test("/export html writes <title>.html and leaves tool details to the daemon's html default", async () => {
    const { h, directory } = app()
    h.app.onGlobal({ gseq: 1, at: 0, type: "session.activity", sessionId: h.sessionId, directory, title: "Fix the flaky reconnect!", state: "idle", updatedAt: 1 } as never)
    await h.type("/export html\r")
    expect(h.sentOf("session.export")).toEqual([{ type: "session.export", sessionId: h.sessionId, format: "html" }])
    expect(readFileSync(path.join(directory, "fix-the-flaky-reconnect.html"), "utf8")).toBe("<!doctype html><title>x</title>\n")
  })

  test("the export options page cycles markdown, json, html and turns tool details on for html", async () => {
    const { h, directory } = app()
    h.app.onGlobal({ gseq: 1, at: 0, type: "session.activity", sessionId: h.sessionId, directory, title: "Notes", state: "idle", updatedAt: 1 } as never)
    await h.type("/export\r")
    await h.type("\t")
    await h.type(" ")
    await h.type(" ")
    expect(h.text().join("\n")).toContain("Format: html")
    expect(h.text().join("\n")).toContain("notes.html")
    await h.type("\r")
    expect(h.sentOf("session.export")[0]).toMatchObject({ format: "html", toolDetails: true })
    expect(readFileSync(path.join(directory, "notes.html"), "utf8")).toContain("<!doctype html>")
  })

  test("/import without a file asks for the newest session of the project and opens the new one", async () => {
    const created = ids("session")
    const { h, directory } = app({ reply: (command) => command.type === "session.import" ? { ok: true, result: { sessionId: created, sourceSessionId: "claude-code:x", turns: 3, items: 9, truncated: false, sanitized: false, attachmentFilesOmitted: 0, from: "claude-code" } } : undefined })
    await h.type("/import\r")
    expect(h.sentOf("session.import")).toEqual([{ type: "session.import", directory, latest: true }])
    expect(h.subscriptions.at(-1)?.sessionId).toBe(created)
    expect(h.text().join("\n")).toContain("imported 3 turns from Claude Code")
    await h.type("/import codex logs/rollout.jsonl\r")
    expect(h.sentOf("session.import")[1]).toEqual({ type: "session.import", directory, source: "logs/rollout.jsonl", from: "codex" })
  })

  test("/import reports the daemon's refusal and stays in the session", async () => {
    const { h } = app({ reply: (command) => command.type === "session.import" ? { ok: false, error: { code: "invalid_command", message: "[IMPORT]: No Claude Code or Codex session with messages found" } } : undefined })
    await h.type("/import\r")
    expect(h.text().join("\n")).toContain("No Claude Code or Codex session")
    expect(h.subscriptions.filter((entry) => entry.sessionId !== h.sessionId)).toEqual([])
  })

  test("/share local and /share gist send the static-share command; a gist waits for --yes; remote terminals are refused", async () => {
    const share = (command: CommandInput) => command.type === "session.share.static" ? { ok: true, result: { sessionId: "s", target: command.target, shared: command.action !== "remove", url: command.target === "gist" ? "https://gist.github.com/u/abcdef0123456789" : "file:///data/shares/s.html" } } : undefined
    const { h } = app({ reply: share })
    await h.type("/share local\r")
    expect(h.sentOf("session.share.static")[0]).toEqual({ type: "session.share.static", sessionId: h.sessionId, target: "local", action: "create" })
    expect(h.text().join("\n")).toContain("file:///data/shares/s.html")
    await h.type("/share gist\r")
    expect(h.sentOf("session.share.static")).toHaveLength(1)
    expect(h.text().join("\n")).toContain("/share gist --yes")
    await h.type("/share gist --yes\r")
    expect(h.sentOf("session.share.static")[1]).toEqual({ type: "session.share.static", sessionId: h.sessionId, target: "gist", action: "create", confirm: true })
    await h.type("/share gist remove\r")
    expect(h.sentOf("session.share.static")[2]).toMatchObject({ target: "gist", action: "remove" })
    const remote = app({ reply: share, remote: true })
    await remote.h.type("/share local\r")
    await remote.h.type("/import\r")
    expect(remote.h.sentOf("session.share.static")).toHaveLength(0)
    expect(remote.h.sentOf("session.import")).toHaveLength(0)
  })
})
