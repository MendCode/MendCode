import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { ACTIVATION_MAX_BYTES, activationProblems, moduleStem, PACKAGE_KINDS, unknownPackageEntries, versionRangeProblem, type Activation } from "@mendcode/protocol/wire"
import { packageCapabilities } from "./capabilities"
import { auditPackageTree, manifestCompatProblem, type PackageHost } from "./install"
import { extensionsProblem, MANIFEST_FILE, readManifest } from "./manifest"

/**
 * `mendcode package check <dir>`: everything that can be said about a package folder without running any of it. Errors would stop an
 * install or an enable (the daemon applies the same schema, compat and activation rules); warnings are things to look at before
 * sharing it. Read-only.
 */
export type PackageCheck = { ok: boolean; name?: string; errors: string[]; warnings: string[]; notes: string[] }

const JSON_KINDS = PACKAGE_KINDS.filter((kind) => kind.paths.some((entry) => entry.endsWith(".json")) || ["tools", "recipes", "workflows", "themes", "contracts"].includes(kind.id))
const MAX_JSON_BYTES = 1024 * 1024

function jsonFiles(dir: string, depth = 0): string[] {
  if (depth > 3 || !existsSync(dir)) return []
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...jsonFiles(full, depth + 1))
    else if (entry.isFile() && entry.name.endsWith(".json")) out.push(full)
  }
  return out
}

function moduleExists(dir: string, module: string): boolean {
  const stem = moduleStem(module)
  const base = path.join(dir, stem.startsWith("extensions/") ? stem : `extensions/${stem}`)
  return ["ts", "js"].some((ext) => existsSync(`${base}.${ext}`) || existsSync(path.join(base, `index.${ext}`)))
}

function themeNames(dir: string): Set<string> {
  const names = new Set<string>()
  for (const file of jsonFiles(path.join(dir, "themes"), 2)) {
    names.add(path.basename(file, ".json"))
    try {
      const name = (JSON.parse(readFileSync(file, "utf8")) as { name?: unknown }).name
      if (typeof name === "string") names.add(name)
    } catch {
      // Reported as invalid JSON below.
    }
  }
  return names
}

export function checkPackage(input: { dir: string; host: PackageHost; knownSlots?: readonly string[] | undefined }): PackageCheck {
  const { dir } = input
  const errors: string[] = []
  const warnings: string[] = []
  const notes: string[] = []
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return { ok: false, errors: [`no folder at ${dir}`], warnings, notes }
  const read = readManifest(dir)
  if ("problem" in read) return { ok: false, errors: [read.problem], warnings, notes }
  const { manifest } = read

  // Compatibility: enforced at enable, so a wrong range is an error here too; a label nobody can read is not enforced.
  const incompatible = manifestCompatProblem(manifest, input.host)
  if (incompatible) errors.push(`${manifest.name} ${incompatible}`)
  const range = manifest.compatibility?.mendcode
  if (range !== undefined) {
    const unreadable = versionRangeProblem(range)
    if (unreadable) warnings.push(`compatibility.mendcode: ${unreadable}; it is shown but not enforced`)
  } else warnings.push("compatibility.mendcode is not set: say which MendCode versions this was tried with (for example \">=0.1.0\")")
  if (manifest.compatibility?.api === undefined) notes.push(`compatibility.api is not set: the extension API is version ${input.host.apiVersion}`)

  // Files: links, secrets and size limits, the same audit the installer runs.
  errors.push(...auditPackageTree(dir))
  const extensionsMismatch = extensionsProblem({ manifest, dir })
  if (extensionsMismatch) errors.push(extensionsMismatch)

  // Folders and files nobody reads.
  const top = readdirSync(dir)
  const unknown = unknownPackageEntries(top)
  if (unknown.length) warnings.push(`nothing reads ${unknown.map((name) => `"${name}"`).join(", ")}: the loaders look at ${PACKAGE_KINDS.flatMap((kind) => kind.paths).join(", ")}`)

  // Resource files that must be valid JSON.
  for (const kind of JSON_KINDS) for (const entry of kind.paths) {
    const full = path.join(dir, entry)
    const files = entry.endsWith(".json") ? (existsSync(full) ? [full] : []) : jsonFiles(full)
    for (const file of files) {
      const relative = path.relative(dir, file)
      try {
        if (lstatSync(file).size > MAX_JSON_BYTES) warnings.push(`${relative} is larger than ${MAX_JSON_BYTES / 1024} KB`)
        JSON.parse(readFileSync(file, "utf8"))
      } catch (error) {
        errors.push(`${relative} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  // The activation profile.
  const rawActivation: unknown = (manifest as { activate?: unknown }).activate
  if (rawActivation !== undefined) {
    const problems = activationProblems(rawActivation)
    errors.push(...problems)
    if (problems.length === 0) {
      const activation = rawActivation as Activation
      if (JSON.stringify(activation).length > ACTIVATION_MAX_BYTES * 0.75) warnings.push(`activate is ${Math.round(JSON.stringify(activation).length / 1024)} KB of the ${ACTIVATION_MAX_BYTES / 1024} KB allowed`)
      if (activation.keybindings) {
        const file = path.join(dir, activation.keybindings)
        if (!statSync(file, { throwIfNoEntry: false })?.isFile()) errors.push(`activate.keybindings: ${activation.keybindings} is not in the package`)
        else {
          try {
            const json = JSON.parse(readFileSync(file, "utf8")) as unknown
            if (typeof json !== "object" || json === null || Array.isArray(json)) errors.push(`${activation.keybindings} must be an object of "key": "action"`)
          } catch {
            errors.push(`${activation.keybindings} is not valid JSON`)
          }
        }
      }
      for (const [slot, module] of Object.entries(activation.views ?? {})) {
        if (!moduleExists(dir, module)) errors.push(`activate.views.${slot}: no module "${module}" in extensions/`)
        if (input.knownSlots && !input.knownSlots.includes(slot)) errors.push(`activate.views.${slot}: not a view slot (known: ${input.knownSlots.join(", ")})`)
      }
      if (activation.theme && !themeNames(dir).has(activation.theme)) warnings.push(`activate.theme "${activation.theme}" is not in the package's themes/: it must be a theme the user already has`)
      for (const file of activation.promptFiles ?? []) if (!existsSync(path.join(dir, file))) errors.push(`activate.promptFiles: ${file} is not in the package`)
      if (!activation.views && existsSync(path.join(dir, "extensions"))) notes.push("extensions/ modules load for everyone who enables the package; list view modules in activate.views to load them only while the package owns the look")
    }
  }

  // Capabilities: what the manifest says against what a read of the code finds (hints, never executed).
  const found = packageCapabilities(dir)
  const declared = new Set(found.declared)
  for (const name of found.observed) if (!declared.has(name)) errors.push(`code appears to use "${name}" but capabilities does not declare it`)
  for (const name of found.declared) if (!found.observed.includes(name)) warnings.push(`capabilities declares "${name}" but no code of the package appears to use it`)
  if (!found.complete) warnings.push("the capability scan was cut short (large tree or links); declared capabilities are not verified")
  const environment = new Set(found.declaredEnvironment ?? [])
  for (const name of found.observedEnvironment ?? []) if (!environment.has(name)) warnings.push(`code reads the environment variable ${name}; declare it in "environment"`)

  if (existsSync(path.join(dir, "hooks.json"))) notes.push("hooks.json runs shell commands on events: users are asked before it runs, and an example should ship disabled")
  notes.push(`${MANIFEST_FILE}: ${manifest.name}@${manifest.version}`)
  return { ok: errors.length === 0, name: manifest.name, errors, warnings, notes }
}

/** The lines `package check` prints. */
export function formatCheck(result: PackageCheck): string[] {
  return [
    ...result.errors.map((line) => `error   ${line}`),
    ...result.warnings.map((line) => `warning ${line}`),
    ...result.notes.map((line) => `note    ${line}`),
    result.ok ? `ok: ${result.name ?? "package"} passes (${result.warnings.length} warning${result.warnings.length === 1 ? "" : "s"})` : `failed: ${result.errors.length} error${result.errors.length === 1 ? "" : "s"}`,
  ]
}
