import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

/**
 * The bench of the Git page's push and pull request tests (docs/git.md): a repository with a local bare repository as `origin` (no network), a `git` that logs
 * every call the code under test makes before running the real one, and a fake `gh` that logs its arguments and standard input and answers what the test says.
 * The code under test gets `env`; the bench's own setup uses plain git, so the logs hold only what the code did. Shared by the daemon and terminal tests.
 */

const REAL_GIT = Bun.which("git") ?? "git"
const US = "\u001f"

export type FakeGh = {
  dir: string
  /** What the next calls print and return. Unset fields reset to: no output, exit 0, no delay. */
  reply(answer: { stdout?: string; stderr?: string; exit?: number; sleep?: number }): void
  /** Every call so far: its arguments and, for `pr create`, what it read on standard input. */
  calls(): Array<{ argv: string[]; stdin: string }>
}

const dirs: string[] = []
/** Removes every directory the benches made. */
export function cleanBenches() { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) }

function made(prefix: string) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), `mend-gitactions-${prefix}-`)))
  dirs.push(dir)
  return dir
}

/** An environment where no global git config, machine identity or proxy can leak in. */
export function plainEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, GH_CONFIG_DIR: path.join(home, "gh"), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", no_proxy: "*", NO_PROXY: "*" }
  for (const name of Object.keys(env)) if (/^GIT_(AUTHOR|COMMITTER|DIR|WORK_TREE|INDEX|ASKPASS|SSH)|^(https?|all)_proxy$/i.test(name)) delete env[name]
  return env
}

const templates = new Map<string, string>()
/** Removes the repositories the benches were copied from. For `afterAll`: bun's test runner ends without running a process exit handler. */
export function cleanBenchTemplates() {
  for (const dir of templates.values()) rmSync(dir, { recursive: true, force: true })
  templates.clear()
}

/**
 * The repository a bench starts from (one commit on `main`; with `remote`, a bare `origin` that has it and is the upstream), made once per
 * test file for each kind and copied into every bench: the nine git commands took 0.15 s of every test. Holds `repo` and `remote.git`.
 */
function template(kind: { identity: boolean; remote: boolean }): string {
  const key = `${kind.identity} ${kind.remote}`
  const known = templates.get(key)
  if (known) return known
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), "mend-gitactions-template-")))
  mkdirSync(path.join(base, "home"))
  const plain = plainEnv(path.join(base, "home"))
  const sh = (cwd: string, ...args: string[]) => {
    const result = Bun.spawnSync([REAL_GIT, ...args], { cwd, env: plain })
    if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`)
  }
  try {
    const dir = path.join(base, "repo")
    mkdirSync(dir)
    sh(dir, "init", "-q", "-b", "main")
    if (kind.identity) { sh(dir, "config", "user.name", "Tester"); sh(dir, "config", "user.email", "tester@example.test") }
    writeFileSync(path.join(dir, "a.txt"), "a1\n")
    sh(dir, "add", ".")
    sh(dir, "commit", "-q", "-m", "init")
    if (kind.remote) {
      const remote = path.join(base, "remote.git")
      Bun.spawnSync([REAL_GIT, "init", "-q", "--bare", "-b", "main", remote], { env: plain })
      sh(dir, "remote", "add", "origin", remote)
      sh(dir, "push", "-q", "-u", "origin", "main")
      sh(dir, "remote", "set-head", "origin", "main")
    }
  } catch (error) {
    rmSync(base, { recursive: true, force: true })
    throw error
  }
  templates.set(key, base)
  return base
}

export function bench(options: { identity?: boolean; remote?: boolean } = {}) {
  const base = made("bench")
  const home = path.join(base, "home")
  mkdirSync(home)
  const plain = plainEnv(home)
  const bin = path.join(base, "bin")
  mkdirSync(bin)
  const gitLog = path.join(base, "git-calls.log")
  const ghDir = path.join(base, "gh")
  mkdirSync(ghDir)
  const wrapper = path.join(bin, "git")
  writeFileSync(wrapper, `#!/bin/sh\nprintf '%s${US}' "$@" >> "${gitLog}"\nprintf '\\n' >> "${gitLog}"\nexec "${REAL_GIT}" "$@"\n`)
  chmodSync(wrapper, 0o755)
  const fake = path.join(bin, "gh")
  writeFileSync(fake, [
    "#!/bin/sh",
    `d="${ghDir}"`,
    'n=$(cat "$d/count" 2>/dev/null || echo 0)',
    "n=$((n+1))",
    'echo "$n" > "$d/count"',
    `printf '%s${US}' "$@" > "$d/$n.argv"`,
    'if [ "$1 $2" = "pr create" ]; then cat > "$d/$n.stdin"; fi',
    '[ -f "$d/sleep" ] && sleep "$(cat "$d/sleep")"',
    '[ -f "$d/stderr" ] && cat "$d/stderr" >&2',
    '[ -f "$d/stdout" ] && cat "$d/stdout"',
    'exit "$(cat "$d/exit" 2>/dev/null || echo 0)"',
    "",
  ].join("\n"))
  chmodSync(fake, 0o755)

  /** The environment of the code under test: the logging git and the fake gh first on the PATH. */
  const env: NodeJS.ProcessEnv = { ...plain, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`, FAKE_GIT_LOG: gitLog }
  /** The same without gh: it is not installed. */
  const withoutGh: NodeJS.ProcessEnv = { ...env, PATH: `${path.join(base, "git-only")}${path.delimiter}${process.env.PATH?.split(path.delimiter).filter((dir) => !existsSync(path.join(dir, "gh"))).join(path.delimiter) ?? ""}` }
  mkdirSync(path.join(base, "git-only"))
  writeFileSync(path.join(base, "git-only", "git"), readFileSync(wrapper))
  chmodSync(path.join(base, "git-only", "git"), 0o755)

  const sh = (cwd: string, ...args: string[]) => {
    const result = Bun.spawnSync([REAL_GIT, ...args], { cwd, env: plain })
    if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`)
    return result.stdout.toString()
  }
  const remote = path.join(base, "remote.git")
  const dir = path.join(base, "repo")
  const from = template({ identity: options.identity !== false, remote: options.remote !== false })
  cpSync(path.join(from, "repo"), dir, { recursive: true })
  if (options.remote !== false) {
    cpSync(path.join(from, "remote.git"), remote, { recursive: true })
    // The one absolute path a repository keeps: where `origin` is.
    const config = path.join(dir, ".git", "config")
    writeFileSync(config, readFileSync(config, "utf8").replaceAll(path.join(from, "remote.git"), remote))
  }
  const write = (file: string, text: string, root = dir) => { mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); writeFileSync(path.join(root, file), text) }

  /** A commit on the current branch. */
  const commit = (message: string, file = `f-${message.replace(/\W+/g, "-").toLowerCase()}.txt`) => { write(file, `${message}\n`); sh(dir, "add", file); sh(dir, "commit", "-q", "-m", message) }
  /** Another clone of the remote, to move it ahead behind the repository's back. */
  const other = () => {
    const clone = path.join(base, "other")
    if (!existsSync(clone)) {
      Bun.spawnSync([REAL_GIT, "clone", "-q", remote, clone], { env: plain })
      sh(clone, "config", "user.name", "Other")
      sh(clone, "config", "user.email", "other@example.test")
    }
    return { dir: clone, git: (...args: string[]) => sh(clone, ...args), commit: (message: string) => { write(`o-${message.replace(/\W+/g, "-")}.txt`, `${message}\n`, clone); sh(clone, "add", "."); sh(clone, "commit", "-q", "-m", message) } }
  }
  const hook = (name: string, body: string) => { const file = path.join(dir, ".git", "hooks", name); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, `#!/bin/sh\n${body}\n`); chmodSync(file, 0o755) }
  const gh: FakeGh = {
    dir: ghDir,
    reply(answer) {
      for (const [name, value] of [["stdout", answer.stdout], ["stderr", answer.stderr], ["exit", answer.exit], ["sleep", answer.sleep]] as const) {
        const file = path.join(ghDir, name)
        if (value === undefined) rmSync(file, { force: true })
        else writeFileSync(file, String(value))
      }
    },
    calls() {
      const count = existsSync(path.join(ghDir, "count")) ? Number(readFileSync(path.join(ghDir, "count"), "utf8")) : 0
      return Array.from({ length: count }, (_, index) => {
        const file = path.join(ghDir, `${index + 1}`)
        return { argv: readFileSync(`${file}.argv`, "utf8").split(US).slice(0, -1), stdin: existsSync(`${file}.stdin`) ? readFileSync(`${file}.stdin`, "utf8") : "" }
      })
    },
  }
  /** Every git call the code under test made, as argument lists. */
  const gitCalls = () => (existsSync(gitLog) ? readFileSync(gitLog, "utf8").split("\n").filter(Boolean).map((line) => line.split(US).slice(0, -1)) : [])
  const pushes = () => gitCalls().filter((call) => call.includes("push"))
  const clearCalls = () => rmSync(gitLog, { force: true })
  /** Where a ref points in the remote, or undefined. */
  const remoteRef = (ref: string) => { const done = Bun.spawnSync([REAL_GIT, "rev-parse", "--verify", "--quiet", ref], { cwd: remote, env: plain }); return done.exitCode === 0 ? done.stdout.toString().trim() : undefined }
  const checkout = (branch: string) => sh(dir, "checkout", "-q", "-b", branch)
  return { base, home, dir, remote, env, plain, withoutGh, sh: (...args: string[]) => sh(dir, ...args), git: sh, write: (file: string, text: string) => write(file, text), commit, other, hook, gh, gitCalls, pushes, clearCalls, remoteRef, checkout }
}

export type Bench = ReturnType<typeof bench>
