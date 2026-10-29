import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import path from "node:path"
import { isUpgradeCommand, parseUpgradeArgs, runUpgradeCommand } from "../src/command"
import { binPaths } from "../src/install"
import { verifyProvenance } from "../src/provenance"
import { channelOf, parseReleases, pickRelease } from "../src/releases"
import { runUpgrade, type UpgradeRequest } from "../src/upgrade"
import { validateReleaseIndex } from "../src/release-index"
import { fakePorts, LINUX_X64, release, REPO, tempDir } from "./helpers"

const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })
function box() {
  const tmp = tempDir()
  cleanups.push(tmp.cleanup)
  const dataDir = path.join(tmp.dir, "data")
  const request = (extra: Partial<UpgradeRequest> = {}): UpgradeRequest => ({ dataDir, home: tmp.dir, repo: REPO, check: false, force: false, rollback: false, currentVersion: "1.0.0", platform: LINUX_X64, ...extra })
  return { dataDir, request, paths: binPaths(dataDir), tmp }
}
const candidate = (version = "1.0.1", body = version) => release({ tag: `v${version}`, prerelease: version.includes("-"), binaries: { [`mendcode-${version}-linux-x64`]: body } })

test("B40 nightly selection orders date and run numerically, ignores draft and wrong prerelease flags", () => {
  const rows = parseReleases([
    release({ tag: "v1.0.0-nightly.20261001.9", prerelease: true }).json,
    release({ tag: "v1.0.0-nightly.20261001.10", prerelease: true }).json,
    release({ tag: "v1.0.0-nightly.20261002.1", prerelease: true, draft: true }).json,
    release({ tag: "v1.0.0-nightly.20261003.1" }).json,
  ])
  expect(pickRelease(rows, "nightly")?.tag).toBe("v1.0.0-nightly.20261001.10")
  expect(rows.map(channelOf)).toEqual(["nightly", "nightly", undefined, undefined])
})

test("B40 target reads the exact tag endpoint, checks without writes/downloads, installs that target", async () => {
  const h = box(), fake = fakePorts([candidate("1.0.1"), candidate("1.0.2")])
  const check = await runUpgrade(h.request({ target: "1.0.1", check: true }), fake.ports)
  expect(check.latest).toBe("v1.0.1")
  expect(fake.requested).toEqual([`https://api.github.com/repos/${REPO}/releases/tags/v1.0.1`])
  expect(existsSync(h.dataDir)).toBe(false)
  await runUpgrade(h.request({ target: "v1.0.1", method: "curl" }), fake.ports)
  expect(readFileSync(h.paths.current, "utf8")).toBe("1.0.1")
})

test("B40 --method and -m parse; unsupported package managers fail before network", async () => {
  expect(parseUpgradeArgs(["upgrade", "1.0.1", "-m", "curl"])).toMatchObject({ ok: true, command: { target: "1.0.1", method: "curl" } })
  expect(isUpgradeCommand(["--dir", "/tmp/data", "update", "1.0.1"])).toBe(true)
  expect(parseUpgradeArgs(["update", "1.0.1"])).toMatchObject({ ok: true, command: { target: "1.0.1" } })
  const h = box(), fake = fakePorts([candidate()])
  for (const method of ["npm", "pnpm", "bun", "brew", "choco", "scoop"]) await expect(runUpgrade(h.request({ method }), fake.ports)).rejects.toThrow("not published")
  expect(fake.requested).toEqual([])
  expect(existsSync(h.dataDir)).toBe(false)
})

test("B40 install fails closed without a verifier or after failed provenance, retaining old bytes", async () => {
  const h = box(), fake = fakePorts([candidate()])
  const { verifyProvenance: _unused, ...unverified } = fake.ports
  await expect(runUpgrade(h.request(), unverified)).rejects.toThrow("verifier unavailable")
  expect(existsSync(h.paths.current)).toBe(false)
  await runUpgrade(h.request(), fake.ports)
  const evil = fakePorts([candidate("1.0.2")])
  evil.ports.verifyProvenance = async () => { throw new Error("bad signer") }
  await expect(runUpgrade(h.request({ currentVersion: "1.0.1" }), evil.ports)).rejects.toThrow("bad signer")
  expect(readFileSync(h.paths.current, "utf8")).toBe("1.0.1")
  expect(existsSync(h.paths.next)).toBe(false)
})

test("B40 provenance pins repo/workflow/tag, checks Darwin signature, cleans verifier staging", async () => {
  const commands: string[][] = []
  let directory = ""
  await verifyProvenance({ bytes: new TextEncoder().encode("binary"), repo: REPO, tag: "v1.0.1", platform: { os: "darwin", arch: "arm64" } }, async (args, dir) => {
    commands.push(args)
    directory = dir
    expect(readFileSync(path.join(dir, "candidate"), "utf8")).toBe("binary")
    return 0
  })
  expect(commands[0]).toEqual(["gh", "attestation", "verify", path.join(directory, "candidate"), "--repo", REPO, "--signer-workflow", `${REPO}/.github/workflows/release.yml`, "--source-ref", "refs/tags/v1.0.1", "--deny-self-hosted-runners"])
  expect(commands[1]).toEqual(["/usr/bin/codesign", "--verify", "--strict", path.join(directory, "candidate")])
  expect(existsSync(directory)).toBe(false)
  await expect(verifyProvenance({ bytes: new Uint8Array(), repo: REPO, tag: "v1.0.1", platform: LINUX_X64 }, async () => 1)).rejects.toThrow("install blocked")
})

test("B40 recovery refuses changed previous bytes and legacy identities, with no activation", async () => {
  const h = box()
  expect(await runUpgrade(h.request(), fakePorts([candidate()]).ports)).toMatchObject({ rollbackAvailable: false })
  expect(await runUpgrade(h.request({ currentVersion: "1.0.1" }), fakePorts([candidate("1.0.2")]).ports)).toMatchObject({ rollbackAvailable: true })
  writeFileSync(h.paths.prev, "tampered")
  const fake = fakePorts([])
  await expect(runUpgrade(h.request({ rollback: true }), fake.ports)).rejects.toThrow("identity changed")
  expect(readFileSync(h.paths.current, "utf8")).toBe("1.0.2")
  expect(fake.requested).toEqual([])
  writeFileSync(path.join(h.dataDir, "upgrade-recovery.json"), "{}")
  await expect(runUpgrade(h.request({ rollback: true }), fake.ports)).rejects.toThrow("external recovery")
})

test("B40 inspect and set channel operate offline, reject incompatible flags, serialize changes", async () => {
  const h = box(), fake = fakePorts([])
  let out = ""
  const deps = { ports: fake.ports, env: {}, home: h.tmp.dir, defaultDir: h.dataDir, currentVersion: "1.0.0", platform: LINUX_X64, out: { write: (text: string) => { out += text } }, err: { write() {} } }
  const run = async (args: string[]) => {
    const parsed = parseUpgradeArgs(["upgrade", ...args])
    if (!parsed.ok) throw new Error(parsed.message)
    return runUpgradeCommand(parsed.command, deps)
  }
  expect(await run(["--inspect", "--json"])).toBe(0)
  expect(JSON.parse(out).data.channel).toBe("stable")
  expect(existsSync(h.dataDir)).toBe(false)
  out = ""
  expect(await run(["--set", "--channel", "nightly", "--json"])).toBe(0)
  expect(JSON.parse(out).data.channel).toBe("nightly")
  const releaseLock = await fake.ports.fs.lock(h.dataDir)
  try { expect(await run(["--set", "--channel", "beta"])).toBe(1) } finally { await releaseLock() }
  expect(fake.requested).toEqual([])
  expect(await run(["channel", "set", "dev"])).toBe(0)
  out = ""
  expect(await run(["channel", "--json"])).toBe(0)
  expect(JSON.parse(out).data.channel).toBe("dev")
  for (const args of [["--set"], ["--inspect", "--check"], ["1.0.0", "--rollback"], ["--set", "--channel", "beta", "--force"]]) expect(parseUpgradeArgs(["upgrade", ...args]).ok).toBe(false)
})

test("B40 attested index rejects wrong repository/tag/channel, duplicates, digest and size", () => {
  const artifact = candidate()
  const file = [...artifact.files].find(([url]) => url.endsWith("release-index.json"))![1]
  const index = JSON.parse(new TextDecoder().decode(file))
  const expected = { repo: REPO, tag: "v1.0.1", channel: "stable" as const, asset: index.assets[0].name, sha256: index.assets[0].sha256, size: index.assets[0].size }
  expect(validateReleaseIndex(index, expected)).toMatchObject({ schema: { version: 1 } })
  for (const patch of [{ repository: "wrong/repo" }, { tag: "v1.0.2" }, { channel: "beta" }, { assets: [index.assets[0], index.assets[0]] }, { schema: { version: 1, fingerprint: "wrong" } }]) expect(() => validateReleaseIndex({ ...index, ...patch }, expected)).toThrow("invalid")
  expect(() => validateReleaseIndex(index, { ...expected, sha256: "0".repeat(64) })).toThrow()
  expect(() => validateReleaseIndex(index, { ...expected, size: 100 })).toThrow()
})

test("B40 verified rollback refuses incompatible schemas and missing release index", async () => {
  const h = box()
  await runUpgrade(h.request(), fakePorts([candidate()]).ports)
  const next = candidate("1.0.2")
  for (const [url, bytes] of next.files) if (url.endsWith("release-index.json")) {
    const index = JSON.parse(new TextDecoder().decode(bytes))
    index.schema.fingerprint = "2".repeat(64)
    next.files.set(url, new TextEncoder().encode(JSON.stringify(index)))
  }
  expect(await runUpgrade(h.request({ currentVersion: "1.0.1" }), fakePorts([next]).ports)).toMatchObject({ rollbackAvailable: false })
  await expect(runUpgrade(h.request({ rollback: true }), fakePorts([]).ports)).rejects.toThrow("schema compatibility differs")
  expect(readFileSync(h.paths.current, "utf8")).toBe("1.0.2")
  const legacy = candidate("1.0.3")
  legacy.json.assets = legacy.json.assets.filter((asset) => asset.name !== "release-index.json")
  await expect(runUpgrade(h.request(), fakePorts([legacy]).ports)).rejects.toThrow("release index missing")
  expect(readFileSync(h.paths.current, "utf8")).toBe("1.0.2")
})

test("B40 refuses symlink aliases into v1 and linked binary paths without changing their targets", async () => {
  const h = box()
  const legacy = path.join(h.tmp.dir, ".mendcode")
  mkdirSync(legacy)
  const alias = path.join(h.tmp.dir, "alias")
  symlinkSync(legacy, alias)
  const fake = fakePorts([candidate()])
  await expect(runUpgrade(h.request({ dataDir: alias, home: h.tmp.dir }), fake.ports)).rejects.toThrow("legacy MendCode")
  mkdirSync(h.paths.dir, { recursive: true })
  const outside = path.join(h.tmp.dir, "retained")
  writeFileSync(outside, "keep")
  symlinkSync(outside, h.paths.prev)
  await expect(runUpgrade(h.request(), fake.ports)).rejects.toThrow("symbolic links")
  expect(readFileSync(outside, "utf8")).toBe("keep")
  expect(fake.requested).toEqual([])
})

test("B40 an explicit older target authorizes a downgrade, latest does not", async () => {
  const h = box()
  const fake = fakePorts([candidate()])
  expect(await runUpgrade(h.request({ currentVersion: "1.0.2", target: "latest" }), fake.ports)).toMatchObject({ status: "ahead" })
  expect(existsSync(h.paths.current)).toBe(false)
  expect(await runUpgrade(h.request({ currentVersion: "1.0.2", target: "1.0.1" }), fake.ports)).toMatchObject({ status: "installed", downgrade: true })
})
