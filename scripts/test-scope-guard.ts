/**
 * Preloaded into every `bun test` run (bunfig.toml): a `bun test` started without one path or name filter runs every test file of
 * the repository in one process, which grew to 30 GB on 2026-10-25. That run is refused here with the command that splits the suite
 * into bounded processes (`scripts/test-fast.ts`, which always names its files). `MENDCODE_TEST_WHOLE=1` lets it through on purpose.
 */
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

const root = path.resolve(import.meta.dir, "..")
if (process.env.MENDCODE_TEST_WHOLE !== "1" && path.resolve(process.cwd()) === root) {
  const args = testArguments(process.pid)
  if (args && wholeSuite(args)) {
    process.stderr.write("[TEST]: `bun test` with no path runs the whole suite in one process (tens of GB). Run `bun scripts/test-fast.ts --all`, or name the files; MENDCODE_TEST_WHOLE=1 forces it.\n")
    process.exit(2)
  }
}
