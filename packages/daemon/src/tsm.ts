import { accessSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"
import { z } from "zod"
import { TsmMux, TsmPlan, TsmPolicy, type TsmChange, type TsmRead, type TsmReport } from "@mendcode/protocol"
import type { createWorktreeManager } from "./worktrees"
import { PROGRAM_NAME } from "@mendcode/program"

const repository = "https://github.com/adibhanna/tsm"
const supportedRange = "worktree-capable build"
const recommendedVersion = "v0.6.7+ with `tsm wt`"
const capabilities = ["tsm wt", "tsm wt open", "tsm wt add/rm", "tsm wt move", "tsm wt prune"]
const State = z.strictObject({ version: z.literal(1), enabled: z.boolean(), installMethod: z.enum(["path", "unknown"]), binaryPath: z.string().nullable(), detectedVersion: z.string().nullable(), defaultMuxBackend: TsmMux, updatedAt: z.string() })
const defaultState = () => ({ version: 1 as const, enabled: false, installMethod: "unknown" as const, binaryPath: null, detectedVersion: null, defaultMuxBackend: "auto" as const, updatedAt: new Date().toISOString() })

function read(file: string) {
  if (!existsSync(file)) return undefined
  const stat = lstatSync(file)
  if (!stat.isFile() || stat.size > 65536) throw new Error("TSM managed file must be a regular file under 64 KiB")
  return JSON.parse(readFileSync(file, "utf8"))
}
function save(file: string, value: unknown) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${crypto.randomUUID()}.tmp`
  writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 })
  renameSync(temporary, file)
}
const DEFAULT_PROBE_TIMEOUT_MS = 1000
async function probe(binary: string, args: string[], cwd: string, timeoutMs: number) {
  try {
    const child = Bun.spawn([binary, ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "ignore" })
    let timedOut = false, truncated = false, output = ""
    const reader = child.stdout.getReader()
    let expire!: () => void
    const deadline = new Promise<{ done: true; value: undefined }>((resolve) => { expire = () => resolve({ done: true, value: undefined }) })
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); expire() }, timeoutMs)
    try {
      const decoder = new TextDecoder()
      while (true) {
        const chunk = await Promise.race([reader.read(), deadline])
        if (chunk.done) break
        output += decoder.decode(chunk.value, { stream: true })
        if (output.length > 16384) { truncated = true; output = output.slice(0, 16384); child.kill("SIGKILL"); break }
      }
      const code = await child.exited
      return { ok: code === 0 && !timedOut && !truncated, output, warning: timedOut ? "TSM probe timed out" : truncated ? "TSM probe exceeded output limit" : code !== 0 ? "TSM probe failed" : "" }
    } finally { clearTimeout(timer); void reader.cancel().catch(() => {}) }
  } catch { return { ok: false, output: "", warning: "TSM probe could not start" } }
}

async function detect(cwd: string, timeoutMs: number) {
  const configured = process.env.MENDCODE_TSM_BINARY
  const binaryPath = configured || Bun.which("tsm")
  const missing = { binaryPath: null, detectedVersion: null, worktreeCapable: false, available: false, warning: configured ? "Configured TSM binary is unavailable" : "TSM binary not found on PATH" }
  if (!binaryPath || !path.isAbsolute(binaryPath)) return missing
  try { accessSync(binaryPath, constants.X_OK); if (!lstatSync(binaryPath).isFile() && !lstatSync(binaryPath).isSymbolicLink()) return missing } catch { return missing }
  const version = await probe(binaryPath, ["--version"], cwd, timeoutMs)
  const help = await probe(binaryPath, ["wt", "--help"], cwd, timeoutMs)
  const detectedVersion = version.ok ? version.output.match(/v?\d+\.\d+\.\d+/)?.[0] ?? null : null
  const numbers = detectedVersion?.match(/(\d+)\.(\d+)\.(\d+)/)
  const worktreeCapable = help.ok && /\bwt\b|worktree/i.test(help.output) || version.ok && Boolean(numbers && (Number(numbers[1]) > 0 || Number(numbers[2]) >= 7))
  return { binaryPath, detectedVersion, worktreeCapable, available: true, warning: version.warning || help.warning }
}

/** `probeTimeoutMs` bounds each `--version`/`wt --help` probe; tests raise it so a loaded machine cannot turn a slow start into "not capable". */
export function createTsmManager(input: { dir: string; worktrees: ReturnType<typeof createWorktreeManager>; probeTimeoutMs?: number }) {
  const probeTimeoutMs = input.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
  let pending = Promise.resolve()
  async function status(directory: string): Promise<TsmReport> {
    const worktrees = await input.worktrees.query(directory, { operation: "status" })
    const id = path.basename(worktrees.registryPath, ".json")
    const root = path.join(input.dir, "tsm", id)
    for (const directory of [path.join(input.dir, "tsm"), root, path.join(input.dir, "tsm-policy")]) {
      if (existsSync(directory) && !lstatSync(directory).isDirectory()) throw new Error("TSM managed directory must not be a symlink")
    }
    const managedFiles = { state: path.join(root, "state.json"), plan: path.join(root, "plan.json"), policy: path.join(input.dir, "tsm-policy", `${id}.json`) }
    const state = State.parse(read(managedFiles.state) ?? defaultState())
    const policy = TsmPolicy.parse(read(managedFiles.policy) ?? { mode: "off", liveSync: false, neverSync: [] })
    const detected = await detect(worktrees.workspace.repoRoot ?? worktrees.workspace.currentPath, probeTimeoutMs)
    const lifecycle = state.enabled ? detected.available && detected.worktreeCapable ? "active" : "degraded" : detected.available ? "installed-inactive" : "not-installed"
    const rootGit = worktrees.workspace.repoRoot !== null
    const head = worktrees.records.find((record) => record.path === worktrees.workspace.repoRoot)?.head
    const gitHead = rootGit && Boolean(head && !/^0+$/.test(head))
    const rawPlan = read(managedFiles.plan)
    return {
      operation: "status", ok: lifecycle !== "degraded", lifecycle, enabled: state.enabled,
      workspace: worktrees.workspace, repository, supportedRange, recommendedVersion,
      binaryPath: detected.binaryPath, detectedVersion: detected.detectedVersion, worktreeCapable: detected.worktreeCapable,
      capabilities, defaultMuxBackend: state.defaultMuxBackend, managedFiles, policy, rootGit, gitHead,
      safety: { installsTsm: false, startsSessions: false, killsSessions: false, removesWorktrees: false, explicitActivationRequired: true, statusExecutesVersionProbe: Boolean(detected.binaryPath) },
      warnings: [...(!rootGit ? ["Project is not a Git checkout"] : !gitHead ? ["Git repository has no commits; commit before using TSM worktrees"] : []), ...(!detected.worktreeCapable && detected.available ? ["Detected TSM does not advertise worktree capabilities"] : []), ...(detected.warning ? [detected.warning] : [])], failures: [],
      ...(rawPlan === undefined ? {} : { plan: TsmPlan.parse(rawPlan) }),
    }
  }
  async function query(directory: string, query: TsmRead): Promise<TsmReport> {
    const report = await status(directory)
    report.operation = query.operation
    if (query.operation === "doctor") {
      if (report.lifecycle === "degraded") report.failures.push("TSM integration is active but binary/capabilities are unavailable")
      if (!report.rootGit) report.failures.push("Project must be a Git checkout before TSM worktree approval")
      if (report.policy.liveSync) report.failures.push("TSM worktree execution must not start while liveSync=true")
      report.ok = report.failures.length === 0
    } else if (query.operation === "open" || query.operation === "create") {
      const native = await input.worktrees.query(directory, query.operation === "open" ? query : { operation: "preview", input: query.input })
      const preview = native.preview!
      const reasons = [...preview.blockReasons, ...(!report.enabled ? ["TSM integration is not active"] : []), ...(report.lifecycle !== "active" ? [`TSM lifecycle is ${report.lifecycle}`] : []), ...(!report.worktreeCapable ? ["TSM binary does not advertise worktree capabilities"] : []), ...(report.policy.liveSync ? ["TSM worktree execution must not start while liveSync=true"] : [])]
      report.preview = { action: query.operation, target: preview.target.path, branch: preview.target.branch, commands: report.workspace.repoRoot ? [{ tool: "tsm", argv: ["wt", ...(query.operation === "create" ? ["add"] : []), preview.target.branch || preview.target.path], cwd: report.workspace.repoRoot, destructive: false }] : [], blocked: reasons.length > 0, blockReasons: reasons, executesTsm: false }
      report.ok = !report.preview.blocked
    }
    return report
  }
  async function change(directory: string, change: TsmChange): Promise<TsmReport> {
    const report = await status(directory)
    if (["plan", "install", "setup"].includes(change.operation)) {
      const plan: TsmPlan = { version: 1, status: "dry-run", generatedAt: new Date().toISOString(), path: report.managedFiles.plan, repository, supportedRange, recommendedVersion,
        install: { executesInstall: false, commands: ["brew tap adibhanna/tsm", "brew install adibhanna/tsm/tsm", "gh release download --repo adibhanna/tsm # choose the asset for this platform"] },
        activation: { command: `${PROGRAM_NAME} tsm activate`, requiresDetectedBinary: true, delegatesWorktreesImmediately: false },
        removal: { command: `${PROGRAM_NAME} tsm remove`, removesExternalTsm: false, killsSessions: false } }
      save(report.managedFiles.plan, plan)
      return { ...report, operation: change.operation, ok: true, plan }
    }
    if (change.operation === "remove") {
      const root = path.dirname(report.managedFiles.state)
      let archivedTo: string | undefined
      if (existsSync(root)) {
        for (const directory of [path.join(input.dir, "trash"), path.join(input.dir, "trash", "tsm")]) {
          if (existsSync(directory) && !lstatSync(directory).isDirectory()) throw new Error("TSM recycle directory must not be a symlink")
        }
        archivedTo = path.join(input.dir, "trash", "tsm", `${path.basename(root)}-${crypto.randomUUID()}`)
        mkdirSync(path.dirname(archivedTo), { recursive: true, mode: 0o700 })
        renameSync(root, archivedTo)
      }
      return { ...await status(directory), operation: "remove", ...(archivedTo ? { archivedTo } : {}) }
    }
    if (change.operation === "activate" && (!report.binaryPath || !report.worktreeCapable)) throw new Error(!report.binaryPath ? "Cannot activate TSM: binary not found" : "Cannot activate TSM: detected binary does not advertise worktree support")
    const current = State.parse(read(report.managedFiles.state) ?? defaultState())
    save(report.managedFiles.state, { ...current, enabled: change.operation === "activate", updatedAt: new Date().toISOString(), ...(change.operation === "activate" ? { installMethod: "path", binaryPath: report.binaryPath, detectedVersion: report.detectedVersion, defaultMuxBackend: change.muxBackend ?? "auto" } : {}) })
    return { ...await status(directory), operation: change.operation }
  }
  return { query, change(directory: string, changeInput: TsmChange) {
    const result = pending.then(() => change(directory, changeInput))
    pending = result.then(() => {}, () => {})
    return result
  } }
}
