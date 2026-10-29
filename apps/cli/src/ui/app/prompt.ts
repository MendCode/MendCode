import { expandPastes, livePastes, pasteLabel } from "../../view/paste-placeholders"
import type { AttachmentPasteResult, BlobRef, SessionId, SessionSummary } from "@mendcode/protocol"
import { truncateEnd } from "../../view/wrap"
import { attachmentToken, draftRefs, sentImageNumber, liveAttachments, pendingFromRefs, type PendingAttachment } from "../../view/attachments"
import { DIAGNOSTIC_COMMANDS, slashSuggestions, type SlashCommand } from "../../view/commands"
import { COMMIT_TEMPLATES } from "../../view/slash-aliases"
import { loadEditorLauncher, type EditorLauncher } from "../external-editor"
import { osc52Copy } from "../osc52"
import { contentSize, draftSize, unsentNotice, type UnsentDraft } from "../drafts"
import { actionHint } from "../keymap"
import { parseCommentDraft, readableMessage } from "../../view/reply-comments"
import { agentMentions, commandMentions, findMentionToken, findSlashToken, threadMentions, wantsThreads, type MentionEntry } from "../../view/mentions"
import { worthKeeping, type RecallEntry, type RecallKind } from "../../view/prompt-search"
import type { AppContext } from "./context"
import { preload } from "../lazy-pages"

export function createPrompt(ctx: AppContext, actions: { extOn(): boolean }) {
  const { input, state, drafts, editor, requestFrame, fail, say, stash, env } = ctx
  const { extOn } = actions

  /** Project/user commands from .mendcode/commands, loaded the first time the prompt starts with "/". */
  let customCommands: SlashCommand[] = []

  let customLoad: Promise<void> | undefined

  /** Saves the prompt as the session's draft after a pause (it survives a closed terminal). */
  /**
   * Pasted text goes in where the cursor is; a large one (`pasteSummary`, at least `pasteSummaryMinChars`) as a
   * `[Pasted Content N chars]` label the user can type around, which the message and the saved draft get as the whole text.
   */
  function insertPasted(text: string) {
    const clean = text.replace(/\r\n?/g, "\n")
    state.pastes = livePastes(state.pastes, editor.text)
    if (!state.tuiProfile.pasteSummary || clean.length < state.tuiProfile.pasteSummaryMinChars) return void editor.insert(clean)
    const label = pasteLabel(clean.length, state.pastes)
    state.pastes.push({ label, text: clean })
    editor.insert(label)
  }

  /** The prompt as the model gets it: every paste label still in it replaced by its text. */
  const expandedPrompt = () => expandPastes(editor.text, livePastes(state.pastes, editor.text))

  function syncDraft() {
    if (input.remote?.readOnly || state.page !== "chat" || state.editingScratch) return
    if (drafts.changed(state.sessionId, { text: expandedPrompt(), images: draftRefs(state.attachments, editor.text) })) state.notice = "draft over 64 KB: saved truncated"
  }

  const attachmentsOf = (images: BlobRef[]): PendingAttachment[] => pendingFromRefs(images)

  /** The attachments that belong to the prompt now (a deleted token took its attachment with it). */
  const liveOnes = () => liveAttachments(state.attachments, editor.text)

  /**
   * Adds an attachment to the prompt. With tokens on (`attachmentChips` inline or both) it also puts its token in the text at the
   * cursor, where the model will read it; with the chip row only (`above`) it waits after the text.
   */
  function addAttachment(item: PendingAttachment) {
    if (state.tuiProfile.attachmentChips === "above") {
      state.attachments = [...state.attachments, item]
      return
    }
    const tokened = { ...item, label: attachmentToken(state.attachments, item, sentImageNumber(state.transcript.blocks().filter((block) => block.kind === "user_message"))) }
    state.attachments = [...state.attachments, tokened]
    editor.insertToken(tokened.label)
    syncDraft()
  }

  /**
   * Puts a session's saved draft back into an empty prompt. `announce` (the start) then looks for the unsent drafts of the
   * project's other sessions, for example a terminal that was closed mid-typing, and says so in a notice.
   */
  async function restoreDraft(target: SessionId, options: { announce?: boolean } = {}) {
    const draft = await drafts.restore(target)
    // Pending comments saved with the draft come back as chips, whatever the prompt holds by now; a parked set stays parked.
    if (draft?.comments && target === state.sessionId) ctx.comments.restore(draft.comments.list, draft.comments.parked)
    if (draft && target === state.sessionId) {
      if (editor.isEmpty() && state.attachments.length === 0) {
        // Text, attachments and their tokens come back as they were, the cursor at the end, with no notice: it is simply the session's prompt.
        editor.insert(draft.text)
        state.attachments = attachmentsOf(draft.images)
        syncMentions()
        requestFrame()
      } else if (draft.text !== editor.text) {
        // Typed before the draft arrived: the prompt stays as it is and the draft waits in the stash, which the next save would otherwise replace.
        const parked = stash.push(draft.text, attachmentsOf(draft.images))
        if (parked.ok) say(`Unsent draft kept in the stash (${draftSize(contentSize(draft))}) · ${actionHint(state.bindings, "stash.pop") ?? "/stash"} restore`, "info")
        else fail(parked.error)
      }
    }
    if (options.announce) await loadUnsent(true)
  }

  /** The unsent drafts of this project's other sessions (older than the retention setting are deleted first). */
  async function loadUnsent(announce = false) {
    const days = state.tuiProfile.draftRetentionDays
    const reply = await input.send({ type: "draft.list", ...(input.directory ? { directory: input.directory } : {}), excludeSessionId: state.sessionId, limit: 20, ...(days > 0 ? { maxAgeDays: days } : {}) })
    if (!reply.ok) return
    state.unsent = (reply.result?.drafts as UnsentDraft[] | undefined) ?? []
    const notice = unsentNotice(state.unsent, actionHint(state.bindings, "drafts.restore") ?? "/drafts")
    if (announce && notice) state.notice = [state.notice, notice].filter(Boolean).join(" · ")
    requestFrame()
  }

  /**
   * Brings an unsent draft of another session into the prompt. A prompt being typed is parked in the prompt stash first, and the
   * draft leaves its old session only after the prompt's own draft is saved, so a crash in between loses nothing.
   */
  async function restoreUnsent(sessionId: SessionId | undefined = state.unsent[0]?.sessionId) {
    if (!sessionId) return say("no unsent drafts")
    const reply = await input.send({ type: "draft.get", sessionId })
    const draft = reply.ok ? (reply.result?.draft as { text?: unknown; attachments?: unknown } | undefined) : undefined
    if (!draft || typeof draft.text !== "string") {
      state.unsent = state.unsent.filter((item) => item.sessionId !== sessionId)
      return say(reply.ok ? "that draft is gone" : "cannot read drafts", "warning")
    }
    const typed = editor.text
    const hadPrompt = typed.trim() !== "" || liveOnes().length > 0
    if (hadPrompt) {
      const saved = stash.push(typed, liveOnes())
      if (!saved.ok) return fail(saved.error)
    }
    // A draft with comments on another session's answer: its chips come along (no longer tied to a message) unless some are pending here.
    const withComments = parseCommentDraft(draft.text)
    if (withComments && !ctx.comments.store.count) {
      editor.replaceAll(withComments.draft)
      ctx.comments.restore(withComments.comments.map(({ itemId: _other, ...comment }) => comment), withComments.parked)
    } else editor.replaceAll(withComments ? readableMessage(draft.text) : draft.text)
    state.attachments = attachmentsOf(Array.isArray(draft.attachments) ? draft.attachments as BlobRef[] : [])
    state.pastes = []
    promptReplaced()
    await drafts.settled()
    await input.send({ type: "draft.set", sessionId, text: "" })
    state.unsent = state.unsent.filter((item) => item.sessionId !== sessionId)
    state.notice = ""
    say(hadPrompt ? "draft restored · the prompt you had is in /stash" : "draft restored", "success", { quiet: !hadPrompt })
  }

  async function openDrafts() {
    await Promise.all([preload("drafts"), loadUnsent()])
    state.draftsState = { selected: 0 }
    state.page = "drafts"
    requestFrame()
  }

  async function draftsKey(key: string) {
    const s = state.draftsState ??= { selected: 0 }
    if (key === "\x1b") {
      if (s.deleting !== undefined) delete s.deleting
      else state.page = "chat"
    } else if (key === "\x1b[A" || key === "\x1b[B") {
      s.selected = Math.max(0, Math.min(state.unsent.length - 1, s.selected + (key.endsWith("B") ? 1 : -1)))
      delete s.deleting
    } else if (key === "\x04") {
      const target = state.unsent[s.selected]
      if (target && s.deleting === target.sessionId) {
        delete s.deleting
        await input.send({ type: "draft.set", sessionId: target.sessionId, text: "" })
        state.unsent = state.unsent.filter((item) => item.sessionId !== target.sessionId)
        s.selected = Math.max(0, Math.min(s.selected, state.unsent.length - 1))
      } else if (target) s.deleting = target.sessionId
    } else if (key === "\r" && state.unsent[s.selected]) {
      const target = state.unsent[s.selected]!.sessionId
      state.page = "chat"
      await restoreUnsent(target)
    }
    requestFrame()
  }

  /** Resolves a local path: media becomes a chip, project files/directories a mention, external text a chip. */
  async function attachPasted(rawPath: string) {
    if (input.remote) {
      say("path attachments disabled while remote", "warning")
      requestFrame()
      return false
    }
    const reply = await input.send({ type: "attachment.paste", path: rawPath, ...(input.directory ? { directory: input.directory } : {}) })
    if (!reply.ok) {
      fail(reply.error.message)
      requestFrame()
      // A line that is no file stays the text it was; a file the limits refuse (too big, not a supported type) adds nothing, token or path.
      return !/^(not a file|path must be absolute)/.test(reply.error.message.replace(/^\[[A-Z]+\]: /, ""))
    }
    const result = reply.result as AttachmentPasteResult
    if (result.kind === "image" || result.kind === "document") addAttachment(result.kind === "image" ? { kind: "image", ref: result.attachment, name: result.name, ...(result.width && result.height ? { width: result.width, height: result.height } : {}) } : { kind: "document", ref: result.attachment, name: result.name })
    else if (result.kind === "mention") editor.insert(`@${/\s/.test(result.path) ? JSON.stringify(result.path) : result.path} `)
    else addAttachment({ kind: "text", name: result.name, content: result.content, ...(result.directory ? { directory: true } : {}) })
    state.notice = ""
    requestFrame()
    return true
  }

  /**
   * Explicit clipboard action. Terminal paste events never probe the image clipboard.
   */
  async function pasteClipboardImage({ text = true }: { text?: boolean } = {}) {
    if (input.remote) {
      say("clipboard images disabled while remote", "warning")
      requestFrame()
      return
    }
    const reply = await input.send({ type: "attachment.clipboard", text })
    if (!reply.ok) {
      fail(reply.error.message)
      requestFrame()
      return
    }
    if (reply.result?.kind === "text") {
      insertPasted(String(reply.result.text))
      syncDraft()
      drafts.flush()
      syncMentions()
    }
    else {
      const { width, height } = reply.result ?? {}
      addAttachment({ kind: "image", ref: reply.result?.attachment as BlobRef, name: String(reply.result?.name ?? "clipboard.png"), ...(typeof width === "number" && typeof height === "number" ? { width, height } : {}) })
    }
    state.notice = ""
    requestFrame()
  }

  /** What the prompt changed to by undo, redo, a stash or the external editor: popups and the draft follow the text. */
  function promptReplaced() {
    state.suggestion = 0
    syncMentions()
    syncDraft()
    requestFrame()
  }

  function undoEdit(direction: "undo" | "redo") {
    if (editor[direction]()) return promptReplaced()
    say(direction === "undo" ? "nothing to undo" : "nothing to redo")
  }

  function stashPrompt() {
    if (editor.text.trim() === "" && !liveOnes().length) return say("nothing to stash")
    const saved = stash.push(editor.text, liveOnes())
    if (!saved.ok) return fail(saved.error)
    // Parked, not discarded: the stash holds it.
    state.submits++
    editor.clear()
    state.attachments = []
    promptReplaced()
    say(`stashed · ${stash.size} kept · /stash pop restores it`, "success")
  }

  /** Brings back the newest stash (or the `number`th of `/stash list`); a prompt being typed is stashed in its place, never lost. */
  function restoreStash(number?: number) {
    const typed = editor.text
    const replacement = typed.trim() !== "" || liveOnes().length ? { text: typed, at: ctx.now(), attachments: liveOnes() } : undefined
    const { entry, result } = stash.pop(number, replacement)
    if (!result.ok) return fail(result.error)
    if (!entry) return say(number === undefined ? "the stash is empty" : `no stash ${number}`, "warning")
    state.attachments = entry.attachments ?? []
    editor.replaceAll(entry.text)
    promptReplaced()
    say(typed.trim() === "" ? "restored from the stash" : "restored · the prompt you had is stashed", "success", { quiet: typed.trim() === "" })
  }

  async function listStash() {
    await preload("stash")
    state.stashState = { selected: 0 }
    state.page = "stash"
    requestFrame()
  }

  function stashKey(key: string) {
    const s = state.stashState ??= { selected: 0 }
    if (key === "\x1b") {
      if (s.deleting !== undefined) delete s.deleting
      else state.page = "chat"
    } else if (key === "\x1b[A" || key === "\x1b[B") {
      s.selected = Math.max(0, Math.min(stash.size - 1, s.selected + (key.endsWith("B") ? 1 : -1)))
      delete s.deleting
    } else if (key === "\x04") {
      if (s.deleting === s.selected) {
        const { result } = stash.pop(s.selected + 1)
        if (!result.ok) fail(result.error)
        s.selected = Math.max(0, Math.min(s.selected, stash.size - 1))
        delete s.deleting
      } else if (stash.size) s.deleting = s.selected
    } else if (key === "\r" && stash.size) {
      restoreStash(s.selected + 1)
      state.page = "chat"
    }
    requestFrame()
  }

  async function runStashCommand(args: string) {
    const [sub = "", rest = ""] = args.split(/\s+/)
    const number = /^[1-9]\d*$/.test(rest) ? Number(rest) : undefined
    if (sub === "") return listStash()
    if (sub === "list" || sub === "ls") return listStash()
    if (sub === "pop") return restoreStash(number)
    if (sub === "drop") {
      const dropped = stash.pop(number)
      if (!dropped.result.ok) return fail(dropped.result.error)
      if (!dropped.entry) return say(number === undefined ? "the stash is empty" : `no stash ${number}`, "warning")
      return say("dropped from the stash")
    }
    if (sub === "clear") {
      const cleared = stash.clear()
      return cleared.ok ? say("stash cleared") : fail(cleared.error)
    }
    state.notice = "usage: /stash [list | pop [n] | drop [n] | clear]"
  }

  /** The prompt's text through `$VISUAL`/`$EDITOR` in a temporary file; the terminal is handed over while it runs. */
  async function editInExternalEditor() {
    if (input.remote) return say("external editor disabled while remote", "warning")
    if (state.page !== "chat") return
    let launch: EditorLauncher
    try {
      launch = await (input.editorLauncher ?? loadEditorLauncher)()
    } catch {
      return fail("the external editor is not available in this install")
    }
    const result = await launch({
      text: editor.text,
      env: { VISUAL: env.VISUAL, EDITOR: env.EDITOR },
      ...(input.terminal ? { suspend: input.terminal.suspend, resume: input.terminal.resume } : {}),
    })
    requestFrame()
    if (!result.ok) return result.reason === "no-editor" ? say(result.message, "warning") : fail(result.message)
    if (!result.changed) return say("prompt unchanged")
    editor.replaceAll(result.text)
    promptReplaced()
    say("prompt updated from your editor", "success", { quiet: true })
  }

  /** Copies the `nth` most recent assistant answer (1 = the last) to the system clipboard through the terminal (OSC 52). */
  function copyAnswer(nth = 1, note?: string) {
    const answers = state.transcript.blocks().filter((block) => block.kind === "agent_message" && block.text.trim() !== "")
    const answer = answers[answers.length - nth]
    if (!answer) return say(answers.length === 0 ? "no answer to copy yet" : `only ${answers.length} answer${answers.length === 1 ? "" : "s"} so far`, "warning")
    const sequence = osc52Copy(answer.text.trim(), { tmux: Boolean(env.TMUX) })
    if (!sequence) return fail("that answer is too long to copy through the terminal")
    input.screen.write?.(sequence)
    say(`${nth === 1 ? "copied the last answer" : `copied answer ${nth} from the end`}${note ? ` · ${note}` : ""}`, "success")
  }

  /** The daemon keeps only the head of a very long prompt in recall and ends it with this note (see `cappedPromptHistoryEntry` in the store). */
  const TRUNCATED_RECALL = /\n… \[truncated: (\d+) chars, first \d+ kept\]$/

  /** A recalled shell line goes back into shell mode (its text is the editor text of shell mode, so `!!cmd` stays `!cmd`); anything else leaves it. */
  function showRecalled(entry: RecallEntry) {
    editor.clear()
    editor.insert(entry.text)
    state.recall.shown = editor.text
    state.shellMode = entry.kind === "shell"
    const truncated = TRUNCATED_RECALL.exec(entry.text)
    if (truncated) say(`truncated prompt, ${truncated[1]} chars originally`, "warning")
    else if (entry.kind === "draft") say("draft · not sent", "info")
  }

  /** The daemon's list as recall entries; an older daemon answers only `prompts`, all of them sent messages. */
  function recallEntriesOf(result: Record<string, unknown> | undefined): RecallEntry[] {
    const entries = result?.entries
    if (Array.isArray(entries)) {
      return entries.flatMap((entry): RecallEntry[] => {
        const { id, kind, text } = entry as { id?: unknown; kind?: unknown; text?: unknown }
        if (typeof text !== "string") return []
        return [{ text, kind: kind === "command" || kind === "shell" || kind === "draft" ? kind : "sent", ...(typeof id === "number" ? { id } : {}) }]
      })
    }
    return Array.isArray(result?.prompts) ? (result.prompts as string[]).map((text): RecallEntry => ({ text, kind: "sent" })) : []
  }

  /** The history is the local daemon's: a remote client keeps only what it enters itself, in memory. */
  async function loadRecall(): Promise<RecallEntry[]> {
    if (input.remote || !input.directory) return []
    const reply = await input.send({ type: "prompt.history", directory: input.directory, limit: 500 })
    return reply.ok ? recallEntriesOf(reply.result) : []
  }

  async function recallOlder() {
    state.recall.prompts ??= await loadRecall()
    if (state.recall.index + 1 >= state.recall.prompts.length) return
    if (state.recall.index === -1) {
      // Leaving the text behind for another entry: it stays reachable with ↓, and it is kept as a draft in case it is never come back to.
      state.recall.draft = editor.text
      state.recall.draftCursor = editor.cursorOffset
      state.recall.shell = state.shellMode
      keepDiscarded({ toast: false, track: false })
    }
    state.recall.index++
    showRecalled(state.recall.prompts[state.recall.index]!)
  }

  function recallNewer() {
    state.recall.index--
    if (state.recall.index >= 0) return showRecalled(state.recall.prompts![state.recall.index]!)
    editor.clear()
    editor.insert(state.recall.draft)
    editor.moveTo(state.recall.draftCursor)
    state.shellMode = state.recall.shell
  }

  /** Moves a text to the top of this terminal's copy of the list (a draft never demotes an entry that was really entered). */
  function bump(text: string, kind: RecallKind) {
    const list = state.recall.prompts
    if (!list) return
    const existing = list.find((entry) => entry.text === text)
    state.recall.prompts = [{ text, kind: kind === "draft" && existing ? existing.kind : kind }, ...list.filter((entry) => entry.text !== text)]
  }

  /** A prompt just entered (sent, a slash command, a shell line): the top of the list; `text` is the editor text, `!` of `!!cmd` included. */
  function remember(text: string, kind: RecallKind = "sent") {
    if (input.remote && !state.recall.prompts) state.recall.prompts = []
    bump(text, kind)
    state.recall.index = -1
    state.recall.draft = ""
    state.recall.shell = false
  }

  /** A slash command run in this terminal never reaches the daemon as a prompt: the history is told. */
  function recordCommand(text: string, sessionId: SessionId) {
    if (input.remote || !sessionId) return
    void input.send({ type: "prompt.record", sessionId, text, kind: "command" }).catch(() => undefined)
  }

  /** A command picked from the slash menu runs without being submitted: it still counts as entered. */
  function ranCommand(text: string) {
    remember(text, "command")
    recordCommand(text, state.sessionId)
  }

  /**
   * The prompt is about to be emptied or replaced without being sent: text worth keeping (12+ characters or several lines) is
   * saved as a draft entry of the project's history, reachable with ↑. `toast` says so once; `track` puts it on top of this
   * terminal's list (not when it is also the unsent text at the bottom of an ongoing recall).
   */
  function keepDiscarded(options: { toast?: boolean; track?: boolean; text?: string } = {}): Promise<void> {
    const text = options.text ?? editor.text
    if (input.remote || !state.sessionId || !worthKeeping(text)) return Promise.resolve()
    if (options.track !== false) bump(text, "draft")
    return input.send({ type: "prompt.record", sessionId: state.sessionId, text, kind: "draft" }).then((reply) => {
      if (options.toast && reply.ok && reply.result?.kept) say("draft saved · ↑ to restore", "success", { quiet: true })
    }).catch(() => undefined)
  }

  /** Custom commands plus the terminal extensions' `/name`s; the same array as `customCommands` while no extension has registered anything. */
  function suggestionPool(): SlashCommand[] {
    const commands = [...customCommands, ...(input.diagnostics ? DIAGNOSTIC_COMMANDS.filter((command) => !input.remote?.readOnly || command.name !== "snapshot") : [])]
    if (!state.ext || !extOn()) return commands
    const own = state.ext.commands().map(({ name, description }): SlashCommand => ({ name, group: "more", aliases: [], summary: description, ext: true }))
    return [...commands.filter((command) => !own.some((mine) => mine.name === command.name)), ...own]
  }

  function loadCustomCommands(refresh = false) {
    if (refresh) customLoad = undefined
    customLoad ??= (async () => {
      if (!input.directory) return
      const reply = await input.send({ type: "commands.list", directory: input.directory })
      const list = reply.ok ? ((reply.result?.commands as Array<{ name: string; description: string; argumentHint: string; source?: string }>) ?? []) : []
      customCommands = list.filter((c) => !(c.source === "builtin" && COMMIT_TEMPLATES.has(c.name))).map((c) => ({ name: c.name, group: "more", aliases: [], summary: [c.argumentHint, c.description].filter(Boolean).join("  "), custom: true as const, ...(c.source === "mcp" ? { mcp: true as const } : {}) }))
      requestFrame()
      if (!input.remote?.readOnly) void input.send({ type: "commands.discover", directory: input.directory }).then((discovered) => {
        if (!discovered.ok) return
        const prompts = (discovered.result?.commands as Array<{ name: string; description: string; argumentHint: string }>) ?? []
        if (!prompts.length) return
        for (const prompt of prompts) {
          const existing = customCommands.find((command) => command.name === prompt.name)
          if (existing && !existing.mcp) continue
          customCommands = customCommands.filter((command) => command.name !== prompt.name)
          customCommands.push({ name: prompt.name, group: "more", aliases: [], summary: [prompt.argumentHint, prompt.description].filter(Boolean).join("  "), custom: true, ...(existing?.mcp ? { mcp: true as const } : {}) })
        }
        if (state.page === "chat" && /^\/[a-z0-9][a-z0-9:_-]*$/i.test(editor.text)) requestFrame()
      }).catch(() => undefined)
    })()
    return customLoad
  }

  /** At most one `files.search` in flight; a keystroke while one runs replaces the pending query, not queues it (latest wins). */
  async function runMentionSearch(directory: string) {
    while (state.mentionPending !== undefined) {
      const query = state.mentionPending
      state.mentionPending = undefined
      state.mentionInFlight = true
      try {
        const [reply, catalog, sessions] = await Promise.all([
          input.send({ type: "files.search", directory, query, limit: 50 }),
          input.remote?.readOnly ? undefined : input.send({ type: "mcp.catalog", directory }),
          input.remote || !wantsThreads(query) ? undefined : input.send({ type: "session.list", directory, limit: 20, hideEmpty: true }),
        ])
        if (state.mentionToken?.query === query) {
          const files = [...threadMentions(sessions?.ok ? (sessions.result?.sessions as SessionSummary[] | undefined) : undefined, query, state.sessionId), ...(reply.ok ? (reply.result?.files as MentionEntry[]) ?? [] : [])]
          const resources = catalog?.ok ? (catalog.result?.resources as Array<{ id: string; description?: string }>) ?? [] : []
          state.mentionResults = [...agentMentions(state.agentReport?.agents, query), ...files, ...resources.filter((entry) => `${entry.id} ${entry.description ?? ""}`.toLowerCase().includes(query.toLowerCase())).map((entry): MentionEntry => ({ path: entry.id, kind: "resource", ...(entry.description ? { description: entry.description } : {}) }))].slice(0, 50)
          state.mentionSuggestion = 0
          requestFrame()
        }
      } catch {
        if (state.mentionToken?.query === query) state.mentionResults = []
      } finally {
        state.mentionInFlight = false
      }
    }
  }

  /** Recomputes the `@` token at the cursor after an edit; fetches its matches when the query changed. */
  function syncMentions() {
    if (state.page !== "chat") return
    const lines = editor.lines()
    const slashActive = lines.length === 1 && slashSuggestions(editor.text, suggestionPool()).length > 0
    const row = lines[editor.cursor.row] ?? ""
    const token = slashActive || state.shellMode ? undefined : findMentionToken(row, editor.cursor.col)
    const slash = token || slashActive || state.shellMode ? undefined : findSlashToken(row, editor.cursor.col, editor.cursor.row === 0)
    state.mentionSuggestion = 0
    // A command named mid-prompt is completed from the list already loaded: no search.
    if (slash) {
      state.mentionToken = slash
      state.mentionResults = commandMentions(suggestionPool(), slash.query)
      state.mentionLastQuery = undefined
      return
    }
    state.mentionToken = token
    if (!token) {
      state.mentionResults = []
      state.mentionLastQuery = undefined
      return
    }
    if (!input.directory || token.query === state.mentionLastQuery) return
    state.mentionLastQuery = token.query
    state.mentionPending = token.query
    if (!state.mentionInFlight) void runMentionSearch(input.directory)
  }

  /** Execution stays in the daemon; Tab only inserts the invocation. */
  async function expandCustom(text: string) {
    // `/commit push|pr` and `/pr comments` (or its alias `/pr-watch comments`) run the daemon's `commit-push`, `commit-pr` and `pr-comments` templates.
    const commit = /^\/(commit\s+(?:push|pr)|(?:pr|pr-watch)\s+comments)(?=\s|$)/i.exec(text)
    if (commit) text = `/${commit[1]!.toLowerCase().replace(/^pr-watch/, "pr").replace(/\s+/, "-")}${text.slice(commit[0].length)}`
    const match = /^\/([a-z0-9][a-z0-9:_-]*)(?:\s+([\s\S]*))?$/i.exec(text)
    if (!match || !input.directory) return undefined
    await loadCustomCommands(true)
    // `commit-push`, `commit-pr` and `pr-comments` are the daemon's templates behind `/commit push`, `/commit pr` and `/pr comments`; typed as a name of their own they are no command (unless the user wrote a command of that name).
    if (!commit && COMMIT_TEMPLATES.has(match[1]!.toLowerCase()) && !customCommands.some((c) => c.name === match[1]!.toLowerCase())) return undefined
    if (!customCommands.some((c) => c.name === match[1]!.toLowerCase()) && !commit && !["init", "review", "commit", "pr-comments", "security-review", "bughunter", "ultraplan", "wiki", "verify"].includes(match[1]!.toLowerCase()) && !match[1]!.includes(":")) return undefined
    if (customCommands.find((command) => command.name === match[1]!.toLowerCase())?.mcp) {
      const reply = await input.send({ type: "commands.expand", directory: input.directory, name: match[1]!.toLowerCase(), args: match[2] ?? "" })
      if (reply.ok) return String(reply.result?.prompt ?? "")
      state.notice = reply.error.message
      return null
    }
    return { name: match[1]!.toLowerCase(), args: match[2] ?? "" }
  }

  return { insertPasted, expandedPrompt, attachmentsOf, liveOnes, stashKey, syncDraft, restoreDraft, restoreUnsent, openDrafts, draftsKey, attachPasted, pasteClipboardImage, undoEdit, stashPrompt, restoreStash, runStashCommand, editInExternalEditor, copyAnswer, recallOlder, recallNewer, remember, recordCommand, ranCommand, keepDiscarded, bump, recallEntriesOf, suggestionPool, loadCustomCommands, syncMentions, expandCustom }
}
