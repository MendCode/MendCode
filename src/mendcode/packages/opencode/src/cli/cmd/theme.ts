import type { Argv } from "yargs"
import { cmd } from "./cmd"
import { Global } from "@mendcode/core/global"
import path from "path"
import { mkdir, readFile, writeFile } from "fs/promises"
import { validateThemeDocument } from "./tui/theme-format"

type Scope = "project" | "global"
function scope(args: { scope?: string }): Scope { return args.scope === "global" ? "global" : "project" }
function themeDir(selected: Scope) { return selected === "global" ? path.join(Global.Path.config, "themes") : path.join(process.cwd(), ".mendcode", "themes") }
function tuiFile(selected: Scope) { return selected === "global" ? path.join(Global.Path.config, "tui.json") : path.join(process.cwd(), ".mendcode", "tui.json") }

const ValidateCommand = cmd({
  command: "validate <file>",
  describe: "validate a MendCode theme JSON document without starting the TUI",
  builder: (yargs: Argv) => yargs.positional("file", { type: "string", demandOption: true }),
  handler: async (args: { file: string }) => {
    const document = JSON.parse(await readFile(path.resolve(args.file), "utf8"))
    const errors = validateThemeDocument(document)
    const result = { ok: errors.length === 0, file: path.resolve(args.file), errors, callsProviders: false }
    console.log(JSON.stringify(result, null, 2))
    if (errors.length) process.exitCode = 1
  },
})

const InstallCommand = cmd({
  command: "install <file>",
  describe: "install a validated theme into the project or global MendCode theme directory",
  builder: (yargs: Argv) => yargs
    .positional("file", { type: "string", demandOption: true })
    .option("name", { type: "string", describe: "theme name; defaults to the source filename" })
    .option("scope", { choices: ["project", "global"] as const, default: "project" }),
  handler: async (args: { file: string; name?: string; scope?: string }) => {
    const source = path.resolve(args.file)
    const document = JSON.parse(await readFile(source, "utf8"))
    const errors = validateThemeDocument(document)
    if (errors.length) throw new Error(`Invalid theme:\n${errors.map((x) => `- ${x}`).join("\n")}`)
    const name = (args.name ?? path.basename(source, path.extname(source))).trim()
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) throw new Error("Theme name must contain only letters, numbers, dot, underscore, or hyphen")
    const dir = themeDir(scope(args))
    await mkdir(dir, { recursive: true })
    const destination = path.join(dir, `${name}.json`)
    await writeFile(destination, JSON.stringify(document, null, 2) + "\n", "utf8")
    console.log(JSON.stringify({ ok: true, name, scope: scope(args), path: destination, callsProviders: false }, null, 2))
  },
})

const SelectCommand = cmd({
  command: "select <name>",
  describe: "select an installed MendCode theme in tui.json",
  builder: (yargs: Argv) => yargs
    .positional("name", { type: "string", demandOption: true })
    .option("scope", { choices: ["project", "global"] as const, default: "project" }),
  handler: async (args: { name: string; scope?: string }) => {
    const selected = scope(args)
    const file = path.join(themeDir(selected), `${args.name}.json`)
    await readFile(file, "utf8")
    const config = tuiFile(selected)
    await mkdir(path.dirname(config), { recursive: true })
    let data: Record<string, unknown> = {}
    try { data = JSON.parse(await readFile(config, "utf8")) } catch { /* create a minimal config */ }
    await writeFile(config, JSON.stringify({ ...data, theme: args.name }, null, 2) + "\n", "utf8")
    console.log(JSON.stringify({ ok: true, name: args.name, scope: selected, config, callsProviders: false }, null, 2))
  },
})

export const ThemeCommand = cmd({
  command: "theme",
  describe: "validate, install, and select agent-authored MendCode themes",
  builder: (yargs: Argv) => yargs.command(ValidateCommand).command(InstallCommand).command(SelectCommand).demandCommand(),
  handler: () => {},
})
