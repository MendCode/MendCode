import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import path from "node:path"
import { PROGRAM_NAME } from "@mendcode/program"
import { scaffoldPackage, packageFiles } from "@mendcode/extension-api/package-scaffold"
import { activationOf, activationPackages, checkPackage, createPackageRegistry, describeActivation, listPackages, packageCapabilities, packageResourceIds, PackageError, readManifest, readPackageKeybindings, readActivationState, readStoredProfile, type ExtensionLayer, type PackageHost } from "@mendcode/packages"
import type { PackagePort, PackageRequest } from "@mendcode/tools"
import { hasLook, resolveActivation } from "@mendcode/protocol/wire"
import { MAX_PRECEDENCE_CLAIMS, fileClaims } from "./precedence"
import { readPackageTree } from "./package-tree"
import { packageMutation } from "./packages-tool"

export function createSelfPackages(input: {
  userDir: string
  directory: string
  host: PackageHost
  local(): boolean
  trusted(): boolean
  disabled(): string[]
  disabledResources?(): string[]
  layers(): ExtensionLayer[]
  manage(command: Record<string, unknown>): Promise<Record<string, unknown>>
  catalog(command: Record<string, unknown>): Promise<Record<string, unknown>>
}): PackagePort {
  const receipts = new Map<string, string>()
  const assertLocal = () => { if (!input.local()) throw new PackageError("Packages require a local session") }
  const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
  /** What the user can do in the shell when the chat approval cannot cover a package, named for the request. */
  const shellAlternative = (request: PackageRequest, name: string, directory: string, scope: "user" | "project") => {
    const flag = scope === "project" ? " --project" : ""
    const command = request.action === "enable" || request.action === "switch-look" ? `${PROGRAM_NAME} package enable ${name}${request.action === "switch-look" ? " --switch" : ""}${flag}`
      : request.action === "disable" ? `${PROGRAM_NAME} package disable ${name}${flag}`
      : request.action === "remove" ? `${PROGRAM_NAME} package remove ${name}${flag}`
      : request.action === "install" ? `${PROGRAM_NAME} package install ${directory}${request.replace ? " --replace" : ""}${flag}`
      : `${PROGRAM_NAME} package check ${directory}`
    return `Do it from the shell, where you see the package yourself: ${command}`
  }
  const installed = () => listPackages({ userDir: input.userDir, directory: input.directory, disabled: input.disabled() })
  const target = (request: PackageRequest) => {
    const matches = installed().filter((pkg) => request.key ? pkg.key === request.key : pkg.name === request.name && (!request.scope || pkg.source === request.scope))
    if (matches.length !== 1) throw new PackageError("Select one installed package by exact key")
    return matches[0]!
  }
  const registry = () => createPackageRegistry({ userDir: input.userDir, directory: input.directory, capabilities: true, host: input.host, disabled: input.disabled() })
  const draftParent = (scope: "user" | "project") => scope === "user" ? path.join(input.userDir, "package-drafts") : input.directory
  const report = async (request: PackageRequest): Promise<Record<string, unknown>> => {
    assertLocal()
    if (request.action === "list") return input.manage({ type: "packages.list", directory: input.directory })
    if (request.action === "search") return registry().search(request.query ?? "", request.sourceId)
    const scope = request.key?.startsWith("project:") ? "project" : request.key?.startsWith("user:") ? "user" : request.scope ?? "project"
    if (["new", "install"].includes(request.action) && scope === "project" && !input.trusted()) throw new PackageError("Trust the project before changing its packages")
    if (request.action === "new") {
      if (!request.name) throw new PackageError("Package name required")
      const directory = path.join(draftParent(scope), request.name)
      if (existsSync(directory)) throw new PackageError("Scaffold destination already exists")
      return { action: "new", scope, directory, source: "built-in package new", version: input.host.apiVersion, capabilities: ["filesystem"], changes: { files: Object.keys(packageFiles(request.name)), enabled: false, overlays: {}, overridden: [] } }
    }
    if (request.action === "check" && !request.key && request.name) {
      const directory = path.join(draftParent(scope), request.name)
      if (existsSync(directory)) { readPackageTree(directory, shellAlternative(request, request.name, directory, scope)); return { directory, check: checkPackage({ dir: directory, host: input.host }) } }
    }
    let pkg = request.action === "install" ? undefined : target(request)
    let preview
    if (request.action === "install") {
      if (!request.name || !request.sourceId) throw new PackageError("Install requires an exact configured sourceId and name")
      preview = registry().preview(request.name, request.sourceId, scope)
      if (preview.entry.remote) throw new PackageError("Remote packages need manual /packages review; chat install requires a complete local preview")
      if (preview.problems.length) throw new PackageError(preview.problems.join("; "))
      if (preview.action === "replace" && !request.replace) throw new PackageError("Replacement requires replace=true")
      const manifest = readManifest(preview.entry.location)
      if (!("manifest" in manifest)) throw new PackageError("Invalid package manifest")
      pkg = { key: `${scope}:${preview.entry.name}`, name: preview.entry.name, source: scope, dir: preview.entry.location, manifest: manifest.manifest, contents: { ...preview.entry.contents, extensions: preview.entry.contents.extensions ?? 0, agents: preview.entry.contents.agents ?? 0 }, enabled: true }
    }
    if (!pkg) throw new PackageError("Package target required")
    if (packageMutation(request.action) && pkg.source === "project" && !input.trusted()) throw new PackageError("Trust the project before changing its packages")
    const { fingerprint, summary: tree } = readPackageTree(pkg.dir, shellAlternative(request, pkg.name, pkg.dir, pkg.source))
    const check = checkPackage({ dir: pkg.dir, host: input.host })
    if (request.action === "check") return { key: pkg.key, check }
    if (["enable", "switch-look", "install"].includes(request.action) && !check.ok) throw new PackageError(check.errors.join("; "))
    const activation = activationOf(pkg)
    if (request.action === "switch-look" && (!activation || !hasLook(activation))) throw new PackageError("Package does not declare a look")
    const layers = input.layers().filter((layer) => layer.dir === pkg.dir || layer.source !== pkg.source || layer.pkg !== pkg.name)
    if (!layers.some((layer) => layer.dir === pkg.dir)) {
      const ownIndex = layers.findIndex((layer) => layer.source === pkg.source && (!layer.pkg && !layer.foreign || layer.pkg && layer.pkg.localeCompare(pkg.name) > 0))
      const off = (input.disabledResources?.() ?? []).filter((entry) => entry.startsWith(`${pkg.key}/`)).map((entry) => entry.slice(pkg.key.length + 1))
      layers.splice(ownIndex < 0 ? layers.length : ownIndex, 0, { dir: pkg.dir, source: pkg.source, pkg: pkg.name, off })
    }
    const precedence = await fileClaims({ layers, directory: input.directory, userDir: input.userDir, projectTrusted: input.trusted() })
    if (precedence.truncated) throw new PackageError(`Package declares more resources than the approval can list (limit ${MAX_PRECEDENCE_CLAIMS} tools, hooks, servers, skills and other claims, found more). Nothing was changed. ${shellAlternative(request, pkg.name, pkg.dir, pkg.source)}`)
    const overridden = precedence.claims.filter((claim) => precedence.claims.some((other) => other.surface === claim.surface && other.name === claim.name && other.rank !== claim.rank))
    const capabilities = packageCapabilities(pkg.dir)
    const keybindings = activation?.keybindings ? readPackageKeybindings(pkg.dir, activation.keybindings) : undefined
    const currentLook = describeActivation({ userDir: input.userDir, directory: input.directory, disabled: input.disabled(), projectTrusted: input.trusted() })
    const enabled = request.action !== "disable" && request.action !== "remove"
    const state = { user: readActivationState({ ...input, scope: "user" }), project: readActivationState({ ...input, scope: "project" }) }
    if (enabled && activation && hasLook(activation)) {
      const owner = currentLook.owners[pkg.source]
      if (owner && owner !== pkg.key && request.action !== "switch-look" && request.action !== "info") throw new PackageError(`${owner} owns the look; use switch-look`)
      state[pkg.source] = { ...state[pkg.source], look: pkg.key }
    }
    const active = activationPackages({ ...input, disabled: input.disabled() }).filter((entry) => entry.key !== pkg.key)
    if (enabled && activation) active.push({ key: pkg.key, scope: pkg.source, activation, ...(keybindings ? { keybindings } : {}), info: pkg })
    active.sort((first, second) => first.scope.localeCompare(second.scope) * -1 || first.info.name.localeCompare(second.info.name))
    const nextLook = resolveActivation({ packages: active, state, projectTrusted: input.trusted(), base: readStoredProfile(input.userDir), panel: () => undefined })
    const overlayKeys = [...new Set([...Object.keys(currentLook.overlay), ...Object.keys(nextLook.overlay)])].filter((key) => JSON.stringify(currentLook.overlay[key]) !== JSON.stringify(nextLook.overlay[key]))
    return { action: request.action, key: pkg.key, scope: pkg.source, source: preview?.entry ?? ("install" in pkg ? pkg.install : undefined) ?? pkg.dir, version: pkg.manifest?.version, fingerprint, tree, contents: pkg.contents, capabilities, ...(capabilities.complete ? {} : { capabilityScan: "partial: the code scan read only part of a large package, so the runnable list in tree is the complete list of what can run or configure something" }), resources: packageResourceIds(pkg.dir), precedence, changes: { enabled, trash: request.action === "remove", overlays: activation ?? {}, keybindings, overridden, overlayKeys, currentLook, nextLook } }
  }
  return {
    async preview(request) {
      const value = await report(request)
      const key = JSON.stringify(request)
      receipts.clear()
      receipts.set(key, digest(value))
      return JSON.stringify(value)
    },
    async run(request) {
      const value = await report(request)
      if (!packageMutation(request.action)) return value
      const key = JSON.stringify(request), receipt = receipts.get(key)
      receipts.delete(key)
      if (!receipt || receipt !== digest(value)) throw new PackageError("Package or settings changed; request a new approval")
      assertLocal()
      const scope = value.scope as "user" | "project"
      if (request.action === "new") {
        const result = scaffoldPackage({ name: request.name!, parent: draftParent(scope) })
        if (!result.ok) throw new PackageError(result.message)
        return { ...result }
      }
      if (request.action === "install") return input.catalog({ type: "packages.install-catalog", directory: input.directory, name: request.name, sourceId: request.sourceId, scope, replace: request.replace })
      if (request.action === "remove") return input.manage({ type: "packages.remove", directory: input.directory, name: target(request).name, scope })
      return input.manage({ type: "packages.enable", directory: input.directory, key: value.key, enabled: request.action !== "disable", switch: request.action === "switch-look" })
    },
  }
}
