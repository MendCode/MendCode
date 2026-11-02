import { existsSync } from "node:fs"
import { resolve, sep } from "node:path"
import type { GraphGate } from "./index-gate"
import type { Indexer } from "./indexer"

/**
 * The numbers of the autopilot (docs/code-graph.md, "Autopilot"). Each one bounds a cost: a walk of the project, a scan of its files,
 * a wait inside a turn.
 */
export const AUTOPILOT = {
  /**
   * Changed code, in bytes since the last index, below which a refresh is not worth a scan: 36 KiB, about 600 lines at this repository's
   * 61 bytes a line (15.3 MB in 248,000 lines of non-test TypeScript), or nine files of the median 4.1 KB. Bytes, not files: a few
   * strings edited in a small file can never reach it (a file contributes at most its own size), a new or rewritten large file does.
   */
  REFRESH_BYTES: 36 * 1024,
  /** What a modified file counts at least, capped by its size: a same-size edit has no size change to measure. 200 bytes is about three lines; 185 such files reach the budget. */
  TOUCH_BYTES: 200,
  /** Per project, the least time between two looks at the disk for drift (one walk, no scan): at most one per two minutes, however many turns. */
  CHECK_GAP_MS: 2 * 60_000,
  /** A build that failed is not retried by turns for this long (a tool call may still ask for it). */
  RETRY_MS: 10 * 60_000,
  /** How long a graph tool waits for a build it just started before it answers "building": a small project is ready inside it. */
  WAIT_MS: 4_000,
} as const

/** Why the autopilot leaves a folder alone, beyond the index gate's own reasons. */
export type AutopilotSkip = "system folder" | "dependency folder" | "off" | "home folder" | "no git repo" | "several repos" | "large folder"

/** Folders of the operating system: a project is never there, whatever a stray `.git` or manifest says. */
const SYSTEM_ROOTS = ["/bin", "/sbin", "/etc", "/dev", "/proc", "/sys", "/boot", "/lib", "/lib32", "/lib64", "/usr", "/System", "/Library", "/Applications", "/private/etc", "/private/var/db", "/opt/homebrew", "/usr/local/Cellar"] as const

/** The filesystem root, an operating system folder or a dependency folder (`node_modules`, a package cache): never a project to index by itself. */
export function systemFolder(cwd: string): AutopilotSkip | undefined {
  const at = resolve(cwd)
  if (at === sep || at === resolve(sep)) return "system folder"
  if (SYSTEM_ROOTS.some((root) => at === root || at.startsWith(`${root}/`))) return "system folder"
  if (at.split(sep).some((part) => part === "node_modules" || part === ".git" || part === ".cache")) return "dependency folder"
  return undefined
}

export type AutopilotOptions = {
  indexer: Indexer
  /** The index gate bound to the project's `/graph` mode (`auto` by default): the verdict for a folder. */
  gate: (cwd: string, signal: AbortSignal) => Promise<GraphGate>
  /** Whether the feature is on now; read at every use, so `/tier graph_autopilot off` stops it at once. */
  enabled: () => boolean
  now?: (() => number) | undefined
  /** The daemon's log line (`[GRAPH]: ...`). */
  log?: ((message: string) => void) | undefined
  /** Test knobs; the defaults are `AUTOPILOT`. */
  wait?: number | undefined
  checkGap?: number | undefined
}

export type AutopilotNeed = { ready: true } | { ready: false; message: string }
export type AutopilotState = "none" | "building" | "refreshing" | "failed" | "idle"

export type GraphAutopilot = {
  /** A session opened or a turn began in `cwd`: build its graph in the background when it has none and may have one, refresh it when enough drifted. Never waits, never throws. */
  note(input: { cwd: string; reason: "session" | "turn" }): void
  /** A graph tool needs the graph of `cwd`: ready, or a clear message (building, with its progress; failed; not eligible). Starts the build when nothing built it yet. */
  need(input: { cwd: string; signal: AbortSignal }): Promise<AutopilotNeed>
  state(cwd: string): AutopilotState
  /** Resolves when nothing runs for `cwd` (a look, a build, a refresh); for callers that must observe the outcome. */
  idle(cwd: string): Promise<void>
  /** Cancels the builds and refreshes of folders that are no longer eligible or the feature is off (settings changed). */
  reconsider(): void
  /** Cancels everything that runs. */
  stop(): void
}

type Entry = { phase: AutopilotState; running?: Promise<void> | undefined; controller?: AbortController | undefined; checkedAt: number; failedAt?: number | undefined; failure?: string | undefined; announced: boolean }

export function createGraphAutopilot(options: AutopilotOptions): GraphAutopilot {
  const { indexer, gate } = options
  const now = options.now ?? Date.now
  const log = options.log ?? (() => undefined)
  const waitMs = options.wait ?? AUTOPILOT.WAIT_MS
  const checkGap = options.checkGap ?? AUTOPILOT.CHECK_GAP_MS
  const entries = new Map<string, Entry>()
  /** The last decision logged per folder, so a decision is written once and not at every turn. */
  const decided = new Map<string, string>()
  const decide = (cwd: string, text: string) => {
    if (decided.get(cwd) === text) return
    decided.delete(cwd)
    decided.set(cwd, text)
    while (decided.size > 64) decided.delete(decided.keys().next().value as string)
    log(`[GRAPH]: autopilot ${text}: ${cwd}`)
  }
  const entryOf = (cwd: string): Entry => {
    let entry = entries.get(cwd)
    if (!entry) {
      entry = { phase: "none", checkedAt: 0, announced: false }
      entries.set(cwd, entry)
      while (entries.size > 64) {
        const oldest = [...entries].find(([, value]) => !value.running)
        if (!oldest) break
        entries.delete(oldest[0])
      }
    }
    return entry
  }
  const built = (cwd: string) => indexer.peek(cwd) !== undefined || existsSync(indexer.cachePath(cwd))

  async function eligible(cwd: string, signal: AbortSignal): Promise<{ ok: true } | { ok: false; reason: AutopilotSkip }> {
    const system = systemFolder(cwd)
    if (system) return { ok: false, reason: system }
    const verdict = await gate(cwd, signal).catch(() => ({ index: false as const, reason: "off" as const }))
    return verdict.index ? { ok: true } : { ok: false, reason: verdict.reason }
  }

  /** Starts the build or refresh of `cwd` as the one that runs for it; the caller has checked there is none. */
  function start(cwd: string, entry: Entry, phase: "building" | "refreshing"): Promise<void> {
    const controller = new AbortController()
    entry.controller = controller
    entry.phase = phase
    entry.failure = undefined
    const startedAt = now()
    log(`[GRAPH]: autopilot ${phase === "building" ? "builds" : "refreshes"} the code graph: ${cwd}`)
    const running = indexer.graph({ cwd, signal: controller.signal }).then(
      (graph) => {
        entry.phase = "idle"
        entry.checkedAt = now()
        log(`[GRAPH]: autopilot ${phase === "building" ? "built" : "refreshed"} ${graph.files.size} files in ${now() - startedAt} ms${graph.partial ? " (partial)" : ""}: ${cwd}`)
      },
      (error: unknown) => {
        const cancelled = error instanceof DOMException && error.name === "AbortError"
        entry.phase = cancelled ? "none" : "failed"
        if (!cancelled) { entry.failedAt = now(); entry.failure = error instanceof Error ? error.message : String(error) }
        log(`[GRAPH]: autopilot ${cancelled ? "cancelled" : `failed (${entry.failure})`}: ${cwd}`)
      },
    ).finally(() => { entry.running = undefined; entry.controller = undefined })
    entry.running = running
    return running
  }

  async function look(cwd: string, entry: Entry, signal: AbortSignal): Promise<void> {
    if (!built(cwd)) {
      if (entry.failedAt !== undefined && now() - entry.failedAt < AUTOPILOT.RETRY_MS) return
      const verdict = await eligible(cwd, signal)
      if (!verdict.ok) return decide(cwd, `skips (${verdict.reason})`)
      decide(cwd, "eligible")
      await start(cwd, entry, "building")
      return
    }
    if (now() - entry.checkedAt < checkGap) return
    entry.checkedAt = now()
    const verdict = await eligible(cwd, signal)
    if (!verdict.ok) return decide(cwd, `skips (${verdict.reason})`)
    const drift = await indexer.drift({ cwd, signal, touchBytes: AUTOPILOT.TOUCH_BYTES })
    if (!drift) return
    if (drift.bytes < AUTOPILOT.REFRESH_BYTES) return
    log(`[GRAPH]: autopilot sees ${drift.changed} of ${drift.indexed} files changed, ${drift.bytes} bytes of code (threshold ${AUTOPILOT.REFRESH_BYTES}): ${cwd}`)
    await start(cwd, entry, "refreshing")
  }

  function note({ cwd: raw }: { cwd: string; reason: "session" | "turn" }): void {
    if (!options.enabled()) return
    const cwd = resolve(raw)
    const entry = entryOf(cwd)
    if (entry.running) return
    const controller = new AbortController()
    entry.controller = controller
    entry.running = look(cwd, entry, controller.signal).catch(() => undefined).finally(() => { if (entry.controller === controller) { entry.controller = undefined; entry.running = undefined } })
  }

  const message = (cwd: string, entry: Entry): string => {
    const progress = indexer.progress(cwd)
    const share = progress && progress.total > 0 ? ` ${Math.min(99, Math.floor((progress.done / progress.total) * 100))}%, ${progress.done} of ${progress.total} files scanned` : ""
    const opening = entry.announced ? "The code graph of this project is still building" : "This project had no code graph; MendCode started building it in the background"
    entry.announced = true
    return `${opening}${share ? ` (${share.trim()})` : ""}. It is not ready yet: use grep, glob and read for now, and call this graph tool again in a minute or so.`
  }

  async function need({ cwd: raw, signal }: { cwd: string; signal: AbortSignal }): Promise<AutopilotNeed> {
    if (!options.enabled()) return { ready: true }
    const cwd = resolve(raw)
    const entry = entryOf(cwd)
    if (entry.phase !== "building" && built(cwd)) return { ready: true }
    if (entry.phase === "failed" && entry.failedAt !== undefined && now() - entry.failedAt < AUTOPILOT.RETRY_MS) {
      return { ready: false, message: `The automatic build of this project's code graph failed (${entry.failure ?? "unknown error"}). Use grep, glob and read.` }
    }
    if (!entry.running) {
      const verdict = await eligible(cwd, signal)
      if (!verdict.ok) return { ready: true }
      if (!entry.running) void start(cwd, entry, "building")
    }
    // Either the build just started, or a look at the disk is running that decides whether to build: both get the same bounded wait.
    const running = entry.running
    if (!running) return { ready: true }
    const outcome = await Promise.race([
      running.then(() => "done" as const),
      new Promise<"waited">((resolveWait) => { const timer = setTimeout(() => resolveWait("waited"), waitMs); timer.unref?.(); signal.addEventListener("abort", () => { clearTimeout(timer); resolveWait("waited") }, { once: true }) }),
    ])
    if (outcome === "done" && entry.phase !== "failed") return { ready: true }
    if (entry.phase === "failed") return { ready: false, message: `The automatic build of this project's code graph failed (${entry.failure ?? "unknown error"}). Use grep, glob and read.` }
    return { ready: false, message: message(cwd, entry) }
  }

  return {
    note,
    need,
    state: (cwd) => entries.get(resolve(cwd))?.phase ?? "none",
    async idle(cwd) {
      for (let running = entries.get(resolve(cwd))?.running; running; running = entries.get(resolve(cwd))?.running) await running.catch(() => undefined)
    },
    reconsider() {
      for (const [cwd, entry] of entries) {
        if (!entry.controller) continue
        if (!options.enabled()) { entry.controller.abort(); continue }
        const controller = entry.controller
        void eligible(cwd, new AbortController().signal).then((verdict) => { if (!verdict.ok) controller.abort() })
      }
    },
    stop() { for (const entry of entries.values()) entry.controller?.abort() },
  }
}
