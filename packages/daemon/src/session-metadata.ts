import type { ModelChoice, ModelRole, SessionEvent, SessionId, Settings } from "@mendcode/protocol"
import type { Store } from "@mendcode/store"
import { redactSecrets } from "@mendcode/protocol"
import { excerpt } from "./session-recall"

/** The message on which a generated first title is looked at again. */
const EARLY_RETITLE = 3
/** The end of the conversation a summary reads: about 6k tokens. */
const SUMMARY_INPUT_CHARS = 24_000
const SUMMARY_SYSTEM = "Summarize the latest work and unresolved tasks concisely. Return only the summary."
const TITLE_SYSTEM = "Return only a descriptive conversation title in 3 to 5 words."
const AUXILIARY_TIMEOUT_MS = 30_000

type AuxiliaryConfig = import("@mendcode/engine-native").AgentProfile & { disable?: boolean | undefined }

/**
 * A model's answer as a title: its first line without reasoning tags, quotes or Markdown marks. A model handed a message that opens
 * with a heading often answers with that heading (`# MISSION: …`); the title is the words, not the Markdown.
 */
export function cleanTitle(raw: string): string {
  const line = raw.replace(/<think>[\s\S]*?<\/think>/g, "").trim().split("\n")[0]!
  return line.replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)+/, "").replace(/\*\*|__|`/g, "").trim().replace(/^["'“”]+|["'“”]+$/g, "").trim().slice(0, 200)
}

/**
 * Auxiliary roles never block a turn or overwrite a title renamed while their request was running.
 * The title is the only call a finished turn can start. The summary is written on demand, when a reader asks for it (`summary`), and
 * kept with the sequence it read up to: asked again before the session moved on, it is the saved text and no call.
 */
export function createSessionMetadata(input: {
  store: Store
  complete?: ((input: { system: string; prompt: string; model?: ModelChoice; signal: AbortSignal }) => Promise<string>) | undefined
  model(id: SessionId, role: ModelRole): ModelChoice
  settings(): Settings
  changed?(id: SessionId): void
  agent?(id: SessionId, role: "title" | "summary"): AuxiliaryConfig | undefined
}) {
  const pending = new Map<SessionId, AbortController>()
  const queued = new Map<SessionId, SessionEvent>()
  const summarizing = new Map<SessionId, { controller: AbortController; done: Promise<string | undefined> }>()
  let stopped = false
  const configOf = (id: SessionId, role: "title" | "summary") => input.agent?.(id, role) ?? input.settings().agent?.[role]
  function modelOf(id: SessionId, role: "title" | "summary", config: ReturnType<typeof configOf>): ModelChoice {
    const fallback = input.model(id, role)
    return { ...(config?.model ? { model: config.model } : fallback), ...(config?.effort ? { effort: config.effort } : {}), ...(config?.model && config.variant ? { variant: config.variant } : {}), parameters: { ...fallback.parameters, ...config?.options, ...(config?.temperature !== undefined ? { temperature: config.temperature } : {}), ...(config?.top_p !== undefined ? { top_p: config.top_p } : {}) } }
  }
  function observe(event: SessionEvent) {
    if (event.type !== "turn.completed" || !input.complete || stopped) return
    if (pending.has(event.sessionId) || pending.size >= 8) {
      if (queued.has(event.sessionId) || queued.size < 16) queued.set(event.sessionId, event)
      return
    }
    const id = event.sessionId
    const info = input.store.sessionInfo(id)
    if (!info || info.parentId) return
    const turns = input.store.turns.list(id).filter((turn) => turn.itemId && turn.status === "completed" && !turn.notice && !turn.shell && !turn.reverted)
    const count = turns.length
    if (!count) return
    const titleBefore = info.title
    const generated = input.store.meta.get(`session.title.generated:${id}`)
    const manual = input.store.meta.get(`session.title.manual:${id}`)
    const initial = count === 1 && !generated && !manual
    const titledAt = Number(input.store.meta.get(`session.title.turn:${id}`) ?? 0)
    // A first title often comes from a greeting ("hi" becomes "A Friendly Conversation Begins"): it is looked at again on the third
    // message, once the work has a topic, and then every 15 messages.
    const early = count === EARLY_RETITLE && titledAt < EARLY_RETITLE
    const refresh = (early || Math.floor(count / 15) > Math.floor(titledAt / 15)) && (!generated || generated === titleBefore) && !manual
    const config = configOf(id, "title")
    if (!initial && !refresh || config?.disable) return
    const human = turns.slice(-15).map((turn) => {
      const item = input.store.readAfter(id, turn.seq - 1, 10).find((event) => event.type === "item.completed" && event.itemId === turn.itemId)
      return item?.type === "item.completed" ? item.text ?? turn.preview : turn.preview
    })
    const prompt = initial ? human[0] ?? transcriptOf(id) : `Current title: ${titleBefore}\nName the topic these messages are about, not the opening greeting; return the current title unchanged if it still fits.\nLatest user messages:\n${human.join("\n").slice(-24_000)}`
    const controller = new AbortController()
    pending.set(id, controller)
    const timer = setTimeout(() => controller.abort(), AUXILIARY_TIMEOUT_MS)
    void (async () => {
      const text = redactSecrets(await input.complete!({ system: config?.prompt || TITLE_SYSTEM, prompt: prompt.slice(0, 24_000), model: modelOf(id, "title", config), signal: controller.signal })).text.trim()
      if (controller.signal.aborted || !text || !input.store.hasSession(id)) return
      const title = cleanTitle(text)
      if (title && input.store.sessionInfo(id)?.title === titleBefore && !input.store.meta.get(`session.title.manual:${id}`)) {
        input.store.renameSession(id, title)
        input.store.meta.set(`session.title.generated:${id}`, title)
        input.store.meta.set(`session.title.turn:${id}`, String(count))
        input.changed?.(id)
      }
    })().catch(() => {}).finally(() => {
      clearTimeout(timer)
      pending.delete(id)
      const next = [...queued.entries()].find(([id]) => !pending.has(id))
      if (next) { queued.delete(next[0]); observe(next[1]) }
    })
  }
  /** The end of the conversation as plain text: the completed items of the last 500 events. */
  function transcriptOf(id: SessionId) {
    const events = input.store.readAfter(id, Math.max(0, (input.store.lastSeq(id) ?? 0) - 500), 500)
    return events.filter((event) => event.type === "item.completed" && event.text).map((event) => (event as { text?: string }).text).join("\n").slice(-SUMMARY_INPUT_CHARS)
  }
  /** The saved summary, when it was written at the session's current sequence. */
  function freshSummary(id: SessionId) {
    const saved = input.store.meta.get(`session.summary:${id}`) || undefined
    const at = input.store.meta.get(`session.summary.seq:${id}`)
    return { saved, fresh: saved !== undefined && at === String(input.store.lastSeq(id) ?? 0) }
  }
  /**
   * The session's summary for a reader that shows it. One completion when the session moved on since the saved one (or none is
   * saved); concurrent readers share it. The saved text, and no call, when nothing changed, the summary agent is disabled or the
   * engine has no completions. The caller checks the tier of the feature that shows it.
   */
  function summary(id: SessionId): Promise<string | undefined> {
    const { saved, fresh } = freshSummary(id)
    if (fresh || !input.complete || stopped || !input.store.hasSession(id)) return Promise.resolve(saved)
    const running = summarizing.get(id)
    if (running) return running.done
    const config = configOf(id, "summary")
    if (config?.disable) return Promise.resolve(saved)
    const seq = input.store.lastSeq(id) ?? 0
    const transcript = transcriptOf(id)
    if (!transcript.trim()) return Promise.resolve(saved)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), AUXILIARY_TIMEOUT_MS)
    const done = (async () => {
      try {
        const text = redactSecrets(await input.complete!({ system: config?.prompt || SUMMARY_SYSTEM, prompt: redactSecrets(transcript).text, model: modelOf(id, "summary", config), signal: controller.signal })).text.trim().slice(0, 500)
        if (controller.signal.aborted || !text || !input.store.hasSession(id)) return saved
        input.store.meta.set(`session.summary:${id}`, text)
        input.store.meta.set(`session.summary.seq:${id}`, String(seq))
        input.changed?.(id)
        return text
      } catch { return saved }
      finally { clearTimeout(timer); summarizing.delete(id) }
    })()
    summarizing.set(id, { controller, done })
    return done
  }
  async function regenerate(id: SessionId): Promise<boolean> {
    if (!input.complete || stopped || pending.has(id)) return false
    const info = input.store.sessionInfo(id)
    const config = configOf(id, "title")
    if (!info || config?.disable) return false
    const controller = new AbortController()
    pending.set(id, controller)
    const manual = input.store.meta.get(`session.title.manual:${id}`)
    const timer = setTimeout(() => controller.abort(), AUXILIARY_TIMEOUT_MS)
    try {
      const prompt = input.store.recall.page(id, Number.MAX_SAFE_INTEGER, 20).filter((item) => item.kind === "user_message").reverse().map((item) => excerpt(input.store.recall.chunks(item), 1200)?.text ?? "").join("\n").slice(-24_000)
      if (!prompt.trim()) return false
      const fallback = input.model(id, "title")
      const model = { ...fallback, ...(config?.model ? { model: config.model } : {}), ...(config?.effort ? { effort: config.effort } : {}) }
      const raw = await Promise.race([
        input.complete({ system: config?.prompt || TITLE_SYSTEM, prompt: redactSecrets(prompt).text, model, signal: controller.signal }),
        new Promise<never>((_, reject) => controller.signal.addEventListener("abort", () => reject(new Error("Title generation cancelled")), { once: true })),
      ])
      const title = cleanTitle(redactSecrets(raw).text)
      if (controller.signal.aborted || !title || input.store.sessionInfo(id)?.title !== info.title || input.store.meta.get(`session.title.manual:${id}`) !== manual) return false
      input.store.renameSession(id, title)
      input.store.meta.set(`session.title.manual:${id}`, "")
      input.store.meta.set(`session.title.generated:${id}`, title)
      input.changed?.(id)
      return true
    } catch { return false }
    finally { clearTimeout(timer); pending.delete(id) }
  }
  return { observe, summary, regenerate, stop() { stopped = true; queued.clear(); for (const controller of pending.values()) controller.abort(); for (const running of summarizing.values()) running.controller.abort() } }
}
