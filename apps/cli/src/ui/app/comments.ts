import type { AppContext } from "./context"
import { createCommentStore, type Offer, type SavedPrompt } from "../comment-store"
import { liveAttachments } from "../../view/attachments"
import { hintKey, inlineKeyNames } from "../keymap"
import { keyText } from "../key-labels"
import { bodyText, highlightLine, type Selection } from "../selection"
import type { Line } from "../theme"
import type { PromptFrame } from "../../view/prompt-chrome"
import type { ViewLine } from "../../view/transcript"
import { buildCommentMessage, locateQuote, MAX_MESSAGE_CHARS, replyUnits, type ReplyComment, type ReplyUnit } from "../../view/reply-comments"
import { chipPill, chipRow, commentHint, commentList, commentToastHint, composeHeader, decideHeader, hintByPassage, hintOnRule, lettersOf, markRows, parkedRow, parseDecisions, replyBar, REPLY_KEYS, tintRule, type ChipModel, type ReplyKeys } from "../../view/reply-comments-view"
import { MOUSE_SGR } from "./constants"

/**
 * Comments on passages of the assistant's answer (docs/editor.md). The user selects (or copies) a passage, presses the comment key and
 * types; the comment becomes a chip on the one prompt, and one Enter sends every chip and the typed text as one message. This factory
 * owns the behaviour: the offer after a copy, composing, the list, the reply mode, sending, the draft, the lifecycle and what is drawn.
 * The store (`../comment-store.ts`) holds the data and the views (`../../view/reply-comments-view.ts`) draw the rows.
 *
 * Plain letters are never taken from the prompt unless the reply mode or the list is open, which the bar says. Any other printable key
 * closes the mode and is typed.
 */

/** A pending comment as an extension sees it. */
export type CommentInfo = Readonly<{ n: number; quote: string; text: string; itemId?: string }>

type Area = { row: number; from: number; to: number }
type Areas = { chips?: Area; pill?: Area; marks: Array<{ row: number; id: number }> }

const SCROLL_KEYS = new Set(["\x1b[5~", "\x1b[6~", "\x1b[H", "\x1bOH", "\x1b[1~", "\x1b[F", "\x1bOF", "\x1b[4~"])
const UP = new Set(["\x1b[A", "\x1bOA"])
const DOWN = new Set(["\x1b[B", "\x1bOB"])
/** The extra rows composing takes above the transcript are capped so a short terminal keeps its conversation. */
const LIST_MAX_ROWS = 9
/** What a comment key says when the feature is off, with the way back on. */
const COMMENTS_OFF = "comments are off · /comments on"

const plainOf = (line: Line) => line.map((span) => span.text).join("")
const extent = (text: string): [number, number] => [Math.max(0, text.search(/\S/)), text.trimEnd().length]

export function createComments(ctx: AppContext, actions: {
  syncDraft(): void
  /** Moves the transcript (positive: up). */
  scroll(lines: number): void
  transcriptWidth(): number
}) {
  const { state, editor, requestFrame, say, now, glyphs: g } = ctx
  const store = createCommentStore()
  let areas: Areas = { marks: [] }
  let offerTimer: ReturnType<typeof setTimeout> | undefined

  // ----- settings and names -------------------------------------------------------------------------------------

  /** On in the balanced and full views, off in minimal, unless the setting says which. */
  const enabled = () => state.tuiProfile.comments === "on" || (state.tuiProfile.comments === "auto" && state.mode !== "minimal")
  const limit = () => state.tuiProfile.commentMax
  const letters = () => lettersOf(state.tuiProfile.commentReplyKeys)
  /** The keys the copy names, as bound now (a rebound or unbound key changes the copy, never the other way round). */
  function keys(): ReplyKeys {
    const bound = (action: "selection.comment" | "comment.list") => hintKey(state.bindings, action, inlineKeyNames(state.bindings, action)[0])
    return { ...REPLY_KEYS, comment: keyText(bound("selection.comment") ?? "click"), list: keyText(bound("comment.list") ?? "/comments list") }
  }
  /** What a key does in the keymap, when it is one of this feature's actions. */
  const actionOf = (key: string) => {
    const bound = state.bindings.direct.get(key)
    return bound && "action" in bound ? bound.action : undefined
  }
  const isCommentKey = (key: string) => actionOf(key) === "selection.comment"

  // ----- the transcript's answers ----------------------------------------------------------------------------------

  const blocks = () => state.transcript.blocks()
  const answerOf = (itemId: string) => blocks().find((block) => block.itemId === itemId && block.kind === "agent_message")
  const newestAnswer = () => blocks().findLast((block) => block.kind === "agent_message")
  /** The newest answer that is complete and has text: what the reply mode walks. */
  const newestFinished = () => blocks().findLast((block) => block.kind === "agent_message" && block.status !== "running" && block.text.trim() !== "")

  /** The comment a selection of the transcript stands for: its text and the answer it starts in; undefined when it is not part of an answer. */
  function selectionTarget(selection: Selection | undefined = state.selection): { quote: string; itemId: string } | undefined {
    const map = state.selectionMap
    if (!selection?.moved || selection.area !== "body" || !map?.lineAt) return undefined
    // A drag that starts or ends in the blank rows around an answer (past its last line, as a drag down to the end does) copies
    // the answer alone: the rows that belong to no item at either end are not part of the passage.
    let first = Math.min(selection.anchor.row, selection.focus.row)
    let last = Math.max(selection.anchor.row, selection.focus.row)
    while (first < last && !map.lineAt(first)?.itemId) first++
    while (last > first && !map.lineAt(last)?.itemId) last--
    const itemId = map.lineAt(first)?.itemId
    if (!itemId || !answerOf(itemId) || !answerOf(map.lineAt(last)?.itemId ?? "")) return undefined
    const quote = bodyText(map, selection).trim()
    return quote ? { quote, itemId } : undefined
  }

  // ----- the offer ---------------------------------------------------------------------------------------------------

  const offerLive = (): Offer | undefined => {
    const offer = store.offer
    if (!offer) return undefined
    if (now() >= offer.until) return endOffer(), undefined
    return offer
  }

  function endOffer(dismissToast = true) {
    if (offerTimer) clearTimeout(offerTimer)
    offerTimer = undefined
    const offer = store.offer
    store.offer = undefined
    if (offer && dismissToast && toastOf.get(offer) === ctx.toasts.current) ctx.toasts.dismiss()
    if (offer) requestFrame()
  }
  /** A press outside the offer ends it. */
  const dismiss = () => endOffer()
  /** The toast each offer rode on, so ending the offer takes only its own toast down. */
  const toastOf = new WeakMap<Offer, unknown>()

  /**
   * A selection was just copied (copy on select): the toast says so, and offers the comment key for a few seconds. False when there is no
   * offer to make (the feature is off, the hint is off, or the text is not part of an answer): the caller copies as usual.
   */
  function copied(selection: Selection, text: string, copy: (hint: string | undefined, ms: number | undefined) => void): boolean {
    const profile = state.tuiProfile
    const target = enabled() && store.count < limit() && !store.composing ? selectionTarget(selection) : undefined
    if (!target) return false
    const ms = profile.commentHintSeconds * 1000
    // `off` shows nothing, but the key still takes the passage that was just copied; `passage` draws its pill by the text, the toast stays plain.
    copy(profile.commentHint === "prompt" ? commentToastHint(keys()) : undefined, profile.commentHint === "off" ? undefined : ms)
    const offer: Offer = { quote: target.quote || text, itemId: target.itemId, until: now() + ms, copied: true }
    store.offer = offer
    toastOf.set(offer, ctx.toasts.current)
    if (offerTimer) clearTimeout(offerTimer)
    offerTimer = setTimeout(() => endOffer(false), ms + 20)
    offerTimer.unref?.()
    requestFrame()
    return true
  }

  /** Any key but the comment key ends the offer (and takes its toast down). Mouse reports are the mouse handler's: a press elsewhere calls `dismiss`. */
  function noteInput(key: string) {
    if (!store.offer || MOUSE_SGR.test(key) || isCommentKey(key)) return
    endOffer()
  }

  // ----- composing ---------------------------------------------------------------------------------------------------------

  function startCompose({ quote, itemId, editId, decide, text = "" }: { quote: string; itemId?: string | undefined; editId?: number | undefined; decide?: ReadonlyArray<{ number: number; text: string }>; text?: string }) {
    const saved: SavedPrompt = { text: editor.text, cursor: editor.cursorOffset, shell: state.shellMode }
    ctx.vim.reset()
    state.shellMode = false
    state.selection = undefined
    state.suggestion = 0
    state.mentionToken = undefined
    state.mentionResults = []
    store.listing = undefined
    store.focused = undefined
    endOffer()
    store.composing = { quote, itemId, editId, saved, ...(decide ? { decide } : {}) }
    editor.replaceAll(text)
    editor.resetHistory()
    requestFrame()
  }

  function restorePrompt(saved: SavedPrompt) {
    editor.replaceAll(saved.text)
    editor.moveTo(saved.cursor)
    editor.resetHistory()
    state.shellMode = saved.shell
    state.suggestion = 0
  }

  function endCompose() {
    const composing = store.composing
    if (!composing) return
    store.composing = undefined
    restorePrompt(composing.saved)
    actions.syncDraft()
    requestFrame()
  }

  /** Enter while composing: stores the comment (or the decisions), puts the prompt back as it was. */
  function saveCompose() {
    const composing = store.composing
    if (!composing) return
    const typed = editor.text.trim()
    if (composing.decide) {
      const { pairs, unknown } = parseDecisions(typed, composing.decide)
      if (unknown.length) return say(`no option ${unknown.join(", ")} in that answer`, "warning")
      if (!pairs.length) return say("write each choice as 1: yes, 2: no", "warning")
      let added = 0
      for (const pair of pairs) if (store.add({ quote: composing.decide.find((option) => option.number === pair.number)!.text, text: pair.text, itemId: composing.itemId }, limit())) added++
      if (added < pairs.length) say(`${limit()} comments is the most: ${added} of ${pairs.length} kept`, "warning")
    } else if (composing.editId !== undefined) {
      if (!typed) return say("a comment needs words · esc cancels", "warning")
      store.edit(composing.editId, typed)
    } else {
      if (!typed) return say("a comment needs words · esc cancels", "warning")
      if (!store.add({ quote: composing.quote, text: typed, itemId: composing.itemId }, limit())) say(`${limit()} comments is the most`, "warning")
    }
    endCompose()
  }

  /** Whether another comment fits; says so when it does not. */
  function room(): boolean {
    if (store.count < limit()) return true
    say(`${limit()} comments is the most · send them or drop one (${keys().list})`, "warning")
    return false
  }

  // ----- the reply mode ----------------------------------------------------------------------------------------------------

  function openReply(): boolean {
    const answer = newestFinished()
    const units = answer ? replyUnits(answer.text) : []
    if (!answer || !units.length) return say("no answer to comment on yet", "info"), true
    store.reply = { itemId: answer.itemId, units, index: units.length - 1 }
    store.listing = undefined
    store.focused = undefined
    endOffer()
    reveal()
    requestFrame()
    return true
  }

  /** Scrolls the transcript so the unit under the reply cursor is on screen. */
  function reveal() {
    const reply = store.reply
    const unit = reply?.units[reply.index]
    if (reply && unit) revealQuote(reply.itemId, unit.text)
  }

  /** The list changes the rows around the prompt, so the body height is only known after the next frame: the scroll waits for it. */
  let pendingReveal: { itemId: string; quote: string } | undefined
  const revealSelected = () => {
    const selected = store.listing ? store.list[store.listing.selected] : undefined
    pendingReveal = selected?.itemId ? { itemId: selected.itemId, quote: selected.quote } : undefined
  }

  function revealQuote(itemId: string, quote: string) {
    const width = actions.transcriptWidth()
    const all = blocks().slice(state.transcript.olderBlocks)
    const at = all.findIndex((block) => block.itemId === itemId)
    if (at < 0) return
    const lines = state.transcript.blockLines(itemId as never, width)
    const found = locateQuote({ rows: lines.map((line) => line.text), quote })
    if (!found) return
    let below = 0
    for (let index = all.length - 1; index > at; index--) below += state.transcript.blockLines(all[index]!.itemId, width).length
    const near = below + (lines.length - 1 - found.to)
    const far = below + (lines.length - 1 - found.from)
    const offset = ctx.view.get(state.sessionId).offset
    const height = Math.max(1, state.lastBodyHeight)
    if (near < offset) actions.scroll(-(offset - near))
    else if (far > offset + height - 1) actions.scroll(far - (offset + height - 1))
  }

  function moveReply(delta: number) {
    const reply = store.reply
    if (!reply) return
    reply.index = Math.max(0, Math.min(reply.units.length - 1, reply.index + delta))
    reveal()
    requestFrame()
  }

  const optionsOf = (reply: NonNullable<typeof store.reply>) => reply.units.filter((unit): unit is ReplyUnit & { number: number } => unit.kind === "option" && unit.number !== undefined)

  function replyKey(key: string): boolean {
    const reply = store.reply!
    const keysOf = letters()
    if (key === "\x1b" || key === "\x03" || isCommentKey(key) || actionOf(key) === "comment.reply") return (store.reply = undefined, requestFrame(), true)
    if (key === keysOf.next || DOWN.has(key)) return (moveReply(1), true)
    if (key === keysOf.previous || UP.has(key)) return (moveReply(-1), true)
    if (key === keysOf.comment) {
      const unit = reply.units[reply.index]!
      if (room()) startCompose({ quote: unit.text, itemId: reply.itemId })
      return true
    }
    const options = optionsOf(reply)
    if (key === keysOf.decide && options.length) {
      if (room()) startCompose({ quote: "", itemId: reply.itemId, decide: options.map((option) => ({ number: option.number, text: option.text })) })
      return true
    }
    if (/^[1-9]$/.test(key)) {
      const target = reply.units.findIndex((unit) => unit.kind === "option" && unit.number === Number(key))
      if (target >= 0) moveReply(target - reply.index)
      return true
    }
    // Mouse reports and the paging keys leave the mode open; anything else is not a reply key: the mode closes and the key goes on.
    if (MOUSE_SGR.test(key) || SCROLL_KEYS.has(key)) return false
    store.reply = undefined
    requestFrame()
    return false
  }

  // ----- the list ----------------------------------------------------------------------------------------------------------

  function openList() {
    if (store.parked) {
      store.unpark()
      actions.syncDraft()
      say(`${store.count} ${store.count === 1 ? "comment" : "comments"} back`, "success", { quiet: true })
      return requestFrame()
    }
    if (!store.count) return say("no comments yet · select a passage and press the comment key", "info")
    store.reply = undefined
    store.focused = undefined
    store.listing = { selected: Math.min(store.listing?.selected ?? 0, store.count - 1) }
    revealSelected()
    requestFrame()
  }

  function listKey(key: string): boolean {
    const listing = store.listing!
    const selected = store.list[listing.selected]
    if (key === "\x1b" || key === "\x03" || actionOf(key) === "comment.list") return (store.listing = undefined, requestFrame(), true)
    if (UP.has(key) || DOWN.has(key)) {
      listing.selected = Math.max(0, Math.min(store.count - 1, listing.selected + (UP.has(key) ? -1 : 1)))
      revealSelected()
      return requestFrame(), true
    }
    if ((key === "e" || key === "\r") && selected) {
      startCompose({ quote: selected.quote, itemId: selected.itemId, editId: selected.id, text: selected.text })
      return true
    }
    if (key === "d" && selected) {
      store.remove(selected.id)
      if (!store.count) store.listing = undefined
      else listing.selected = Math.min(listing.selected, store.count - 1)
      revealSelected()
      actions.syncDraft()
      return requestFrame(), true
    }
    if ((key === "J" || key === "K") && selected) {
      const to = store.move(selected.id, key === "J" ? 1 : -1)
      if (to !== undefined) {
        listing.selected = to
        actions.syncDraft()
      }
      return requestFrame(), true
    }
    if (MOUSE_SGR.test(key) || SCROLL_KEYS.has(key)) return false
    store.listing = undefined
    requestFrame()
    return false
  }

  // ----- keys --------------------------------------------------------------------------------------------------------------

  /** The keys of an open mode. True when the key was used; false lets it through to the prompt (a closed mode gives the key back too). */
  function key(input: string): boolean {
    if (store.composing) {
      if (input === "\r") return saveCompose(), true
      if (input === "\x1b" || input === "\x03") return endCompose(), true
      return false
    }
    if (store.reply) return replyKey(input)
    if (store.listing) return listKey(input)
    return false
  }

  /** ctrl+c: ends the mode that is open, else sets pending comments aside as a draft when the prompt is empty. False: ctrl+c goes on as it always does. */
  function ctrlC(): boolean {
    if (store.composing || store.reply || store.listing) return key("\x03")
    if (!enabled() || !editor.isEmpty() || liveAttachments(state.attachments, editor.text).length || state.shellMode || !store.active().length) return false
    const count = store.count
    store.park()
    actions.syncDraft()
    ctx.drafts.flush()
    say(`${count} ${count === 1 ? "comment" : "comments"} kept as a draft`, "success", { quiet: true })
    requestFrame()
    return true
  }

  /**
   * The comment key (`selection.comment`). False when the feature is off or `commentKey` keeps the old quote behaviour, so the caller
   * quotes the selection as before. A kept selection or a passage just copied becomes the comment's quote; with neither it walks the
   * newest answer; pressed again in the reply mode it leaves it. `always` is ctrl+g (`COMMENT_KEY`): it never quotes, so `commentKey`
   * does not apply to it and with the feature off it says so.
   */
  function commentKey({ always = false }: { always?: boolean } = {}): boolean {
    if (!enabled()) return always ? (say(COMMENTS_OFF, "info"), true) : false
    if (state.tuiProfile.commentKey === "quote" && !always) return false
    if (store.composing) return true
    const target = selectionTarget()
    if (target) return (room() && startCompose(target), true)
    const offer = offerLive()
    if (offer) return (room() && startCompose({ quote: offer.quote, itemId: offer.itemId }), true)
    if (state.selection?.moved && state.selection.area === "body") return (say("select text inside an answer to comment on it", "warning"), true)
    if (store.reply) return (store.reply = undefined, requestFrame(), true)
    return room() ? openReply() : true
  }

  /** The other keymap actions of the feature. */
  function run(action: "comment.list" | "comment.reply" | "comment.clear") {
    if (!enabled()) return say(COMMENTS_OFF, "info")
    if (action === "comment.list") return store.listing ? (store.listing = undefined, requestFrame()) : openList()
    if (action === "comment.reply") return store.reply ? (store.reply = undefined, requestFrame()) : void (room() && openReply())
    clear()
  }

  function clear() {
    const count = store.clear()
    store.composing && endCompose()
    actions.syncDraft()
    say(count ? `${count} ${count === 1 ? "comment" : "comments"} dropped` : "no comments to drop", count ? "success" : "info", { quiet: count > 0 })
    requestFrame()
  }

  /** `/comments on|off|auto` etc. keep the data; turning the feature off while a mode is open closes it. */
  function leave() {
    store.composing && endCompose()
    store.reply = undefined
    store.listing = undefined
    store.focused = undefined
    endOffer(false)
  }

  // ----- sending -----------------------------------------------------------------------------------------------------------

  const infoOf = (comments: readonly ReplyComment[]): CommentInfo[] => comments.map((comment, index) => ({ n: index + 1, quote: comment.quote, text: comment.text, ...(comment.itemId !== undefined ? { itemId: comment.itemId } : {}) }))

  /**
   * What the pending comments and the typed text become: the envelope message (an extension may reshape it), or an error to show. Undefined
   * when there is nothing to attach (feature off, no comments, a mode still open): the text goes as typed.
   */
  function attach(general: string): { message: string } | { error: string } | undefined {
    const comments = store.active()
    if (!enabled() || !comments.length || store.composing) return undefined
    const profile = state.tuiProfile
    let message = buildCommentMessage({ comments, general, lastItemId: newestAnswer()?.itemId, wording: { envelope: profile.commentTemplate, entry: profile.commentEntry } })
    const reshaped = state.ext?.commentEnvelope({ message, comments: infoOf(comments), note: general })
    if (reshaped !== undefined) message = reshaped
    if (!message.trim()) return { error: "nothing to send" }
    if (message.length > MAX_MESSAGE_CHARS) return { error: `comments and text are ${message.length} characters, over the ${MAX_MESSAGE_CHARS} limit · shorten or drop some` }
    return { message }
  }

  /** The message was sent: the comments are spent. */
  function sent() {
    if (!store.count && !store.parked) return
    leave()
    store.clear()
    actions.syncDraft()
    requestFrame()
  }

  // ----- the draft and the session -----------------------------------------------------------------------------------------

  function draftView(sessionId: string) {
    if (sessionId !== state.sessionId || (!store.count && !store.composing)) return undefined
    return { comments: store.list, parked: store.parked, lastItemId: newestAnswer()?.itemId, ...(store.composing ? { draft: store.composing.saved.text } : {}) }
  }

  /** Comments from a restored draft; nothing is taken when some are pending already. */
  function restore(comments: readonly ReplyComment[], parked: boolean) {
    if (store.count || store.composing) return
    store.restore(comments, parked)
    store.owner = state.sessionId
    requestFrame()
  }

  /** A session switch: the open mode ends with the prompt intact, then (after the draft is saved) the store is emptied for the next session. */
  function switching() {
    leave()
  }
  function reset(owner: string) {
    store.reset(owner)
  }

  /** A compaction removes the messages comments point at: they keep their quotes and lose their anchors. An answer newer than the reply mode's ends it. */
  function refresh() {
    if (!store.count && !store.reply) return
    if (store.reply && newestFinished()?.itemId !== store.reply.itemId) store.reply = undefined
    if (!store.count) return
    const all = blocks()
    const compaction = all.findLastIndex((block) => block.kind === "compaction" && block.status === "ok")
    if (compaction >= 0 && store.list.some((comment) => comment.itemId !== undefined)) {
      const gone = new Set(all.slice(0, compaction).map((block) => block.itemId as string))
      if (store.orphan((itemId) => !gone.has(itemId))) actions.syncDraft()
    }
  }

  // ----- an extension's view -------------------------------------------------------------------------------------------------

  /** Adds a comment from code (an extension: "comment on this diff hunk"). False when the feature is off, the words are empty or the limit is reached. */
  function add({ quote, text, itemId }: { quote: string; text: string; itemId?: string }): boolean {
    if (!enabled() || store.count >= limit()) return false
    const added = store.add({ quote, text, itemId, other: itemId === undefined }, limit())
    if (!added) return false
    actions.syncDraft()
    requestFrame()
    return true
  }

  // ----- what is drawn -------------------------------------------------------------------------------------------------------

  /** A new frame: the areas of the last one are forgotten. */
  function beginFrame() {
    areas = { marks: [] }
    // Turned off while a mode was open (/comments off, the settings page): the mode closes, the comments wait.
    if (store.modal && !enabled()) leave()
    if (store.count || store.reply || store.composing || store.offer) refresh()
  }

  /** The prompt's frame while a comment is typed: the rule is tinted and the header row sits under it, so the typed text is plainly a comment. */
  function frame<F extends PromptFrame>(base: F, width: number): F {
    const composing = store.composing
    if (!composing || !enabled()) return base
    const header = composing.decide
      ? decideHeader({ options: composing.decide.map((option) => option.number), pairs: parseDecisions(editor.text, composing.decide).pairs, width, keys: keys() }, g)
      : composeHeader({ quote: composing.quote, width, draftKept: composing.saved.text.trim() !== "", keys: keys(), editing: composing.editId !== undefined }, g)
    return { ...base, top: [tintRule(base.top[0]!), ...base.top.slice(1), header] }
  }

  const chipsOf = (): ChipModel[] => {
    const last = newestAnswer()?.itemId
    return store.list.map((comment, index) => ({ n: index + 1, quote: comment.quote, ...(!comment.other && (comment.itemId === undefined || comment.itemId !== last) ? { earlier: true } : {}) }))
  }

  /** The rows above the prompt (the reply bar, then the chips, the list or the parked-draft line) and under it. `chip` is the index of the chip row in `above`. */
  function rows({ width, height }: { width: number; height: number }): { above: Line[]; below: Line[]; chip?: number } {
    const above: Line[] = []
    const below: Line[] = []
    if (!enabled() && !store.modal) return { above, below }
    const profile = state.tuiProfile
    const names = keys()
    const reply = store.reply
    if (reply) {
      const unit = reply.units[reply.index]!
      above.push(replyBar({ index: reply.index, total: reply.units.length, unit, width, options: optionsOf(reply).length > 0, letters: letters(), keys: names }, g))
    }
    if (!store.count) return { above, below }
    let chip: number | undefined
    if (store.parked) {
      chip = above.length
      above.push(parkedRow({ count: store.count, width, keys: names }, g))
    } else if (store.listing) {
      chip = above.length
      above.push(...commentList({ comments: store.list, selected: store.listing.selected, width, maxRows: Math.max(3, Math.min(LIST_MAX_ROWS, height - 12)), lastItemId: newestAnswer()?.itemId, limit: limit(), keys: names }, g))
    } else if (profile.commentChips !== "rule") {
      const row = chipRow({ chips: chipsOf(), width, listing: false, style: profile.commentChipStyle, collapse: profile.commentCollapse, ...(store.focused !== undefined ? { focused: store.list.findIndex((comment) => comment.id === store.focused) + 1 } : {}), keys: names }, g)
      if (profile.commentChips === "above") {
        chip = above.length
        above.push(row)
      } else below.push(row)
    }
    return { above, below, ...(chip !== undefined ? { chip } : {}) }
  }

  /** Marks, fills and the passage hint on the transcript rows on screen (`visible[i]` is `body[padTop + i]`); no work at all without comments. */
  function decorate({ body, visible, padTop, top, width }: { body: Line[]; visible: readonly ViewLine[]; padTop: number; top: number; width: number }) {
    const profile = state.tuiProfile
    const selection = enabled() && profile.commentHint === "passage" ? selectionTarget() : undefined
    const offer = enabled() && profile.commentHint === "passage" ? offerLive() : undefined
    const pending = enabled() && !store.parked ? store.list : []
    if (!pending.length && !store.composing && !store.reply && !selection && !offer) return
    const byItem = new Map<string, { index: number[]; text: string[] }>()
    const rowsOf = (itemId: string) => {
      let found = byItem.get(itemId)
      if (!found) {
        found = { index: [], text: [] }
        visible.forEach((line, index) => {
          if (line.itemId !== itemId) return
          found!.index.push(index)
          found!.text.push(line.text)
        })
        byItem.set(itemId, found)
      }
      return found
    }
    const locate = (itemId: string | undefined, quote: string): [number, number] | undefined => {
      if (!itemId) return undefined
      const mine = rowsOf(itemId)
      const at = mine.index.length ? locateQuote({ rows: mine.text, quote }) : undefined
      return at ? [padTop + mine.index[at.from]!, padTop + mine.index[at.to]!] : undefined
    }
    const fill = (span: [number, number]) => {
      for (let row = span[0]; row <= span[1]; row++) {
        const [from, to] = extent(plainOf(body[row]!))
        body[row] = highlightLine(body[row]!, from, to, { bg: "element" })
      }
    }
    const mark = (span: [number, number], n: number | undefined, id?: number) => {
      const marked = markRows({ rows: body, from: span[0], to: span[1], ...(n !== undefined ? { n } : {}), width, glyph: profile.commentMarkGlyph }, g)
      body.splice(0, body.length, ...marked)
      if (id !== undefined) areas.marks.push({ row: top + span[0], id })
    }
    if (profile.commentMarks) pending.forEach((comment, index) => {
      const span = locate(comment.itemId, comment.quote)
      if (span) mark(span, index + 1, comment.id)
    })
    const composing = store.composing
    if (composing?.decide) composing.decide.forEach((option) => {
      const span = locate(composing.itemId, option.text)
      if (span) (fill(span), mark(span, option.number))
    })
    else if (composing) {
      const span = locate(composing.itemId, composing.quote)
      if (span) (fill(span), mark(span, undefined))
    }
    const reply = store.reply
    if (reply && !composing?.decide) {
      const unit = reply.units[reply.index]
      const span = unit ? locate(reply.itemId, unit.text) : undefined
      if (span) (fill(span), mark(span, undefined))
    }
    // A focused chip (a click on its mark) is shown by the same fill on its passage.
    if (store.focused !== undefined) {
      const comment = store.list.find((entry) => entry.id === store.focused)
      const span = comment ? locate(comment.itemId, comment.quote) : undefined
      if (span) fill(span)
    }
    // Hint by the passage (the alternative to the prompt's rule and the toast).
    const hinted = selection ?? offer
    if (hinted) {
      const span = locate("itemId" in hinted ? hinted.itemId : undefined, hinted.quote)
      const hint = commentHint({ copied: !!offer, width: width - 4, keys: keys() }, g)
      const placed = span ? hintByPassage({ rows: body, plain: body.map(plainOf), from: span[0], to: span[1], width, hint, cover: true }) : undefined
      if (placed) {
        body[placed.row] = placed.line
        areas.pill = { row: top + placed.row, from: placed.col, to: placed.col + hint.reduce((sum, span) => sum + [...span.text].length, 0) }
      }
    }
  }

  /**
   * After the frame is laid out: the prompt's top rule carries the pill of a kept selection (alternative B) or the pending count
   * (`commentChips: rule`), and the rows of the chips, the toast and the pill are remembered for clicks.
   */
  function place({ rows: drawn, rule, chip, below, width }: { rows: Line[]; rule: number; chip?: number; below?: number; width: number }) {
    if (chip !== undefined) areas.chips = { row: chip, from: 0, to: width }
    if (below !== undefined) areas.chips = { row: below, from: 0, to: width }
    if (pendingReveal) {
      const target = pendingReveal
      pendingReveal = undefined
      revealQuote(target.itemId, target.quote)
      requestFrame()
    }
    if (!enabled() || rule < 0 || rule >= drawn.length) return
    const profile = state.tuiProfile
    const names = keys()
    const selection = profile.commentHint === "prompt" ? selectionTarget() : undefined
    const hint = selection ? commentHint({ copied: false, width: width - 4, keys: names }, g) : undefined
    const count = !selection && profile.commentChips === "rule" && store.count && !store.listing ? chipPill({ count: store.count, earlier: chipsOf().filter((chip) => chip.earlier).length, keys: names }) : undefined
    const pill = hint ?? count
    if (!pill) return
    const placed = hintOnRule({ rule: drawn[rule]!, width, hint: pill })
    drawn[rule] = placed.line
    const cellsWide = pill.reduce((sum, span) => sum + [...span.text].length, 0)
    areas.pill = { row: rule, from: placed.from, to: placed.from + cellsWide }
    if (!hint) areas.chips = { row: rule, from: placed.from, to: placed.from + cellsWide }
  }

  // ----- the mouse ---------------------------------------------------------------------------------------------------------

  const within = (area: Area | undefined, row: number, col: number) => !!area && row === area.row && col >= area.from && col < area.to

  /** A press somewhere outside the transcript's text: on the chips, the offer's pill or toast. True when it was used. */
  function areaClick({ row, col }: { row: number; col: number }): boolean {
    if (within(areas.pill, row, col)) {
      const target = selectionTarget() ?? offerLive()
      if (!target || !room()) return false
      startCompose(target)
      return true
    }
    if (within(areas.chips, row, col) && store.count && !store.parked) {
      store.reply = undefined
      store.focused = undefined
      store.listing = { selected: 0 }
      requestFrame()
      return true
    }
    if (within(areas.chips, row, col) && store.parked) return (openList(), true)
    return false
  }

  /** A click on a margin mark focuses its chip (it stays out of drag-select: only the mark's own cells count). True when it was used. */
  function bodyClick({ row, col }: { row: number; col: number }): boolean {
    const mark = col < 2 ? areas.marks.find((entry) => entry.row === row) : undefined
    if (mark) {
      store.focused = mark.id
      store.reply = undefined
      // A count has no chip to show: the list opens on the comment instead.
      if (state.tuiProfile.commentChipStyle === "count" || state.tuiProfile.commentChips === "rule") store.listing = { selected: Math.max(0, store.list.findIndex((comment) => comment.id === mark.id)) }
      requestFrame()
      return true
    }
    return false
  }

  return {
    store,
    enabled,
    keys,
    letters,
    composing: () => store.composing !== undefined,
    /** True while the offer after a copy is open: the passage just copied that the comment key takes. */
    offering: () => store.offer !== undefined,
    modal: () => store.modal,
    hasActive: () => enabled() && store.active().length > 0 && !store.composing,
    key,
    ctrlC,
    noteInput,
    dismiss,
    commentKey,
    run,
    clear,
    openList,
    openReply,
    leave,
    switching,
    reset,
    copied,
    attach,
    sent,
    draftView,
    restore,
    refresh,
    beginFrame,
    frame,
    rows,
    decorate,
    place,
    areaClick,
    bodyClick,
    areas: () => areas,
    pending: (): readonly CommentInfo[] => infoOf(store.list),
    add,
  }
}

export type Comments = ReturnType<typeof createComments>
