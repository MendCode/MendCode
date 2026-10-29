import { afterEach, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { appHarness, cleanTemps, conversation, ids, NOW, tempDir } from "./session-ui-harness"
import { parseFanout } from "../src/view/fanout"
import { quoteWithComment } from "../src/view/quote"
import { groupSessions } from "../src/view/session-list"

afterEach(cleanTemps)
test("fan-out opens with cold lazy modules in an isolated app process", async () => {
  const out = tempDir()
  const run = Bun.spawn([process.execPath, path.resolve(import.meta.dir, "../../../scripts/render-t6-t11-frames.ts"), out], { stdout: "pipe", stderr: "pipe" })
  const [exit, errors] = await Promise.all([run.exited, new Response(run.stderr).text()])
  expect(errors).toBe("")
  expect(exit).toBe(0)
  expect(readFileSync(path.join(out, "fanout-100x30.txt"), "utf8")).toContain("fake-b: inspected changes and tests")
})
function harness(width = 100, height = 30, remote = false) {
  const sessionId = ids("session")
  const directory = tempDir()
  const lifecycle = { pinnedAt: NOW, pr: { number: 7, url: "https://github.com/acme/app/pull/7", title: "Fix", state: "OPEN" as const, branch: "fix", checkedAt: NOW } }
  const sessions = [
    { sessionId, directory, title: "Pinned fix", createdAt: NOW, updatedAt: NOW, state: "idle" as const, queued: 0, lifecycle },
    { sessionId: ids("session"), directory, title: "Active work", createdAt: NOW, updatedAt: NOW, state: "idle" as const, queued: 0 },
    { sessionId: ids("session"), directory, title: "Settled work", createdAt: NOW, updatedAt: NOW, state: "idle" as const, queued: 0, archivedAt: NOW, lifecycle: { settledReason: "Reviewed" } },
  ]
  const branches = ["fake-a", "fake-b"].map((model, index) => ({ sessionId: sessions[index + 1]!.sessionId, directory, model, branch: `fanout-${model}`, state: "idle", summary: `${model} complete` }))
  const h = appHarness({ width, height, sessionId, directory, dataDir: tempDir(), ...(remote ? { remote: { host: "localhost", readOnly: false } } : {}), reply: (command) => {
    if (command.type === "session.list") return { ok: true, result: { sessions } }
    if (command.type === "session.fanout") return { ok: true, result: { branches } }
    if (command.type === "session.history") return { ok: true, result: { sessionId, turns: [{ turnId: ids("turn"), at: NOW, status: "completed", reverted: false, items: [{ itemId: ids("item"), kind: "user_message", text: "request", status: "ok" }, { itemId: ids("item"), kind: "agent_message", text: "answer\nsecond line", status: "ok" }] }] } }
    return { ok: true }
  } })
  return { ...h, sessions }
}

test("lifecycle slash commands send explicit actions and Undo restores the settled thread", async () => {
  const h = harness()
  for (const command of ["/title regenerate", "/pin off", "/pr link 7", "/settle rules inactive 7", "/settle reviewed", "/settle undo"]) await h.type(`${command}\r`)
  expect(h.sentOf("session.meta").map((command) => "input" in command ? command.input : undefined)).toEqual([
    { action: "regenerate_title" }, { action: "pin", pinned: false }, { action: "link_pr", pr: "7" },
    { action: "rules", inactiveDays: 7, disabled: false }, { action: "settle", reason: "reviewed" }, { action: "restore" },
  ])
  expect(h.sentOf("user.submit")).toHaveLength(0)
})
test("local metadata and worktree commands never leave a remote TUI", async () => {
  const h = harness(100, 30, true)
  await h.type("/title regenerate\r")
  await h.type('/fanout "test" fake-a fake-b\r')
  expect(h.sentOf("session.meta")).toHaveLength(0)
  expect(h.sentOf("session.fanout")).toHaveLength(0)
})
test("fan-out comparison and session sections render at compact and wide sizes", async () => {
  for (const [width, height] of [[100, 30], [180, 50]]) {
    const h = harness(width, height)
    await h.type('/fanout "compare the fix" fake-a fake-b\r')
    expect(h.sentOf("session.fanout").at(-1)).toMatchObject({ action: "start", prompt: "compare the fix", models: ["fake-a", "fake-b"] })
    expect(h.text().join("\n")).toContain("fake-a complete")
    expect(h.text().join("\n")).toContain("fake-b complete")
    await h.type("\x1b")
    await h.type("/sessions\r")
    await h.type("\x0f")
    const frame = h.text().join("\n")
    expect(frame).toContain("Pinned")
    expect(frame).toContain("Active")
    expect(frame).toContain("Settled")
    expect(frame).toContain("#7")
    expect(h.frames.at(-1)!.length).toBeLessThanOrEqual(height)
  }
})
test("orchestration updates replace their grouped transcript card", () => {
  const h = harness()
  const c = conversation(h.sessionId, (event) => h.app.onEvent(event))
  c.emit({ type: "session.orchestration", groupId: "group-one", text: "Fan-out pending" })
  c.emit({ type: "session.orchestration", groupId: "group-one", text: "Fan-out complete" })
  h.app.render()
  expect(h.text().join("\n")).toContain("Fan-out complete")
  expect(h.text().join("\n")).not.toContain("Fan-out pending")
})
test("Quote + comment keeps the existing draft and never submits it", async () => {
  const h = harness()
  await h.type("/messages\r")
  h.app.editor.replaceAll("existing comment")
  await h.type("\r")
  await h.type("Q")
  expect(h.app.page).toBe("chat")
  expect(h.app.editor.text).toBe("> answer\n> second line\n\nexisting comment")
  expect(h.sentOf("user.submit")).toHaveLength(0)
})
test("prompt quoting, malformed fan-out and archived pins have bounded deterministic behavior", () => {
  expect(quoteWithComment("line one\nline two", "review this")).toBe("> line one\n> line two\n\nreview this")
  expect(quoteWithComment("x".repeat(20000)).length).toBe(16004)
  expect(parseFanout('"say \\"hello\\"" a b')).toEqual({ prompt: 'say "hello"', models: ["a", "b"] })
  for (const bad of ['"test" a', 'test a b', '"" a b', '"broken a b']) expect(parseFanout(bad)).toBeUndefined()
  const h = harness()
  expect(groupSessions(h.sessions, "", h.sessionId, true).map((group) => group.section)).toEqual(["Pinned", "Active", "Settled"])
})
