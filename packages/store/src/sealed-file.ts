import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto"
import { chmodSync, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs"
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
      // A view, not a copy: a sealed database is as large as the whole history.
      const value = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      if (value.length < 36) throw new Error(`[PRIVACY]: ${name} authentication failed; wrong key or damaged file`)
      const decipher = createDecipheriv("aes-256-gcm", key(), value.subarray(8, 20))
      decipher.setAAD(Buffer.from(`MENDENC1:${name}:${context}`))
      decipher.setAuthTag(value.subarray(-16))
      try {
        const plain = decipher.update(value.subarray(20, -16))
        const tail = decipher.final()
        return tail.length ? Buffer.concat([plain, tail]) : plain
      } catch { throw new Error(`[PRIVACY]: ${name} authentication failed; wrong key or damaged file`) }
    },
    /**
     * `atomicPrivateWrite(file, seal(bytes, context))` without holding the sealed copy: the same bytes on disk, encrypted
     * and written in slices, so sealing a large database costs a slice of memory instead of a second copy of it.
     */
    sealToFile(file: string, bytes: Uint8Array, context: string) {
      const iv = randomBytes(12)
      const cipher = createCipheriv("aes-256-gcm", key(), iv)
      cipher.setAAD(Buffer.from(`MENDENC1:${name}:${context}`))
      atomicPrivateWriteParts(file, function* () {
        yield MAGIC
        yield iv
        for (let at = 0; at < bytes.byteLength; at += STREAM_SLICE) yield cipher.update(bytes.subarray(at, Math.min(at + STREAM_SLICE, bytes.byteLength)))
        yield cipher.final()
        yield cipher.getAuthTag()
      })
    },
    /** `open(readFileSync(file), context, true)` reading and decrypting in slices into one buffer: no ciphertext copy in memory. */
    openFile(file: string, context: string) {
      const fd = openSync(file, "r")
      try {
        const size = fstatSync(fd).size
        const fail = () => new Error(`[PRIVACY]: ${name} authentication failed; wrong key or damaged file`)
        if (size < 36) throw fail()
        const head = Buffer.alloc(20)
        if (readSync(fd, head, 0, 20, 0) !== 20 || !encrypted(head)) throw fail()
        const tag = Buffer.alloc(16)
        if (readSync(fd, tag, 0, 16, size - 16) !== 16) throw fail()
        const decipher = createDecipheriv("aes-256-gcm", key(), head.subarray(8, 20))
        decipher.setAAD(Buffer.from(`MENDENC1:${name}:${context}`))
        decipher.setAuthTag(tag)
        const length = size - 36
        const plain = Buffer.allocUnsafe(length)
        const slice = Buffer.allocUnsafe(Math.min(STREAM_SLICE, Math.max(1, length)))
        let done = 0
        try {
          while (done < length) {
            const want = Math.min(slice.length, length - done)
            if (readSync(fd, slice, 0, want, 20 + done) !== want) throw fail()
            const out = decipher.update(slice.subarray(0, want))
            out.copy(plain, done)
            done += out.length
          }
          const tail = decipher.final()
          if (tail.length) { tail.copy(plain, done); done += tail.length }
        } catch { plain.fill(0); throw fail() }
        return plain.subarray(0, done)
      } finally { closeSync(fd) }
    },
  }
}

/** Slice size of streamed sealing: large enough for full AES speed, small next to a database. */
const STREAM_SLICE = 4 * 1024 * 1024

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

/** `atomicPrivateWrite` of the concatenated parts, written one after another (the same temp, fsync and rename). */
export function atomicPrivateWriteParts(file: string, parts: () => Iterable<Uint8Array>) {
  const temp = `${file}.${randomUUID()}.tmp`
  try {
    const fd = openSync(temp, "wx", 0o600)
    try {
      for (const part of parts()) {
        let written = 0
        while (written < part.byteLength) written += writeSync(fd, part, written, part.byteLength - written)
      }
      fsyncSync(fd)
    } finally { closeSync(fd) }
    renameSync(temp, file)
    const folder = openSync(path.dirname(file), "r")
    try { fsyncSync(folder) } finally { closeSync(folder) }
  } finally { rmSync(temp, { force: true }) }
}
