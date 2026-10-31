import { describe, expect, test } from "bun:test"
import { createPermissions, levelOf } from "../src/pr-review/permissions"
import type { GhCall } from "../src/pr-review/publish"

/** GitHub's `collaborators/{login}/permission` answer, as the REST API returns it (only the fields read). */
const answer = (permission: string, role_name?: string) => JSON.stringify({ permission, ...(role_name ? { role_name } : {}), user: { login: "ana", type: "User" } })

/** A fake `gh` whose answer per login can change between calls (a revocation); records every endpoint. */
function fakeGh(levels: Record<string, () => { code: number; out: string; err?: string }>) {
  const calls: string[] = []
  const gh: GhCall = async ({ argv }) => {
    calls.push(argv[1]!)
    const login = /collaborators\/([^/]+)\/permission$/.exec(argv[1]!)?.[1]
    return (login ? levels[decodeURIComponent(login)]?.() : undefined) ?? { code: 1, out: "", err: "gh: Not Found (HTTP 404)" }
  }
  return { gh, calls }
}

describe("a login's permission on a repository", () => {
  test("reads GitHub's role: maintain and triage come from role_name, a custom role falls back to the legacy level", () => {
    expect(levelOf({ permission: "write", role_name: "maintain" })).toBe("maintain")
    expect(levelOf({ permission: "read", role_name: "triage" })).toBe("triage")
    expect(levelOf({ permission: "admin", role_name: "admin" })).toBe("admin")
    expect(levelOf({ permission: "write", role_name: "security-engineer" })).toBe("write")
    expect(levelOf({ permission: "none" })).toBe("none")
    expect(levelOf({ permission: "owner" })).toBe("unknown")
    expect(levelOf("nonsense")).toBe("unknown")
  })

  test("is cached for the TTL, read again after it, and `fresh` always asks GitHub", async () => {
    let at = 0
    const fake = fakeGh({ ana: () => ({ code: 0, out: answer("write", "write") }) })
    const permissions = createPermissions({ gh: fake.gh, now: () => at, ttlMs: 1000 })
    expect(await permissions.permissionOf("acme/app", "ana")).toBe("write")
    expect(await permissions.permissionOf("acme/app", "ANA")).toBe("write")
    expect(fake.calls).toEqual(["repos/acme/app/collaborators/ana/permission"])
    at = 999
    await permissions.permissionOf("acme/app", "ana")
    expect(fake.calls).toHaveLength(1)
    at = 1000
    await permissions.permissionOf("acme/app", "ana")
    expect(fake.calls).toHaveLength(2)
    await permissions.permissionOf("acme/app", "ana", { fresh: true })
    expect(fake.calls).toHaveLength(3)
  })

  test("a revocation is seen before a write: mayWrite revalidates even with a cached write", async () => {
    let level = "write"
    const fake = fakeGh({ ana: () => ({ code: 0, out: answer(level, level) }) })
    const permissions = createPermissions({ gh: fake.gh, now: () => 0 })
    expect(await permissions.permissionOf("acme/app", "ana")).toBe("write")
    level = "read"
    // Cached for display...
    expect(await permissions.permissionOf("acme/app", "ana")).toBe("write")
    // ...but never for the write itself.
    expect(await permissions.mayWrite("acme/app", "ana")).toBe(false)
    expect(await permissions.permissionOf("acme/app", "ana")).toBe("read")
  })

  test("any error is unknown, never cached and never a write: 404, rate limit, gh missing, a throw, an unparseable answer", async () => {
    const errors = [
      () => ({ code: 1, out: "", err: "gh: Not Found (HTTP 404)" }),
      () => ({ code: 1, out: "", err: "gh: API rate limit exceeded (HTTP 403)" }),
      () => ({ code: 127, out: "", err: "Executable not found in $PATH: \"gh\"" }),
      () => ({ code: 0, out: "<html>" }),
      () => { throw new Error("spawn failed") },
    ]
    for (const error of errors) {
      const fake = fakeGh({ ana: error })
      const permissions = createPermissions({ gh: fake.gh, now: () => 0 })
      expect(await permissions.permissionOf("acme/app", "ana")).toBe("unknown")
      expect(await permissions.mayWrite("acme/app", "ana", { fresh: false })).toBe(false)
      // Not cached: the second ask went to GitHub again.
      expect(fake.calls).toHaveLength(2)
    }
  })

  test("a failed fresh read drops the cached level, so a later cached read cannot bring back a write", async () => {
    let ok = true
    const fake = fakeGh({ ana: () => ok ? { code: 0, out: answer("admin", "admin") } : { code: 1, out: "", err: "HTTP 502" } })
    const permissions = createPermissions({ gh: fake.gh, now: () => 0 })
    expect(await permissions.mayWrite("acme/app", "ana")).toBe(true)
    ok = false
    expect(await permissions.mayWrite("acme/app", "ana")).toBe(false)
    expect(await permissions.permissionOf("acme/app", "ana")).toBe("unknown")
  })

  test("admin, maintain and write may push; triage, read and none may not", async () => {
    const roles: Record<string, [string, string]> = { a: ["admin", "admin"], m: ["write", "maintain"], w: ["write", "write"], t: ["read", "triage"], r: ["read", "read"], n: ["none", "none"] }
    const fake = fakeGh(Object.fromEntries(Object.entries(roles).map(([login, [permission, role]]) => [login, () => ({ code: 0, out: answer(permission, role) })])))
    const permissions = createPermissions({ gh: fake.gh })
    const may = await Promise.all(Object.keys(roles).map((login) => permissions.mayWrite("acme/app", login)))
    expect(may).toEqual([true, true, true, false, false, false])
  })

  test("an invalid repository or login is unknown without calling gh, so nothing reaches the URL", async () => {
    const fake = fakeGh({})
    const permissions = createPermissions({ gh: fake.gh })
    for (const [repo, login] of [["acme/app", "../../user"], ["acme/app", "ana?x=1"], ["../etc", "ana"], ["acme", "ana"], ["acme/app", ""]] as const) expect(await permissions.permissionOf(repo, login)).toBe("unknown")
    expect(fake.calls).toEqual([])
    // An app's login is valid.
    await permissions.permissionOf("acme/app", "my-app[bot]")
    expect(fake.calls).toEqual(["repos/acme/app/collaborators/my-app%5Bbot%5D/permission"])
  })

  test("concurrent asks share one request; forget drops a login, a repository or everything", async () => {
    let resolve!: () => void
    const gate = new Promise<void>((done) => { resolve = done })
    const calls: string[] = []
    const gh: GhCall = async ({ argv }) => { calls.push(argv[1]!); await gate; return { code: 0, out: answer("write", "write") } }
    const permissions = createPermissions({ gh, now: () => 0 })
    const both = Promise.all([permissions.permissionOf("acme/app", "ana"), permissions.permissionOf("acme/app", "ana")])
    resolve()
    expect(await both).toEqual(["write", "write"])
    expect(calls).toHaveLength(1)
    permissions.forget("acme/app", "ana")
    await permissions.permissionOf("acme/app", "ana")
    expect(calls).toHaveLength(2)
    await permissions.permissionOf("acme/other", "ana")
    permissions.forget("ACME/APP")
    await permissions.permissionOf("acme/app", "ana")
    await permissions.permissionOf("acme/other", "ana")
    expect(calls).toHaveLength(4)
    permissions.forget()
    await permissions.permissionOf("acme/other", "ana")
    expect(calls).toHaveLength(5)
  })

  test("an older read that answers after a fresh one does not replace it", async () => {
    const pending: Array<(out: string) => void> = []
    const gh: GhCall = ({ argv: _argv }) => new Promise((done) => pending.push((out) => done({ code: 0, out })))
    const permissions = createPermissions({ gh, now: () => 0 })
    const old = permissions.permissionOf("acme/app", "ana")
    const fresh = permissions.permissionOf("acme/app", "ana", { fresh: true })
    while (pending.length < 2) await Bun.sleep(0)
    pending[1]!(answer("read", "read"))
    expect(await fresh).toBe("read")
    pending[0]!(answer("admin", "admin"))
    expect(await old).toBe("admin")
    expect(await permissions.permissionOf("acme/app", "ana")).toBe("read")
  })
})
