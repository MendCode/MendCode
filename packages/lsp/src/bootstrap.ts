import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { constants } from "node:fs"
import { basename, dirname, isAbsolute, join, parse, resolve, sep } from "node:path"
import { DEFAULT_SERVERS, findRoot, type LspServerSpec } from "./registry"
import { runManaged } from "@mendcode/tools"
import { installedPresetCommand, preparePresetCommand, pythonEnvironments } from "./other-launch"

const exists = (path: string) => access(path).then(() => true, () => false)
const executable = (path: string) => access(path, constants.X_OK).then(() => true, () => false)
const markerExists = async (path: string) => {
  const name = basename(path)
  if (!name.includes("*")) return exists(path)
  const pattern = new RegExp(`^${name.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`)
  return (await readdir(dirname(path)).catch(() => [])).some((entry) => pattern.test(entry))
}

/** Discover installed project/cache binaries without downloading or changing dependencies. */
export async function localCommand({ spec, cwd, root = cwd, cacheDir, which, run = runManaged, signal }: { spec: LspServerSpec; cwd: string; root?: string; cacheDir?: string; which: (binary: string) => string | null; run?: typeof runManaged; signal?: AbortSignal }): Promise<string[] | undefined> {
  const prepare = (command: string[]) => preparePresetCommand({ spec, cwd, root, ...(cacheDir ? { cacheDir } : {}), which, run, ...(signal ? { signal } : {}), command })
  const directories: string[] = []
  const top = resolve(cwd)
  for (let directory = resolve(root); directory === top || directory.startsWith(top + sep); directory = dirname(directory)) {
    directories.push(join(directory, "node_modules", ".bin"))
    if (directory === top) break
  }
  if (!directories.length) directories.push(join(cwd, "node_modules", ".bin"))
  if (cacheDir && spec.bootstrap !== false) directories.push(join(cacheDir, "bin"), join(cacheDir, "node_modules", ".bin"), join(cacheDir, spec.id, "node_modules", ".bin"))
  for (const command of [spec.command, ...(spec.fallbacks ?? [])]) {
    const binary = command[0]!
    if (binary.includes("/") || binary.includes("\\")) {
      const path = isAbsolute(binary) ? binary : resolve(cwd, binary)
      if (await executable(path)) return prepare([path, ...command.slice(1)])
      continue
    }
    const candidates: string[] = []
    if (spec.env?.PATH !== undefined) {
      for (const directory of spec.env.PATH.split(process.platform === "win32" ? ";" : ":")) {
        const path = resolve(cwd, directory, binary)
        if (await executable(path)) candidates.push(path)
      }
    } else {
      const path = which(binary)
      if (path) candidates.push(path)
    }
    const local: string[] = []
    for (const directory of directories) {
      for (const suffix of process.platform === "win32" ? [".cmd", ".exe", ""] : [""]) {
        const path = join(directory, binary + suffix)
        if (await executable(path)) local.push(path)
      }
    }
    for (const path of new Set(spec.id === "oxlint" || spec.id === "biome" ? [...local, ...candidates] : [...candidates, ...local])) {
      if (signal?.aborted) return undefined
      if (spec.id === "oxlint" && binary === "oxlint" && command[1] === "--lsp") {
        const help = await run({ argv: [path, "--help"], cwd: root, env: { ...process.env, ...spec.env }, timeoutMs: 2_000, signal: signal ?? new AbortController().signal }).catch(() => undefined)
        if (!help || help.exitCode !== 0 || help.cancelled || help.timedOut || !help.output.includes("--lsp")) continue
      }
      return prepare([path, ...command.slice(1)])
    }
  }
  return installedPresetCommand({ spec, cwd, root, ...(cacheDir ? { cacheDir } : {}), which, run, ...(signal ? { signal } : {}) })
}

export async function serverRoot({ file, cwd, spec }: { file: string; cwd: string; spec: LspServerSpec }): Promise<string | undefined> {
  if (spec.rootExcludes?.length) {
    const excluded = await findRoot({ file, cwd, markers: spec.rootExcludes, exists: markerExists })
    for (const marker of spec.rootExcludes) if (await markerExists(join(excluded, marker))) return undefined
  }
  const root = await findRoot({ file, cwd, markers: spec.rootMarkers, exists: markerExists })
  if (spec.rootRequired && !(await Promise.all(spec.rootMarkers.map((marker) => markerExists(join(root, marker))))).some(Boolean)) return undefined
  if (spec.rootGroups) for (const markers of spec.rootGroups) {
    const candidate = await findRoot({ file, cwd, markers, exists: markerExists })
    if ((await Promise.all(markers.map((marker) => markerExists(join(candidate, marker))))).some(Boolean)) return candidate
  }
  if (spec.rootFallback === "git" && !(await Promise.all(spec.rootMarkers.map((marker) => markerExists(join(root, marker))))).some(Boolean)) {
    const repository = await findRoot({ file, cwd: parse(resolve(cwd)).root, markers: [".git"], exists })
    return await exists(join(repository, ".git")) ? repository : root
  }
  if (spec.id === "go") {
    const work = await findRoot({ file, cwd, markers: ["go.work"], exists })
    return await exists(join(work, "go.work")) ? work : root
  }
  if (spec.id !== "rust") return root
  const top = resolve(cwd)
  for (let dir = root; dir === top || dir.startsWith(top + sep); dir = dirname(dir)) {
    const toml = await readFile(join(dir, "Cargo.toml"), "utf8").catch(() => "")
    if (/^\s*\[workspace\]\s*$/m.test(toml)) return dir
    if (dir === top) break
  }
  return root
}

export async function serverInitialization({ spec, root, cwd }: { spec: LspServerSpec; root: string; cwd: string }): Promise<Record<string, unknown> | undefined> {
  const initialization: Record<string, unknown> = {}
  const astro = spec.id === "astro" && spec.command[0] === "astro-ls"
  if (spec.id === "typescript" || astro) {
    const top = resolve(cwd)
    for (let dir = root; dir === top || dir.startsWith(top + sep); dir = dirname(dir)) {
      const path = join(dir, "node_modules", "typescript", "lib", "tsserver.js")
      if (await exists(path)) {
        if (astro) initialization.typescript = { tsdk: dirname(path) }
        else initialization.tsserver = { path }
        break
      }
      if (dir === top) break
    }
    if (astro && !initialization.typescript) return undefined
  }
  if (spec.id === "eslint" && spec.command[0] === "vscode-eslint-language-server") {
    const top = resolve(cwd)
    let installed = false
    for (let directory = root; directory === top || directory.startsWith(top + sep); directory = dirname(directory)) {
      if (await exists(join(directory, "node_modules", "eslint", "package.json"))) {
        installed = true
        break
      }
      if (directory === top) break
    }
    if (!installed) return undefined
  }
  if (spec.id === "python" || spec.id === "ty") {
    for (const venv of pythonEnvironments(spec, root)) {
      const python = join(venv, process.platform === "win32" ? "Scripts/python.exe" : "bin/python")
      if (await exists(python)) {
        initialization.pythonPath = python
        break
      }
    }
  }
  return { ...initialization, ...spec.initialization }
}

type Provisioned = { command?: string[]; reason?: string }
const ended = (result: Awaited<ReturnType<typeof runManaged>>) => result.cancelled ? "was cancelled" : result.timedOut ? "timed out" : `exited with code ${result.exitCode}`

type Provision = { spec: LspServerSpec; cwd: string; cacheDir: string; which: (binary: string) => string | null; run: typeof runManaged; signal?: AbortSignal | undefined; online: boolean }

/** The servers MendCode itself can provision: TypeScript, Pyright and gopls (other presets use installed binaries only). */
export const PROVISIONED_SERVERS = ["typescript", "python", "go"] as const
const provisionable = (spec: LspServerSpec) => spec.id === "typescript" && spec.command[0] === "typescript-language-server" || spec.id === "python" && spec.command[0] === "pyright-langserver" || spec.id === "go" && spec.command[0] === "gopls"

/**
 * Installs a builtin server into `<cacheDir>/<id>` (gopls into `<cacheDir>/bin`). Offline it uses local package/toolchain
 * caches only; online (an explicit `lsp install`) pnpm and the Go module proxy download. Either way pnpm runs no package
 * scripts and takes no release younger than a day, and Go keeps the local toolchain.
 */
async function provisionBuiltin({ spec, cwd, cacheDir, which, run, signal, online }: Provision): Promise<Provisioned> {
  const directory = join(cacheDir, spec.id)
  await mkdir(directory, { recursive: true })
  const env = { ...process.env, ...spec.env }
  const mode = online ? "" : "--offline "
  const runCommand = (argv: string[], extra: Record<string, string> = {}) => run({ argv, cwd: directory, env: { ...env, ...extra }, timeoutMs: online ? 180_000 : 15_000, signal: signal ?? new AbortController().signal })
  if (spec.id === "go") {
    const go = which("go")
    if (!go) return { reason: "go is not on PATH" }
    await mkdir(join(cacheDir, "bin"), { recursive: true })
    const result = await runCommand([go, "install", "golang.org/x/tools/gopls@latest"], { GOBIN: join(cacheDir, "bin"), GOTOOLCHAIN: "local", ...(online ? {} : { GOPROXY: "off", GOSUMDB: "off" }) })
    if (result.exitCode !== 0 || result.cancelled || result.timedOut) return { reason: `go install gopls${online ? "" : " from the local module cache"} ${ended(result)}` }
  } else {
    const pnpm = which("pnpm")
    if (!pnpm) return { reason: "pnpm is not on PATH" }
    const version = await runCommand([pnpm, "--version"])
    if (version.exitCode !== 0 || version.cancelled || version.timedOut) return { reason: `pnpm --version ${ended(version)}` }
    const major = Number(/^(\d+)\./.exec(version.output.trim())?.[1] ?? 0)
    if (major < 11) return { reason: "pnpm 11 or newer is required" }
    // Exclusive create preserves an existing cache's package manifest.
    await writeFile(join(directory, "package.json"), JSON.stringify({ name: `mendcode-lsp-${spec.id}`, private: true }), { flag: "wx" }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error })
    const packages = spec.id === "typescript" ? ["typescript-language-server", "typescript"] : ["pyright"]
    const result = await runCommand([pnpm, "add", ...(online ? [] : ["--offline"]), "--ignore-scripts", "--config.minimumReleaseAge=1440", ...packages])
    if (result.exitCode !== 0 || result.cancelled || result.timedOut) return { reason: `pnpm add ${mode}${packages.join(" ")} ${ended(result)}` }
  }
  const command = await localCommand({ spec, cwd, cacheDir, which })
  return command ? { command } : { reason: `${spec.command[0]} is still missing after the ${online ? "" : "offline "}install` }
}

/**
 * Missing builtins may be provisioned from local package/toolchain caches only. `explain` receives why nothing was
 * provisioned, for every caller of a shared install; it is not called for a spec that is never provisioned.
 */
export function createOfflineBootstrap({ cacheDir, which = Bun.which, run = runManaged }: { cacheDir: string; which?: (binary: string) => string | null; run?: typeof runManaged }) {
  const pending = new Map<string, Promise<Provisioned>>()
  return async ({ spec, cwd, disabled = false, signal, explain }: { spec: LspServerSpec; cwd: string; disabled?: boolean; signal?: AbortSignal; explain?: (reason: string) => void }): Promise<string[] | undefined> => {
    const installed = await localCommand({ spec, cwd, cacheDir, which })
    if (installed || disabled || spec.disableDownload || spec.bootstrap === false || signal?.aborted) return installed
    // Custom commands and rust-analyzer never acquire a substitute package.
    if (!provisionable(spec)) return undefined
    let task = pending.get(spec.id)
    if (!task) {
      task = provisionBuiltin({ spec, cwd, cacheDir, which, run, signal, online: false }).catch((error: unknown): Provisioned => ({ reason: error instanceof Error ? error.message : String(error) }))
      pending.set(spec.id, task)
      void task.finally(() => { if (pending.get(spec.id) === task) pending.delete(spec.id) })
    }
    const { command, reason } = await task
    if (!command && reason) explain?.(reason)
    return command
  }
}

/** `mendcode lsp install <id>`: downloads a builtin server into the data dir's LSP cache, where every later lookup finds it. */
export async function installLspServer({ id, cwd, cacheDir, which = Bun.which, run = runManaged, signal }: { id: (typeof PROVISIONED_SERVERS)[number]; cwd: string; cacheDir: string; which?: (binary: string) => string | null; run?: typeof runManaged; signal?: AbortSignal }): Promise<{ id: string; command?: string[]; already?: boolean; reason?: string }> {
  const spec = DEFAULT_SERVERS.find((entry) => entry.id === id)
  if (!spec || !provisionable(spec)) return { id, reason: `${id} is not a server MendCode installs (it installs ${PROVISIONED_SERVERS.join(", ")})` }
  const present = await localCommand({ spec, cwd, cacheDir, which })
  if (present) return { id, command: present, already: true }
  const result = await provisionBuiltin({ spec, cwd, cacheDir, which, run, signal, online: true }).catch((error: unknown): Provisioned => ({ reason: error instanceof Error ? error.message : String(error) }))
  return { id, ...result }
}
