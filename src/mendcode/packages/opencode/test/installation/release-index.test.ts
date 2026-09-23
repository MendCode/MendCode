import { afterAll, expect, test } from "bun:test"
import { createHash, randomUUID } from "node:crypto"
import { mkdtemp, mkdir, rename, readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { validateReleaseIndex, verifyReleaseIndex, verifyInstallerBytes, type ReleaseIndex } from "../../src/installation/release-index"
import { supportedMigrationJournal } from "../../src/storage/migration-journal"

const digest = (text: string) => createHash("sha256").update(text).digest("hex")
const roots: string[] = []
async function directory() { const root = await mkdtemp(path.join(os.tmpdir(), "mendcode-index-test-")); roots.push(root); return root }
afterAll(async () => {
  const trash = path.join(os.homedir(), ".Trash")
  await mkdir(trash, { recursive: true })
  for (const root of roots) await rename(root, path.join(trash, `${path.basename(root)}-${randomUUID()}`))
})

function fixture(): ReleaseIndex {
  const journal = [{ name: "20260803032053_dynamic_workflows", timestamp: Date.UTC(2026, 7, 3, 3, 20, 53), hash: "d".repeat(64) }]
  return { formatVersion: 1, version: "0.1.44-beta.1", channel: "beta", tag: "v0.1.44-beta.1", commit: "a".repeat(40), repository: "MendCode/MendCode",
    provenance: { workflow: ".github/workflows/release.yml", runID: "123" },
    installer: { path: "src/mendcode/install", commit: "a".repeat(40), sha256: digest("installer") },
    windowsInstaller: { path: "src/mendcode/install.ps1", commit: "a".repeat(40), sha256: digest("windows installer") },
    schema: { journal, fingerprint: digest(JSON.stringify(journal)) },
    assets: [{ name: "mendcode-darwin-arm64.zip", platform: "darwin-arm64", size: 1024, sha256: "b".repeat(64) }],
  }
}
function fetcher(index: ReleaseIndex = fixture(), source = index.commit) {
  return (async (url: string | URL | Request) => {
    if (String(url).endsWith("/release-index.json")) return Response.json(index)
    if (String(url).startsWith("https://api.github.com/repos/MendCode/MendCode/commits/")) return Response.json({ sha: source })
    throw new Error("Unexpected request")
  }) as typeof fetch
}

test("verified index returns only commit-pinned installer and authenticated checksums", async () => {
  const calls: string[][] = []
  const output = await verifyReleaseIndex({ version: fixture().version, directory: await directory(), fetch: fetcher(),
    run: async (command, args, options) => { calls.push([command, ...args]); expect(options.timeoutMs).toBe(30_000); return { exitCode: 0 } },
  })
  expect(output.installerURL).toBe(`https://raw.githubusercontent.com/MendCode/MendCode/${fixture().commit}/src/mendcode/install`)
  expect(output.checksums).toEqual({ "mendcode-darwin-arm64.zip": "b".repeat(64) })
  expect(output.windowsInstallerURL).toEndWith(`/${fixture().commit}/src/mendcode/install.ps1`)
  verifyInstallerBytes(Buffer.from("windows installer"), output.windowsInstallerSHA256)
  expect(calls).toHaveLength(1)
  expect(calls[0]).toContain("--deny-self-hosted-runners")
  expect(calls[0]).toContain("MendCode/MendCode/.github/workflows/release.yml")
  expect(JSON.parse(await readFile(output.file, "utf8"))).toEqual(fixture())
  verifyInstallerBytes(Buffer.from("installer"), output.installerSHA256)
  expect(() => verifyInstallerBytes(Buffer.from("tampered"), output.installerSHA256)).toThrow("checksum")
})

test("rejects mismatched source and attestation failures without an installer execution", async () => {
  let calls = 0
  const input = { version: fixture().version, directory: await directory(), fetch: fetcher(), run: async (command: string) => { expect(command).toBe("gh"); calls++; return { exitCode: 1 } } }
  await expect(verifyReleaseIndex(input)).rejects.toThrow("provenance verification failed")
  await expect(verifyReleaseIndex({ ...input, fetch: fetcher(fixture(), "c".repeat(40)), run: async () => ({ exitCode: 0 }) })).rejects.toThrow("source commit")
  await expect(verifyReleaseIndex({ ...input, run: async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }) } })).rejects.toThrow("GitHub CLI")
  expect(calls).toBe(1)
})

test("legacy missing metadata and over-limit bodies fail closed before subprocess", async () => {
  const input = { version: fixture().version, directory: await directory(), run: async () => { throw new Error("must not execute") } }
  await expect(verifyReleaseIndex({ ...input, fetch: async () => new Response("missing", { status: 404 }) })).rejects.toThrow("legacy")
  await expect(verifyReleaseIndex({ ...input, fetch: async () => new Response("x".repeat(512 * 1024 + 1)) })).rejects.toThrow("size limit")
  await expect(verifyReleaseIndex({ ...input, fetch: async () => new Response("bad JSON") })).rejects.toThrow()
})

test("validates schema fingerprint, identity, assets, channels and repository", () => {
  for (const modify of [
    (value: ReleaseIndex) => { value.schema.fingerprint = "c".repeat(64) },
    (value: ReleaseIndex) => { value.schema.journal[0].timestamp++ },
    (value: ReleaseIndex) => { value.assets[0].name = "../mendcode-darwin-arm64.zip" },
    (value: ReleaseIndex) => { value.assets.push(value.assets[0]) },
    (value: ReleaseIndex) => { value.channel = "stable" },
    (value: ReleaseIndex) => { value.installer.commit = "c".repeat(40) },
    (value: ReleaseIndex) => { value.windowsInstaller.commit = "c".repeat(40) },
    (value: ReleaseIndex) => { value.assets[0].platform = "linux-x64" },
  ]) { const value = fixture(); modify(value); expect(() => validateReleaseIndex(value, { version: fixture().version })).toThrow() }
  expect(() => validateReleaseIndex({ ...fixture(), repository: "other/repo" }, { version: fixture().version })).toThrow()
})

test("accepts the actual supported migration journal including historical hyphenated names", async () => {
  const value = fixture()
  const journal = supportedMigrationJournal()
  value.schema = { journal, fingerprint: digest(JSON.stringify(journal)) }
  expect(journal.some((entry) => entry.name.includes("workspace-name"))).toBe(true)
  expect(validateReleaseIndex(value, { version: value.version }).schema.journal).toEqual(journal)
  const { makeIndex } = await import(path.join(import.meta.dir, "../../../../script/release-index.mjs"))
  const generated = makeIndex({ ...value, journal, runID: value.provenance.runID })
  expect(validateReleaseIndex(generated, { version: value.version }).schema).toEqual(value.schema)
})
