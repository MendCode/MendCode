import path from "node:path"
import { realpathSync } from "node:fs"
import { UpgradeError } from "./errors"
import type { UpgradeFs } from "./ports"
import { BIN_NAME, EXECUTABLE_MODE } from "./settings"
import { PROGRAM_NAME } from "@mendcode/program"

export function binPaths(dataDir: string) {
  const dir = path.join(dataDir, "bin")
  return { dir, current: path.join(dir, BIN_NAME), next: path.join(dir, `${BIN_NAME}.new`), prev: path.join(dir, `${BIN_NAME}.prev`) }
}

const within = (parent: string, child: string) => {
  const relative = path.relative(parent, child)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

/** Legacy MendCode locations; an upgrade never writes to or under them. */
export const v1Dirs = (home: string) => [path.join(home, ".mendcode"), path.join(home, ".local", "share", "mendcode")]

/** The absolute data directory, or a refusal when it is (inside) a legacy MendCode directory. */
export function resolveDataDir({ dataDir, home }: { dataDir: string; home: string }) {
  const resolved = path.resolve(dataDir)
  const canonical = (file: string): string => {
    try { return realpathSync(file) } catch {
      const parent = path.dirname(file)
      return parent === file ? file : path.join(canonical(parent), path.basename(file))
    }
  }
  if (v1Dirs(home).some((v1) => within(v1, resolved) || within(canonical(v1), canonical(resolved)))) throw new UpgradeError("bad-data-dir", `${resolved} belongs to legacy MendCode; ${PROGRAM_NAME} never writes there`)
  return resolved
}

async function guarded<T>(step: string, run: () => Promise<T>) {
  try {
    return await run()
  } catch (error) {
    if (error instanceof UpgradeError) throw error
    throw new UpgradeError("io", `${step}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Stages the binary as `mendcode-next.new`, keeps the running one as `.prev` and renames the new one over
 * `mendcode-next`. The command exists with complete content at every moment; a failure leaves it untouched.
 */
export async function installBinary({ fs, dataDir, bytes }: { fs: UpgradeFs; dataDir: string; bytes: Uint8Array }) {
  const paths = binPaths(dataDir)
  await guarded("cannot create the bin directory", () => fs.mkdir(paths.dir))
  try {
    await guarded("cannot stage the new binary", async () => {
      await fs.writeFile(paths.next, bytes)
      await fs.chmod(paths.next, EXECUTABLE_MODE)
    })
    await guarded("cannot keep the previous binary", async () => {
      if (!(await fs.exists(paths.current))) return
      await fs.copyFile(paths.current, paths.prev)
      await fs.chmod(paths.prev, EXECUTABLE_MODE)
    })
    await guarded("cannot install the new binary", () => fs.rename(paths.next, paths.current))
  } catch (error) {
    await fs.remove(paths.next).catch(() => undefined)
    throw error
  }
  return paths.current
}

/** Swaps `mendcode-next` and `.prev`, so a second rollback goes forward again. */
export async function rollbackBinary({ fs, dataDir }: { fs: UpgradeFs; dataDir: string }) {
  const paths = binPaths(dataDir)
  if (!(await fs.exists(paths.prev))) throw new UpgradeError("no-previous", `nothing to roll back: ${paths.prev} does not exist`)
  try {
    await guarded("cannot roll back", async () => {
      const hadCurrent = await fs.exists(paths.current)
      if (hadCurrent) await fs.copyFile(paths.current, paths.next)
      await fs.rename(paths.prev, paths.current)
      if (hadCurrent) await fs.rename(paths.next, paths.prev)
    })
  } catch (error) {
    await fs.remove(paths.next).catch(() => undefined)
    throw error
  }
  return paths.current
}
