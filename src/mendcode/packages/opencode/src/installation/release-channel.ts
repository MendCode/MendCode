import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import semver from "semver"

export const channels = ["stable", "beta", "nightly"] as const
export type ReleaseChannel = (typeof channels)[number]

export function parseChannel(value: unknown): ReleaseChannel {
  if (value === "stable" || value === "beta" || value === "nightly") return value
  throw new Error("Release channel must be stable, beta, or nightly")
}

function configPath() {
  // Update preferences must remain independent of build channel and database layout.
  return path.join(process.env.OPENCODE_TEST_HOME ?? os.homedir(), ".mendcode", "release-channel.json")
}

export async function readChannel(): Promise<ReleaseChannel> {
  const text = await fs.readFile(configPath(), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null
    throw error
  })
  if (text === null) return "stable"
  return parseChannel(JSON.parse(text).channel)
}

export async function writeChannel(value: unknown) {
  const channel = parseChannel(value)
  const file = configPath()
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  await fs.writeFile(temporary, JSON.stringify({ version: 1, channel }) + "\n", { mode: 0o600 })
  await fs.rename(temporary, file)
  return channel
}

export type Release = { tag_name: string; draft?: boolean; prerelease?: boolean }

export function selectRelease(releases: Release[], channel: ReleaseChannel) {
  return releases
    .filter((release) => {
      if (release.draft) return false
      const version = semver.parse(release.tag_name)
      if (!version) return false
      if (channel === "stable") return !release.prerelease && version.prerelease.length === 0
      return release.prerelease === true && version.prerelease[0] === channel
    })
    .sort((a, b) => semver.rcompare(a.tag_name, b.tag_name))[0]?.tag_name.replace(/^v/, "")
}
