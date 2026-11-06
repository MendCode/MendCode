import { stat } from "node:fs/promises"
import { join } from "node:path"
import type { FileDiff } from "./context"

/** Optional, read-only caller evidence. Loaded only for a funded deferred reader, never at startup. */
export async function graftCallers(directory: string, files: readonly FileDiff[], executable?: string): Promise<string | undefined> {
  try {
    if (!(await stat(join(directory, "graft"))).isDirectory()) return undefined
    const cli = executable ?? Bun.which("graft")
    if (!cli) return undefined
    const symbols = new Set(files.flatMap((file) => [...file.text.slice(0, 16_000).matchAll(/^[+-]export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|interface|type)\s+([A-Za-z_$][\w$]*)/gm)].map((match) => match[1]!)))
    const out: string[] = []
    for (const symbol of [...symbols].slice(0, 4)) {
      const child = Bun.spawn([cli, "callers", symbol], { cwd: directory, stdin: "ignore", stdout: "pipe", stderr: "ignore" })
      const timer = setTimeout(() => child.kill(), 2_000)
      try {
        const reader = child.stdout.getReader()
        const chunks: Uint8Array[] = []
        let bytes = 0
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          chunks.push(value.subarray(0, Math.max(0, 4_000 - bytes))); bytes += value.length
          if (bytes >= 4_000) { child.kill(); break }
        }
        if (await child.exited === 0) out.push(`${symbol}: ${Buffer.concat(chunks).toString("utf8")}`)
      } finally { clearTimeout(timer) }
    }
    return out.join("\n").slice(0, 4_000) || undefined
  } catch { return undefined }
}
