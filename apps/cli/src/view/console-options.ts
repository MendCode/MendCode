import type { ConsoleOrg, ConsoleReport } from "@mendcode/protocol"

export function consoleOptions(report?: ConsoleReport, query = ""): ConsoleOrg[] {
  const needle = query.trim().toLowerCase()
  return (report?.orgs ?? []).filter((org) => `${org.orgName} ${org.accountEmail} ${new URL(org.accountUrl).host}`.toLowerCase().includes(needle))
    .toSorted((a, b) => Number(b.active) - Number(a.active) || a.accountEmail.localeCompare(b.accountEmail) || new URL(a.accountUrl).host.localeCompare(new URL(b.accountUrl).host) || a.orgName.localeCompare(b.orgName))
}
