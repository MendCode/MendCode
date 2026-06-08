import { $ } from "bun"
import semver from "semver"
import path from "path"

const rootPkgPath = path.resolve(import.meta.dir, "../../../package.json")
const rootPkg = await Bun.file(rootPkgPath).json()
const expectedBunVersion = rootPkg.packageManager?.split("@")[1]

if (!expectedBunVersion) {
  throw new Error("packageManager field not found in root package.json")
}

// relax version requirement
const expectedBunVersionRange = `^${expectedBunVersion}`

if (!semver.satisfies(process.versions.bun, expectedBunVersionRange)) {
  throw new Error(`This script requires bun@${expectedBunVersionRange}, but you are using bun@${process.versions.bun}`)
}

const env = {
  CHANNEL: process.env["MENDCODE_CHANNEL"] ?? process.env["OPENCODE_CHANNEL"],
  BUMP: process.env["MENDCODE_BUMP"] ?? process.env["OPENCODE_BUMP"],
  VERSION: process.env["MENDCODE_VERSION"] ?? process.env["OPENCODE_VERSION"],
  RELEASE: process.env["MENDCODE_RELEASE"] ?? process.env["OPENCODE_RELEASE"],
}
const CHANNEL = await (async () => {
  if (env.CHANNEL) return env.CHANNEL
  if (env.BUMP) return "latest"
  if (env.VERSION && !env.VERSION.startsWith("0.0.0-")) return "latest"
  return await $`git branch --show-current`.text().then((x) => x.trim() || "dev")
})()
const IS_PREVIEW = CHANNEL !== "latest"

const VERSION = await (async () => {
  if (env.VERSION) return env.VERSION
  if (IS_PREVIEW) return `0.0.0-${CHANNEL}-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}`
  const runtimePkg = await Bun.file(path.resolve(import.meta.dir, "../../../packages/opencode/package.json")).json()
  const version = runtimePkg.version
  const [major, minor, patch] = version.split(".").map((x: string) => Number(x) || 0)
  const t = env.BUMP?.toLowerCase()
  if (t === "major") return `${major + 1}.0.0`
  if (t === "minor") return `${major}.${minor + 1}.0`
  return `${major}.${minor}.${patch + 1}`
})()

const bot = ["actions-user", "mendcode", "mendcode-agent[bot]", "opencode", "opencode-agent[bot]"]
const teamPath = path.resolve(import.meta.dir, "../../../.github/TEAM_MEMBERS")
const team = [
  ...(await Bun.file(teamPath)
    .text()
    .then((x) => x.split(/\r?\n/).map((x) => x.trim()))
    .then((x) => x.filter((x) => x && !x.startsWith("#")))),
  ...bot,
]

export const Script = {
  get channel() {
    return CHANNEL
  },
  get version() {
    return VERSION
  },
  get preview() {
    return IS_PREVIEW
  },
  get release(): boolean {
    return !!env.RELEASE
  },
  get team() {
    return team
  },
}
console.log(`mendcode script`, JSON.stringify(Script, null, 2))
