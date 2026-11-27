import { readFileSync, statSync, watch, type FSWatcher } from "node:fs"
import path from "node:path"

const POLL_MS = 250

/**
 * Calls `changed` once, shortly after the certificate or key file is rewritten or replaced (a renewal tool renames a new file over the old one).
 * It watches the folders, so a replaced file is seen; there is no timer while nothing changes. Loaded only by a daemon that listens with TLS.
 *
 * Bun on Linux opens every entry of a folder it starts watching, and a unix socket in that folder (the daemon's own, when the certificate
 * lives in the data folder) fails that open with ENXIO: the error escapes the process unhandled and the watcher is dead. A folder whose
 * watch fails that way is followed by checking its two files with a stat every few hundred milliseconds instead (a watch on the file itself misses a file renamed over it).
 */
export function watchTlsFiles(input: {
  files: readonly string[]
  changed(): void
  debounceMs?: number
  pollMs?: number
  watchFolder?: (folder: string, listener: (event: string, name: string | Buffer | null) => void) => FSWatcher
}): { close(): void } {
  const watchFolder = input.watchFolder ?? ((folder, listener) => watch(folder, listener))
  const names = new Set(input.files.map((file) => path.resolve(file)))
  const watchers = new Map<string, FSWatcher>()
  const pollers: ReturnType<typeof setInterval>[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  const schedule = () => {
    clearTimeout(timer)
    timer = setTimeout(() => { timer = undefined; input.changed() }, input.debounceMs ?? 1000)
  }
  const poll = (folder: string) => {
    for (const file of names) {
      if (path.dirname(file) !== folder) continue
      // The file as it is when the watch is asked for; a timer of our own compares it (a runtime's file watcher can start its first look late and take a renewal made meanwhile as the starting point).
      const look = () => { try { const info = statSync(file); return `${info.ino}:${info.size}:${info.mtimeMs}` } catch { return "" } }
      let known = look()
      const poller = setInterval(() => {
        const now = look()
        if (now === known) return
        known = now
        if (now) schedule()
      }, input.pollMs ?? POLL_MS)
      poller.unref?.()
      pollers.push(poller)
    }
  }
  for (const folder of new Set([...names].map((file) => path.dirname(file)))) {
    try {
      const watcher = watchFolder(folder, (_event, name) => { if (name && names.has(path.join(folder, name.toString()))) schedule() })
      watcher.on("error", () => {
        watchers.delete(folder)
        try { watcher.close() } catch { /* already closed */ }
        poll(folder)
      })
      watchers.set(folder, watcher)
    } catch { /* an unreadable folder keeps the certificate loaded at start */ }
  }
  return {
    close() {
      clearTimeout(timer)
      for (const watcher of watchers.values()) watcher.close()
      for (const poller of pollers) clearInterval(poller)
    },
  }
}

/** The PEM files as the listener takes them, or undefined when either is missing or empty (a renewal caught mid-write). */
export function readTlsFiles(cert: string, key: string): { cert: Buffer; key: Buffer } | undefined {
  try {
    const pair = { cert: readFileSync(cert), key: readFileSync(key) }
    return pair.cert.length && pair.key.length ? pair : undefined
  } catch { return undefined }
}
