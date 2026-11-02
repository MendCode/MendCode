import { afterEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createIdFactory } from "@mendcode/protocol"
import { compactProfile } from "../src/compress"
import { openStore } from "../src"

const ids = createIdFactory()
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const profile = (firstTokenMs: number | null) => ({ estimatedTokens: { instructions: 5087, memory: 0, history: 73, toolResults: 0, toolSchemas: 2939, media: 0, total: 8099 }, firstTokenMs, durationMs: 3792, toolCount: 16, imageCount: 0 })

test("a request profile is stored as its numbers and read back as the same event", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mend-profile-"))
  dirs.push(dir)
  let store = openStore({ dir })
  const sessionId = ids("session"), turnId = ids("turn")
  store.createSession({ id: sessionId, directory: "/probe", title: "p" })
  const written = [3737, null].map((first) => store.sessionSink.append({ type: "usage.recorded", sessionId, turnId, provider: "p", model: "m", input: 1, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0, profile: profile(first), compactAt: 475000 }))
  store.close()
  const db = new Database(path.join(dir, "mendd.db"), { readonly: true })
  const rows = db.query<{ payload: string }, [string]>("SELECT payload FROM events WHERE session_id = ? AND type = 'usage.recorded' ORDER BY seq").all(sessionId)
  db.close()
  expect(rows[0]!.payload).toContain('"profile":[5087,0,73,0,2939,0,8099,3737,3792,16,0]')
  expect(rows[1]!.payload).toContain('"profile":[5087,0,73,0,2939,0,8099,null,3792,16,0]')
  store = openStore({ dir })
  const read = store.readAfter(sessionId, 0, 10).filter((event): event is typeof written[number] => event.type === "usage.recorded")
  expect(read).toEqual(written)
  expect(JSON.stringify(read[0])).toBe(JSON.stringify(written[0]))
  store.close()
})

test("only the exact profile serialization is rewritten", () => {
  const odd = '{"type":"usage.recorded","profile":{"estimatedTokens":{"memory":0}}}'
  expect(compactProfile(odd, "usage.recorded")).toBe(odd)
  expect(compactProfile(JSON.stringify({ type: "item.completed", profile: profile(1) }), "item.completed")).toContain('"estimatedTokens"')
})
