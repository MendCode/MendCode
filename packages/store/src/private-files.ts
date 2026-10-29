import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs"
import path from "node:path"
import { atomicPrivateWrite, cleanPrivateTemp, isSealedFile, type createSealedFiles } from "./sealed-file"

/** Only application-owned transcript/output files. Never encrypt a user's checkout or explicit exports. */
export function createPrivateFiles(dir: string, privacy: { enabled(): boolean; sealed: ReturnType<typeof createSealedFiles>; warn?(message: string): void; beforeConvert?(): void }) {
  const roots = ["session-transcripts", "tool-output", "goals"].map((name) => path.join(path.resolve(dir), name))
  const owned = (file: string) => roots.some((root) => path.dirname(path.resolve(file)) === root)
  const context = (file: string) => `file:${path.relative(path.resolve(dir), path.resolve(file))}`
  const unreadable = new Map<string, unknown>()
  const pending = new Set<string>()
  return {
    unreadable,
    pending,
    read(file: string): Buffer | undefined {
      if (!owned(file)) return undefined
      if (!lstatSync(file).isFile()) throw new Error("[PRIVACY]: not a regular stored file")
      return privacy.sealed.open(readFileSync(file), context(file))
    },
    write(file: string, bytes: Uint8Array) {
      if (!owned(file)) throw new Error("[PRIVACY]: path is not an owned transcript file")
      atomicPrivateWrite(file, privacy.enabled() ? privacy.sealed.seal(bytes, context(file)) : bytes)
    },
    convert(selected?: string[], opening = false) {
      pending.clear()
      unreadable.clear()
      for (const root of roots) {
        if (!existsSync(root) || !lstatSync(root).isDirectory()) continue
        for (const name of readdirSync(root)) {
          const file = path.join(root, name)
          if (selected && !selected.includes(path.relative(path.resolve(dir), file))) continue
          if (name.endsWith(".tmp")) {
            cleanPrivateTemp(file, (target) => { this.read(target) })
            continue
          }
          let content: Buffer, sealed: boolean
          try {
            const stat = lstatSync(file)
            if (!stat.isFile() || stat.nlink !== 1) continue
            sealed = isSealedFile(file)
            if (opening && sealed === privacy.enabled()) continue
            pending.add(file)
            content = privacy.sealed.open(readFileSync(file), context(file))
          } catch (error) {
            pending.add(file)
            unreadable.set(file, error)
            privacy.warn?.(`[PRIVACY]: unreadable ${JSON.stringify(file)}`)
            continue
          }
          try { if (sealed !== privacy.enabled()) { privacy.beforeConvert?.(); this.write(file, content) } }
          catch {
            privacy.warn?.(`[PRIVACY]: conversion incomplete ${JSON.stringify(file)}`)
            continue
          }
          pending.delete(file)
        }
      }
    },
  }
}
