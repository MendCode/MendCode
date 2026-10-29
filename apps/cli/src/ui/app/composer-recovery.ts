import type { BlobRef } from "@mendcode/protocol"
import { liveAttachments } from "../../view/attachments"
import { PROMPT_MARGIN } from "../../view/prompt-chrome"
import { PROMPT_SEARCH_MAX_QUERY, PROMPT_SEARCH_PROMPTS, promptSearchBar, searchPrompts, type RecallEntry } from "../../view/prompt-search"
import type { QueuedPrompt } from "../../view/turn-state"
import { MOUSE_SGR } from "./constants"
import type { AppContext } from "./context"

const PRINTABLE = /^[^\x00-\x1f\x7f\x1b]+$/
/** The paging keys keep scrolling the transcript while the search bar is open. */
const SCROLL_KEYS = new Set(["\x1b[5~", "\x1b[6~", "\x1b[H", "\x1bOH", "\x1b[1~", "\x1b[F", "\x1bOF", "\x1b[4~"])
/** A second Esc inside this window (idle, empty prompt) opens the backtrack picker. */
export const BACKTRACK_ESC_MS = 2_000

/**
 * Getting text back into the prompt: a queued prompt pulled out of the queue, the queue after an interrupt, a search over
 * the project's earlier prompts, and the Esc-Esc backtrack. Everything here is local to the terminal except the daemon's
 * existing `queue.remove` and `prompt.history`.
 */
export function createComposerRecovery(ctx: AppContext, actions: {
  attachmentsOf(images: BlobRef[]): typeof ctx.state.attachments
  syncMentions(): void
  syncDraft(): void
  openBacktrack(): Promise<void>
  recallEntriesOf(result: Record<string, unknown> | undefined): RecallEntry[]
  keepDiscarded(options: { text?: string; track?: boolean }): Promise<void>
}) {
  const { input, state, editor, requestFrame, say, fail, now } = ctx

  /** What the prompt changed to: popups and the draft follow the text. */
  function refresh() {
    state.suggestion = 0
    actions.syncMentions()
    actions.syncDraft()
    requestFrame()
  }

  /** The text of a queued entry the way it was typed; undefined when only the 200-character preview is known and it may be cut. */
  function queuedPrompt(queueId: (typeof state.transcript.queue)[number]["queueId"]): QueuedPrompt | undefined {
    const known = state.turnState.queuedPrompt(queueId)
    if (known) return known
    const entry = state.transcript.queue.find((candidate) => candidate.queueId === queueId)
    if (!entry || entry.preview.length >= 200) return undefined
    return { text: entry.preview, attachments: [], kind: state.turnState.isShellQueued(queueId) ? "shell" : "message" }
  }

  /** Puts a taken entry in front of what is in the prompt (so pulling back several rebuilds the order they were queued in). */
  function place(entries: readonly QueuedPrompt[]) {
    const shell = entries.find((entry) => entry.kind === "shell")
    if (shell) state.shellMode = true
    const typed = editor.text
    editor.replaceAll([...entries.map((entry) => entry.text), ...(typed ? [typed] : [])].join("\n"))
    state.attachments = [...entries.flatMap((entry) => actions.attachmentsOf(entry.attachments)), ...state.attachments]
    refresh()
  }

  /** What stops an entry from coming back into the prompt, or undefined when it can. */
  function refusal(entry: QueuedPrompt | undefined) {
    if (!entry) return "cannot read that queued message"
    if (entry.kind === "notice" || entry.kind === "compact") return "that queued item is not a prompt · ctrl+k drops it"
    if (entry.kind === "shell" && !editor.isEmpty() && !state.shellMode) return "clear the prompt first: that is a shell command"
    if (entry.kind === "message" && state.shellMode) return "leave shell mode first: that is a message"
    return undefined
  }

  /** ↑ on an empty prompt edits the queue instead of the prompt history while its newest entry is one that can come back. */
  function canEditQueued() {
    const last = state.transcript.queue.at(-1)
    return state.page === "chat" && !input.remote?.readOnly && !!last && refusal(queuedPrompt(last.queueId)) === undefined
  }

  /**
   * After an interrupt the daemon holds the queue; sending its first queued entry next releases the rest behind it, so what was
   * queued still runs once the cancelled turn has stopped. Undefined when nothing is queued; else whether the send was taken.
   */
  async function sendQueueNext() {
    const first = state.transcript.queue[0]
    if (!first || input.remote?.readOnly) return undefined
    const reply = await input.send({ type: "queue.promote", sessionId: state.sessionId, queueId: first.queueId })
    if (!reply.ok && reply.error.code !== "target_mismatch") fail(reply.error.message)
    return reply.ok
  }

  /** alt+up (or ↑ on an empty prompt): the newest queued prompt leaves the queue and joins the prompt. */
  async function editQueued() {
    if (state.page !== "chat") return
    if (input.remote?.readOnly) return say("queue editing disabled while read-only", "warning")
    const last = state.transcript.queue.at(-1)
    if (!last) return say("nothing queued")
    const entry = queuedPrompt(last.queueId)
    const refused = refusal(entry)
    if (refused) return say(refused, "warning")
    const reply = await input.send({ type: "queue.remove", sessionId: state.sessionId, queueId: last.queueId })
    if (!reply.ok) return reply.error.code === "target_mismatch" ? say("that message already started", "warning") : fail(reply.error.message)
    place([entry!])
    say("queued prompt back in the editor", "success", { quiet: true })
  }

  /**
   * After an interrupt: every queued message goes back into the prompt in the order it was queued, instead of waiting in a
   * held queue. Shell lines, notices and compactions stay queued.
   */
  async function restoreQueue() {
    if (input.remote?.readOnly || state.shellMode) return
    const taken: QueuedPrompt[] = []
    for (const queued of [...state.transcript.queue]) {
      const entry = queuedPrompt(queued.queueId)
      if (entry?.kind !== "message") continue
      const reply = await input.send({ type: "queue.remove", sessionId: state.sessionId, queueId: queued.queueId })
      if (reply.ok) taken.push(entry)
    }
    if (!taken.length) return
    place(taken)
    say(`${taken.length} queued prompt${taken.length === 1 ? "" : "s"} back in the editor`, "success", { quiet: true })
  }

  /** True when the transcript holds a prompt of the user's to go back to. */
  function hasPrompts() {
    return state.transcript.blocks().some((block) => block.kind === "user_message" && !block.notice)
  }

  /** Esc on an idle, empty prompt: the first press arms, the second opens the backtrack picker. True when it took the key. */
  function backtrackEscape() {
    if (!state.tuiProfile.escBacktrack || state.page !== "chat" || !editor.isEmpty() || liveAttachments(state.attachments, editor.text).length > 0 || state.shellMode) return false
    if (state.transcript.pendingRequests.length > 0 || input.remote?.readOnly) return false
    if (state.backtrackArmedAt > 0 && now() - state.backtrackArmedAt <= BACKTRACK_ESC_MS) {
      state.backtrackArmedAt = 0
      void openBacktrack()
      return true
    }
    if (!hasPrompts()) return false
    state.backtrackArmedAt = now()
    say("esc again to edit an earlier prompt")
    return true
  }

  /** The shown match goes in the prompt (a shell line in shell mode); no match puts back what was there before. */
  function show() {
    const search = state.promptSearch
    if (!search) return
    const index = search.matches[search.at]
    editor.replaceAll(index === undefined ? search.draft : search.prompts[index]!)
    state.shellMode = index === undefined ? search.shell ?? false : search.kinds?.[index] === "shell"
    requestFrame()
  }

  /** `/prompt-history clear-drafts`: every unsent draft kept in the project's history goes. */
  async function clearDrafts() {
    if (!input.directory) return say("no project to clear drafts in", "warning")
    const reply = await input.send({ type: "prompt.history.delete", directory: input.directory, drafts: true })
    if (!reply.ok) return fail(reply.error.message)
    state.recall.prompts = undefined
    const removed = Number(reply.result?.removed ?? 0)
    say(removed ? `${removed} draft${removed === 1 ? "" : "s"} cleared from the history` : "no drafts in the history", removed ? "success" : "info")
  }

  /** alt+r, `/prompt-history [text]`: search the project's earlier prompts; the match shows in the prompt as you type. */
  async function openSearch(query = "") {
    if (state.page !== "chat" || state.promptSearch) return
    if (input.remote) return say("prompt history is local only", "warning")
    if (!input.directory) return say("no project to search prompts in", "warning")
    if (query.trim() === "clear-drafts") return clearDrafts()
    const reply = await input.send({ type: "prompt.history", directory: input.directory, limit: PROMPT_SEARCH_PROMPTS })
    if (!reply.ok) return fail(reply.error.message)
    const entries = actions.recallEntriesOf(reply.result)
    if (!entries.length) return say("no earlier prompts in this project")
    const text = query.slice(0, PROMPT_SEARCH_MAX_QUERY)
    const prompts = entries.map((entry) => entry.text)
    state.promptSearch = { query: text, prompts, kinds: entries.map((entry) => entry.kind), ids: entries.map((entry) => entry.id), matches: searchPrompts(prompts, text), at: 0, draft: editor.text, shell: state.shellMode }
    state.shortcuts = false
    show()
  }

  /** ctrl+d on the shown entry (twice): it is deleted from the project's history and the list moves on. */
  async function deleteShown() {
    const search = state.promptSearch
    if (!search) return
    const index = search.matches[search.at]
    const id = index === undefined ? undefined : search.ids?.[index]
    if (index === undefined || id === undefined || !input.directory) return
    if (!search.confirm) {
      search.confirm = true
      return
    }
    search.confirm = false
    const reply = await input.send({ type: "prompt.history.delete", directory: input.directory, entryId: id })
    if (!reply.ok) return fail(reply.error.message)
    if (state.promptSearch !== search) return
    const keptIds = search.prompts.flatMap((_, at) => (at === index ? [] : [at]))
    search.prompts = keptIds.map((at) => search.prompts[at]!)
    if (search.kinds) search.kinds = keptIds.map((at) => search.kinds![at]!)
    if (search.ids) search.ids = keptIds.map((at) => search.ids![at])
    search.matches = searchPrompts(search.prompts, search.query)
    search.at = Math.min(search.at, Math.max(0, search.matches.length - 1))
    state.recall.prompts = undefined
    show()
  }

  function closeSearch(keep: boolean) {
    const search = state.promptSearch
    if (!search) return
    state.promptSearch = undefined
    if (!keep) {
      editor.replaceAll(search.draft)
      state.shellMode = search.shell ?? false
    } else if (editor.text !== search.draft) {
      // The match replaces what was typed before the search: that text stays reachable as a draft.
      void actions.keepDiscarded({ text: search.draft, track: false })
    }
    state.recall.index = -1
    refresh()
  }

  function change(query: string) {
    const search = state.promptSearch
    if (!search) return
    search.query = query.slice(0, PROMPT_SEARCH_MAX_QUERY)
    search.matches = searchPrompts(search.prompts, search.query)
    search.at = 0
    search.confirm = false
    show()
  }

  function step(delta: number) {
    const search = state.promptSearch
    if (!search || !search.matches.length) return
    search.confirm = false
    search.at = Math.max(0, Math.min(search.matches.length - 1, search.at + delta))
    show()
  }

  /** Handles a key while the search bar is open; false lets it through (the wheel and the paging keys). */
  async function searchKey(raw: string) {
    const search = state.promptSearch
    if (!search) return false
    if (MOUSE_SGR.test(raw) || SCROLL_KEYS.has(raw)) return false
    if (raw === "\x1b" || raw === "\x03") closeSearch(false)
    else if (raw === "\r" || raw === "\t") closeSearch(true)
    else if (raw === "\x1b[A" || raw === "\x1bOA" || raw === "\x12" || raw === "\x10") step(1)
    else if (raw === "\x1b[B" || raw === "\x1bOB" || raw === "\x0e") step(-1)
    else if (raw === "\x7f" || raw === "\b") change([...search.query].slice(0, -1).join(""))
    else if (raw === "\x15") change("")
    else if (raw === "\x04") await deleteShown()
    else if (PRINTABLE.test(raw)) change(search.query + raw)
    requestFrame()
    return true
  }

  /** Pasted text goes into the query as one line. */
  function searchPaste(text: string) {
    const search = state.promptSearch
    if (!search) return false
    change(search.query + text.replace(/\s+/g, " "))
    requestFrame()
    return true
  }

  /** The bar row for a frame `width` wide. */
  function searchRow(width: number) {
    return state.promptSearch ? promptSearchBar({ state: state.promptSearch, width, margin: PROMPT_MARGIN }) : undefined
  }

  /** The backtrack picker (Esc-Esc, `/backtrack`). Reverting to a prompt while a turn runs stops that turn first, as /undo does. */
  async function openBacktrack() {
    if (state.page !== "chat") return
    if (input.remote?.readOnly) return say("backtrack disabled while read-only", "warning")
    if (!hasPrompts()) return say("no earlier prompt to go back to")
    await actions.openBacktrack()
  }

  return { editQueued, canEditQueued, sendQueueNext, restoreQueue, backtrackEscape, openBacktrack, openSearch, searchKey, searchPaste, searchRow }
}
