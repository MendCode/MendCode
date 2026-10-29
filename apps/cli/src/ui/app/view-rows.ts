import { VIEW_SLOT_NAMES, VIEW_SLOTS } from "@mendcode/extension-api/views"
import type { UiView } from "../../view/customize-page"
import type { AppContext } from "./context"

/** Every view slot as /customize > Views lists it: the owner (built-in, a package or a user/project file), faults, average time and the user's switch. */
export function viewRows(state: AppContext["state"]): UiView[] {
  const status = state.ext?.views.status() ?? []
  const owners = state.ext?.loaded ?? []
  return VIEW_SLOT_NAMES.map((slot): UiView => {
    const mine = status.findLast((entry) => entry.slot === slot)
    const disabled = state.tuiProfile.disabledViews.includes(slot)
    if (!mine) return { slot, label: VIEW_SLOTS[slot].label, owner: "built-in", disabled, tripped: false, strikes: 0, calls: 0, avgMs: 0 }
    const loaded = owners.find((entry) => entry.name === mine.owner)
    const owner = loaded?.pkg ? `package ${loaded.pkg}` : loaded?.source === "project" ? `project ${mine.owner}` : `user ${mine.owner}`
    return { slot, label: VIEW_SLOTS[slot].label, owner, disabled, tripped: mine.tripped, strikes: mine.strikes, calls: mine.calls, avgMs: mine.avgMs, ...(mine.lastError ? { lastError: mine.lastError } : {}) }
  })
}
