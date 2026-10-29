import { afterAll, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

/**
 * scripts/test-shards.sh against a fake `bun` (and fake `timeout` / `setsid`) on PATH: the reporter, the signal report and the
 * heartbeat that CI relies on to say why a run ended, none of which can be seen from the suite itself.
 */

const SCRIPT = path.join(import.meta.dir, "test-shards.sh")
const root = mkdtempSync(path.join(tmpdir(), "mend-shards-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const FAKE_BUN = `#!/bin/sh
case "\${FAKE_BUN_MODE:-pass}" in
  pass) printf 'apps/cli/test/a.test.ts:\\n(pass) fine [1ms]\\n\\n 1 pass\\n 0 fail\\nRan 1 tests across 1 files. [5ms]\\n' ;;
  fail)
    cat <<'EOF'
::group::apps/cli/test/a.test.ts:
(pass) fine [1ms]
::endgroup::
::group::apps/cli/test/b.test.ts:
12 |   expect(1).toBe(2)
error: expect(received).toBe(expected)
Expected: 2
Received: 1
::error file=apps/cli/test/b.test.ts,line=12::Expected: 2
(fail) the broken one [12ms]
::endgroup::
::group::apps/cli/test/c.test.ts:
Test "slow" timed out after 15000ms
::error title=error: Test "slow" timed out after 15000ms::
(fail) the slow one [15001ms]
 ^ this test timed out after 15000ms.
::endgroup::
::group::apps/cli/test/z.test.ts:
(pass) last [1ms]
::endgroup::

 2 tests failed:
(fail) the broken one [12ms]
(fail) the slow one [15001ms]

 1 pass
 2 fail
Ran 3 tests across 4 files. [20.00s]
EOF
    exit 1 ;;
  hang) printf 'apps/cli/test/slow.test.ts:\\n(pass) one [1ms]\\n'; exec sleep 30 ;;
  short) printf 'apps/cli/test/slow.test.ts:\\n(pass) one [1ms]\\n'; sleep 2.5; printf ' 1 pass\\nRan 1 tests across 1 files. [2.5s]\\n' ;;
  agent) printf 'apps/cli/test/a.test.ts:\\n(pass) agent=[%s%s%s]\\n\\n 1 pass\\n 0 fail\\nRan 1 tests across 1 files. [5ms]\\n' "\${CLAUDECODE:-}" "\${AGENT:-}" "\${REPL_ID:-}" ;;
  selfterm) printf 'apps/cli/test/slow.test.ts:\\n(pass) one [1ms]\\n'; kill -TERM $$; sleep 5 ;;
esac
`

const FAKE_TIMEOUT = `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_TOOLS_LOG"
shift 3
exec "$@"
`

const FAKE_SETSID = `#!/bin/sh
printf 'setsid %s\\n' "$*" >> "$FAKE_TOOLS_LOG"
[ "$1" = "--wait" ] && shift
exec "$@"
`

function bin(tools: Record<string, string>) {
  const dir = mkdtempSync(path.join(root, "bin-"))
  for (const [name, body] of Object.entries(tools)) {
    writeFileSync(path.join(dir, name), body)
    chmodSync(path.join(dir, name), 0o755)
  }
  return dir
}

// `daemon` is a part that runs as one process; `cli` runs as one process per 40 files (see the last test).
type Run = { mode: string; part?: string; tools?: Record<string, string>; env?: Record<string, string> }

function launch({ mode, part = "daemon", tools = {}, env = {} }: Run) {
  const toolsDir = bin({ bun: FAKE_BUN, ...tools })
  const logDir = path.join(mkdtempSync(path.join(root, "logs-")), "kept")
  const toolsLog = path.join(root, `tools-${Math.random().toString(36).slice(2)}.log`)
  // CI runs `sh scripts/test-shards.sh` and sh is dash on Ubuntu: use dash where it exists, the host's sh elsewhere (macOS: bash).
  const child = Bun.spawn([Bun.which("dash") ?? "sh", SCRIPT, part], {
    detached: true,
    stdout: "pipe",
    stderr: "pipe",
    env: { PATH: `${toolsDir}:${process.env.PATH}`, HOME: process.env.HOME ?? root, FAKE_BUN_MODE: mode, FAKE_TOOLS_LOG: toolsLog, MENDCODE_TEST_LOG_DIR: logDir, ...env },
  })
  const text = async () => {
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    return { out, err, code }
  }
  return { child, text, logDir, toolsLog }
}

describe("failure report", () => {
  test("each failure is listed once under the file it belongs to; the closing summary is not read as more failures of the last file", async () => {
    const { text } = launch({ mode: "fail" })
    const { out, code } = await text()
    expect(code).toBe(1)
    const failing = out.split("\n").filter((line) => line.startsWith("  FAIL "))
    expect(failing).toEqual(["  FAIL apps/cli/test/b.test.ts", "  FAIL apps/cli/test/c.test.ts"])
    expect(out).toContain("    the broken one [12ms]")
    expect(out).toContain("    the slow one [15001ms]")
    expect(out).toContain("this test timed out after 15000ms.")
    expect(out).toContain("      | Expected: 2")
    // The annotation copies are dropped, and nothing is filed under the last file or the group markers.
    expect(out).not.toContain("::error")
    expect(out).not.toContain("::group::")
    expect(out).not.toContain("z.test.ts")
  })
})

describe("what the run says about how it ended", () => {
  test("a heartbeat line names the part, the time, the load and memory, and the test file it is in", async () => {
    const { text } = launch({ mode: "short", env: { MENDCODE_TEST_HEARTBEAT_SECONDS: "1" } })
    const { out, code } = await text()
    expect(code).toBe(0)
    expect(out).toMatch(/heartbeat daemon\s+\+\s*\d+s load=\S+ .*top=\[.*\] last=apps\/cli\/test\/slow\.test\.ts\n/)
    expect(out).toMatch(/daemon\s+\d+s\s+exit 0/)
  }, 20_000)

  test("a SIGTERM to the whole group is reported with the part, the test file and the process table, and the script exits 143", async () => {
    const { child, text, logDir } = launch({ mode: "hang" })
    // The part has started and printed its first file when its log has the file: give the shell a moment, then signal the group as the runner would.
    await Bun.sleep(1500)
    process.kill(-child.pid, "SIGTERM")
    const { out, code } = await text()
    expect(code).toBe(143)
    expect(out).toContain('test-shards: received SIGTERM during part "daemon"')
    expect(out).toContain("last test file: apps/cli/test/slow.test.ts")
    expect(out).toContain("biggest processes")
    expect(existsSync(path.join(logDir, "daemon.log"))).toBe(true)
    expect(readFileSync(path.join(logDir, "daemon.log"), "utf8")).toContain("slow.test.ts")
  }, 20_000)

  test("a part killed by a signal fails the run and names the signal, and the script itself carries on to report it", async () => {
    const { text } = launch({ mode: "selfterm" })
    const { out, code } = await text()
    expect(code).toBe(1)
    expect(out).toContain("PART ENDED BY SIGNAL 15 (TERM) in test file: apps/cli/test/slow.test.ts")
    expect(out).toMatch(/total\s+\d+s\s+FAILED/)
  }, 20_000)

  test("a part that prints nothing for the silence limit is named with its test file and its processes, killed, and fails the run", async () => {
    const { text, logDir } = launch({ mode: "hang", env: { MENDCODE_TEST_SILENCE_SECONDS: "1" } })
    const { out, code } = await text()
    expect(code).toBe(1)
    expect(out).toMatch(/daemon\s+HUNG {2}no output for 1s, \d+s into the part; last test file: apps\/cli\/test\/slow\.test\.ts\n/)
    expect(out).toContain("the part and every process below it")
    // The hung process itself is in the listing: the fake bun became `sleep 30`.
    expect(out).toMatch(/\n {6}\s*\d+\s+\d+\s+\d+\s+\S+\s+\S+\s+sleep 30\n/)
    expect(out).toMatch(/daemon\s+\d+s\s+exit 137/)
    expect(out).toContain("PART HUNG: killed after 1s without output")
    expect(out).toContain("      | (pass) one [1ms]")
    expect(out).not.toContain("PART TIMED OUT")
    expect(out).toMatch(/total\s+\d+s\s+FAILED/)
    expect(readFileSync(path.join(logDir, "daemon.log"), "utf8")).toContain("slow.test.ts")
  }, 30_000)

  test("a silence limit of 0 turns the check off and a value that is not a whole number is refused", async () => {
    const off = launch({ mode: "pass", env: { MENDCODE_TEST_SILENCE_SECONDS: "0" } })
    const first = await off.text()
    expect(first.code).toBe(0)
    expect(first.out).toMatch(/daemon\s+\d+s\s+exit 0/)
    const refused = launch({ mode: "pass", env: { MENDCODE_TEST_SILENCE_SECONDS: "never" } })
    const second = await refused.text()
    expect(second.code).toBe(2)
    expect(second.err).toContain("MENDCODE_TEST_SILENCE_SECONDS must be a whole number")
  }, 20_000)

  test("bun never sees the variables that make it print failures only, so the log names every file whoever starts the run", async () => {
    const { text, logDir } = launch({ mode: "agent", env: { CLAUDECODE: "1", AGENT: "1", REPL_ID: "1" } })
    const { code } = await text()
    expect(code).toBe(0)
    expect(readFileSync(path.join(logDir, "daemon.log"), "utf8")).toContain("(pass) agent=[]")
  }, 20_000)

  test("the part limit and the new session go through `timeout` and `setsid --wait`, and a bad heartbeat value is refused", async () => {
    const run = launch({ mode: "pass", tools: { timeout: FAKE_TIMEOUT, setsid: FAKE_SETSID }, env: { MENDCODE_TEST_PART_SECONDS: "60", MENDCODE_TEST_NEW_SESSION: "1", MENDCODE_TEST_TIME_SCALE: "3" } })
    const { out, code } = await run.text()
    expect(code).toBe(0)
    expect(out).toMatch(/daemon\s+\d+s\s+exit 0/)
    expect(readFileSync(run.toolsLog, "utf8").split("\n").filter(Boolean)).toEqual(["setsid --wait true", "setsid --wait timeout -k 15 60 bun test --timeout 15000 packages/daemon", "-k 15 60 bun test --timeout 15000 packages/daemon"])
    const refused = launch({ mode: "pass", env: { MENDCODE_TEST_HEARTBEAT_SECONDS: "soon" } })
    const result = await refused.text()
    expect(result.code).toBe(2)
    expect(result.err).toContain("MENDCODE_TEST_HEARTBEAT_SECONDS must be a whole number")
  }, 20_000)

  test("cli runs as labelled processes of at most 40 files whose lists are disjoint and together name every apps/cli test file", async () => {
    const run = launch({ mode: "pass", part: "cli", tools: { timeout: FAKE_TIMEOUT }, env: { MENDCODE_TEST_PART_SECONDS: "60" } })
    const { out, code } = await run.text()
    expect(code).toBe(0)
    const all = [...new Bun.Glob("apps/cli/**/*.test.ts").scanSync({ cwd: path.join(import.meta.dir, "..") })].filter((file) => !file.includes("node_modules"))
    const processes = Math.ceil(all.length / 40)
    for (let n = 1; n <= processes; n++) {
      expect(out).toMatch(new RegExp(`cli-${n}\\s+\\d+s\\s+exit 0`))
      expect(existsSync(path.join(run.logDir, `cli-${n}.log`))).toBe(true)
    }
    const lists = readFileSync(run.toolsLog, "utf8").split("\n").filter(Boolean).map((line) => line.split(" ").filter((word) => word.endsWith(".test.ts")))
    expect(lists).toHaveLength(processes)
    for (const list of lists) expect(list.length).toBeGreaterThan(0)
    for (const list of lists) expect(list.length).toBeLessThanOrEqual(40)
    const named = lists.flat()
    expect(new Set(named).size).toBe(named.length)
    expect(named.toSorted()).toEqual(all.toSorted())
  }, 60_000)
})
