import type { ConsoleLogin, ConsoleReport, SessionShare } from "@mendcode/protocol"
import type { Line } from "../ui/theme"
import { appearancePage, focusedWindow } from "./appearance-layout"
import { fit, panelGrid, type GridPanel } from "./deck"
import { wrap } from "./wrap"
import { consoleOptions } from "./console-options"

export type ConsolePageState = { selected: number; scroll: number; report?: ConsoleReport; login?: ConsoleLogin | undefined; message?: string; error?: string; busy?: boolean; readOnly: boolean; picker?: boolean; query?: string; form?: { field: number; values: string[]; cursors: number[] } | undefined; confirm?: string | undefined }
export type SharePageState = { share?: SessionShare; error?: string; busy?: boolean; readOnly: boolean; confirm?: boolean }
const safe = (text: string) => text.replace(/[\x00-\x1f\x7f-\x9f]/g, "")
const lines = (values: string[], width: number): Line[] => values.flatMap((value) => wrap(safe(value), Math.max(1, width)).map((text) => [{ text }]))
export function renderConsolePage(input: { state: ConsolePageState; width: number; height: number }): Line[] {
  const { state, width, height } = input, report = state.report, inner = Math.max(1, width - 4), room = Math.max(1, height - 2), compact = width < 70
  const errors = [...(state.error ? [state.error] : []), ...(state.readOnly ? ["Console control is local only"] : []), ...(state.busy ? ["Reading Console…"] : []), ...(report?.unavailableAccountIDs?.length ? [`${report.unavailableAccountIDs.length} accounts unavailable`] : [])]
  let hints = compact ? "↑↓ · ↵ · r · s · l · esc" : "↑↓ select · ↵ switch · r refresh · s setup · l login · d logout · o open · esc"
  let rows: Line[]
  if (state.picker) {
    hints = compact ? "type search · ↑↓ · ↵ · esc" : "type to search · ↑↓ select · ↵ switch · esc"
    const options = consoleOptions(report, state.query)
    rows = panelGrid({ width: inner, compact: false, padding: true, heights: [room], rows: [[{ title: `Organizations · ${options.length}`, active: true, body: (w) => {
      const body: Line[] = []
      let category = "", selectedRow = 0
      options.forEach((org, index) => {
        const label = `${org.accountEmail}  ${new URL(org.accountUrl).host}`
        if (label !== category) { if (body.length) body.push([]); category = label; body.push(fit([{ text: safe(label), fg: "primary" }], w)) }
        if (state.selected === index) selectedRow = body.length
        body.push(fit([{ text: `${state.selected === index ? "›" : " "} ${safe(org.orgName)}${org.active ? " · active" : ""}`, fg: state.selected === index ? "primary" : "text", bold: state.selected === index }], w))
      })
      const prefix = [...lines([`Search ${state.query ?? ""}▏`, ...errors], w), []]
      return [...prefix, ...focusedWindow(body.length ? body : lines([state.busy ? "Loading orgs…" : state.query ? "No matching orgs" : "No orgs found"], w), selectedRow, Math.max(1, room - 4 - prefix.length))]
    } }]] })
  } else if (state.form) {
    hints = "tab field · ↵ save · esc"
    const form = state.form
    rows = panelGrid({ width: inner, compact: false, padding: true, heights: [room], rows: [[{ title: "Console setup", active: true, body: (w) => [
      ...["URL", "Token file"].map((label, index) => {
        const value = form.values[index] ?? "", cursor = form.cursors[index] ?? value.length, prefix = `${form.field === index ? "›" : " "} ${label}: `
        const start = Math.max(0, cursor - Math.max(1, w - prefix.length - 1) + 1)
        return fit([{ text: prefix, fg: form.field === index ? "primary" : "muted" }, { text: safe(form.field === index ? value.slice(start, cursor) + "▏" + value.slice(cursor) : value), fg: "text" }], w)
      }), [], ...lines(["Loopback origin · private token file", ...errors], w),
    ] }]] })
  } else if (state.login) {
    hints = "p poll · c copy URL · esc cancel"
    rows = panelGrid({ width: inner, compact: false, padding: true, heights: [room], rows: [[{ title: "Log in", body: (w) => lines([state.login!.url, `Enter code: ${state.login!.userCode}`, `Expires ${new Date(state.login!.expiresAt).toISOString()}`, state.message ?? "Waiting for authorization…", ...errors], w) }]] })
  } else if (state.confirm) {
    hints = "y log out · n cancel · esc"
    const email = report?.accounts.find((a) => a.accountID === state.confirm)?.accountEmail ?? ""
    rows = panelGrid({ width: inner, compact: false, padding: true, heights: [room], rows: [[{ title: "Log out?", body: (w) => lines([email, ...errors], w) }]] })
  } else {
    const connection: GridPanel = { title: "Console", body: (w) => lines([report?.enabled ? "On" : "Off", ...(report?.url ? [report.url] : []), `Token ${report?.tokenConfigured ? "configured" : "missing"}`, ...(state.message ? [state.message] : []), ...errors], w) }
    const orgs: GridPanel = { title: `Organizations · ${report?.orgs.length ?? 0}`, active: true, scroll: Math.max(0, state.selected * 3 - Math.max(1, room - 13)), body: (w) => report?.orgs.length ? consoleOptions(report).flatMap((org, index) => [fit([{ text: `${state.selected === index ? "›" : " "} ${safe(org.orgName)}${org.active ? " · active" : ""}`, fg: state.selected === index ? "primary" : "text", bold: state.selected === index }], w), ...lines([`  ${org.accountEmail}  ${new URL(org.accountUrl).host}`], w), []]) : lines([state.busy ? "Loading orgs…" : "No orgs found"], w) }
    const accounts: GridPanel = { title: `Accounts · ${report?.accounts.length ?? 0}`, body: (w) => lines(report?.accounts.length ? report.accounts.flatMap((a) => [`${a.accountEmail}${a.active ? " · active" : ""}`, a.accountUrl]) : ["Not logged in"], w) }
    const quota: GridPanel = { title: "Quota and billing", body: (w) => lines([...(report?.metadataError ? [report.metadataError] : []), ...(report?.quota ? [`${report.quota.used} / ${report.quota.limit}`, ...(report.quota.resetAt ? [`Resets ${new Date(report.quota.resetAt).toISOString()}`] : [])] : ["Quota unavailable"]), ...(report?.billingUrl ? [report.billingUrl] : []), ...(report?.consoleManagedProviders.length ? [`Providers: ${report.consoleManagedProviders.join(", ")}`] : [])], w) }
    rows = compact ? panelGrid({ width: inner, compact: false, padding: true, heights: [room], rows: [[{ ...orgs, title: `Console · ${report?.enabled ? "on" : "off"}`, body: (w) => [...lines([...(state.message ? [state.message] : []), ...errors], w), ...(!report?.orgs.length && report?.url ? lines([report.url], w) : []), ...(orgs.body as (w: number) => Line[])(w)] }]] }) : panelGrid({ width: inner, compact: false, padding: true, heights: [Math.min(room - 5, 7 + errors.length + (state.message ? 1 : 0)), Math.max(1, room - Math.min(room - 5, 7 + errors.length + (state.message ? 1 : 0)) - 1)], rows: [[connection, accounts], [orgs, quota]] })
  }
  return appearancePage({ title: state.picker ? "Switch org" : "Console", hints, body: rows, width, height })
}
export function renderSharePage(input: { state: SharePageState; width: number; height: number }): Line[] {
  const { state, width, height } = input, share = state.share, room = Math.max(1, height - 2)
  const errors = [...(state.error ? [state.error] : []), ...(share?.error ? [share.error] : []), ...(state.readOnly ? ["Sharing control is local only"] : []), ...(state.busy ? ["Updating share…"] : [])]
  const info: GridPanel = { title: state.confirm ? "Unshare this session?" : "Session link", body: (w) => lines([share?.url ?? "Not shared", ...(share?.syncedAt ? [`Synced ${new Date(share.syncedAt).toISOString()}`] : []), ...(share?.truncated ? ["Transcript truncated"] : []), ...errors], w) }
  const policy: GridPanel = { title: "Policy", body: (w) => lines([share?.policy ?? "disabled", "m manual · a auto · d disabled", "Redacted credentials · full replacement", "Reasoning and tool payloads excluded"], w) }
  const rows = panelGrid({ width: Math.max(1, width - 4), compact: false, padding: true, heights: [room], rows: width < 70 || state.confirm ? [[{ ...info, body: (w) => [...(info.body as (w: number) => Line[])(w), ...(!state.confirm ? [[], ...lines([`Policy ${share?.policy ?? "disabled"}`], w)] : [])] }]] : [[info, policy]] })
  return appearancePage({ title: "Share", hints: state.confirm ? "y unshare · n cancel · esc" : width < 70 ? "↵ create · s sync · u remove · r · esc" : "↵ create · s sync · u unshare · c copy · r refresh · m/a/d policy · esc", body: rows, width, height })
}
