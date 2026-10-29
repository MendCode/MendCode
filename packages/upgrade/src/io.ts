import { chmod, copyFile, lstat, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { verifyProvenance } from "./provenance"
import { UpgradeError } from "./errors"
import type { UpgradeFs, UpgradePorts } from "./ports"
import { DOWNLOAD_TIMEOUT_MS, FETCH_TIMEOUT_MS, GITHUB_API, MAX_DOWNLOAD_BYTES, MAX_JSON_BYTES, PRIVATE_REPO_HINT, TOKEN_ENVS } from "./settings"

const HEADERS = { accept: "application/vnd.github+json, application/octet-stream", "user-agent": "mendcode-upgrade" }

/** Reads a response body up to `limit` bytes; a bigger body is refused, not buffered. */
async function readBody(response: Response, limit: number, what: string) {
  const declared = Number(response.headers.get("content-length") ?? 0)
  if (declared > limit) throw new UpgradeError("network", `${what} is larger than ${limit} bytes`)
  const reader = response.body?.getReader()
  if (!reader) return new Uint8Array(await response.arrayBuffer())
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > limit) {
      await reader.cancel()
      throw new UpgradeError("network", `${what} is larger than ${limit} bytes`)
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

/** How a client without a token or with one reads GitHub; injected so tests never reach the network. */
export type GithubAccess = { fetch: typeof fetch; token: () => Promise<string | undefined> }

const TOKEN_SHAPE = /^[A-Za-z0-9_.-]{20,255}$/
const GITHUB_API_HOST = new URL(GITHUB_API).host

/** `GH_TOKEN`, then `GITHUB_TOKEN`, then `gh auth token`; a value that does not look like a token is ignored. */
export async function findGithubToken(env: Record<string, string | undefined> = process.env, runGh: () => Promise<string> = ghAuthToken) {
  for (const name of TOKEN_ENVS) {
    const value = env[name]?.trim()
    if (value && TOKEN_SHAPE.test(value)) return value
  }
  const value = await runGh().catch(() => "")
  return TOKEN_SHAPE.test(value.trim()) ? value.trim() : undefined
}

/** One lookup serves the several requests of an upgrade; a long-lived daemon asks again after a minute. */
function rememberedToken(ttlMs = 60_000) {
  let found: { at: number; token: Promise<string | undefined> } | undefined
  return () => {
    if (!found || Date.now() - found.at > ttlMs) found = { at: Date.now(), token: findGithubToken() }
    return found.token
  }
}

async function ghAuthToken() {
  const child = Bun.spawn(["gh", "auth", "token"], { stdin: "ignore", stdout: "pipe", stderr: "ignore" })
  const timeout = setTimeout(() => child.kill(), 10_000)
  try {
    const [text, code] = await Promise.all([new Response(child.stdout).text(), child.exited])
    return code === 0 ? text : ""
  } finally { clearTimeout(timeout) }
}

/**
 * One GET. The token goes to api.github.com only: an API asset URL answers with a redirect to a signed storage URL, which is
 * followed without the token, so the credential never reaches another host.
 */
export async function get(url: string, timeoutMs: number, limit: number, access: GithubAccess) {
  if (!url.startsWith("https://")) throw new UpgradeError("network", `refusing a non-https URL: ${url}`)
  const token = new URL(url).host === GITHUB_API_HOST ? await access.token() : undefined
  const headers: Record<string, string> = { ...HEADERS, ...(token ? { authorization: `Bearer ${token}` } : {}) }
  if (/\/releases\/assets\/\d+$/.test(url)) headers.accept = "application/octet-stream"
  let response = await access.fetch(url, { headers, redirect: token ? "manual" : "follow", signal: AbortSignal.timeout(timeoutMs) })
  if (token && response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location") ?? ""
    if (!location.startsWith("https://")) throw new UpgradeError("network", `${url} redirected to a non-https location`)
    response = await access.fetch(location, { headers: { ...HEADERS, accept: "application/octet-stream" }, redirect: "follow", signal: AbortSignal.timeout(timeoutMs) })
  }
  if (!response.ok) {
    const hint = [401, 403, 404].includes(response.status) && new URL(url).host === GITHUB_API_HOST ? token ? "; the token cannot read this repository (it needs read access to its contents)" : `; ${PRIVATE_REPO_HINT}` : ""
    throw new UpgradeError("network", `${url} answered ${response.status}${hint}`)
  }
  return readBody(response, limit, url)
}

export const nodeFs: UpgradeFs = {
  readBytes: (file) => readFile(file),
  lock: async (dir) => {
    await mkdir(dir, { recursive: true })
    for (const relative of ["bin", "bin/mendcode-next", "bin/mendcode-next.prev", "bin/mendcode-next.new", "upgrade.json", "upgrade.json.tmp", "upgrade-recovery.json", "upgrade-recovery.json.tmp"]) {
      const entry = await lstat(path.join(dir, relative)).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return undefined })
      if (entry?.isSymbolicLink()) throw new UpgradeError("bad-data-dir", "updater paths cannot be symbolic links")
    }
    const file = path.join(dir, "upgrade.lock")
    const handle = await open(file, "wx", 0o600).catch(() => { throw new UpgradeError("busy", "another update/channel operation owns upgrade.lock; verify its owner before recovering it") })
    await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: Date.now() }))
    return async () => { await handle.close(); await rm(file, { force: true }) }
  },
  mkdir: async (dir) => void (await mkdir(dir, { recursive: true })),
  writeFile: (file, bytes) => writeFile(file, bytes),
  chmod: (file, mode) => chmod(file, mode),
  rename: (from, to) => rename(from, to),
  copyFile: (from, to) => copyFile(from, to),
  exists: (file) =>
    stat(file).then(
      () => true,
      () => false,
    ),
  remove: (file) => rm(file, { force: true }),
  readText: (file) =>
    readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    }),
}

/** The real ports: GitHub over HTTPS (with the user's token when there is one) and the local filesystem. */
export function createNodePorts(access: GithubAccess = { fetch, token: rememberedToken() }): UpgradePorts {
  return {
    fetchJson: async (url) => JSON.parse(new TextDecoder().decode(await get(url, FETCH_TIMEOUT_MS, MAX_JSON_BYTES, access))),
    // With a token the API endpoint of the asset is used (the only link a private repository serves); without one, the public link.
    download: async (url, maxBytes = MAX_DOWNLOAD_BYTES, apiUrl) => get((apiUrl && await access.token()) ? apiUrl : url, DOWNLOAD_TIMEOUT_MS, Math.min(maxBytes, MAX_DOWNLOAD_BYTES), access),
    fs: nodeFs,
    now: Date.now,
    verifyProvenance,
  }
}
