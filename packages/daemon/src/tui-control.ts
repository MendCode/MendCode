import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { TUI_DEFAULTS, TUI_ENUMS, tuiProblems, type TuiControlInput, type TuiControlReport } from "@mendcode/protocol/wire"
import { SidebarSpec } from "@mendcode/protocol"

export function createTuiControl(dir: string) {
  const root = path.join(dir, "tui")
  const file = path.join(root, "profile.json")
  function read(target: string): Record<string, unknown> {
    if (!existsSync(target)) return {}
    const raw = JSON.parse(readFileSync(target, "utf8"))
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid TUI JSON object")
    return raw
  }
  function write(target: string, value: unknown) {
    mkdirSync(path.dirname(target), { recursive: true })
    const temp = target + "." + randomUUID() + ".tmp"
    writeFileSync(temp, JSON.stringify(value, null, 2) + "\n")
    renameSync(temp, target)
  }
  function validate(profile: Record<string, unknown>) {
    const issues = tuiProblems(profile)
    if (!SidebarSpec.safeParse(profile.sidebarWidgets ?? []).success) issues.push("Invalid sidebar widgets")
    if (issues.length) throw new Error(issues.join("; "))
  }
  function saved(kind: "proposals" | "backups", id: string | undefined) {
    if (!id || !/^[a-z0-9-]{1,80}$/i.test(id)) throw new Error("Expected a saved " + kind.slice(0, -1) + " id")
    const target = path.join(root, kind, id + ".json")
    if (!existsSync(target)) throw new Error("Unknown " + kind.slice(0, -1) + ": " + id)
    return read(target)
  }
  function change(next: Record<string, unknown>, dryRun: boolean | undefined) {
    validate(next)
    if (dryRun) return undefined
    const backupId = randomUUID()
    write(path.join(root, "backups", backupId + ".json"), { ...TUI_DEFAULTS, ...read(file) })
    write(path.join(root, "latest-backup.json"), { id: backupId })
    write(file, next)
    return backupId
  }
  function run(input: TuiControlInput): TuiControlReport {
    const current = { ...TUI_DEFAULTS, ...read(file) }
    let profile = current
    let proposalId: string | undefined
    let backupId: string | undefined
    const artifacts: string[] = []
    if (input.operation === "apply") {
      profile = input.profile ? { ...current, ...input.profile } : saved("proposals", input.argument).profile as Record<string, unknown>
      backupId = change(profile, input.dryRun)
    } else if (input.operation === "apply-preset") {
      if (["compact", "comfortable", "spacious"].includes(input.argument ?? "")) profile = { ...current, density: input.argument }
      else if (input.argument === "toggle-worktree") profile = { ...current, showProject: !current.showProject }
      else throw new Error("Expected compact|comfortable|spacious|toggle-worktree")
      backupId = change(profile, input.dryRun)
    } else if (input.operation === "rollback") {
      profile = saved("backups", input.argument ?? read(path.join(root, "latest-backup.json")).id as string | undefined)
      backupId = change(profile, input.dryRun)
    } else if (input.operation === "propose") {
      const text = input.argument ?? ""
      const patch: Record<string, unknown> = { ...input.profile }
      if (/compact|compacto|tight|small|pequeñ/i.test(text)) patch.density = "compact"
      if (/spacious|espacioso/i.test(text)) patch.density = "spacious"
      if (/comfortable|cómodo/i.test(text)) patch.density = "comfortable"
      if (/green|verde/i.test(text)) patch.theme = "mendcode"
      if (/(?:disable|without|no|hide).*worktree/i.test(text)) patch.showProject = false
      if (/plain|raw/i.test(text)) { patch.presentation = "raw"; patch.messageRenderer = "plain" }
      profile = { ...current, ...patch }
      validate(profile)
      proposalId = randomUUID()
      // Dry-run creates a reviewable proposal; applying it is always a separate operation.
      const target = path.join(root, "proposals", proposalId + ".json")
      write(target, { profile, request: text, changed: Object.keys(patch) })
      artifacts.push(target)
    } else if (["preview", "render", "project"].includes(input.operation)) {
      profile = { ...current, ...input.profile }
      validate(profile)
      const target = path.join(root, "runtime", input.operation + ".json")
      write(target, { architecture: "native-line-grid", profile, state: input.state ?? "home", source: file })
      artifacts.push(target)
    }
    const issues = tuiProblems(profile)
    for (const frame of input.frames ?? []) {
      const target = path.join(root, "runtime", frame.name + ".txt")
      mkdirSync(path.dirname(target), { recursive: true })
      writeFileSync(target, frame.lines.join("\n") + "\n")
      artifacts.push(target)
    }
    return {
      profile, path: file, valid: issues.length === 0, issues,
      ...(input.operation === "schema" ? { schema: { type: "object", additionalProperties: false, properties: Object.fromEntries(Object.entries(TUI_DEFAULTS).map(([key, value]) => [key, { type: Array.isArray(value) ? "array" : typeof value, default: value, ...(TUI_ENUMS[key] ? { enum: TUI_ENUMS[key] } : {}) }])) } } : {}),
      ...(proposalId ? { proposalId } : {}), ...(backupId ? { backupId } : {}),
      artifacts, changed: Object.keys(profile).filter((key) => JSON.stringify(profile[key]) !== JSON.stringify(current[key])),
      ...(input.check ? { check: { exitCode: issues.length ? 1 : 0 } } : {}),
    }
  }
  return { run }
}
