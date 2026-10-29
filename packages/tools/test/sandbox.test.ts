import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { bwrapArguments, createBackgroundTasks, sandboxBackend, sandboxCommand, sandboxHint, sandboxPolicy, seatbeltProfile, shell, type SandboxPolicy } from "../src"
import { makeContext, useTempDir } from "./helpers"

const tmp = useTempDir()

const policy = (overrides: Partial<SandboxPolicy> = {}): SandboxPolicy => ({ mode: "workspace-write", network: false, writable: ["/work/project"], protect: ["/work/project/.git/hooks"], ...overrides })

describe("sandbox policy", () => {
  test("off or unset means no sandbox", () => {
    expect(sandboxPolicy({ config: undefined, cwd: "/work" })).toBeUndefined()
    expect(sandboxPolicy({ config: { mode: "off", network: "on" }, cwd: "/work" })).toBeUndefined()
  })

  test("read-only writes nothing and workspace-write confines writes to the project, temp and the extra roots", () => {
    expect(sandboxPolicy({ config: { mode: "read-only" }, cwd: tmp() })).toEqual({ mode: "read-only", network: false, writable: [], protect: [] })
    const root = tmp()
    const extra = tmp()
    const result = sandboxPolicy({ config: { mode: "workspace-write", network: "on", writableRoots: [extra, "relative/ignored"] }, cwd: root, temp: [] })!
    expect(result.network).toBe(true)
    expect(result.writable.map((entry) => entry.split("/").pop())).toEqual([root.split("/").pop(), extra.split("/").pop()])
    expect(result.protect.some((entry) => entry.endsWith("/.git/hooks"))).toBe(true)
    expect(result.protect.some((entry) => entry.endsWith("/.git/config"))).toBe(true)
    expect(result.protect.some((entry) => entry.endsWith("/.mendcode"))).toBe(true)
  })

  test("network is off unless the setting says on", () => {
    expect(sandboxPolicy({ config: { mode: "workspace-write" }, cwd: tmp() })!.network).toBe(false)
    expect(sandboxPolicy({ config: { mode: "workspace-write", network: "off" }, cwd: tmp() })!.network).toBe(false)
  })
})

describe("sandbox command wrapping", () => {
  test("seatbelt profile denies writes, re-allows the roots, re-denies the protected paths and cuts the network", () => {
    const profile = seatbeltProfile(policy())
    const lines = profile.split("\n")
    expect(lines.indexOf("(deny file-write*)")).toBeLessThan(lines.findIndex((line) => line.includes('(subpath "/work/project")') && line.startsWith("(allow")))
    expect(lines.findIndex((line) => line.startsWith("(deny file-write*") && line.includes("/.git/hooks"))).toBeGreaterThan(lines.findIndex((line) => line.includes('(subpath "/work/project")') && line.startsWith("(allow")))
    expect(profile).toContain("(deny network*)")
    expect(seatbeltProfile(policy({ network: true }))).not.toContain("network")
    expect(seatbeltProfile({ mode: "read-only", network: false, writable: [], protect: [] })).not.toMatch(/\(allow file-write\* \(subpath "\/work/)
  })

  test("a path cannot break out of the profile string", () => {
    const profile = seatbeltProfile(policy({ writable: ['/work/a"b)(allow default)'] }))
    expect(profile).toContain('(subpath "/work/a\\"b)(allow default)")')
    expect(() => seatbeltProfile(policy({ writable: ["/work/a\nb"] }))).toThrow()
    const refused = sandboxCommand({ argv: ["sh"], policy: policy({ writable: ["/work/a\nb"] }), backend: { name: "seatbelt", binary: "/usr/bin/sandbox-exec" } })
    expect(refused.ok).toBe(false)
  })

  test("bubblewrap arguments: read-only root, writable binds, protected re-binds, no network namespace sharing", () => {
    const args = bwrapArguments({ policy: policy(), exists: () => true })
    expect(args.slice(args.indexOf("--ro-bind"), args.indexOf("--ro-bind") + 3)).toEqual(["--ro-bind", "/", "/"])
    expect(args).toContain("--unshare-net")
    expect(args).toContain("--new-session")
    const bind = args.indexOf("--bind")
    expect(args.slice(bind, bind + 3)).toEqual(["--bind", "/work/project", "/work/project"])
    expect(args.lastIndexOf("--ro-bind")).toBeGreaterThan(bind)
    expect(bwrapArguments({ policy: policy({ network: true }), interactive: true, exists: () => false })).not.toContain("--unshare-net")
    expect(bwrapArguments({ policy: policy(), interactive: true, exists: () => false })).not.toContain("--new-session")
    expect(bwrapArguments({ policy: policy(), exists: () => false })).not.toContain("--bind")
  })

  test("argv is wrapped for the backend and untouched without a policy", () => {
    expect(sandboxCommand({ argv: ["sh", "-c", "ls"], policy: undefined })).toEqual({ ok: true, argv: ["sh", "-c", "ls"] })
    const seat = sandboxCommand({ argv: ["sh", "-c", "ls"], policy: policy(), backend: { name: "seatbelt", binary: "/usr/bin/sandbox-exec" } })
    expect(seat).toMatchObject({ ok: true })
    if (seat.ok) expect([seat.argv[0], seat.argv[1], ...seat.argv.slice(3)]).toEqual(["/usr/bin/sandbox-exec", "-p", "sh", "-c", "ls"])
    const bwrap = sandboxCommand({ argv: ["sh", "-c", "ls"], policy: policy(), backend: { name: "bwrap", binary: "/usr/bin/bwrap" } })
    if (bwrap.ok) expect(bwrap.argv.slice(-4)).toEqual(["--", "sh", "-c", "ls"])
  })

  test("with a policy and no backend nothing runs: it fails closed", () => {
    const result = sandboxCommand({ argv: ["sh"], policy: policy(), backend: null })
    expect(result).toMatchObject({ ok: false })
    expect(result.ok === false && result.error).toContain("/sandbox off")
  })

  test("backend detection follows the platform", () => {
    expect(sandboxBackend({ platform: "darwin", exists: () => true })).toEqual({ name: "seatbelt", binary: "/usr/bin/sandbox-exec" })
    expect(sandboxBackend({ platform: "darwin", exists: () => false })).toBeUndefined()
    expect(sandboxBackend({ platform: "linux", exists: (file) => file === "/usr/bin/bwrap" })).toEqual({ name: "bwrap", binary: "/usr/bin/bwrap" })
    expect(sandboxBackend({ platform: "linux", exists: () => false })).toBeUndefined()
    expect(sandboxBackend({ platform: "win32", exists: () => true })).toBeUndefined()
  })

  test("the hint appears only for output that looks like a sandbox refusal", () => {
    expect(sandboxHint({ output: "touch: x: Operation not permitted", policy: policy() })).toContain("/sandbox")
    expect(sandboxHint({ output: "curl: (6) Could not resolve host: example.com", policy: policy() })).toContain("network off")
    expect(sandboxHint({ output: "tests failed: 3", policy: policy() })).toBe("")
  })
})

// Real enforcement: only where this system has a working backend (a nested sandbox or a disabled user namespace skips it).
const backend = sandboxBackend()
async function works(): Promise<boolean> {
  if (!backend) return false
  const root = tmp()
  const probe = await shell.execute({ command: "true" }, { ...makeContext({ cwd: root }), sandbox: sandboxPolicy({ config: { mode: "workspace-write" }, cwd: root })! })
  return !probe.isError
}
const live = (await works()) ? test : test.skip

describe("sandbox enforcement through the shell tool", () => {
  live("workspace-write lets a command write in the project and blocks writes outside it", async () => {
    const root = tmp()
    const outside = tmp()
    const sandbox = sandboxPolicy({ config: { mode: "workspace-write" }, cwd: root, temp: [] })!
    const context = { ...makeContext({ cwd: root }), sandbox }
    const inside = await shell.execute({ command: "echo hi > inside.txt && cat inside.txt" }, context)
    expect(inside.isError).toBe(false)
    expect(readFileSync(join(root, "inside.txt"), "utf8")).toBe("hi\n")
    const blocked = await shell.execute({ command: `echo no > ${outside}/outside.txt` }, context)
    expect(blocked.isError).toBe(true)
    expect(existsSync(join(outside, "outside.txt"))).toBe(false)
    expect(blocked.output).toContain("[sandbox workspace-write, network off")
  })

  live("protected paths stay read-only inside the project", async () => {
    const root = tmp()
    mkdirSync(join(root, ".git/hooks"), { recursive: true })
    const context = { ...makeContext({ cwd: root }), sandbox: sandboxPolicy({ config: { mode: "workspace-write" }, cwd: root, temp: [] })! }
    const hook = await shell.execute({ command: "echo '#!/bin/sh' > .git/hooks/pre-commit" }, context)
    expect(hook.isError).toBe(true)
    expect(existsSync(join(root, ".git/hooks/pre-commit"))).toBe(false)
    const ordinary = await shell.execute({ command: "echo ok > .git/HEAD" }, context)
    expect(ordinary.isError).toBe(false)
  })

  live("read-only blocks every write, reads still work", async () => {
    const root = tmp()
    writeFileSync(join(root, "a.txt"), "data")
    const context = { ...makeContext({ cwd: root }), sandbox: sandboxPolicy({ config: { mode: "read-only" }, cwd: root })! }
    expect((await shell.execute({ command: "cat a.txt" }, context)).output).toBe("data")
    const write = await shell.execute({ command: "echo x > b.txt" }, context)
    expect(write.isError).toBe(true)
    expect(existsSync(join(root, "b.txt"))).toBe(false)
  })

  live("the network is off by default and opens with network on", async () => {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("pong") })
    try {
      const root = tmp()
      const command = `curl -s -m 3 http://127.0.0.1:${server.port}/`
      const off = await shell.execute({ command }, { ...makeContext({ cwd: root }), sandbox: sandboxPolicy({ config: { mode: "workspace-write" }, cwd: root })! })
      expect(off.output).not.toContain("pong")
      const on = await shell.execute({ command }, { ...makeContext({ cwd: root }), sandbox: sandboxPolicy({ config: { mode: "workspace-write", network: "on" }, cwd: root })! })
      expect(on.output).toContain("pong")
    } finally {
      server.stop(true)
    }
  })

  live("background tasks run under the same sandbox", async () => {
    const root = tmp()
    const outside = tmp()
    const registry = createBackgroundTasks({})
    try {
      const port = registry.forSession("s1")
      const started = port.start({ command: `echo a > ${root}/ok.txt; echo b > ${outside}/no.txt; echo done`, cwd: root, sandbox: sandboxPolicy({ config: { mode: "workspace-write" }, cwd: root, temp: [] })! })
      if (!started.ok) throw new Error(started.error)
      await port.read(started.task.id, { waitMs: 3_000, signal: new AbortController().signal })
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(existsSync(join(root, "ok.txt"))).toBe(true)
      expect(existsSync(join(outside, "no.txt"))).toBe(false)
    } finally {
      registry.stop()
    }
  })
})
