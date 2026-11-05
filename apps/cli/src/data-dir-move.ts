import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { dataDirFromEnv, moveLegacyDataDir, stopStandaloneDaemon, type DataDirMove } from "@mendcode/program/data-dir"

/**
 * Runs before anything opens the data directory (entry.ts): moves `~/.mendcode-v2` to `~/.mendcode` once, on the first start of a
 * version that uses the new name. A daemon of the earlier version is stopped first (running turns end as interrupted and resume),
 * and an installed user service is pointed at the new path. Nothing moves when `--dir` or a variable names the directory, or under
 * `bun test` (a test opts in with `MENDCODE_TEST_DATA_DIR_MOVE=1`). A move that cannot happen now is tried again on the next start.
 */
export async function moveDataDirAtStart(argv: readonly string[] = process.argv, env: Readonly<Record<string, string | undefined>> = process.env, home = homedir()): Promise<DataDirMove | undefined> {
  if (argv.some((arg) => arg === "--dir" || arg.startsWith("--dir="))) return undefined
  if (dataDirFromEnv(env)) return undefined
  if (env.NODE_ENV === "test" && env.MENDCODE_TEST_DATA_DIR_MOVE !== "1") return undefined
  if (!existsSync(path.join(home, ".mendcode-v2"))) return undefined
  let service: { rebind(newDir: string): Promise<void> } | undefined
  const result = await moveLegacyDataDir({
    home,
    stopDaemon: (dir) => stopStandaloneDaemon(dir),
    beforeMove: async (oldDir) => { service = await stopUserService(oldDir, home) },
    afterMove: async (_oldDir, newDir) => { await service?.rebind(newDir) },
  })
  if (result.moved) process.stderr.write(`MendCode keeps its data in ${path.join(home, ".mendcode")} now (moved from ~/.mendcode-v2, which still points to it).${result.v1Aside ? ` What MendCode v1 kept there is in ${result.v1Aside}.` : ""}\n`)
  else if (result.reason === "failed") process.stderr.write(`MendCode could not move ~/.mendcode-v2 to ~/.mendcode (${result.detail}); it keeps using ~/.mendcode-v2 and tries again next start.\n`)
  return result
}

/**
 * An installed user service bound to the old directory is stopped (launchd or systemd would restart its daemon on the old path),
 * and after the move its binding and definition name the new one; it is started again when it was running.
 */
async function stopUserService(oldDir: string, home: string) {
  if (process.platform !== "darwin" && process.platform !== "linux") return undefined
  const { createUserService, daemonServicePlan } = await import("../../../packages/daemon/src/user-service")
  const bindingPath = daemonServicePlan({ dir: oldDir, cwd: home, command: [process.execPath] }).bindingPath
  if (!existsSync(bindingPath)) return undefined
  const binding = JSON.parse(readFileSync(bindingPath, "utf8")) as { dir: string; cwd: string; command: string[]; engine?: string }
  if (path.resolve(binding.dir) !== path.resolve(oldDir)) return undefined
  const options = { cwd: binding.cwd, command: binding.command, ...(binding.engine ? { engine: binding.engine } : {}) }
  const before = await createUserService({ ...options, dir: oldDir }).status()
  if (before.loaded) await createUserService({ ...options, dir: oldDir }).control("stop")
  return {
    async rebind(newDir: string) {
      writeFileSync(bindingPath, JSON.stringify({ ...binding, dir: newDir }) + "\n", { mode: 0o600 })
      const service = createUserService({ ...options, dir: newDir })
      await service.control("install")
      if (before.loaded) await service.control("start")
    },
  }
}
