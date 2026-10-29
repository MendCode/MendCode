import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { parseUpgradeArgs, upgradeText } from "../src/command"
import { UpgradeError } from "../src/errors"
import { binPaths } from "../src/install"
import { findGithubToken, get, type GithubAccess } from "../src/io"
import { cosignArgs, signerIdentity, verifyProvenance } from "../src/provenance"
import { parseReleases } from "../src/releases"
import { UPGRADE_REPO } from "../src/settings"
import { resolveRepo, runUpgrade, type UpgradeRequest } from "../src/upgrade"
import { fakePorts, LINUX_X64, release, REPO, tempDir } from "./helpers"

const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })
function box() {
  const tmp = tempDir()
  cleanups.push(tmp.cleanup)
  const dataDir = path.join(tmp.dir, "data")
  const request = (extra: Partial<UpgradeRequest> = {}): UpgradeRequest => ({ dataDir, home: tmp.dir, repo: REPO, channel: "nightly", check: false, force: false, rollback: false, currentVersion: "0.0.1-dev", platform: LINUX_X64, ...extra })
  return { dataDir, request, paths: binPaths(dataDir) }
}
const NIGHTLY = "v0.0.1-nightly.20261005.12"
const nightly = (tag = NIGHTLY, extra: Partial<Parameters<typeof release>[0]> = {}) =>
  release({ tag, prerelease: true, mode: "cosign", binaries: { [`mendcode-${tag.slice(1)}-linux-x64`]: tag }, ...extra })

describe("command line", () => {
  test("--require-signature parses for an install only and never with --allow-unsigned", () => {
    expect(parseUpgradeArgs(["upgrade", "--require-signature"])).toMatchObject({ ok: true, command: { requireSignature: true } })
    expect(parseUpgradeArgs(["upgrade", "--require-signature", "--check"])).toEqual({ ok: false, message: "--require-signature only applies to an install" })
    expect(parseUpgradeArgs(["upgrade", "--require-signature", "--allow-unsigned"])).toEqual({ ok: false, message: "--require-signature and --allow-unsigned contradict each other" })
  })

  test("--channel nightly and --allow-unsigned parse for an install; --allow-unsigned is refused with --check, --inspect, --set and --rollback", () => {
    expect(parseUpgradeArgs(["upgrade", "--channel", "nightly", "--allow-unsigned"])).toEqual({ ok: true, command: { json: false, channel: "nightly", check: false, force: false, rollback: false, allowUnsigned: true, help: false } })
    for (const extra of [["--check"], ["--inspect"], ["--set", "--channel", "nightly"], ["--rollback"]]) {
      expect(parseUpgradeArgs(["upgrade", "--allow-unsigned", ...extra])).toEqual({ ok: false, message: "--allow-unsigned only applies to an install" })
    }
  })

  test("the install text names what vouched for the binary, and warns when only the SHA256 did", () => {
    const base = { status: "installed", channel: "nightly", current: "0.0.1-dev", latest: NIGHTLY, downgrade: false, installedTo: "/d/bin/mendcode-next", asset: "a", rollbackAvailable: false } as const
    expect(upgradeText({ ...base, verification: "cosign" }, { check: false })).toContain("verified: SHA256 and the cosign signature")
    expect(upgradeText({ ...base, verification: "checksum-only" }, { check: false })).toContain("WARNING: verified by SHA256 only")
  })
})

describe("the default release repository", () => {
  test("is MendCode/MendCode without any environment variable; the variable still overrides it", () => {
    expect(UPGRADE_REPO).toBe("MendCode/MendCode")
    expect(resolveRepo({})).toBe("MendCode/MendCode")
    expect(resolveRepo({ MENDCODE_UPGRADE_REPO: "" })).toBe("MendCode/MendCode")
    expect(resolveRepo({ MENDCODE_UPGRADE_REPO: "acme/mirror" })).toBe("acme/mirror")
  })
})

describe("nightly channel on a repository GitHub does not attest", () => {
  test("installs the newest nightly after verifying the signed SHA256SUMS, the index digest and the binary bundle", async () => {
    const h = box()
    const fake = fakePorts([nightly("v0.0.1-nightly.20261004.30"), nightly(NIGHTLY), nightly("v0.0.1-nightly.20261005.9")])
    const result = await runUpgrade(h.request(), fake.ports)
    expect(result).toMatchObject({ status: "installed", channel: "nightly", latest: NIGHTLY, verification: "cosign" })
    expect(readFileSync(h.paths.current, "utf8")).toBe(NIGHTLY)
    expect(fake.verified).toEqual([
      { bundle: "bundle of SHA256SUMS", metadata: true, tag: NIGHTLY, repo: REPO },
      { bundle: `bundle of mendcode-0.0.1-nightly.20261005.12-linux-x64`, metadata: false, tag: NIGHTLY, repo: REPO },
    ])
  })

  test("a nightly with no signature bundle, a bad index digest or a failing signature installs nothing", async () => {
    for (const [name, make, expected] of [
      ["no SHA256SUMS bundle", () => nightly(NIGHTLY, { without: ["SHA256SUMS.sigstore.json"] }), "SHA256SUMS.sigstore.json signature bundle"],
      ["no binary bundle", () => nightly(NIGHTLY, { without: [`mendcode-${NIGHTLY.slice(1)}-linux-x64.sigstore.json`] }), "signature bundle"],
      ["no digest for the release index", () => nightly(NIGHTLY, { sums: `${"a".repeat(64)}  mendcode-${NIGHTLY.slice(1)}-linux-x64\n` }), "SHA256SUMS"],
    ] as const) {
      const h = box()
      await expect(runUpgrade(h.request(), fakePorts([make()]).ports)).rejects.toThrow(expected)
      expect([name, existsSync(h.paths.current)]).toEqual([name, false])
    }
    const h = box()
    const fake = fakePorts([nightly()])
    fake.ports.verifyProvenance = async () => { throw new UpgradeError("provenance", "cosign signature verification failed") }
    await expect(runUpgrade(h.request({ allowUnsigned: true }), fake.ports)).rejects.toThrow("cosign signature verification failed")
    expect(existsSync(h.paths.current)).toBe(false)
  })

  test("without cosign it installs after the SHA256 check and says so; --require-signature refuses instead", async () => {
    const missing = async () => { throw new UpgradeError("verifier-missing", "cosign is not installed; install cosign 2.6.1 or newer") }
    const strict = box()
    const first = fakePorts([nightly()])
    first.ports.verifyProvenance = missing
    await expect(runUpgrade(strict.request({ requireSignature: true }), first.ports)).rejects.toThrow("--require-signature")
    expect(existsSync(strict.paths.current)).toBe(false)

    const plain = box()
    const second = fakePorts([nightly()])
    second.ports.verifyProvenance = missing
    expect(await runUpgrade(plain.request(), second.ports)).toMatchObject({ status: "installed", verification: "checksum-only" })
    expect(readFileSync(plain.paths.current, "utf8")).toBe(NIGHTLY)

    const mismatch = box()
    const third = fakePorts([nightly(NIGHTLY, { binaries: { [`mendcode-${NIGHTLY.slice(1)}-linux-x64`]: "x" }, sums: `${"0".repeat(64)}  mendcode-${NIGHTLY.slice(1)}-linux-x64\n${"0".repeat(64)}  release-index.json\n` })])
    third.ports.verifyProvenance = missing
    await expect(runUpgrade(mismatch.request(), third.ports)).rejects.toThrow("does not match SHA256SUMS")
  })

  test("a public release with cosign bundles and GitHub provenance is checked through cosign, which needs no GitHub account", async () => {
    const tag = NIGHTLY
    const asset = `mendcode-${tag.slice(1)}-linux-x64`
    const both = nightly(tag)
    both.json.assets.push({ name: "provenance.sigstore.json", browser_download_url: `https://example.test/provenance/${tag}`, url: "https://api.github.com/repos/MendCode/MendCode/releases/assets/1" })
    both.files.set(`https://example.test/provenance/${tag}`, new TextEncoder().encode("provenance"))
    const h = box()
    const fake = fakePorts([both])
    expect(await runUpgrade(h.request(), fake.ports)).toMatchObject({ status: "installed", verification: "cosign" })
    expect(fake.verified.map((call) => call.bundle)).toEqual(["bundle of SHA256SUMS", `bundle of ${asset}`])
  })

  test("a release that carries GitHub provenance still goes through the attestation path", async () => {
    const h = box()
    const fake = fakePorts([release({ tag: NIGHTLY, prerelease: true, mode: "attested", binaries: { [`mendcode-${NIGHTLY.slice(1)}-linux-x64`]: "attested" } })])
    expect(await runUpgrade(h.request(), fake.ports)).toMatchObject({ status: "installed", verification: "attestation" })
    expect(fake.verified.every((call) => call.bundle === undefined)).toBe(true)
    expect(fake.verified).toHaveLength(2)
  })

  test("a private-repository release that a stable or beta user never sees stays out of the nightly channel and the reverse", async () => {
    const h = box()
    const rows = [nightly(), release({ tag: "v0.0.1-beta.2", prerelease: true, mode: "cosign", binaries: { "mendcode-0.0.1-beta.2-linux-x64": "b" } }), release({ tag: "v0.0.1", mode: "cosign", binaries: { "mendcode-0.0.1-linux-x64": "s" } })]
    expect((await runUpgrade(h.request({ check: true }), fakePorts(rows).ports)).latest).toBe(NIGHTLY)
    expect((await runUpgrade(h.request({ check: true, channel: "beta" }), fakePorts(rows).ports)).latest).toBe("v0.0.1-beta.2")
    expect((await runUpgrade(h.request({ check: true, channel: "stable" }), fakePorts(rows).ports)).latest).toBe("v0.0.1")
  })
})

describe("cosign verification of one payload", () => {
  test("pins the exact tag identity of MendCode/MendCode and the GitHub OIDC issuer", () => {
    expect(signerIdentity("MendCode/MendCode", NIGHTLY)).toBe(`https://github.com/MendCode/MendCode/.github/workflows/release.yml@refs/tags/${NIGHTLY}`)
    expect(cosignArgs("/f", "/f.sigstore.json", "MendCode/MendCode", NIGHTLY)).toEqual([
      "cosign", "verify-blob", "--bundle", "/f.sigstore.json",
      "--certificate-identity", `https://github.com/MendCode/MendCode/.github/workflows/release.yml@refs/tags/${NIGHTLY}`,
      "--certificate-oidc-issuer", "https://token.actions.githubusercontent.com", "/f",
    ])
  })

  test("writes the bytes and the bundle to a temporary directory, runs cosign, then removes the directory", async () => {
    const calls: string[][] = []
    let directory = ""
    await verifyProvenance({ bytes: new TextEncoder().encode("binary"), bundle: new TextEncoder().encode("bundle"), repo: REPO, tag: NIGHTLY, platform: LINUX_X64 }, async (args, dir) => {
      calls.push(args)
      directory = dir
      expect(readFileSync(path.join(dir, "candidate"), "utf8")).toBe("binary")
      expect(readFileSync(path.join(dir, "candidate.sigstore.json"), "utf8")).toBe("bundle")
      return 0
    })
    expect(calls).toEqual([cosignArgs(path.join(directory, "candidate"), path.join(directory, "candidate.sigstore.json"), REPO, NIGHTLY)])
    expect(existsSync(directory)).toBe(false)
  })

  test("a failing signature blocks; a missing cosign binary is reported as a missing verifier", async () => {
    const input = { bytes: new Uint8Array(), bundle: new Uint8Array(), repo: REPO, tag: NIGHTLY, platform: LINUX_X64 }
    await expect(verifyProvenance(input, async () => 1)).rejects.toThrow("cosign signature of the release is required")
    const error = (await verifyProvenance(input, async () => { throw Object.assign(new Error("Executable not found in $PATH: \"cosign\""), { code: "ENOENT" }) }).catch((caught: unknown) => caught)) as UpgradeError
    expect(error).toMatchObject({ code: "verifier-missing" })
    expect(error.message).toContain("cosign")
  })
})

describe("reading a private repository", () => {
  const TOKEN = "ghp_" + "a".repeat(36)
  const access = (responses: Array<(url: string, init: RequestInit) => Response>, token: string | null = TOKEN) => {
    const seen: Array<{ url: string; headers: Record<string, string>; redirect: string | undefined }> = []
    const queue = [...responses]
    const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url)
      seen.push({ url: target, headers: { ...(init?.headers as Record<string, string>) }, redirect: init?.redirect })
      return queue.shift()!(target, init ?? {})
    }) as typeof fetch
    return { seen, access: { fetch: fetcher, token: async () => token ?? undefined } satisfies GithubAccess }
  }

  test("the token is sent to api.github.com only and the signed storage redirect is followed without it", async () => {
    const asset = "https://api.github.com/repos/MendCode/MendCode/releases/assets/42"
    const storage = "https://release-assets.githubusercontent.com/blob?sig=abc"
    const { seen, access: github } = access([() => new Response(null, { status: 302, headers: { location: storage } }), () => new Response("payload")])
    const bytes = await get(asset, 1000, 1024, github)
    expect(new TextDecoder().decode(bytes)).toBe("payload")
    expect(seen[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`)
    expect(seen[0]!.headers.accept).toBe("application/octet-stream")
    expect(seen[0]!.redirect).toBe("manual")
    expect(seen[1]!.url).toBe(storage)
    expect(seen[1]!.headers.authorization).toBeUndefined()
  })

  test("a public asset link never carries the token, and a redirect away from https is refused", async () => {
    const { seen, access: github } = access([() => new Response("public")])
    await get("https://github.com/MendCode/MendCode/releases/download/v1/x", 1000, 1024, github)
    expect(seen[0]!.headers.authorization).toBeUndefined()
    const insecure = access([() => new Response(null, { status: 302, headers: { location: "http://evil.test/x" } })])
    await expect(get("https://api.github.com/repos/a/b/releases/assets/1", 1000, 1024, insecure.access)).rejects.toThrow("non-https")
  })

  test("a 404 from the API says how to authenticate when there is no token, and what is missing when there is one", async () => {
    const anonymous = access([() => new Response("{}", { status: 404 })], null)
    await expect(get("https://api.github.com/repos/MendCode/MendCode/releases?per_page=100", 1000, 1024, anonymous.access)).rejects.toThrow("gh auth login")
    expect(anonymous.seen[0]!.headers.authorization).toBeUndefined()
    const denied = access([() => new Response("{}", { status: 404 })])
    await expect(get("https://api.github.com/repos/MendCode/MendCode/releases?per_page=100", 1000, 1024, denied.access)).rejects.toThrow("read access")
  })

  test("the token comes from GH_TOKEN, then GITHUB_TOKEN, then gh auth token, and a value that is not a token is ignored", async () => {
    const ghOutput = async () => `gho_${"b".repeat(36)}\n`
    expect(await findGithubToken({ GH_TOKEN: TOKEN, GITHUB_TOKEN: "ghp_" + "c".repeat(36) }, ghOutput)).toBe(TOKEN)
    expect(await findGithubToken({ GITHUB_TOKEN: "ghp_" + "c".repeat(36) }, ghOutput)).toBe("ghp_" + "c".repeat(36))
    expect(await findGithubToken({}, ghOutput)).toBe(`gho_${"b".repeat(36)}`)
    expect(await findGithubToken({ GH_TOKEN: "short" }, async () => "")).toBeUndefined()
    expect(await findGithubToken({}, async () => { throw new Error("gh missing") })).toBeUndefined()
  })

  test("a release read from the API keeps the asset endpoint that serves it to an authenticated client", () => {
    const [row] = parseReleases([release({ tag: NIGHTLY, prerelease: true, mode: "cosign", binaries: { [`mendcode-${NIGHTLY.slice(1)}-linux-x64`]: "x" } }).json])
    expect(row!.assets.every((asset) => /^https:\/\/api\.github\.com\/repos\/acme\/mendcode-test\/releases\/assets\/\d+$/.test(asset.apiUrl ?? ""))).toBe(true)
    const [foreign] = parseReleases([{ tag_name: "v1.0.0", assets: [{ name: "a", browser_download_url: "https://github.com/x/y/releases/download/v1.0.0/a", url: "https://evil.test/assets/1" }] }])
    expect(foreign!.assets[0]!.apiUrl).toBeUndefined()
  })
})
