import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

/**
 * Synthetic legacy MendCode data directories. Nothing here reads or copies real v1 data: every directory is built from
 * scratch in a temp dir, following the v1 drizzle schema the importer reads.
 */

export const T0 = Date.UTC(2026, 0, 10)
export const SECOND = 1000

/** A 1x1 PNG, as v1 stores attachments: a base64 data URL inside a `file` part. */
export const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
export const PNG_URL = `data:image/png;base64,${PNG_BASE64}`
export const PNG_BYTES = Buffer.from(PNG_BASE64, "base64").byteLength

const SCHEMA = `
CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL, vcs TEXT, name TEXT, icon_url TEXT, icon_color TEXT, time_created INTEGER, time_updated INTEGER, time_initialized INTEGER, sandboxes TEXT NOT NULL, commands TEXT, icon_url_override TEXT);
CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT, slug TEXT NOT NULL, directory TEXT NOT NULL, title TEXT NOT NULL, version TEXT NOT NULL, share_url TEXT, summary_additions INTEGER, summary_deletions INTEGER, summary_files INTEGER, summary_diffs TEXT, revert TEXT, permission TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, time_compacting INTEGER, time_archived INTEGER, workspace_id TEXT, path TEXT, agent TEXT, model TEXT);
CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER, time_updated INTEGER, data TEXT NOT NULL);
CREATE INDEX message_session_idx ON message (session_id, time_created, id);
CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER, time_updated INTEGER, data TEXT NOT NULL);
CREATE INDEX part_session_idx ON part (session_id);
CREATE INDEX part_message_idx ON part (message_id, id);
`

type Json = Record<string, unknown>

export type V1Builder = ReturnType<typeof createV1Dir>

/** Creates `<root>/v1` with an empty v1 schema; `finish()` closes the database the way a stopped v1 leaves it. */
export function createV1Dir(root: string) {
  const dir = path.join(root, "v1")
  mkdirSync(dir, { recursive: true })
  const db = new Database(path.join(dir, "mendcode-local.db"), { create: true })
  db.run("PRAGMA journal_mode = WAL")
  db.run(SCHEMA)
  db.query("INSERT INTO project (id, worktree, sandboxes, time_created, time_updated) VALUES ('prj_1', '/work/alpha', '[]', ?, ?)").run(T0, T0)
  let partCounter = 0
  const builder = {
    dir,
    db,
    session(input: { id: string; created: number; updated?: number; parent?: string; directory?: string; title?: string; archived?: boolean }) {
      db.query("INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated, time_archived) VALUES (?, 'prj_1', ?, ?, ?, ?, '1', ?, ?, ?)").run(
        input.id,
        input.parent ?? null,
        input.id,
        input.directory ?? "/work/alpha",
        input.title ?? `Title of ${input.id}`,
        input.created,
        input.updated ?? input.created + 60 * SECOND,
        input.archived ? input.created + 120 * SECOND : null,
      )
    },
    message(sessionId: string, id: string, created: number, data: Json) {
      db.query("INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)").run(id, sessionId, created, created, JSON.stringify(data))
    },
    /** `raw` inserts the part text as is (a corrupt part). */
    part(sessionId: string, messageId: string, created: number, data: Json | { raw: string }) {
      const id = `prt_${String(++partCounter).padStart(6, "0")}`
      db.query("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)").run(id, messageId, sessionId, created, created, "raw" in data && typeof data.raw === "string" ? data.raw : JSON.stringify(data))
    },
    user(sessionId: string, id: string, created: number, parts: Json[]) {
      builder.message(sessionId, id, created, { role: "user", time: { created }, agent: "build", model: { providerID: "openai", modelID: "gpt" } })
      for (const part of parts) builder.part(sessionId, id, created, part)
    },
    assistant(sessionId: string, id: string, created: number, options: { completed?: number; error?: Json; summary?: boolean; parts: Array<Json | { raw: string }> }) {
      builder.message(sessionId, id, created, {
        role: "assistant",
        parentID: "x",
        mode: "build",
        agent: "build",
        modelID: "gpt",
        providerID: "openai",
        time: { created, ...(options.completed ? { completed: options.completed } : {}) },
        tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
        cost: 0,
        ...(options.summary ? { summary: true } : {}),
        ...(options.error ? { error: options.error } : {}),
      })
      for (const part of options.parts) builder.part(sessionId, id, created, part)
    },
    /** Closes the database with the log emptied, as a cleanly stopped v1 leaves it, and removes the log files. */
    finish() {
      db.run("PRAGMA wal_checkpoint(TRUNCATE)")
      db.close()
      rmSync(path.join(dir, "mendcode-local.db-wal"), { force: true })
      rmSync(path.join(dir, "mendcode-local.db-shm"), { force: true })
    },
  }
  return builder
}

export const text = (value: string, extra: Json = {}) => ({ type: "text", text: value, ...extra })
export const file = (url: string, filename: string, mime = "image/png") => ({ type: "file", mime, filename, url })
export const tool = (name: string, state: Json, callID = `call_${name}`) => ({ type: "tool", tool: name, callID, state })
export const done = (output: string, title?: string) => ({ status: "completed", input: { path: "x" }, output, ...(title ? { title } : {}), time: { start: 1, end: 2 } })

export const LONG_OUTPUT = `${"line with \"quotes\" and text\n".repeat(4000)}`
/** Under MAX_INLINE_TEXT characters, but over the event size limit once JSON-escaped. */
export const ESCAPE_HEAVY = '"'.repeat(40_000)

export const IDS = {
  alpha: "ses_a",
  compacted: "ses_b",
  aborted: "ses_c",
  failed: "ses_d",
  child: "ses_e",
  empty: "ses_f",
  archived: "ses_g",
  corrupt: "ses_h",
  interrupted: "ses_i",
  lateChild: "ses_j",
  lateParent: "ses_k",
} as const

/** The standard fixture: one of everything the importer has to handle, plus memories and side files. */
export function standardFixture(root: string) {
  const v1 = createV1Dir(root)
  const at = (seconds: number) => T0 + seconds * SECOND

  v1.session({ id: IDS.alpha, created: at(0) })
  v1.user(IDS.alpha, "msg_a1", at(1), [text("hello alpha"), file(PNG_URL, "shot.png"), text("SYNTHETIC-HIDDEN", { synthetic: true })])
  v1.assistant(IDS.alpha, "msg_a2", at(2), {
    completed: at(9),
    parts: [
      { type: "step-start" },
      { type: "reasoning", text: "thinking about alpha", time: { start: at(2), end: at(3) }, metadata: { openai: { itemId: "rs_1", reasoningEncryptedContent: "ENCRYPTED-BLOB" } } },
      tool("read", { ...done("file contents", "src/a.ts"), time: { start: at(3), end: at(4) } }, "call_read"),
      tool("bash", { status: "error", input: { command: "false" }, error: "exit code 2", time: { start: at(4), end: at(5) } }, "call_bash"),
      tool("edit", { status: "running", input: { path: "a.ts" }, time: { start: at(5) } }, "call_edit"),
      text("Done with alpha.", { time: { start: at(6), end: at(7) } }),
      { type: "patch", hash: "abc", files: ["a.ts"] },
      { type: "step-finish", reason: "stop", tokens: { total: 2, input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0 },
    ],
  })
  v1.user(IDS.alpha, "msg_a3", at(20), [text("second question")])
  v1.assistant(IDS.alpha, "msg_a4", at(21), {
    completed: at(30),
    parts: [
      tool("bash", { ...done(LONG_OUTPUT, "npm test"), time: { start: at(22), end: at(23) } }, "call_long"),
      tool("bash", { ...done(ESCAPE_HEAVY, "escapes"), time: { start: at(23), end: at(24) } }, "call_escapes"),
      text("second answer"),
    ],
  })

  v1.session({ id: IDS.compacted, created: at(100) })
  v1.user(IDS.compacted, "msg_b1", at(101), [text("early question")])
  v1.assistant(IDS.compacted, "msg_b2", at(102), { completed: at(103), parts: [text("early reply")] })
  v1.user(IDS.compacted, "msg_b3", at(104), [{ type: "compaction", auto: false, overflow: false, resume: false }])
  v1.assistant(IDS.compacted, "msg_b4", at(105), { completed: at(106), summary: true, parts: [text("SUMMARY ZERO")] })
  v1.user(IDS.compacted, "msg_b5", at(107), [text("middle question")])
  v1.assistant(IDS.compacted, "msg_b6", at(108), { completed: at(109), parts: [text("middle answer")] })
  v1.user(IDS.compacted, "msg_b7", at(110), [{ type: "compaction", auto: true, overflow: true, resume: true }])
  v1.assistant(IDS.compacted, "msg_b8", at(111), { completed: at(112), summary: true, parts: [text("SUMMARY ONE")] })
  v1.user(IDS.compacted, "msg_b9", at(113), [text("after compaction"), file(PNG_URL, "shot.png")])
  v1.assistant(IDS.compacted, "msg_b10", at(114), {
    completed: at(119),
    parts: [tool("read", { ...done("after tool", "b.ts"), time: { start: at(115), end: at(116) } }, "call_after"), text("final answer")],
  })

  v1.session({ id: IDS.aborted, created: at(150) })
  v1.user(IDS.aborted, "msg_c1", at(151), [text("cancel me")])
  v1.assistant(IDS.aborted, "msg_c2", at(152), { completed: at(153), error: { name: "MessageAbortedError", data: { message: "aborted" } }, parts: [text("partial")] })

  v1.session({ id: IDS.failed, created: at(160) })
  v1.user(IDS.failed, "msg_d1", at(161), [text("fail me")])
  v1.assistant(IDS.failed, "msg_d2", at(162), { completed: at(163), error: { name: "APIError", data: { message: "boom" } }, parts: [] })

  v1.session({ id: IDS.child, created: at(200), parent: IDS.alpha })
  v1.user(IDS.child, "msg_e1", at(201), [text("child task")])
  v1.assistant(IDS.child, "msg_e2", at(202), { completed: at(203), parts: [text("child result")] })

  v1.session({ id: IDS.empty, created: at(210) })

  v1.session({ id: IDS.archived, created: Date.UTC(2026, 1, 1), archived: true })
  v1.user(IDS.archived, "msg_g1", Date.UTC(2026, 1, 1) + SECOND, [text("old chat")])
  v1.assistant(IDS.archived, "msg_g2", Date.UTC(2026, 1, 1) + 2 * SECOND, { completed: Date.UTC(2026, 1, 1) + 3 * SECOND, parts: [text("old answer")] })

  v1.session({ id: IDS.corrupt, created: at(220) })
  v1.user(IDS.corrupt, "msg_h1", at(221), [text("corrupt one")])
  v1.assistant(IDS.corrupt, "msg_h2", at(222), { completed: at(223), parts: [text("fine part"), { raw: "{not json" }] })

  v1.session({ id: IDS.interrupted, created: Date.UTC(2026, 1, 2) })
  v1.user(IDS.interrupted, "msg_i1", Date.UTC(2026, 1, 2) + SECOND, [text("unanswered"), file("file:///tmp/notes.txt", "notes.txt", "text/plain")])

  // The child sorts before its parent by creation time: it can only be linked after the parent is imported.
  v1.session({ id: IDS.lateChild, created: at(230), parent: IDS.lateParent })
  v1.user(IDS.lateChild, "msg_j1", at(231), [text("late child")])
  v1.assistant(IDS.lateChild, "msg_j2", at(232), { completed: at(233), parts: [text("late child answer")] })
  v1.session({ id: IDS.lateParent, created: at(240) })
  v1.user(IDS.lateParent, "msg_k1", at(241), [text("late parent")])
  v1.assistant(IDS.lateParent, "msg_k2", at(242), { completed: at(243), parts: [text("late parent answer")] })

  v1.finish()
  addSideFiles(v1.dir)
  return v1.dir
}

const memory = (fields: Json) => JSON.stringify({ tags: [], categoryIDs: [], cwd: "", files: [], evidence: "", confidence: 0.9, sensitivity: "low", createdAt: "2026-01-02T00:00:00.000Z", updatedAt: "2026-01-03T00:00:00.000Z", ...fields })

export const SECRET = "SECRET-DO-NOT-READ"

/** Memory files, credentials and the directories v1 leaves behind. */
export function addSideFiles(dir: string) {
  mkdirSync(path.join(dir, "memory", "dream"), { recursive: true })
  writeFileSync(
    path.join(dir, "memory", "entries.jsonl"),
    [
      memory({ id: "m1", scope: "global", text: "Prefer Bun", categoryIDs: ["prefs"], source: "manual" }),
      memory({ id: "m2", scope: "project", text: "Use pnpm here", cwd: "/work/alpha", source: "agent", sensitivity: "medium" }),
      memory({ id: "m3", scope: "global", text: "the api key is hunter2", source: "agent", sensitivity: "high" }),
      memory({ id: "m4", scope: "global", text: "Prefer Bun", source: "agent" }),
    ].join("\n") + "\n",
  )
  writeFileSync(path.join(dir, "memory", "archived.jsonl"), `${memory({ id: "m5", scope: "global", text: "Old fact", source: "agent" })}\n`)
  writeFileSync(path.join(dir, "memory", "dream", "state.json"), "{}")
  writeFileSync(path.join(dir, "auth.json"), JSON.stringify({ token: SECRET }))
  writeFileSync(path.join(dir, "mcp-auth.json"), JSON.stringify({ token: SECRET }))
  for (const [name, bytes] of [["storage/session/a.json", 100], ["log/v1.log", 50], ["snapshot/s1", 10], ["session-transcripts/a.md", 20]] as const) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true })
    writeFileSync(path.join(dir, name), "x".repeat(bytes))
  }
  writeFileSync(path.join(dir, "other.db"), "x".repeat(30))
}

/** Every path under `dir` with a hash of its content and its size and mtime: equal before and after means untouched. */
export function fingerprint(dir: string) {
  const entries: string[] = []
  const walk = (current: string) => {
    for (const name of readdirSync(current).sort()) {
      const full = path.join(current, name)
      const stat = statSync(full)
      const relative = path.relative(dir, full)
      if (stat.isDirectory()) {
        entries.push(`${relative}/`)
        walk(full)
      } else entries.push(`${relative} ${stat.size} ${stat.mtimeMs} ${createHash("sha256").update(readFileSync(full)).digest("hex")}`)
    }
  }
  walk(dir)
  return entries
}

export function tempRoot() {
  return realpathSync(mkdtempSync(path.join(tmpdir(), "mendcode-migrate-")))
}
export function removeAll(dirs: string[]) {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
}
