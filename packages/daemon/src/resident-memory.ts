// Resident set size as `ps -o rss` reports it. Bun 1.4 on macOS returns the physical footprint as `process.memoryUsage().rss`,
// which leaves out the shared clean pages RSS counts; on Linux and Windows `process.memoryUsage().rss` is still the RSS.
// The macOS reader (`proc_pid_rusage`, RUSAGE_INFO_V4, field 8 `ri_resident_size`) is loaded on the first call, not at start.

type ResidentReader = (pid: number) => number | undefined

let darwinReader: ResidentReader | null | undefined

function loadDarwinReader(): ResidentReader | null {
  try {
    const { dlopen, FFIType, ptr } = require("bun:ffi") as typeof import("bun:ffi")
    const proc = dlopen("/usr/lib/libproc.dylib", { proc_pid_rusage: { args: [FFIType.i32, FFIType.i32, FFIType.ptr], returns: FFIType.i32 } })
    const buffer = new BigUint64Array(64)
    return (pid) => proc.symbols.proc_pid_rusage(pid, 6, ptr(buffer)) === 0 ? Number(buffer[8]) : undefined
  } catch {
    return null
  }
}

/** Resident set size of this process in bytes, the number `ps -o rss` shows on every platform. */
export function residentBytes(): number {
  if (process.platform === "darwin") {
    if (darwinReader === undefined) darwinReader = loadDarwinReader()
    const bytes = darwinReader?.(process.pid)
    if (bytes !== undefined) return bytes
  }
  return process.memoryUsage().rss
}

/** `process.memoryUsage()` with `rss` read as `ps` reads it. */
export function residentMemoryUsage(): NodeJS.MemoryUsage {
  return { ...process.memoryUsage(), rss: residentBytes() }
}
