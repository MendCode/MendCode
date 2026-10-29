import { lstatSync, readFileSync, realpathSync } from "node:fs"
import path from "node:path"

export const CHANNEL_FILE_LIMIT = 20 * 1024 * 1024

const SENSITIVE_NAME = [/^\.env(\..*)?$/i, /^\.(npmrc|netrc|pgpass|git-credentials)$/i, /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i, /\.(pem|key|p12|pfx|keystore|jks)$/i, /^credentials(\..*)?$/i, /^remote-tokens\.json$/i, /^telegram-token$/i]
const SENSITIVE_DIR = new Set([".git", ".ssh", ".aws", ".gnupg", ".kube"])

export type ChannelFile = { ok: true; name: string; bytes: Uint8Array } | { ok: false; reason: string }

function inside(root: string, target: string) {
  const relative = path.relative(root, target)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

/**
 * A file a paired chat asks for. It must resolve (symlinks included) inside the session's project, outside the daemon's
 * data directory, be a regular file under the size limit and not look like a credential. The refusal never reveals paths outside the project.
 */
export function readChannelFile({ directory, dataDir, input }: { directory: string; dataDir: string; input: string }): ChannelFile {
  const wanted = input.trim()
  if (!wanted || wanted.length > 1000 || wanted.includes("\0")) return { ok: false, reason: "give a file path inside the project" }
  let root: string, target: string
  try {
    root = realpathSync(directory)
    target = realpathSync(path.resolve(root, wanted))
  } catch { return { ok: false, reason: "no such file in the project" } }
  if (!inside(root, target)) return { ok: false, reason: "only files inside the project can be sent" }
  let data: string | undefined
  try { data = realpathSync(dataDir) } catch {}
  if (data && inside(data, target)) return { ok: false, reason: "that file is private to MendCode" }
  const parts = path.relative(root, target).split(path.sep)
  if (parts.slice(0, -1).some((part) => SENSITIVE_DIR.has(part)) || SENSITIVE_NAME.some((pattern) => pattern.test(parts.at(-1)!))) return { ok: false, reason: "that file looks like a credential and is not sent" }
  const stat = lstatSync(target)
  if (!stat.isFile()) return { ok: false, reason: "not a regular file" }
  if (stat.size > CHANNEL_FILE_LIMIT) return { ok: false, reason: `file is larger than ${CHANNEL_FILE_LIMIT / 1024 / 1024} MB` }
  if (stat.size === 0) return { ok: false, reason: "file is empty" }
  try { return { ok: true, name: path.basename(target), bytes: new Uint8Array(readFileSync(target)) } } catch { return { ok: false, reason: "could not read the file" } }
}
