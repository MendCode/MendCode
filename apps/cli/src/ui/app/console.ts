import type { CommandInput } from "@mendcode/client"
import type { ConsoleLogin, ConsolePoll, ConsoleReport, SessionShare } from "@mendcode/protocol"
import type { ConsolePageState, SharePageState } from "../../view/console-page"
import type { AppContext } from "./context"
import { preload } from "../lazy-pages"
import { consoleOptions } from "../../view/console-options"

export function createConsole(ctx: AppContext) {
  const { state, input, requestFrame, copyText } = ctx
  let timer: ReturnType<typeof setTimeout> | undefined
  function stopConsole() { clearTimeout(timer); timer = undefined }
  async function request(view: ConsolePageState | SharePageState, command: CommandInput) {
    if (view.busy) return
    if (input.remote && command.type !== "session.share.get") { view.error = "Console and sharing control is local only"; requestFrame(); return }
    view.busy = true
    view.error = ""
    requestFrame()
    try {
      const reply = await input.send(command)
      if (!reply.ok) { view.error = reply.error.message; return }
      return reply.result
    } catch { view.error = "Console unavailable; refresh to retry" }
    finally { view.busy = false; requestFrame() }
  }
  async function refresh(view: ConsolePageState) {
    const result = await request(view, { type: "console.get" })
    if (result) { view.report = result as ConsoleReport; view.selected = Math.max(0, Math.min(view.selected, (consoleOptions(view.report, view.query).length || 1) - 1)) }
    requestFrame()
  }
  async function poll(view: ConsolePageState) {
    if (!view.login || state.console !== view || state.page !== "console") return
    const result = await request(view, { type: "console.poll", loginID: view.login.loginID }) as ConsolePoll | undefined
    if (!result || !view.login || state.console !== view || state.page !== "console") return
    if (result.status === "success") { view.login = undefined; view.message = `Logged in as ${result.accountEmail}`; await refresh(view) }
    else if (result.status === "denied" || result.status === "expired") { view.login = undefined; view.error = `Authorization ${result.status}` }
    else { view.message = result.status === "slow" ? "Authorization pending · slower polling" : "Waiting for authorization…"; stopConsole(); timer = setTimeout(() => void poll(view), result.intervalMs ?? view.login.intervalMs); timer.unref() }
    requestFrame()
  }
  async function consoleCommand(text: string) {
    const match = /^\/(org|console)(?:\s+(.*))?$/.exec(text.trim())
    const shared = /^\/(share|unshare)(?:\s+(.*))?$/.exec(text.trim())
    if (!match && !shared) return false
    stopConsole()
    await preload("console")
    if (state.console?.login) { await request(state.console, { type: "console.cancel", loginID: state.console.login.loginID }); state.console.login = undefined }
    if (shared) {
      const view: SharePageState = { readOnly: !!input.remote }
      state.sharePage = view
      state.page = "share"
      const args = shared[2]?.trim() ?? ""
      let command: CommandInput = { type: "session.share.get", sessionId: state.sessionId }
      if (shared[1] === "unshare") view.confirm = true
      else if (args === "create") command = { type: "session.share", sessionId: state.sessionId }
      else if (args === "sync") command = { type: "session.share.sync", sessionId: state.sessionId }
      else if (args) view.error = "Use /share [create|sync] or /unshare"
      const result = await request(view, command)
      if (result) view.share = result as SessionShare
    } else {
      const view: ConsolePageState = { selected: 0, scroll: 0, readOnly: !!input.remote, picker: match![1] !== "console", query: "" }
      state.console = view
      state.page = "console"
      if (match![2]) { if (view.picker) view.query = match![2]!.slice(0, 200); else view.error = "Use /console; s setup · l login" }
      await refresh(view)
    }
    requestFrame()
    return true
  }
  async function consoleKey(key: string) {
    if (state.page === "share") {
      const view = state.sharePage
      if (!view || view.busy) return
      if (key === "\x1b") { if (view.confirm) view.confirm = false; else state.page = "chat" }
      else if (view.confirm) {
        if (key === "n") view.confirm = false
        else if (key === "y") { const result = await request(view, { type: "session.unshare", sessionId: state.sessionId }); if (result) { view.share = result as SessionShare; view.confirm = false } }
      } else if (key === "c" && view.share?.url) copyText(view.share.url, "share URL")
      else if (key === "u") view.confirm = true
      else if (["m", "a", "d"].includes(key)) {
        const reply = await request(view, { type: "settings.set", patch: { share: ({ m: "manual", a: "auto", d: "disabled" } as const)[key as "m" | "a" | "d"] } })
        if (reply) { const result = await request(view, { type: "session.share.get", sessionId: state.sessionId }); if (result) view.share = result as SessionShare }
      } else if (["r", "\r", "s"].includes(key)) {
        const type = key === "r" ? "session.share.get" : key === "s" ? "session.share.sync" : "session.share"
        const result = await request(view, { type, sessionId: state.sessionId })
        if (result) view.share = result as SessionShare
      }
      return requestFrame()
    }
    const view = state.console
    if (!view || view.busy) return
    if (view.picker) {
      const orgs = consoleOptions(view.report, view.query)
      if (key === "\x1b") state.page = "chat"
      else if (key === "\x1b[A") view.selected = Math.max(0, view.selected - 1)
      else if (key === "\x1b[B") view.selected = Math.min(Math.max(0, orgs.length - 1), view.selected + 1)
      else if (key === "\r") {
        const org = orgs[view.selected]
        if (org?.active) state.page = "chat"
        else if (org) {
          const result = await request(view, { type: "console.switchOrg", accountID: org.accountID, orgID: org.orgID })
          if (result) { view.report = result as ConsoleReport; await input.send({ type: "models.list", sessionId: state.sessionId }); state.page = "chat"; ctx.say(`Switched to ${org.orgName}`) }
        }
      } else if (key === "\x7f") { view.query = (view.query ?? "").slice(0, -1); view.selected = 0 }
      else if (key === "\x15") { view.query = ""; view.selected = 0 }
      else if (!/[\x00-\x1f\x7f]/.test(key) && (view.query?.length ?? 0) + key.length <= 200) { view.query = (view.query ?? "") + key; view.selected = 0 }
      return requestFrame()
    }
    if (key === "\x1b") {
      stopConsole()
      if (view.login) { await request(view, { type: "console.cancel", loginID: view.login.loginID }); view.login = undefined }
      else if (view.form) view.form = undefined
      else if (view.confirm) view.confirm = undefined
      else state.page = "chat"
    } else if (view.login) {
      if (key === "p") { stopConsole(); await poll(view) }
      else if (key === "c") copyText(view.login.url, "login URL")
    } else if (view.confirm) {
      if (key === "n") view.confirm = undefined
      else if (key === "y") { const result = await request(view, { type: "console.logout", accountID: view.confirm }); if (result) { view.report = result as ConsoleReport; view.confirm = undefined; view.message = "Logged out"; await refresh(view) } }
    } else if (view.form) {
      const form = view.form, index = form.field, value = form.values[index] ?? "", cursor = form.cursors[index] ?? value.length
      if (key === "\r") {
        const result = await request(view, { type: "console.configure", enabled: true, url: form.values[0]!, tokenFile: form.values[1]! })
        if (result) { view.form = undefined; await refresh(view) }
      } else if (["\t", "\x1b[Z", "\x1b[A", "\x1b[B"].includes(key)) form.field = 1 - index
      else if (key === "\x1b[D") form.cursors[index] = Math.max(0, cursor - 1)
      else if (key === "\x1b[C") form.cursors[index] = Math.min(value.length, cursor + 1)
      else if (key === "\x01" || key === "\x1b[H") form.cursors[index] = 0
      else if (key === "\x05" || key === "\x1b[F") form.cursors[index] = value.length
      else if (key === "\x7f" && cursor > 0) { form.values[index] = value.slice(0, cursor - 1) + value.slice(cursor); form.cursors[index] = cursor - 1 }
      else if (key === "\x15") { form.values[index] = ""; form.cursors[index] = 0 }
      else if (!/[\x00-\x1f\x7f]/.test(key) && value.length + key.length <= (index === 0 ? 2048 : 4096)) { form.values[index] = value.slice(0, cursor) + key + value.slice(cursor); form.cursors[index] = cursor + key.length }
    } else if (key === "s") {
      const values = [view.report?.url ?? "http://127.0.0.1:8788", ""]
      view.form = { field: 0, values, cursors: values.map((value) => value.length) }
    } else if (key === "r") await refresh(view)
    else if (key === "l") {
      const result = await request(view, { type: "console.login" })
      if (result) { view.login = result as ConsoleLogin; await request(view, { type: "console.open", loginID: view.login.loginID }); timer = setTimeout(() => void poll(view), view.login.intervalMs); timer.unref() }
    } else if (key === "o" || key === "b") await request(view, { type: "console.open", ...(key === "b" ? { target: "billing" } : {}) })
    else if (key === "d") { const account = consoleOptions(view.report)[view.selected]?.accountID ?? view.report?.accounts.find((a) => a.active)?.accountID; if (account) view.confirm = account }
    else if (key === "\x1b[A" || key === "k") view.selected = Math.max(0, view.selected - 1)
    else if (key === "\x1b[B" || key === "j") view.selected = Math.min(Math.max(0, (view.report?.orgs.length ?? 0) - 1), view.selected + 1)
    else if (key === "\r") {
      const org = consoleOptions(view.report)[view.selected]
      if (org && !org.active) {
        const result = await request(view, { type: "console.switchOrg", accountID: org.accountID, orgID: org.orgID })
        if (result) { view.report = result as ConsoleReport; view.message = `Switched to ${org.orgName}`; await input.send({ type: "models.list", sessionId: state.sessionId }) }
      }
    } else if (key === "x") { const result = await request(view, { type: "console.configure", enabled: false }); if (result) view.report = result as ConsoleReport }
    requestFrame()
  }
  return { consoleCommand, consoleKey, stopConsole }
}
