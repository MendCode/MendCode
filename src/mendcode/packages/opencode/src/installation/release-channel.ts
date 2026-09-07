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

async function commitChannel(value: unknown) {
  const channel = parseChannel(value)
  const file = configPath()
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${randomUUID()}.tmp`
  await fs.writeFile(temporary, JSON.stringify({ version: 1, channel }) + "\n", { mode: 0o600 })
  await fs.rename(temporary, file)
  return channel
}

/** Serialize updater activation and preference changes across CLI processes. */
export async function acquireChannelTransition() {
  const file = `${configPath()}.lock`
  await fs.mkdir(path.dirname(file), { recursive: true })
  const handle = await fs.open(file, "wx", 0o600).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "EEXIST") {
      throw new Error("Another channel/update operation owns the release-channel lock. Wait for it to finish; after a crash, verify its recorded owner is no longer running before recovering the lock.")
    }
    throw error
  })
  const identity = await handle.stat()
  let released = false
  const release = async () => {
    if (released) return
    released = true
    await handle.close()
    const current = await fs.lstat(file).catch(() => undefined)
    if (current?.ino === identity.ino && current.dev === identity.dev) await fs.unlink(file)
  }
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: Date.now() }) + "\n")
  } catch (error) {
    await release()
    throw error
  }
  return { commit: commitChannel, release }
}

export async function writeChannel(value: unknown) {
  const channel = parseChannel(value)
  const transition = await acquireChannelTransition()
  try { return await transition.commit(channel) } finally { await transition.release() }
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
