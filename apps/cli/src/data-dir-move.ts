import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { dataDirFromEnv, moveLegacyDataDir, stopStandaloneDaemon, type DataDirMove } from "@mendcode/program/data-dir"
import type { ServiceExecutor } from "../../../packages/daemon/src/user-service"

/** What a test replaces: the service manager commands and the platform the service lives on. */
export type DataDirMoveHost = { execute?: ServiceExecutor; platform?: NodeJS.Platform; /** The daemon's work, as `daemon status` reports it; undefined when it cannot be queried. */ work?: (dir: string) => Promise<DaemonWork | undefined> }
type DaemonWork = { activeTurns: number; backgroundJobs: number; loops: { running: number } }

/** Asks the daemon of `dir` what it does, like `daemon status`. No daemon at all is no work; one that holds the directory and does not answer is unknown. */
async function daemonWork(dir: string): Promise<DaemonWork | undefined> {
  const { createClient } = await import("@mendcode/client")
  const { defaultLocalTransport, readLocalEndpoint } = await import("@mendcode/client/local-endpoint")
  const client = createClient({ ...(defaultLocalTransport() === "tcp" || readLocalEndpoint(dir) ? { localTcp: () => readLocalEndpoint(dir) } : { socketPath: path.join(dir, "mendd.sock") }), name: "data-dir-move", reconnect: false, timeoutMs: 2000 })
  try {
    await client.connect()
    const reply = await client.send({ type: "daemon.status" })
    return reply.ok ? reply.result as unknown as DaemonWork : undefined
  } catch {
    const { inspectLockOwner } = await import("@mendcode/program/daemon-identity")
    const owner = inspectLockOwner({ dir })
    return owner.state === "gone" || owner.state === "none" ? { activeTurns: 0, backgroundJobs: 0, loops: { running: 0 } } : undefined
  } finally { client.close() }
}

const NOTICE_FILE = ".data-dir-move-notice"

/**
 * Runs before anything opens the data directory (entry.ts): moves `~/.mendcode-v2` to `~/.mendcode` once, on the first start of a
 * version that uses the new name. A daemon of the earlier version is stopped first (running turns end as interrupted and resume),
 * and an installed user service is pointed at the new path with its listener and TLS flags kept. Nothing moves when `--dir` or a
 * variable names the directory, or under `bun test` (a test opts in with `MENDCODE_TEST_DATA_DIR_MOVE=1`). A move that cannot happen
 * now is tried again on the next start; the reason is written to stderr once, not on every command.
 */
export async function moveDataDirAtStart(argv: readonly string[] = process.argv, env: Readonly<Record<string, string | undefined>> = process.env, home = homedir(), host: DataDirMoveHost = {}): Promise<DataDirMove | undefined> {
  if (argv.some((arg) => arg === "--dir" || arg.startsWith("--dir="))) return undefined
  if (dataDirFromEnv(env)) return undefined
  if (env.NODE_ENV === "test" && env.MENDCODE_TEST_DATA_DIR_MOVE !== "1") return undefined
  if (!existsSync(path.join(home, ".mendcode-v2"))) return undefined
  let service: { rebind(newDir: string): Promise<void> } | undefined
  const result = await moveLegacyDataDir({
    home,
    stopDaemon: (dir) => stopStandaloneDaemon(dir),
    beforeMove: async (oldDir) => {
      // Any command can be the first start of the new version: the move never interrupts work, it waits for a start that finds none.
      const work = await (host.work ?? daemonWork)(oldDir)
      if (!work) throw new Error("the daemon holding it cannot be asked what it is doing")
      if (work.activeTurns || work.backgroundJobs || work.loops?.running) throw new Error(`the daemon is working: ${work.activeTurns} turns · ${work.backgroundJobs} jobs${work.loops?.running ? ` · ${work.loops.running} loops` : ""}`)
      service = await stopUserService(oldDir, home, host)
    },
    afterMove: async (_oldDir, newDir) => { await service?.rebind(newDir) },
  })
  if (result.moved) process.stderr.write(`MendCode keeps its data in ${path.join(home, ".mendcode")} now (moved from ~/.mendcode-v2, which still points to it).${result.v1Aside ? ` What MendCode v1 kept there is in ${result.v1Aside}.` : ""}\n`)
  else if (result.reason === "failed") noticeOnce(path.join(home, ".mendcode-v2", NOTICE_FILE), `MendCode could not move ~/.mendcode-v2 to ~/.mendcode (${result.detail}); it keeps using ~/.mendcode-v2 and tries again next start.\n`)
  return result
}

/** The same reason is said once: later starts that fail the same way stay quiet, a different reason is said again. */
function noticeOnce(file: string, message: string) {
  try { if (readFileSync(file, "utf8") === message) return } catch { /* not said yet */ }
  process.stderr.write(message)
  try { writeFileSync(file, message, { mode: 0o600 }) } catch { /* a read-only directory says it every time, which is the lesser harm */ }
}

/**
 * An installed user service bound to the old directory is stopped (launchd or systemd would restart its daemon on the old path),
 * and after the move its binding and definition name the new one; it is started again when it was running. The listener and TLS
 * flags come from the binding, or from the installed definition when the binding does not record them; a definition that differs
 * from the current template does not stop the move, it is rewritten. Unit drop-ins live beside the unit and stay as they are.
 */
async function stopUserService(oldDir: string, home: string, host: DataDirMoveHost) {
  const platform = host.platform ?? process.platform
  if (platform !== "darwin" && platform !== "linux") return undefined
  const { createUserService, daemonServicePlan, remoteArgsFromDefinition } = await import("../../../packages/daemon/src/user-service")
  const base = { home, platform }
  const bindingPath = daemonServicePlan({ ...base, dir: oldDir, cwd: home, command: [process.execPath] }).bindingPath
  if (!existsSync(bindingPath)) return undefined
  const binding = JSON.parse(readFileSync(bindingPath, "utf8")) as { dir: string; cwd: string; command: string[]; engine?: string; remote?: string[] }
  if (path.resolve(binding.dir) !== path.resolve(oldDir)) return undefined
  const definitionPath = daemonServicePlan({ ...base, dir: oldDir, cwd: binding.cwd, command: binding.command }).definitionPath
  let definition: string | undefined
  try { definition = readFileSync(definitionPath, "utf8") } catch { /* no definition: nothing to recover from */ }
  const remote = binding.remote ?? (definition ? remoteArgsFromDefinition(definition) : undefined)
  const options = { ...base, cwd: binding.cwd, command: binding.command, ...(binding.engine ? { engine: binding.engine } : {}), ...(remote ? { remote } : {}) }
  const open = (dir: string) => createUserService({ ...options, dir }, host.execute)
  const before = await open(oldDir).stopLoaded()
  return {
    async rebind(newDir: string) {
      writeFileSync(bindingPath, JSON.stringify({ ...binding, dir: newDir, ...(remote ? { remote } : {}) }) + "\n", { mode: 0o600 })
      const service = open(newDir)
      await service.control("install")
      if (before.loaded) await service.control("start")
    },
  }
}
