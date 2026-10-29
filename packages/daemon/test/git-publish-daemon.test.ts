import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readdirSync } from "node:fs"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { Command, createIdFactory, isReadOnlyCommand, type SessionId } from "@mendcode/protocol"
import { startDaemon } from "../src"
import { remoteTokens } from "../src/remote"
import { cleanBenches, cleanBenchTemplates } from "./git-actions-bench"
import { publishBench, type PublishBench } from "./git-publish-bench"

const ids = createIdFactory()
const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  cleanBenches()
})
afterAll(cleanBenchTemplates)

const OFF = "push and pull requests are off"
const URL = "https://github.com/me/widgets"

describe("the commands", () => {
  const shape = (type: string, extra: Record<string, unknown> = {}) => ({ type, id: ids("command"), clientId: ids("client"), directory: "/project", ...extra })

  test("git.publish takes a name, an owner and a description, and nothing that could make it public, internal or pushing; none is a read-only command", () => {
    expect(Command.safeParse(shape("git.publish")).success).toBe(true)
    expect(Command.safeParse(shape("git.publish", { name: "widgets", owner: "me", description: "Small", preview: true, sessionId: ids("session") })).success).toBe(true)
    for (const extra of [{ visibility: "public" }, { visibility: "private" }, { public: true }, { private: false }, { internal: true }, { push: true }, { remote: "origin" }, { source: "/x" }, { argv: ["gh"] }, { template: "x" }, { team: "t" }]) {
      expect(Command.safeParse(shape("git.publish", extra)).success).toBe(false)
    }
    expect(Command.safeParse(shape("git.publish", { name: "x".repeat(101) })).success).toBe(false)
    expect(Command.safeParse(shape("git.publish", { owner: "x".repeat(61) })).success).toBe(false)
    expect(Command.safeParse(shape("git.publish", { description: "x".repeat(351) })).success).toBe(false)
    for (const type of ["git.publish", "git.init"] as const) expect(isReadOnlyCommand(type)).toBe(false)
  })

  test("git.init takes the session it belongs to and a preview flag, and nothing else", () => {
    expect(Command.safeParse(shape("git.init", { sessionId: ids("session") })).success).toBe(true)
    expect(Command.safeParse(shape("git.init", { sessionId: ids("session"), preview: true })).success).toBe(true)
    expect(Command.safeParse(shape("git.init")).success).toBe(false)
    for (const extra of [{ branch: "main" }, { bare: true }, { template: "/x" }, { argv: ["git"] }, { commit: true }]) expect(Command.safeParse(shape("git.init", { sessionId: ids("session"), ...extra })).success).toBe(false)
  })
})

async function boot(b: PublishBench) {
  const saved = { PATH: process.env.PATH, HOME: process.env.HOME, GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM, GH_CONFIG_DIR: process.env.GH_CONFIG_DIR, FAKE_GIT_LOG: process.env.FAKE_GIT_LOG, no_proxy: process.env.no_proxy }
  Object.assign(process.env, { PATH: b.env.PATH, HOME: b.home, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GH_CONFIG_DIR: path.join(b.home, "gh"), FAKE_GIT_LOG: b.env.FAKE_GIT_LOG, no_proxy: "*" })
  cleanups.push(() => { for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value } })
  const dir = path.join(b.base, "data")
  mkdirSync(dir)
  const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), listen: "127.0.0.1:0", engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }) })
  cleanups.push(() => daemon.stop())
  const local = createClient({ socketPath: daemon.socketPath, name: "local" })
  await local.connect()
  cleanups.push(() => local.close())
  const session = async (directory: string) => {
    const created = await local.send({ type: "session.create", directory, title: "t" })
    const sessionId = (created.ok ? created.result?.sessionId : undefined) as SessionId
    await local.subscribe(sessionId, 0)
    return sessionId
  }
  const sessionId = await session(b.dir)
  async function remote(readOnly: boolean) {
    const token = remoteTokens(dir).create({ name: readOnly ? "ro" : "full", readOnly }).token
    const peer = createClient({ name: "remote", remote: { hostname: "127.0.0.1", port: daemon.remotePort!, token } })
    await peer.connect()
    cleanups.push(() => peer.close())
    return peer
  }
  const settings = (patch: Record<string, unknown>) => local.send({ type: "settings.set", patch: patch as never })
  b.clearCalls()
  return { daemon, local, sessionId, session, remote, settings }
}
const notes = (h: Awaited<ReturnType<typeof boot>>, sessionId: SessionId) => h.daemon.store.readAfter(sessionId, 0).filter((event) => event.type === "session.orchestration").map((event) => event.type === "session.orchestration" ? event.text : "")

function ready() {
  const b = publishBench()
  b.user()
  b.addsRemote(`${URL}.git`)
  b.gh.reply({ stdout: URL })
  b.clearCalls()
  return b
}

describe("git.publish while the switch is off", () => {
  test("it is refused with how to turn it on, and no git or gh process ever started", async () => {
    const b = ready()
    const h = await boot(b)
    for (const command of [
      { type: "git.publish" as const, directory: b.dir },
      { type: "git.publish" as const, directory: b.dir, preview: true },
      { type: "git.publish" as const, directory: b.dir, name: "widgets", owner: "me", description: "x" },
    ]) {
      const reply = await h.local.send(command)
      expect(reply).toMatchObject({ ok: false, error: { code: "forbidden" } })
      expect(!reply.ok && reply.error.message).toContain(OFF)
      expect(!reply.ok && reply.error.message).toContain("/experimental git_actions on")
    }
    await Bun.sleep(50)
    expect({ git: b.gitCalls(), gh: b.ghCalls() }).toEqual({ git: [], gh: [] })
    expect(b.hasRemote("origin")).toBe(false)
  })

  test("a tier alone does not turn it on, and features.git_actions: false blocks it with the switch on", async () => {
    const b = ready()
    const h = await boot(b)
    await h.settings({ tier: "balanced" })
    expect(await h.local.send({ type: "git.publish", directory: b.dir, preview: true })).toMatchObject({ ok: false, error: { code: "forbidden" } })
    await h.settings({ experimental: { git_actions: true }, features: { git_actions: false } })
    expect(await h.local.send({ type: "git.publish", directory: b.dir, preview: true })).toMatchObject({ ok: false, error: { code: "forbidden" } })
    await Bun.sleep(50)
    expect({ git: b.gitCalls(), gh: b.ghCalls() }).toEqual({ git: [], gh: [] })
  })
})

describe("git.publish with the switch on", () => {
  test("a local client previews and publishes: one create with --private, the remote is added, nothing is pushed, and the session gets a note", async () => {
    const b = ready()
    const h = await boot(b)
    await h.settings({ experimental: { git_actions: true } })
    const preview = await h.local.send({ type: "git.publish", directory: b.dir, name: "widgets", sessionId: h.sessionId, preview: true })
    expect(preview).toMatchObject({ ok: true, result: { published: false, plan: { repo: "me/widgets", visibility: "private" } } })
    expect(b.creates()).toEqual([])
    const done = await h.local.send({ type: "git.publish", directory: b.dir, name: "widgets", description: "Small widgets", sessionId: h.sessionId })
    expect(done).toMatchObject({ ok: true, result: { published: true, url: URL, origin: `${URL}.git` } })
    expect(b.creates()).toEqual([["repo", "create", "me/widgets", "--private", "--source", b.dir, "--remote", "origin", "--description=Small widgets"]])
    expect(b.pushes()).toEqual([])
    expect(b.hasRemote("origin")).toBe(true)
    expect(notes(h, h.sessionId)).toEqual(["Git page: published me/widgets as a private repository and added origin (nothing pushed)."])
    // The push is possible right after, as a step of its own: planned here, not run.
    const next = await h.local.send({ type: "git.push", directory: b.dir, preview: true })
    expect(next).toMatchObject({ ok: true, result: { pushed: false, plan: { remote: "origin", setUpstream: true, url: `${URL}.git` } } })
    expect(b.pushes()).toEqual([])
  })

  test("a remote client and a read-only peer are refused, and nothing runs", async () => {
    const b = ready()
    const h = await boot(b)
    await h.settings({ experimental: { git_actions: true } })
    for (const peer of [await h.remote(false), await h.remote(true)]) {
      for (const command of [
        { type: "git.publish" as const, directory: b.dir },
        { type: "git.publish" as const, directory: b.dir, preview: true },
        { type: "git.publish" as const, directory: b.dir, name: "widgets", owner: "me" },
      ]) expect(await peer.send(command)).toMatchObject({ ok: false, error: { code: "forbidden" } })
    }
    expect({ git: b.gitCalls(), gh: b.ghCalls() }).toEqual({ git: [], gh: [] })
    expect(b.hasRemote("origin")).toBe(false)
  })

  test("a permission rule that denies the command refuses it from the daemon and names the rule; so does the session's own", async () => {
    const b = ready()
    const h = await boot(b)
    await h.settings({ experimental: { git_actions: true }, permission: { bash: { "gh repo create *": "deny" } } })
    const denied = await h.local.send({ type: "git.publish", directory: b.dir, owner: "me", name: "widgets" })
    expect(denied).toMatchObject({ ok: false, error: { code: "forbidden" } })
    expect(!denied.ok && denied.error.message).toContain('your permission rule bash "gh repo create *" denies')
    expect(await h.local.send({ type: "git.publish", directory: b.dir, owner: "me", name: "widgets", preview: true })).toMatchObject({ ok: false, error: { code: "forbidden" } })
    expect(b.creates()).toEqual([])
    await h.settings({ permission: { bash: { "gh api user": "deny" } } })
    const account = await h.local.send({ type: "git.publish", directory: b.dir, preview: true })
    expect(!account.ok && account.error.message).toContain('your permission rule bash "gh api user" denies')
    expect(b.hasRemote("origin")).toBe(false)
  })

  test("origin already there and a partial failure come back as the daemon's one error with its lines", async () => {
    const b = ready()
    const h = await boot(b)
    await h.settings({ experimental: { git_actions: true } })
    b.addsRemote(undefined)
    b.gh.reply({ stdout: URL, stderr: 'X Unable to add remote "origin"', exit: 1 })
    const partial = await h.local.send({ type: "git.publish", directory: b.dir, owner: "me", name: "widgets", sessionId: h.sessionId })
    expect(partial).toMatchObject({ ok: false, error: { code: "invalid_command" } })
    expect(!partial.ok && partial.error.message.split("\n")).toContain(`run: git remote add origin ${URL}`)
    expect(notes(h, h.sessionId)).toEqual([])
    b.sh("remote", "add", "origin", `${URL}.git`)
    const exists = await h.local.send({ type: "git.publish", directory: b.dir, owner: "me", name: "widgets" })
    expect(!exists.ok && exists.error.message).toContain("a remote named origin already exists")
    expect(b.creates()).toHaveLength(1)
  })
})

describe("git.init", () => {
  test("a local client previews and initializes the session's own project folder; the session gets a note and the folder holds only .git", async () => {
    const b = ready()
    const h = await boot(b)
    const project = path.join(b.base, "fresh")
    mkdirSync(project)
    const sessionId = await h.session(project)
    const preview = await h.local.send({ type: "git.init", directory: project, sessionId, preview: true })
    expect(preview).toMatchObject({ ok: true, result: { initialized: false, plan: { argv: ["git", "init", "-b", "main"] } } })
    expect(readdirSync(project)).toEqual([])
    const done = await h.local.send({ type: "git.init", directory: project, sessionId })
    expect(done).toMatchObject({ ok: true, result: { initialized: true, root: project } })
    expect(readdirSync(project)).toEqual([".git"])
    expect(notes(h, sessionId)).toEqual([`Git page: initialized a git repository in ${project} (branch main, nothing committed).`])
    expect(await h.local.send({ type: "git.init", directory: project, sessionId })).toMatchObject({ ok: false, error: { message: expect.stringContaining("already a git repository") } })
  })

  test("it needs no switch: git.init runs with the experimental switch off and never starts gh", async () => {
    const b = ready()
    const h = await boot(b)
    const project = path.join(b.base, "fresh")
    mkdirSync(project)
    const sessionId = await h.session(project)
    expect(await h.local.send({ type: "git.init", directory: project, sessionId })).toMatchObject({ ok: true })
    expect(b.ghCalls()).toEqual([])
    expect(b.gitCalls().some((call) => call.includes("push") || call.includes("fetch") || call.includes("remote"))).toBe(false)
  })

  test("a folder that is not the session's project, an unknown session and the home folder are refused, and nothing is created", async () => {
    const b = ready()
    const h = await boot(b)
    const project = path.join(b.base, "fresh")
    const elsewhere = path.join(b.base, "elsewhere")
    mkdirSync(project)
    mkdirSync(elsewhere)
    const sessionId = await h.session(project)
    expect(await h.local.send({ type: "git.init", directory: elsewhere, sessionId })).toMatchObject({ ok: false, error: { message: "[GIT]: only the project folder of this session can be initialized" } })
    expect(await h.local.send({ type: "git.init", directory: project, sessionId: ids("session") })).toMatchObject({ ok: false, error: { code: "unknown_session" } })
    const homeSession = await h.session(b.home)
    expect(await h.local.send({ type: "git.init", directory: b.home, sessionId: homeSession })).toMatchObject({ ok: false, error: { message: "[GIT]: this is your home folder: open a project folder instead" } })
    expect(existsSync(path.join(elsewhere, ".git"))).toBe(false)
    expect(existsSync(path.join(project, ".git"))).toBe(false)
    expect(existsSync(path.join(b.home, ".git"))).toBe(false)
    // Inside a repository: the answer names the root.
    const nested = path.join(b.dir, "nested")
    mkdirSync(nested)
    const nestedSession = await h.session(nested)
    expect(await h.local.send({ type: "git.init", directory: nested, sessionId: nestedSession })).toMatchObject({ ok: false, error: { message: `[GIT]: this folder is inside the git repository at ${b.dir}: the page does not start another one` } })
  })

  test("a remote client and a read-only peer are refused", async () => {
    const b = ready()
    const h = await boot(b)
    const project = path.join(b.base, "fresh")
    mkdirSync(project)
    const sessionId = await h.session(project)
    for (const peer of [await h.remote(false), await h.remote(true)]) {
      for (const preview of [false, true]) expect(await peer.send({ type: "git.init", directory: project, sessionId, ...(preview ? { preview } : {}) })).toMatchObject({ ok: false, error: { code: "forbidden" } })
    }
    expect(readdirSync(project)).toEqual([])
  })
})
