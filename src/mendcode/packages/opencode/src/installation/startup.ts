import fs from "node:fs/promises"
import { createReadStream } from "node:fs"
import { createHash, randomUUID } from "node:crypto"
import path from "node:path"
import { BACKEND_PREPARATION_TIMEOUT_MS } from "./backend-startup"

export async function latestUpdateOperation(executable: string) {
  const directory = path.dirname(await fs.realpath(executable))
  const records: Array<{ file: string; phase: string; version: string; failed: boolean; modified: number }> = []
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(".update.")) continue
    const file = path.join(directory, entry.name, "status")
    const stat = await fs.lstat(file).catch(() => undefined)
    if (!stat?.isFile() || stat.size > 4096) continue
    const fields = Object.fromEntries((await fs.readFile(file, "utf8")).trim().split(/\r?\n/).map((line) => {
      const separator = line.indexOf("=")
      return [line.slice(0, separator), line.slice(separator + 1)]
    }))
    if (!/^[a-z-]+$/.test(fields.phase ?? "") || !/^[0-9][a-zA-Z0-9.+-]*$/.test(fields.version ?? "")) continue
    records.push({ file, phase: fields.phase, version: fields.version,
      failed: fields.exit_code !== undefined && fields.exit_code !== "0", modified: stat.mtimeMs })
  }
  return records.sort((a, b) => b.modified - a.modified)[0]
}

export async function pendingUpdate(executable: string, version: string) {
  const directory = path.dirname(await fs.realpath(executable))
  const entries = await fs.readdir(directory, { withFileTypes: true })
  const candidates: Array<{ directory: string; digest: string; modified: number }> = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(".update.")) continue
    const operation = path.join(directory, entry.name)
    const status = path.join(operation, "status")
    const metadata = await fs.lstat(status).catch(() => undefined)
    if (!metadata?.isFile() || metadata.size > 4096) continue
    const fields = Object.fromEntries((await fs.readFile(status, "utf8")).trim().split("\n").map((line) => {
      const separator = line.indexOf("=")
      return [line.slice(0, separator), line.slice(separator + 1)]
    }))
    if (fields.version !== version || fields.phase !== "activated" || !/^[a-fA-F0-9]{64}$/.test(fields.binary_sha256 ?? "")) continue
    candidates.push({ directory: operation, digest: fields.binary_sha256.toLowerCase(), modified: metadata.mtimeMs })
  }
  if (!candidates.length) return
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(executable)) hash.update(chunk)
  const digest = hash.digest("hex")
  return candidates.sort((a, b) => b.modified - a.modified).find((candidate) => candidate.digest === digest)
}

export async function trackUpdateStartup(input: {
  executable: string
  version: string
  timeoutMs?: number
  journal?: Array<{ name: string; timestamp: number; hash: string }>
}) {
  const operation = await pendingUpdate(input.executable, input.version)
  if (!operation) return
  if (input.journal) {
    const temporary = path.join(operation.directory, `compatibility-${randomUUID()}.tmp`)
    await fs.writeFile(temporary, JSON.stringify({ formatVersion: 1, version: input.version,
      digest: operation.digest, journal: input.journal }) + "\n", { mode: 0o600 })
    await fs.rename(temporary, path.join(operation.directory, "compatibility.json"))
  }
  const started = Date.now()
  const file = path.join(operation.directory, `startup-${randomUUID()}.json`)
  let state: "starting" | "failed" | "ready" = "starting"
  let writes = Promise.resolve()
  const write = (error?: string) => {
    const snapshot = { version: input.version, digest: operation.digest, pid: process.pid, state, error,
      startedAt: new Date(started).toISOString(), elapsedMs: Date.now() - started }
    writes = writes.then(async () => {
      const temporary = `${file}.tmp`
      await fs.writeFile(temporary, JSON.stringify(snapshot) + "\n", { mode: 0o600 })
      await fs.rename(temporary, file)
    })
    return writes
  }
  await write()
  const expire = () => {
    state = "failed"
    void write("Backend and TUI readiness were not confirmed within the startup deadline.").catch(() => {})
  }
  let timer = setTimeout(expire, input.timeoutMs ?? 30_000)
  timer.unref()
  return {
    file,
    preparing() {
      clearTimeout(timer)
      timer = setTimeout(expire, BACKEND_PREPARATION_TIMEOUT_MS + 30_000)
      timer.unref()
    },
    connecting() {
      clearTimeout(timer)
      timer = setTimeout(expire, input.timeoutMs ?? 30_000)
      timer.unref()
    },
    async ready() {
      clearTimeout(timer)
      state = "ready"
      await write()
    },
    async close(error = "Client exited before backend and TUI readiness were confirmed.") {
      clearTimeout(timer)
      if (state === "ready" || state === "failed") return writes
      state = "failed"
      await write(error)
    },
  }
}

export async function latestUpdateStartup(executable: string, version: string) {
  const operation = await pendingUpdate(executable, version)
  if (!operation) return
  const attempts: Array<{ file: string; state: string; error?: string; startedAt: string }> = []
  for (const entry of await fs.readdir(operation.directory, { withFileTypes: true })) {
    if (!entry.isFile() || !/^startup-[a-f0-9-]+\.json$/.test(entry.name)) continue
    const file = path.join(operation.directory, entry.name)
    const metadata = await fs.lstat(file)
    if (!metadata.isFile() || metadata.size > 8192) continue
    const record = await fs.readFile(file, "utf8").then((text) => JSON.parse(text)).catch(() => undefined)
    if (!record || record.version !== version || record.digest !== operation.digest ||
      !["starting", "failed", "ready"].includes(record.state) ||
      typeof record.startedAt !== "string" || !Number.isFinite(Date.parse(record.startedAt)) ||
      !Number.isSafeInteger(record.pid) || record.pid <= 0) continue
    let state = record.state as string
    if (state === "starting") {
      try { process.kill(record.pid, 0) } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") state = "interrupted"
      }
    }
    attempts.push({ file, state, startedAt: record.startedAt,
      error: typeof record.error === "string" ? record.error : undefined })
  }
  return attempts.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))[0]
}
