import { describe, expect, test } from "bun:test"
import { createIdFactory } from "@mendcode/protocol"
import { createApp } from "../src/ui/app"
import { glyphs, type Line } from "../src/ui/theme"
import type { MentionEntry } from "../src/view/mentions"

const ids = createIdFactory()

const FILES: MentionEntry[] = [
  { path: "src/app.ts", kind: "file" },
  { path: "src/view", kind: "dir" },
  { path: "README.md", kind: "file" },
]

/** Settles the fire-and-forget `files.search` chain (never awaited by onKey — it must not block a keystroke). */
const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function harness() {
  const frames: Line[][] = []
  const sent: Array<Record<string, unknown>> = []
  const screen = {
    size: { width: 80, height: 20 },
    draw: (rows: Line[]) => void frames.push(rows),
  } as unknown as Parameters<typeof createApp>[0]["screen"]
  const send = async (command: unknown) => {
    const c = command as Record<string, unknown>
    sent.push(c)
    if (c.type === "files.search") {
      const query = String(c.query ?? "").toLowerCase()
      const files = query ? FILES.filter((f) => f.path.toLowerCase().includes(query)) : FILES
      return { ok: true, result: { files } }
    }
    return { ok: true }
  }
  const app = createApp({ sessionId: ids("session"), screen, send: send as never, exit() {}, schedule: (fn) => fn(), glyphs: glyphs({}), directory: "/proj" })
  const text = () => frames.at(-1)!.map((row) => row.map((s) => s.text).join(""))
  return { app, text, sent }
}

async function type(app: ReturnType<typeof createApp>, text: string) {
  for (const ch of text) await app.onKey(ch)
}

describe("@ mention picker in the app", () => {
  test("typing @ queries files.search under the project directory and shows matches", async () => {
    const { app, text, sent } = harness()
    await type(app, "look at @src")
    await flush()
    expect(sent.some((c) => c.type === "files.search" && c.directory === "/proj")).toBe(true)
    expect(text().some((line) => line.includes("@src/app.ts"))).toBe(true)
    expect(app.editor.text).toBe("look at @src")
  })

  test("tab completes @path and a trailing space, keeping the rest of the line", async () => {
    const { app } = harness()
    await type(app, "look at @src")
    await flush()
    await app.onKey("\t")
    expect(app.editor.text).toBe("look at @src/app.ts ")
  })

  test("enter also completes the mention (it does not submit the prompt)", async () => {
    const { app, sent } = harness()
    await type(app, "@src")
    await flush()
    await app.onKey("\r")
    expect(app.editor.text).toBe("@src/app.ts ")
    expect(sent.some((c) => c.type === "user.submit")).toBe(false)
  })

  test("esc closes the popup and leaves the typed text untouched", async () => {
    const { app, text } = harness()
    await type(app, "@src")
    await flush()
    expect(text().some((line) => line.includes("@src/app.ts"))).toBe(true)
    await app.onKey("\x1b")
    expect(text().some((line) => line.includes("@src/app.ts"))).toBe(false)
    expect(app.editor.text).toBe("@src")
  })

  test("arrow keys move the selection; a click on a suggestion completes it", async () => {
    const { app, text } = harness()
    await type(app, "@src")
    await flush()
    const row = text().findIndex((line) => line.includes("@src/view/"))
    expect(row).toBeGreaterThanOrEqual(0)
    await app.onKey(`\x1b[<0;1;${row + 1}M`)
    expect(app.editor.text).toBe("@src/view ")
  })

  test("a mention with no matches shows no popup and @../escape is never sent through the picker's completion", async () => {
    const { app, text } = harness()
    await type(app, "@nomatch")
    await flush()
    expect(text().every((line) => !line.includes("@nomatch/"))).toBe(true)
  })
})
