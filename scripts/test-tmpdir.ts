/**
 * Test preload: every `bun test` process gets its own temporary directory (`$TMPDIR/mc-test-<pid>-…`) and removes it when it exits, so the
 * directories tests make with mkdtemp and forget (hundreds of files do) never pile up in the real one. Child processes a test starts
 * inherit it. A process that was killed leaves its directory; the next test process removes the ones whose pid is gone.
 */
import { mkdirSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const PREFIX = "mendtest-"
// A short base: tests that print or budget a temporary path (prompts, wrapped rows) must see one no longer than the system's own.
const real = process.env.MENDCODE_TEST_TMP_BASE ?? (process.platform === "darwin" ? "/private/tmp" : tmpdir())

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (failure) {
    return (failure as NodeJS.ErrnoException).code === "EPERM"
  }
}

// Directories of killed test processes; the pid is in the name. Bounded, and only this exact prefix.
try {
  for (const name of readdirSync(real).filter((entry) => entry.startsWith(PREFIX)).slice(0, 200)) {
    const pid = Number(/^(\d+)$/.exec(name.slice(PREFIX.length))?.[1])
    if (Number.isInteger(pid) && pid !== process.pid && !alive(pid)) rmSync(path.join(real, name), { recursive: true, force: true })
  }
} catch {}

if (!process.env.MENDCODE_TEST_KEEP_TMPDIR) {
  try {
    // The pid is unique among live processes; a directory left by a killed process with the same pid is reused and removed at exit.
    const scratch = path.join(real, `${PREFIX}${process.pid}`)
    mkdirSync(scratch, { recursive: true })
    process.env.TMPDIR = scratch
    process.on("exit", () => {
      try { rmSync(scratch, { recursive: true, force: true }) } catch {}
    })
  } catch {}
}
