import type { ConsoleReport, SessionShare } from "@mendcode/protocol"
import { appHarness, NOW } from "./session-ui-harness"

export function b74Harness(options: { width?: number; height?: number; enabled?: boolean; remote?: { host: string; readOnly: boolean } } = {}) {
  let report: ConsoleReport = { enabled: options.enabled ?? true, url: "http://127.0.0.1:8788", tokenConfigured: options.enabled ?? true, accounts: options.enabled === false ? [] : [{ accountID: "local-account", accountEmail: "dev@local.test", accountUrl: "http://127.0.0.1:8788", active: true, activeOrgID: "engineering" }], orgs: options.enabled === false ? [] : [
    { accountID: "local-account", accountEmail: "dev@local.test", accountUrl: "http://127.0.0.1:8788", orgID: "engineering", orgName: "Engineering", active: true },
    { accountID: "local-account", accountEmail: "dev@local.test", accountUrl: "http://127.0.0.1:8788", orgID: "research", orgName: "Research", active: false },
  ], switchableOrgCount: options.enabled === false ? 0 : 2, consoleManagedProviders: ["local-models"], activeOrgName: "Engineering", quota: { used: 42, limit: 100, resetAt: NOW + 86400000 }, billingUrl: "http://127.0.0.1:8788/billing" }
  let share: SessionShare = { sessionId: "", policy: "disabled", pending: false }
  let fail = false
  const h = appHarness({ ...options, directory: "/work/mendcode", reply: (command) => {
    if (fail && /^(console\.|session\.share|session\.unshare)/.test(command.type)) { fail = false; return { ok: false, error: { code: "invalid_command", message: "Console returned HTTP 503" } } }
    let result: unknown
    if (command.type === "console.get" || command.type === "console.accounts") result = structuredClone(report)
    else if (command.type === "console.configure") { report.enabled = command.enabled; if (command.url) report.url = command.url; report.tokenConfigured = report.tokenConfigured || !!command.tokenFile; result = report }
    else if (command.type === "console.login") result = { loginID: "local-login", url: "http://127.0.0.1:8788/device", userCode: "ABCD-EFGH", expiresAt: NOW + 60000, intervalMs: 60000 }
    else if (command.type === "console.poll") result = { status: "success", accountEmail: "dev@local.test" }
    else if (command.type === "console.switchOrg") { report.orgs = report.orgs.map((org) => ({ ...org, active: org.orgID === command.orgID })); report.activeOrgName = report.orgs.find((o) => o.active)?.orgName ?? ""; report.accounts[0]!.activeOrgID = command.orgID; result = report }
    else if (command.type === "console.logout") { report = { enabled: report.enabled, ...(report.url ? { url: report.url } : {}), tokenConfigured: report.tokenConfigured, accounts: [], orgs: [], switchableOrgCount: 0, consoleManagedProviders: [] }; result = report }
    else if (command.type === "session.share.get") result = { ...share, sessionId: command.sessionId }
    else if (command.type === "session.share" || command.type === "session.share.sync") {
      if (share.policy === "disabled") return { ok: false, error: { code: "invalid_command", message: "Sharing is disabled; choose manual or auto first" } }
      share = { ...share, sessionId: command.sessionId, url: "http://127.0.0.1:8788/share/local-session", syncedAt: NOW }; result = share
    } else if (command.type === "session.unshare") { share = { sessionId: command.sessionId, policy: share.policy, pending: false }; result = share }
    else if (command.type === "settings.set" && command.patch.share) { share.policy = command.patch.share as SessionShare["policy"]; result = { settings: { share: share.policy } } }
    return { ok: true, ...(result ? { result: structuredClone(result) as Record<string, unknown> } : {}) }
  } })
  h.app.applySettings({ onboarded: true })
  const keys = async (...values: string[]) => { for (const key of values) await h.app.onKey(key); await Bun.sleep(2); h.app.render() }
  return { ...h, keys, failNext: () => { fail = true }, getReport: () => structuredClone(report), patchReport: (patch: Partial<ConsoleReport>) => { report = { ...report, ...structuredClone(patch) } } }
}
