import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { parseActivationState } from "@mendcode/protocol/wire"
import { readMcpServers } from "../mcp-config"
import { canonicalJson, sha256 } from "./bundle"
import { installedTreeHash } from "./export"
import type { ImportPlan } from "./plan"

export type CompareStatus = "match" | "differs" | "pending-approval" | "quarantined" | "kept-target" | "blocked" | "omitted"
export type CompareRow = { item: string; status: CompareStatus; expected?: string; obtained?: string; note?: string }
export type CompareReport = {
  rows: CompareRow[]
  counts: Record<CompareStatus, number>
  /** True only when every row matches and nothing was left out, quarantined or left for approval. */
  identical: boolean
  summary: string
}

const short = (value: unknown) => { const text = JSON.stringify(value) ?? "unset"; return text.length > 80 ? `${text.slice(0, 77)}…` : text }
const fileSha = (file: string) => { try { return sha256(readFileSync(file)) } catch { return undefined } }
const readJson = (file: string): Record<string, unknown> => { try { const value = JSON.parse(readFileSync(file, "utf8")); return value && typeof value === "object" && !Array.isArray(value) ? value : {} } catch { return {} } }

/**
 * Configuration the bundle describes (expected) against what this machine holds now (obtained), item by item. Built from
 * the plan, so a rewritten home folder is expected in its rewritten form; it reads the data directory and the settings
 * again, and claims nothing it did not read. Exclusions count as differences of the whole: never "identical" with omissions.
 */
export function compareWithBundle(input: { plan: ImportPlan; dataDir: string; settings: Record<string, unknown> }): CompareReport {
  const { plan } = input
  const dataDir = path.resolve(input.dataDir)
  const rows: CompareRow[] = []
  const disabled = Array.isArray(input.settings.disabledPackages) ? input.settings.disabledPackages as string[] : []
  const profile = readJson(path.join(dataDir, "tui", "profile.json"))
  let servers: Record<string, Record<string, unknown>> = {}
  try { servers = readMcpServers(path.join(dataDir, "mcp.json")) } catch { servers = {} }
  for (const step of plan.steps) {
    switch (step.kind) {
      case "unit": {
        if (step.status === "blocked") { rows.push({ item: step.unit, status: "blocked", ...(step.reason ? { note: step.reason } : {}) }); break }
        const differing = step.files.filter((file) => fileSha(path.join(dataDir, file.path)) !== file.sha256)
        rows.push({ item: step.unit, status: differing.length === 0 ? "match" : step.status === "keep" ? "kept-target" : "differs", expected: `${step.files.length} file${step.files.length === 1 ? "" : "s"}`, obtained: differing.length ? `${differing.length} differ` : "same bytes", ...(step.files.some((file) => file.rewritten) ? { note: "home folder rewritten" } : {}) })
        break
      }
      case "quarantine":
        rows.push({ item: step.unit, status: "quarantined", note: step.reason })
        break
      case "mcp": {
        const entry = servers[step.name]
        const pending = Boolean(entry && (entry as { pendingApproval?: unknown }).pendingApproval)
        rows.push({ item: `mcp.json#${step.name}`, status: step.status === "blocked" ? "blocked" : step.status === "keep" ? "kept-target" : !entry ? "differs" : pending ? "pending-approval" : step.status === "identical" ? "match" : "differs", ...(step.reason ? { note: step.reason } : {}) })
        break
      }
      case "package": {
        const dir = path.join(dataDir, "packages", step.name)
        if (step.status === "quarantine" || step.status === "blocked") { rows.push({ item: `packages/${step.name}`, status: step.status === "quarantine" ? "quarantined" : "blocked", ...(step.reason ? { note: step.reason } : {}) }); break }
        const tree = existsSync(dir) ? installedTreeHash(dir) : undefined
        const enabled = existsSync(dir) && !disabled.includes(`user:${step.name}`)
        const same = tree?.sha256 === step.treeSha256 && enabled === step.enabled
        rows.push({ item: `packages/${step.name}`, status: same ? "match" : step.status === "keep" ? "kept-target" : "differs", expected: `${step.enabled ? "on" : "off"} · ${step.treeSha256.slice(0, 12)}`, obtained: existsSync(dir) ? `${enabled ? "on" : "off"} · ${tree?.sha256.slice(0, 12) ?? "unreadable"}` : "not installed" })
        break
      }
      case "setting": {
        const same = canonicalJson(input.settings[step.key]) === canonicalJson(step.value)
        rows.push({ item: `settings.${step.key}`, status: same ? "match" : step.status === "keep" ? "kept-target" : "differs", expected: short(step.value), obtained: short(input.settings[step.key]) })
        break
      }
      case "profile": {
        if (step.status === "blocked") { rows.push({ item: `tui/profile.json#${step.key}`, status: "blocked", ...(step.reason ? { note: step.reason } : {}) }); break }
        const same = canonicalJson(profile[step.key]) === canonicalJson(step.value)
        rows.push({ item: `tui/profile.json#${step.key}`, status: same ? "match" : step.status === "keep" ? "kept-target" : "differs", expected: short(step.value), obtained: short(profile[step.key]) })
        break
      }
      case "activation": {
        if (step.status === "none") break
        const state = parseActivationState(readJson(path.join(dataDir, "activation.json")))
        const missing = step.kept.filter((key) => !state.kept.includes(key))
        const lookSame = !step.look || state.look === step.look
        rows.push({ item: "activation.json", status: missing.length === 0 && lookSame ? "match" : "differs", expected: `look ${step.look ?? "none"} · kept ${step.kept.join(", ") || "none"}`, obtained: `look ${state.look ?? "none"} · kept ${state.kept.join(", ") || "none"}` })
        break
      }
      case "pending":
        rows.push({ item: step.item, status: step.scope === "machine" ? "omitted" : "pending-approval", note: step.reason })
        break
    }
  }
  for (const entry of plan.excluded) rows.push({ item: entry.path, status: "omitted", note: entry.reason })
  const counts = { "match": 0, "differs": 0, "pending-approval": 0, "quarantined": 0, "kept-target": 0, "blocked": 0, "omitted": 0 } satisfies Record<CompareStatus, number>
  for (const row of rows) counts[row.status]++
  const identical = rows.length > 0 && counts.match === rows.length
  const rest = (Object.keys(counts) as CompareStatus[]).filter((key) => key !== "match" && counts[key] > 0).map((key) => `${counts[key]} ${key}`)
  const summary = identical
    ? `all ${rows.length} items match the bundle`
    : `${counts.match} of ${rows.length} items match the bundle; not identical: ${rest.join(", ")}`
  return { rows, counts, identical, summary }
}
