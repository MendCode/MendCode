import { constants } from "node:fs"
import { open } from "node:fs/promises"
import path from "node:path"
import { createIdFactory, redactEventText, redactSecrets, SESSION_IMPORT_MAX_BYTES, SessionTranscript, type SessionImportResult } from "@mendcode/protocol"
import type { SessionEventDraft } from "@mendcode/kernel"
import type { ModelMessage } from "@mendcode/engine-native"
import type { Store } from "@mendcode/store"
import type { Outcome } from "./session-history"
import { foreignTranscript, isV1Export, v1ExportTranscript, type ForeignKind } from "./session-import-foreign"
import { defaultHomes, latestCandidates, readRegular, translate, type ForeignHomes } from "./session-import-source"
import { redactValue } from "./secrets"

export function redactTranscriptValue<T>(value: T): T {
  return redactValue(value, { redactKeys: true })
}

const marker = (kind: string, id: string, text: string) => text.trim() ? `[redacted:${kind}:${id}]` : text

/** Sanitize all content, not only strings recognized as credentials. IDs and numeric structure remain inspectable. */
export function sanitizeTranscript(value: SessionTranscript): SessionTranscript {
  return {
    ...value,
    sanitized: true,
    title: marker("session-title", value.sessionId, value.title),
    directory: marker("session-directory", value.sessionId, value.directory),
    turns: value.turns.map((turn) => ({
      ...turn,
      ...(turn.error ? { error: { code: marker("error-code", turn.turnId, turn.error.code), message: marker("error", turn.turnId, turn.error.message) } } : {}),
      ...(turn.metadata ? { metadata: { ...turn.metadata, provider: marker("provider", turn.turnId, turn.metadata.provider), model: marker("model", turn.turnId, turn.metadata.model) } } : {}),
      items: turn.items.map((item) => {
        const { render: _render, ...rest } = item
        return { ...rest, text: marker(item.kind, item.itemId, item.text),
          ...(item.tool !== undefined ? { tool: marker("tool", item.itemId, item.tool) } : {}),
          ...(item.input !== undefined ? { input: marker("tool-input", item.itemId, item.input) } : {}),
          ...(item.authorityText !== undefined ? { authorityText: marker("authority", item.itemId, item.authorityText) } : {}),
          ...(item.meta ? { meta: { redacted: `metadata:${item.itemId}` } } : {}),
          ...(item.resultMeta ? { resultMeta: { redacted: `result-metadata:${item.itemId}` } } : {}),
          ...(item.attachments ? { attachments: item.attachments.map((attachment, i) => ({ ...attachment, name: marker("file-name", `${item.itemId}-${i}`, attachment.name), mime: marker("file-mime", `${item.itemId}-${i}`, attachment.mime) })) } : {}),
        }
      }),
    })),
  }
}

/** Explicit URL imports are anonymous and bounded; a sharing backend/auth contract is deliberately not inferred. */
export async function readSessionSource(source: string, directory: string, request: typeof fetch = fetch): Promise<string> {
  if (/^https?:\/\//i.test(source)) {
    const url = new URL(source)
    if (url.username || url.password) throw new Error("Import URL must not contain credentials")
    if (/^\/share\//.test(url.pathname)) throw new Error("Share URLs require the B74 sharing service and v1 compatibility decision")
    const response = await request(url, { redirect: "error", credentials: "omit", signal: AbortSignal.timeout(20_000) })
    if (!response.ok) throw new Error(`Import URL returned HTTP ${response.status}`)
    if (Number(response.headers.get("content-length")) > SESSION_IMPORT_MAX_BYTES) {
      await response.body?.cancel()
      throw new Error(`Import exceeds ${SESSION_IMPORT_MAX_BYTES} bytes`)
    }
    if (!response.body) throw new Error("Import URL returned an empty body")
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let bytes = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        bytes += value.byteLength
        if (bytes > SESSION_IMPORT_MAX_BYTES) throw new Error(`Import exceeds ${SESSION_IMPORT_MAX_BYTES} bytes`)
        chunks.push(value)
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(source)) throw new Error("Import accepts a JSON file or an HTTP(S) URL")
  const file = await open(path.resolve(directory, source), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const info = await file.stat()
    if (!info.isFile()) throw new Error("Import source must be a regular file")
    if (info.size > SESSION_IMPORT_MAX_BYTES) throw new Error(`Import exceeds ${SESSION_IMPORT_MAX_BYTES} bytes`)
    const buffer = Buffer.alloc(SESSION_IMPORT_MAX_BYTES + 1)
    let bytes = 0
    while (bytes < buffer.length) {
      const read = await file.read(buffer, bytes, buffer.length - bytes, bytes)
      if (!read.bytesRead) break
      bytes += read.bytesRead
    }
    if (bytes > SESSION_IMPORT_MAX_BYTES) throw new Error(`Import exceeds ${SESSION_IMPORT_MAX_BYTES} bytes`)
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytes))
  } finally { await file.close() }
}

type ImportInput = { source?: string | undefined; directory: string; from?: "auto" | "mendcode" | ForeignKind | undefined; latest?: boolean | undefined }

/** The value to validate and the tool it came from: native JSON or URL as before, a Claude Code / Codex file, or the newest of a project. */
async function resolveSource(input: ImportInput, homes: Required<ForeignHomes>, now: number): Promise<{ raw: unknown; origin: "mendcode" | ForeignKind }> {
  const from = input.from ?? "auto"
  if (input.latest) {
    if (from === "mendcode") throw new Error("latest reads Claude Code or Codex sessions, not mendcode-session JSON")
    for (const candidate of latestCandidates({ directory: input.directory, from, homes })) {
      const { text, mtime } = await readRegular(candidate.file)
      const transcript = foreignTranscript(candidate.kind, text, { fallbackAt: mtime, now })
      if (transcript.turns.length) return { raw: transcript, origin: candidate.kind }
    }
    throw new Error(`No ${from === "auto" ? "Claude Code or Codex" : from === "codex" ? "Codex" : "Claude Code"} session with messages found for ${input.directory}`)
  }
  if (!input.source) throw new Error("Import needs a file or URL")
  if (/^[a-z][a-z0-9+.-]*:/i.test(input.source)) {
    if (from !== "auto" && from !== "mendcode") throw new Error(`${from} transcripts are local JSONL files, not URLs`)
    return { raw: JSON.parse(await readSessionSource(input.source, input.directory)), origin: "mendcode" }
  }
  const { text, mtime } = await readRegular(path.resolve(input.directory, input.source))
  const translated = translate({ text, from, mtime, now })
  if ("native" in translated) {
    if (Buffer.byteLength(text) > SESSION_IMPORT_MAX_BYTES) throw new Error(`Import exceeds ${SESSION_IMPORT_MAX_BYTES} bytes`)
    return { raw: translated.native, origin: "mendcode" }
  }
  if (!translated.transcript.turns.length) throw new Error(`No messages found in that ${translated.kind} transcript`)
  return { raw: translated.transcript, origin: translated.kind }
}

export function createSessionTransfer(ctx: { store: Store; ids?: ReturnType<typeof createIdFactory>; homes?: ForeignHomes; now?: () => number }) {
  const ids = ctx.ids ?? createIdFactory()
  return {
    async import(input: ImportInput): Promise<Outcome<SessionImportResult>> {
      try {
        const resolved = await resolveSource(input, { ...defaultHomes(), ...ctx.homes }, (ctx.now ?? Date.now)())
        const now = (ctx.now ?? Date.now)()
        // MendCode v1's export JSON is read like another agent's transcript: translated, then validated and redacted as a native file.
        const v1 = isV1Export(resolved.raw) ? v1ExportTranscript(resolved.raw, { fallbackAt: now, now }) : undefined
        if (v1 && !v1.turns.length) throw new Error("No messages found in that MendCode v1 export")
        const raw: unknown = redactTranscriptValue(v1 ?? resolved.raw)
        const parsed = SessionTranscript.safeParse(raw)
        if (!parsed.success) throw new Error("Invalid session JSON: expected mendcode-session@1 with bounded, unique turns and items")
        const value = parsed.data
        const sessionId = ids("session")
        const events: Array<SessionEventDraft & { at: number }> = []
        const messages: ModelMessage[] = []
        let attachmentFilesOmitted = 0
        let count = 0
        const event = (draft: SessionEventDraft, at: number) => events.push({ ...redactEventText(draft), at })
        for (const turn of value.turns) {
          const turnId = ids("turn")
          event({ type: "turn.started", sessionId, turnId, queueId: ids("queue"), ...(turn.metadata ? { importedMetadata: turn.metadata } : {}) }, turn.at)
          for (const item of turn.items) {
            const itemId = ids("item")
            count++
            const meta = { ...item.meta, ...(item.tool ? { tool: item.tool } : {}), ...(item.source ? { [item.source]: true } : {}), ...(item.truncated ? { importedTruncated: true } : {}) }
            event({ type: "item.started", sessionId, turnId, itemId, kind: item.kind, meta }, item.at ?? turn.at)
            const resultMeta = item.resultMeta ?? {}
            event({ type: "item.completed", sessionId, itemId, status: item.status ?? "ok", text: item.text, ...(item.attachments ? { attachmentDescriptions: item.attachments } : {}), ...(item.input !== undefined ? { toolInput: item.input } : {}), ...(item.render ? { render: item.render } : {}), ...(item.authorityText !== undefined ? { authorityText: item.authorityText } : {}), ...(Object.keys(resultMeta).length ? { meta: resultMeta } : {}) }, item.at ?? turn.at)
            attachmentFilesOmitted += item.attachments?.length ?? 0
            if (item.kind === "user_message") messages.push({ role: "user", content: redactSecrets(item.text).text + (item.attachments?.length ? `\n\n[Imported attachment files unavailable: ${item.attachments.map((attachment) => attachment.name).join(", ")}]` : "") })
            else if (item.kind === "agent_message") messages.push({ role: "assistant", content: redactSecrets(item.text).text, toolCalls: [] })
            else if (item.kind === "tool_call") messages.push({ role: "assistant", content: `[Imported tool: ${redactSecrets(item.tool ?? "tool").text}]\n${redactSecrets(item.text).text}`, toolCalls: [] })
          }
          const end = Math.max(turn.at + (turn.metadata?.durationMs ?? 0), ...turn.items.map((item) => item.at ?? turn.at))
          if (turn.outcome === "failed") event({ type: "turn.failed", sessionId, turnId, error: turn.error ?? { code: "imported", message: "Imported failed turn" } }, end)
          else if (turn.outcome === "cancelled") event({ type: "turn.cancelled", sessionId, turnId, by: "user" }, end)
          else if (turn.outcome === "running" || turn.outcome === "interrupted") event({ type: "turn.interrupted", sessionId, turnId, reason: "transport" }, end)
          else event({ type: "turn.completed", sessionId, turnId }, end)
        }
        ctx.store.importTranscript({ id: sessionId, directory: input.directory, title: redactSecrets(value.title).text, createdAt: value.turns[0]?.at ?? value.exportedAt, events, messages, origin: { sourceSessionId: value.sessionId, sanitized: value.sanitized ?? false, truncated: value.truncated || value.turns.some((turn) => turn.items.some((item) => item.truncated)) } })
        return { ok: true, result: { sessionId, sourceSessionId: value.sessionId, turns: value.turns.length, items: count, sanitized: value.sanitized ?? false, truncated: value.truncated || value.turns.some((turn) => turn.items.some((item) => item.truncated)), attachmentFilesOmitted, from: resolved.origin } }
      } catch (error) {
        return { ok: false, code: "invalid_command", message: `[IMPORT]: ${redactSecrets(error instanceof Error ? error.message : "Could not import session").text}` }
      }
    },
  }
}
