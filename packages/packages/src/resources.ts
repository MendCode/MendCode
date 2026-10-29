import { existsSync, readdirSync } from "node:fs"
import path from "node:path"
import { resourceId, resourceKey, RESOURCE_KINDS, type ExtensionSource, type ResourceKind } from "./layers"
import { PackageError } from "./install"
import { listPackages } from "./manifest"

export const MAX_PACKAGE_RESOURCES = 500

export type PackageResource = { id: string; kind: ResourceKind; name: string; enabled: boolean }
export type PackageResources = { key: string; name: string; source: ExtensionSource; resources: PackageResource[] }

const entries = (dir: string) => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((entry) => !entry.name.startsWith(".")).sort((a, b) => a.name.localeCompare(b.name)) : [])

function markdownNames(dir: string, prefix = ""): string[] {
  return entries(dir).flatMap((entry) => entry.isDirectory() ? markdownNames(path.join(dir, entry.name), `${prefix}${entry.name}:`) : entry.isFile() && entry.name.endsWith(".md") ? [`${prefix}${entry.name.slice(0, -3)}`.toLowerCase()] : [])
}

const stems = (dir: string, extension: RegExp) => entries(dir).filter((entry) => entry.isFile() && extension.test(entry.name) && !entry.name.endsWith(".d.ts")).map((entry) => entry.name.replace(extension, ""))

/** The switchable resources a package folder ships, by kind; names follow what each loader calls them. Nothing is read or imported. */
export function packageResourceIds(dir: string): Array<{ id: string; kind: ResourceKind; name: string }> {
  const names: Record<ResourceKind, string[]> = {
    skills: entries(path.join(dir, "skills")).filter((entry) => entry.isDirectory() && existsSync(path.join(dir, "skills", entry.name, "SKILL.md"))).map((entry) => entry.name),
    commands: markdownNames(path.join(dir, "commands")),
    agents: stems(path.join(dir, "agents"), /\.md$/),
    themes: stems(path.join(dir, "themes"), /\.json$/),
    tools: stems(path.join(dir, "tools"), /\.json$/),
    extensions: [
      ...stems(path.join(dir, "extensions"), /\.(ts|js)$/),
      ...entries(path.join(dir, "extensions")).filter((entry) => entry.isDirectory() && ["index.ts", "index.js"].some((file) => existsSync(path.join(dir, "extensions", entry.name, file)))).map((entry) => entry.name),
    ],
  }
  return RESOURCE_KINDS.flatMap((kind) => names[kind].map((name) => ({ id: resourceId(kind, name), kind, name }))).slice(0, MAX_PACKAGE_RESOURCES)
}

/** Every installed package (optionally one key) with its resources and whether each is on. */
export function listPackageResources(input: { userDir: string; directory: string; disabledResources?: readonly string[]; key?: string | undefined }): PackageResources[] {
  const off = new Set(input.disabledResources ?? [])
  return listPackages({ userDir: input.userDir, directory: input.directory })
    .filter((pkg) => !input.key || pkg.key === input.key)
    .map((pkg) => ({ key: pkg.key, name: pkg.name, source: pkg.source, resources: packageResourceIds(pkg.dir).map((resource) => ({ ...resource, enabled: !off.has(resourceKey(pkg.key, resource.id)) })) }))
}

/** Settings value after switching one resource; throws when the package or resource does not exist. */
export function setResourceEnabled(input: { userDir: string; directory: string; disabledResources: readonly string[]; key: string; resource: string; enabled: boolean }): string[] {
  const found = listPackageResources({ userDir: input.userDir, directory: input.directory, key: input.key })[0]
  if (!found) throw new PackageError(`${input.key} is not installed`)
  if (!found.resources.some((resource) => resource.id === input.resource)) throw new PackageError(`${input.key} has no resource ${input.resource}`)
  const full = resourceKey(input.key, input.resource)
  const rest = input.disabledResources.filter((entry) => entry !== full)
  return input.enabled ? rest : [...rest, full]
}
