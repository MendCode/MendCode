import { posix } from "node:path"
import type { WorkspacePackage } from "./types"

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value)

/** Prefer source/types to generated JS, but only the graph's indexed paths can ever be resolved. */
function targets(value: unknown, depth = 0): string[] {
  if (depth > 12) return []
  if (typeof value === "string") return [value]
  if (Array.isArray(value)) return value.flatMap((entry) => targets(entry, depth + 1))
  if (!object(value)) return []
  const ordered = [...new Set(["source", "types", "import", "require", "default", ...Object.keys(value)])]
  return ordered.flatMap((key) => targets(value[key], depth + 1))
}

export function workspacePackage(text: string, dir: string): WorkspacePackage | undefined {
  let data: unknown
  try { data = JSON.parse(text) } catch { return undefined }
  if (!object(data) || typeof data.name !== "string" || !data.name) return undefined
  const entries: Record<string, string[]> = {}
  const field = data.exports
  if (field !== undefined) {
    if (object(field) && Object.keys(field).some((key) => key.startsWith("."))) {
      for (const [key, value] of Object.entries(field)) entries[key] = targets(value)
    } else entries["."] = targets(field)
  } else {
    entries["."] = ["source", "types", "typings", "module", "main"].flatMap((key) => targets(data[key]))
    entries["."].push("./index")
    entries["./*"] = ["./*"]
  }
  return { name: data.name, dir, entries }
}

export function workspaceTargets(spec: string, packages: readonly WorkspacePackage[]): string[] {
  // `startsWith(name)` and a "/" after it, not `startsWith(`${name}/`)`: the graph asks this for every import of every file, so it
  // builds no string per package.
  const matching = packages.filter((pkg) => spec === pkg.name || (spec.startsWith(pkg.name) && spec.charCodeAt(pkg.name.length) === 47)).sort((a, b) => b.name.length - a.name.length)
  const pkg = matching[0]
  if (!pkg || matching[1]?.name === pkg.name) return []
  const subpath = spec === pkg.name ? "." : `.${spec.slice(pkg.name.length)}`
  let values = pkg.entries[subpath]
  if (!values) {
    const patterns = Object.keys(pkg.entries).filter((key) => key.includes("*")).sort((a, b) => b.indexOf("*") - a.indexOf("*") || b.length - a.length)
    for (const pattern of patterns) {
      const [prefix, suffix = ""] = pattern.split("*")
      if (!subpath.startsWith(prefix!) || !subpath.endsWith(suffix) || subpath.length < prefix!.length + suffix.length) continue
      const capture = subpath.slice(prefix!.length, suffix ? -suffix.length : undefined)
      values = pkg.entries[pattern]!.map((value) => value.replaceAll("*", capture))
      break
    }
  }
  return (values ?? []).flatMap((value) => {
    const relative = posix.normalize(value)
    if (posix.isAbsolute(relative) || relative === ".." || relative.startsWith("../") || relative.includes("\\")) return []
    return [posix.join(pkg.dir, relative)]
  })
}
