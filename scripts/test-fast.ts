import { cpus } from "node:os"
import path from "node:path"
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"

/**
 * The developer's test run: only the test files whose inputs changed since they last passed, as small groups on every core (each
 * group is its own `bun test` process). `scripts/test-shards.sh` runs every file one part after another (ten minutes or more here)
 * and stays the release and CI check.
 *
 * usage: bun scripts/test-fast.ts [--all] [--list] [--jobs N] [--group N] [filter ...]     a filter is a substring of a test file's path
 *
 * - What a test file depends on (`inputs`): every file it imports, directly or through others; the non-code files and test helpers of
 *   its own package; the whole `src` of a package its text names by path (a test that starts the CLI or the daemon as a process);
 *   and docs, workflows, scripts and the root files when it reads those. A file whose inputs hash to what they did when it last
 *   passed is not run. `--all` runs everything. A dependency none of these rules sees (a path built at run time) is not tracked:
 *   the shard script before a release is what covers that.
 * - An imported file under a package's `src` counts by its code, not its text: what bun runs once comments, formatting and types are
 *   gone (`codeDigest`). A comment or a type edited in a central file therefore reruns only the tests that may read sources as text
 *   (`READS_SOURCES`: the test or one of its helpers says `src`, `packages/`, `apps/`, lists a directory or resolves a module); those
 *   keep counting every input by its text. Types cannot change what a test does at run time, and the typecheck below runs first.
 * - `--list` prints the files that would run and runs nothing (no typecheck either).
 * - SCALE files measure the product at full size and take about a minute each on their own. They are left out unless `--all` or a
 *   filter names them, and the last lines say so.
 * - QUIET files measure frame and start-up times of the compiled binary against budgets. With eleven other test processes on the
 *   machine every frame is slower and the budgets were missed (then met in the second run, alone), so these files are not started
 *   with the others: they run once the others are done, one at a time.
 * - A group that fails while the machine is loaded is run again alone at the end, and that second result is the verdict: a time
 *   budget missed only because twelve processes shared the machine is reported as such (with the tests that failed) and does not fail
 *   the run; a real failure fails twice. `MENDCODE_TEST_LOG_DIR` keeps the complete output of every group that failed its first run.
 * - node_modules/.cache/test-fast.json remembers each file's duration and passing hash. A file that took `ALONE_SECONDS` or more runs
 *   as a group of its own and the slowest groups start first, so the run is as long as its slowest file, not as six slow files in a row.
 * - bun prints only failures when it believes an AI agent started it (`CLAUDECODE`, `AGENT`, `REPL_ID`). The groups run without those
 *   variables: the output, and with it each file's duration, is the same whoever starts the run.
 */
const ROOT = realpathSync(path.join(import.meta.dir, ".."))
const SOURCES = ["apps", "packages", "scripts", "examples"]
const SCALE = ["packages/store/test/disk-budget.test.ts"]
/** Files whose whole point is a time measured on the compiled binary: they run after the others, one at a time (see the header). */
const QUIET = ["scripts/perf.test.ts"]
const CACHE = path.join(ROOT, "node_modules", ".cache", "test-fast.json")
const GROUP_SECONDS = 150
/** The limit of a group with a SCALE file: about a minute alone, 145 s measured with eleven other processes, 240 s is the test's own limit. */
const SCALE_GROUP_SECONDS = 300
const TAIL_LINES = 60
/** Bump when the rules in `inputs` change, so every remembered hash is dropped. */
const RULES = 3
/** A file that took this long runs alone; the other groups are filled up to `GROUP_FILL_SECONDS` of known duration. */
const ALONE_SECONDS = 5
const GROUP_FILL_SECONDS = 10
/** What an unmeasured file is assumed to take when groups are filled. */
const UNKNOWN_SECONDS = 1
const CODE = /\.(ts|tsx|mts|cts|js|mjs|cjs|jsx)$/
const SHARED = /(^|["'`/ ])(docs|\.github|scripts)\/|README|THIRD_PARTY|package\.json|tsconfig/
const SHARED_FILES = /^(docs\/|\.github\/|scripts\/|[^/]+$)/
/** Product source: the files that count by their code when a test only imports them. */
const SOURCE = /^(apps|packages)\/[^/]+\/src\/.*\.tsx?$/
const IN_SOURCE = /^(apps|packages)\/[^/]+\/src\//
/** Code that may open a source file as text: it names a source directory, lists directories or asks where a module is. */
const READS_SOURCES = /\bsrc\b|\b(apps|packages)\/|["'`](apps|packages)["'`]|ls-files|\bGlob\b|readdir|resolveSync|(import\.meta|require)\.resolve/
/** The variables bun reads to decide an AI agent is running it, which makes it print failures only. */
const AGENT_VARIABLES = ["CLAUDECODE", "AGENT", "REPL_ID"]

type Group = { key: string; files: string[] }
type Outcome = { group: Group; code: number; seconds: number; pass: number; fail: number; skip: number; output: string; fileSeconds: Map<string, number> }
type Memory = { rules: number; seconds: Record<string, number>; passed: Record<string, string> }
type Inputs = { files: string[]; imported: Set<string>; readsSources: boolean }

const VALUE_OPTIONS = ["--jobs", "--group"]
function option(name: string, fallback: number): number {
  const at = process.argv.indexOf(name)
  const value = at < 0 ? Number.NaN : Number(process.argv[at + 1])
  return Number.isInteger(value) && value >= 1 ? value : fallback
}

const jobs = option("--jobs", Math.max(2, cpus().length - 2))
const groupSize = option("--group", 6)
const everything = process.argv.includes("--all")
const listOnly = process.argv.includes("--list")
const filters = process.argv.slice(2).filter((arg, index, all) => !arg.startsWith("--") && !VALUE_OPTIONS.includes(all[index - 1] ?? ""))

/** Every file git knows or would add, relative to the root. */
const repoFiles = new TextDecoder().decode(Bun.spawnSync(["git", "ls-files", "-co", "--exclude-standard"], { cwd: ROOT }).stdout).split("\n").filter(Boolean)
const packageOf = (file: string) => file.match(/^(apps|packages)\/[^/]+/)?.[0]
const packages = [...new Set(repoFiles.map(packageOf).filter((name): name is string => name !== undefined))]

const texts = new Map<string, string>()
function text(file: string): string {
  let value = texts.get(file)
  if (value === undefined) {
    try { value = readFileSync(path.join(ROOT, file), "utf8") } catch { value = "" }
    texts.set(file, value)
  }
  return value
}
const digests = new Map<string, string>()
function digest(file: string): string {
  let value = digests.get(file)
  if (value === undefined) digests.set(file, (value = Bun.hash(text(file)).toString(36)))
  return value
}

const transpilers = { ts: new Bun.Transpiler({ loader: "ts" }), tsx: new Bun.Transpiler({ loader: "tsx" }) }
const transpiler = (file: string) => transpilers[/x$/.test(file) ? "tsx" : "ts"]
const scanned = new Map<string, string[]>()
/** The specifiers of one file's imports that exist at run time (bun leaves out the type-only ones, as it does when it runs the file). */
function specifiersOf(file: string): string[] {
  let found = scanned.get(file)
  if (found === undefined) {
    found = []
    if (CODE.test(file)) try { found = transpiler(file).scanImports(text(file)).map((entry) => entry.path) } catch { /* a file bun cannot scan has no tracked imports */ }
    scanned.set(file, found)
  }
  return found
}

const codes = new Map<string, string>()
/**
 * What bun runs of a TypeScript file: its text without comments, formatting and types. The text itself for anything else, for a
 * file bun cannot transpile, and for one that starts with bun's `// @bun` mark (already transpiled, run as it is).
 */
function code(file: string): string {
  let value = codes.get(file)
  if (value === undefined) {
    value = text(file)
    if (/\.tsx?$/.test(file) && !/^\s*\/\/ *@bun\b/.test(value)) try { value = transpiler(file).transformSync(value) } catch { /* the text */ }
    codes.set(file, value)
  }
  return value
}
const codeDigests = new Map<string, string>()
function codeDigest(file: string): string {
  let value = codeDigests.get(file)
  if (value === undefined) codeDigests.set(file, (value = Bun.hash(code(file)).toString(36)))
  return value
}

const readers = new Map<string, boolean>()
/** Whether a file's code, apart from what it imports, says something `READS_SOURCES` knows. */
function mayReadSources(file: string): boolean {
  let value = readers.get(file)
  if (value === undefined) {
    let rest = code(file)
    for (const specifier of new Set(specifiersOf(file))) rest = rest.replaceAll(`"${specifier}"`, "").replaceAll(`'${specifier}'`, "")
    readers.set(file, (value = READS_SOURCES.test(rest)))
  }
  return value
}

const imported = new Map<string, string[]>()
/** The repository files one file imports (workspace packages resolve to their source through node_modules). */
function imports(file: string): string[] {
  const known = imported.get(file)
  if (known) return known
  const found: string[] = []
  imported.set(file, found)
  for (const specifier of specifiersOf(file)) {
    if (specifier.startsWith("node:") || specifier.startsWith("bun")) continue
    try {
      const resolved = path.relative(ROOT, realpathSync(Bun.resolveSync(specifier, path.dirname(path.join(ROOT, file)))))
      if (!resolved.startsWith("..") && !resolved.includes("node_modules")) found.push(resolved)
    } catch { /* not a file of this repository */ }
  }
  return found
}

function closure(file: string): Set<string> {
  const seen = new Set<string>([file])
  const stack = [file]
  for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
    for (const dependency of imports(next)) if (!seen.has(dependency)) { seen.add(dependency); stack.push(dependency) }
  }
  return seen
}

/** The files whose content decides a test file's result, as far as it can be read from the source (see the header). */
function inputs(test: string): Inputs {
  const all = closure(test)
  const reached = new Set(all)
  const own = packageOf(test)
  const testDir = path.dirname(test)
  const named = packages.filter((name) => name !== own && [...all].some((file) => path.dirname(file) === testDir && text(file).includes(`${name}/`)))
  const shared = test.startsWith("scripts/") || [...all].some((file) => SHARED.test(text(file)))
  // The test's side of the closure (the test, its helpers, scripts): product source is not asked, it runs the same whatever its comments say.
  const readsSources = named.length > 0 || [...all].some((file) => CODE.test(file) && !IN_SOURCE.test(file) && mayReadSources(file))
  // A package started as a process brings what its source imports, too.
  for (const file of repoFiles) {
    if (named.some((name) => file.startsWith(`${name}/src/`))) for (const dependency of closure(file)) all.add(dependency)
  }
  for (const file of repoFiles) {
    if (all.has(file)) continue
    const inOwn = own !== undefined && file.startsWith(`${own}/`)
    if (inOwn && (!CODE.test(file) || (path.dirname(file) === testDir && !file.endsWith(".test.ts")))) all.add(file)
    else if (shared && SHARED_FILES.test(file) && !file.endsWith(".test.ts")) all.add(file)
  }
  return { files: [...all].sort(), imported: reached, readsSources }
}

const salt = `${RULES} ${Bun.version} ${digest("pnpm-lock.yaml")} ${digest("bunfig.toml")}`
function inputHash(test: string): string {
  const { files, imported, readsSources } = inputs(test)
  const byCode = (file: string) => !readsSources && SOURCE.test(file) && imported.has(file)
  return Bun.hash(`${salt}\n${files.map((file) => `${file} ${byCode(file) ? codeDigest(file) : digest(file)}`).join("\n")}`).toString(36)
}

function remembered(): Memory {
  try {
    const read = JSON.parse(readFileSync(CACHE, "utf8")) as Partial<Memory>
    if (read.rules === RULES) return { rules: RULES, seconds: read.seconds ?? {}, passed: read.passed ?? {} }
  } catch { /* first run */ }
  return { rules: RULES, seconds: {}, passed: {} }
}

/**
 * Files of one directory stay together, cut into groups of at most `groupSize` files and about `GROUP_FILL_SECONDS` of the
 * durations remembered in `seconds`. A file known to take `ALONE_SECONDS` or more is a group of its own.
 */
function groups(files: string[], seconds: Record<string, number>): Group[] {
  const byDir = new Map<string, string[]>()
  for (const file of files) byDir.set(path.dirname(file), [...(byDir.get(path.dirname(file)) ?? []), file])
  const out: Group[] = []
  for (const list of byDir.values()) {
    let open: string[] = []
    let filled = 0
    const close = () => {
      if (open.length) out.push({ key: open[0] as string, files: open })
      open = []
      filled = 0
    }
    for (const file of list) {
      const known = seconds[file] ?? UNKNOWN_SECONDS
      if (known >= ALONE_SECONDS) { out.push({ key: file, files: [file] }); continue }
      if (open.length >= groupSize || (open.length > 0 && filled + known > GROUP_FILL_SECONDS)) close()
      open.push(file)
      filled += known
    }
    close()
  }
  return out
}

const count = (output: string, word: string) => Number(output.match(new RegExp(`^ *(\\d+) ${word}`, "m"))?.[1] ?? 0)
const childEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !AGENT_VARIABLES.includes(name)))

/** Everything a stream carries, as text; `onLine` sees each complete line as it arrives. */
async function drain(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void): Promise<string> {
  const decoder = new TextDecoder()
  let all = ""
  let rest = ""
  for await (const chunk of stream) {
    const piece = decoder.decode(chunk, { stream: true })
    all += piece
    const lines = (rest + piece).split("\n")
    rest = lines.pop() ?? ""
    for (const line of lines) onLine(line)
  }
  return all
}

async function run(group: Group): Promise<Outcome> {
  const started = Date.now()
  const child = Bun.spawn(["bun", "test", ...group.files.map((file) => `./${file}`)], { cwd: ROOT, env: childEnv, stdout: "pipe", stderr: "pipe", stdin: "ignore" })
  const timer = setTimeout(() => child.kill("SIGKILL"), (group.files.some((file) => SCALE.includes(file)) ? SCALE_GROUP_SECONDS : GROUP_SECONDS) * 1000)
  // bun prints a file's name on a line of its own when it starts the file: the time to the next such line is what the file took.
  const marks: Array<{ file: string; at: number }> = []
  const onLine = (line: string) => {
    const file = line.match(/^(?:\.\/)?(\S+\.test\.ts):$/)?.[1]
    if (file !== undefined && group.files.includes(file) && !marks.some((mark) => mark.file === file)) marks.push({ file, at: Date.now() })
  }
  const [out, err, code] = await Promise.all([drain(child.stdout, onLine), drain(child.stderr, onLine), child.exited])
  clearTimeout(timer)
  const ended = Date.now()
  const output = out + err
  const fileSeconds = new Map(marks.map((mark, index) => [mark.file, ((marks[index + 1]?.at ?? ended) - mark.at) / 1000]))
  return { group, code, seconds: (ended - started) / 1000, pass: count(output, "pass"), fail: count(output, "fail"), skip: count(output, "skip"), output, fileSeconds }
}

async function pool<T>(items: T[], size: number, work: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items]
  await Promise.all(Array.from({ length: Math.min(size, queue.length) }, async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) await work(item)
  }))
}

/** What bun printed for the failing tests: the lines before each `(fail)`; a group that died without one shows its tail. */
function failureText(outcome: Outcome): string {
  const lines = outcome.output.split("\n")
  const summary = lines.findIndex((line) => /^ *\d+ tests? failed:$/.test(line))
  const body = summary < 0 ? lines : lines.slice(0, summary)
  const kept: string[] = []
  let since: string[] = []
  for (const line of body) {
    if (/^\((pass|skip|todo)\)/.test(line)) since = []
    else if (line.startsWith("(fail)")) { kept.push(...since.slice(-40), line, ""); since = [] }
    else if (line.trim()) since.push(line)
  }
  return (kept.length ? kept : lines.slice(-TAIL_LINES)).map((line) => `    | ${line}`).join("\n")
}

/** The names of the tests a group's output marks as failed. */
function failedTests(outcome: Outcome): string[] {
  return [...new Set(outcome.output.split("\n").filter((line) => line.startsWith("(fail) ")).map((line) => line.slice(7).replace(/ \[[\d.]+ms\]$/, "")))]
}

// Code that does not compile fails the run here, in seconds: started anyway, its test processes hung until they were killed.
if (!listOnly && !process.argv.includes("--no-typecheck")) {
  const checked = Bun.spawnSync([path.join(ROOT, "node_modules", ".bin", "tsc"), "-p", "tsconfig.base.json", "--noEmit"], { cwd: ROOT, env: { ...process.env, PWD: ROOT } })
  if (checked.exitCode !== 0) {
    console.error(`test-fast: the typecheck fails, no test was run\n${new TextDecoder().decode(checked.stdout).split("\n").slice(0, 20).join("\n")}`)
    process.exit(1)
  }
}
const startedAll = Date.now()
const wanted = repoFiles
  .filter((file) => file.endsWith(".test.ts") && SOURCES.some((source) => file.startsWith(`${source}/`)))
  .filter((file) => filters.length === 0 || filters.some((filter) => file.includes(filter)))
  .sort()
if (wanted.length === 0) {
  console.error(`test-fast: no test file matches ${filters.join(", ")}`)
  process.exit(2)
}
const left = everything || filters.length ? [] : wanted.filter((file) => SCALE.includes(file))
const memory = remembered()
const hashes = new Map(wanted.filter((file) => !left.includes(file)).map((file) => [file, inputHash(file)]))
const files = [...hashes.keys()].filter((file) => everything || memory.passed[file] !== hashes.get(file))
const unchanged = hashes.size - files.length
// A group no file of which was measured starts before the measured ones: its duration may be anything.
const expected = (group: Group) => group.files.reduce((total, file) => total + (memory.seconds[file] ?? Number.MAX_SAFE_INTEGER / 1024), 0)
const quiet = files.filter((file) => QUIET.includes(file))
const queue = groups(files.filter((file) => !quiet.includes(file)), memory.seconds).sort((a, b) => expected(b) - expected(a))
console.log(`test-fast: ${hashes.size} files, ${unchanged} unchanged since they last passed, ${files.length} to run in ${queue.length} groups, ${jobs} at a time (inputs read in ${((Date.now() - startedAll) / 1000).toFixed(1)}s)`)
if (listOnly) {
  for (const file of files) console.log(file)
  process.exit(0)
}

const outcomes: Outcome[] = []
await pool(queue, jobs, async (group) => { outcomes.push(await run(group)) })
for (const file of quiet) outcomes.push(await run({ key: file, files: [file] }))
const firstSeconds = (Date.now() - startedAll) / 1000

const failed = outcomes.filter((outcome) => outcome.code !== 0)
const still: Outcome[] = []
const logDir = process.env.MENDCODE_TEST_LOG_DIR
await pool(failed, 1, async (outcome) => {
  if (logDir) {
    try {
      mkdirSync(logDir, { recursive: true })
      writeFileSync(path.join(logDir, `fast-${outcome.group.key.replaceAll("/", "_")}.log`), outcome.output)
    } catch { /* the log is a convenience */ }
  }
  const again = await run(outcome.group)
  outcomes[outcomes.indexOf(outcome)] = { ...again, seconds: outcome.seconds, fileSeconds: outcome.fileSeconds }
  if (again.code === 0) console.log(`  passed on a second run, failed under load: ${outcome.group.files.join(" ")}${failedTests(outcome).map((name) => `\n      ${name}`).join("")}`)
  else still.push(again)
})

try {
  for (const outcome of outcomes) {
    for (const [file, seconds] of outcome.fileSeconds) memory.seconds[file] = Math.round(seconds * 10) / 10
    for (const file of outcome.group.files) {
      if (outcome.code === 0) memory.passed[file] = hashes.get(file) as string
      else delete memory.passed[file]
    }
  }
  mkdirSync(path.dirname(CACHE), { recursive: true })
  writeFileSync(CACHE, JSON.stringify(memory))
} catch { /* without the file the next run only runs more than it needs to */ }

for (const outcome of still) {
  console.log(`\n  FAIL (exit ${outcome.code}) ${outcome.group.files.join(" ")}\n${failureText(outcome)}`)
}
const sum = (pick: (outcome: Outcome) => number) => outcomes.reduce((value, outcome) => value + pick(outcome), 0)
const measured = outcomes.flatMap((outcome) => [...outcome.fileSeconds])
if (measured.length) console.log(`slowest   ${measured.sort((a, b) => b[1] - a[1]).slice(0, 5).map(([file, seconds]) => `${seconds.toFixed(0)}s ${file}`).join(", ")}`)
if (left.length) console.log(`left out  ${left.join(" ")} (scale measurements; --all runs them)`)
if (unchanged) console.log(`not run   ${unchanged} files whose inputs are what they were when they last passed (--all runs them)`)
console.log(`total     ${((Date.now() - startedAll) / 1000).toFixed(0)}s (${firstSeconds.toFixed(0)}s first pass)  ${sum((o) => o.pass)} pass  ${sum((o) => o.skip)} skip  ${still.length ? `${still.length} groups FAILED` : "passed"}${failed.length > still.length ? `  (${failed.length - still.length} groups needed the second run)` : ""}`)
process.exit(still.length ? 1 : 0)
