import { createHash } from "node:crypto"
import { mkdir, lstat, writeFile } from "node:fs/promises"
import path from "node:path"
import { existsSync } from "node:fs"

/** Snapshot objects and index live only in the data dir, never in the project's Git index. */
export function createDebugSnapshots(dir: string) {
  const locks = new Map<string, Promise<unknown>>()
  return async (directory: string, operation: "snapshot.track" | "snapshot.patch" | "snapshot.diff", hash?: string) => {
    const previous = locks.get(directory) ?? Promise.resolve()
    const task = previous.catch(() => {}).then(async () => {
      const gitdir = path.join(dir, "debug-snapshots", createHash("sha256").update(directory).digest("hex"))
      const run = async (args: string[], stdin?: string, source = false, missingOK = false) => {
        const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"].includes(key)))
        const child = Bun.spawn(["git", "--no-pager", "-c", "core.fsmonitor=false", "-c", "core.autocrlf=false", "-c", "core.quotepath=false", ...(source ? [] : ["--git-dir", gitdir, "--work-tree", directory]), ...args], { cwd: directory, stdin: stdin === undefined ? "ignore" : "pipe", stdout: "pipe", stderr: "pipe", env: { ...environment, GIT_OPTIONAL_LOCKS: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } })
        if (stdin !== undefined) { child.stdin!.write(stdin); child.stdin!.end() }
        const timer = setTimeout(() => child.kill(), 5000)
        try {
          const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
          if (code !== 0 && !(missingOK && code === 1)) throw new Error(error.trim() || "snapshot command failed")
          if (Buffer.byteLength(output) > 120_000) throw new Error("snapshot output exceeds 120 KB")
          return output
        } finally { clearTimeout(timer) }
      }
      if (operation !== "snapshot.track" && !existsSync(gitdir)) throw new Error("No snapshots for this project; run debug snapshot track")
      if (!existsSync(gitdir)) {
        await mkdir(gitdir, { recursive: true })
        await run(["init", "--quiet"])
        await writeFile(path.join(gitdir, "info", "exclude"), ".git\nnode_modules\n")
      }
      if (hash && !/^[a-f0-9]{40,64}$/.test(hash)) throw new Error("invalid snapshot hash")
      if (hash && (await run(["cat-file", "-t", hash])).trim() !== "tree") throw new Error("snapshot hash is not a tree")
      const candidates = (await run(["ls-files", "--cached", "--others", "--exclude-standard", "-z"], undefined, true)).split("\0").filter(Boolean)
      if (candidates.length > 10000) throw new Error("snapshot exceeds 10000 files")
      const ignored = new Set(candidates.length ? (await run(["check-ignore", "--no-index", "--stdin", "-z"], candidates.join("\0") + "\0", true, true)).split("\0") : [])
      const allowed: string[] = []
      for (const file of candidates) {
        if (ignored.has(file)) continue
        const full = path.resolve(directory, file)
        if (!full.startsWith(directory + path.sep) || full === dir || full.startsWith(dir + path.sep)) continue
        const stat = await lstat(full).catch(() => undefined)
        if (stat?.isSymbolicLink() || stat?.isFile() && stat.size <= 2 * 1024 * 1024 || !stat) allowed.push(file)
      }
      // Rebuild the private index, including removals, from the current ignore-aware candidate list.
      await run(["read-tree", "--empty"])
      const present: string[] = []
      for (const file of allowed) if (existsSync(path.join(directory, file))) present.push(file)
      if (present.length) await run(["add", "--all", "--pathspec-from-file=-", "--pathspec-file-nul"], present.join("\0") + "\0")
      if (operation === "snapshot.track") return { hash: (await run(["write-tree"])).trim() }
      if (operation === "snapshot.patch") return { hash, files: (await run(["diff", "--cached", "--no-ext-diff", "--no-textconv", "--name-only", "-z", hash!, "--", "."])).split("\0").filter(Boolean).map((file) => path.join(directory, file)) }
      return { diff: (await run(["diff", "--cached", "--no-ext-diff", "--no-textconv", "--no-color", hash!, "--", "."])).trim() }
    })
    locks.set(directory, task)
    try { return await task } finally { if (locks.get(directory) === task) locks.delete(directory) }
  }
}
