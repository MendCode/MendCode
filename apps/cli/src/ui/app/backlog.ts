import type { BacklogItem, BacklogReport } from "@mendcode/protocol/wire"
import { BACKLOG_USAGE, backlogChangeText, backlogCount, backlogLines, backlogOriginText, parseBacklogWords } from "../../view/backlog"
import { createTextPageState, preload } from "../lazy-pages"
import type { AppContext } from "./context"

/**
 * `/backlog`: the user's own list of pending things for this project (docs/sidebar.md). Every write is this command's;
 * the daemon keeps the list and the panel card (`/panel widget backlog`) draws the copy held in `state.backlog`.
 */
export async function runBacklogCommand(ctx: AppContext, actions: { switchSession(sessionId: string): Promise<unknown>; openFile(target: string): void }, args: string) {
  const { input, state, say, fail, requestFrame } = ctx
  const directory = input.directory
  if (!directory) return say("backlog needs a project directory", "warning")
  const words = parseBacklogWords(args.trim() ? args.trim().split(/\s+/) : [], state.sessionId ? { sessionId: state.sessionId } : {})
  if (words.kind === "error") return say(`${words.message} · ${BACKLOG_USAGE}`, "warning")

  const listed = async (): Promise<BacklogItem[] | undefined> => {
    const reply = await input.send({ type: "backlog.get", directory })
    if (!reply.ok) return fail(reply.error.message), undefined
    state.backlog = (reply.result as BacklogReport | undefined)?.items ?? []
    return [...state.backlog]
  }

  if (words.kind === "list") {
    // The list is a text page like /doctor's; its module is the one the recap page loads.
    const [items] = await Promise.all([listed(), preload("recap")])
    if (!items) return
    const open = items.filter((item) => !item.done), done = items.filter((item) => item.done)
    state.textPage = createTextPageState({
      title: "Backlog",
      summary: items.length ? `${backlogCount(items)} · /backlog add <text> · done <id> · remove <id> · clear` : "Nothing pending · /backlog add <text>",
      sections: [
        ...(open.length ? [{ heading: "Open", lines: backlogLines(open) }] : []),
        ...(done.length ? [{ heading: "Done", note: "/backlog clear removes these", lines: backlogLines(done) }] : []),
      ],
    })
    state.page = "text"
    return requestFrame()
  }

  if (words.kind === "open") {
    const item = (await listed())?.find((entry) => entry.id === words.id)
    if (!item) return say(`backlog: no item #${words.id}`, "warning")
    if (!item.origin?.sessionId && !item.origin?.path) return say(`backlog: #${item.id} has no session or file to open`, "info")
    if (item.origin.sessionId && item.origin.sessionId !== state.sessionId) await actions.switchSession(item.origin.sessionId)
    if (item.origin.path) actions.openFile(item.origin.path)
    return say(`backlog: #${item.id} · ${backlogOriginText(item.origin)}`, "info")
  }

  const before = words.change.op === "clear-done" ? state.backlog ?? await listed() : undefined
  const reply = await input.send({ type: "backlog.change", directory, change: words.change })
  if (!reply.ok) return fail(reply.error.message)
  const result = reply.result as (BacklogReport & { added?: number }) | undefined
  state.backlog = result?.items ?? []
  say(backlogChangeText(words.change, { added: result?.added, items: state.backlog }, before), "success")
  requestFrame()
}
