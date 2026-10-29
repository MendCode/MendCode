import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createIdFactory } from "@mendcode/protocol"
import { openStore } from "../src"

test("legacy model rows migrate, variants and parameters survive reopening, and reset clears all options", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mend-model-options-"))
  let store = openStore({ dir })
  try {
    const sessionId = createIdFactory()("session")
    store.createSession({ id: sessionId, directory: dir, title: "Legacy" })
    store.setSessionModel(sessionId, { model: "test", effort: "high" })
    store.close()
    const raw = new Database(path.join(dir, "mendd.db"))
    raw.run("ALTER TABLE sessions DROP COLUMN model_options")
    raw.close()
    store = openStore({ dir })
    expect(store.sessionModel(sessionId)).toEqual({ model: "test", effort: "high" })
    const choice = { model: "test", variant: "precise", parameters: { temperature: 0 } }
    store.setSessionModel(sessionId, choice)
    store.close()
    store = openStore({ dir })
    expect(store.sessionModel(sessionId)).toEqual(choice)
    store.setSessionModel(sessionId, { model: "test" })
    expect(store.sessionModel(sessionId)).toEqual({ model: "test" })
    store.setSessionModel(sessionId, undefined)
    expect(store.sessionModel(sessionId)).toBeUndefined()
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
