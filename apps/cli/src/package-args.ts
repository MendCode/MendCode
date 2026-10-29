import type { CommandInput } from "@mendcode/client"
import { PACKAGE_SELECTIONS } from "@mendcode/protocol/wire"

type CatalogInput = Extract<CommandInput, { type: "packages.search" | "packages.show" | "packages.preview" | "packages.sources" | "packages.add-source" | "packages.remove-source" | "packages.refresh" | "packages.config" | "packages.resource" | "packages.install-catalog" | "packages.install-source" | "packages.disable-all" | "packages.assets" | "packages.create" | "packages.update" | "packages.delete-local" }>
type WithoutDirectory<T> = T extends unknown ? Omit<T, "directory"> : never
export type PackageAutomation = { kind: "package.catalog"; request: WithoutDirectory<CatalogInput> }

export function packageArguments(args: string[], flags: Map<string, string | true>, registry = false, repeated = new Map<string, string[]>()): PackageAutomation | { error: string } | undefined {
  const [action = "status", target, source] = args
  const value = (key: string) => typeof flags.get(key) === "string" ? String(flags.get(key)) : undefined
  const sourceId = source ?? value("source")
  const scope = flags.has("project") ? "project" as const : "user" as const
  const request = (input: WithoutDirectory<CatalogInput>): PackageAutomation => ({ kind: "package.catalog", request: input })
  const need = (label: string) => ({ error: `package ${action} needs ${label}` })
  if (["create", "update", "delete-local"].includes(action) && !registry) {
    if (args.length > 1) return { error: `package ${action} accepts flags, not positional arguments` }
    if (action === "delete-local") return request({ type: "packages.delete-local" })
    const metadata = Object.fromEntries([
      ["id", value("id")], ["title", value("title") ?? value("name")], ["description", value("description")], ["version", value("version")],
      ["kind", value("kind")], ["channel", value("channel")], ["sourceType", value("source-type")], ["sourceURL", value("source-url")],
      ["compatMendcode", value("compat-mendcode")], ["compatRuntimePack", value("compat-runtime-pack")],
    ].filter((entry) => entry[1] !== undefined))
    if (metadata.id !== undefined && !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(metadata.id)) return { error: "package id must use lowercase letters, digits, . _ - (max 64)" }
    const selections: { include?: Array<typeof PACKAGE_SELECTIONS[number] | "all">; exclude?: Array<typeof PACKAGE_SELECTIONS[number] | "all"> } = {}
    for (const key of ["include", "exclude"] as const) {
      if (!repeated.has(key)) continue
      const values = repeated.get(key)!.flatMap((item) => item.split(",").map((part) => part.trim()).filter(Boolean))
      if (!values.length || values.some((item) => item !== "all" && !PACKAGE_SELECTIONS.includes(item as typeof PACKAGE_SELECTIONS[number]))) return { error: `unknown or empty package --${key} target` }
      selections[key] = values as NonNullable<typeof selections[typeof key]>
    }
    return request({ type: action === "create" ? "packages.create" : "packages.update", metadata, ...selections })
  }
  if (registry && ["list", "status"].includes(action) || action === "sources") return request({ type: "packages.sources" })
  if (action === "search") return request({ type: "packages.search", query: target ?? "", ...(sourceId ? { sourceId } : {}) })
  if (action === "show") return target ? request({ type: "packages.show", name: target, ...(sourceId ? { sourceId } : {}) }) : need("<name> [source]")
  if (action === "preview") {
    if (registry) return request({ type: "packages.preview", sourceId: target ?? "local", scope })
    return target ? request({ type: "packages.preview", name: target, sourceId: sourceId ?? "local", scope }) : need("<name> [source]")
  }
  if (["use", "install"].includes(action) && target && (action === "use" || sourceId || /^[a-z0-9][a-z0-9._-]{0,63}$/.test(target))) return request({ type: "packages.install-catalog", name: target, ...(sourceId ? { sourceId } : {}), scope, ...(flags.has("replace") ? { replace: true } : {}) })
  if (["install-source", "use-source", ...(registry ? ["apply"] : [])].includes(action)) return target ? request({ type: "packages.install-source", sourceId: target, scope, ...(flags.has("replace") ? { replace: true } : {}) }) : need("<source>")
  if (["disable-all", "deselect-all"].includes(action)) return request({ type: "packages.disable-all", ...(flags.has("project") ? { scope } : {}) })
  if (action === "refresh") return target ? request({ type: "packages.refresh", sourceId: target }) : need("<source>")
  if (action === "config") {
    const key = target ? /^(user|project):/.test(target) ? target : `${scope}:${target}` : undefined
    const [verb, resource] = args.slice(2)
    if (!verb) return request({ type: "packages.config", ...(key ? { key } : {}) })
    if (!key || !["enable", "disable"].includes(verb) || !resource) return { error: "package config usage: config [<name>] | config <name> enable|disable <kind/name>" }
    return request({ type: "packages.resource", key, resource, enabled: verb === "enable" })
  }
  if (["add-source", ...(registry ? ["add"] : [])].includes(action)) {
    if (value("type") && !["local", "remote"].includes(value("type")!)) return { error: "registry sources must use --type local or --type remote (https catalog)" }
    const location = value("url") ?? value("location") ?? source
    return target && location ? request({ type: "packages.add-source", sourceId: target, location, enabled: flags.has("enable") }) : need("<id> <folder> [--enable]")
  }
  if (["remove-source", ...(registry ? ["remove"] : [])].includes(action)) return target ? request({ type: "packages.remove-source", sourceId: target }) : need("<source>")
  if (action === "assets") return request({ type: "packages.assets" })
  return undefined
}

export function packageCatalogText(report: Record<string, unknown>) {
  if (report.action === "create" || report.action === "update") return `${report.action} ${report.name}@${report.version}\nPackage: ${report.packagePath}\nManifest: ${report.manifestPath}\n${report.backupPath ? `Backup: ${report.backupPath}\n` : ""}Artifacts: ${Array.isArray(report.artifacts) ? report.artifacts.length : 0}\nSettings: ${Array.isArray(report.settings) ? report.settings.join(", ") || "none" : "none"}\n`
  if (report.action === "delete-local") return `delete-local\n${Array.isArray(report.removed) && report.removed.length ? `Removed: ${report.removed.join(", ")}\nTrash: ${report.trashPath}\n` : "No local package\n"}`
  if (Array.isArray(report.entries)) return `${report.entries.map((item) => `${item.sourceId}:${item.name}\t${item.version}\t${item.state}\t${item.description}`).join("\n") || "no catalog packages"}\n${Array.isArray(report.issues) && report.issues.length ? `${report.issues.join("\n")}\n` : ""}`
  if (Array.isArray(report.packages) && report.packages.every((item) => Array.isArray(item.resources))) return `${report.packages.map((item) => `${item.key}\n${item.resources.map((resource: { id: string; enabled: boolean }) => `  ${resource.enabled ? "on " : "off"} ${resource.id}`).join("\n") || "  no resources"}`).join("\n") || "no packages"}\n`
  if (Array.isArray(report.sources)) return `${typeof report.entries === "number" ? `fetched ${report.entries} packs\n` : ""}${report.sources.map((item) => `${item.id}\t${item.enabled ? "on" : "off"}\t${item.location}${item.remote ? item.fetchedAt ? `\tremote, fetched ${new Date(item.fetchedAt).toISOString().slice(0, 16).replace("T", " ")}` : "\tremote, not fetched" : ""}`).join("\n")}\n`
  return `${JSON.stringify(report, null, 2)}\n`
}
