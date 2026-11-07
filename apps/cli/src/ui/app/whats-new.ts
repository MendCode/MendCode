import type { Settings } from "@mendcode/protocol"
import { featureOn } from "@mendcode/protocol/wire"
import { gatedHint } from "../../view/commands"
import type { WhatsNewChange, WhatsNewCost, WhatsNewPick } from "../../view/whatsnew-page"
import { createWhatsNewState, preload, whatsNewKey } from "../lazy-pages"
import type { AppContext } from "./context"

/** Most changes one `/whatsnew` call carries; the page says how many more `/whatsnew all` lists. */
const MAX_SENT_CHANGES = 80
const USAGE = "usage: /whatsnew [all]"

/**
 * `/whatsnew` (docs/whats-new.md, balanced and full: the `whats_new` feature). Bare, it lists what changed since the last look
 * and asks one model call (the aside role, else the session's model) which of those fit this user, showing the estimated tokens
 * first and the counted ones after; `/whatsnew all` lists the whole changelog with no call. An action applies only after its
 * preview and a second Enter: a settings change through `settings.set`, a command put in the prompt (it never runs by itself).
 */
export function createWhatsNew(ctx: AppContext) {
  const { input, state, editor, say, requestFrame } = ctx
  let visit = 0

  async function command(args: string) {
    const word = args.trim().toLowerCase()
    if (word && word !== "all") return say(USAGE, "warning")
    if (!featureOn(state.settingsNow, "whats_new")) return say(`/whatsnew · ${gatedHint("whats_new", state.settingsNow) ?? "off"}`, "info")
    const all = word === "all"
    await preload("whatsnew")
    const [{ bundledChangelog, freshItems, readSeen, sectionItems, writeSeen }, { brief, plainItem, WHATS_NEW_MAX_CHANGES }] = await Promise.all([import("../../changelog"), import("@mendcode/protocol/changelog")])
    let entries: ReturnType<typeof bundledChangelog>
    try { entries = bundledChangelog(input.version) } catch (error) { return say(error instanceof Error ? error.message : String(error), "error") }
    const seen = input.dataDir ? readSeen(input.dataDir) : undefined
    const listed = entries.flatMap((entry) => {
      const fresh = freshItems(entry, seen, entries)
      return sectionItems(entry).map((item, index) => ({ section: entry.title, item, fresh: fresh[index]! }))
    })
    const unseen = listed.filter((change) => change.fresh)
    // Nothing new (or a first look): the newest section stands for "this version".
    const newest = entries[0]?.title
    const mine = unseen.length ? unseen : listed.filter((change) => change.section === newest)
    const shown = all ? listed : mine
    const lead = seen === undefined ? "first look" : unseen.length ? `${unseen.length} new since your last look` : "nothing new since your last look"
    const changes: WhatsNewChange[] = shown.map((change) => ({ section: change.section, text: plainItem(change.item), fresh: change.fresh }))
    // The call carries one line per change, newest first, within the protocol's limit.
    const sent: string[] = []
    let size = 0
    for (const change of all ? [] : mine) {
      const line = `- [${change.section}] ${plainItem(brief(change.item, 200))}`
      if (sent.length === MAX_SENT_CHANGES || size + line.length + 1 > WHATS_NEW_MAX_CHANGES) break
      sent.push(line)
      size += line.length + 1
    }
    state.whatsNew = createWhatsNewState({ all, summary: `${input.version ? `MendCode ${input.version} · ` : ""}${lead}${!all && !unseen.length && newest ? ` · ${newest}` : ""}`, changes, unsent: all ? 0 : mine.length - sent.length })
    state.page = "whatsnew"
    if (input.dataDir) writeSeen(input.dataDir, entries)
    requestFrame()
    if (all) return
    const page = state.whatsNew
    const token = ++visit
    const live = () => token === visit && state.page === "whatsnew" && state.whatsNew === page
    const failWith = (message: string) => { if (live()) { page.status = "error"; page.error = message; requestFrame() } }
    if (input.remote) return failWith("/whatsnew reads this machine's memories and settings: run it on the machine that runs MendCode · /whatsnew all lists the changes")
    if (!sent.length) return failWith("no changes to ask about · /whatsnew all lists the changelog")
    const request = { type: "whatsnew.ask", directory: input.directory ?? ".", version: input.version ?? "dev", changes: sent.join("\n"), ...(state.sessionId ? { sessionId: state.sessionId } : {}) }
    const planned = await input.send({ ...request, dryRun: true } as never)
    if (!planned.ok) return failWith(planned.error.message)
    page.cost = planned.result as WhatsNewCost
    requestFrame()
    const reply = await input.send(request as never)
    if (!live()) return
    if (!reply.ok) return failWith(reply.error.message)
    const result = reply.result as WhatsNewCost & { suggestions?: WhatsNewPick[] }
    page.cost = { model: result.model, estimate: result.estimate, ...(result.usage ? { usage: result.usage } : {}) }
    page.picks = (result.suggestions ?? []).map((pick) => ({ ...pick, text: plainItem(pick.text) }))
    page.status = "ready"
    requestFrame()
  }

  async function act(pickIndex: number, kind: "apply" | "command") {
    const page = state.whatsNew
    const pick = page?.picks[pickIndex]
    if (!page || !pick) return
    if (kind === "command" && pick.command) {
      // The command waits in the prompt: the user runs it with Enter, or edits it.
      visit++
      state.page = "chat"
      editor.clear()
      editor.insert(pick.command)
      say(`${pick.command} is in the prompt · enter runs it`, "info")
      return
    }
    if (!pick.patch) return
    const reply = await input.send({ type: "settings.set", patch: pick.patch } as never)
    if (!reply.ok) { say(reply.error.message, "error"); return }
    state.settingsNow = (reply.result?.settings as Settings | undefined) ?? state.settingsNow
    pick.done = `applied · ${pick.diff?.[0] ?? "settings saved"}`
    say("settings saved · every terminal has them", "success")
  }

  async function key(raw: string) {
    // A paste arrives as one string: each character is a key, as typing it would be.
    const keys = /^[\x20-\x7e -￿]{2,}$/u.test(raw) ? [...raw] : [raw]
    for (const each of keys) {
      const page = state.whatsNew
      if (!page) { state.page = "chat"; break }
      const result = whatsNewKey(page, each)
      // The call in flight fills the page object it was started for, so the new state is copied into that object.
      Object.assign(page, result.state)
      if (result.action.type === "close") { visit++; state.page = "chat"; break }
      if (result.action.type === "apply" || result.action.type === "command") await act(result.action.pick, result.action.type)
      if (state.page !== "whatsnew") break
    }
    requestFrame()
  }

  return { command, key }
}
