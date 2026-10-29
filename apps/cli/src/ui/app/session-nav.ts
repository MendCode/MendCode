import { createTextPageState, textPageKey, textPageRows, textPageViewport } from "../lazy-pages"
import type { AppContext } from "./context"

/**
 * `/recap` (the model's summary of the session) and `/changelog`, drawn as read-only text pages. The tree and the
 * bookmarks are `session-tree.ts`; the daemon owns the data (`session.recap`, docs/sessions.md).
 */
export function createSessionNav(ctx: AppContext) {
  const { input, state, requestFrame } = ctx
  let visit = 0

  /** `/recap` shows the model's summary of the session so far; `/recap refresh` writes it again even when the session did not change. */
  async function recapCommand(args: string) {
    const sessionId = state.sessionId
    const token = ++visit
    state.textPage = createTextPageState({ title: "Recap", status: "loading", hint: "asking the model for a recap…" })
    state.page = "text"
    requestFrame()
    const reply = await input.send({ type: "session.recap", sessionId, ...(args.trim() === "refresh" ? { refresh: true } : {}) })
    if (token !== visit || state.page !== "text") return
    state.textPage = reply.ok
      ? createTextPageState({ title: "Recap", sections: [{ heading: "So far", note: reply.result?.cached === true ? "cached, nothing new since" : "just written", lines: String(reply.result?.text ?? "").split("\n").map((line) => line.replace(/^\s*[-*]\s+/, "- ")) }], summary: "r writes it again" })
      : createTextPageState({ title: "Recap", status: "error", error: reply.error.message })
    requestFrame()
  }

  async function changelogCommand() {
    const { CHANGELOG, entriesSince, readSeen, writeSeen } = await import("../../changelog")
    const seen = input.dataDir ? readSeen(input.dataDir) : undefined
    const fresh = new Set(entriesSince(seen).map((entry) => entry.id))
    const unseen = seen === undefined ? 0 : fresh.size
    state.textPage = createTextPageState({
      title: "Changelog",
      summary: `${input.version ? `MendCode ${input.version} · ` : ""}${seen === undefined ? "first look" : unseen ? `${unseen} new since your last look` : "nothing new since your last look"}`,
      sections: CHANGELOG.map((entry) => ({ heading: `${entry.id} · ${entry.title}`, ...(seen !== undefined && fresh.has(entry.id) ? { note: "new" } : {}), lines: entry.items.map((item) => `- ${item}`) })),
    })
    state.page = "text"
    const newest = CHANGELOG[0]
    if (input.dataDir && newest) writeSeen(input.dataDir, newest.id)
    requestFrame()
  }

  async function textKey(key: string) {
    const page = state.textPage
    if (!page) { state.page = "chat"; return requestFrame() }
    if (key === "r" && page.title === "Recap" && page.status !== "loading") return recapCommand("refresh")
    const { width, height } = input.screen.size
    const view = textPageViewport(width, state.pageBodyHeight ?? height)
    const result = textPageKey(page, key, textPageRows(page, view.inner).length, view.rows)
    state.textPage = result.state
    // The import page goes back to the page it was opened from, not always to the chat.
    if (result.close) {
      visit++
      const back = page.title === "Import setup" ? state.textReturn : undefined
      state.textReturn = undefined
      state.page = back && back !== "text" && (back !== "setup" || state.onboarding || state.setupAdvanced) ? back : "chat"
    }
    requestFrame()
  }

  return { recapCommand, changelogCommand, textKey }
}
