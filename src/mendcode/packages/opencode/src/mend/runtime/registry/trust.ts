import { createHash } from "crypto"
import { existsSync } from "fs"
import { readdir, readFile } from "fs/promises"
import path from "path"
import { MEND_PACKAGE_MANIFEST_CANDIDATES } from "./package-manifest"
import type { RuntimeRegistryEntry } from "./types"

const blockedMendcodeApplySegments = new Set([
  "auth",
  "runs",
  "cache",
  "generated",
  "node_modules",
])

export function isApplyAllowed(rel: string) {
  const normalized = rel.split(path.sep).join(path.posix.sep)
  if (normalized === "mend-package.json") return true
  const parts = normalized.split("/")
  if (parts[0] !== ".mendcode") return false
  if (blockedMendcodeApplySegments.has(parts[1] || "")) return false
  if (normalized.includes("/.env")) return false
  if ([
    "mend-package.json",
    ".mendcode/mendcode.json",
    ".mendcode/models.yaml",
    ".mendcode/package.json",
    ".mendcode/prompt-mode.json",
    ".mendcode/runtime-pack.json",
  ].includes(normalized)) return true
  if (/^\.mendcode\/focus\/[^/]+\.ya?ml$/.test(normalized)) return true
  if (/^\.mendcode\/commands\/.+\.md$/.test(normalized)) return true
  if (/^\.mendcode\/agents\/.+\.md$/.test(normalized)) return true
  if (/^\.mendcode\/skills\/.+\/SKILL\.md$/.test(normalized)) return true
  if (/^\.mendcode\/prompts\/.+\.md$/.test(normalized)) return true
  if (/^\.mendcode\/mcp\/.+\.jsonc?$/.test(normalized)) return true
  if (/^\.mendcode\/context\/(project|summary)\.md$/.test(normalized)) return true
  if (normalized === ".mendcode/context/refresh.json") return true
  if (normalized === ".mendcode/tui/profile.json") return true
  if (normalized === ".mendcode/worktree/policy.yaml") return true
  if (/^\.mendcode\/imports\/.+\.json$/.test(normalized)) return true
  return false
}

async function listFilesRecursive(root: string) {
  const out: string[] = []
  async function walk(dir: string) {
    if (!existsSync(dir)) return
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(full)
      else out.push(full)
    }
  }
  await walk(root)
  return out.sort()
}

export async function digestApplicableSource(stageDir: string) {
  const sourceMend = path.join(stageDir, ".mendcode")
  const files = existsSync(sourceMend)
    ? (await listFilesRecursive(sourceMend))
      .map((file) => ({ file, rel: path.relative(stageDir, file) }))
      .filter((item) => isApplyAllowed(item.rel))
    : existsSync(path.join(stageDir, "runtime-pack.json"))
      ? [{ file: path.join(stageDir, "runtime-pack.json"), rel: "runtime-pack.json" }]
      : MEND_PACKAGE_MANIFEST_CANDIDATES
        .map((candidate) => ({
          file: path.join(stageDir, candidate),
          rel: candidate.split(path.sep).join(path.posix.sep),
        }))
        .filter((item) => existsSync(item.file))
  const hash = createHash("sha256")
  for (const item of files.sort((a, b) => a.rel.localeCompare(b.rel))) {
    const body = await readFile(item.file)
    hash.update(item.rel.split(path.sep).join(path.posix.sep))
    hash.update("\0")
    hash.update(createHash("sha256").update(body).digest("hex"))
    hash.update("\0")
  }
  return {
    algorithm: "sha256" as const,
    value: hash.digest("hex"),
    files: files.map((item) => item.rel.split(path.sep).join(path.posix.sep)),
  }
}

export function verifyRegistryTrust(entry: RuntimeRegistryEntry, digest: { algorithm: "sha256"; value: string }) {
  const warnings: string[] = []
  const required = entry.trustPolicy?.requireSignature === true
  if (!entry.signature) {
    if (required) throw new Error(`Registry source ${entry.id} requires a sha256 signature but none is configured`)
    if (entry.trust !== "local") warnings.push(`Registry source ${entry.id} is ${entry.trust} trust and unsigned; use --signature sha256:<digest> --require-signature to pin it`)
    return { signed: false, verified: false, warnings }
  }
  if (entry.signature.algorithm !== digest.algorithm || entry.signature.value !== digest.value) {
    throw new Error(`Registry source ${entry.id} signature mismatch: expected sha256:${entry.signature.value}, got sha256:${digest.value}`)
  }
  return { signed: true, verified: true, warnings }
}

export function privateGitReadiness(entry: RuntimeRegistryEntry) {
  if (entry.type !== "private-git") return null
  const tokenEnv = entry.privateGit?.tokenEnv || null
  return {
    credentialMode: entry.privateGit?.credentialMode || "ssh-or-git-credential-helper",
    tokenEnv,
    tokenPresent: tokenEnv ? Boolean(process.env[tokenEnv]) : false,
    storesCredentialsInRegistry: false,
    note: tokenEnv
      ? `Uses ${tokenEnv} through Git environment config without writing the token to .mendcode.`
      : "Uses SSH agent or the user's existing Git credential helper; prompts are disabled during fetch.",
  }
}
