import { rangeBounds, usageWasteOpen } from "../lazy-pages"
import type { Settings, UsageReport, UsageWasteReport, UsageWeatherReport } from "@mendcode/protocol"
import type { WasteAction } from "../../view/usage-waste-tab"
import { USAGE_WIDGET_IDS } from "@mendcode/protocol/wire"
import type { TuiProfile } from "../../view/tui-profile"
import type { AppContext } from "./context"

export function createUsage(ctx: AppContext, changeProfile: (patch: Partial<TuiProfile>) => void) {
  const { input, state, localDay, now, fail, requestFrame, say } = ctx
  let generation = 0
  let wasteGeneration = 0
  let weatherGeneration = 0

  async function loadWeather() {
    const revision = ++weatherGeneration
    const profile = state.tuiProfile
    if (!profile.usageWidgets.includes("weather") || !profile.usageWeatherEnabled || !profile.usageWeatherRegion) {
      state.usageState.weather = { status: "off" }
      state.usageState.weatherLoading = false
      return
    }
    const region = profile.usageWeatherRegion
    state.usageState.weatherLoading = true
    requestFrame()
    const reply = await input.send({ type: "usage.weather.query", enabled: true, region })
    if (revision !== weatherGeneration || !state.tuiProfile.usageWeatherEnabled || !state.tuiProfile.usageWidgets.includes("weather") || state.tuiProfile.usageWeatherRegion !== region) return
    state.usageState.weatherLoading = false
    state.usageState.weather = reply.ok ? reply.result as UsageWeatherReport : { status: "error", region }
    requestFrame()
  }

  async function loadUsage() {
    const revision = ++generation
    const { from, to } = rangeBounds(state.usageState.range, localDay(now()))
    const { scope, project } = state.usageState
    const reply = await input.send({ type: "usage.query", from, to, scope, ...(input.directory ? { directory: input.directory } : {}), ...(project ? { project } : {}) })
    if (revision !== generation) return
    if (!reply.ok) fail(reply.error.message)
    else state.usageReport = reply.result as UsageReport
    requestFrame()
    if (usageWasteOpen(state.usageState)) await loadWaste()
    await loadWeather()
  }

  /** The Waste tab's report for the page's range and scope. */
  async function loadWaste() {
    const revision = ++wasteGeneration
    const { from, to } = rangeBounds(state.usageState.range, localDay(now()))
    const { scope, project } = state.usageState
    state.usageWasteLoading = true
    requestFrame()
    const reply = await input.send({ type: "usage.waste", from, to, scope, ...(input.directory ? { directory: input.directory } : {}), ...(project ? { project } : {}) })
    if (revision !== wasteGeneration) return
    state.usageWasteLoading = reply.ok ? undefined : false
    if (reply.ok) state.usageWaste = reply.result as UsageWasteReport
    else fail(reply.error.message)
    requestFrame()
  }

  /** Enter on the Waste tab: saves the finding's fix or the change's revert, then reads the report again so the change shows. */
  async function applyWaste(action: WasteAction) {
    const reply = await input.send({ type: "settings.set", patch: action.patch })
    if (!reply.ok) return fail(reply.error.message.replace(/^\[DAEMON\]:\s*/, ""))
    state.settingsNow = (reply.result as { settings?: Settings } | undefined)?.settings ?? state.settingsNow
    say(action.kind === "apply" ? `applied: ${action.label} · Changes measures it from now; enter on it there puts it back` : `put back: ${action.change.label}`, "success")
    state.usageState = { ...state.usageState, wasteIndex: 0, scroll: 0 }
    await loadWaste()
  }

  /** Settings consume their keys before the report, so Enter never opens a session while editing. */
  async function usageSettingsKey(key: string): Promise<boolean> {
    const page = state.usageState
    if (page.weatherInput !== undefined) {
      const chars = [...page.weatherInput]
      const cursor = page.weatherCursor ?? chars.length
      if (key === "\x1b") { delete page.weatherInput; delete page.weatherCursor }
      else if (key === "\r") {
        const region = page.weatherInput.trim()
        changeProfile({ usageWeatherEnabled: !!region, usageWeatherRegion: region, ...(region && !state.tuiProfile.usageWidgets.includes("weather") ? { usageWidgets: [...state.tuiProfile.usageWidgets, "weather"] } : {}) })
        delete page.weatherInput
        delete page.weatherCursor
        await loadWeather()
      } else if (key === "\x15") { page.weatherInput = ""; page.weatherCursor = 0 }
      else if (key === "\x1b[D") page.weatherCursor = Math.max(0, cursor - 1)
      else if (key === "\x1b[C") page.weatherCursor = Math.min(chars.length, cursor + 1)
      else if (key === "\x1b[H" || key === "\x01") page.weatherCursor = 0
      else if (key === "\x1b[F" || key === "\x05") page.weatherCursor = chars.length
      else if (key === "\x7f" || key === "\b") { if (cursor) chars.splice(cursor - 1, 1); page.weatherInput = chars.join(""); page.weatherCursor = Math.max(0, cursor - 1) }
      else if (key === "\x1b[3~") { chars.splice(cursor, 1); page.weatherInput = chars.join("") }
      else if (!/[\x00-\x1f\x7f-\x9f]/.test(key) && page.weatherInput.length + key.length <= 120) { chars.splice(cursor, 0, ...key); page.weatherInput = chars.join(""); page.weatherCursor = cursor + [...key].length }
      requestFrame()
      return true
    }
    if (page.widgetIndex !== undefined) {
      if (key === "\x1b" || key === "q" || key.toLowerCase() === "c") delete page.widgetIndex
      else if (key === "\x1b[A" || key === "k") page.widgetIndex = Math.max(0, page.widgetIndex - 1)
      else if (key === "\x1b[B" || key === "j") page.widgetIndex = Math.min(USAGE_WIDGET_IDS.length - 1, page.widgetIndex + 1)
      else if (key === "\x1b[H") page.widgetIndex = 0
      else if (key === "\x1b[F") page.widgetIndex = USAGE_WIDGET_IDS.length - 1
      else if (key === "\r" || key === " ") {
        const id = USAGE_WIDGET_IDS[page.widgetIndex]!
        const enabled = state.tuiProfile.usageWidgets
        changeProfile({ usageWidgets: enabled.includes(id) ? enabled.filter((entry) => entry !== id) : [...enabled, id], ...(id === "clock" ? { usageClock: !enabled.includes(id) } : {}) })
        page.scroll = 0
        await loadWeather()
      } else if (key.toLowerCase() === "d") { changeProfile({ usageWidgets: [] }); page.scroll = 0; await loadWeather() }
      requestFrame()
      return true
    }
    if (key.toLowerCase() === "c") { page.widgetIndex = 0; requestFrame(); return true }
    if (key.toLowerCase() === "w") { page.weatherInput = state.tuiProfile.usageWeatherRegion; page.weatherCursor = [...page.weatherInput].length; requestFrame(); return true }
    return false
  }

  return { loadUsage, loadWaste, applyWaste, usageSettingsKey }
}
