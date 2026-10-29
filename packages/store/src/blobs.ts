import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { atomicPrivateWrite, cleanPrivateTemp, isSealedFile, privateTempTarget, type createSealedFiles } from "./sealed-file"
import path from "node:path"
import type { BlobRef } from "@mendcode/protocol"

/** Content-addressed files: the same bytes are stored once no matter how often they are attached (P11, A9). */
export function createBlobFiles(root: string, privacy?: { enabled(): boolean; sealed: ReturnType<typeof createSealedFiles>; warn?(message: string): void; beforeConvert?(): void }) {
  mkdirSync(root, { recursive: true })
  const pathOf = (sha256: string) => path.join(root, sha256.slice(0, 2), sha256)
  const unreadable = new Map<string, unknown>()
  const pending = new Set<string>()
  const plain = (bytes: Uint8Array, name: string) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex") === name
  const decode = (bytes: Buffer, name: string) => {
    try { return privacy!.sealed.open(bytes, `blob:${name}`, true) }
    catch (error) { if (plain(bytes, name)) return bytes; throw error }
  }

  return {
    pathOf,
    unreadable,
    pending,
    read(sha256: string) {
      if (unreadable.has(pathOf(sha256))) throw unreadable.get(pathOf(sha256))
      const bytes = readFileSync(pathOf(sha256))
      return privacy && (privacy.enabled() || privacy.sealed.encrypted(bytes)) ? decode(bytes, sha256) : bytes
    },
    convert(opening = false, selected?: string[]) {
      if (!privacy || !lstatSync(root).isDirectory()) return
      pending.clear()
      unreadable.clear()
      for (const dir of readdirSync(root, { withFileTypes: true })) {
        if (!/^[a-f0-9]{2}$/.test(dir.name) || !dir.isDirectory()) continue
        for (const name of readdirSync(path.join(root, dir.name))) {
          const tempTarget = privateTempTarget(name)
          if (!selected && tempTarget && /^[a-f0-9]{64}$/.test(tempTarget) && tempTarget.startsWith(dir.name)) {
            cleanPrivateTemp(path.join(root, dir.name, name), (file) => { decode(readFileSync(file), tempTarget) })
            continue
          }
          if (!/^[a-f0-9]{64}$/.test(name) || !name.startsWith(dir.name)) continue
          if (selected && !selected.includes(name)) continue
          const file = pathOf(name)
          let bytes: Buffer, content: Buffer, sealed: boolean
          try {
            const stat = lstatSync(file)
            if (!stat.isFile() || stat.nlink !== 1) continue
            if (opening && isSealedFile(file) === privacy.enabled()) continue
            pending.add(file)
            bytes = readFileSync(file)
            sealed = !plain(bytes, name)
            content = sealed ? privacy.sealed.open(bytes, `blob:${name}`, true) : bytes
          } catch (error) {
            pending.add(file)
            unreadable.set(file, error)
            privacy.warn?.(`[PRIVACY]: unreadable ${JSON.stringify(file)}`)
            continue
          }
          try {
            if (sealed !== privacy.enabled()) {
              privacy.beforeConvert?.()
              atomicPrivateWrite(file, privacy.enabled() ? privacy.sealed.seal(content, `blob:${name}`) : content)
            }
          } catch {
            privacy.warn?.(`[PRIVACY]: conversion incomplete ${JSON.stringify(file)}`)
            continue
          }
          pending.delete(file)
        }
      }
    },
    write(bytes: Uint8Array, mime: string): BlobRef {
      const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
      const target = pathOf(sha256)
      if (!existsSync(target)) {
        mkdirSync(path.dirname(target), { recursive: true })
        const temp = `${target}.${process.pid}.${Date.now()}.tmp`
        writeFileSync(temp, privacy?.enabled() ? privacy.sealed.seal(bytes, `blob:${sha256}`) : bytes, { mode: 0o600 })
        renameSync(temp, target)
      }
      return { sha256, bytes: bytes.byteLength, mime }
    },
    remove(sha256: string) {
      rmSync(pathOf(sha256), { force: true })
    },
    /** Every file in the store (including partial `.tmp` writes) with size and mtime. */
    scan() {
      const files: Array<{ name: string; bytes: number; mtimeMs: number }> = []
      for (const dir of readdirSync(root)) {
        const full = path.join(root, dir)
        for (const file of readdirSync(full)) {
          const stat = statSync(path.join(full, file))
          files.push({ name: file, bytes: stat.size, mtimeMs: stat.mtimeMs })
        }
      }
      return files
    },
    totalBytes() {
      let total = 0
      for (const file of this.scan()) total += file.bytes
      return total
    },
  }
}
