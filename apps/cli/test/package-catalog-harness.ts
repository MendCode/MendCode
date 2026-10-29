import type { PackageCatalogEntry, PackageCatalogReport, PackageInfo, PackageSourceInfo } from "@mendcode/protocol"
import { appHarness, tempDir } from "./session-ui-harness"

export function catalogHarness(width = 100, height = 30, fail = false) {
  const entries: PackageCatalogEntry[] = [
    { name: "review-kit", title: "Review Kit", version: "1.2.0", description: "Code review commands, a reviewer agent and a testing skill.", sourceId: "team", location: "/catalog/review-kit", tags: ["review", "testing"], state: "available", contents: { skills: 1, commands: 2, agents: 1, tools: 0, themes: 0, mcp: false, extensions: 0 } },
    { name: "terminal-kit", title: "Terminal Kit", version: "0.4.0", description: "Terminal pages and widgets for local development.", sourceId: "team", location: "/catalog/terminal-kit", tags: ["terminal"], state: "available", contents: { skills: 0, commands: 0, agents: 0, tools: 1, themes: 1, mcp: true, extensions: 1 } },
  ]
  let sources: PackageSourceInfo[] = [{ id: "local", location: "/work/project", enabled: true, builtin: true }, { id: "team", location: "/catalog", enabled: true, builtin: false }]
  let installed: PackageInfo[] = [{ name: "local-kit", key: "user:local-kit", source: "user", dir: "/data/packages/local-kit", enabled: true, manifest: { name: "local-kit", version: "1.0.0", description: "Local workflow commands" }, contents: { tools: 0, skills: 1, commands: 2, themes: 0, mcp: false } }]
  let resources = [{ id: "skills/deploy", kind: "skills", name: "deploy", enabled: true }, { id: "commands/review", kind: "commands", name: "review", enabled: true }]
  const h = appHarness({ width, height, dataDir: tempDir(), directory: "/work/project", reply: (command) => {
    if (!command.type.startsWith("packages.")) return undefined
    if (fail) return { ok: false, error: { code: "invalid_command", message: "Catalog unavailable" } }
    if (command.type === "packages.list") return { ok: true, result: { directory: "/work/project", packages: installed } }
    if (command.type === "packages.search") {
      const report: PackageCatalogReport = { query: command.query ?? "", issues: [], entries: entries.filter((entry) => !command.sourceId || entry.sourceId === command.sourceId).map((entry) => ({ ...entry, state: installed.some((item) => item.name === entry.name) ? "active" : "available" })) }
      return { ok: true, result: report }
    }
    if (command.type === "packages.preview") {
      const entry = entries.find((entry) => entry.name === command.name)!
      return { ok: true, result: { entry, scope: command.scope, action: installed.some((item) => item.name === entry.name) ? "replace" : "install", problems: [] } }
    }
    if (command.type === "packages.install-catalog") {
      const entry = entries.find((entry) => entry.name === command.name)!
      installed.push({ name: entry.name, key: `${command.scope}:${entry.name}`, source: command.scope, dir: `/data/packages/${entry.name}`, enabled: true, manifest: { name: entry.name, version: entry.version, description: entry.description }, contents: entry.contents })
      return { ok: true, result: { directory: "/work/project", packages: installed } }
    }
    if (command.type === "packages.sources") return { ok: true, result: { sources } }
    if (command.type === "packages.add-source") {
      sources = [...sources.filter((source) => source.id !== command.sourceId), { id: command.sourceId, location: command.location, enabled: command.enabled ?? false, builtin: false, ...(command.location.startsWith("https://") ? { remote: true } : {}) }]
      return { ok: true, result: { sources } }
    }
    if (command.type === "packages.refresh") {
      sources = sources.map((source) => source.id === command.sourceId ? { ...source, fetchedAt: Date.UTC(2026, 9, 3, 12, 30) } : source)
      return { ok: true, result: { sources, entries: 1 } }
    }
    if (command.type === "packages.config" || command.type === "packages.resource") {
      if (command.type === "packages.resource") resources = resources.map((resource) => resource.id === command.resource ? { ...resource, enabled: command.enabled } : resource)
      return { ok: true, result: { directory: "/work/project", packages: [{ key: command.key, name: "local-kit", source: "user", resources }] } }
    }
    if (command.type === "packages.remove-source") { sources = sources.filter((source) => source.id !== command.sourceId); return { ok: true, result: { sources } } }
    if (command.type === "packages.disable-all") { installed = installed.map((pkg) => ({ ...pkg, enabled: false })); return { ok: true, result: { directory: "/work/project", packages: installed } } }
    if (command.type === "packages.assets") return { ok: true, result: { promptMode: "focus", totals: { skills: 2, commands: 4, agents: 1, prompts: 1, templates: 2, tools: 1, themes: 1, extensions: 1, mcp: true }, layers: [{ source: "user:review-kit", contents: entries[0]!.contents, prompts: 0, templates: 0 }, { source: "user", contents: entries[1]!.contents, prompts: 1, templates: 1 }, { source: "project", contents: { tools: 0, skills: 1, commands: 2, themes: 0, mcp: false }, prompts: 0, templates: 1 }] } }
    return { ok: true }
  } })
  h.app.applySettings({ onboarded: true })
  return h
}
