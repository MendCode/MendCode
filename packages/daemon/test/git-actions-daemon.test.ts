import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { mkdirSync } from "node:fs"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { Command, createIdFactory, isReadOnlyCommand, type SessionId } from "@mendcode/protocol"
import { startDaemon } from "../src"
import { remoteTokens } from "../src/remote"
import { bench, cleanBenches, cleanBenchTemplates, type Bench } from "./git-actions-bench"

const ids = createIdFactory()
const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  cleanBenches()
})
afterAll(cleanBenchTemplates)

const URL = "https://github.com/acme/widgets/pull/42"
const OFF = "push and pull requests are off"

describe("the commands", () => {
  const shape = (type: string, extra: Record<string, unknown> = {}) => ({ type, id: ids("command"), clientId: ids("client"), directory: "/project", ...extra })

  test("take a directory and what each needs, nothing that could force, tag, mirror or delete, and none is a read-only command", () => {
    expect(Command.safeParse(shape("git.push")).success).toBe(true)
    expect(Command.safeParse(shape("git.push", { preview: true, confirm: "main", sessionId: ids("session") })).success).toBe(true)
    expect(Command.safeParse(shape("git.pr.view")).success).toBe(true)
    expect(Command.safeParse(shape("git.pr.create", { title: "T", body: "B", base: "main", draft: true, preview: true })).success).toBe(true)
    for (const extra of [{ force: true }, { forceWithLease: true }, { tags: true }, { all: true }, { mirror: true }, { delete: true }, { remote: "origin" }, { branch: "main" }, { refspec: "a:b" }, { argv: ["git"] }]) {
      expect(Command.safeParse(shape("git.push", extra)).success).toBe(false)
      expect(Command.safeParse(shape("git.pr.create", extra)).success).toBe(false)
    }
    expect(Command.safeParse(shape("git.pr.create", { title: "x".repeat(257) })).success).toBe(false)
    expect(Command.safeParse(shape("git.pr.create", { body: "x".repeat(16_001) })).success).toBe(false)
    expect(Command.safeParse(shape("git.pr.create", { draft: "yes" })).success).toBe(false)
    for (const type of ["git.push", "git.pr.view", "git.pr.create"] as const) expect(isReadOnlyCommand(type)).toBe(false)
  })
})

async function boot(b: Bench) {
  // The daemon starts git and gh with its own environment: the bench's logging git and fake gh, and no global config, for the length of the test.
  const saved = { PATH: process.env.PATH, HOME: process.env.HOME, GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM, FAKE_GIT_LOG: process.env.FAKE_GIT_LOG, no_proxy: process.env.no_proxy }
  Object.assign(process.env, { PATH: b.env.PATH, HOME: b.home, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", FAKE_GIT_LOG: b.env.FAKE_GIT_LOG, no_proxy: "*" })
  cleanups.push(() => { for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value } })
  const dir = path.join(b.base, "data")
  mkdirSync(dir)
  const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), listen: "127.0.0.1:0", engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }) })
  cleanups.push(() => daemon.stop())
  const local = createClient({ socketPath: daemon.socketPath, name: "local" })
  await local.connect()
  cleanups.push(() => local.close())
  const created = await local.send({ type: "session.create", directory: b.dir, title: "t" })
  const sessionId = (created.ok ? created.result?.sessionId : undefined) as SessionId
  await local.subscribe(sessionId, 0)
  async function remote(readOnly: boolean) {
    const token = remoteTokens(dir).create({ name: readOnly ? "ro" : "full", readOnly }).token
    const peer = createClient({ name: "remote", remote: { hostname: "127.0.0.1", port: daemon.remotePort!, token } })
    await peer.connect()
    cleanups.push(() => peer.close())
    return peer
  }
  const settings = (patch: Record<string, unknown>) => local.send({ type: "settings.set", patch: patch as never })
  b.clearCalls()
  return { daemon, local, sessionId, remote, settings }
}

function featured() {
  const b = bench()
  b.checkout("feat/x")
  b.commit("Change 1")
  b.clearCalls()
  return b
}
const calls = (b: Bench) => ({ git: b.gitCalls(), gh: b.gh.calls() })

describe("while the switch is off nothing is started", () => {
  test("every command is refused with how to turn it on, and no git or gh process ever started", async () => {
    const b = featured()
    const h = await boot(b)
    for (const command of [
      { type: "git.push" as const, directory: b.dir },
      { type: "git.push" as const, directory: b.dir, preview: true },
      { type: "git.pr.view" as const, directory: b.dir },
      { type: "git.pr.create" as const, directory: b.dir, title: "T", body: "B" },
      { type: "git.pr.create" as const, directory: b.dir, preview: true },
    ]) {
      const reply = await h.local.send(command)
      expect(reply).toMatchObject({ ok: false, error: { code: "forbidden" } })
      expect(!reply.ok && reply.error.message).toContain(OFF)
      expect(!reply.ok && reply.error.message).toContain("/experimental git_actions on")
    }
    await Bun.sleep(50)
    expect(calls(b)).toEqual({ git: [], gh: [] })
    expect(b.remoteRef("refs/heads/feat/x")).toBeUndefined()
  })

  test("features.git_actions: false blocks it even with the switch on, and so does the minimalist tier; balanced allows it", async () => {
    const b = featured()
    const h = await boot(b)
    await h.settings({ experimental: { git_actions: true }, features: { git_actions: false } })
    expect(await h.local.send({ type: "git.push", directory: b.dir, preview: true })).toMatchObject({ ok: false, error: { code: "forbidden" } })
    await h.settings({ features: {}, tier: "minimalist" })
    expect(await h.local.send({ type: "git.pr.view", directory: b.dir })).toMatchObject({ ok: false, error: { code: "forbidden" } })
    await Bun.sleep(50)
    expect(calls(b)).toEqual({ git: [], gh: [] })
    await h.settings({ tier: "balanced" })
    expect(await h.local.send({ type: "git.push", directory: b.dir, preview: true })).toMatchObject({ ok: true, result: { pushed: false, plan: { branch: "feat/x" } } })
  })

  test("a tier alone does not turn it on: balanced with the switch unset is still off", async () => {
    const b = featured()
    const h = await boot(b)
    await h.settings({ tier: "balanced" })
    expect(await h.local.send({ type: "git.push", directory: b.dir })).toMatchObject({ ok: false, error: { code: "forbidden" } })
    await h.settings({ tier: "full" })
    expect(await h.local.send({ type: "git.pr.create", directory: b.dir, preview: true })).toMatchObject({ ok: false, error: { code: "forbidden" } })
    await Bun.sleep(50)
    expect(calls(b)).toEqual({ git: [], gh: [] })
  })
})

describe("with the switch on", () => {
  test("a local client previews, pushes, reads the pull request and creates it; the remote has the branch and gh got exactly one create", async () => {
    const b = featured()
    const h = await boot(b)
    await h.settings({ experimental: { git_actions: true } })
    const preview = await h.local.send({ type: "git.push", directory: b.dir, preview: true, sessionId: h.sessionId })
    expect(preview).toMatchObject({ ok: true, result: { pushed: false, plan: { branch: "feat/x", remote: "origin", setUpstream: true, commitsTotal: 1 } } })
    expect(b.pushes()).toEqual([])
    const pushed = await h.local.send({ type: "git.push", directory: b.dir, sessionId: h.sessionId })
    expect(pushed).toMatchObject({ ok: true, result: { pushed: true } })
    expect(b.pushes()).toEqual([["push", "--no-recurse-submodules", "--no-follow-tags", "-u", "origin", "feat/x"]])
    expect(b.remoteRef("refs/heads/feat/x")).toBe(b.sh("rev-parse", "HEAD").trim())

    b.gh.reply({ stderr: 'no pull requests found for branch "feat/x"', exit: 1 })
    expect(await h.local.send({ type: "git.pr.view", directory: b.dir })).toMatchObject({ ok: true, result: { branch: "feat/x" } })
    b.gh.reply({ stdout: URL })
    const made = await h.local.send({ type: "git.pr.create", directory: b.dir, title: "Change 1", body: "- Change 1", sessionId: h.sessionId })
    expect(made).toMatchObject({ ok: true, result: { created: true, url: URL, number: 42 } })
    expect(b.gh.calls().filter((call) => call.argv[1] === "create")).toEqual([{ argv: ["pr", "create", "--base", "main", "--head", "feat/x", "--title=Change 1", "--body-file", "-"], stdin: "- Change 1" }])
  })

  test("the session gets a passive note for each action, as events of its log, and no turn starts", async () => {
    const b = featured()
    const h = await boot(b)
    await h.settings({ experimental: { git_actions: true } })
    await h.local.send({ type: "git.push", directory: b.dir, sessionId: h.sessionId })
    b.gh.reply({ stdout: URL })
    await h.local.send({ type: "git.pr.create", directory: b.dir, title: "T", body: "", sessionId: h.sessionId })
    await h.local.send({ type: "git.push", directory: b.dir, preview: true, sessionId: h.sessionId })
    const events = h.daemon.store.readAfter(h.sessionId, 0)
    const notes = events.filter((event) => event.type === "session.orchestration")
    expect(notes.map((event) => event.type === "session.orchestration" ? event.text : "")).toEqual([
      "Git page: pushed feat/x to origin (1 commit).",
      `Git page: opened a pull request from feat/x into main: ${URL}.`,
    ])
    expect(events.some((event) => event.type === "turn.started" || event.type === "queue.added")).toBe(false)
  })

  test("a remote client and a read-only peer are refused everything, and nothing runs", async () => {
    const b = featured()
    const h = await boot(b)
    await h.settings({ experimental: { git_actions: true } })
    b.gh.reply({ stdout: URL })
    for (const peer of [await h.remote(false), await h.remote(true)]) {
      for (const command of [
        { type: "git.push" as const, directory: b.dir },
        { type: "git.push" as const, directory: b.dir, preview: true },
        { type: "git.pr.view" as const, directory: b.dir },
        { type: "git.pr.create" as const, directory: b.dir, title: "T", body: "" },
        { type: "git.pr.create" as const, directory: b.dir, preview: true },
      ]) expect(await peer.send(command)).toMatchObject({ ok: false, error: { code: "forbidden" } })
    }
    expect(calls(b)).toEqual({ git: [], gh: [] })
    expect(b.remoteRef("refs/heads/feat/x")).toBeUndefined()
  })

  test("a permission rule that denies the command refuses it from the daemon and names the rule; the session's own rules count", async () => {
    const b = featured()
    const h = await boot(b)
    await h.settings({ experimental: { git_actions: true }, permission: { bash: { "git push *": "deny" } } })
    const denied = await h.local.send({ type: "git.push", directory: b.dir })
    expect(denied).toMatchObject({ ok: false, error: { code: "forbidden" } })
    expect(!denied.ok && denied.error.message).toContain('your permission rule bash "git push *" denies')
    expect(await h.local.send({ type: "git.push", directory: b.dir, preview: true })).toMatchObject({ ok: false, error: { code: "forbidden" } })
    expect(b.pushes()).toEqual([])
    await h.settings({ permission: { bash: { "gh pr create *": "deny" } } })
    b.gh.reply({ stdout: URL })
    const pushed = await h.local.send({ type: "git.push", directory: b.dir })
    expect(pushed).toMatchObject({ ok: true, result: { pushed: true } })
    const refused = await h.local.send({ type: "git.pr.create", directory: b.dir, title: "T", body: "" })
    expect(!refused.ok && refused.error.message).toContain('your permission rule bash "gh pr create *" denies')
    expect(b.gh.calls()).toHaveLength(0)
  })

  test("a refusal is one line with the daemon's code: not a repository, and a rejected push", async () => {
    const b = featured()
    const h = await boot(b)
    await h.settings({ experimental: { git_actions: true } })
    expect(await h.local.send({ type: "git.push", directory: b.base })).toMatchObject({ ok: false, error: { code: "not_git", message: "[GIT]: not a git repository" } })
    await h.local.send({ type: "git.push", directory: b.dir })
    const other = b.other()
    other.git("fetch", "-q", "origin")
    other.git("checkout", "-q", "-b", "feat/x", "--track", "origin/feat/x")
    other.commit("Theirs")
    other.git("push", "-q", "origin", "feat/x")
    b.commit("Mine")
    const theirs = b.remoteRef("refs/heads/feat/x")
    const rejected = await h.local.send({ type: "git.push", directory: b.dir })
    expect(rejected).toMatchObject({ ok: false, error: { code: "invalid_command" } })
    expect(!rejected.ok && rejected.error.message).toContain("push rejected")
    expect(b.remoteRef("refs/heads/feat/x")).toBe(theirs)
  })
})
