import { readdirSync, readFileSync } from "node:fs"
import { isSignalablePid } from "@mendcode/tools"

/**
 * A process the daemon started for the model is `sh -c "<command>"`, and the program the model cares about may be its child, not the
 * shell itself: dash (Ubuntu's /bin/sh) keeps running as the parent when the command is not a lone simple command, bash and zsh
 * usually replace themselves with it. A signal sent to the shell alone then never reaches the program, and a kill leaves it running
 * with nobody to read its output. The process group is no help either: a child started with a pseudo-terminal is not the leader of a
 * group of its own (observed on macOS: its pgid is its parent's). So a signal or a kill goes to the process and everything below it.
 */

/** The parent pid in a `/proc/<pid>/stat` line (`pid (comm) state ppid …`; comm may hold spaces and parentheses, so fields are counted after the last `)`). */
export function parentFromProcStat(stat: string): number | undefined {
  const parent = Number.parseInt(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1] ?? "", 10)
  return Number.isSafeInteger(parent) ? parent : undefined
}

/** `pid ppid` pairs of every process on the machine, one `pid ppid` row per line; empty when the platform gives no table. */
export function processTable(platform: string = process.platform): string {
  try {
    if (platform === "linux") {
      const rows: string[] = []
      for (const name of readdirSync("/proc")) {
        if (!/^\d+$/.test(name)) continue
        try {
          rows.push(`${name} ${parentFromProcStat(readFileSync(`/proc/${name}/stat`, "utf8")) ?? ""}`)
        } catch { /* the process ended while the table was read */ }
      }
      return rows.join("\n")
    }
    if (platform === "win32") return ""
    const child = Bun.spawnSync(["ps", "-A", "-o", "pid=", "-o", "ppid="], { stdout: "pipe", stderr: "ignore", stdin: "ignore", env: { PATH: "/usr/bin:/bin" } })
    return child.stdout.toString()
  } catch {
    return ""
  }
}

/** Every process below `pid` in a `pid ppid` table (not `pid` itself), children before their parents. A cycle in the table ends the walk. */
export function descendantsOf({ table, pid }: { table: string; pid: number }): number[] {
  const children = new Map<number, number[]>()
  for (const line of table.split("\n")) {
    const [child, parent] = line.trim().split(/\s+/).map((field) => Number.parseInt(field, 10))
    if (child === undefined || parent === undefined || !Number.isSafeInteger(child) || !Number.isSafeInteger(parent)) continue
    children.set(parent, [...(children.get(parent) ?? []), child])
  }
  const order: number[] = []
  const seen = new Set<number>([pid])
  const visit = (parent: number) => {
    for (const child of children.get(parent) ?? []) {
      if (seen.has(child)) continue
      seen.add(child)
      visit(child)
      order.push(child)
    }
  }
  visit(pid)
  return order
}

/**
 * Sends `signal` to `pid` and every process below it. The tree is read before anything is signalled, so a parent that dies first
 * cannot hide its children. Pids that cannot be a child of ours (`isSignalablePid`) are skipped; a process that is already gone is not an error.
 * Returns the pids signalled.
 */
export function signalTree({ pid, signal, table = processTable(), send = (target: number, name: NodeJS.Signals) => process.kill(target, name) }: { pid: number; signal: NodeJS.Signals; table?: string; send?: (pid: number, signal: NodeJS.Signals) => void }): number[] {
  const targets = [...descendantsOf({ table, pid }), pid].filter((target) => isSignalablePid(target))
  const signalled: number[] = []
  for (const target of targets) {
    try {
      send(target, signal)
      signalled.push(target)
    } catch { /* already gone, or not ours */ }
  }
  return signalled
}
