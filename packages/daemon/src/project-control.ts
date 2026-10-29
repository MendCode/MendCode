import { createHash, randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { createInstructionLoader } from "@mendcode/engine-native"
import { ProjectPackagePatch as PackagePatchSchema, redactSecrets, type ProjectControlInput, type ProjectPackagePatch, type Settings } from "@mendcode/protocol"
import { featureOn, PROMPT_FOCUS_CHOICES, type PromptFocus } from "@mendcode/protocol/wire"
import { createPromptModes, FOCUS_CONTEXT } from "./prompt-modes"
import { isInstructionUrl, remoteInstructions } from "./remote-instructions"

const CONFIG = ".mendcode/project.json"
const names: Record<PromptFocus | "auto", string> = { auto: "Follows the session's model", neutral: "No vendor guidance", codex: "Codex optimized", claude: "Anthropic-family planning discipline", gemini: "Gemini context and checkpoint style", kimi: "Kimi shell-workflow style", deepseek: "DeepSeek optimized", mistral: "Mistral optimized", glm: "GLM long-horizon iteration style", minimax: "MiniMax agentic coding style", grok: "Grok fast tool-loop style", local: "Small local model strictness" }
type Config = { version?: number; instructions?: string[]; skills?: { paths?: string[]; urls?: string[] }; package?: ProjectPackagePatch & { source?: Record<string, string>; compatibility?: Record<string, string>; selection?: Record<string, unknown> }; [key: string]: unknown }
type FileState = { path: string; exists: boolean; bytes: number; mtimeMs: number | null; hash: string | null; changed: boolean }
type Snapshot = { version: number; level: number; generatedAt: string | null; previousGeneratedAt?: string | null; files: FileState[]; docs?: string[]; commands?: string[]; packageScripts?: string[]; packageDependencies?: string[]; gitChangedPaths?: string[]; changed?: string[]; truncated?: boolean }

function readJson<T>(file: string, fallback: T): T {
  try {
    const info = statSync(file)
    if (!info.isFile() || info.size > 64 * 1024) throw new Error("Project metadata exceeds 64 KiB")
    return JSON.parse(readFileSync(file, "utf8")) as T
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback
    throw error
  }
}
function strings(value: unknown) {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 100 || value.some((item) => typeof item !== "string" || !item.trim() || item.length > 4096)) throw new Error("Expected at most 100 nonempty paths or URLs")
  return value as string[]
}
function config(root: string): Config {
  const value = readJson<Config>(path.join(root, CONFIG), {})
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid project.json")
  strings(value.instructions)
  if (value.skills !== undefined) {
    if (!value.skills || typeof value.skills !== "object" || Array.isArray(value.skills)) throw new Error("Invalid project skills")
    strings(value.skills.paths)
    strings(value.skills.urls)
  }
  return value
}

/**
 * Explicit local paths are data, never executable extensions. An https instruction URL in the user's own settings is read from
 * its downloaded copy (`remote`, remote-instructions.ts); every other remote declaration is listed as blocked, never fetched.
 */
export function projectSources(root: string, settings: Settings, remote?: (url: string) => string | undefined) {
  const project = config(root)
  const expand = (file: string) => file.startsWith("~/") ? path.join(homedir(), file.slice(2)) : path.resolve(root, file)
  const blocked: Array<{ path: string; reason: string }> = []
  const local = (raw: string, projectOnly: boolean) => {
    if (/^https?:\/\//i.test(raw)) {
      blocked.push({ path: raw, reason: projectOnly ? "A project's config cannot add remote sources; put an instruction URL in your own settings (instructions)" : "Remote skill sources are not downloaded" })
      return false
    }
    if (!projectOnly) return true
    const file = expand(raw)
    const rel = path.relative(path.resolve(root), file)
    if (rel === ".." || rel.startsWith(".." + path.sep)) {
      blocked.push({ path: raw, reason: "External project source needs an explicit user setting" })
      return false
    }
    let ancestor = file.split(/[?*[{]/, 1)[0] || root
    while (!existsSync(ancestor)) {
      const parent = path.dirname(ancestor)
      if (parent === ancestor) break
      ancestor = parent
    }
    try {
      const realRelative = path.relative(realpathSync(root), realpathSync(ancestor))
      if (realRelative === ".." || realRelative.startsWith(".." + path.sep)) {
        blocked.push({ path: raw, reason: "Project source symlink leaves the project" })
        return false
      }
    } catch {}
    return true
  }
  const own = (settings.instructions ?? []).flatMap((raw) => {
    if (isInstructionUrl(raw)) { const copy = remote?.(raw); return copy ? [copy] : [] }
    if (/^http:\/\//i.test(raw)) { blocked.push({ path: raw, reason: "Instruction URLs must use https" }); return [] }
    return local(raw, false) ? [raw] : []
  })
  const instructions = [...new Set([...own, ...strings(project.instructions).filter((file) => local(file, true)).map(expand)])]
  const skills = [...(settings.skills?.paths ?? []).filter((dir) => local(dir, false)).map((dir) => ({ dir: expand(dir), source: "user" as const })), ...strings(project.skills?.paths).filter((dir) => local(dir, true)).map((dir) => ({ dir: expand(dir), source: "project" as const }))]
  for (const url of [...(settings.skills?.urls ?? []), ...strings(project.skills?.urls)]) blocked.push({ path: url, reason: "Remote source policy is undecided; no download" })
  return { instructions, skills, blocked }
}

/** The settings that steer which instruction files are found: extra file names and project-root markers. */
export function instructionControls(settings: () => Settings) {
  return {
    includes: () => featureOn(settings(), "instruction_includes"),
    fallbacks: () => settings().instructionFallbacks ?? [],
    rootMarkers: () => settings().projectRootMarkers ?? [".git"],
  }
}

function profile(id: PromptFocus, requested: string = id) {
  return {
    id, ...(requested !== id ? { requested } : {}), publicName: names[id],
    promptPolicy: { contextFiles: FOCUS_CONTEXT[id].files, behavior: FOCUS_CONTEXT[id].behavior },
    architecture: "native-harness",
  }
}

export function createProjectControl(options: { dir: string; settings(): Settings; now?(): number; /** The project's main model, which `auto` follows when asked outside a session. */ model?(directory: string): string | undefined }) {
  const modes = createPromptModes(options.dir, options.model ? { defaultModel: options.model } : {})
  const now = options.now ?? Date.now
  const remote = remoteInstructions(options.dir)
  const loader = createInstructionLoader({ globalFile: path.join(options.dir, "AGENTS.md"), paths: (root) => projectSources(root, options.settings(), remote.pathFor).instructions, ...instructionControls(options.settings) })
  function rootOf(directory: string) {
    const root = realpathSync(directory)
    if (!statSync(root).isDirectory()) throw new Error("Project must be a directory")
    return root
  }
  function target(root: string, relative: string) {
    const file = path.join(root, relative)
    let ancestor = file
    while (!existsSync(ancestor)) ancestor = path.dirname(ancestor)
    const resolved = realpathSync(ancestor)
    const rel = path.relative(root, resolved)
    if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) throw new Error("Project writes must stay inside the project")
    mkdirSync(path.dirname(file), { recursive: true })
    return file
  }
  function save(root: string, relative: string, value: unknown) {
    const file = target(root, relative)
    const temp = file + "." + randomUUID() + ".tmp"
    writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 })
    renameSync(temp, file)
  }
  function seed(root: string, relative: string, text: string) {
    const file = target(root, relative)
    try {
      writeFileSync(file, text, { flag: "wx", mode: 0o600 })
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false
      throw error
    }
  }
  function packageMetadata(root: string) {
    const configured = config(root).package ?? {}
    const pkg = readJson<{ name?: string; description?: string }>(path.join(root, "package.json"), {})
    return { id: configured.id || null, title: configured.title || pkg.name || null, description: configured.description || pkg.description || null, version: configured.version || "0.1.0", kind: configured.kind || "bundle", channel: configured.channel || "local", source: configured.source ?? {}, compatibility: configured.compatibility ?? {}, selection: configured.selection ?? {} }
  }
  function packageSet(root: string, patch: ProjectPackagePatch) {
    PackagePatchSchema.parse(patch)
    const cfg = config(root)
    const pkg = { ...cfg.package }
    for (const key of ["id", "title", "description", "version", "kind", "channel"] as const) if (patch[key] !== undefined) {
      if (patch[key]?.trim()) pkg[key] = patch[key]
      else delete pkg[key]
    }
    for (const [field, entries] of [["source", [["sourceType", "type"], ["sourceURL", "url"]]], ["compatibility", [["compatMendcode", "mendcode"], ["compatRuntimePack", "runtimePack"]]]] as const) {
      const object = { ...pkg[field] }
      for (const [key, name] of entries) if (patch[key] !== undefined) {
        if (patch[key]?.trim()) object[name] = patch[key]!
        else delete object[name]
      }
      if (Object.keys(object).length) pkg[field] = object
      else delete pkg[field]
    }
    save(root, CONFIG, { ...cfg, package: pkg })
    return packageMetadata(root)
  }
  function contextStatus(root: string) {
    const snapshot = readJson<Snapshot>(path.join(root, ".mendcode/context/refresh.json"), { version: 1, level: 1, files: [], generatedAt: null })
    return { ...snapshot, summary: existsSync(path.join(root, ".mendcode/context/summary.md")) ? ".mendcode/context/summary.md" : null }
  }
  function inventory(root: string, folder: string, suffix: string) {
    const files: string[] = []
    function walk(dir: string, depth: number) {
      if (depth > 1 || files.length >= 200) return
      try { for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (files.length >= 200) break
        if (entry.isDirectory()) walk(path.join(dir, entry.name), depth + 1)
        else if (entry.isFile() && entry.name.endsWith(suffix)) files.push(path.relative(root, path.join(dir, entry.name)))
      } } catch {}
    }
    walk(path.join(root, folder), 0)
    return files
  }
  async function refresh(root: string) {
    const previous = contextStatus(root)
    const prior = new Map(previous.files.map((file) => [file.path, file]))
    const inputs = ["AGENTS.md", "CLAUDE.md", ".agents/context.md", ".agents/global/context.md", ".mendcode/context/project.md", CONFIG, ".mendcode/prompts/custom.md", "package.json"]
    const files: FileState[] = inputs.map((relative) => {
      const full = path.join(root, relative)
      let bytes = 0, mtimeMs: number | null = null, hash: string | null = null, exists = false
      try {
        const real = realpathSync(full)
        const rel = path.relative(root, real)
        if (rel.startsWith(".." + path.sep) || rel === "..") throw new Error("External context input")
        const info = statSync(real)
        if (!info.isFile()) throw new Error("Not a file")
        exists = true
        bytes = info.size
        mtimeMs = info.mtimeMs
        if (bytes <= 64 * 1024) hash = createHash("sha256").update(readFileSync(real)).digest("hex")
      } catch {}
      const old = prior.get(relative)
      return { path: relative, exists, bytes, mtimeMs, hash, changed: !!old && (old.exists !== exists || old.bytes !== bytes || old.mtimeMs !== mtimeMs || old.hash !== hash) }
    })
    let gitChangedPaths: string[] = []
    try {
      const proc = Bun.spawn(["git", "status", "--short", "-z", "--untracked-files=normal"], { cwd: root, stdout: "pipe", stderr: "ignore", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } })
      const timer = setTimeout(() => proc.kill(), 2000)
      try {
        const reader = proc.stdout.getReader()
        const chunks: Uint8Array[] = []
        let size = 0
        while (size <= 64 * 1024) {
          const chunk = await reader.read()
          if (chunk.done) break
          size += chunk.value.byteLength
          chunks.push(chunk.value)
        }
        if (size > 64 * 1024) proc.kill()
        const bytes = Buffer.concat(chunks).subarray(0, 64 * 1024)
        reader.releaseLock()
        if (await proc.exited === 0) {
          const entries = new TextDecoder().decode(bytes).split("\0")
          for (let i = 0; i < entries.length; i++) {
            const entry = entries[i]!
            if (!entry) continue
            const file = entry.slice(3)
            if (/[RC]/.test(entry.slice(0, 2))) i++
            if (!/(^|\/)(\.env[^/]*|\.git|runs|cache)(\/|$)/.test(file)) gitChangedPaths.push(file)
          }
          gitChangedPaths = gitChangedPaths.slice(0, 50)
        }
      } finally { clearTimeout(timer) }
    } catch {}
    const pkg = readJson<{ scripts?: Record<string, unknown>; dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> }>(path.join(root, "package.json"), {})
    const snapshot: Snapshot = { version: 1, level: 2, previousGeneratedAt: previous.generatedAt, generatedAt: new Date(now()).toISOString(), files, docs: inventory(root, "docs", ".md"), commands: inventory(root, ".mendcode/commands", ".md"), packageScripts: Object.keys(pkg.scripts ?? {}).sort().slice(0, 200), packageDependencies: Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).sort().slice(0, 200), gitChangedPaths, changed: files.filter((file) => file.changed).map((file) => file.path), truncated: files.some((file) => file.bytes > 64 * 1024) }
    const section = (title: string, values: string[]) => `## ${title}\n\n${values.length ? values.map((value) => `- ${value}`).join("\n") : "- none"}\n`
    const summary = ["# MendCode Context Summary", `Generated: ${snapshot.generatedAt}\nRefresh level: 2 · deterministic/local only`, section("Local evidence inputs", files.filter((file) => file.exists).map((file) => `${file.path} (${file.bytes} bytes)`)), section("Missing optional inputs", files.filter((file) => !file.exists).map((file) => file.path)), section("Changed since previous refresh", snapshot.changed!), section("Docs", snapshot.docs!), section("Command pack", snapshot.commands!), section("Package scripts", snapshot.packageScripts!), section("Dependencies", snapshot.packageDependencies!), section("Local git freshness", gitChangedPaths)].join("\n\n")
    save(root, ".mendcode/context/refresh.json", snapshot)
    writeFileSync(target(root, ".mendcode/context/summary.md"), redactSecrets(summary).text + "\n", { mode: 0o600 })
    return { summary: ".mendcode/context/summary.md", present: files.filter((file) => file.exists).length, total: files.length, truncated: snapshot.truncated }
  }
  async function run(directory: string, input: ProjectControlInput): Promise<Record<string, unknown>> {
    const root = rootOf(directory)
    let result: Record<string, unknown>
    switch (input.operation) {
      case "init": {
        const current = modes.status(root)
        const defaults = { version: 1, instructions: [], skills: { paths: [], urls: [] }, package: { version: "0.1.0", kind: "bundle", channel: "local" } }
        const created: string[] = []
        const add = (file: string, text: string) => { if (seed(root, file, text)) created.push(file) }
        add(CONFIG, JSON.stringify(defaults, null, 2) + "\n")
        add(".mendcode/context/project.md", "# Project context\n")
        add(".mendcode/context/refresh.json", JSON.stringify({ version: 1, level: 1, files: [], generatedAt: null }) + "\n")
        for (const folder of ["memory", "commands", "skills"]) target(root, `.mendcode/${folder}/.seed`)
        result = { initialized: ".mendcode", created, focus: current.focusID, modelChanged: false }
        break
      }
      case "config-show":
        result = { directory: root, path: CONFIG, config: config(root), focus: modes.status(root), settings: options.settings(), sources: projectSources(root, options.settings()) }
        break
      case "context-status":
        result = contextStatus(root)
        break
      case "context-refresh":
        result = await refresh(root)
        break
      case "context-show": {
        if (!contextStatus(root).summary) await refresh(root)
        const file = path.join(root, ".mendcode/context/summary.md")
        if (statSync(file).size > 128 * 1024) throw new Error("Context summary exceeds 128 KiB")
        result = { summary: ".mendcode/context/summary.md", text: readFileSync(file, "utf8") }
        break
      }
      case "focus-status": {
        const current = modes.status(root)
        result = { active: current.focusID, resolved: current.resolvedFocus, profile: profile(current.resolvedFocus, current.focusID) }
        break
      }
      case "focus-list":
        result = { profiles: PROMPT_FOCUS_CHOICES.map((id) => ({ id, publicName: names[id] })) }
        break
      case "focus-show": {
        const current = modes.status(root)
        const choice = input.focusID ?? current.focusID
        result = choice === "auto" ? profile(current.resolvedFocus, "auto") : profile(choice)
        break
      }
      case "focus-use": {
        if (!PROMPT_FOCUS_CHOICES.includes(input.focusID)) throw new Error("Unknown focus profile")
        modes.set(root, { focusID: input.focusID })
        result = { active: input.focusID, modelChanged: false }
        break
      }
      case "package-show":
        result = packageMetadata(root)
        break
      case "package-set":
        result = packageSet(root, input.patch)
        break
    }
    return JSON.parse(redactSecrets(JSON.stringify(result)).text)
  }
  return { run, instructions: loader }
}
