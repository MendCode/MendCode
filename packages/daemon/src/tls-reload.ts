import { readFileSync, watch, type FSWatcher } from "node:fs"
import path from "node:path"

/**
 * Calls `changed` once, shortly after the certificate or key file is rewritten or replaced (a renewal tool renames a new file over the old one).
 * It watches the folders, so a replaced file is seen; there is no timer while nothing changes. Loaded only by a daemon that listens with TLS.
 */
export function watchTlsFiles(input: { files: readonly string[]; changed(): void; debounceMs?: number }): { close(): void } {
  const names = new Set(input.files.map((file) => path.resolve(file)))
  const watchers: FSWatcher[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  const schedule = () => {
    clearTimeout(timer)
    timer = setTimeout(() => { timer = undefined; input.changed() }, input.debounceMs ?? 1000)
  }
  for (const folder of new Set([...names].map((file) => path.dirname(file)))) {
    try {
      watchers.push(watch(folder, (_event, name) => { if (name && names.has(path.join(folder, name.toString()))) schedule() }))
    } catch { /* an unreadable folder keeps the certificate loaded at start */ }
  }
  return { close() { clearTimeout(timer); for (const watcher of watchers) watcher.close() } }
}

/** The PEM files as the listener takes them, or undefined when either is missing or empty (a renewal caught mid-write). */
export function readTlsFiles(cert: string, key: string): { cert: Buffer; key: Buffer } | undefined {
  try {
    const pair = { cert: readFileSync(cert), key: readFileSync(key) }
    return pair.cert.length && pair.key.length ? pair : undefined
  } catch { return undefined }
}
