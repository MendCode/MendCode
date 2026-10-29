import { z } from "zod"
import path from "node:path"
import { redactSecrets, type SessionTranscript, type SessionEvent, type SessionId, type SessionShare, type Settings } from "@mendcode/protocol"
import { privateText, savePrivate, serviceLink, type ConsoleService } from "./console"
import type { createSessionHistory } from "./session-history"
import type { Store } from "@mendcode/store"

const recordSchema = z.object({ sessionId: z.string(), id: z.string().min(1).max(200), secret: z.string().min(1).max(8192), url: z.string().url().max(2048), backend: z.string().url(), accountID: z.string().optional(), orgID: z.string().optional(), resource: z.enum(["share", "shares"]), syncedAt: z.number().optional(), truncated: z.boolean().optional() })
type Record = z.infer<typeof recordSchema>
export function createSessionSharing(input: { dir: string; store: Store; console: ConsoleService; history: ReturnType<typeof createSessionHistory>; settings(): Settings; now?: () => number; debounceMs?: number }) {
  const file = path.join(input.dir, "session-shares.json"), now = input.now ?? Date.now
  const records = new Map<string, Record>(), pending = new Set<string>(), errors = new Map<string, string>(), timers = new Map<string, ReturnType<typeof setTimeout>>(), tails = new Map<string, Promise<unknown>>()
  let stopped = false
  try { for (const record of z.array(recordSchema).max(10_000).parse(JSON.parse(privateText(file)))) records.set(record.sessionId, record) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Share state unreadable") }
  const save = () => savePrivate(file, [...records.values()])
  const policy = () => input.settings().share ?? "disabled"
  function status(sessionId: SessionId): SessionShare {
    if (!input.store.hasSession(sessionId)) throw new Error("Unknown session")
    const record = records.get(sessionId)
    return { sessionId, policy: policy(), pending: pending.has(sessionId), ...(record ? { url: record.url, ...(record.syncedAt === undefined ? {} : { syncedAt: record.syncedAt }), ...(record.truncated ? { truncated: true } : {}) } : {}), ...(errors.has(sessionId) ? { error: errors.get(sessionId)! } : {}) }
  }
  function clearTimer(sessionId: string) { clearTimeout(timers.get(sessionId)); timers.delete(sessionId) }
  async function serial<T>(sessionId: SessionId, run: () => Promise<T>): Promise<T> {
    clearTimer(sessionId)
    const previous = tails.get(sessionId) ?? Promise.resolve()
    const next = previous.then(async () => { if (stopped) throw new Error("Sharing stopped"); pending.add(sessionId); errors.delete(sessionId); return run() })
    const tail = next.catch(() => {}).finally(() => { if (tails.get(sessionId) === tail) { pending.delete(sessionId); tails.delete(sessionId) } })
    tails.set(sessionId, tail)
    try { const result = await next; await tail; return result } catch (error) { errors.set(sessionId, error instanceof Error ? error.message : "Share operation failed"); throw error }
  }
  async function sync(record: Record) {
    if (policy() === "disabled") throw new Error("Sharing is disabled")
    const exported = input.history.export({ sessionId: record.sessionId as SessionId, format: "json", sanitize: false, reasoning: false, toolDetails: false, assistantMetadata: false, timestamps: true })
    if (!exported.ok) throw new Error("Share session unavailable")
    const access = await input.console.access({ url: record.backend, ...(record.accountID ? { accountID: record.accountID } : {}), ...(record.orgID ? { orgID: record.orgID } : {}) })
    const transcript = JSON.parse(exported.result.text) as SessionTranscript
    const publicData = { format: transcript.format, sessionId: transcript.sessionId, title: redactSecrets(transcript.title).text, directory: "[redacted]", exportedAt: transcript.exportedAt, truncated: transcript.truncated,
      turns: transcript.turns.map((turn) => ({ turnId: turn.turnId, at: turn.at, outcome: turn.outcome, items: turn.items.filter((item) => item.kind === "user_message" || item.kind === "agent_message").map((item) => ({ itemId: item.itemId, kind: item.kind, text: redactSecrets(item.text).text, ...(item.at === undefined ? {} : { at: item.at }), ...(item.status ? { status: item.status } : {}) })) })),
    }
    // A full replacement includes deletions/undo; public viewers never retain removed content.
    await input.console.http(record.backend, `/api/${record.resource}/${encodeURIComponent(record.id)}/sync`, access.headers, { secret: record.secret, replace: true, format: "mendcode-share@1", data: publicData })
    record.syncedAt = now()
    record.truncated = exported.result.truncated
    save()
  }
  async function create(sessionId: SessionId) {
    if (!input.store.hasSession(sessionId)) throw new Error("Unknown session")
    if (policy() === "disabled") throw new Error("Sharing is disabled; choose manual or auto first")
    let record = records.get(sessionId)
    if (!record) {
      if (records.size >= 10_000) throw new Error("Share limit reached")
      const access = await input.console.access()
      const parsed = z.object({ id: z.string().min(1).max(200), url: z.string().url().max(2048), secret: z.string().min(1).max(8192) }).safeParse(await input.console.http(access.url, `/api/${access.resource}`, access.headers, { sessionID: sessionId }))
      if (!parsed.success) throw new Error("Sharing service returned invalid data")
      record = { sessionId, ...parsed.data, url: serviceLink(parsed.data.url, access.url), backend: access.url, resource: access.resource, ...(access.accountID ? { accountID: access.accountID } : {}), ...(access.orgID ? { orgID: access.orgID } : {}) }
      records.set(sessionId, record)
      save()
    }
    await sync(record)
  }
  async function remove(sessionId: SessionId) {
    const record = records.get(sessionId)
    if (record) {
      const access = await input.console.access({ url: record.backend, ...(record.accountID ? { accountID: record.accountID } : {}), ...(record.orgID ? { orgID: record.orgID } : {}) })
      await input.console.http(record.backend, `/api/${record.resource}/${encodeURIComponent(record.id)}`, access.headers, { secret: record.secret }, "DELETE")
      records.delete(sessionId)
      save()
    }
    errors.delete(sessionId)
  }
  function schedule(sessionId: SessionId) {
    if (stopped || policy() === "disabled" || (!records.has(sessionId) && policy() !== "auto")) return
    clearTimer(sessionId)
    const timer = setTimeout(() => {
      timers.delete(sessionId)
      void serial(sessionId, () => create(sessionId)).catch(() => {})
    }, input.debounceMs ?? 1000)
    timer.unref()
    timers.set(sessionId, timer)
  }
  return {
    status,
    async create(sessionId: SessionId) { await serial(sessionId, () => create(sessionId)); return status(sessionId) },
    async sync(sessionId: SessionId) { await serial(sessionId, async () => { const record = records.get(sessionId); if (!record) throw new Error("Session is not shared"); await sync(record) }); return status(sessionId) },
    async remove(sessionId: SessionId) { await serial(sessionId, () => remove(sessionId)); return status(sessionId) },
    beforeDelete: (sessionId: SessionId) => serial(sessionId, () => remove(sessionId)),
    created: schedule,
    observe(event: SessionEvent) {
      if (["item.completed", "turn.completed", "turn.cancelled", "turn.failed", "turn.interrupted", "turn.reverted", "turn.restored"].includes(event.type)) schedule(event.sessionId)
    },
    changed: schedule,
    async stop() { stopped = true; for (const timer of timers.values()) clearTimeout(timer); timers.clear(); await Promise.all([...tails.values()]) },
  }
}
