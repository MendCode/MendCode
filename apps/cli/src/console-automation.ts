import type { CommandInput } from "@mendcode/client"
import type { ConsoleLogin, ConsolePoll, ConsoleReport, SessionShare, StaticShare } from "@mendcode/protocol"
import type { AutomationDeps, Common } from "./automation"
import type { ConsoleAutomation, ShareAutomation } from "./console-args"

type Reply = { ok: true; result: Record<string, unknown> } | { ok: false; message: string; code: string }
type Context = AutomationDeps & { request(command: CommandInput): Promise<Reply>; result(data: Record<string, unknown>, human: string): number; fail(message: string, exit?: number, code?: string): number }
export function consoleText(report: ConsoleReport): string {
  return [report.enabled ? `Console ${report.url ?? ""}` : "Console off", ...report.accounts.map((account) => `${account.active ? "●" : " "} ${account.accountEmail}  ${account.accountUrl}`), ...report.orgs.map((org) => `${org.active ? "●" : " "} ${org.orgName}  ${org.accountEmail}  ${org.orgID}`), ...(report.quota ? [`Quota ${report.quota.used}/${report.quota.limit}`] : []), ...(report.billingUrl ? [`Billing ${report.billingUrl}`] : []), ...(report.metadataError ? [report.metadataError] : []), ...(report.unavailableAccountIDs?.length ? [`${report.unavailableAccountIDs.length} accounts unavailable`] : [])].join("\n") + "\n"
}
export function shareText(share: SessionShare): string { return [`Sharing ${share.policy}`, share.url ?? "Not shared", ...(share.syncedAt ? [`Synced ${new Date(share.syncedAt).toISOString()}`] : []), ...(share.truncated ? ["Transcript truncated"] : []), ...(share.error ? [share.error] : [])].join("\n") + "\n" }
export function staticShareText(share: StaticShare): string { return share.shared ? `Shared ${share.target}: ${share.url}${share.truncated ? " · transcript truncated" : ""}\n` : `Not shared (${share.target})\n` }
export function createConsoleAutomation(ctx: Context) {
  return async (command: (ConsoleAutomation | ShareAutomation) & Common): Promise<number> => {
    if (command.kind === "share") {
      const reply = await ctx.request(command.request)
      if (!reply.ok) return ctx.fail(reply.message)
      if (command.request.type === "session.share.static") return ctx.result(reply.result, staticShareText(reply.result as StaticShare))
      return ctx.result(reply.result, command.request.type === "settings.set" ? `Sharing ${String((reply.result.settings as { share?: string })?.share ?? "disabled")}\n` : shareText(reply.result as SessionShare))
    }
    const run = async (input: CommandInput) => {
      const reply = await ctx.request(input)
      if (!reply.ok) return ctx.fail(reply.message)
      return ctx.result(reply.result, input.type === "console.open" ? `Opened ${reply.result.url}\n` : consoleText(reply.result as ConsoleReport))
    }
    if (command.operation === "setup") return run({ type: "console.configure", enabled: true, ...(command.argument ? { url: command.argument } : {}), tokenFile: command.tokenFile! })
    if (command.operation === "off") return run({ type: "console.configure", enabled: false })
    if (command.operation === "open") return run({ type: "console.open" })
    if (command.operation === "login") {
      const started = await ctx.request({ type: "console.login", ...(command.argument ? { url: command.argument } : {}) })
      if (!started.ok) return ctx.fail(started.message)
      const login = started.result as ConsoleLogin
      if (command.json) ctx.result(started.result, "")
      else ctx.out.write(`Go to: ${login.url}\nEnter code: ${login.userCode}\n`)
      if (!command.json && ctx.isTTY) await ctx.request({ type: "console.open", loginID: login.loginID })
      let interrupted = false
      let wake: (() => void) | undefined
      ctx.onInterrupt(() => { interrupted = true; wake?.() })
      let wait = login.intervalMs
      for (;;) {
        await new Promise<void>((resolve) => { const timer = (ctx.setTimer ?? ((ms, fn) => { const id = setTimeout(fn, ms); return { cancel: () => clearTimeout(id) } }))(wait, resolve); wake = () => { timer.cancel(); resolve() } })
        if (interrupted) { await ctx.request({ type: "console.cancel", loginID: login.loginID }); return 2 }
        const reply = await ctx.request({ type: "console.poll", loginID: login.loginID })
        if (!reply.ok) { await ctx.request({ type: "console.cancel", loginID: login.loginID }); return ctx.fail(reply.message) }
        const poll = reply.result as ConsolePoll
        if (poll.status === "success") return ctx.result(reply.result, `Logged in as ${poll.accountEmail}\n`)
        if (poll.status === "denied" || poll.status === "expired") return ctx.fail(`Console authorization ${poll.status}`)
        wait = poll.intervalMs ?? login.intervalMs
      }
    }
    const got = await ctx.request({ type: command.operation === "logout" ? "console.accounts" : command.operation === "status" ? "console.get" : "console.listOrgs" })
    if (!got.ok) return ctx.fail(got.message)
    const report = got.result as ConsoleReport
    if (command.operation === "status") return ctx.result(got.result, consoleText(report))
    if (command.operation === "orgs") return ctx.result(got.result, report.orgs.length ? report.orgs.map((org) => `  ${org.active ? "●" : " "} ${org.orgName}  ${org.accountEmail}  ${org.accountUrl}  ${org.orgID}`).join("\n") + "\n" : "No orgs found\n")
    if (command.operation === "logout") {
      if (!report.accounts.length) return ctx.result(got.result, "Not logged in\n")
      let id = report.accounts.find((account) => account.accountEmail === command.argument || account.accountID === command.argument)?.accountID
      if (command.argument && !id) return ctx.fail("Console account not found")
      if (!id && ctx.prompt) id = await ctx.prompt({ title: "Log out", label: "Account", options: report.accounts.map((a) => ({ value: a.accountID, label: a.accountEmail, hint: a.accountUrl })) })
      if (!id) return ctx.prompt ? 2 : ctx.fail("Logout needs an account email outside an interactive terminal", 64)
      return run({ type: "console.logout", accountID: id })
    }
    if (!report.orgs.length) return ctx.result(got.result, "No orgs found\n")
    const choices = report.orgs.map((org, index) => ({ value: String(index), label: `${org.orgName} (${org.accountEmail})`, hint: org.active ? "active" : org.accountUrl }))
    const matches = command.argument ? report.orgs.filter((org) => org.orgID === command.argument || org.orgName === command.argument) : []
    if (command.argument && matches.length !== 1) return ctx.fail("Organization not found or ambiguous")
    const selected = command.argument ? String(report.orgs.indexOf(matches[0]!)) : ctx.prompt ? await ctx.prompt({ title: "Switch org", label: "Organization", options: choices }) : undefined
    if (selected === undefined) return ctx.prompt ? 2 : ctx.fail("Switch needs an organization ID outside an interactive terminal", 64)
    const org = report.orgs[Number(selected)]
    if (!org) return ctx.fail("Selected organization unavailable")
    return run({ type: "console.switchOrg", accountID: org.accountID, orgID: org.orgID })
  }
}
