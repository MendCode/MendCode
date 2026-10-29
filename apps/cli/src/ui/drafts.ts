import type { BlobRef, SessionId } from "@mendcode/protocol"
import { MAX_DRAFT_CHARS } from "@mendcode/protocol/wire"
import type { CommandInput, CommandReply } from "@mendcode/client"
import { buildCommentDraft, parseCommentDraft, type ReplyComment } from "../view/reply-comments"
import { draftSizeLabel } from "../view/session-label"

/** Quiet time after the last keystroke before the draft is saved. */
export const DRAFT_DEBOUNCE_MS = 400

export type DraftContent = { text: string; images: BlobRef[] }

/**
 * Pending comments (docs/editor.md) are saved inside the draft's text as the wire envelope with a few more attributes
 * (`buildCommentDraft`): no protocol field, so an older daemon stores and returns them as text, and an older terminal that restores
 * one gets an envelope it can send as it is. `view` says what the comments of a session are right now; the draft's own text is `draft`
 * while a comment is typed in its place, else the prompt's.
 */
export type CommentsView = { comments: readonly ReplyComment[]; parked: boolean; lastItemId?: string | undefined; draft?: string | undefined }
export type RestoredDraft = DraftContent & { comments?: { list: ReplyComment[]; parked: boolean } }

/**
 * An unsent draft of another session, as `draft.list` reports it (the preview is one line; the text comes from `draft.get`).
 * `chars` and `preview` are of what was typed, tokens such as `[Image #1]` left out; `attachments` and `images` say what came with it.
 * An older daemon sends no `images`: its drafts count as attachments.
 */
export type UnsentDraft = { sessionId: SessionId; title: string; chars: number; attachments: number; images?: number; preview: string; updatedAt: number }

/** `1.2k chars`, `340 chars`. */
export const charsLabel = (chars: number) => (chars >= 1000 ? `${(chars / 1000).toFixed(1).replace(/\.0$/, "")}k chars` : `${chars} chars`)

/** What a draft holds, as the notice says it: `340 chars`, `340 chars, 1 image`, `2 attachments`. */
export const draftSize = (draft: Pick<UnsentDraft, "chars" | "attachments" | "images">) => draftSizeLabel({ chars: draft.chars, attachments: draft.attachments, images: draft.images ?? 0 })

/** The size of a draft's content as the daemon would report it: the text without the tokens of its attachments, and what came with it. */
export function contentSize(content: DraftContent): Pick<UnsentDraft, "chars" | "attachments" | "images"> {
  const typed = content.images.reduce((rest, ref) => (ref.label ? rest.replace(ref.label, "") : rest), content.text)
  return { chars: typed.trim() === "" ? 0 : typed.length, attachments: content.images.length, images: content.images.filter((ref) => ref.mime.startsWith("image/")).length }
}

/** The start-up notice for unsent drafts; undefined when there are none. `key` is the restore key as the key-label system words it. */
export function unsentNotice(drafts: readonly UnsentDraft[], key: string): string | undefined {
  const first = drafts[0]
  if (!first) return undefined
  return drafts.length === 1 ? `Unsent draft saved (${draftSize(first)}) · ${key} restore` : `${drafts.length} unsent drafts saved · ${key} restores the newest · /drafts lists them`
}

/** A prompt with no text but whitespace and no attachment is no draft. */
const blank = (content: DraftContent) => content.text.trim() === "" && content.images.length === 0

const keyOf = (content: DraftContent) => `${content.text}\u0000${content.images.map((ref) => ref.sha256).join(",")}`
const EMPTY_KEY = keyOf({ text: "", images: [] })

/**
 * Keeps the prompt of the current session in the daemon while it is typed, so closing the terminal (or losing it)
 * does not lose it. Saves are debounced; clearing (after a submit) goes out at once so a sent prompt never comes back.
 */
export function createDraftSync(input: {
  send(command: CommandInput): Promise<CommandReply>
  delayMs?: number
  setTimer?: (run: () => void, ms: number) => unknown
  clearTimer?: (timer: unknown) => void
  /** The pending comments of a session, or undefined when it has none. */
  comments?: (sessionId: SessionId) => CommentsView | undefined
}) {
  const delayMs = input.delayMs ?? DRAFT_DEBOUNCE_MS
  const setTimer = input.setTimer ?? ((run, ms) => setTimeout(run, ms))
  const clearTimer = input.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>))
  /** What the daemon holds per session, as a comparison key. */
  const saved = new Map<SessionId, string>()
  let timer: unknown
  let queued: { sessionId: SessionId; content: DraftContent; key: string } | undefined
  /** Saves sent and not yet answered, so quitting or a closing terminal can wait for them. */
  const inFlight = new Set<Promise<unknown>>()

  function save(sessionId: SessionId, content: DraftContent, key: string) {
    saved.set(sessionId, key)
    const sent = input.send({ type: "draft.set", sessionId, text: content.text.slice(0, MAX_DRAFT_CHARS), ...(content.images.length ? { attachments: content.images.slice(0, 16) } : {}) }).catch(() => undefined)
    inFlight.add(sent)
    void sent.finally(() => inFlight.delete(sent))
  }

  function cancel() {
    if (timer !== undefined) clearTimer(timer)
    timer = undefined
    queued = undefined
  }

  function flush() {
    const next = queued
    cancel()
    if (next) save(next.sessionId, next.content, next.key)
  }

  return {
    /** Called after each input: saves a changed prompt after a pause, or at once when it was emptied. True when the text is over the limit and is kept truncated. */
    changed(sessionId: SessionId, typed: DraftContent): boolean {
      const view = input.comments?.(sessionId)
      // With no comments yet, a comment being typed still must not be saved as the draft: `view.draft` is the prompt it replaced.
      const composed = view ? { ...typed, text: view.comments.length ? buildCommentDraft({ comments: view.comments, draft: view.draft ?? typed.text, parked: view.parked, lastItemId: view.lastItemId, limit: MAX_DRAFT_CHARS }) : view.draft ?? typed.text } : typed
      // Spaces and line breaks alone are an empty prompt: they save no draft and take a saved one away.
      const content = blank(composed) ? { text: "", images: [] } : composed
      const key = keyOf(content)
      if (queued && queued.sessionId !== sessionId) flush()
      if ((saved.get(sessionId) ?? EMPTY_KEY) === key) {
        cancel()
        return typed.text.length > MAX_DRAFT_CHARS
      }
      if (key === EMPTY_KEY) {
        cancel()
        save(sessionId, content, key)
        return false
      }
      queued = { sessionId, content, key }
      if (timer !== undefined) clearTimer(timer)
      timer = setTimer(flush, delayMs)
      return typed.text.length > MAX_DRAFT_CHARS
    },
    /** Saves a pending change now (before switching session or quitting). */
    flush,
    /** Saves a pending change now and resolves once the daemon has every save (a closing terminal or a quit waits for it). */
    async settled(): Promise<void> {
      flush()
      await Promise.all([...inFlight])
    },
    /** The saved draft of a session, remembered as saved so opening it does not write it back. */
    async restore(sessionId: SessionId): Promise<RestoredDraft | undefined> {
      const reply = await input.send({ type: "draft.get", sessionId })
      const draft = reply.ok ? (reply.result?.draft as { text?: unknown; attachments?: unknown } | undefined) : undefined
      if (!draft || typeof draft.text !== "string") return undefined
      const content: DraftContent = { text: draft.text, images: Array.isArray(draft.attachments) ? (draft.attachments as BlobRef[]) : [] }
      // One an earlier version stored for an empty prompt: it holds nothing, so it goes instead of coming back.
      if (blank(content)) {
        save(sessionId, { text: "", images: [] }, EMPTY_KEY)
        return undefined
      }
      saved.set(sessionId, keyOf(content))
      const comments = parseCommentDraft(draft.text)
      return comments ? { text: comments.draft, images: content.images, comments: { list: comments.comments, parked: comments.parked } } : content
    },
  }
}
