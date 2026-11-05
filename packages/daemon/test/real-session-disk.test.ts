import { afterEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { ModelEvent } from "@mendcode/engine-native"
import { boot, jumpClock, openSession, until, type NativeHarness } from "./native-harness"

/**
 * The short real session of the public disk comparison, driven through the daemon with a scripted model: one prompt, one `read`
 * call with its output, one streamed answer, two usage records, a generated title. It sums every column of every row of the
 * session across all tables (the blog's metric) and breaks it down by table, so a change to what a session stores shows here
 * without a model. `MEND_DISK_REPORT=1` prints the breakdown.
 */
const PROMPT = "Read src/theme.ts and list each color name with its hex value. Do not edit any file."
const THEME = `export const palette = {\n  background: "#0b0d12",\n  surface: "#151a23",\n  accent: "#7c5cff",\n  success: "#3fbf8f",\n  warning: "#f2b84b",\n  danger: "#ff5c7a",\n};`
const ANSWER = "Colors in `src/theme.ts:1`:\n\n| Name | Hex value |\n|---|---|\n| background | `#0b0d12` |\n| surface | `#151a23` |\n| accent | `#7c5cff` |\n| success | `#3fbf8f` |\n| warning | `#f2b84b` |\n| danger | `#ff5c7a` |\n\nNo files edited."

let harness: NativeHarness | undefined
afterEach(async () => { await harness?.cleanup(); harness = undefined })

function chunks(text: string, size: number): ModelEvent[] {
  const out: ModelEvent[] = []
  for (let i = 0; i < text.length; i += size) out.push({ type: "text", delta: text.slice(i, i + size) })
  return out
}

/** Bytes of every column of every row of the session, per table (each integer counted by its decimal text, as the blog's script does). */
export function sessionBytes(db: import("bun:sqlite").Database, sessionId: string) {
  const tables = db.query<{ name: string }, []>("select name from sqlite_master where type='table'").all()
  const out: Record<string, { rows: number; bytes: number }> = {}
  let total = 0
  for (const { name } of tables) {
    const cols = db.query<{ name: string }, []>(`pragma table_info("${name}")`).all().map((c) => c.name)
    if (!cols.includes("session_id")) continue
    const expr = cols.map((c) => `coalesce(length(cast("${c}" as blob)),0)`).join("+")
    const r = db.query<{ n: number; b: number }, [string]>(`select count(*) n, coalesce(sum(${expr}),0) b from "${name}" where session_id=?`).get(sessionId)!
    if (r.n) { out[name] = { rows: r.n, bytes: r.b }; total += r.b }
  }
  const own = db.query<{ b: number }, [string]>(`select ${db.query<{ name: string }, []>("pragma table_info(sessions)").all().map((c) => `coalesce(length(cast("${c.name}" as blob)),0)`).join("+")} b from sessions where id=?`).get(sessionId)!.b
  return { tables: out, sessions: own, total: total + own }
}

export async function runShortSession() {
  const project = path.join(realpathSync(tmpdir()), `mc-demo-${process.pid}`)
  mkdirSync(path.join(project, "src"), { recursive: true })
  writeFileSync(path.join(project, "src/theme.ts"), THEME + "\n")
  const usage = (input: number, output: number, cacheRead: number): ModelEvent => ({ type: "usage", usage: { input, output, reasoning: 0, cacheRead, cacheWrite: 0 } })
  const clock = jumpClock()
  harness = await boot({
    clock,
    project,
    provider: { id: "chatgpt", model: "gpt-6-astra" },
    complete: async () => "Theme Color Hex Values",
    steps: [
      [{ type: "tool_call", call: { callId: "call_A4vKrfvbYIx3p8FLqNo8mOyn", name: "read", args: { path: "src/theme.ts" } } }, usage(6796, 23, 0), { type: "finish", reason: "tool_calls" }],
      [...chunks(ANSWER, 3), usage(267, 98, 6656), { type: "finish", reason: "stop" }],
    ],
  })
  const h = harness
  const sessionId = await openSession(h, "full")
  h.store.limitCheckpoints.track(sessionId, { provider: "codex", used: { '["codex","primary",1793887462000]': { percent: 63, at: Date.now(), burn: 0 } }, saved: [] })
  const ack = await h.client.send({ type: "user.submit", sessionId, text: PROMPT, attachments: [] })
  if (!ack.ok) throw new Error(JSON.stringify(ack))
  await until(() => h.events.some((event) => event.type === "turn.completed"))
  await new Promise((resolve) => setTimeout(resolve, 400))
  // The idle step the daemon arms when the session settles runs once the quiet period is over.
  clock.jump(60_000)
  await until(() => h.store.readAfter(sessionId, 0, 100).filter((event) => event.type === "foreground.state").length === 1)
  // The idle batch the daemon runs when nothing is working: folding, then the envelopes.
  for (let i = 0; i < 20; i++) if (h.store.foldStoredDeltas(100).complete) break
  return { harness: h, sessionId, project }
}

test("a short real session stores under its budget", async () => {
  const { harness: h, sessionId, project } = await runShortSession()
  try {
    const db = new Database(path.join(h.dir, "mendd.db"), { readonly: true })
    const result = sessionBytes(db, sessionId)
    db.close()
    if (process.env.MEND_DISK_REPORT) console.log(JSON.stringify(result, null, 1))
    // Measured 3,201 (4,880 before the settled turn sealed into one block, 6,406 before the transient snapshots, the empty
    // snapshot row and the profile numbers went); a rise means a new row or column per session.
    expect(result.total).toBeLessThan(3_300)
    // The turn is one block; only the idle state written after it stays a row until the next turn seals.
    expect(result.tables.turn_blocks!.rows).toBe(1)
    expect(result.tables.events!.rows).toBe(1)
    expect(result.tables.turn_snapshots).toBeUndefined()
  } finally { rmSync(project, { recursive: true, force: true }) }
}, 30_000)

test("a turn that changed no file keeps no snapshot row, and its changes read as an empty incomplete report", async () => {
  const { harness: h, sessionId, project } = await runShortSession()
  try {
    const db = new Database(path.join(h.dir, "mendd.db"), { readonly: true })
    expect(db.query("SELECT COUNT(*) AS n FROM turn_snapshots WHERE session_id = ?").get(sessionId)).toEqual({ n: 0 })
    db.close()
    const prompt = h.events.find((event) => event.type === "item.completed" && event.text === PROMPT)
    const reply = await h.client.send({ type: "session.changes", sessionId, ...(prompt?.type === "item.completed" ? { atItemId: prompt.itemId } : {}) })
    expect(reply).toMatchObject({ ok: true, result: { files: [], omittedFiles: 0, complete: false } })
  } finally { rmSync(project, { recursive: true, force: true }) }
}, 30_000)
