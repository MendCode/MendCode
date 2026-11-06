// Per-process resource readings for the perf scripts, next to `ps` RSS (docs/performance.md).
// macOS: `proc_pid_rusage(RUSAGE_INFO_V4)` through bun:ffi gives the physical footprint (what the process owns, without the
// binary's shared clean code pages that RSS counts), its lifetime peak, and user plus system CPU time. Linux: RSS and CPU
// from `/proc`; footprint is not available there and stays undefined. Elsewhere, `ps`. Nothing is installed or spawned on macOS or Linux.
const MB = 1048576

export type ProcessStats = {
  /** Resident set size in MB (what `ps -o rss` shows). */
  rssMB: number
  /** macOS physical footprint in MB; undefined where the platform does not report it. */
  footprintMB?: number
  /** Highest physical footprint the process has had in its lifetime, MB. */
  peakFootprintMB?: number
  /** User plus system CPU time consumed so far, ms. */
  cpuMs: number
}

type Reader = (pid: number) => ProcessStats | undefined

function darwinReader(): Reader | undefined {
  try {
    const { dlopen, FFIType, ptr } = require("bun:ffi") as typeof import("bun:ffi")
    const proc = dlopen("/usr/lib/libproc.dylib", { proc_pid_rusage: { args: [FFIType.i32, FFIType.i32, FFIType.ptr], returns: FFIType.i32 } })
    const sys = dlopen("/usr/lib/libSystem.B.dylib", { mach_timebase_info: { args: [FFIType.ptr], returns: FFIType.i32 } })
    const timebase = new Uint32Array(2)
    sys.symbols.mach_timebase_info(ptr(timebase))
    const nanosPerTick = timebase[0]! / (timebase[1] || 1)
    const buffer = new BigUint64Array(64)
    // rusage_info_v4 (flavor 6), 8-byte fields: [2] ri_user_time, [3] ri_system_time, [8] ri_resident_size, [9] ri_phys_footprint, [30] ri_lifetime_max_phys_footprint.
    return (pid) => {
      if (proc.symbols.proc_pid_rusage(pid, 6, ptr(buffer)) !== 0) return undefined
      return {
        rssMB: +(Number(buffer[8]) / MB).toFixed(1),
        footprintMB: +(Number(buffer[9]) / MB).toFixed(1),
        peakFootprintMB: +(Number(buffer[30]) / MB).toFixed(1),
        cpuMs: +((Number(buffer[2]) + Number(buffer[3])) * nanosPerTick / 1e6).toFixed(1),
      }
    }
  } catch { return undefined }
}

/** `ps` time field (`[dd-][hh:]mm:ss.cc`) in ms. */
export function parsePsTime(text: string): number {
  const [days, rest] = text.includes("-") ? text.split("-") as [string, string] : ["0", text]
  const parts = rest.split(":").map(Number)
  while (parts.length < 3) parts.unshift(0)
  return Math.round((((Number(days) * 24 + parts[0]!) * 60 + parts[1]!) * 60 + parts[2]!) * 1000)
}

function psReader(pid: number): ProcessStats | undefined {
  const out = Bun.spawnSync(["ps", "-o", "rss=,time=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" }).stdout.toString().trim().split(/\s+/)
  if (out.length < 2 || !Number.isFinite(Number(out[0]))) return undefined
  return { rssMB: +(Number(out[0]) / 1024).toFixed(1), cpuMs: parsePsTime(out[1]!) }
}

/** Linux: RSS from `/proc/<pid>/status` and CPU from `/proc/<pid>/stat` in clock ticks (USER_HZ, 100 on Linux), finer than `ps -o time`'s whole seconds. */
function linuxReader(pid: number): ProcessStats | undefined {
  try {
    const { readFileSync } = require("node:fs") as typeof import("node:fs")
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
    // Fields after the command name, which sits in parentheses and may hold spaces: utime and stime are fields 14 and 15.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ")
    const rssKB = Number(/^VmRSS:\s+(\d+)/m.exec(readFileSync(`/proc/${pid}/status`, "utf8"))?.[1])
    const ticks = Number(fields[11]) + Number(fields[12])
    if (!Number.isFinite(rssKB) || !Number.isFinite(ticks)) return undefined
    return { rssMB: +(rssKB / 1024).toFixed(1), cpuMs: ticks * 10 }
  } catch { return undefined }
}

const native: Reader | undefined = process.platform === "darwin" ? darwinReader() : process.platform === "linux" ? linuxReader : undefined

/** Readings of a live process, or undefined when it is gone. */
export function processStats(pid: number): ProcessStats | undefined {
  return native?.(pid) ?? psReader(pid)
}

/** The median of a list of numbers (the lower middle for an even count), and the range, for A/B tables. */
export function spread(values: readonly number[]) {
  const sorted = [...values].sort((a, b) => a - b)
  return { median: sorted[Math.floor((sorted.length - 1) / 2)] ?? 0, min: sorted[0] ?? 0, max: sorted.at(-1) ?? 0 }
}
