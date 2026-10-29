import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { UpgradeError } from "./errors"
import type { Platform } from "./releases"
import { OIDC_ISSUER, VERIFY_TIMEOUT_MS } from "./settings"

export type VerificationRunner = (args: string[], directory: string) => Promise<number>

/** The keyless certificate identity of the release workflow run for one tag; it must match what `release.yml` signs under. */
export const signerIdentity = (repo: string, tag: string) => `https://github.com/${repo}/.github/workflows/release.yml@refs/tags/${tag}`

export const attestationArgs = (file: string, repo: string, tag: string) => [
  "gh", "attestation", "verify", file, "--repo", repo,
  "--signer-workflow", `${repo}/.github/workflows/release.yml`,
  "--source-ref", `refs/tags/${tag}`, "--deny-self-hosted-runners",
]

export const cosignArgs = (file: string, bundle: string, repo: string, tag: string) => [
  "cosign", "verify-blob", "--bundle", bundle,
  "--certificate-identity", signerIdentity(repo, tag),
  "--certificate-oidc-issuer", OIDC_ISSUER, file,
]

const run: VerificationRunner = async (args, directory) => {
  // The Sigstore trust root and cosign's cache stay in the temporary directory, like the installers' staging directory.
  const env = { ...process.env, GH_CONFIG_DIR: directory, TUF_ROOT: path.join(directory, "tuf"), XDG_CACHE_HOME: path.join(directory, "cache") }
  const child = Bun.spawn(args, { cwd: directory, stdout: "ignore", stderr: "ignore", env })
  const timeout = setTimeout(() => child.kill(), VERIFY_TIMEOUT_MS)
  try { return await child.exited } finally { clearTimeout(timeout) }
}

const missingTool = (error: unknown) => error instanceof Error && ("code" in error && error.code === "ENOENT" || /ENOENT|not found|no such file/i.test(error.message))

/**
 * Fail closed: the exact bytes, repository, workflow and source tag must be attested (public repositories), or, with a
 * `bundle`, signed by that workflow's keyless cosign identity (private repositories, which GitHub does not attest).
 */
export async function verifyProvenance(input: { bytes: Uint8Array; bundle?: Uint8Array; repo: string; tag: string; platform: Platform; metadata?: boolean }, runner: VerificationRunner = run) {
  const directory = await mkdtemp(path.join(tmpdir(), "mendcode-verify-"))
  const file = path.join(directory, "candidate")
  try {
    await writeFile(file, input.bytes, { mode: 0o600 })
    if (input.bundle) {
      const bundle = path.join(directory, "candidate.sigstore.json")
      await writeFile(bundle, input.bundle, { mode: 0o600 })
      try {
        if (await runner(cosignArgs(file, bundle, input.repo, input.tag), directory) !== 0) throw new Error("cosign signature verification failed")
      } catch (error) {
        if (missingTool(error)) throw new UpgradeError("verifier-missing", "cosign is not installed; it verifies the signature of releases GitHub does not attest (install cosign 2.6.1 or newer)")
        throw error
      }
    } else if (await runner(attestationArgs(file, input.repo, input.tag), directory) !== 0) throw new Error("attestation verification failed")
    if (input.platform.os === "darwin" && !input.metadata) {
      await chmod(file, 0o755)
      if (await runner(["/usr/bin/codesign", "--verify", "--strict", file], directory) !== 0) throw new Error("Darwin signature verification failed")
    }
  } catch (error) {
    if (error instanceof UpgradeError) throw error
    throw new UpgradeError("provenance", `${error instanceof Error ? error.message : "verification failed"}; install blocked (${input.bundle ? "the cosign signature of the release is required" : "gh and release attestations are required"})`)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
