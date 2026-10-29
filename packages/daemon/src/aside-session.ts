import type { AsideThread, PermissionMode, RequestId, SessionEvent, SessionId } from "@mendcode/protocol"

/**
 * `/btw` as a hidden side session (docs/btw.md): a child of the main session that runs the read-only `explore` agent on the
 * aside model, so a side question can read files, search and run commands, retries the provider like any turn, and says which
 * model answered. The panel's thread is built from the side session's events; nothing of it enters the main session.
 */

/** The agent a side session runs: read, search, list, shell and the web, no edits. */
export const ASIDE_AGENT = "explore"
/** The thread keeps this many entries (questions, answers, tool lines); the oldest go first. */
const MAX_ENTRIES = 64
const MAX_TEXT = 24_000

export const ASIDE_BRIEF = [
  "You are the side chat (/btw) of a coding session the user is running in parallel. The <session> blocks below show that session's",
  "transcript, read-only: it keeps running, and nothing you say or do enters it. Answer the user's side questions about it.",
  "You may read files, search and run read-only commands (git status, git log, git diff, ls) to check facts before answering. Never",
  "change files, install, commit, push or start long-running processes. A command that needs approval is refused here: say what the",
  "user can run instead. Be brief and direct. Answer in the language of the question.",
].join(" ")

const sideKey = (main: SessionId) => `aside.session:${main}`
const mainKey = (side: SessionId) => `aside.main:${side}`
const seenKey = (main: SessionId) => `aside.seen:${main}`

/** `cleared`: `/btw clear` stopped it; its end publishes nothing and the side session is deleted. */
type Live = { main: SessionId; thread: AsideThread; items: Map<string, number>; done(thread: AsideThread): void; cleared?: true }

export function createAsideSessions(deps: {
  meta: { get(key: string): string | undefined; set(key: string, value: string): void }
  hasSession(id: SessionId): boolean
  directory(id: SessionId): string | undefined
  /** A new hidden child of `main` in `directory`, running `ASIDE_AGENT`. */
  create(main: SessionId, directory: string): SessionId
  /** Puts the aside model on the side session and returns its label for the panel. */
  model(main: SessionId, side: SessionId): string | undefined
  /** The main session's transcript after `afterSeq` (the last part of it when there is a lot), and the last seq it covers. */
  transcript(main: SessionId, afterSeq: number): { text: string; seq: number }
  permission(main: SessionId): PermissionMode
  submit(side: SessionId, text: string, mode: PermissionMode): Promise<void>
  cancel(side: SessionId): Promise<void>
  deny(side: SessionId, requestId: RequestId, reason: string): void
  remove(side: SessionId): void
  /** The same, once the turn that just ended has let the session go. */
  removeLater(side: SessionId): void
  /** The panel's thread for `main`: read, and written (published to the terminals; `persist` saves it to disk). */
  thread(main: SessionId): AsideThread
  save(main: SessionId, thread: AsideThread, persist: boolean): void
  redact(text: string): string
}) {
  const live = new Map<SessionId, Live>()

  const sideOf = (main: SessionId): SessionId | undefined => {
    const side = deps.meta.get(sideKey(main)) as SessionId | undefined
    return side && deps.hasSession(side) ? side : undefined
  }

  /** The line under the thread while the answer runs (a tool, a retry); none clears it. */
  function setStatus(entry: Live, status?: string) {
    const { status: _status, ...rest } = entry.thread
    entry.thread = status ? { ...rest, status: status.slice(0, 300) } : rest
  }

  function publish(entry: Live, persist: boolean) {
    if (entry.cleared) return
    const messages = entry.thread.messages
    if (messages.length > MAX_ENTRIES) {
      const drop = messages.length - MAX_ENTRIES
      messages.splice(0, drop)
      for (const [item, index] of entry.items) entry.items.set(item, index - drop)
    }
    deps.save(entry.main, { ...entry.thread, messages: messages.map((message) => ({ ...message })) }, persist)
  }

  function finish(side: SessionId, entry: Live, error?: string) {
    live.delete(side)
    setStatus(entry)
    entry.thread = { ...entry.thread, busy: false, ...(error ? { error: error.slice(0, 500) } : {}) }
    publish(entry, true)
    entry.done(entry.thread)
    if (entry.cleared) deps.removeLater(side)
  }

  return {
    /** Whether `id` is a side session (the engine runs it as a child: no orientation, no recall, the agent's tools). */
    isAside: (id: SessionId) => Boolean(deps.meta.get(mainKey(id))),
    /** The side session of `main`, when it has one. */
    sideOf,
    busy: (main: SessionId) => [...live.values()].some((entry) => entry.main === main),

    /** Asks the side session; resolves with the thread once its turn ends. */
    async ask(main: SessionId, question: string): Promise<AsideThread> {
      const directory = deps.directory(main)
      if (!directory) throw new Error("unknown session")
      let side = sideOf(main)
      // A session moved to another folder (/cd) gets a side session there.
      if (side && deps.directory(side) !== directory) side = undefined
      const fresh = !side
      if (!side) {
        side = deps.create(main, directory)
        deps.meta.set(sideKey(main), side)
        deps.meta.set(mainKey(side), main)
        deps.meta.set(seenKey(main), "0")
      }
      const model = deps.model(main, side)
      const update = deps.transcript(main, Number(deps.meta.get(seenKey(main)) ?? 0))
      deps.meta.set(seenKey(main), String(update.seq))
      const block = fresh ? `<session>\n${update.text || "(nothing yet)"}\n</session>` : update.text ? `<session_update>\n${update.text}\n</session_update>` : "(the session has nothing new)"
      const prompt = `${fresh ? `${ASIDE_BRIEF}\n\n` : ""}${block}\n\nSide question: ${question}`
      const previous = deps.thread(main)
      const { error: _error, status: _status, ...kept } = previous
      const entry: Live = { main, thread: { ...kept, messages: [...kept.messages, { role: "user", text: question }], busy: true, ...(model ? { model } : {}) }, items: new Map(), done: () => undefined }
      const ended = new Promise<AsideThread>((resolve) => { entry.done = resolve })
      live.set(side, entry)
      publish(entry, true)
      try {
        await deps.submit(side, prompt, deps.permission(main))
      } catch (error) {
        finish(side, entry, error instanceof Error ? error.message : String(error))
      }
      return ended
    },

    /** Stops a running answer; `forget` also deletes the side session (its history goes with it). */
    async clear(main: SessionId, forget: boolean) {
      const side = sideOf(main)
      if (!side) return
      if (forget) deps.meta.set(sideKey(main), "")
      const running = live.get(side)
      if (running) {
        if (forget) running.cleared = true
        await deps.cancel(side)
      } else if (forget) deps.remove(side)
    },

    observe(event: SessionEvent) {
      const entry = live.get(event.sessionId)
      if (!entry) return
      const messages = entry.thread.messages
      switch (event.type) {
        case "item.started": {
          if (event.kind === "agent_message") {
            entry.items.set(event.itemId, messages.push({ role: "assistant", text: "" }) - 1)
            setStatus(entry)
          } else if (event.kind === "tool_call") {
            const tool = typeof event.meta?.tool === "string" ? event.meta.tool.replace(/\s+/g, " ").trim() : "tool"
            entry.items.set(event.itemId, messages.push({ role: "tool", text: tool.slice(0, 200) }) - 1)
            setStatus(entry, `Running ${tool.split(":")[0]!.trim()}…`)
          } else if (event.kind === "reasoning") setStatus(entry, "Thinking…")
          else return
          return publish(entry, false)
        }
        case "item.delta": {
          const index = entry.items.get(event.itemId)
          if (index === undefined || messages[index]?.role !== "assistant") return
          messages[index]!.text = (messages[index]!.text + event.text).slice(0, MAX_TEXT)
          return publish(entry, false)
        }
        case "item.completed": {
          const index = entry.items.get(event.itemId)
          if (index === undefined || !messages[index]) return
          entry.items.delete(event.itemId)
          const message = messages[index]!
          if (message.role === "assistant") message.text = deps.redact((event.text ?? message.text).trim()).slice(0, MAX_TEXT)
          else if (event.status !== "ok") message.text = `${message.text} · ${event.status}`.slice(0, 240)
          setStatus(entry)
          return publish(entry, false)
        }
        case "turn.retrying":
          setStatus(entry, `Retrying (attempt ${event.attempt}): ${event.message}`)
          return publish(entry, false)
        case "server.request":
          // Nobody answers an approval in the side chat: the request is refused and the model says what to run instead.
          messages.push({ role: "tool", text: "needed approval: refused in the side chat" })
          deps.deny(event.sessionId, event.requestId, "The side chat cannot ask for approval. Do not retry: answer with what you know and tell the user what to run in the main chat.")
          return publish(entry, false)
        case "turn.completed":
          return finish(event.sessionId, entry)
        case "turn.failed":
          return finish(event.sessionId, entry, event.error.message)
        case "turn.cancelled":
          return finish(event.sessionId, entry, "Side chat stopped")
        case "turn.interrupted":
          return finish(event.sessionId, entry, "Side chat interrupted")
      }
    },
  }
}
export type AsideSessions = ReturnType<typeof createAsideSessions>
