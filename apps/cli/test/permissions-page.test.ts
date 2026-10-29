import { afterEach, describe, expect, test } from "bun:test"
import type { ModelsReport, PermissionGrant } from "@mendcode/protocol"
import type { Line } from "../src/ui/theme"
import { createPermissionsPageState, PICKABLE_MODES, permissionsPageKey, renderPermissionsPage, reviewerStatus, type PermissionsPageState, type ReviewerStatus } from "../src/view/permissions-page"
import { textWidth } from "../src/view/wrap"
import { appHarness, scratch } from "./extensions-harness"

const NOW = 1_800_000_000_000
const MIN = 60_000
const text = (line: Line) => line.map((span) => span.text).join("")
const plain = (lines: Line[]) => lines.map(text)

const grants: PermissionGrant[] = [
  { grantId: "shell", tool: "shell", permission: "execute", grantedAt: NOW - 5 * MIN },
  { grantId: "edit", tool: "edit", permission: "write", grantedAt: NOW - 90 * MIN },
  { grantId: "mcp__docs__search", tool: "mcp__docs__search", permission: "execute", grantedAt: NOW - 10_000 },
]

const off: ReviewerStatus = { kind: "off" }
const render = (over: Partial<Parameters<typeof renderPermissionsPage>[0]> = {}) =>
  renderPermissionsPage({ mode: "smart", grants, reviewer: off, state: createPermissionsPageState(), width: 100, height: 30, now: NOW, ...over })

describe("permissions page keys", () => {
  test("esc and q close; arrows and j/k move the grant selection and clamp", () => {
    let state = createPermissionsPageState()
    expect(permissionsPageKey(state, "\x1b", grants).action).toEqual({ type: "close" })
    expect(permissionsPageKey(state, "q", grants).action).toEqual({ type: "close" })
    expect(permissionsPageKey(state, "k", grants).state).toBe(state)
    state = permissionsPageKey(state, "\x1b[B", grants).state
    state = permissionsPageKey(state, "j", grants).state
    expect(state.selected).toBe(2)
    expect(permissionsPageKey(state, "j", grants).state).toBe(state)
    expect(permissionsPageKey(state, "\x1b[A", grants).state.selected).toBe(1)
  })

  test("r revokes the selected grant by its id; with no grants nothing happens", () => {
    expect(permissionsPageKey({ selected: 1 }, "r", grants).action).toEqual({ type: "revoke", grantId: "edit" })
    expect(permissionsPageKey({ selected: 0 }, "x", grants).action).toEqual({ type: "revoke", grantId: "shell" })
    expect(permissionsPageKey({ selected: 0 }, "r", []).action).toEqual({ type: "none" })
    expect(permissionsPageKey({ selected: 0 }, "R", []).action).toEqual({ type: "none" })
  })

  test("R asks first; R or y then revokes all, any other key cancels", () => {
    const armed = permissionsPageKey({ selected: 0 }, "R", grants)
    expect(armed.state.confirmAll).toBe(true)
    expect(armed.action).toEqual({ type: "none" })
    expect(permissionsPageKey(armed.state, "R", grants)).toEqual({ state: { selected: 0 }, action: { type: "revoke", grantId: "all" } })
    expect(permissionsPageKey(armed.state, "y", grants).action).toEqual({ type: "revoke", grantId: "all" })
    const cancelled = permissionsPageKey(armed.state, "j", grants)
    expect(cancelled.action).toEqual({ type: "none" })
    expect(cancelled.state.confirmAll).toBeUndefined()
  })

  test("1-4 pick ask, edits, full and smart; m opens the model page; other digits do nothing", () => {
    const state = createPermissionsPageState()
    expect(PICKABLE_MODES).toEqual(["ask", "edits", "full", "smart"])
    for (const [key, mode] of [["1", "ask"], ["2", "edits"], ["3", "full"], ["4", "smart"]] as const) expect(permissionsPageKey(state, key, grants).action).toEqual({ type: "mode", mode })
    expect(permissionsPageKey(state, "5", grants).action).toEqual({ type: "none" })
    expect(permissionsPageKey(state, "m", grants).action).toEqual({ type: "model" })
  })
})

describe("permissions page render", () => {
  test("lists every mode with its meaning, the current one marked, and plan left to /plan", () => {
    const rows = plain(render({ mode: "edits" }))
    const all = rows.join("\n")
    for (const words of ["edits and commands ask", "edits run, commands ask", "runs unless denied by rule", "low risk runs; rest asks", "read-only (/plan)"]) expect(all).toContain(words)
    expect(rows.find((row) => row.includes("edits run, commands ask"))).toContain("❯")
    expect(rows.filter((row) => /❯ (ask|edits|full|smart|plan) /.test(row))).toHaveLength(1)
  })

  test("summarizes smart mode's rules: what runs, what asks and how grants behave", () => {
    const all = plain(render()).join("\n")
    expect(all).toContain("Smart rules")
    expect(all).toContain("reads · edits inside the project · allow-listed commands")
    expect(all).toContain("destructive · secrets · .git · outside the project · network")
    expect(all).toContain("shell expansion · unlisted commands · unknown tools")
    expect(all).toContain("never a high-risk one")
  })

  test("lists the session grants with their permission and age", () => {
    const rows = plain(render())
    const shell = rows.find((row) => row.includes("shell") && row.includes("execute"))!
    expect(shell).toContain("5m")
    expect(rows.find((row) => row.includes("edit ") && row.includes("write"))).toContain("1h")
    expect(rows.find((row) => row.includes("mcp__docs__search"))).toContain("now")
    expect(rows.join("\n")).toContain("3 grants")
    expect(rows.find((row) => row.includes("shell") && row.includes("execute"))).toContain("❯")
  })

  test("no grants, loading and a failed list each say so", () => {
    expect(plain(render({ grants: [] })).join("\n")).toContain("none yet")
    expect(plain(render({ grants: undefined })).join("\n")).toContain("loading grants…")
    expect(plain(render({ grants: undefined, grantsError: "no session yet" })).join("\n")).toContain("no session yet")
  })

  test("the reviewer row shows off, loading, a failed lookup and the model it runs on, with a link to /model", () => {
    expect(plain(render()).join("\n")).toMatch(/reviewer\s+off · no model set, no reviewer runs/)
    expect(plain(render()).join("\n")).toContain("set the permissionReviewer role in /model")
    expect(plain(render({ reviewer: { kind: "loading" } })).join("\n")).toContain("checking…")
    expect(plain(render({ reviewer: { kind: "error", message: "daemon unreachable" } })).join("\n")).toContain("daemon unreachable")
    const on = plain(render({ reviewer: { kind: "on", model: "gpt-5.6-mini", effort: "low" } })).join("\n")
    expect(on).toMatch(/reviewer\s+on · gpt-5.6-mini low/)
    expect(on).toContain("judges what the rules did not settle")
    expect(plain(render({ mode: "ask", reviewer: { kind: "on", model: "m" } })).join("\n")).toContain("only consulted in smart mode")
  })

  test("reviewerStatus reads the role from a models report: unset is off, there is no fallback to main", () => {
    const report = (roles: ModelsReport["roles"]) => ({ engine: "native", selectable: true, models: [], defaults: { model: "main-model" }, roles }) as ModelsReport
    expect(reviewerStatus(undefined)).toEqual({ kind: "loading" })
    expect(reviewerStatus(undefined, "boom")).toEqual({ kind: "error", message: "boom" })
    expect(reviewerStatus(report({ main: { model: "main-model" } }))).toEqual({ kind: "off" })
    expect(reviewerStatus(report({ permissionReviewer: { model: "tiny", effort: "low" } }))).toEqual({ kind: "on", model: "tiny", effort: "low" })
    expect(reviewerStatus(report({ permissionReviewer: { model: "tiny" } }))).toEqual({ kind: "on", model: "tiny" })
  })

  test("the confirm state replaces the hints and names how many grants go", () => {
    const rows = plain(render({ state: { selected: 0, confirmAll: true } }))
    expect(rows.join("\n")).toContain("revoke all 3 grants? R or y confirms")
    expect(rows.join("\n")).toContain("R/y confirm · any key cancels")
  })

  test("full access is flagged in the header", () => {
    expect(text(render({ mode: "full" })[1]!)).toContain("Full access")
  })

  test("every width draws exactly height rows of at most width cells, with the selected grant in view", () => {
    const many: PermissionGrant[] = Array.from({ length: 30 }, (_, i) => ({ grantId: `tool_${i}`, tool: `tool_${i}`, permission: "execute", grantedAt: NOW - i * MIN }))
    for (const width of [40, 60, 80, 100, 140]) {
      for (const height of [12, 24, 40]) {
        for (const state of [createPermissionsPageState(), { selected: 29 } satisfies PermissionsPageState]) {
          const rows = plain(render({ grants: many, width, height, state }))
          expect(rows).toHaveLength(height)
          for (const row of rows) expect(textWidth(row)).toBeLessThanOrEqual(width)
          if (height >= 24) expect(rows.some((row) => row.includes(`tool_${state.selected}`))).toBe(true)
        }
      }
    }
  })

  test("at 100 columns the modes sit beside the grants", () => {
    const rows = plain(render({ width: 100, height: 30 }))
    const row = rows.find((line) => line.includes("Mode") && line.includes("Session grants"))
    expect(row).toBeDefined()
  })
})

const made: Array<ReturnType<typeof scratch>> = []
afterEach(() => {
  for (const item of made.splice(0)) item.cleanup()
})

describe("/permissions in the app", () => {
  const report = { engine: "native", selectable: true, models: [], defaults: { model: "main-model" }, roles: { permissionReviewer: { model: "tiny-reviewer" } } }
  async function open(options: { grants?: PermissionGrant[]; revoked?: number; height?: number } = {}) {
    const dirs = scratch()
    made.push(dirs)
    let current = [...(options.grants ?? grants)]
    const h = await appHarness({
      dataDir: dirs.dataDir,
      width: 100,
      height: options.height ?? 34,
      reply: (command) => {
        if (command.type === "permissions.list") return { ok: true, result: { grants: current } }
        if (command.type === "permissions.revoke") {
          const before = current.length
          current = command.grantId === "all" ? [] : current.filter((grant) => grant.grantId !== command.grantId)
          return { ok: true, result: { revoked: options.revoked ?? before - current.length } }
        }
        if (command.type === "models.list") return { ok: true, result: report }
        return undefined
      },
    })
    await h.start({ onboarded: true })
    await h.type("/permissions")
    await h.key("\r")
    await Bun.sleep(15)
    h.app.render()
    return h
  }

  test("a bare /permissions opens the page, asks for the session's grants and the models, and shows the reviewer", async () => {
    const h = await open()
    expect(h.app.page).toBe("permissions")
    expect(h.sent.filter((command) => command.type === "permissions.list")).toEqual([{ type: "permissions.list", sessionId: h.sessionId }])
    expect(h.sent.filter((command) => command.type === "models.list" && command.sessionId === h.sessionId).length).toBeGreaterThanOrEqual(1)
    const screen = h.text()
    expect(screen).toContain("Permissions")
    expect(screen).toContain("mcp__docs__search")
    expect(screen).toMatch(/reviewer\s+on · tiny-reviewer/)
  })

  test("r revokes the selected grant and the list refreshes; R then y revokes the rest", async () => {
    const h = await open()
    await h.key("j")
    await h.key("r")
    await Bun.sleep(15)
    h.app.render()
    expect(h.sent.filter((command) => command.type === "permissions.revoke")).toEqual([{ type: "permissions.revoke", sessionId: h.sessionId, grantId: "edit" }])
    expect(h.text()).not.toMatch(/edit\s+write/)
    expect(h.text()).toContain("2 grants")
    await h.key("R")
    expect(h.sent.filter((command) => command.type === "permissions.revoke")).toHaveLength(1)
    expect(h.text()).toContain("revoke all 2 grants?")
    await h.key("y")
    await Bun.sleep(15)
    h.app.render()
    expect(h.sent.filter((command) => command.type === "permissions.revoke").at(-1)).toMatchObject({ grantId: "all" })
    expect(h.text()).toContain("none yet")
  })

  test("a digit sets the mode through the daemon; m goes to /model; esc returns to the chat", async () => {
    const h = await open()
    await h.key("4")
    expect(h.sent.filter((command) => command.type === "session.permission.set")).toEqual([{ type: "session.permission.set", sessionId: h.sessionId, mode: "smart" }])
    await h.key("m")
    await Bun.sleep(15)
    expect(h.app.page).toBe("model")
    await h.key("\x1b")
    expect(h.app.page).toBe("chat")
  })

  test("esc closes the page", async () => {
    const h = await open()
    await h.key("\x1b")
    expect(h.app.page).toBe("chat")
  })

  test("/permissions <mode> still sets the mode without opening the page; an unknown mode says so", async () => {
    const dirs = scratch()
    made.push(dirs)
    const h = await appHarness({ dataDir: dirs.dataDir, width: 100, height: 34 })
    await h.start({ onboarded: true })
    await h.type("/permissions smart")
    await h.key("\r")
    expect(h.app.page).toBe("chat")
    expect(h.sent.filter((command) => command.type === "session.permission.set")).toEqual([{ type: "session.permission.set", sessionId: h.sessionId, mode: "smart" }])
    await h.type("/permissions bogus")
    await h.key("\r")
    expect(h.text()).toContain("unknown permission mode: bogus (ask, smart, edits, full, plan)")
    expect(h.sent.filter((command) => command.type === "session.permission.set")).toHaveLength(1)
  })
})


test("policy panels show configured rules and the selected reviewer role; compact has one column", () => {
  const settings = { permission: { read: { "*/private/*": "deny" as const }, bash: "ask" as const }, tools: { webfetch: false }, permissionReviewerRole: "small" as const, experimental: { primary_tools: ["loop"], continue_loop_on_deny: true } }
  const report = { engine: "native", selectable: true, models: [], defaults: { model: "main" }, roles: { small: { model: "reviewer" } } } as ModelsReport
  expect(reviewerStatus(report, undefined, "small")).toMatchObject({ kind: "on", model: "reviewer" })
  for (const [width, height] of [[60, 20], [100, 30], [160, 45], [180, 50], [220, 60]]) {
    const rows = plain(render({ settings, width, height }))
    expect(rows).toHaveLength(height!)
    expect(rows.every((row) => textWidth(row) <= width!)).toBe(true)
    expect(rows[0]).toContain("esc")
    if (width! < 70) expect(rows.some((row) => row.includes("Mode") && row.includes("Session grants"))).toBe(false)
    else {
      expect(rows.join("\n")).toContain("read */private/*: deny")
      expect(rows.join("\n")).toContain("Primary only: loop")
      expect(rows.some((row) => row.includes("┌─ Tool/path policy"))).toBe(true)
    }
  }
  expect(permissionsPageKey({ selected: 0 }, "\x1b[6~", grants).state.scroll).toBe(8)
})
