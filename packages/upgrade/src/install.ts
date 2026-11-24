import path from "node:path"
import { realpathSync } from "node:fs"
import { sha256Hex } from "./checksum"
import { UpgradeError } from "./errors"
import { INSTALL_RECEIPT, LEGACY_INSTALL_RECEIPT, parseInstallReceipt } from "./install-receipt"
import type { UpgradeFs } from "./ports"
import { BIN_NAME, EXECUTABLE_MODE } from "./settings"
import { PROGRAM_NAME } from "@mendcode/program"

export function binPaths(dataDir: string) {
  const dir = path.join(dataDir, "bin")
  return { dir, current: path.join(dir, BIN_NAME), next: path.join(dir, `${BIN_NAME}.new`), prev: path.join(dir, `${BIN_NAME}.prev`) }
}

/** The name the managed executables had before (`bin/mendcode-next`, `.prev`); an install from then is moved to the new names. */
export const LEGACY_BIN_NAME = "mendcode-next"

/** Moves an install's old executables to the new names, once, unless a file already has the new name. Runs under the upgrade lock. */
export async function adoptLegacyBin(fs: UpgradeFs, dataDir: string) {
  const paths = binPaths(dataDir)
  for (const [from, to] of [[path.join(paths.dir, LEGACY_BIN_NAME), paths.current], [path.join(paths.dir, `${LEGACY_BIN_NAME}.prev`), paths.prev]] as const) {
    if (await fs.exists(from) && !await fs.exists(to)) await fs.rename(from, to)
  }
}

const within = (parent: string, child: string) => {
  const relative = path.relative(parent, child)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

/** MendCode v1's locations (set aside in `~/.mendcode-v1` when `~/.mendcode` became this version's folder); an upgrade never writes to or under them. */
export const v1Dirs = (home: string) => [path.join(home, ".mendcode-v1"), path.join(home, ".local", "share", "mendcode")]

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
 * Stages the binary as `mendcode.new`, keeps the running one as `.prev` and renames the new one over
 * `mendcode`. The command exists with complete content at every moment; a failure leaves it untouched.
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

/** What `install.ps1` calls the program: the executable is `<install dir>\mendcode.exe` and the replaced one waits beside it as `mendcode.exe.old`. */
export const WINDOWS_EXE = "mendcode.exe"
export const replacedExecutable = (executable: string) => `${executable}.old`

/**
 * The executable `upgrade` replaces on Windows: the running program when it is the compiled `mendcode.exe`, else the install
 * directory of `install.ps1` (`MENDCODE_INSTALL_DIR`, else `%LOCALAPPDATA%\Programs\mendcode`). Undefined when neither is known.
 */
export function windowsInstallPath({ runningBinary, env }: { runningBinary?: string | undefined; env: Record<string, string | undefined> }) {
  if (runningBinary) return runningBinary
  const dir = env.MENDCODE_INSTALL_DIR || (env.LOCALAPPDATA ? path.win32.join(env.LOCALAPPDATA, "Programs", "mendcode") : undefined)
  return dir ? path.win32.join(dir, WINDOWS_EXE) : undefined
}

/**
 * Replaces `target` with `bytes` the way Windows allows while the program runs: a running executable can be renamed but not
 * overwritten or deleted. The new file is staged beside it and its digest read back, the running one is renamed to `.old`
 * (removed at the next start of the new program), then the staged file takes its name. When the second rename fails the
 * first is undone, so `target` is always a complete program.
 */
export async function installWindowsBinary({ fs, target, bytes, sha256 }: { fs: UpgradeFs; target: string; bytes: Uint8Array; sha256: string }) {
  const staged = `${target}.new`
  const old = replacedExecutable(target)
  let aside = false
  try {
    await guarded("cannot create the install directory", () => fs.mkdir(path.dirname(target)))
    await guarded("cannot stage the new executable", () => fs.writeFile(staged, bytes))
    const onDisk = await guarded("cannot read back the staged executable", () => fs.readBytes(staged))
    if (sha256Hex(onDisk) !== sha256) throw new UpgradeError("checksum-mismatch", `the staged ${path.basename(target)} does not match the verified SHA256; nothing was replaced`)
    if (await fs.exists(target)) {
      await guarded(`cannot clear ${old}: a program replaced earlier is still running, close it and run upgrade again`, () => fs.remove(old))
      await guarded(`cannot move ${target} aside`, () => fs.rename(target, old))
      aside = true
    }
    await guarded("cannot put the new executable in place", () => fs.rename(staged, target))
  } catch (error) {
    if (aside) {
      try { await fs.rename(old, target) } catch (restore) {
        throw new UpgradeError("io", `${error instanceof Error ? error.message : String(error)}; restoring the previous program failed too (${restore instanceof Error ? restore.message : String(restore)}): it is at ${old}`)
      }
    }
    await fs.remove(staged).catch(() => undefined)
    throw error
  }
  return target
}

/** The installer's receipt beside `target` names the digest of the program; `uninstall` checks it, so a replaced program gets its new one (the tier stays). */
export async function refreshInstallReceipt({ fs, target, sha256 }: { fs: UpgradeFs; target: string; sha256: string }) {
  const dir = path.dirname(target)
  const current = path.join(dir, INSTALL_RECEIPT)
  const legacy = path.join(dir, LEGACY_INSTALL_RECEIPT)
  const text = (await fs.readText(current)) ?? (await fs.readText(legacy))
  const receipt = text === undefined ? undefined : parseInstallReceipt(text)
  if (!receipt || receipt.binary !== WINDOWS_EXE) return false
  await fs.writeFile(`${current}.tmp`, new TextEncoder().encode(`schema=mendcode.install.v1\nbinary=${WINDOWS_EXE}\nsha256=${sha256}\n${receipt.tier ? `tier=${receipt.tier}\n` : ""}`))
  await fs.rename(`${current}.tmp`, current)
  await fs.remove(legacy)
  return true
}

/** Swaps `mendcode` and `.prev`, so a second rollback goes forward again. */
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
