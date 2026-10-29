import { lstatSync, readdirSync, unlinkSync, writeFileSync } from "node:fs"
import path from "node:path"

import { featureOn } from "@mendcode/protocol/wire"
import type { Settings } from "@mendcode/protocol"
import { outputDirectory } from "./output-directory"

/** Command output filters: `features.output_filters`, then `tool_output.filters`, then the tier (balanced and full); off with no tier. */
export function toolOutputSettings(settings: Settings, safeMode?: boolean): NonNullable<Settings["tool_output"]> {
  const own = settings.tool_output
  const on = settings.features?.output_filters ?? own?.filters ?? featureOn(settings, "output_filters", { safeMode })
  return { ...own, filters: on }
}

const MAX_SAVED = 8 * 1024 * 1024
const MAX_TOTAL = 64 * 1024 * 1024
const RETENTION = 24 * 60 * 60 * 1000

/** Disposable tool excerpts have their own disk budget, separate from referenced attachment blobs. */
export function createToolOutputs(dir: string, now = Date.now, write?: (file: string, bytes: Uint8Array) => void) {
  function cleanup() {
    let entries: Array<{ file: string; size: number; time: number }> = []
    try {
      const directory = outputDirectory(dir, "tool-output")
      if (!directory) return
      entries = readdirSync(directory).filter((name) => /^tool-[a-f0-9-]+\.txt$/.test(name)).flatMap((name) => {
        const file = path.join(directory, name)
        try {
          const stat = lstatSync(file)
          if (!stat.isFile() || stat.nlink !== 1) return []
          if (stat.mtimeMs < now() - RETENTION) { unlinkSync(file); return [] }
          return [{ file, size: stat.size, time: stat.mtimeMs }]
        } catch { return [] }
      })
    } catch { return }
    let total = entries.reduce((sum, entry) => sum + entry.size, 0)
    for (const entry of entries.sort((a, b) => a.time - b.time)) {
      if (total <= MAX_TOTAL) break
      try { unlinkSync(entry.file); total -= entry.size } catch {}
    }
  }
  cleanup()
  return {
    cleanup,
    async save(text: string, complete = true) {
      const directory = outputDirectory(dir, "tool-output", true)!
      const bytes = Buffer.from(text)
      const marker = Buffer.from("\n[Saved output capped for disk safety]\n")
      const half = Math.floor((MAX_SAVED - marker.length) / 2)
      let head = half, tail = bytes.length - half
      while (head > 0 && (bytes[head]! & 0xc0) === 0x80) head--
      while (tail < bytes.length && (bytes[tail]! & 0xc0) === 0x80) tail++
      const saved = bytes.length <= MAX_SAVED ? bytes : Buffer.concat([bytes.subarray(0, head), marker, bytes.subarray(tail)])
      const file = path.join(directory, `tool-${crypto.randomUUID()}.txt`)
      if (write) write(file, saved)
      else writeFileSync(file, saved, { mode: 0o600, flag: "wx" })
      cleanup()
      return { path: file, complete: complete && bytes.length <= MAX_SAVED }
    },
  }
}
