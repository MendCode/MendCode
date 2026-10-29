import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto"
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"

const MAGIC = Buffer.from("MENDENC1")

export function isSealedFile(file: string) {
  const fd = openSync(file, "r")
  try { const header = Buffer.alloc(8); return readSync(fd, header, 0, 8, 0) === 8 && header.equals(MAGIC) }
  finally { closeSync(fd) }
}

/** Authenticated, versioned files. A missing key must never silently replace an existing one. */
export function createSealedFiles(dir: string, name: string, existing: () => boolean) {
  const keyPath = path.join(dir, "keys", `${name}.key`)
  let cached: Buffer | undefined
  function key() {
    if (cached) return cached
    if (existsSync(keyPath)) {
      const value = readFileSync(keyPath)
      if (value.length !== 32) throw new Error(`[PRIVACY]: invalid ${name} key; restore keys/${name}.key`)
      chmodSync(keyPath, 0o600)
      return cached = value
    }
    if (existing()) throw new Error(`[PRIVACY]: missing keys/${name}.key; restore it from your backup`)
    mkdirSync(path.dirname(keyPath), { recursive: true, mode: 0o700 })
    chmodSync(path.dirname(keyPath), 0o700)
    const value = randomBytes(32)
    writeFileSync(keyPath, value, { mode: 0o600, flag: "wx" })
    const fd = openSync(keyPath, "r")
    try { fsyncSync(fd) } finally { closeSync(fd) }
    const folder = openSync(path.dirname(keyPath), "r")
    try { fsyncSync(folder) } finally { closeSync(folder) }
    return cached = value
  }
  const encrypted = (bytes: Uint8Array) => Buffer.from(bytes.subarray(0, MAGIC.length)).equals(MAGIC)
  return {
    encrypted,
    seal(bytes: Uint8Array, context: string) {
      const iv = randomBytes(12)
      const cipher = createCipheriv("aes-256-gcm", key(), iv)
      cipher.setAAD(Buffer.from(`MENDENC1:${name}:${context}`))
      return Buffer.concat([MAGIC, iv, cipher.update(bytes), cipher.final(), cipher.getAuthTag()])
    },
    open(bytes: Uint8Array, context: string, required = false) {
      if (!encrypted(bytes)) {
        if (required) throw new Error(`[PRIVACY]: ${name} authentication failed; wrong key or damaged file`)
        return Buffer.from(bytes)
      }
      const value = Buffer.from(bytes)
      if (value.length < 36) throw new Error(`[PRIVACY]: ${name} authentication failed; wrong key or damaged file`)
      const decipher = createDecipheriv("aes-256-gcm", key(), value.subarray(8, 20))
      decipher.setAAD(Buffer.from(`MENDENC1:${name}:${context}`))
      decipher.setAuthTag(value.subarray(-16))
      try { return Buffer.concat([decipher.update(value.subarray(20, -16)), decipher.final()]) }
      catch { throw new Error(`[PRIVACY]: ${name} authentication failed; wrong key or damaged file`) }
    },
  }
}

export function privateTempTarget(file: string) {
  return /^(.*)\.[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.tmp$/.exec(file)?.[1]
}

export function cleanPrivateTemp(file: string, validate: (target: string) => void) {
  const target = privateTempTarget(file)
  if (!target) return
  try {
    const stat = lstatSync(file)
    if (!stat.isFile() || stat.nlink !== 1 || !lstatSync(target).isFile()) return
    validate(target)
    rmSync(file)
  } catch {}
}

export function atomicPrivateWrite(file: string, bytes: Uint8Array) {
  const temp = `${file}.${randomUUID()}.tmp`
  try {
    writeFileSync(temp, bytes, { mode: 0o600, flag: "wx" })
    const fd = openSync(temp, "r")
    try { fsyncSync(fd) } finally { closeSync(fd) }
    renameSync(temp, file)
    const folder = openSync(path.dirname(file), "r")
    try { fsyncSync(folder) } finally { closeSync(folder) }
  } finally { rmSync(temp, { force: true }) }
}
