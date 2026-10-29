import { afterEach, describe, expect, test } from "bun:test"
import { boot, openSession, say, stop, until } from "./native-harness"

const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })
async function native(options: Parameters<typeof boot>[0] = {}) {
  const h = await boot(options)
  cleanup.push(() => h.cleanup())
  return h
}

/** The headless `--effort LEVEL` reaches the daemon as `ModelChoice.effort`, the choice F3 and `/model ID LEVEL` already make. */
describe("effort chosen for a native model", () => {
  test("session.create with an effort sends that effort in the model request", async () => {
    const h = await native({ steps: [stop("done")] })
    const created = await h.client.send({ type: "session.create", directory: h.project, choice: { model: "gpt-6-luna", effort: "medium" } })
    const sessionId = created.ok ? (created.result!.sessionId as import("@mendcode/protocol").SessionId) : undefined
    expect(sessionId).toBeDefined()
    await h.client.subscribe(sessionId!, 0)
    await h.client.send({ type: "session.permission.set", sessionId: sessionId!, mode: "full" })
    await say(h, sessionId!, "hello")
    expect(h.requests[0]).toMatchObject({ model: "gpt-6-luna", effort: "medium" })
  })

  test("a per-turn selection with an effort applies to that turn only", async () => {
    const h = await native({ steps: [stop("one"), stop("two")] })
    const sessionId = await openSession(h)
    await h.client.send({ type: "session.model.set", sessionId, choice: { model: "gpt-6-luna", effort: "high" } })
    expect(await h.client.send({ type: "user.submit", sessionId, text: "one", attachments: [], selection: { model: { model: "gpt-6-luna", effort: "low" } } })).toMatchObject({ ok: true })
    await until(() => h.store.lastTurnStatus(sessionId) === "completed")
    await say(h, sessionId, "two")
    expect(h.requests.map((request) => request.effort)).toEqual(["low", "high"])
  })

  test("an effort the model does not list is refused with the valid ones, for creation, switch and turn", async () => {
    const h = await native()
    const choice = { model: "gpt-6-luna", effort: "xhigh" as const }
    const created = await h.client.send({ type: "session.create", directory: h.project, choice })
    expect(created.ok ? "" : created.error.message).toContain("gpt-6-luna supports low, medium, high; effort xhigh is not one of them")
    const sessionId = await openSession(h)
    const switched = await h.client.send({ type: "session.model.set", sessionId, choice })
    expect(switched.ok ? "" : switched.error.message).toContain("supports low, medium, high")
    const turn = await h.client.send({ type: "user.submit", sessionId, text: "x", attachments: [], selection: { model: choice } })
    expect(turn).toMatchObject({ ok: false, error: { code: "invalid_command" } })
    expect(h.requests).toHaveLength(0)
  })

  test("a model that lists no efforts is not constrained by the daemon: the choice is kept as asked", async () => {
    const { invalidChoice, resolveModel } = await import("../src/models")
    const catalog = { selectable: true, list: () => [{ id: "plain", name: "Plain", efforts: [] }], defaults: { model: "plain" } }
    expect(invalidChoice({ model: "plain", effort: "high" }, catalog)).toBeUndefined()
    expect(resolveModel({ role: "main", session: { model: "plain", effort: "high" }, roles: {}, catalog })).toEqual({ model: "plain", effort: "high" })
  })
})
