import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createAsideStore } from "../src/aside"

test("side history survives a new store, is isolated by session, and clear survives restart", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "aside-store-"))
  try {
    const a = createAsideStore(dir)
    a.set("a", { messages: [{ role: "user", text: "q" }, { role: "assistant", text: "a" }], busy: false })
    a.set("b", { messages: [{ role: "user", text: "pending" }], busy: true })
    const b = createAsideStore(dir)
    expect(b.get("a")).toEqual(a.get("a"))
    expect(b.get("b")).toMatchObject({ busy: false, error: "Side chat interrupted by daemon restart" })
    b.set("a", { messages: [], busy: false })
    expect(createAsideStore(dir).get("a")).toEqual({ messages: [], busy: false })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
