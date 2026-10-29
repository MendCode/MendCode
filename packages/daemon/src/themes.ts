import { lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { MAX_THEME_BYTES, THEME_NAME, themeDocument } from "@mendcode/protocol/wire"
import type { Command, Settings } from "@mendcode/protocol"

type ThemeCommand = Extract<Command, { type: "theme.validate" | "theme.install" | "theme.select" }>

export function createThemes(input: { dir: string; settings: { get(): Settings; set(patch: Record<string, unknown>): Settings }; applyProfile(theme: string): void; changed(settings: Settings): void }) {
  function read(file: string) {
    if (!statSync(file).isFile()) throw new Error("theme must be a file")
    if (statSync(file).size > MAX_THEME_BYTES) throw new Error(`theme exceeds ${MAX_THEME_BYTES / 1024} KB`)
    const raw = readFileSync(file, "utf8")
    if (Buffer.byteLength(raw) > MAX_THEME_BYTES) throw new Error(`theme exceeds ${MAX_THEME_BYTES / 1024} KB`)
    return JSON.parse(raw) as unknown
  }
  function root(directory: string, scope: "user" | "project") {
    const target = scope === "user" ? realpathSync(input.dir) : path.join(realpathSync(directory), ".mendcode")
    if (lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error("theme scope must not be a symlink")
    const themes = path.join(target, "themes")
    if (lstatSync(themes, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error("theme directory must not be a symlink")
    return target
  }
  function run(command: ThemeCommand): Record<string, unknown> {
    const source = command.type === "theme.select" ? path.join(root(command.directory, command.scope), "themes", `${command.name}.json`) : path.resolve(command.file)
    let json: unknown
    let errors: string[]
    try {
      if (command.type === "theme.select" && lstatSync(source).isSymbolicLink()) throw new Error("theme file must not be a symlink")
      json = read(source)
      errors = themeDocument(json).errors
    } catch (error) {
      errors = [error instanceof SyntaxError ? "invalid JSON" : error instanceof Error ? error.message : String(error)]
    }
    if (command.type === "theme.validate") return { ok: errors.length === 0, file: source, errors, callsProviders: false }
    if (errors.length) throw new Error(`Invalid theme: ${errors.join("; ")}`)
    const name = (command.type === "theme.install" ? command.name ?? path.basename(source, path.extname(source)) : command.name).trim()
    if (!THEME_NAME.test(name)) throw new Error("Theme name must use letters, numbers, dot, underscore or hyphen (max 40)")
    if (command.type === "theme.install") {
      const content = JSON.stringify(json, null, 2) + "\n"
      if (Buffer.byteLength(content) > MAX_THEME_BYTES) throw new Error(`installed theme exceeds ${MAX_THEME_BYTES / 1024} KB`)
      const directory = path.join(root(command.directory, command.scope), "themes")
      mkdirSync(directory, { recursive: true })
      if (lstatSync(directory).isSymbolicLink()) throw new Error("theme directory must not be a symlink")
      const destination = path.join(directory, `${name}.json`)
      if (lstatSync(destination, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error("theme file must not be a symlink")
      const temp = `${destination}.${randomUUID()}.tmp`
      writeFileSync(temp, content, { flag: "wx", mode: 0o600 })
      renameSync(temp, destination)
      return { ok: true, name, scope: command.scope, path: destination, callsProviders: false }
    }
    const directory = path.resolve(command.directory)
    if (command.scope === "user") input.applyProfile(name)
    const settings = input.settings.set(command.scope === "user" ? { theme: name } : { projectThemes: { ...input.settings.get().projectThemes, [directory]: name } })
    input.changed(settings)
    return { ok: true, name, scope: command.scope, config: command.scope === "user" ? path.join(input.dir, "tui", "profile.json") : path.join(input.dir, "mendd.db"), directory, callsProviders: false }
  }
  return { run }
}
