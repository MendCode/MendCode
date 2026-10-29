import type { ModelChoice, ModelRole, SessionEvent, SessionId, Settings } from "@mendcode/protocol"
import type { Store } from "@mendcode/store"
import { redactSecrets } from "@mendcode/protocol"
import { excerpt } from "./session-recall"

/** The message on which a generated first title is looked at again. */
const EARLY_RETITLE = 3

/**
 * A model's answer as a title: its first line without reasoning tags, quotes or Markdown marks. A model handed a message that opens
 * with a heading often answers with that heading (`# MISSION: …`); the title is the words, not the Markdown.
 */
export function cleanTitle(raw: string): string {
  const line = raw.replace(/<think>[\s\S]*?<\/think>/g, "").trim().split("\n")[0]!
  return line.replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)+/, "").replace(/\*\*|__|`/g, "").trim().replace(/^["'“”]+|["'“”]+$/g, "").trim().slice(0, 200)
}

/** Auxiliary roles never block a turn or overwrite a title renamed while their request was running. */
export function createSessionMetadata(input: {
  store: Store
  complete?: ((input: { system: string; prompt: string; model?: ModelChoice; signal: AbortSignal }) => Promise<string>) | undefined
  model(id: SessionId, role: ModelRole): ModelChoice
  settings(): Settings
  changed?(id: SessionId): void
  agent?(id: SessionId, role: "title" | "summary"): import("@mendcode/engine-native").AgentProfile & { disable?: boolean | undefined } | undefined
}) {
  const pending = new Map<SessionId, AbortController>()
  const queued = new Map<SessionId, SessionEvent>()
  let stopped = false
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
    const controller = new AbortController()
    pending.set(id, controller)
    const timer = setTimeout(() => controller.abort(), 30_000)
    const titleBefore = info.title
    const generated = input.store.meta.get(`session.title.generated:${id}`)
    const initial = count === 1 && !generated && !input.store.meta.get(`session.title.manual:${id}`)
    const titledAt = Number(input.store.meta.get(`session.title.turn:${id}`) ?? 0)
    // A first title often comes from a greeting ("hi" becomes "A Friendly Conversation Begins"): it is looked at again on the third
    // message, once the work has a topic, and then every 15 messages.
    const early = count === EARLY_RETITLE && titledAt < EARLY_RETITLE
    const refresh = (early || Math.floor(count / 15) > Math.floor(titledAt / 15)) && (!generated || generated === titleBefore) && !input.store.meta.get(`session.title.manual:${id}`)
    const events = input.store.readAfter(id, Math.max(0, (input.store.lastSeq(id) ?? 0) - 500), 500)
    const transcript = events.filter((event) => event.type === "item.completed" && event.text).map((event) => (event as { text?: string }).text).join("\n").slice(-24_000)
    const human = turns.slice(-15).map((turn) => {
      const item = input.store.readAfter(id, turn.seq - 1, 10).find((event) => event.type === "item.completed" && event.itemId === turn.itemId)
      return item?.type === "item.completed" ? item.text ?? turn.preview : turn.preview
    })
    const titlePrompt = initial ? human[0] ?? transcript : `Current title: ${titleBefore}\nName the topic these messages are about, not the opening greeting; return the current title unchanged if it still fits.\nLatest user messages:\n${human.join("\n").slice(-24_000)}`
    void (async () => {
      for (const role of ["title", "summary"] as const) {
        const config = input.agent?.(id, role) ?? input.settings().agent?.[role]
        if (controller.signal.aborted || role === "title" && !initial && !refresh || config?.disable) continue
        const fallback = input.model(id, role)
        const model = { ...(config?.model ? { model: config.model } : fallback), ...(config?.effort ? { effort: config.effort } : {}), ...(config?.model && config.variant ? { variant: config.variant } : {}), parameters: { ...fallback.parameters, ...config?.options, ...(config?.temperature !== undefined ? { temperature: config.temperature } : {}), ...(config?.top_p !== undefined ? { top_p: config.top_p } : {}) } }
        let text: string
        try {
          text = redactSecrets(await input.complete!({ system: config?.prompt || (role === "title" ? "Return only a descriptive conversation title in 3 to 5 words." : "Summarize the latest work and unresolved tasks concisely. Return only the summary."), prompt: role === "title" ? titlePrompt.slice(0, 24_000) : transcript, model, signal: controller.signal })).text.trim()
        } catch { continue }
        if (controller.signal.aborted || !text || !input.store.hasSession(id)) continue
        if (role === "title") {
          const title = cleanTitle(text)
          if (title && input.store.sessionInfo(id)?.title === titleBefore && !input.store.meta.get(`session.title.manual:${id}`)) {
            input.store.renameSession(id, title)
            input.store.meta.set(`session.title.generated:${id}`, title)
            input.store.meta.set(`session.title.turn:${id}`, String(count))
            input.changed?.(id)
          }
        } else {
          input.store.meta.set(`session.summary:${id}`, text.slice(0, 500))
          input.changed?.(id)
        }
      }
    })().catch(() => {}).finally(() => {
      clearTimeout(timer)
      pending.delete(id)
      const next = [...queued.entries()].find(([id]) => !pending.has(id))
      if (next) { queued.delete(next[0]); observe(next[1]) }
    })
  }
  async function regenerate(id: SessionId): Promise<boolean> {
    if (!input.complete || stopped || pending.has(id)) return false
    const info = input.store.sessionInfo(id)
    const config = input.agent?.(id, "title") ?? input.settings().agent?.title
    if (!info || config?.disable) return false
    const controller = new AbortController()
    pending.set(id, controller)
    const manual = input.store.meta.get(`session.title.manual:${id}`)
    const timer = setTimeout(() => controller.abort(), 30_000)
    try {
      const prompt = input.store.recall.page(id, Number.MAX_SAFE_INTEGER, 20).filter((item) => item.kind === "user_message").reverse().map((item) => excerpt(input.store.recall.chunks(item), 1200)?.text ?? "").join("\n").slice(-24_000)
      if (!prompt.trim()) return false
      const fallback = input.model(id, "title")
      const model = { ...fallback, ...(config?.model ? { model: config.model } : {}), ...(config?.effort ? { effort: config.effort } : {}) }
      const raw = await Promise.race([
        input.complete({ system: config?.prompt || "Return only a descriptive conversation title in 3 to 5 words.", prompt: redactSecrets(prompt).text, model, signal: controller.signal }),
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
  return { observe, regenerate, stop() { stopped = true; queued.clear(); for (const controller of pending.values()) controller.abort() } }
}
