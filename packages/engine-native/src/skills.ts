import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs"
import path from "node:path"
import { defaultLayers, emptyDiagnostics, frontmatterBoolean, frontmatterHint, frontmatterList, frontmatterText, layerAllows, layerLabel, layerReads, oneLine, parseFrontmatter, resolvePrecedence, type Candidate, type ExtensionLayer, type ResourceDiagnostics } from "@mendcode/packages"
import { defineTool } from "@mendcode/tools"
import { z } from "zod"

export type Skill = {
  name: string
  description: string
  dir: string
  source: "project" | "user"
  pkg?: string
  /** `on-demand: true`: kept out of the prompt catalog; an explicit selection can still load it. */
  onDemand?: boolean
  /** The layer it came from (`user`, `project`, `package acme`, `.claude (project)`). */
  layer: string
  /** `allowed-tools`: read and shown, never enforced or pre-approved (see `notes`). */
  allowedTools?: string[]
  model?: string
  effort?: string
  /** `disable-model-invocation: true`: not in the catalog and refused to the `skill` tool; the user can still run it. */
  disableModelInvocation?: boolean
  /** `user-invocable: false` hides the skill from `/skills` and the slash menu. */
  userInvocable: boolean
  argumentHint?: string
  /** Fields no loader reads, by name. */
  ignoredFields: string[]
  /** What the loader read but cannot apply, in plain words. */
  notes: string[]
}

const MAX_SKILLS = 100
/** One folder is read in full before the cap, so precedence decides what survives the quota. */
const MAX_SCANNED = 600
const MAX_SKILL_CHARS = 40_000
const SKILLS_BLOCK_CHARS = 4_000
const SKILL_NAME = /^[a-z0-9][a-z0-9_.:-]{0,99}$/

/** Fields read as written, then the Agent Skills fields that are informational only. Anything else is listed as ignored. */
const READ_FIELDS = new Set(["name", "description", "on-demand", "allowed-tools", "model", "effort", "disable-model-invocation", "user-invocable", "argument-hint"])
const INFORMATIONAL_FIELDS = new Set(["license", "compatibility", "metadata", "version"])

const inside = (root: string, target: string) => {
  const relative = path.relative(root, target)
  return relative === "" || !(relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative))
}
const real = (file: string) => { try { return realpathSync(file) } catch { return undefined } }

/**
 * The line that tells the model where a skill's files are. It names the folder's real path: a skill that says "resolve this
 * file's real directory and read ../../shared/x.md" is then followed from where the files are, not from the symlink it was found through.
 */
export function skillFolderLine(dir: string) {
  return `Skill folder: ${real(dir) ?? dir}`
}

type Parsed = { skill: Omit<Skill, "dir" | "source" | "pkg" | "layer">; keys: string[] } | { problem: string }
const cache = new Map<string, { mtimeMs: number; size: number; value: Parsed & { body: string } }>()

function parseSkill(file: string, folder: string): (Parsed & { body: string }) | { problem: string } {
  let info: ReturnType<typeof statSync>
  try { info = statSync(file) } catch { return { problem: "not readable" } }
  if (info.size > MAX_SKILL_CHARS * 4) return { problem: "larger than 160 KB" }
  const cached = cache.get(file)
  if (cached?.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.value
  let text: string
  try { text = readFileSync(file, "utf8") } catch { return { problem: "not readable" } }
  const front = parseFrontmatter(text)
  let value: Parsed & { body: string }
  if (front.problem) value = { problem: front.problem, body: "" }
  else {
    const { data } = front
    const declared = frontmatterText(data.name)
    const name = (declared ?? path.basename(folder)).toLowerCase()
    if (!SKILL_NAME.test(name)) value = { problem: `invalid skill name "${name.slice(0, 40)}": use lowercase letters, digits, _ . : -`, body: "" }
    else {
      const allowedTools = frontmatterList(data["allowed-tools"])
      const model = frontmatterText(data.model)
      const effort = frontmatterText(data.effort)
      const notes: string[] = []
      if (allowedTools?.length) notes.push(`allowed-tools (${allowedTools.join(", ")}) is not applied: a skill file neither grants nor restricts tools here, so the normal permissions stay in force`)
      if (model) notes.push(`model "${model}" applies only when the skill runs as /${name} and the model exists; a model-loaded skill keeps the session model`)
      if (effort) notes.push(`effort "${effort}" is not applied; choose it with /effort`)
      if (front.lenient) notes.push("frontmatter is not valid YAML; read line by line")
      const description = frontmatterText(data.description)
      const hint = frontmatterHint(data["argument-hint"])
      const disable = frontmatterBoolean(data["disable-model-invocation"])
      value = {
        skill: {
          name, description: oneLine(description ?? "", 300), userInvocable: frontmatterBoolean(data["user-invocable"]) !== false,
          ignoredFields: front.keys.filter((key) => !READ_FIELDS.has(key.toLowerCase()) && !INFORMATIONAL_FIELDS.has(key.toLowerCase())),
          notes,
          ...(frontmatterBoolean(data["on-demand"]) ? { onDemand: true } : {}),
          ...(allowedTools?.length ? { allowedTools } : {}), ...(model ? { model } : {}), ...(effort ? { effort } : {}),
          ...(disable ? { disableModelInvocation: true } : {}), ...(hint ? { argumentHint: hint } : {}),
        },
        keys: front.keys, body: front.body,
      }
    }
  }
  if (cache.size > 1_000) cache.clear()
  cache.set(file, { mtimeMs: info.mtimeMs, size: info.size, value })
  return value
}

type Source = { root: string; source: Skill["source"]; pkg?: string | undefined; layer: string; allowed: string[]; recursive?: boolean }

/**
 * A skill folder is followed when it is a real directory, or a symlink whose target stays inside an allowed root (the
 * layer's own folder, the project for project layers); a symlinked SKILL.md follows the same rule. Anything that leaves
 * is refused and reported, never silently skipped.
 */
function scan(spec: Source, diagnostics: ResourceDiagnostics): Array<Candidate<Skill>> {
  if (!existsSync(spec.root)) return []
  const found: Array<Candidate<Skill>> = []
  const seen = new Set<string>()
  const allowed = [...spec.allowed, real(spec.root)].filter((root): root is string => root !== undefined)
  const permitted = (target: string) => allowed.some((root) => inside(root, target))
  let visited = 0
  function visit(dir: string, depth: number) {
    if (found.length >= MAX_SCANNED || depth > (spec.recursive ? 10 : 1) || visited++ >= 1000) return
    const resolvedDir = real(dir)
    if (!resolvedDir || seen.has(resolvedDir)) return
    seen.add(resolvedDir)
    const file = path.join(dir, "SKILL.md")
    try {
      if (statSync(file, { throwIfNoEntry: false })?.isFile()) {
        const target = real(file)
        if (!target || !permitted(target)) diagnostics.problems.push({ file, message: "SKILL.md resolves outside the allowed folders (outside the layer or project); refused" })
        else {
          const parsed = parseSkill(file, dir)
          if ("problem" in parsed) diagnostics.problems.push({ file, message: parsed.problem })
          else found.push({ name: parsed.skill.name, layer: spec.layer, value: { ...parsed.skill, dir, source: spec.source, layer: spec.layer, ...(spec.pkg ? { pkg: spec.pkg } : {}) } })
        }
      }
      for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.name.startsWith(".") || entry.name === "node_modules") continue
        const child = path.join(dir, entry.name)
        if (entry.isDirectory()) visit(child, depth + 1)
        else if (entry.isSymbolicLink() && statSync(child, { throwIfNoEntry: false })?.isDirectory()) {
          const target = real(child)
          if (target && permitted(target)) visit(child, depth + 1)
          else diagnostics.problems.push({ file: child, message: "symlink resolves outside the allowed folders (outside the layer or project); refused" })
        }
      }
    } catch {}
  }
  visit(spec.root, 0)
  return found
}

/**
 * Skills are folders with a SKILL.md (frontmatter `name`, `description`) in each extension layer's `skills/`
 * (packages, then the user's, then the project's `.mendcode/skills`; `.agents/skills` and `.claude/skills` sit under their scope's own folder);
 * a later layer wins on the same name, and only then is the 100-skill cap applied (lowest-priority layers drop first).
 * Frontmatter is YAML (Claude Code, Codex and pi formats). Only names and descriptions go into the prompt; the body is
 * loaded on demand by the `skill` tool. `on-demand: true` also keeps metadata out of the prompt; explicit CLI/user selection can still load it.
 */
export function createSkillLoader(options: { userDir: string; layers?: (cwd: string) => ExtensionLayer[]; paths?: (cwd: string) => Array<{ dir: string; source: Skill["source"] }>; enabled?: (cwd: string, name: string) => boolean }) {
  const layersFor = options.layers ?? ((cwd: string) => defaultLayers({ userDir: options.userDir, directory: cwd }))
  function inspect(cwd: string): { skills: Skill[]; diagnostics: ResourceDiagnostics } {
    const diagnostics = emptyDiagnostics()
    const candidates: Array<Candidate<Skill>> = []
    const project = real(cwd)
    for (const layer of layersFor(cwd)) {
      if (!layerReads(layer, "skills")) continue
      const label = layerLabel(layer)
      const allowed = [real(layer.dir), ...(layer.source === "project" ? [project] : [])].filter((root): root is string => root !== undefined)
      for (const entry of scan({ root: path.join(layer.dir, "skills"), source: layer.source, pkg: layer.pkg, layer: label, allowed }, diagnostics)) {
        if (layerAllows(layer, "skills", entry.name) && layerAllows(layer, "skills", path.basename(entry.value.dir))) candidates.push(entry)
      }
    }
    for (const root of options.paths?.(cwd) ?? []) {
      const label = `configured ${root.source}`
      for (const entry of scan({ root: root.dir, source: root.source, layer: label, allowed: [], recursive: true }, diagnostics)) candidates.push(entry)
    }
    const kept = resolvePrecedence("skill", candidates, MAX_SKILLS, diagnostics)
    for (const entry of kept) {
      const skill = entry.value
      if (skill.ignoredFields.length) diagnostics.ignored.push({ kind: "skill", name: skill.name, layer: skill.layer, fields: skill.ignoredFields })
    }
    return { skills: kept.map((entry) => entry.value), diagnostics }
  }
  const list = (cwd: string): Skill[] => inspect(cwd).skills
  const modelVisible = (cwd: string, skill: Skill) => !skill.disableModelInvocation && options.enabled?.(cwd, skill.name) !== false
  return {
    list,
    inspect,
    enabled: (cwd: string, name: string) => options.enabled?.(cwd, name) !== false,
    /** `<available_skills>` for the system prompt; empty when there are none. */
    block(cwd: string) {
      const skills = list(cwd).filter((skill) => !skill.onDemand && modelVisible(cwd, skill))
      if (skills.length === 0) return ""
      const lines: string[] = []
      let used = 0
      for (const skill of skills) {
        const line = `- ${skill.name}: ${skill.description || "(no description)"}`
        if (used + line.length > SKILLS_BLOCK_CHARS) break
        lines.push(line)
        used += line.length + 1
      }
      return [
        "<available_skills>",
        "Before you answer or act, check these skills. If a description matches the request, call the `skill` tool with its name first and follow what it says.",
        ...lines,
        "</available_skills>",
      ].join("\n")
    },
    /** Skills the `skill` tool may load or list for the model: enabled and not `disable-model-invocation`. */
    modelSkills: (cwd: string) => list(cwd).filter((skill) => modelVisible(cwd, skill)),
    /** `user` is a person asking (`/skills`, `/name`): it also reaches `disable-model-invocation` skills. */
    load(cwd: string, name: string, access: { user?: boolean } = {}) {
      const skill = list(cwd).find((s) => s.name === name.toLowerCase())
      if (!skill || options.enabled?.(cwd, skill.name) === false || skill.disableModelInvocation && !access.user) return undefined
      const file = path.join(skill.dir, "SKILL.md")
      const parsed = parseSkill(file, skill.dir)
      if ("problem" in parsed) return undefined
      const { body } = parsed
      return { skill, body: body.length > MAX_SKILL_CHARS ? `${body.slice(0, MAX_SKILL_CHARS)}\n[… truncated]` : body }
    },
  }
}

export type SkillLoader = ReturnType<typeof createSkillLoader>

/** An unknown name lists this many skills; the rest are one call with no name away. */
export const UNKNOWN_SKILL_LISTED = 12

/** `docs` is the command that explains how a skill gets installed (`mendcode docs skills`); without it the unknown-skill answer names no command. */
export function createSkillTool(loader: SkillLoader, options: { docs?: string } = {}) {
  return defineTool({
    name: "skill",
    description: "Load a skill by name, or call with no name to list the skills available. Returns its instructions and the folder holding any files it references.",
    permission: "read",
    args: z.object({ name: z.string().min(1).max(100).optional() }),
    async execute({ name }, context) {
      const available = loader.modelSkills(context.cwd)
      if (name === undefined) {
        const lines = available.map((skill) => `- ${skill.name}: ${skill.description || "(no description)"}`)
        return { output: lines.length ? `Skills available (load one with the skill tool and its name):\n${lines.join("\n")}` : "No skills installed.", truncated: false, title: "skill: list", isError: false }
      }
      const loaded = loader.load(context.cwd, name)
      if (!loaded) {
        const manual = loader.list(context.cwd).find((s) => s.name === name.toLowerCase() && s.disableModelInvocation && loader.enabled(context.cwd, s.name))
        if (manual) return { output: `skill ${manual.name} sets disable-model-invocation: only the user can run it, with /${manual.name}`, truncated: false, title: `skill: ${name}`, isError: true }
        const known = available.map((s) => s.name)
        const shown = known.slice(0, UNKNOWN_SKILL_LISTED).join(", ")
        const rest = known.length - UNKNOWN_SKILL_LISTED
        const listed = known.length ? ` (available: ${shown}${rest > 0 ? `, and ${rest} more: call skill with no name for the full list` : ""})` : " (no skills installed)"
        // A skill is a file the user or a package puts in a skills folder; naming a URL or a topic loads nothing, so the model should not retry.
        const install = options.docs ? `. A skill is installed as a SKILL.md in a skills folder or a package, not by naming it: ${options.docs}` : ""
        return { output: `unknown skill: ${name}${listed}${install}`, truncated: false, title: `skill: ${name}`, isError: true }
      }
      const notes = loaded.skill.notes.map((note) => `Note: ${note}`)
      return { output: [skillFolderLine(loaded.skill.dir), ...(notes.length ? [notes.join("\n")] : []), loaded.body.trim()].join("\n\n"), truncated: false, title: `skill: ${loaded.skill.name}`, isError: false }
    },
  })
}
