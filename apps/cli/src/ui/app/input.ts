import type { createScratch } from "./scratch"
import type { createGoal } from "./goal"
import type { createPrompt } from "./prompt"
import type { createMemory } from "./memory"
import { createKeyTokenizer, type KeyToken } from "../keys"
import { connectPaste } from "../lazy-pages"
import { composeSubmission, liveAttachments, pastedPaths } from "../../view/attachments"
import { parseSlash, slashRefusal } from "../../view/commands"
import { removedAliasHint } from "../../view/slash-aliases"
import { hoistCommand } from "../../view/mentions"
import type { AppContext } from "./context"
import type { ItemId, TurnId } from "@mendcode/protocol"
import { DOUBLE_ESC_MS, RETRACT_NARRATION_CHARS } from "./constants"
import { MAX_DRAFT_CHARS } from "@mendcode/protocol/wire"
import { moveLongPastes } from "./paste-upload"

/** Plain text split over several terminal reads still counts as one paste while the reads follow each other this closely. */
export const PASTE_BURST_MS = 40
/** Newlines inside one plain read that make it a paste, or a single one with this many characters of text. Typed-ahead text and scripted input rarely reach either. */
const PASTE_BURST_LINES = 2
const PASTE_BURST_CHARS = 48

export function createInput(ctx: AppContext, actions: {
  recordSlash?: (name: string) => void
  rewind: ReturnType<typeof import("./session").createSession>["rewind"]
  findPaste(text: string): boolean
  composer: ReturnType<typeof import("./composer-recovery").createComposerRecovery>
  prepareIdeContext(): Promise<{ text: string; markSent(): void }>
  attachPasted: ReturnType<typeof createPrompt>["attachPasted"]
  insertPasted: ReturnType<typeof createPrompt>["insertPasted"]
  expandedPrompt: ReturnType<typeof createPrompt>["expandedPrompt"]
  pasteClipboardImage: ReturnType<typeof createPrompt>["pasteClipboardImage"]
  syncMentions: ReturnType<typeof createPrompt>["syncMentions"]
  syncDraft: ReturnType<typeof createPrompt>["syncDraft"]
  compactionPaste(text: string): Promise<void>
  scratchPaste: ReturnType<typeof createScratch>["scratchPaste"]
  saveScratch: ReturnType<typeof createScratch>["saveScratch"]
  saveGoalEdit: ReturnType<typeof createGoal>["saveGoalEdit"]
  loadMemories: ReturnType<typeof createMemory>["loadMemories"]
  submitPlanDraft: (text: string) => Promise<void>
  answerQuestion: (text: string) => Promise<void>
  questionPaste: (text: string) => boolean
  planReviewPaste: (text: string) => boolean
  gitPaste: (text: string) => boolean
  remember: ReturnType<typeof createPrompt>["remember"]
  recordCommand: ReturnType<typeof createPrompt>["recordCommand"]
  runExtensionCommand: (text: string) => Promise<boolean>
  runSlash: (text: string) => Promise<boolean>
  expandCustom: ReturnType<typeof createPrompt>["expandCustom"]
  suggestionPool: ReturnType<typeof createPrompt>["suggestionPool"]
  /** The line with a user alias replaced by its command, or undefined when it holds none. */
  expandAlias(text: string): string | undefined
  switchSession(sessionId: import("@mendcode/protocol").SessionId): Promise<void>
  endScratchEdit: ReturnType<typeof createScratch>["endScratchEdit"]
  endGoalEdit: ReturnType<typeof createGoal>["endGoalEdit"]
  /** True when the message is held for a question about a session that went cold; the prompt keeps its text. */
  idleGate(): Promise<boolean>
  /** A terminal read that was not a focus report: the user is here. */
  noteInput(): void
}) {
  const { input, state, now, editor, fail, report, requestFrame, say } = ctx
  const { attachPasted, syncMentions, syncDraft, saveScratch, saveGoalEdit, loadMemories, submitPlanDraft, remember, recordCommand, runExtensionCommand, runSlash, expandCustom, endScratchEdit, endGoalEdit } = actions
  const tokenize = createKeyTokenizer()

  /**
   * A terminal without bracketed paste delivers a paste as plain text and newlines in one read, and each newline would send
   * what came before it. A read made only of plain text with several lines (or one line break and a lot of text), or a plain
   * read with a newline right after such a one, is therefore one paste. A single line, or a line and its Enter, is typing.
   */
  function pasteBurst(tokens: KeyToken[]): KeyToken[] {
    if (state.page !== "chat" || !state.tuiProfile.pasteBurst || state.palette || tokens.length === 0) return tokens
    const plain = tokens.every((token) => token.type === "key" && (token.seq === "\r" || token.seq === "\n" || token.seq === "\t" || !/[\x00-\x1f\x7f\x1b]/.test(token.seq)))
    if (!plain) return tokens
    const isNewline = (token: KeyToken) => token.type === "key" && (token.seq === "\r" || token.seq === "\n")
    const newlines = tokens.flatMap((token, at) => isNewline(token) ? [at] : [])
    const characters = tokens.reduce((sum, token) => sum + (token.type === "key" && !isNewline(token) ? token.seq.length : 0), 0)
    const interior = newlines.filter((at) => at < tokens.length - 1).length
    const command = tokens[0]?.type === "key" && tokens[0].seq.startsWith("/")
    // A bare Enter is always an Enter, and so is a slash command typed ahead of more text: a pasted newline comes with text, in volume.
    const burst = newlines.length > 0 && characters > 0 && !command && (state.pasteBurstUntil > now() || interior >= PASTE_BURST_LINES || interior > 0 && characters >= PASTE_BURST_CHARS)
    if (burst) state.pasteBurstUntil = now() + PASTE_BURST_MS
    return burst ? [{ type: "paste", text: tokens.map((token) => token.type === "key" ? token.seq : "").join("") }] : tokens
  }

  /** An `Esc`-prefixed key the app binds. With the keyboard protocol on, Option+key that composed a character is this binding when it is bound, and the character when it is not. */
  const altBound = (seq: string) => state.bindings.direct.has(seq) || state.bindings.inline.has(seq) || seq === "\x1b}" || seq === "\x1b]" || state.page === "tutorial"

  /** With the keyboard protocol on, `CSI u` keys become the sequences the keymap knows (ui/keyboard-protocol.ts) and a modifier pressed alone is dropped; otherwise the keys unchanged. */
  function realKeys(tokens: KeyToken[]): KeyToken[] {
    if (!input.screen.keyboard?.active) return tokens
    return tokens.flatMap((token): KeyToken[] => {
      if (token.type !== "key") return [token]
      const seq = input.screen.translateKey(token.seq, altBound)
      return seq ? [{ type: "key", seq }] : []
    })
  }

  /** Raw stdin chunk: split into keys and handled in order. */
  async function onInput(data: string, onKey: (key: string) => Promise<void>) {
    let pasted = false
    const raw = input.screen.consumeTerminalInput?.(data) ?? data
    if (raw) actions.noteInput()
    // The person is back at the keyboard: the restart into the new build has been seen.
    if (raw && state.updated) state.updated = false
    for (const token of pasteBurst(realKeys(tokenize(raw)))) {
      if (token.type === "key") await onKey(token.seq)
      // An extension modal gets a paste as typed text (one key per character); it never reaches the prompt behind it.
      else if (state.extModalId) await onKey(token.text.replace(/\s+/g, " "))
      else if (state.page === "env") { await onKey(token.text.replace(/\r\n?/g, "\n").replace(/\n$/, "")); continue }
      else if (actions.planReviewPaste(token.text)) continue
      else if (actions.gitPaste(token.text)) continue
      else if (state.page === "chat") {
        if (state.promptSearch && actions.composer.searchPaste(token.text)) continue
        if (state.find && !state.palette && actions.findPaste(token.text)) continue
        if (state.palette) {
          await onKey(token.text.replace(/\s+/g, " "))
          continue
        }
        const chat = state.sideChats.get(state.sessionId)
        if (chat?.open && chat.focused) {
          chat.editor.insert(token.text.replace(/\s+/g, " "))
          if (chat.draft.length > 4_000) chat.draft = chat.draft.slice(0, 4_000)
          requestFrame()
          continue
        }
        if (state.compactionLive.focused) continue
        if (state.editingScratch) { actions.scratchPaste(token.text); continue }
        if (actions.questionPaste(token.text)) continue
        // Empty paste is not consent to read the image clipboard. Only image.paste does that.
        if (token.text === "") continue
        const paths = parseSlash(token.text.trim()) ? undefined : pastedPaths(token.text)
        if (paths) {
          for (const raw of paths) if (!(await attachPasted(raw))) editor.insert(`${raw}\n`)
          syncMentions()
          requestFrame()
          continue
        }
        actions.insertPasted(token.text)
        pasted = true
        syncMentions()
        requestFrame()
      } else if (state.page === "compaction") {
        await actions.compactionPaste(token.text)
      } else if (state.page === "memory-assistant" || state.page === "export" || state.page === "skills" || state.page === "model-picker" || state.page === "history" && state.historyState.editing || state.page === "usage" && state.usageState.weatherInput !== undefined) {
        await onKey(token.text.replace(/\s+/g, " "))
      } else if (state.page === "console" && state.console?.form) {
        await onKey(token.text.replace(/[\x00-\x1f\x7f]/g, ""))
      } else if (state.page === "connect") {
        // A pasted key goes into the masked field (or is ignored); it never reaches the prompt editor.
        state.connectState = connectPaste(state.connectState, token.text)
        requestFrame()
      }
    }
    syncDraft()
    // A paste is hard to retype: it is saved at once instead of after the typing pause.
    if (pasted) ctx.drafts.flush()
  }

  async function submit() {
    // A user alias (`slashCommands[].aliases`) is the command it names from here on: the prompt, the history and the recents see `/changes`, not `/d`.
    const aliased = editor.text.startsWith("/") ? actions.expandAlias(editor.text.trim()) : undefined
    if (aliased) editor.replaceAll(aliased)
    // Paste labels become the text they stand for before anything reads the prompt (commands, comments, the message).
    // What was typed, labels included, is what comes back when the message cannot go.
    const typed = { text: editor.text, pastes: state.pastes, attachments: state.attachments }
    const restoreTyped = () => { editor.replaceAll(typed.text); state.pastes = typed.pastes; state.attachments = typed.attachments }
    const submissionSession = state.sessionId
    const submissionDirectory = input.directory
    // Pastes too long for one message go as text attachments under their labels (the model still reads them whole).
    const long = state.pastes.length && !editor.text.startsWith("/") ? await moveLongPastes({ send: input.send, text: editor.text, pastes: state.pastes }) : undefined
    // The upload took a moment: a prompt that changed meanwhile (another session's draft, newer typing) is not this message.
    if (long && (state.sessionId !== submissionSession || input.directory !== submissionDirectory || editor.text !== typed.text)) return requestFrame()
    if (long && "error" in long) {
      fail(long.error)
      return requestFrame()
    }
    if (long) {
      state.pastes = long.pastes
      state.attachments = [...state.attachments, ...long.attachments]
    }
    if (state.pastes.length) {
      editor.replaceAll(actions.expandedPrompt())
      state.pastes = []
    }
    // A skill or custom command named after other text runs with that text as its arguments (docs/commands.md).
    const hoisted = state.shellMode || state.editingScratch || state.editingGoal || state.editingMemory ? undefined : hoistCommand(editor.text.trim(), actions.suggestionPool())
    if (hoisted) editor.replaceAll(hoisted)
    const text = editor.text.trim()
    // The daemon takes a message of 64 KB at most: a longer one stays in the prompt, as typed, with its size.
    if (text.length > MAX_DRAFT_CHARS) {
      restoreTyped()
      fail(`message is ${Math.ceil(text.length / 1024)} KB, the limit is 64 KB · trim it, or save it to a file and mention it with @`)
      return requestFrame()
    }
    const delivery = state.nextDelivery
    state.nextDelivery = undefined
    state.submits++
    if (state.editingScratch) return saveScratch()
    if (state.editingGoal) return saveGoalEdit()
    if (state.editingMemory) {
      if (!text) return
      const reply = await input.send({ type: "memory.update", memoryId: state.editingMemory, text })
      if (!reply.ok) return (fail(reply.error.message), requestFrame())
      state.editingMemory = undefined
      editor.clear()
      state.notice = ""
      state.page = "memory"
      await loadMemories()
      return
    }
    if (state.planDraft) return submitPlanDraft(text)
    if (state.transcript.pendingRequests[0]?.kind === "question") return actions.answerQuestion(text)
    if (state.shellMode) {
      // `!!command`: the shell mode's own `!` came first, so a second one marks a command whose output stays out of the model's history.
      const local = text.startsWith("!")
      const command = local ? text.slice(1).trim() : text
      if (!command) return
      // The daemon runs it (no model call); an engine without shell mode answers invalid_command, shown as a notice.
      const reply = await input.send({ type: "user.shell", sessionId: state.sessionId, command, ...(local ? { local: true } : {}) })
      if (!reply.ok) {
        state.notice = reply.error.message.replace(/^\[[A-Z]+\]: /, "")
        return requestFrame()
      }
      remember(text, "shell")
      editor.clear()
      editor.resetHistory()
      state.shellMode = false
      state.notice = ""
      return requestFrame()
    }
    // Pending comments on the answer are a message of their own: Enter sends them with whatever is typed (docs/editor.md).
    if (!text && liveAttachments(state.attachments, editor.text).length === 0 && !ctx.comments.hasActive()) return
    // A command the tier does not list answers with the tier that has it; nothing runs and the line is not kept (docs/tiers.md, "Slash commands").
    const refusal = text.startsWith("/") ? slashRefusal(text, state.settingsNow, state.tuiProfile.slashCommands) : undefined
    if (refusal) {
      editor.clear()
      editor.resetHistory()
      say(refusal, "info")
      return requestFrame()
    }
    // `/connect <name>` is never kept in the prompt history: what follows the command could be a key pasted by mistake.
    const keepable = Boolean(text) && !/^\/(?:env|privacy|connect)(?:\s|$)/i.test(text)
    const command = keepable && /^\/[a-z0-9]/i.test(text)
    if (keepable) remember(text, command ? "command" : "sent")
    // A command the terminal runs itself never reaches the daemon as a message, so the project's history is told first
    // (a line that turns out to be a message is recorded again by the daemon as the same text).
    if (command) recordCommand(text, submissionSession)
    if (text.startsWith("/") && ((await runExtensionCommand(text)) || (await runSlash(text)))) return
    // A custom command expands to its prompt; any other text (including paths like /Users/…) is sent as typed.
    const expanded = text.startsWith("/") ? await expandCustom(text) : undefined
    if (expanded === null) return
    // A name that was an alias of a built-in once and is not any more is no message to the model: the line says where the command went (docs/commands.md, "Aliases").
    const moved = expanded === undefined ? removedAliasHint(text) : undefined
    if (moved) {
      editor.clear()
      editor.resetHistory()
      say(moved, "info")
      return requestFrame()
    }
    if (await actions.idleGate()) return
    // The comments and the typed text become one message; one that cannot be sent (too long) stays in the prompt, comments included.
    const attached = !state.transcript.pendingRequests.length && !(expanded !== undefined && typeof expanded !== "string") ? ctx.comments.attach(typeof expanded === "string" ? expanded : text) : undefined
    if (attached && "error" in attached) return (fail(attached.error), requestFrame())
    const ide =state.transcript.pendingRequests.length ? { text: "", markSent() {} } : await actions.prepareIdeContext()
    if (state.sessionId !== submissionSession || input.directory !== submissionDirectory || editor.text.trim() !== text) return
    // What still belongs to the prompt: a deleted token took its attachment with it.
    const live = liveAttachments(state.attachments, editor.text)
    editor.clear()
    // A sent prompt is not an edit to undo: the next one starts with a clean history.
    editor.resetHistory()
    requestFrame()
    // While the agent is asking, the prompt answers it instead of queueing a new message.
    const question = state.transcript.pendingRequests.find((request) => request.kind === "question")
    if (question) {
      const answered = await input.send({ type: "request.resolve", sessionId: state.sessionId, requestId: question.requestId, decision: { kind: "answer", text } })
      report(answered)
      return requestFrame()
    }
    // Text typed while an approval waits is a "no, do this instead" (plan feedback, a better command…).
    const approval = state.transcript.pendingRequests.find((request) => request.kind === "approval")
    if (approval && text) {
      const denied = await input.send({ type: "request.resolve", sessionId: state.sessionId, requestId: approval.requestId, decision: { kind: "deny", reason: text } })
      report(denied)
      return requestFrame()
    }
    const sending = live
    state.attachments = []
    const executable = expanded !== undefined && typeof expanded !== "string" ? expanded : undefined
    const composed = composeSubmission(attached ? attached.message : typeof expanded === "string" ? expanded : executable ? "" : text, sending, executable ? "" : ide.text)
    const contextText = composed.text
    composed.text = ide.text + composed.text
    state.clearPending = state.tuiProfile.submitScroll === "clear"
    const reply = await input.send(executable ? { type: "commands.execute", sessionId: state.sessionId, ...executable, attachments: composed.attachments, ...(composed.text ? { contextText: `\n\n${composed.text}` } : {}) } : { type: "user.submit", sessionId: state.sessionId, text: composed.text, attachments: composed.attachments, ...(typeof expanded === "string" || ide.text ? { displayText: typeof expanded === "string" ? text : contextText } : {}), ...(delivery && !executable ? { delivery } : {}) })
    // A message that could not go comes back to the prompt it left, unless something newer is there now (another session,
    // text typed while it was sent): that stays, and the message is one ↑ away in the prompt history.
    const restorable = state.sessionId === submissionSession && editor.isEmpty() && state.attachments.length === 0
    if (!reply.ok) state.clearPending = false
    if (!reply.ok && restorable) { state.attachments = sending; if (typed.pastes.length) restoreTyped(); else editor.replaceAll(text) }
    if (reply.ok) {
      if (attached) ctx.comments.sent()
      ide.markSent()
      if (expanded !== undefined && !parseSlash(text)) actions.recordSlash?.(/^\/([a-z0-9][a-z0-9:_-]*)/i.exec(text)?.[1]?.toLowerCase() ?? "")
    }
    if (reply.ok && delivery === "steer") say(reply.result?.steered ? "steering: joins after the next tool result" : "queued: this turn cannot take it sooner", "info")
    report(reply)
    // A prompt the daemon handled without a turn says what became of it (`@agent` sent to its child, a hook that blocked it).
    if (reply.ok && reply.result?.handled === true && typeof reply.result.notice === "string") say(reply.result.notice, "info")
    if (reply.ok && reply.result?.task) await actions.switchSession((reply.result.task as import("@mendcode/protocol").TaskRecord).taskId)
    requestFrame()
  }

  /** The user message of a running turn the model has not answered yet, when Esc may take it back (`escRetract`, an empty prompt). */
  function retractable(turnId: TurnId): ItemId | undefined {
    // Messages queued behind it were written after it: taking it back under them would reorder the conversation, so Esc only stops.
    if (!state.tuiProfile.escRetract || !editor.isEmpty() || state.attachments.length > 0 || state.transcript.queue.length > 0 || input.remote?.readOnly) return undefined
    const blocks = state.transcript.blocks().filter((block) => block.turnId === turnId)
    const message = blocks.find((block) => block.kind === "user_message")
    if (!message || message.notice || message.shell) return undefined
    // A line of narration ("Checking the routes first.") is not an answer yet: GPT models write one before every first tool call.
    const said = blocks.reduce((total, block) => total + (block.kind === "agent_message" ? block.text.trim().length : 0), 0)
    return said > RETRACT_NARRATION_CHARS ? undefined : message.itemId
  }

  async function onEscape() {
    if (state.editingScratch) return endScratchEdit()
    if (state.editingGoal) return endGoalEdit()
    if (state.editingMemory) {
      state.editingMemory = undefined
      editor.clear()
      state.notice = ""
      state.page = "memory"
      return requestFrame()
    }
    if (state.planDraft) {
      state.planDraft = undefined
      editor.clear()
      state.notice = ""
      return requestFrame()
    }
    // Esc dismisses a pending question (the card's "esc dismiss"); the agent is told it was declined.
    const question = state.transcript.pendingRequests.find((request) => request.kind === "question")
    if (question) {
      editor.clear()
      const reply = await input.send({ type: "request.resolve", sessionId: state.sessionId, requestId: question.requestId, decision: { kind: "deny" } })
      report(reply)
      return requestFrame()
    }
    const turnId = state.transcript.activeTurn
    if (!turnId) {
      // Idle with an empty prompt: Esc twice goes back to an earlier prompt to edit and resend.
      if (actions.composer.backtrackEscape()) requestFrame()
      return
    }
    // The first Esc arms the cancel; the working row shows `[esc again to interrupt]` until the window closes.
    if (now() - state.escArmedAt > DOUBLE_ESC_MS) {
      state.escArmedAt = now()
      return requestFrame()
    }
    state.escArmedAt = 0
    // Nothing answered yet (a typo caught in time): the message is taken back, as if never sent, and waits in the prompt to fix.
    const unanswered = retractable(turnId)
    if (unanswered) {
      await actions.rewind("undo", false, unanswered)
      if (state.rewindCard?.state === "done") state.rewindCard = undefined
      state.notice = "message back in the prompt"
      return requestFrame()
    }
    const reply = await input.send({ type: "turn.cancel", sessionId: state.sessionId, turnId })
    if (!reply.ok && reply.error.code !== "target_mismatch") fail(reply.error.message)
    // The interrupt holds the queue; the terminal sends it on, so what was queued runs once the cancelled turn has stopped.
    // With `queueRestore` the queued messages come back into the prompt instead.
    if (reply.ok && state.tuiProfile.queueRestore) await actions.composer.restoreQueue()
    else if (reply.ok && await actions.composer.sendQueueNext()) state.notice = "interrupted · sending the queued message"
    requestFrame()
  }

  return { onInput, submit, onEscape }
}
