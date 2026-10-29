import { afterEach, describe, expect, test } from "bun:test"
import type { CommandInput, CommandReply } from "@mendcode/client"
import { cleanTemps } from "./session-ui-harness"
import { frame, gitApp, settle } from "./git-page-helpers"

afterEach(cleanTemps)

const NEW = "ses_01NEWSESSION0000000000000A"
const WORKSPACE = { id: "ws_made", name: "work-ab12cd", type: "worktree", branch: "mend/work-ab12cd", directory: "/tmp/made" }
const ok = (result: unknown) => ({ ok: true, result }) as CommandReply

/** The daemon as `/new` sees it: a project that is (or is not) a Git repository, a workspace that can (or cannot) be made. */
function daemon(options: { git?: boolean; create?: CommandReply } = {}) {
  return (command: CommandInput): CommandReply | undefined => {
    if (command.type === "session.create") return ok({ sessionId: NEW })
    if (command.type !== "project.rest") return undefined
    const operation = (command.input as { operation: string }).operation
    if (operation === "current") return ok({ project: { worktree: "/tmp/project", ...(options.git === false ? {} : { vcs: "git" }) } })
    if (operation === "workspace-create") return options.create ?? ok({ workspace: WORKSPACE })
    if (operation === "workspace-warp") return ok({})
    return undefined
  }
}
const rest = (app: Awaited<ReturnType<typeof gitApp>>) => app.h.sent.filter((command) => command.type === "project.rest").map((command) => command.input as { operation: string; input?: unknown })
const runNew = async (app: Awaited<ReturnType<typeof gitApp>>) => { await app.h.type("/new\r"); await settle(); await settle(); app.h.app.render() }

describe("git.newSessionWorktree", () => {
  test("off (the default): /new creates the session and nothing else, no workspace is asked for", async () => {
    const app = await gitApp({ intercept: daemon() })
    await runNew(app)
    expect(app.h.sent.filter((command) => command.type === "session.create")).toHaveLength(1)
    expect(rest(app).filter((request) => ["current", "workspace-create", "workspace-warp"].includes(request.operation))).toEqual([])
  })

  test("on: the new session is moved into a fresh workspace with the requests /warp → New workspace sends, before the terminal enters it", async () => {
    const app = await gitApp({ intercept: daemon(), settings: { git: { newSessionWorktree: true } } })
    await runNew(app)
    const requests = rest(app).filter((request) => request.operation !== "workspace-list" && request.operation !== "workspace-status")
    expect(requests.map((request) => request.operation)).toEqual(["current", "workspace-create", "workspace-warp"])
    expect(requests[1]).toMatchObject({ operation: "workspace-create", input: { type: "worktree", branch: null, extra: {} } })
    expect(requests[2]).toMatchObject({ operation: "workspace-warp", input: { id: "ws_made", sessionID: NEW } })
    expect(app.h.app.sessionId).toBe(NEW)
    expect(frame(app.h)).not.toContain("stays in the project")
  })

  test("the same requests as the /warp form, whose name field only adds extra.name", async () => {
    const app = await gitApp({ intercept: daemon(), settings: { git: { newSessionWorktree: true } } })
    await app.h.type("/warp\r")
    await settle()
    await app.h.app.onKey("c")
    await app.h.type("spike")
    await app.h.app.onKey("\r")
    await settle()
    const form = rest(app).find((request) => request.operation === "workspace-create")
    expect(form).toMatchObject({ input: { type: "worktree", branch: null, extra: { name: "spike" } } })
  })

  test("not a Git repository: the session is created in place and one line says why; no workspace is made", async () => {
    const app = await gitApp({ intercept: daemon({ git: false }), settings: { git: { newSessionWorktree: true } } })
    await runNew(app)
    expect(app.h.app.sessionId).toBe(NEW)
    expect(rest(app).some((request) => request.operation === "workspace-create")).toBe(false)
    expect(frame(app.h)).toContain("New session stays in the project: it is not a Git repository")
  })

  test("a workspace that cannot be made: the session is created in place and one line says why", async () => {
    const failure = { ok: false, error: { code: "internal", message: "[GIT]: worktree add failed: disk full\nsecond line" } } as CommandReply
    const app = await gitApp({ intercept: daemon({ create: failure }), settings: { git: { newSessionWorktree: true } } })
    await runNew(app)
    expect(app.h.app.sessionId).toBe(NEW)
    expect(rest(app).some((request) => request.operation === "workspace-warp")).toBe(false)
    expect(frame(app.h)).toContain("New session stays in the project: no workspace")
  })

  test("a tier without the Git page ignores the setting", async () => {
    const app = await gitApp({ intercept: daemon(), tier: "minimalist", settings: { git: { newSessionWorktree: true } } })
    await runNew(app)
    expect(rest(app).filter((request) => ["current", "workspace-create", "workspace-warp"].includes(request.operation))).toEqual([])
    expect(app.h.app.sessionId).toBe(NEW)
  })
})
