import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"

/**
 * Instruction URLs from the user's own settings (`instructions: ["https://…"]`, as v1 and opencode read them). The prompt is
 * built synchronously from files, so each URL is downloaded in the background into `<data dir>/instructions-remote/` and the
 * instruction loader reads that copy: the first prompt after adding a URL may not have it yet, later ones do. A copy is
 * refreshed when older than `REFRESH_MS`; a failed download keeps the last good copy. A project's own config never adds URLs
 * (project-control.ts blocks them): a repository cannot pull text into the prompt that changes after it was reviewed.
 */

export const REMOTE_INSTRUCTIONS_DIR = "instructions-remote"
const REFRESH_MS = 10 * 60_000
const TIMEOUT_MS = 5_000
const MAX_BYTES = 64 * 1024

export const isInstructionUrl = (raw: string) => /^https:\/\//i.test(raw)

/** The copy's file name: readable in the prompt's `source` label, unique per URL. */
export function remoteFileName(url: string) {
  const parsed = new URL(url)
  const readable = `${parsed.host}${parsed.pathname}`.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80)
  return `${readable || "instructions"}-${Bun.hash(url).toString(16).slice(0, 8)}.md`
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>

const caches = new Map<string, ReturnType<typeof createCache>>()

function createCache(input: { dir: string; fetch: Fetch; now: () => number; log: (line: string) => void }) {
  const folder = path.join(input.dir, REMOTE_INSTRUCTIONS_DIR)
  const running = new Map<string, Promise<void>>()
  const tried = new Map<string, number>()
  /** When each copy was last downloaded by this daemon; a copy from an earlier run is refreshed once on first use. */
  const fetched = new Map<string, number>()

  async function download(url: string) {
    const file = path.join(folder, remoteFileName(url))
    try {
      const response = await input.fetch(url, { redirect: "follow", signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: "text/markdown, text/plain;q=0.9, */*;q=0.1" } })
      if (!isInstructionUrl(response.url || url)) throw new Error("redirected away from https")
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const bytes = new Uint8Array(await response.arrayBuffer())
      if (bytes.byteLength > MAX_BYTES) throw new Error(`larger than ${MAX_BYTES / 1024} KB`)
      mkdirSync(folder, { recursive: true })
      const temporary = `${file}.${process.pid}.tmp`
      writeFileSync(temporary, bytes, { mode: 0o600 })
      renameSync(temporary, file)
      fetched.set(url, input.now())
    } catch (error) {
      input.log(`[INSTRUCTIONS]: ${url}: not downloaded (${error instanceof Error ? error.message : String(error)})${existsSync(file) ? "; the last copy stays" : ""}`)
    }
  }

  /** Starts a download when the copy is missing or old (at most one at a time per URL, and not again within the refresh time after a failure). */
  function refresh(url: string) {
    const age = input.now() - (fetched.get(url) ?? -Infinity)
    const lastTry = tried.get(url) ?? -Infinity
    if (age < REFRESH_MS || input.now() - lastTry < REFRESH_MS || running.has(url)) return running.get(url)
    tried.set(url, input.now())
    const job = download(url).finally(() => running.delete(url))
    running.set(url, job)
    return job
  }

  return {
    /** The local copy of `url` (refreshing it in the background), or undefined while there is none yet. */
    pathFor(url: string): string | undefined {
      void refresh(url)
      const file = path.join(folder, remoteFileName(url))
      return existsSync(file) ? file : undefined
    },
    /** Downloads every URL that has no fresh copy; resolves when they are done (startup, settings changes, tests). */
    async prefetch(urls: readonly string[]) {
      await Promise.all(urls.filter(isInstructionUrl).map((url) => refresh(url)))
    },
  }
}

/** One cache per data directory, shared by the prompt's loader and the project report. */
export function remoteInstructions(dir: string, overrides: { fetch?: Fetch; now?: () => number; log?: (line: string) => void } = {}) {
  let cache = caches.get(dir)
  if (!cache || Object.keys(overrides).length) {
    cache = createCache({ dir, fetch: overrides.fetch ?? ((url, init) => fetch(url, init)), now: overrides.now ?? Date.now, log: overrides.log ?? ((line) => console.error(line)) })
    caches.set(dir, cache)
  }
  return cache
}
