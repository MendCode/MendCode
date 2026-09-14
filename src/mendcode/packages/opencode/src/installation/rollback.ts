import fs from "node:fs/promises"
import path from "node:path"
import { createReadStream } from "node:fs"
import { createHash } from "node:crypto"
import z from "zod"
import semver from "semver"
import { pendingUpdate } from "./startup"

const digest = z.string().regex(/^[a-f0-9]{64}$/)
const compatibility = z.object({
  formatVersion: z.literal(1),
  version: z.string().refine((value) => Boolean(semver.valid(value))),
  digest,
  journal: z.array(z.object({ name: z.string().max(200), timestamp: z.number().int().nonnegative(), hash: digest })).max(2048),
})
export type RollbackCompatibility = z.infer<typeof compatibility>

async function regularFile(file: string, maxBytes: number) {
  const stat = await fs.lstat(file)
  if (!stat.isFile() || stat.size > maxBytes) throw new Error(`Invalid update record: ${path.basename(file)}`)
  return fs.readFile(file, "utf8")
}

async function hash(file: string) {
  if (!(await fs.lstat(file)).isFile()) throw new Error("Retained executable must be a regular file.")
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest("hex")
}

async function status(directory: string) {
  return Object.fromEntries((await regularFile(path.join(directory, "status"), 4096)).trim().split("\n").map((line) => {
    const separator = line.indexOf("=")
    return [line.slice(0, separator), line.slice(separator + 1)]
  }))
}

export async function rollbackTarget(executable: string, version: string) {
  const current = await pendingUpdate(executable, version)
  if (!current) throw new Error("No verified update history matches this executable; automatic rollback is unavailable.")
  const record = await status(current.directory)
  const previousDigest = digest.safeParse(record.previous_sha256)
  if (!previousDigest.success) throw new Error("The previous executable has no recorded identity; automatic rollback is unavailable.")
  const previous = path.join(current.directory, "previous")
  if (await hash(previous) !== previousDigest.data) throw new Error("The retained executable checksum changed; rollback was refused.")
  const directory = path.dirname(current.directory)
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(".update.")) continue
    const history = path.join(directory, entry.name)
    const metadata = await regularFile(path.join(history, "compatibility.json"), 512_000)
      .then((text) => compatibility.parse(JSON.parse(text))).catch(() => undefined)
    if (!metadata || metadata.digest !== previousDigest.data) continue
    const installed = await status(history).catch(() => undefined)
    if (installed?.phase !== "activated" || installed.version !== metadata.version || installed.binary_sha256 !== metadata.digest) continue
    return { previous, metadata, currentDigest: current.digest }
  }
  throw new Error("Compatibility of the previous executable is unknown. Automatic rollback is unavailable; no data was restored or changed.")
}

export async function rollback(input: {
  executable: string
  version: string
  // The caller fences backend startup and SQLite writers before activation.
  maintain: (metadata: RollbackCompatibility) => Promise<() => void | Promise<void>>
  platform?: NodeJS.Platform
}) {
  if ((input.platform ?? process.platform) === "win32") {
    throw new Error("Rollback requires verified deferred replacement on Windows; this installation cannot perform it yet.")
  }
  const executable = await fs.realpath(input.executable)
  const directory = path.dirname(executable)
  const lock = path.join(directory, ".update-lock")
  await fs.mkdir(lock, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "EEXIST") throw new Error("Another update owns the installation lock. Wait for it to finish or recover its verified dead owner.")
    throw error
  })
  let operation: string | undefined
  let release: (() => void | Promise<void>) | undefined
  let phase = "checking"
  let target: Awaited<ReturnType<typeof rollbackTarget>> | undefined
  const record = async (code = "") => {
    if (!operation) return
    const text = `version=${target?.metadata.version ?? input.version}\nphase=${phase}\nowner_pid=${process.pid}\nexit_code=${code}\nbinary_sha256=${target?.metadata.digest ?? ""}\nprevious_sha256=${target?.currentDigest ?? ""}\n`
    await fs.writeFile(path.join(operation, "status.next"), text, { mode: 0o600 })
    await fs.rename(path.join(operation, "status.next"), path.join(operation, "status"))
  }
  try {
    operation = await fs.mkdtemp(path.join(directory, ".update.rollback-"))
    await fs.writeFile(path.join(lock, "owner"), `pid=${process.pid}\noperation=${operation}\n`, { mode: 0o600 })
    await record()
    target = await rollbackTarget(executable, input.version)
    phase = "verifying"
    await record()
    release = await input.maintain(target.metadata)
    if (await hash(executable) !== target.currentDigest) throw new Error("Installed executable changed during rollback verification.")
    await fs.copyFile(executable, path.join(operation, "previous"))
    const candidate = path.join(operation, "candidate")
    await fs.copyFile(target.previous, candidate)
    if (await hash(candidate) !== target.metadata.digest) throw new Error("Retained executable changed during rollback staging.")
    await fs.chmod(candidate, 0o755)
    await fs.writeFile(path.join(operation, "compatibility.json"), JSON.stringify(target.metadata) + "\n", { mode: 0o600 })
    phase = "activating"
    await record()
    await fs.rename(candidate, executable)
    phase = "activated"
    await record("0")
    return { version: target.metadata.version, operation }
  } catch (error) {
    await record("1").catch(() => undefined)
    throw error
  } finally {
    try { await release?.() } finally {
      if (operation) await fs.rename(lock, path.join(operation, "lock"))
      else await fs.rename(lock, path.join(directory, `.update.abandoned-${process.pid}-${Date.now()}`))
    }
  }
}
