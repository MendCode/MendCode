import type { Settings } from "@mendcode/protocol"
import type { QueuePageState, QueueRow } from "../../view/queue-page"
import { createQueuePageState, preload } from "../lazy-pages"
import type { AppContext } from "./context"
import { queuePolicy } from "./queue-policy"

type QueueMode = NonNullable<Settings["queue"]>["mode"]
type QueueList = { held: boolean; paused: boolean; entries: QueueRow[] }

const PRINTABLE = /^[^\x00-\x1f\x7f]+$/u

export function createQueue(ctx: AppContext, applySettings: (settings: Settings) => void) {
  const { input, state, report, requestFrame, say } = ctx

  const policy = () => queuePolicy(state)

  /** Reads the daemon's queue (the other terminal may have changed it) and keeps the selection and any open edit valid. */
  async function refresh() {
    const page = state.queueState
    if (!page || !state.sessionId) return
    const reply = await input.send({ type: "queue.list", sessionId: state.sessionId })
    if (state.queueState !== page) return
    if (!reply.ok) {
      page.error = reply.error.message.replace(/^\[[A-Z]+\]: /, "")
      return
    }
    const result = reply.result as unknown as Partial<QueueList> | undefined
    page.rows = result?.entries ?? []
    page.held = result?.held === true
    page.paused = result?.paused === true
    page.mode = policy()
    page.loaded = true
    page.selected = Math.max(0, Math.min(page.rows.length - 1, page.selected))
    if (page.deleting !== undefined && !page.rows.some((row) => row.queueId === page.deleting)) page.deleting = undefined
    if (page.edit && !page.rows.some((row) => row.queueId === page.edit!.queueId)) {
      page.edit = undefined
      page.error = "that message left the queue"
    }
  }

  async function openQueue() {
    await preload("queue")
    state.queueState = createQueuePageState(policy())
    state.page = "queue"
    requestFrame()
    await refresh()
    requestFrame()
  }

  async function queueCommand(args: string) {
    const mode = args.trim()
    if (mode && mode !== "after-response" && mode !== "after-tools" && mode !== "immediate") {
      state.notice = "usage: /queue [after-response | after-tools | immediate]"
      return
    }
    const reply = await input.send(mode ? { type: "settings.set", patch: { queue: { mode: mode as QueueMode } } } : { type: "settings.get" })
    if (!reply.ok) { report(reply); return }
    if (reply.ok && reply.result?.settings) applySettings(reply.result.settings as Settings)
    state.notice = `queue: ${policy()}`
    // Bare `/queue` opens the manager; naming a policy only saves it.
    if (!mode) return openQueue()
    requestFrame()
  }

  /** Sends one queue command and reloads the list; the failure text lands in the page header. */
  async function act(page: QueuePageState, command: Parameters<typeof input.send>[0]) {
    const reply = await input.send(command)
    page.error = reply.ok ? undefined : reply.error.message.replace(/^\[[A-Z]+\]: /, "")
    await refresh()
    return reply.ok ? reply : undefined
  }

  async function editKey(page: QueuePageState, key: string) {
    const edit = page.edit!
    page.error = undefined
    if (key === "\x1b") page.edit = undefined
    else if (key === "\r") {
      const row = page.rows.find((candidate) => candidate.queueId === edit.queueId)
      if (!edit.text.trim()) page.error = "a queued message cannot be empty"
      else if (!row || edit.text === row.text) page.edit = undefined
      else if (await act(page, { type: "queue.edit", sessionId: state.sessionId, queueId: edit.queueId as never, text: edit.text })) page.edit = undefined
    } else if (key === "\x7f" || key === "\b") {
      if (edit.cursor > 0) page.edit = { ...edit, text: edit.text.slice(0, edit.cursor - 1) + edit.text.slice(edit.cursor), cursor: edit.cursor - 1 }
    } else if (key === "\x1b[3~") page.edit = { ...edit, text: edit.text.slice(0, edit.cursor) + edit.text.slice(edit.cursor + 1) }
    else if (key === "\x1b[D") page.edit = { ...edit, cursor: Math.max(0, edit.cursor - 1) }
    else if (key === "\x1b[C") page.edit = { ...edit, cursor: Math.min(edit.text.length, edit.cursor + 1) }
    else if (key === "\x01" || key === "\x1b[H" || key === "\x1b[1~") page.edit = { ...edit, cursor: 0 }
    else if (key === "\x05" || key === "\x1b[F" || key === "\x1b[4~") page.edit = { ...edit, cursor: edit.text.length }
    else if (key === "\n") page.edit = { ...edit, text: `${edit.text.slice(0, edit.cursor)}\n${edit.text.slice(edit.cursor)}`, cursor: edit.cursor + 1 }
    else if (PRINTABLE.test(key)) page.edit = { ...edit, text: edit.text.slice(0, edit.cursor) + key + edit.text.slice(edit.cursor), cursor: edit.cursor + key.length }
  }

  async function queueKey(key: string) {
    const page = state.queueState
    if (!page) {
      state.page = "chat"
      return requestFrame()
    }
    if (page.edit) {
      await editKey(page, key)
      return requestFrame()
    }
    const row = page.rows[page.selected]
    const sessionId = state.sessionId
    if (key === "\x1b") {
      if (page.deleting !== undefined) page.deleting = undefined
      else {
        state.page = "chat"
        state.queueState = undefined
      }
    } else if (key === "\x1b[A" || key === "\x1b[B") {
      page.selected = Math.max(0, Math.min(page.rows.length - 1, page.selected + (key.endsWith("B") ? 1 : -1)))
      page.deleting = undefined
      page.error = undefined
    } else if ((key === "K" || key === "\x1b[1;2A" || key === "J" || key === "\x1b[1;2B") && row) {
      const up = key === "K" || key === "\x1b[1;2A"
      const target = page.selected + (up ? -1 : 1)
      page.deleting = undefined
      if (target >= 0 && target < page.rows.length && await act(page, { type: "queue.reorder", sessionId, queueId: row.queueId as never, to: up ? "up" : "down" })) page.selected = target
    } else if ((key === "e" || key === "\r") && row) {
      page.deleting = undefined
      if (row.editable) { page.error = undefined; page.edit = { queueId: row.queueId, text: row.text, cursor: row.text.length } }
      else page.error = row.kind === "message" || row.kind === "shell" ? "this message was expanded by a command or mention and cannot be edited" : "only a message can be edited"
    } else if (key === "s" && row) {
      page.deleting = undefined
      const reply = await act(page, { type: "queue.steer", sessionId, queueId: row.queueId as never })
      if (reply) say(reply.result?.steered ? "steering: joins after the next tool result" : "queued: this turn cannot take it sooner", "info")
    } else if (key === "p" && row) {
      page.deleting = undefined
      await act(page, { type: "queue.promote", sessionId, queueId: row.queueId as never })
    } else if (key === "x" && row) {
      if (page.deleting === row.queueId) {
        page.deleting = undefined
        await act(page, { type: "queue.remove", sessionId, queueId: row.queueId as never })
      } else page.deleting = row.queueId
    }
    requestFrame()
  }

  /** A queue change from any terminal while the page is open. */
  function noteQueue() {
    if (state.page === "queue") void refresh().then(requestFrame)
  }

  return { queueCommand, queueKey, noteQueue }
}
