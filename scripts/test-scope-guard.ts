/**
 * Preloaded into every `bun test` run (bunfig.toml): a `bun test` started without one path or name filter runs every test file of
 * the repository in one process, which grew to 30 GB on 2026-10-25. That run is refused here with the command that splits the suite
 * into bounded processes (`scripts/test-fast.ts`, which always names its files). `MENDCODE_TEST_WHOLE=1` lets it through on purpose.
 */
import { statSync } from "node:fs"
import path from "node:path"

/** The arguments `bun test` was started with, from the process table (a preload's `process.argv` holds the resolved files instead). */
function testArguments(pid: number): string[] | undefined {
  const listed = Bun.spawnSync(["ps", "-o", "args=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" })
  const words = new TextDecoder().decode(listed.stdout).trim().split(/\s+/)
  const at = words.indexOf("test")
  return at < 0 ? undefined : words.slice(at + 1)
}

/** True when the run names nothing to narrow it: no path, no `-t`/`--test-name-pattern`. */
export function wholeSuite(args: readonly string[]): boolean {
  return !args.some((arg, index) => !arg.startsWith("-") && !/^(-t|--test-name-pattern|--timeout|--preload|--rerun-each|--bail)$/.test(args[index - 1] ?? "") || arg === "-t" || arg.startsWith("--test-name-pattern"))
}

/** More test files than this in one process is a whole workspace's worth (apps/cli has hundreds); the split runner sends a handful. */
export const MAX_FILES_PER_PROCESS = 60

const TEST_FILE = new Bun.Glob("**/*.{test,spec}.{ts,tsx,js,jsx,mts,cts}")

/** How many test files the paths a run names hold: a file counts one, a directory every test file under it. */
export function testFileCount(args: readonly string[], cwd: string): number {
  let count = 0
  for (const [index, arg] of args.entries()) {
    if (arg.startsWith("-") || /^(-t|--test-name-pattern|--timeout|--preload|--rerun-each|--bail)$/.test(args[index - 1] ?? "")) continue
    const target = path.resolve(cwd, arg)
    try {
      if (statSync(target).isDirectory()) {
        for (const file of TEST_FILE.scanSync({ cwd: target })) if (!file.includes("node_modules/") && ++count > MAX_FILES_PER_PROCESS) return count
      } else count++
    } catch {
      count++
    }
  }
  return count
}

const root = path.resolve(import.meta.dir, "..")
if (process.env.MENDCODE_TEST_WHOLE !== "1") {
  const args = testArguments(process.pid) ?? []
  const atRoot = path.resolve(process.cwd()) === root
  // From a workspace (`bun test ./test` in apps/cli) a directory of hundreds of files is the same one process of tens of GB.
  const files = testFileCount(args, process.cwd())
  if (atRoot && wholeSuite(args) || !wholeSuite(args) && files > MAX_FILES_PER_PROCESS || !atRoot && wholeSuite(args) && testFileCount(["."], process.cwd()) > MAX_FILES_PER_PROCESS) {
    process.stderr.write(`[TEST]: this \`bun test\` loads ${files > MAX_FILES_PER_PROCESS ? `more than ${MAX_FILES_PER_PROCESS}` : "every"} test files into one process (tens of GB). Run \`bun scripts/test-fast.ts\` (\`--all\` for everything), or name fewer files; MENDCODE_TEST_WHOLE=1 forces it.\n`)
    process.exit(2)
  }
}
