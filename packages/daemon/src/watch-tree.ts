import { lstatSync, readdirSync, watch, type FSWatcher } from "node:fs"
import path from "node:path"

/**
 * A directory tree watched one directory at a time. inotify (Linux) watches a single directory, not its subtree, and `fs.watch(…,
 * { recursive: true })` does not arm the directories created after it started there: a skill written to a new `skills/<name>/` was
 * never seen. This watcher arms every directory `descend` accepts and arms new ones as they appear.
 *
 * It does not trust what an event says. Platforms differ in the event name (`rename` for a create, a delete and a move alike), in the
 * file name (the old name of a rename-over, the temp name of an atomic save, none at all) and in what happens to a watch whose
 * directory was deleted and made again (the old watch is dead). So any event in a directory only schedules a short, single-shot
 * rescan of that directory: it lists the entries, compares them with what the last scan saw (name, size, mtime, inode) and reports
 * what is new, changed or gone, arms a subdirectory that is new or whose inode changed (it was replaced) and disarms one that is gone.
 * The file name an event does carry is still reported at once, for latency. The cost is bounded: at most `maxDirectories` armed
 * directories and `MAX_SCANNED_ENTRIES` entries compared per directory (a larger one falls back to trusting event names).
 */
export const MAX_TREE_DIRECTORIES = 512
export const MAX_SCANNED_ENTRIES = 1_000
export const RESCAN_DELAY_MS = 15
/**
 * A watch armed on a path that was watched before and then lost (the directory was deleted, replaced or moved) cannot be trusted to
 * report: whether a platform's watch on a re-created path delivers events depends on how it tracks watches (by path, by inode, by
 * descriptor that may still be closing). Such a directory is rescanned on this interval for as long as it is armed, so a missed
 * event delays the report by at most this much instead of losing it. Only these directories are polled, never the whole tree.
 */
export const SUSPECT_POLL_MS = 500
const MAX_RETIRED_PATHS = 4_096
const MAX_LOG_LINES = 60

export type TreeWatch = {
  close(): void
  /** Directories currently armed. */
  directories(): number
  /** What the watcher saw, for a failure message: armed directories, the last listing and snapshot of each, and the latest events and reports. */
  describe(): string
}

type Armed = { handle: FSWatcher; inode: string; entries: Map<string, string> | undefined; suspect: boolean; lastListing: string[]; timer?: ReturnType<typeof setTimeout> | undefined }

export type DirectoryWatch = (dir: string, listener: (event: string, filename: string | null | undefined) => void) => FSWatcher
/** The fields of a stat the comparison reads. */
export type TreeStat = { ino: number; size: number; mtimeMs: number; birthtimeMs: number }

export function watchTree({ root, descend, onChange, maxDirectories = MAX_TREE_DIRECTORIES, watchDirectory = (dir, listener) => watch(dir, { recursive: false }, listener), stat = (file) => lstatSync(file), suspectPollMs = SUSPECT_POLL_MS }: {
  root: string
  /** Whether the directory at this posix path relative to `root` (never the root itself) is watched, and so descended into. */
  descend: (relative: string) => boolean
  /** A change at this posix path relative to `root`, or undefined when the platform did not say where. */
  onChange: (relative: string | undefined) => void
  maxDirectories?: number
  /** How one directory is watched; tests replace it with the shapes other platforms report. */
  watchDirectory?: DirectoryWatch
  /** How an entry is stat'ed for the comparison; tests replace it with what Linux filesystems report (birth time 0, reused inodes). */
  stat?: (file: string) => TreeStat
  /** Poll interval of directories armed again after being lost; 0 turns the poll off (tests that show what it covers). */
  suspectPollMs?: number
}): TreeWatch {
  const armed = new Map<string, Armed>()
  const retired = new Set<string>()
  const log: string[] = []
  const note = (line: string) => {
    log.push(line)
    if (log.length > MAX_LOG_LINES) log.shift()
  }
  let closed = false
  let poller: ReturnType<typeof setInterval> | undefined
  const relativeOf = (full: string) => path.relative(root, full).split(path.sep).join("/")
  /** Who a directory is: its inode and, where the filesystem has one, its birth time (an inode is often reused by the directory made right after a delete). */
  const inodeOf = (full: string) => {
    try {
      const found = stat(full)
      return `${found.ino}:${found.birthtimeMs}`
    } catch {
      return undefined
    }
  }

  function updatePoller() {
    const needed = [...armed.values()].some((state) => state.suspect)
    if (needed && !poller && suspectPollMs > 0) {
      poller = setInterval(() => {
        for (const [dir, state] of [...armed]) if (state.suspect && armed.get(dir) === state) rescan({ dir, announce: true, why: "poll" })
      }, suspectPollMs)
      poller.unref?.()
    } else if (!needed && poller) {
      clearInterval(poller)
      poller = undefined
    }
  }

  function disarm(dir: string) {
    for (const [key, state] of armed) {
      if (key !== dir && !key.startsWith(dir + path.sep)) continue
      clearTimeout(state.timer)
      state.handle.close()
      armed.delete(key)
      retired.add(key)
      if (retired.size > MAX_RETIRED_PATHS) retired.delete(retired.values().next().value as string)
      note(`disarmed ${relativeOf(key) || "."}`)
    }
    updatePoller()
  }

  /** Arms `dir` (replacing a watch on a previous incarnation of it); false when it cannot be, or the bound is reached. */
  function arm(dir: string): boolean {
    if (closed) return false
    const inode = inodeOf(dir)
    if (inode === undefined) return false
    const existing = armed.get(dir)
    if (existing) {
      if (existing.inode === inode) return true
      disarm(dir)
    }
    if (armed.size >= maxDirectories) return false
    let handle: FSWatcher
    try {
      handle = watchDirectory(dir, (event, filename) => {
        if (closed) return
        note(`event ${event} ${relativeOf(dir) || "."}/${filename ?? "(no name)"}`)
        onChange(filename === null || filename === undefined ? undefined : relativeOf(path.join(dir, String(filename))))
        schedule(dir)
        // An event named after the directory itself is its own deletion or move: its watch may be dead, so the parent looks again.
        if (dir !== root && filename !== null && filename !== undefined && String(filename) === path.basename(dir)) schedule(path.dirname(dir))
      })
    } catch {
      return false
    }
    handle.on("error", () => {
      // Only the watch that is still the current one is closed: closing a stale handle by path can take the new watch of the same path down with it.
      if (armed.get(dir)?.handle !== handle) return
      handle.close()
      armed.delete(dir)
      retired.add(dir)
      note(`error on ${relativeOf(dir) || "."}`)
      updatePoller()
      schedule(path.dirname(dir))
    })
    armed.set(dir, { handle, inode, entries: new Map(), suspect: retired.has(dir), lastListing: [] })
    note(`armed ${relativeOf(dir) || "."}${retired.has(dir) ? " (suspect: watched before)" : ""}`)
    updatePoller()
    return true
  }

  function schedule(dir: string) {
    const state = armed.get(dir)
    if (!state || state.timer !== undefined) return
    state.timer = setTimeout(() => {
      state.timer = undefined
      rescan({ dir, announce: true, why: "event" })
    }, RESCAN_DELAY_MS)
  }

  /** What identifies an entry's content for the comparison between two scans: the name is the key, so a rename is a new name whatever its inode, size and mtime. */
  function signature(full: string, directory: boolean): string | undefined {
    try {
      const found = stat(full)
      return directory ? `d${found.ino}:${found.birthtimeMs}` : `f${found.ino}:${found.size}:${found.mtimeMs}`
    } catch {
      return undefined
    }
  }

  function rescan({ dir, announce, why = "start" }: { dir: string; announce: boolean; why?: string }) {
    const state = armed.get(dir)
    if (!state || closed) return
    let listing
    try {
      listing = readdirSync(dir, { withFileTypes: true })
      state.lastListing = listing.map((entry) => entry.name)
      if (announce) note(`rescan (${why}) ${relativeOf(dir) || "."}: ${state.lastListing.join(",") || "empty"}`)
    } catch {
      // The directory is gone: its parent's event (or this one) told us; drop the dead watch and let the parent report it.
      disarm(dir)
      if (dir !== root) schedule(path.dirname(dir))
      return
    }
    const before = state.entries
    const diff = before !== undefined && listing.length <= MAX_SCANNED_ENTRIES
    const after = diff ? new Map<string, string>() : undefined
    for (const entry of listing) {
      const full = path.join(dir, entry.name)
      const directory = entry.isDirectory()
      const relative = relativeOf(full)
      if (directory && descend(relative)) {
        // A directory that is new, or that replaced one with the same name (another inode), needs a live watch and a look inside.
        const known = armed.get(full)
        const replaced = known !== undefined && known.inode !== inodeOf(full)
        if (known === undefined || replaced) {
          if (arm(full)) rescan({ dir: full, announce, why: "armed" })
        }
      }
      if (after === undefined) continue
      const sig = signature(full, directory)
      if (sig === undefined) continue
      after.set(entry.name, sig)
      if (announce && before!.get(entry.name) !== sig && !directory) onChange(relative)
      else if (announce && directory && before!.get(entry.name) === undefined) onChange(relative)
    }
    if (before !== undefined && after !== undefined) {
      for (const [name, sig] of before) {
        if (after.has(name)) continue
        const full = path.join(dir, name)
        if (sig.startsWith("d")) disarm(full)
        if (announce) onChange(relativeOf(full))
      }
    }
    state.entries = after
  }

  arm(root)
  rescan({ dir: root, announce: false })
  return {
    directories: () => armed.size,
    describe() {
      const dirs = [...armed].map(([dir, state]) => `  ${relativeOf(dir) || "."}${state.suspect ? " [suspect, polled]" : ""}: last listing [${state.lastListing.join(", ")}]; snapshot [${[...(state.entries ?? [])].map(([name, sig]) => `${name}=${sig}`).join(", ")}]`)
      return `armed directories (${armed.size}):\n${dirs.join("\n")}\nlast ${log.length} notes:\n${log.map((line) => `  ${line}`).join("\n")}`
    },
    close() {
      closed = true
      if (poller) clearInterval(poller)
      poller = undefined
      for (const state of armed.values()) {
        clearTimeout(state.timer)
        state.handle.close()
      }
      armed.clear()
    },
  }
}
