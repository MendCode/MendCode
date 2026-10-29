import { Database } from "bun:sqlite"
import { afterEach, describe, expect, test } from "bun:test"
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { SessionEvent, type SessionId } from "@mendcode/protocol"
import { openStore, type Store } from "@mendcode/store"
import { derivedId, ENGINE_KEY, MigrateError, runMigration, type MigrationReport } from "../src"
import { openV1 } from "../src/v1-reader"
import { createV1Dir, ESCAPE_HEAVY, fingerprint, IDS, LONG_OUTPUT, PNG_BASE64, PNG_BYTES, removeAll, SECOND, SECRET, standardFixture, T0, tempRoot, text } from "./fixture"

const temps: string[] = []
const stores: Store[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  removeAll(temps)
})

function setup() {
  const root = tempRoot()
  temps.push(root)
  const from = standardFixture(root)
  return { root, from, dir: path.join(root, "v2"), home: path.join(root, "home") }
}

type Env = ReturnType<typeof setup>
const migrate = (env: Env, extra: Partial<Parameters<typeof runMigration>[0]> = {}) => runMigration({ from: env.from, dir: env.dir, home: env.home, ...extra })

function sessionIdOf(from: string, v1Id: string): SessionId {
  const reader = openV1(from)
  try {
    return derivedId("session", v1Id, reader.session(v1Id)!.createdAt)
  } finally {
    reader.close()
  }
}

/** Reopens the target the migration wrote (it closed its own store). */
function target(env: Env) {
  const store = openStore({ dir: env.dir })
  stores.push(store)
  return { store, events: (v1Id: string) => store.readAfter(sessionIdOf(env.from, v1Id), 0, 100_000) }
}

describe("import", () => {
  test("imports the synthetic history and leaves the v1 directory byte-identical", async () => {
    const env = setup()
    const before = fingerprint(env.from)
    const report = await migrate(env)
    expect(fingerprint(env.from)).toEqual(before)
    expect(report.sessions).toEqual({ seen: 11, imported: 9, already: 0, empty: 1, failed: 1, archived: 1, orphaned: 0 })
    expect(report.errors.map((error) => error.id)).toEqual([IDS.corrupt])
    expect(report.errors[0]!.message).toContain("invalid JSON")
  })

  test("every event validates against the protocol, with contiguous seq and non-decreasing time", async () => {
    const env = setup()
    await migrate(env)
    const { store, events } = target(env)
    for (const v1Id of Object.values(IDS)) {
      if (v1Id === IDS.empty || v1Id === IDS.corrupt) {
        expect(store.hasSession(sessionIdOf(env.from, v1Id))).toBe(false)
        continue
      }
      const list = events(v1Id)
      expect(list.length).toBeGreaterThan(2)
      let previousAt = 0
      list.forEach((event, index) => {
        expect(SessionEvent.parse(event)).toEqual(event)
        expect(event.seq).toBe(index + 1)
        expect(event.at).toBeGreaterThanOrEqual(previousAt)
        previousAt = event.at
      })
      expect(list[0]!.type).toBe("session.created")
    }
  })

  test("maps parts to items: user text without synthetic parts, reasoning text only, tool statuses, skipped parts counted", async () => {
    const env = setup()
    const report = await migrate(env)
    const { events } = target(env)
    const list = events(IDS.alpha)
    const items = new Map<string, { kind: string; meta?: unknown; status?: string; text?: string }>()
    for (const event of list) {
      if (event.type === "item.started") items.set(event.itemId, { kind: event.kind, ...(event.meta ? { meta: event.meta } : {}) })
      if (event.type === "item.completed") Object.assign(items.get(event.itemId)!, { status: event.status, ...(event.text !== undefined ? { text: event.text } : {}) })
    }
    const all = [...items.values()]
    expect(all.filter((item) => item.kind === "user_message").map((item) => item.text)).toEqual(["hello alpha", "second question"])
    expect(all.filter((item) => item.kind === "reasoning").map((item) => item.text)).toEqual(["thinking about alpha"])
    const tools = all.filter((item) => item.kind === "tool_call")
    expect(tools.slice(0, 3).map((item) => [item.meta, item.status, item.text])).toEqual([
      [{ tool: "read", title: "src/a.ts" }, "ok", "file contents"],
      [{ tool: "bash", title: "bash" }, "error", "exit code 2"],
      [{ tool: "edit", title: "edit" }, "interrupted", undefined],
    ])
    expect(all.filter((item) => item.kind === "agent_message").map((item) => item.text)).toEqual(["Done with alpha.", "second answer"])
    expect(JSON.stringify(list)).not.toContain("ENCRYPTED-BLOB")
    expect(JSON.stringify(list)).not.toContain("SYNTHETIC-HIDDEN")
    expect(report.partsSkipped).toMatchObject({ patch: 1, "step-start": 1, "step-finish": 1, "text (synthetic or ignored)": 1 })
    expect(report.items).toMatchObject({ reasoning: 1, tool_call: 6, compaction: 2 })
    expect(list.filter((event) => event.type === "turn.started")).toHaveLength(2)
  })

  test("long text goes to a blob with a preview, even when it fits the character limit but not the event size", async () => {
    const env = setup()
    const report = await migrate(env)
    const { store, events } = target(env)
    const completed = events(IDS.alpha).filter((event): event is Extract<SessionEvent, { type: "item.completed" }> => event.type === "item.completed" && event.blob !== undefined)
    expect(completed).toHaveLength(2)
    const [long, escapes] = completed
    expect(long!.blob!.mime).toBe("text/plain")
    expect(long!.text!.length).toBeLessThanOrEqual(4001)
    expect(long!.text!.startsWith("line with")).toBe(true)
    expect(readFileSync(store.blobPath(long!.blob!.sha256), "utf8")).toBe(LONG_OUTPUT)
    expect(readFileSync(store.blobPath(escapes!.blob!.sha256), "utf8")).toBe(ESCAPE_HEAVY)
    expect(report.longTexts).toBe(2)
  })

  test("identical attachments are stored once and referenced twice", async () => {
    const env = setup()
    const report = await migrate(env)
    const { store, events } = target(env)
    const refs = [IDS.alpha, IDS.compacted].flatMap((v1Id) => events(v1Id).flatMap((event) => (event.type === "item.completed" ? (event.attachments ?? []) : [])))
    expect(refs).toHaveLength(2)
    expect(refs[0]!.sha256).toBe(refs[1]!.sha256)
    expect(refs[0]).toMatchObject({ mime: "image/png", bytes: PNG_BYTES, name: "shot.png" })
    expect(report.attachments).toEqual({ count: 2, decodedBytes: 2 * PNG_BYTES, uniqueBytes: PNG_BYTES, savedBytes: PNG_BYTES, notAttached: 0 })
    expect(existsSync(store.blobPath(refs[0]!.sha256))).toBe(true)
    // the image once, plus the two long texts
    expect(readdirSync(path.join(env.dir, "blobs")).flatMap((sub) => readdirSync(path.join(env.dir, "blobs", sub)))).toHaveLength(3)
  })

  test("a file that is not a data URL becomes a text line", async () => {
    const env = setup()
    await migrate(env)
    const { events } = target(env)
    const user = events(IDS.interrupted).find((event) => event.type === "item.completed")
    expect(user).toMatchObject({ text: "unanswered\n\n[file: notes.txt file:///tmp/notes.txt]" })
  })

  test("turn outcomes: completed, cancelled by the user, failed with the v1 message, interrupted on restart", async () => {
    const env = setup()
    const report = await migrate(env)
    const { events } = target(env)
    const last = (v1Id: string) => events(v1Id).at(-1)!
    expect(last(IDS.alpha).type).toBe("turn.completed")
    expect(last(IDS.aborted)).toMatchObject({ type: "turn.cancelled", by: "user" })
    expect(last(IDS.failed)).toMatchObject({ type: "turn.failed", error: { code: "v1_error", message: "boom" } })
    expect(last(IDS.interrupted)).toMatchObject({ type: "turn.interrupted", reason: "restart" })
    // alpha 2, compacted 5 (two compaction turns), child 1, archived 1, late child 1, late parent 1
    expect(report.turns).toEqual({ completed: 11, failed: 1, cancelled: 1, interrupted: 1 })
  })

  test("compactions become items carrying the summary text", async () => {
    const env = setup()
    await migrate(env)
    const { events } = target(env)
    const list = events(IDS.compacted)
    const kinds = new Map<string, string>()
    const summaries: string[] = []
    for (const event of list) {
      if (event.type === "item.started") kinds.set(event.itemId, event.kind)
      if (event.type === "item.completed" && kinds.get(event.itemId) === "compaction") summaries.push(event.text ?? "")
    }
    expect(summaries).toEqual(["SUMMARY ZERO", "SUMMARY ONE"])
  })

  test("child sessions point at their parent, also when the parent sorts after the child", async () => {
    const env = setup()
    const report = await migrate(env)
    const { store } = target(env)
    expect(store.sessionInfo(sessionIdOf(env.from, IDS.child))?.parentId).toBe(sessionIdOf(env.from, IDS.alpha))
    expect(store.sessionInfo(sessionIdOf(env.from, IDS.lateChild))?.parentId).toBe(sessionIdOf(env.from, IDS.lateParent))
    expect(report.sessions.orphaned).toBe(0)
  })

  test("a session whose parent is not imported is kept without a parent and counted", async () => {
    const root = tempRoot()
    temps.push(root)
    const v1 = createV1Dir(root)
    v1.session({ id: "ses_p", created: T0 })
    v1.user("ses_p", "m1", T0 + SECOND, [text("parent")])
    v1.session({ id: "ses_c", created: Date.UTC(2026, 1, 3), parent: "ses_p" })
    v1.user("ses_c", "m2", Date.UTC(2026, 1, 3) + SECOND, [text("child")])
    v1.finish()
    const dir = path.join(root, "v2")
    const report = await runMigration({ from: v1.dir, dir, home: path.join(root, "home"), since: Date.UTC(2026, 1, 1) })
    expect(report.sessions).toMatchObject({ seen: 1, imported: 1, orphaned: 1 })
    const store = openStore({ dir })
    stores.push(store)
    expect(store.sessionInfo(derivedId("session", "ses_c", Date.UTC(2026, 1, 3)))?.parentId).toBeNull()
  })

  test("an unreadable data URL leaves a marker in the message and the session is still imported", async () => {
    const root = tempRoot()
    temps.push(root)
    const v1 = createV1Dir(root)
    v1.session({ id: "ses_bad", created: T0 })
    v1.user("ses_bad", "m1", T0 + SECOND, [text("look"), { type: "file", mime: "image/png", filename: "x.png", url: "data:image/png;base64,@@@not-base64@@@" }])
    v1.session({ id: "ses_ok", created: T0 + 10 * SECOND })
    v1.user("ses_ok", "m2", T0 + 11 * SECOND, [text("fine")])
    v1.finish()
    const env = { root, from: v1.dir, dir: path.join(root, "v2"), home: path.join(root, "home") }
    const report = await migrate(env)
    expect(report.sessions).toMatchObject({ seen: 2, imported: 2, failed: 0 })
    expect(report.partsSkipped["file (unreadable data)"]).toBe(1)
    const user = target(env).events("ses_bad").find((event) => event.type === "item.completed" && event.text?.startsWith("look"))
    expect(user).toMatchObject({ text: "look\n\n[file: x.png (not attached: unreadable data)]" })
  })

  test("URL-safe base64 attachments decode to the same bytes", async () => {
    const root = tempRoot()
    temps.push(root)
    const v1 = createV1Dir(root)
    const urlSafe = PNG_BASE64.replace(/\+/g, "-").replace(/\//g, "_")
    v1.session({ id: "ses_safe", created: T0 })
    v1.user("ses_safe", "m1", T0 + SECOND, [text("img"), { type: "file", mime: "image/png", filename: "a.png", url: `data:image/png;base64,${urlSafe}` }])
    v1.finish()
    const report = await runMigration({ from: v1.dir, dir: path.join(root, "v2"), home: path.join(root, "home") })
    expect(report.attachments).toMatchObject({ count: 1, decodedBytes: PNG_BYTES })
  })

  test("--since keeps only recently updated sessions", async () => {
    const env = setup()
    const report = await migrate(env, { since: Date.UTC(2026, 1, 1) })
    expect(report.since).toBe("2026-02-01")
    expect(report.sessions).toMatchObject({ seen: 2, imported: 2 })
  })
})

describe("idempotence and recovery", () => {
  test("a rerun imports nothing new and keeps every session exactly once", async () => {
    const env = setup()
    await migrate(env)
    const { store } = target(env)
    const seqBefore = Object.values(IDS).map((v1Id) => store.lastSeq(sessionIdOf(env.from, v1Id)))
    const memoriesBefore = store.memories.list().length
    store.close()
    stores.length = 0
    const second = await migrate(env)
    expect(second.sessions).toEqual({ seen: 11, imported: 0, already: 9, empty: 1, failed: 1, archived: 0, orphaned: 0 })
    expect(second.memories).toMatchObject({ imported: 0, already: 3 })
    expect(second.messages).toBe(0)
    const reopened = target(env)
    expect(Object.values(IDS).map((v1Id) => reopened.store.lastSeq(sessionIdOf(env.from, v1Id)))).toEqual(seqBefore)
    expect(reopened.store.memories.list()).toHaveLength(memoriesBefore)
    expect(reopened.events(IDS.alpha)).toHaveLength(seqBefore[0]!)
  })

  test("a half-imported session from an interrupted run is restarted, not duplicated", async () => {
    const env = setup()
    const alpha = sessionIdOf(env.from, IDS.alpha)
    const early = openStore({ dir: env.dir })
    early.createSession({ id: alpha, directory: "/work/alpha", title: "half" })
    early.close()
    await migrate(env)
    const { store, events } = target(env)
    expect(events(IDS.alpha).filter((event) => event.type === "session.created")).toHaveLength(1)
    expect(store.sessionInfo(alpha)?.title).toBe("Title of ses_a")
    expect(store.engineBindings.get(alpha, "migrate-v1")).toBe(IDS.alpha)
  })
})

describe("dry run", () => {
  test("reports exactly what an import would and creates no v2 file", async () => {
    const env = setup()
    const before = fingerprint(env.from)
    const dry = await migrate(env, { dryRun: true })
    expect(existsSync(env.dir)).toBe(false)
    expect(fingerprint(env.from)).toEqual(before)
    expect(dry.dryRun).toBe(true)
    expect(dry.reportFile).toBeUndefined()
    const real = await migrate(env)
    const comparable = (report: MigrationReport) => ({ sessions: report.sessions, messages: report.messages, items: report.items, turns: report.turns, partsSkipped: report.partsSkipped, attachments: report.attachments, longTexts: report.longTexts, memories: report.memories, engineContext: report.engineContext, errors: report.errors })
    expect(comparable(dry)).toEqual(comparable(real))
  })

  test("a dry run does not touch an existing v2 store", async () => {
    const env = setup()
    mkdirSync(env.dir, { recursive: true })
    await migrate(env, { dryRun: true })
    expect(readdirSync(env.dir)).toEqual([])
  })
})

describe("refusals", () => {
  test("a target inside the v1 directory is refused and nothing is written", async () => {
    const env = setup()
    const before = fingerprint(env.from)
    await expect(runMigration({ from: env.from, dir: path.join(env.from, "v2"), home: env.home })).rejects.toMatchObject({ code: "dir-inside-from" })
    await expect(runMigration({ from: env.from, dir: env.from, home: env.home })).rejects.toMatchObject({ code: "dir-inside-from" })
    expect(fingerprint(env.from)).toEqual(before)
  })

  test("a target inside ~/.mendcode or ~/.local/share/mendcode is refused", async () => {
    const env = setup()
    for (const v1Home of [".mendcode", path.join(".local", "share", "mendcode")]) {
      const dir = path.join(env.home, v1Home, "next")
      await expect(runMigration({ from: env.from, dir, home: env.home })).rejects.toMatchObject({ code: "dir-is-v1" })
      expect(existsSync(dir)).toBe(false)
    }
  })

  test("a source without mendcode-local.db is refused", async () => {
    const env = setup()
    const empty = path.join(env.root, "not-v1")
    mkdirSync(empty)
    await expect(runMigration({ from: empty, dir: env.dir, home: env.home })).rejects.toBeInstanceOf(MigrateError)
    await expect(runMigration({ from: empty, dir: env.dir, home: env.home })).rejects.toMatchObject({ code: "missing-db" })
    expect(existsSync(env.dir)).toBe(false)
  })

  test("a target locked by another writer is refused with a clear message", async () => {
    const env = setup()
    const before = fingerprint(env.from)
    const holder = openStore({ dir: env.dir })
    stores.push(holder)
    const error = await migrate(env).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(MigrateError)
    expect((error as MigrateError).code).toBe("target-locked")
    expect((error as MigrateError).message).toContain(`stop MendCode first (a daemon is using ${env.dir})`)
    expect(fingerprint(env.from)).toEqual(before)
  })
})

describe("memories", () => {
  test("saved and archived entries are mapped; duplicates and high sensitivity are skipped", async () => {
    const env = setup()
    const report = await migrate(env)
    expect(report.memories).toEqual({ imported: 3, already: 0, duplicate: 1, skippedHighSensitivity: 1, invalid: 0, truncated: 0 })
    const { store } = target(env)
    const byText = new Map(store.memories.list().map((memory) => [memory.text, memory]))
    expect(byText.get("Prefer Bun")).toMatchObject({ scope: "user", category: "prefs", status: "saved", createdAt: Date.UTC(2026, 0, 2), updatedAt: Date.UTC(2026, 0, 3) })
    expect(byText.get("Use pnpm here")).toMatchObject({ scope: "project", directory: "/work/alpha", status: "saved" })
    expect(byText.get("Old fact")).toMatchObject({ scope: "user", status: "archived" })
    expect(byText.has("the api key is hunter2")).toBe(false)
    const raw = new Database(path.join(env.dir, "mendd.db"), { readonly: true })
    expect(raw.query<{ source: string }, []>("SELECT source FROM memories WHERE text = 'Use pnpm here'").get()?.source).toBe("v1:agent")
    raw.close()
  })

  test("--no-memories leaves them out", async () => {
    const env = setup()
    const report = await migrate(env, { memories: false })
    expect(report.memories.imported).toBe(0)
    expect(target(env).store.memories.list()).toEqual([])
  })
})

describe("engine context", () => {
  test("only what follows the last compaction is written, summary first, tool calls paired with results", async () => {
    const env = setup()
    const report = await migrate(env)
    const { store } = target(env)
    const messages = store.engineMessages.load(sessionIdOf(env.from, IDS.compacted), ENGINE_KEY) as Array<Record<string, unknown>>
    expect(messages.map((message) => message.role)).toEqual(["user", "user", "assistant", "tool", "assistant"])
    expect(messages[0]!.content).toBe("Summary of the conversation so far (earlier messages were compacted):\n\nSUMMARY ONE")
    expect(messages[1]).toMatchObject({ role: "user", content: "after compaction", attachments: [{ mime: "image/png", name: "shot.png" }] })
    expect(messages[2]).toMatchObject({ role: "assistant", content: "", toolCalls: [{ callId: "call_after", name: "read", args: { path: "x" } }] })
    expect(messages[3]).toMatchObject({ role: "tool", callId: "call_after", name: "read", output: "after tool", isError: false })
    expect(messages[4]).toMatchObject({ role: "assistant", content: "final answer", toolCalls: [] })
    expect(JSON.stringify(messages)).not.toContain("SUMMARY ZERO")
    expect(JSON.stringify(messages)).not.toContain("middle")
    expect(report.engineContext.sessions).toBe(9)
  })

  test("a session without compaction keeps its whole conversation; a tool that never finished is an error result", async () => {
    const env = setup()
    await migrate(env)
    const { store } = target(env)
    const messages = store.engineMessages.load(sessionIdOf(env.from, IDS.alpha), ENGINE_KEY) as Array<Record<string, unknown>>
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "tool", "tool", "tool", "assistant", "user", "assistant", "tool", "tool", "assistant"])
    const tools = messages.filter((message) => message.role === "tool")
    expect(tools.slice(0, 3).map((message) => [message.name, message.isError])).toEqual([["read", false], ["bash", true], ["edit", true]])
    expect((tools[0] as { output: string }).output).toBe("file contents")
    expect((tools[2] as { output: string }).output).toContain("never finished")
  })
})

describe("report", () => {
  test("is saved under <dir>/migrations, lists what was left behind and never touches credentials", async () => {
    const env = setup()
    const lines: string[] = []
    const report = await migrate(env, { onProgress: (line) => lines.push(line) })
    expect(report.reportFile).toBeDefined()
    expect(path.dirname(report.reportFile!)).toBe(path.join(env.dir, "migrations"))
    expect(path.basename(report.reportFile!)).toMatch(/^v1-\d{4}-\d{2}-\d{2}T[\d-]+Z\.json$/)
    const saved = JSON.parse(readFileSync(report.reportFile!, "utf8")) as MigrationReport
    expect(saved).toEqual(JSON.parse(JSON.stringify(report)))
    expect(report.credentialsNotRead).toEqual(["auth.json", "mcp-auth.json"])
    expect(JSON.stringify(report)).not.toContain(SECRET)
    const left = new Map(report.notMigrated.map((entry) => [entry.name, entry]))
    expect(left.get("storage")).toMatchObject({ bytes: 100, approximate: false })
    expect(left.get("log")!.bytes).toBe(50)
    expect(left.get("snapshot")!.bytes).toBe(10)
    expect(left.get("session-transcripts")!.bytes).toBe(20)
    expect(left.get(path.join("memory", "dream"))!.bytes).toBe(2)
    expect(left.get("other.db")!.bytes).toBe(30)
    expect(left.has("mendcode-local.db")).toBe(false)
    expect(report.durationMs).toBeGreaterThanOrEqual(0)
    expect(lines[0]).toContain("11 sessions")
  })

  test("progress is reported every 50 sessions with elapsed time", async () => {
    const root = tempRoot()
    temps.push(root)
    const v1 = createV1Dir(root)
    for (let i = 0; i < 120; i++) {
      const id = `ses_${String(i).padStart(3, "0")}`
      v1.session({ id, created: T0 + i * SECOND })
      v1.user(id, `m_${id}`, T0 + i * SECOND + 1, [text(`question ${i}`)])
    }
    v1.finish()
    const lines: string[] = []
    const report = await runMigration({ from: v1.dir, dir: path.join(root, "v2"), home: path.join(root, "home"), onProgress: (line) => lines.push(line) })
    expect(report.sessions.imported).toBe(120)
    expect(lines.filter((line) => /: (50|100)\/120 sessions/.test(line))).toHaveLength(2)
    expect(lines.at(-1)).toMatch(/100\/120 sessions \(100 imported, 0 already, 0 empty, 0 failed\) \d/)
  })
})

describe("v1 database access", () => {
  test("a write-ahead log that holds the only copy of the data is read without changing the database or the log", async () => {
    const root = tempRoot()
    temps.push(root)
    const live = createV1Dir(path.join(root, "live"))
    live.db.run("PRAGMA wal_autocheckpoint = 0")
    live.session({ id: "ses_wal", created: T0 })
    live.user("ses_wal", "m1", T0 + SECOND, [text("only in the log")])
    const from = path.join(root, "copy")
    mkdirSync(from)
    for (const name of ["mendcode-local.db", "mendcode-local.db-wal", "mendcode-local.db-shm"]) copyFileSync(path.join(live.dir, name), path.join(from, name))
    live.db.close()
    expect(statSync(path.join(from, "mendcode-local.db-wal")).size).toBeGreaterThan(0)
    const hashes = (names: string[]) => fingerprint(from).filter((entry) => names.some((name) => entry.startsWith(`${name} `)))
    const before = hashes(["mendcode-local.db", "mendcode-local.db-wal"])
    const report = await runMigration({ from, dir: path.join(root, "v2"), home: path.join(root, "home"), dryRun: true })
    expect(report.sessions).toMatchObject({ seen: 1, imported: 1 })
    expect(hashes(["mendcode-local.db", "mendcode-local.db-wal"])).toEqual(before)
  })
})

describe("a SQLite build without URI filenames", () => {
  test("the v1 database is read from a private snapshot that is removed on close, and the v1 directory is not touched", () => {
    const env = setup()
    const before = fingerprint(env.from)
    const snapshots = () => readdirSync(tmpdir()).filter((name) => name.startsWith("mendcode-v1-"))
    const leftBefore = snapshots()
    const reader = openV1(env.from, { immutableUri: false })
    expect(reader.sessionCount(undefined)).toBe(11)
    expect(snapshots().length).toBe(leftBefore.length + 1)
    reader.close()
    expect(snapshots()).toEqual(leftBefore)
    expect(fingerprint(env.from)).toEqual(before)
  })
})
