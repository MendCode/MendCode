import { readFileSync } from "node:fs"
import path from "node:path"

const ROOT = path.join(import.meta.dir, "../../..")
declare const MENDCODE_COMPILED_BUILD_ID: string | undefined

/** What the daemon process runs from source: every package, the prompts and the built-in recipes and skills. */
const DAEMON_SOURCES = ["packages/*/src/**/*.ts", "packages/*/prompts/**/*.md", "packages/daemon/builtin/**/*", "apps/cli/package.json"]
/** A release binary also embeds the terminal client, so its id follows the client sources too. */
const RELEASE_SOURCES = [...DAEMON_SOURCES, "apps/cli/src/**/*.ts"]

/**
 * Identifies the code the daemon is running. Clients compare it in the handshake and restart an idle
 * daemon that is older than themselves (version skew after an update or during development).
 * Release builds set MENDCODE_BUILD_ID; development hashes the sources the daemon runs, so a UI-only edit
 * does not make a healthy daemon look old. `scope: "release"` (scripts/build.ts) adds the client sources.
 * One pattern per glob: Bun 1.3 returns no files for a brace pattern that mixes `**` branches, which once made
 * every development id the hash of nothing (`dev-e3b0c44298fc`) and hid all version skew.
 */
export function computeBuildId(env: Record<string, string | undefined> = process.env, scope: "daemon" | "release" = "daemon") {
  if (typeof MENDCODE_COMPILED_BUILD_ID !== "undefined") return MENDCODE_COMPILED_BUILD_ID
  if (env.MENDCODE_BUILD_ID) return env.MENDCODE_BUILD_ID
  const files = new Set<string>()
  for (const pattern of scope === "release" ? RELEASE_SOURCES : DAEMON_SOURCES) {
    for (const file of new Bun.Glob(pattern).scanSync({ cwd: ROOT })) if (!file.includes("node_modules")) files.add(file)
  }
  if (files.size === 0) throw new Error("[BUILD-ID]: no source files found under the repository root")
  const hasher = new Bun.CryptoHasher("sha256")
  for (const file of [...files].sort()) {
    hasher.update(file)
    hasher.update(readFileSync(path.join(ROOT, file)))
  }
  return `dev-${hasher.digest("hex").slice(0, 12)}`
}
