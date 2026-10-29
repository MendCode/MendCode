import { chmodSync, existsSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { bench } from "./git-actions-bench"

/**
 * The bench of the publish tests (docs/git.md): the push bench (a repository, a logging git, a fake gh that records its arguments), with a gh that
 * also answers `gh api user` and, like the real one, adds the remote that `gh repo create --source … --remote …` was asked for. No network, no real gh.
 */

const REAL_GIT = Bun.which("git") ?? "git"
const US = "\u001f"

export function publishBench(options: Parameters<typeof bench>[0] = { remote: false }) {
  const b = bench(options)
  const fake = path.join(b.env.PATH!.split(path.delimiter)[0]!, "gh")
  writeFileSync(fake, [
    "#!/bin/sh",
    `d="${b.gh.dir}"`,
    'n=$(cat "$d/count" 2>/dev/null || echo 0)',
    "n=$((n+1))",
    'echo "$n" > "$d/count"',
    `printf '%s${US}' "$@" > "$d/$n.argv"`,
    '[ -f "$d/sleep" ] && sleep "$(cat "$d/sleep")"',
    'if [ "$1 $2" = "api user" ]; then',
    '  [ -f "$d/user.stderr" ] && cat "$d/user.stderr" >&2',
    '  [ -f "$d/user.stdout" ] && cat "$d/user.stdout"',
    '  exit "$(cat "$d/user.exit" 2>/dev/null || echo 0)"',
    "fi",
    'if [ "$1 $2" = "pr view" ]; then',
    '  [ -f "$d/view.stdout" ] && cat "$d/view.stdout" || echo "no pull requests found for branch" >&2',
    '  exit "$(cat "$d/view.exit" 2>/dev/null || echo 1)"',
    "fi",
    'src=""; rem=""; prev=""',
    'for a in "$@"; do',
    '  [ "$prev" = "--source" ] && src="$a"',
    '  [ "$prev" = "--remote" ] && rem="$a"',
    '  prev="$a"',
    "done",
    '[ -f "$d/stderr" ] && cat "$d/stderr" >&2',
    '[ -f "$d/stdout" ] && cat "$d/stdout"',
    `[ -f "$d/adds-remote" ] && "${REAL_GIT}" -C "$src" remote add "$rem" "$(cat "$d/adds-remote")"`,
    'exit "$(cat "$d/exit" 2>/dev/null || echo 0)"',
    "",
  ].join("\n"))
  chmodSync(fake, 0o755)
  const file = (name: string, value: string | number | undefined) => {
    const target = path.join(b.gh.dir, name)
    if (value === undefined) rmSync(target, { force: true })
    else writeFileSync(target, String(value))
  }
  return {
    ...b,
    /** What `gh api user` answers (default: the account `me`). */
    user(answer: { stdout?: string; stderr?: string; exit?: number } = { stdout: "me\n" }) {
      file("user.stdout", answer.stdout)
      file("user.stderr", answer.stderr)
      file("user.exit", answer.exit)
    },
    /** The address the fake `gh repo create` adds as the remote it was asked for, or none. */
    addsRemote(url: string | undefined) { file("adds-remote", url) },
    /** The `gh repo create` calls so far, as argument lists. */
    creates: () => b.gh.calls().map((call) => call.argv).filter((argv) => argv[0] === "repo"),
    /** Every call of gh so far. */
    ghCalls: () => b.gh.calls().map((call) => call.argv),
    hasRemote: (name: string) => b.sh("remote").split("\n").includes(name),
    exists: (name: string) => existsSync(path.join(b.dir, name)),
  }
}

export type PublishBench = ReturnType<typeof publishBench>
