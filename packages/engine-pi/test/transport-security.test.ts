import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { seatbeltProfile, type SandboxPolicy } from "@mendcode/tools"
import { spawnPi, type PiTransport } from "../src/transport"
import { probePi } from "../src/config"

const dirs: string[] = []
const transports: PiTransport[] = []
afterEach(() => {
  for (const transport of transports.splice(0)) transport.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

test("pi is wrapped in the native shell profile with an argument array, including network and protected paths", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mendcode-pi-sandbox-"))
  dirs.push(dir)
  const log = join(dir, "sandbox-argv.json")
  const fake = join(dir, "fake-sandbox.ts")
  // The test backend records its argv and exits; it deliberately does not claim OS enforcement.
  writeFileSync(fake, `#!${process.execPath}\nimport { writeFileSync } from "node:fs"\nwriteFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)))\n`, { mode: 0o700 })
  const policy: SandboxPolicy = { mode: "workspace-write", network: false, writable: [dir], protect: [join(dir, ".mendcode"), join(dir, ".git", "hooks")] }
  const args = ["--mode", "rpc", "--no-extensions", "-e", join(dir, "bridge.ts"), "--model", "provider/model; not a shell"]
  const transport = spawnPi({ command: "pi-test", args, env: {}, cwd: dir, sandbox: policy, sandboxBackend: { name: "seatbelt", binary: fake } })
  transports.push(transport)
  expect(await transport.exited).toBe(0)
  const argv = JSON.parse(readFileSync(log, "utf8")) as string[]
  expect(argv).toEqual(["-p", seatbeltProfile(policy), "pi-test", ...args])
  expect(argv[1]).toContain("(deny network*)")
  expect(argv[1]).toContain('(deny file-write* (subpath "')
  expect(argv[1]).toContain(join(dir, ".mendcode"))
  expect(argv[1]).toContain(join(dir, ".git", "hooks"))
})

test("an enabled sandbox with no backend refuses pi and its probes instead of falling back to an unconfined process", async () => {
  const policy: SandboxPolicy = { mode: "read-only", network: false, writable: [], protect: [] }
  expect(() => spawnPi({ command: process.execPath, args: [], env: {}, cwd: tmpdir(), sandbox: policy, sandboxBackend: null })).toThrow("no sandbox backend")
  expect(await probePi({ command: process.execPath, sandbox: policy, sandboxBackend: null })).toEqual({ ok: false })
})

test("both capability probes run in an empty temp cwd under the same shell profile", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mendcode-pi-probe-sandbox-"))
  dirs.push(dir)
  const fake = join(dir, "fake-sandbox.ts")
  const log = join(dir, "probes.jsonl")
  const help = readFileSync(join(import.meta.dir, "fixtures", "pi-help.txt"), "utf8")
  writeFileSync(fake, `#!${process.execPath}\nimport { appendFileSync } from "node:fs"\nappendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }) + "\\n")\nprocess.stdout.write(process.argv.includes("--version") ? "0.85.1\\n" : ${JSON.stringify(help)})\n`, { mode: 0o700 })
  const policy: SandboxPolicy = { mode: "read-only", network: false, writable: [], protect: [] }
  expect(await probePi({ command: "pi-test", sandbox: policy, sandboxBackend: { name: "seatbelt", binary: fake } })).toMatchObject({ ok: true, capabilities: { disableExtensions: true } })
  const calls = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line))
  expect(calls.map((call) => call.argv)).toEqual([
    ["-p", seatbeltProfile(policy), "pi-test", "--version"],
    ["-p", seatbeltProfile(policy), "pi-test", "--no-extensions", "--help"],
  ])
  expect(calls[0].cwd).toBe(calls[1].cwd)
  expect(calls[0].cwd).toContain("mendcode-pi-probe-")
  expect(calls[0].cwd).not.toBe(dir)
})

test("the records end only after stderr was read to its end, so an exit carries the last words written after stdout closed", async () => {
  // stdout closes at once; the reason arrives on stderr 150 ms later, as from a process that dies while flushing.
  const transport = spawnPi({ command: "/bin/sh", args: ["-c", "exec 1>&-; sleep 0.15; echo 'boom: late words' >&2"], env: {}, cwd: tmpdir() })
  for await (const _ of transport.lines) { /* no records */ }
  expect(transport.stderrTail()).toBe("boom: late words")
})

test("a grandchild that keeps stderr open does not hold the exit for long", async () => {
  const transport = spawnPi({ command: "/bin/sh", args: ["-c", "exec 1>&-; (sleep 5 &) ; echo first >&2"], env: {}, cwd: tmpdir() })
  const started = Date.now()
  for await (const _ of transport.lines) { /* no records */ }
  expect(Date.now() - started).toBeLessThan(2_000)
  expect(transport.stderrTail()).toBe("first")
  transport.close()
})
