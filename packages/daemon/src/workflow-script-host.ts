import { existsSync, realpathSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { sandboxBackend, type SandboxBackend } from "@mendcode/tools"
import type { ScriptHostInput, ScriptHostPort } from "@mendcode/workflows"

/**
 * Runs a workflow script in its own OS process (the compiled binary itself with `__script-host`, or `bun script-host.ts` in
 * development), under the strictest profile the platform offers, with a watchdog. The script never shares the daemon's memory.
 *
 * Layers, outermost first: (1) a separate process the daemon can SIGKILL, with an empty environment and `/` as its directory;
 * (2) the OS sandbox: no network, no file writes, no process creation (Seatbelt only: bubblewrap has no syscall filter here, so on
 * Linux layer 3 is what removes process creation, and a loopback socket can be opened inside the private network namespace), and no
 * reads of the user's home, the daemon's data directory, the project or the temp directories (macOS Seatbelt, Linux bubblewrap: the
 * hidden roots are empty read-only tmpfs and only the host's own files show through; with neither the host refuses to start unless
 * `MENDCODE_SCRIPT_UNSANDBOXED=1`); (3) a stripped global scope inside the process (script-host.ts); (4) the watchdog: no heartbeat
 * for `silenceMs` (a loop that never yields) or resident memory above `heapMb` kills it. Messages from it are untrusted data.
 */
export type ScriptHostLimits = { silenceMs: number; heapMb: number; pollMs: number }
export const DEFAULT_SCRIPT_LIMITS: ScriptHostLimits = { silenceMs: 30_000, heapMb: 256, pollMs: 500 }

const BUNFS = /^(\/\$bunfs\/|[A-Za-z]:[\\/]~BUN[\\/])/
const MAX_STDERR = 2_000
const MAX_LINE = 4 * 1024 * 1024

const real = (target: string) => {
  try {
    return realpathSync(target)
  } catch {
    return path.resolve(target)
  }
}

function seatbeltString(value: string) {
  if (/[\0-\x1f\x7f]/.test(value)) throw new Error("path has control characters")
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
}

/** Where script reads are refused: whatever could hold secrets or the user's work. */
export function hiddenRoots(input: { home?: string | undefined; dir: string; directory: string }): string[] {
  const temp = [os.tmpdir(), "/tmp", "/var/tmp", "/private/tmp", "/private/var/tmp", "/var/folders", "/private/var/folders"]
  return [...new Set([input.home, input.dir, input.directory, ...temp].filter((entry): entry is string => !!entry && path.isAbsolute(entry) && entry !== "/").flatMap((entry) => [entry, real(entry)]))]
}

/** The Seatbelt profile of a script host: allow everything, then take away writes, network, forking and the hidden roots; the host's own files stay readable. */
export function scriptSeatbeltProfile(input: { hidden: readonly string[]; readable: readonly string[]; readableTrees: readonly string[] }): string {
  const lines = ["(version 1)", "(allow default)", "(deny file-write*)", '(allow file-write* (subpath "/dev"))', "(deny network*)", "(deny process-fork)"]
  if (input.hidden.length) lines.push(`(deny file-read-data ${input.hidden.map((root) => `(subpath ${seatbeltString(root)})`).join(" ")})`)
  const allowed = [...input.readable.map((file) => `(literal ${seatbeltString(file)})`), ...input.readableTrees.map((tree) => `(subpath ${seatbeltString(tree)})`)]
  if (allowed.length) lines.push(`(allow file-read-data ${allowed.join(" ")})`)
  return lines.join("\n")
}

/**
 * bubblewrap arguments: read-only root, hidden roots replaced by empty tmpfs, nothing writable, no network, own pid/ipc namespaces.
 * bubblewrap applies its arguments in order, so the list is built as: (1) the read-only root, (2) one empty tmpfs per OUTERMOST
 * hidden root that exists (a hidden root inside another one, such as a per-run data directory under /tmp, is already empty inside
 * the parent's tmpfs, and mounting it first would bury it under the parent's tmpfs, which is what made `--remount-ro` fail with
 * "realpath(destination): No such file"), (3) the host's own files bound read-only at their own path inside those tmpfs (bwrap
 * creates the parent directories; only listed paths appear), (4) `--remount-ro` on each tmpfs from (2), which exist at that point
 * and are never nested in one another. A tmpfs is writable, so without (4) a write into a hidden root would succeed into memory
 * the watchdog does not measure. `readable` entries outside every hidden root are already visible through the root bind and are
 * not bound again.
 */
export function scriptBwrapArguments(input: { hidden: readonly string[]; readable: readonly string[]; exists?: (file: string) => boolean }): string[] {
  const exists = input.exists ?? existsSync
  const args = ["--die-with-parent", "--new-session", "--unshare-user", "--unshare-pid", "--unshare-net", "--unshare-ipc", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc"]
  const roots = outermostRoots(input.hidden.filter((root) => exists(root)))
  for (const root of roots) args.push("--tmpfs", root)
  for (const file of [...new Set(input.readable)]) if (exists(file) && roots.some((root) => isInside(file, root))) args.push("--ro-bind", file, file)
  for (const root of roots) args.push("--remount-ro", root)
  args.push("--chdir", "/")
  return args
}

const isInside = (file: string, root: string) => file === root || file.startsWith(root.endsWith("/") ? root : `${root}/`)

/** The roots no other root contains, each once. */
export function outermostRoots(roots: readonly string[]): string[] {
  const unique = [...new Set(roots.map((root) => path.posix.normalize(root).replace(/(.)\/$/, "$1")))]
  return unique.filter((root) => !unique.some((other) => other !== root && isInside(root, other)))
}

export type ScriptHostLaunch = { argv: string[]; isolation: "seatbelt" | "bwrap" | "none"; readable: string[] }

/** The command line of a host: how to start the host code (binary or dev source) wrapped in the sandbox. Throws when no sandbox exists and the user did not allow running without one. */
export function scriptHostLaunch(input: { dir: string; directory: string; home?: string | undefined; backend?: SandboxBackend | null; command?: string[]; env?: Record<string, string | undefined>; /** Tests: extra files the command reads. */ readable?: string[] }): ScriptHostLaunch {
  const compiled = BUNFS.test(Bun.main)
  const hostFile = path.join(import.meta.dir, "../../workflows/src/script-host.ts")
  const command = input.command ?? (compiled ? [process.execPath, "__script-host"] : [process.execPath, hostFile])
  const exec = real(process.execPath)
  const hostFiles = [exec, process.execPath, ...(input.readable ?? []).flatMap((file) => [file, real(file)]), ...(compiled || input.command ? [] : [real(hostFile)])]
  // Seatbelt reads a literal directory as its listing only, so the parents of the extra files are allowed for it; bubblewrap binds a directory whole, so it gets the files alone.
  const readable = [...hostFiles, ...(input.readable ?? []).map((file) => path.dirname(real(file)))]
  const trees = compiled || input.command ? [] : [real(path.dirname(hostFile))]
  const hidden = hiddenRoots({ home: input.home, dir: input.dir, directory: input.directory })
  const backend = input.backend === undefined ? sandboxBackend() : input.backend
  const env = input.env ?? process.env
  if (!backend) {
    if (env.MENDCODE_SCRIPT_UNSANDBOXED !== "1") throw new Error("this system has no OS sandbox (macOS sandbox-exec or Linux bwrap), and workflow scripts only run inside one; set MENDCODE_SCRIPT_UNSANDBOXED=1 to run them with process isolation alone")
    return { argv: command, isolation: "none", readable }
  }
  if (backend.name === "seatbelt") return { argv: [backend.binary, "-p", scriptSeatbeltProfile({ hidden, readable, readableTrees: trees }), ...command], isolation: "seatbelt", readable }
  return { argv: [backend.binary, ...scriptBwrapArguments({ hidden, readable: [...hostFiles, ...trees] }), "--", ...command], isolation: "bwrap", readable }
}

/**
 * What to tell the user when the OS sandbox itself does not start: how to check it by hand and what to do about it. The
 * bubblewrap profile is written against its documentation and unit tested, but was not run on Linux by its authors.
 */
export function sandboxFailure(isolation: "seatbelt" | "bwrap", binary: string, detail: string): string {
  const how = isolation === "bwrap"
    ? `Check it by hand: ${binary} --unshare-user --unshare-pid --unshare-net --ro-bind / / true. If that fails, install bubblewrap (apt install bubblewrap) and allow unprivileged user namespaces (Ubuntu 24.04 and later: sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0). The bubblewrap profile has not been verified on Linux by its authors`
    : `Check it by hand: ${binary} -p '(version 1)(allow default)' /usr/bin/true`
  return `the OS sandbox (${isolation}) did not start the script host: ${detail.trim().split("\n")[0]?.slice(0, 200) || "no output"}. ${how}. To run scripts with process isolation alone (weaker), set MENDCODE_SCRIPT_UNSANDBOXED=1.`
}

type ChildProcess = ReturnType<typeof Bun.spawn>

/**
 * Resident memory in KiB of `root` and every process below it, from the output of `ps -A -o pid=,ppid=,rss=` (one `pid ppid rss`
 * row per process), or undefined when `root` is not in the table. The host the daemon spawned is not always the process that runs
 * the script: under bubblewrap it is `bwrap`, a few MB that forks the sandbox's init, which forks the script host, so the memory of
 * the script lives in a descendant and measuring `root` alone never sees a heap bomb.
 */
export function treeResidentKib({ table, root }: { table: string; root: number }): number | undefined {
  const rss = new Map<number, number>()
  const children = new Map<number, number[]>()
  for (const line of table.split("\n")) {
    const [pid, ppid, kib] = line.trim().split(/\s+/).map((field) => Number.parseInt(field, 10))
    if (pid === undefined || ppid === undefined || kib === undefined || !Number.isSafeInteger(pid) || !Number.isSafeInteger(ppid) || !Number.isFinite(kib)) continue
    rss.set(pid, kib)
    children.set(ppid, [...(children.get(ppid) ?? []), pid])
  }
  if (!rss.has(root)) return undefined
  let total = 0
  const seen = new Set<number>()
  const pending = [root]
  for (let pid = pending.pop(); pid !== undefined; pid = pending.pop()) {
    if (seen.has(pid)) continue
    seen.add(pid)
    total += rss.get(pid) ?? 0
    pending.push(...(children.get(pid) ?? []))
  }
  return total
}

/** Resident memory of a process and everything it started, in KiB, or undefined when it cannot be read. */
async function residentKib(pid: number): Promise<number | undefined> {
  try {
    const child = Bun.spawn(["/bin/ps", "-A", "-o", "pid=", "-o", "ppid=", "-o", "rss="], { stdout: "pipe", stderr: "ignore", stdin: "ignore", env: { PATH: "/usr/bin:/bin" } })
    const text = await new Response(child.stdout).text()
    await child.exited
    return treeResidentKib({ table: text, root: pid })
  } catch {
    return undefined
  }
}

export function createProcessScriptHost(options: { dir: string; limits?: Partial<ScriptHostLimits>; home?: string | undefined; backend?: SandboxBackend | null; command?: string[]; env?: Record<string, string | undefined>; readable?: string[] }): ScriptHostPort & { describe(directory: string): { isolation: ScriptHostLaunch["isolation"]; limits: ScriptHostLimits }; verify(directory: string): Promise<string | undefined> } {
  const limits = { ...DEFAULT_SCRIPT_LIMITS, ...options.limits }
  const home = options.home ?? os.homedir()
  const launch = (directory: string, probe?: string[]) => scriptHostLaunch({ dir: options.dir, directory, home, ...(options.backend !== undefined ? { backend: options.backend } : {}), ...(probe ? { command: probe, readable: probe } : options.command ? { command: options.command } : {}), ...(options.env ? { env: options.env } : {}), ...(!probe && options.readable ? { readable: options.readable } : {}) })
  const port: ReturnType<typeof createProcessScriptHost> = {
    describe(directory: string) {
      try {
        return { isolation: launch(directory).isolation, limits }
      } catch {
        return { isolation: "none", limits }
      }
    },
    /** Runs `true` under the same sandbox wrapper: undefined when the sandbox works (or there is none), otherwise the message that says how to check it. */
    async verify(directory: string): Promise<string | undefined> {
      const probe = launch(directory, ["/usr/bin/true"])
      if (probe.isolation === "none") return undefined
      try {
        const child = Bun.spawn(probe.argv, { cwd: "/", env: { PATH: "/usr/bin:/bin" }, stdin: "ignore", stdout: "ignore", stderr: "pipe" })
        const timer = setTimeout(() => child.kill(9), 5_000)
        const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
        clearTimeout(timer)
        return code === 0 ? undefined : sandboxFailure(probe.isolation, probe.argv[0]!, stderr || `exited with code ${code}`)
      } catch (error) {
        return sandboxFailure(probe.isolation, probe.argv[0]!, error instanceof Error ? error.message : String(error))
      }
    },
    start(input: ScriptHostInput) {
      const launched = launch(input.directory)
      const { argv } = launched
      let spawned: ChildProcess
      try {
        spawned = Bun.spawn(argv, {
          cwd: "/",
          env: { PATH: "/usr/bin:/bin", NO_COLOR: "1", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" },
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        })
      } catch (error) {
        if (launched.isolation === "none") throw error
        throw new Error(sandboxFailure(launched.isolation, argv[0]!, error instanceof Error ? error.message : String(error)))
      }
      const child = spawned
      let received = false
      let killReason: string | undefined
      let exited = false
      let lastBeat = Date.now()
      let stderr = ""
      const stdin = child.stdin as { write(data: string): unknown; flush(): unknown; end(): unknown }
      const send = (message: Record<string, unknown>) => {
        if (exited) return
        try {
          stdin.write(`${JSON.stringify(message)}\n`)
          stdin.flush()
        } catch {}
      }
      const kill = (reason: string) => {
        killReason ??= reason
        try {
          child.kill(9)
        } catch {}
      }
      void (async () => {
        const decoder = new TextDecoder()
        let buffer = ""
        for await (const chunk of child.stdout as ReadableStream<Uint8Array>) {
          buffer += decoder.decode(chunk, { stream: true })
          if (buffer.length > MAX_LINE && !buffer.includes("\n")) return void kill("the script wrote a message larger than 4 MiB")
          for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
            const line = buffer.slice(0, newline)
            buffer = buffer.slice(newline + 1)
            if (!line.trim()) continue
            let message: unknown
            try {
              message = JSON.parse(line)
            } catch {
              continue
            }
            if (typeof message !== "object" || message === null || Array.isArray(message)) continue
            lastBeat = Date.now()
            received = true
            if ((message as { t?: unknown }).t === "hb") continue
            input.onMessage(message as Record<string, unknown>)
          }
        }
      })()
      void (async () => {
        for await (const chunk of child.stderr as ReadableStream<Uint8Array>) if (stderr.length < MAX_STDERR) stderr += new TextDecoder().decode(chunk)
      })()
      const watchdog = setInterval(() => {
        if (exited) return
        if (Date.now() - lastBeat > limits.silenceMs) return kill(`no heartbeat for ${Math.round(limits.silenceMs / 1000)} s: the script never yields (a loop without await)`)
        void residentKib(child.pid).then((kib) => {
          if (!exited && kib !== undefined && kib > limits.heapMb * 1024) kill(`memory limit exceeded (${Math.round(kib / 1024)} MB of ${limits.heapMb} MB)`)
        })
      }, limits.pollMs)
      void child.exited.then(async (code) => {
        exited = true
        clearInterval(watchdog)
        let reason = killReason ?? `exited with code ${code}${stderr.trim() ? `: ${stderr.trim().split("\n").slice(-3).join(" ").slice(0, 300)}` : ""}`
        // A host that died before saying anything under an OS sandbox may be the sandbox failing: check it, and say how to verify it by hand.
        if (!killReason && !received && code !== 0 && launched.isolation !== "none") reason = (await port.verify(input.directory)) ?? reason
        input.onExit({ reason })
      })
      send({ t: "init", body: input.body, meta: input.meta, args: input.args, seed: input.seed, now: input.now })
      return { send, kill }
    },
  }
  return port
}
