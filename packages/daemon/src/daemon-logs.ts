import { open } from "node:fs/promises"
import path from "node:path"
import type { DaemonLogsReport } from "@mendcode/protocol"
import { redactSecrets } from "@mendcode/protocol/wire"

export const daemonLogPaths = (dir: string) => ({ stdout: path.join(dir, "logs", "daemon.stdout.log"), stderr: path.join(dir, "logs", "daemon.stderr.log") })

/** Bounded tails only; never follow a symlink into an unrelated file. */
export async function daemonLogs(dir: string, lines = 100): Promise<DaemonLogsReport> {
  const { constants } = await import("node:fs")
  const logs: DaemonLogsReport["logs"] = []
  for (const [stream, file] of Object.entries(daemonLogPaths(dir))) {
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
      const stat = await handle.stat()
      if (!stat.isFile()) throw new Error("Daemon log is not a regular file")
      const length = Math.min(stat.size, 128 * 1024)
      const buffer = Buffer.alloc(length)
      const { bytesRead } = await handle.read(buffer, 0, length, Math.max(0, stat.size - length))
      let text = buffer.subarray(0, bytesRead).toString("utf8")
      if (stat.size > length) text = text.slice(text.indexOf("\n") + 1)
      const rows = text.replace(/\n$/, "").split("\n")
      const tail = rows.slice(-lines).join("\n")
      logs.push({ stream: stream as "stdout" | "stderr", path: file, text: redactSecrets(tail).text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ""), missing: false, truncated: stat.size > length || rows.length > lines })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      logs.push({ stream: stream as "stdout" | "stderr", path: file, text: "", missing: true, truncated: false })
    } finally { await handle?.close() }
  }
  return { logs }
}
