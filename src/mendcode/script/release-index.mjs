import { createHash } from "node:crypto"
import { readFile, readdir, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

export const digest = (value) => createHash("sha256").update(value).digest("hex")

export function releaseChannel(version) {
  if (/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) return "stable"
  if (/^\d+\.\d+\.\d+-beta\.[1-9]\d*$/.test(version)) return "beta"
  if (/^\d+\.\d+\.\d+-nightly\.\d{8}\.[1-9]\d*$/.test(version)) return "nightly"
  throw new Error("Unsupported release version")
}

export function migrationEntry(name, sql) {
  const date = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})_/.exec(name)
  if (!date) throw new Error(`Invalid migration name: ${name}`)
  const [, year, month, day, hour, minute, second] = date.map(Number)
  return { name, timestamp: Date.UTC(year, month - 1, day, hour, minute, second), hash: digest(sql) }
}

export function makeIndex({ version, commit, repository, runID, journal, assets, installer, windowsInstaller }) {
  const channel = releaseChannel(version)
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("Release commit must be a full SHA")
  if (repository !== "MendCode/MendCode") throw new Error("Unauthorized release repository")
  if (!/^[1-9]\d*$/.test(runID)) throw new Error("Invalid workflow run")
  if (!journal.length) throw new Error("Missing schema journal")
  for (let i = 0; i < journal.length; i++) {
    const entry = journal[i]
    if (!/^\d{14}_/.test(entry.name) || !/^[a-f0-9]{64}$/.test(entry.hash) || !Number.isSafeInteger(entry.timestamp))
      throw new Error("Invalid schema journal entry")
    if (i > 0 && (journal[i - 1].name >= entry.name || journal[i - 1].timestamp >= entry.timestamp))
      throw new Error("Schema journal must be ordered and unique")
  }
  const names = new Set()
  for (const asset of assets) {
    if (!/^mendcode-(linux|darwin|windows)-(arm64|x64)(-baseline)?(-musl)?\.(zip|tar\.gz)$/.test(asset.name))
      throw new Error("Invalid release asset name")
    if (names.has(asset.name)) throw new Error("Duplicate release asset")
    names.add(asset.name)
    if (!/^[a-f0-9]{64}$/.test(asset.sha256) || !Number.isSafeInteger(asset.size) || asset.size <= 0)
      throw new Error("Invalid release asset metadata")
  }
  if (!assets.length || !/^[a-f0-9]{64}$/.test(installer.sha256) || !/^[a-f0-9]{64}$/.test(windowsInstaller?.sha256)) throw new Error("Missing release artifacts")
  return {
    formatVersion: 1, version, channel, tag: `v${version}`, commit, repository,
    provenance: { workflow: ".github/workflows/release.yml", runID },
    installer: { path: "src/mendcode/install", commit, sha256: installer.sha256 },
    windowsInstaller: { path: "src/mendcode/install.ps1", commit, sha256: windowsInstaller.sha256 },
    schema: { journal, fingerprint: digest(JSON.stringify(journal)) },
    assets: assets.map((asset) => ({ ...asset, platform: asset.name.replace(/^mendcode-/, "").replace(/\.(zip|tar\.gz)$/, "") })),
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const dist = path.resolve(process.argv[2] ?? "dist")
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
  const migrationDir = path.join(root, "packages/opencode/migration")
  const journal = []
  for (const entry of (await readdir(migrationDir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue
    journal.push(migrationEntry(entry.name, await readFile(path.join(migrationDir, entry.name, "migration.sql"), "utf8")))
  }
  const assets = []
  for (const name of (await readdir(dist)).sort()) {
    if (!/\.(zip|tar\.gz)$/.test(name)) continue
    const file = path.join(dist, name)
    assets.push({ name, size: (await stat(file)).size, sha256: digest(await readFile(file)) })
  }
  const index = makeIndex({
    version: process.env.VERSION, commit: process.env.RELEASE_COMMIT, repository: process.env.GITHUB_REPOSITORY,
    runID: process.env.GITHUB_RUN_ID, journal, assets, installer: { sha256: digest(await readFile(path.join(root, "install"))) },
    windowsInstaller: { sha256: digest(await readFile(path.join(root, "install.ps1"))) },
  })
  await writeFile(path.join(dist, "release-index.json"), JSON.stringify(index, null, 2) + "\n")
}
