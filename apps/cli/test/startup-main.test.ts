import { afterEach, expect, test } from "bun:test"
import { existsSync, readdirSync } from "node:fs"
import path from "node:path"
import { cleanTemps, tempDir } from "./session-ui-harness"
import { boot, stop, until, type NativeHarness } from "../../../packages/daemon/test/native-harness"

const harnesses: NativeHarness[] = []
afterEach(async () => { for (const h of harnesses.splice(0)) await h.cleanup(); cleanTemps() })
const entry = path.join(import.meta.dir, "../src/entry.ts")
function launch(dir: string, args: string[], stdin = "", env: Record<string, string> = {}) {
  return Bun.spawn([process.execPath, entry, "--dir", dir, ...args], { stdin: new Blob([stdin]), stdout: "pipe", stderr: "pipe", env: { ...process.env, HOME: dir, CODEX_HOME: dir, MENDCODE_V2_DIR: dir, ...env } })
}
async function output(child: ReturnType<typeof launch>) {
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  return { out, err, code }
}

test("main combines positional prompt and piped stdin; explicit cwd and title reach the session", async () => {
  const h = await boot({ steps: [stop("CLI answer.")] })
  harnesses.push(h)
  const result = await output(launch(h.dir, ["run", "Review", "--cwd", h.project, "--title", "CLI review", "--model", "gpt-6-sol", "--variant", "high", "--agent", "plan"], "these changes\n"))
  expect(result.code).toBe(0)
  expect(result.out).toBe("CLI answer.\n")
  expect(result.err).toContain("session: ses_")
  expect(JSON.stringify(h.requests[0]?.messages)).toContain("Review\\nthese changes")
  const listed = await h.client.send({ type: "session.list", directory: h.project })
  const sessions = listed.ok ? listed.result?.sessions as { sessionId: Parameters<typeof h.client.getSession>[0]; title: string }[] : []
  expect(sessions[0]?.title).toBe("CLI review")
  const detail = await h.client.getSession(sessions[0]!.sessionId)
  expect(detail.ok && detail.session.directory).toBe(h.project)
  expect(detail.ok && detail.session.permission).toBe("plan")
}, 15_000)

test("usage errors never launch a daemon or expose supplied passwords", async () => {
  const dir = tempDir()
  for (const args of [["run", "go", "--cwd", path.join(dir, "missing")], ["run", "go", "--fork"], ["run", "go", "--password=do-not-print"]]) {
    const result = await output(launch(dir, args))
    expect(result.code).toBe(64)
    expect(result.err).not.toContain("do-not-print")
    expect(existsSync(path.join(dir, "mendd.sock"))).toBe(false)
  }
}, 15_000)

// The slow-machine case (Linux CI): the signal lands while the temporary daemon is still starting, before this process has connected to it.
for (const signal of ["SIGTERM", "SIGINT"] as const) test(`isolated TUI told to stop with ${signal} the moment its temporary directory exists still stops its daemon and exits 0`, async () => {
  const dir = tempDir()
  const root = tempDir()
  const child = launch(dir, ["--cwd", dir, "--engine", "faux", "--isolated", "--initial-message", "Draft only"], "", { TMPDIR: root })
  const result = output(child)
  try {
    let isolated = ""
    await until(() => {
      isolated = readdirSync(root).filter((name) => name.startsWith("mendcode-isolated-")).map((name) => path.join(root, name)).find(existsSync) ?? ""
      return !!isolated
    })
    child.kill(signal)
    expect((await result).code).toBe(0)
    await until(() => !existsSync(path.join(isolated, "mendd.sock")))
  } finally { if (child.exitCode === null) child.kill("SIGKILL"); await result }
}, 15_000)

for (const signal of ["SIGTERM", "SIGINT"] as const) test(`isolated TUI starts its own temporary daemon and shuts it down on ${signal}`, async () => {
  const dir = tempDir()
  const root = tempDir()
  const child = launch(dir, ["--cwd", dir, "--engine", "faux", "--isolated", "--initial-message", "Draft only"], "", { TMPDIR: root })
  const result = output(child)
  try {
    let socket = ""
    await until(() => {
      socket = readdirSync(root).filter((name) => name.startsWith("mendcode-isolated-")).map((name) => path.join(root, name, "mendd.sock")).find(existsSync) ?? ""
      return !!socket
    })
    expect(existsSync(path.join(dir, "mendd.sock"))).toBe(false)
    await Bun.sleep(100)
    child.kill(signal)
    expect((await result).code).toBe(0)
    await until(() => !existsSync(socket))
  } finally { if (child.exitCode === null) child.kill("SIGTERM"); await result }
}, 15_000)
