/**
 * Preloaded into every `bun test` run (bunfig.toml): the tests cannot signal anything outside the processes they spawned.
 *
 * A signal that reaches the test runner's own group, the runner itself, its parent (the CI step's shell, a developer's terminal) or
 * every process the user owns would end the whole run, or a developer's session, without a test failing. So `process.kill` refuses
 * pid 0 and -1 (whole groups), pid 1, a pid that is not a whole number (`NaN` is how an unparsed pid file turns into 0 in some
 * runtimes), this process and its parent, and a negative pid (a process group) that is not the group of a child this run spawned.
 * A refusal throws EPERM, the error the product code already handles by falling back to signalling the child it holds. Signal 0
 * (is it alive) is never refused. Positive pids other than those above stay allowed: tests read the pid of the daemon they started
 * from its ready line or its lock file and stop it.
 */
import childProcess from "node:child_process"

/** Why a test may not send a signal to `pid`, or undefined when it may. `spawned` holds the pids of the children this run started. */
export function refuseSignal({ pid, signal, self = process.pid, parent = process.ppid, spawned }: { pid: unknown; signal: unknown; self?: number; parent?: number; spawned: ReadonlySet<number> }): string | undefined {
  if (signal === 0 || signal === "0") return undefined
  if (typeof pid !== "number" || !Number.isSafeInteger(pid)) return `${String(pid)} is not a whole number`
  if (pid === 0) return "pid 0 is this process's whole group"
  if (pid === -1) return "pid -1 is every process the user owns"
  if (pid === 1) return "pid 1 is init"
  if (pid === self || pid === parent) return `pid ${pid} is the test runner${pid === parent ? "'s parent" : ""}`
  if (pid < 0 && !spawned.has(-pid)) return `${-pid} is not the process group of a child this run spawned`
  return undefined
}

type SpawnLike = (...args: unknown[]) => { pid?: number | undefined }

/** Wraps `target[name]` so every child it returns is recorded in `spawned`. */
function recordSpawns({ target, name, spawned }: { target: Record<string, unknown>; name: string; spawned: Set<number> }) {
  const original = target[name] as SpawnLike | undefined
  if (typeof original !== "function") return
  target[name] = function (this: unknown, ...args: unknown[]) {
    const child = original.apply(this, args)
    if (child?.pid) spawned.add(child.pid)
    return child
  }
}

/** Installs the guard on `process.kill`; `spawned` is filled by the wrapped spawn functions. */
export function installKillGuard({ spawned = new Set<number>(), proc = process }: { spawned?: Set<number>; proc?: Pick<typeof process, "kill" | "pid" | "ppid"> } = {}) {
  const real = proc.kill.bind(proc)
  proc.kill = ((pid: number, signal?: string | number) => {
    const reason = refuseSignal({ pid, signal, self: proc.pid, parent: proc.ppid, spawned })
    if (reason) throw Object.assign(new Error(`[TEST]: refused to signal ${String(pid)}: ${reason}`), { code: "EPERM", syscall: "kill" })
    return real(pid, signal)
  }) as typeof process.kill
  return spawned
}

const marker = globalThis as { __mendcodeKillGuard?: boolean }
if (!marker.__mendcodeKillGuard) {
  marker.__mendcodeKillGuard = true
  const spawned = installKillGuard()
  recordSpawns({ target: Bun as unknown as Record<string, unknown>, name: "spawn", spawned })
  recordSpawns({ target: childProcess as unknown as Record<string, unknown>, name: "spawn", spawned })
}
