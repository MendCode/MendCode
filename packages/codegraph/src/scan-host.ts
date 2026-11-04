import path from "node:path"
import { scanFile } from "./indexer"
import type { FileRec } from "./types"
import type { WalkedFile } from "./walk"

/**
 * Scanning a project's files in a process of its own (the compiled binary with `__codegraph-scan`, or `bun scan-host.ts` from
 * source). A terminal that hosts the daemon runs without the DFG tier to hold less memory (apps/cli/src/launcher.ts), and the
 * scanner is the one hot loop that needs it: this repository's 3,288 files took 2.3 s to scan there instead of 1.7. The host
 * starts with the user's environment, every tier on, and its garbage (the files' text, the scanner's tokens) leaves with it.
 */
export type ScanRequest = { cwd: string; files: Array<{ path: string; walked: WalkedFile }> }
/** One line of the host's output per requested file, in the order asked: the record, or null for a file that did not scan. */
export type ScanLine = { path: string; rec: FileRec | null }

/** A first build scans at least this many files before it pays for a process of its own (about 80 ms to start one). */
export const HOSTED_SCAN_FILES = 256

const BUNFS = /^(\/\$bunfs\/|[A-Za-z]:[\\/]~BUN[\\/])/

/** The command line of the scan host: the binary itself when compiled, this file under the same runtime from source. */
export function scanHostCommand(main = Bun.main, executable = process.execPath): string[] {
  return BUNFS.test(main) ? [executable, "__codegraph-scan"] : [executable, path.join(import.meta.dir, "scan-host.ts")]
}

/** The host side: reads one request from stdin and writes a line per file as soon as it is scanned. */
export async function runScanHost() {
  const request = JSON.parse(await Bun.stdin.text()) as ScanRequest
  const out = Bun.stdout.writer()
  for (const { path: file, walked } of request.files) {
    const rec = await scanFile({ cwd: request.cwd, path: file, walked, onScan: undefined })
    out.write(`${JSON.stringify({ path: file, rec: rec ?? null } satisfies ScanLine)}\n`)
    await out.flush()
  }
  await out.end()
}

/**
 * The daemon side: starts the host for `files` and returns their records one at a time, in the order asked. Throws when the host
 * cannot start, dies or answers out of order; the indexer then scans the files left in its own process.
 */
export function hostedScan(input: { command: string[]; request: ScanRequest; signal: AbortSignal }) {
  const child = Bun.spawn(input.command, { stdin: "pipe", stdout: "pipe", stderr: "ignore", env: process.env })
  const kill = () => child.kill()
  input.signal.addEventListener("abort", kill, { once: true })
  child.stdin.write(JSON.stringify(input.request))
  void child.stdin.end()
  const reader = child.stdout.getReader()
  const decoder = new TextDecoder()
  let pending = ""
  async function line(): Promise<string> {
    for (;;) {
      const end = pending.indexOf("\n")
      if (end >= 0) {
        const text = pending.slice(0, end)
        pending = pending.slice(end + 1)
        return text
      }
      const { value, done } = await reader.read()
      if (done) throw new Error("the code graph scan host ended early")
      pending += decoder.decode(value, { stream: true })
    }
  }
  return {
    async next(file: string): Promise<FileRec | undefined> {
      const got = JSON.parse(await line()) as ScanLine
      if (got.path !== file) throw new Error("the code graph scan host answered out of order")
      return got.rec ?? undefined
    },
    close() {
      input.signal.removeEventListener("abort", kill)
      kill()
    },
  }
}

if (import.meta.main) await runScanHost()
