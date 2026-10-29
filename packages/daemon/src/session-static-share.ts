import { chmodSync, existsSync, lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { randomBytes } from "node:crypto"
import { pathToFileURL } from "node:url"
import { z } from "zod"
import { redactSecrets, type SessionId, type SessionTranscript, type SessionTranscriptTurn, type StaticShare } from "@mendcode/protocol"
import type { Store } from "@mendcode/store"
import { privateText, savePrivate } from "./console"
import type { GithubProcess } from "./github"
import { renderHtml } from "./session-html"
import type { createSessionHistory } from "./session-history"

/**
 * Sharing that needs no Console backend. Both targets publish the same public data as a Console share: user and assistant
 * text with credentials redacted, the local directory removed, no thinking, tool payloads, metadata or attachment files.
 * `local` writes one HTML page under `<data>/shares/` (private mode) and gives its `file://` link. `gist` uploads the
 * Markdown rendering as a secret GitHub gist through `gh` (the user's own authentication) and only when the caller
 * confirms; the process runner is injected, so tests never reach the network.
 */
const recordSchema = z.object({ sessionId: z.string(), target: z.enum(["local", "gist"]), url: z.string().max(2048), path: z.string().max(4096).optional(), id: z.string().max(200).optional(), at: z.number(), turns: z.number().int().nonnegative(), truncated: z.boolean() })
type Record = z.infer<typeof recordSchema>
const GIST_URL = /^https:\/\/gist\.github\.com\/(?:[A-Za-z0-9-]+\/)?([0-9a-f]{8,64})$/

export function publicTurns(transcript: SessionTranscript): SessionTranscriptTurn[] {
  return transcript.turns.map((turn) => ({ turnId: turn.turnId, at: turn.at, outcome: turn.outcome, items: turn.items.filter((item) => (item.kind === "user_message" || item.kind === "agent_message") && item.source === undefined).map((item) => ({ itemId: item.itemId, kind: item.kind, text: redactSecrets(item.text).text, ...(item.at === undefined ? {} : { at: item.at }) })) })).filter((turn) => turn.items.length > 0)
}

export function publicMarkdown({ title, turns, truncated }: { title: string; turns: SessionTranscriptTurn[]; truncated: boolean }): string {
  const out = [`# ${title.trim() || "MendCode session"}`]
  for (const turn of turns) for (const item of turn.items) if (item.text.trim()) out.push(`## ${item.kind === "user_message" ? "User" : "Assistant"}\n\n${item.text.trim()}`)
  if (truncated) out.push("> Transcript truncated.")
  return `${out.join("\n\n")}\n`
}

export function createStaticShare(input: { dir: string; store: Store; history: ReturnType<typeof createSessionHistory>; gh: GithubProcess; now?: () => number }) {
  const folder = path.join(input.dir, "shares")
  const file = path.join(folder, "static-shares.json")
  const now = input.now ?? Date.now
  const records = new Map<string, Record>()
  const key = (sessionId: string, target: string) => `${target}:${sessionId}`
  try { for (const record of z.array(recordSchema).max(10_000).parse(JSON.parse(privateText(file)))) records.set(key(record.sessionId, record.target), record) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Share state unreadable") }
  const save = () => savePrivate(file, [...records.values()])

  function view(sessionId: SessionId, target: "local" | "gist"): StaticShare {
    const record = records.get(key(sessionId, target))
    return { sessionId, target, shared: record !== undefined, ...(record ? { url: record.url, ...(record.path ? { path: record.path } : {}), ...(record.id ? { id: record.id } : {}), at: record.at, turns: record.turns, truncated: record.truncated } : {}) }
  }

  function snapshot(sessionId: SessionId) {
    const exported = input.history.export({ sessionId, format: "json", sanitize: false, reasoning: false, toolDetails: false, assistantMetadata: false, timestamps: true })
    if (!exported.ok) throw new Error("Session unavailable")
    const transcript = JSON.parse(exported.result.text) as SessionTranscript
    return { title: redactSecrets(transcript.title).text, turns: publicTurns(transcript), truncated: exported.result.truncated, exportedAt: transcript.exportedAt }
  }

  function writePage(sessionId: SessionId, html: string): string {
    mkdirSync(folder, { recursive: true, mode: 0o700 })
    chmodSync(folder, 0o700)
    const target = path.join(folder, `${sessionId}.html`)
    if (existsSync(target) && lstatSync(target).isSymbolicLink()) throw new Error("Share file cannot be a symlink")
    const temp = `${target}.${randomBytes(8).toString("hex")}.tmp`
    writeFileSync(temp, html, { flag: "wx", mode: 0o600 })
    renameSync(temp, target)
    return target
  }

  async function createLocal(sessionId: SessionId) {
    const page = snapshot(sessionId)
    const target = writePage(sessionId, renderHtml({ title: page.title, turns: page.turns, truncated: page.truncated, exportedAt: page.exportedAt, timestamps: true }))
    records.set(key(sessionId, "local"), { sessionId, target: "local", url: pathToFileURL(target).href, path: target, at: now(), turns: page.turns.length, truncated: page.truncated })
    save()
    return view(sessionId, "local")
  }

  async function run(argv: string[], stdin?: string) {
    try {
      const result = await input.gh({ argv, cwd: input.dir, ...(stdin === undefined ? {} : { stdin }) })
      if (result.code !== 0) throw new Error("failed")
      return result.out
    } catch { throw new Error("gh gist failed; check that gh is installed and signed in") }
  }

  async function createGist(sessionId: SessionId, confirm: boolean | undefined) {
    if (confirm !== true) throw new Error("A gist leaves this machine; repeat with confirmation to upload the public transcript as a secret gist")
    const previous = records.get(key(sessionId, "gist"))
    if (previous) throw new Error("Session already has a gist; remove it first")
    const page = snapshot(sessionId)
    const out = await run(["gh", "gist", "create", "--filename", `${sessionId}.md`, "--desc", page.title.slice(0, 200) || "MendCode session", "-"], publicMarkdown(page))
    const url = out.split("\n").map((line) => line.trim()).findLast((line) => GIST_URL.test(line))
    if (!url) throw new Error("gh did not return a gist link")
    records.set(key(sessionId, "gist"), { sessionId, target: "gist", url, id: GIST_URL.exec(url)![1]!, at: now(), turns: page.turns.length, truncated: page.truncated })
    save()
    return view(sessionId, "gist")
  }

  return {
    /** A deleted session takes its local page with it; a gist is not touched (it needs the network and the user's say). */
    forget(sessionId: SessionId) {
      const record = records.get(key(sessionId, "local"))
      if (!record) return
      if (record.path) rmSync(record.path, { force: true })
      records.delete(key(sessionId, "local"))
      save()
    },
    async handle({ sessionId, target, action, confirm }: { sessionId: SessionId; target: "local" | "gist"; action: "create" | "status" | "remove"; confirm?: boolean | undefined }): Promise<StaticShare> {
      if (!input.store.hasSession(sessionId)) throw new Error("Unknown session")
      if (action === "status") return view(sessionId, target)
      if (action === "create") return target === "local" ? createLocal(sessionId) : createGist(sessionId, confirm)
      const record = records.get(key(sessionId, target))
      if (record?.target === "local" && record.path) rmSync(record.path, { force: true })
      if (record?.target === "gist" && record.id) await run(["gh", "gist", "delete", record.id, "--yes"])
      if (record) { records.delete(key(sessionId, target)); save() }
      return view(sessionId, target)
    },
  }
}
