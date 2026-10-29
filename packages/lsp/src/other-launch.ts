import { access, mkdir, readdir, stat } from "node:fs/promises"
import { constants } from "node:fs"
import { createHash } from "node:crypto"
import { homedir } from "node:os"
import { join } from "node:path"
import { runManaged } from "@mendcode/tools"
import { OTHER_SERVERS } from "./other-presets"
import type { LspServerSpec } from "./registry"

const exists = (path: string) => access(path).then(() => true, () => false)
const executable = (path: string) => access(path, constants.X_OK).then(() => true, () => false)
const builtin = (spec: LspServerSpec) => OTHER_SERVERS.find((server) => server.id === spec.id && [server.command, ...(server.fallbacks ?? [])].some((command) => command[0] === spec.command[0]))
type LaunchInput = { spec: LspServerSpec; cwd: string; root: string; cacheDir?: string; which: (binary: string) => string | null; run?: typeof runManaged; signal?: AbortSignal }

export function presetUnavailable(spec: LspServerSpec): string | undefined {
  if (!builtin(spec)) return undefined
  if (spec.id === "razor") return "Razor requires roslyn-language-server and the VS Code C# Razor extension"
  if (spec.id === "jdtls") return "JDTLS requires Java 21+ and an installed jdtls launcher or cached distribution"
  return undefined
}

export function pythonEnvironments(spec: LspServerSpec, root: string): string[] {
  return [spec.env?.VIRTUAL_ENV ?? process.env.VIRTUAL_ENV, join(root, ".venv"), join(root, "venv")].filter((path): path is string => !!path)
}

async function razorFiles(spec: LspServerSpec) {
  const explicit = spec.env?.VSCODE_EXTENSIONS ?? process.env.VSCODE_EXTENSIONS
  const roots = explicit ? [explicit] : [".vscode", ".vscode-insiders", ".vscode-server", ".vscode-server-insiders"].map((folder) => join(homedir(), folder, "extensions"))
  for (const root of new Set(roots)) {
    const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
    const candidates = await Promise.all(entries.filter((entry) => entry.isDirectory() && entry.name.startsWith("ms-dotnettools.csharp-")).map(async (entry) => ({ path: join(root, entry.name, ".razorExtension"), modified: (await stat(join(root, entry.name)).catch(() => undefined))?.mtimeMs ?? 0 })))
    for (const candidate of candidates.sort((a, b) => b.modified - a.modified)) {
      const files = [join(candidate.path, "Microsoft.CodeAnalysis.Razor.Compiler.dll"), join(candidate.path, "Targets", "Microsoft.NET.Sdk.Razor.DesignTime.targets"), join(candidate.path, "Microsoft.VisualStudioCode.RazorExtension.dll")]
      if ((await Promise.all(files.map(exists))).every(Boolean)) return files
    }
  }
  return undefined
}

/** Complete installed launchers without fetching packages or changing user toolchains. */
export async function preparePresetCommand(input: LaunchInput & { command: string[] }): Promise<string[] | undefined> {
  const { spec, command, root, cacheDir, which, run = runManaged, signal } = input
  if (signal?.aborted) return undefined
  if (!builtin(spec)) return command
  if (spec.id === "razor") {
    const files = await razorFiles(spec)
    if (!files || signal?.aborted) return undefined
    return [...command, `--razorSourceGenerator=${files[0]}`, `--razorDesignTimePath=${files[1]}`, "--extension", files[2]!]
  }
  if (spec.id === "jdtls") {
    const java = spec.env?.JAVA_HOME ? join(spec.env.JAVA_HOME, "bin", process.platform === "win32" ? "java.exe" : "java") : which("java")
    if (!java) return undefined
    const version = await run({ argv: [java, "-version"], cwd: root, env: { ...process.env, ...spec.env }, timeoutMs: 2_000, signal: signal ?? new AbortController().signal }).catch(() => undefined)
    const major = Number(/(?:openjdk|java)(?:\s+version)?\s+"?(\d+)/i.exec(version?.output ?? "")?.[1] ?? 0)
    if (!version || version.exitCode !== 0 || version.cancelled || version.timedOut || major < 21 || signal?.aborted) return undefined
    if (!cacheDir) return command
    const data = join(cacheDir, "jdtls", "workspaces", createHash("sha256").update(root).digest("hex").slice(0, 24))
    await mkdir(data, { recursive: true })
    return [...command, "-data", data]
  }
  return command
}

/** v1's installed virtualenv/toolchain/distribution fallbacks, confined to explicit caches. */
export async function installedPresetCommand(input: LaunchInput): Promise<string[] | undefined> {
  const { spec, cwd, root, cacheDir, which, run = runManaged, signal } = input
  if (!builtin(spec) || signal?.aborted) return undefined
  const candidates: string[][] = []
  if (spec.id === "ty") for (const venv of pythonEnvironments(spec, root)) candidates.push([join(venv, process.platform === "win32" ? "Scripts/ty.exe" : "bin/ty"), "server"])
  if (spec.id === "csharp" || spec.id === "razor" || spec.id === "fsharp") candidates.push([join(spec.env?.DOTNET_CLI_HOME ?? process.env.DOTNET_CLI_HOME ?? homedir(), ".dotnet", "tools", spec.command[0]! + (process.platform === "win32" ? ".exe" : "")), ...spec.command.slice(1)])
  if (spec.id === "sourcekit-lsp") {
    const xcrun = which("xcrun")
    if (xcrun) {
      const result = await run({ argv: [xcrun, "--find", "sourcekit-lsp"], cwd: root, env: { ...process.env, ...spec.env }, timeoutMs: 2_000, signal: signal ?? new AbortController().signal }).catch(() => undefined)
      if (result?.exitCode === 0 && !result.timedOut && !result.cancelled && result.output.trim()) candidates.push([result.output.trim()])
    }
  }
  if (cacheDir && spec.bootstrap !== false) {
    const suffix = process.platform === "win32" ? ".exe" : ""
    candidates.push([join(cacheDir, spec.id, "bin", spec.command[0]! + suffix), ...spec.command.slice(1)])
    if (spec.id === "elixir-ls") candidates.push([join(cacheDir, "elixir-ls-master", "release", process.platform === "win32" ? "language_server.bat" : "language_server.sh")])
    if (spec.id === "kotlin-ls") candidates.push([join(cacheDir, "kotlin-ls", process.platform === "win32" ? "kotlin-lsp.cmd" : "kotlin-lsp.sh"), "--stdio"])
    if (spec.id === "clangd") {
      const entries = await readdir(cacheDir, { withFileTypes: true }).catch(() => [])
      for (const entry of entries.filter((entry) => entry.isDirectory() && entry.name.startsWith("clangd_")).sort((a, b) => b.name.localeCompare(a.name))) candidates.push([join(cacheDir, entry.name, "bin", "clangd" + suffix), ...spec.command.slice(1)])
    }
    if (spec.id === "jdtls") {
      const java = spec.env?.JAVA_HOME ? join(spec.env.JAVA_HOME, "bin", "java" + suffix) : which("java")
      const distribution = join(cacheDir, "jdtls")
      const jars = (await readdir(join(distribution, "plugins")).catch(() => [])).filter((name) => /^org\.eclipse\.equinox\.launcher_.*\.jar$/.test(name)).sort().reverse()
      const configuration = join(distribution, process.platform === "darwin" ? "config_mac" : process.platform === "win32" ? "config_win" : "config_linux")
      if (java && jars[0] && await exists(configuration)) candidates.push([java, "-Declipse.application=org.eclipse.jdt.ls.core.id1", "-Dosgi.bundles.defaultStartLevel=4", "-Declipse.product=org.eclipse.jdt.ls.core.product", "-Dlog.level=ALL", "--add-modules=ALL-SYSTEM", "--add-opens=java.base/java.util=ALL-UNNAMED", "--add-opens=java.base/java.lang=ALL-UNNAMED", "-jar", join(distribution, "plugins", jars[0]), "-configuration", configuration])
    }
  }
  for (const command of candidates) {
    if (signal?.aborted) return undefined
    if (await executable(command[0]!)) return preparePresetCommand({ spec, cwd, root, ...(cacheDir ? { cacheDir } : {}), which, run, ...(signal ? { signal } : {}), command })
  }
  return undefined
}
