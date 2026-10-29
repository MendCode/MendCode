import { describe, expect, test } from "bun:test"
import { createIdFactory } from "@mendcode/protocol"
import { createApp } from "../src/ui/app"
import { glyphs, type Line } from "../src/ui/theme"
import { DEFAULT_TUI_PROFILE } from "../src/view/tui-profile"

const ids = createIdFactory()
const PASTE_START = "\x1b[200~"
const PASTE_END = "\x1b[201~"
const paste = (text: string) => `${PASTE_START}${text}${PASTE_END}`

function blobRef(bytes: number, mime = "image/png") {
  return { sha256: "a".repeat(64), bytes, mime }
}

/** These tests are about the chip row over the prompt, the `above` setting; inline tokens have their own file (inline-attachments.test.ts). */
async function harness(opts: { directory?: string; mode?: "minimal" | "balanced" | "full"; send?(command: Record<string, unknown>): Promise<Record<string, unknown>> } = {}) {
  const sent: Array<Record<string, unknown>> = []
  const frames: Line[][] = []
  const screen = { size: { width: 100, height: 24 }, draw: (rows: Line[]) => void frames.push(rows) } as unknown as Parameters<typeof createApp>[0]["screen"]
  const app = createApp({
    sessionId: ids("session"),
    screen,
    directory: opts.directory ?? "/work/project",
    mode: opts.mode ?? "balanced",
    profile: { ...DEFAULT_TUI_PROFILE, attachmentChips: "above" },
    send: async (command: Record<string, unknown>) => {
      sent.push(command)
      if (opts.send) return opts.send(command)
      return { ok: true }
    },
    exit() {},
    schedule: (fn: () => void) => fn(),
    glyphs: glyphs({}),
    now: () => 1_800_000_000_000,
  } as never)
  const text = () => frames.at(-1)!.map((row) => row.map((s) => s.text).join(""))
  return { app, sent, text }
}

describe("clipboard paste (Ctrl+V)", () => {
  test("Ctrl+V with an image on the clipboard adds a chip", async () => {
    const { app, sent, text } = await harness({
      send: async (command) => (command.type === "attachment.clipboard" ? { ok: true, result: { attachment: blobRef(245_760), name: "clipboard.png" } } : { ok: true }),
    })
    await app.onKey("\x16")
    expect(sent.some((c) => c.type === "attachment.clipboard")).toBe(true)
    expect(text().some((line) => line.includes("[Image #1 · 240 KB]"))).toBe(true)
  })

  test("empty bracketed paste does not read the clipboard; explicit Ctrl+V adds a sized chip and backspace removes it", async () => {
    const { app, sent, text } = await harness({
      send: async (command) => (command.type === "attachment.clipboard" ? { ok: true, result: { attachment: blobRef(319_488), name: "clipboard.png", width: 1440, height: 900 } } : { ok: true }),
    })
    await app.onInput(paste(""))
    expect(sent.filter((c) => c.type === "attachment.clipboard")).toEqual([])
    await app.onKey("\x16")
    expect(sent.filter((c) => c.type === "attachment.clipboard")).toEqual([expect.objectContaining({ text: true })])
    expect(text().some((line) => line.includes("[Image #1 · 1440×900 · 312 KB]"))).toBe(true)
    await app.onKey("\x7f")
    expect(text().some((line) => line.includes("[Image #1"))).toBe(false)
  })

  test("an image chip is sent as an attachment on submit, with the typed text", async () => {
    const { app, sent } = await harness({
      send: async (command) => (command.type === "attachment.clipboard" ? { ok: true, result: { attachment: blobRef(2048), name: "clipboard.png" } } : { ok: true }),
    })
    await app.onKey("\x16")
    await app.onKey("h")
    await app.onKey("\r")
    expect(sent.find((c) => c.type === "user.submit")).toMatchObject({ text: "h", attachments: [{ mime: "image/png", bytes: 2048, name: "clipboard.png" }] })
  })

  test("a failed submit (a model without vision) keeps the chip so the user can remove it", async () => {
    const { app, text } = await harness({
      send: async (command) => {
        if (command.type === "attachment.clipboard") return { ok: true, result: { attachment: blobRef(2048), name: "clipboard.png" } }
        if (command.type === "user.submit") return { ok: false, error: { code: "invalid_command", message: "[DAEMON]: Text Only does not accept images; pick a vision model or remove the image" } }
        return { ok: true }
      },
    })
    await app.onKey("\x16")
    await app.onKey("h")
    await app.onKey("\r")
    expect(text().some((line) => line.includes("does not accept images"))).toBe(true)
    expect(text().some((line) => line.includes("[Image #1"))).toBe(true)
  })

  test("Ctrl+V with nothing on the clipboard shows the daemon's error as a notice, no chip", async () => {
    const { app, text } = await harness({
      send: async (command) => (command.type === "attachment.clipboard" ? { ok: false, error: { code: "invalid_command", message: "[ATTACHMENT]: no image in the clipboard" } } : { ok: true }),
    })
    await app.onKey("\x16")
    expect(text().some((line) => line.includes("no image in the clipboard"))).toBe(true)
    expect(text().some((line) => line.includes("■"))).toBe(false)
  })

  test("a plain bracketed paste of text is unaffected: it is inserted, not treated as Ctrl+V", async () => {
    const { app, sent, text } = await harness()
    await app.onInput(paste("hola mundo"))
    expect(sent.some((c) => c.type === "attachment.clipboard")).toBe(false)
    expect(text().some((line) => line.includes("hola mundo"))).toBe(true)
  })
})

describe("pasting or dropping local paths", () => {
  test("a PDF gets a named chip, submits its ref, and backspace can remove it", async () => {
    const { app, sent, text } = await harness({ send: async (c) => c.type === "attachment.paste" ? { ok: true, result: { kind: "document", attachment: blobRef(2048, "application/pdf"), name: "design.pdf" } } : { ok: true } })
    await app.onInput(paste("/tmp/design.pdf"))
    expect(text().some((row) => row.includes("■ design.pdf · 2 KB"))).toBe(true)
    await app.onKey("\x7f")
    expect(text().some((row) => row.includes("■ design.pdf"))).toBe(false)
    await app.onInput(paste("/tmp/design.pdf"))
    await app.onKey("r")
    await app.onKey("\r")
    expect(sent.find((c) => c.type === "user.submit")).toMatchObject({ text: "r", attachments: [{ mime: "application/pdf", name: "design.pdf", bytes: 2048 }] })
  })

  test("directory mentions with spaces are quoted and remain prompt text", async () => {
    const { app, sent, text } = await harness({ send: async (c) => c.type === "attachment.paste" ? { ok: true, result: { kind: "mention", path: "design notes" } } : { ok: true } })
    await app.onInput(paste('"/work/project/design notes"'))
    expect(text().some((row) => row.includes('@"design notes"'))).toBe(true)
    await app.onKey("\r")
    expect(sent.find((c) => c.type === "user.submit")).toMatchObject({ text: '@"design notes"' })
  })
  test("a bracketed paste that is a single image path attaches it instead of inserting text", async () => {
    const { app, sent, text } = await harness({
      send: async (command) => (command.type === "attachment.paste" ? { ok: true, result: { kind: "image", attachment: blobRef(1024), name: "shot.png" } } : { ok: true }),
    })
    await app.onInput(paste("/tmp/shot.png"))
    expect(sent.find((c) => c.type === "attachment.paste")).toMatchObject({ path: "/tmp/shot.png", directory: "/work/project" })
    expect(text().some((line) => line.includes("[Image #1 · 1 KB]"))).toBe(true)
    expect(text().some((line) => line.includes("/tmp/shot.png"))).toBe(false)
  })

  test("a quoted drag-and-drop path with a size shows the sized chip", async () => {
    const { app, sent, text } = await harness({
      send: async (command) => (command.type === "attachment.paste" ? { ok: true, result: { kind: "image", attachment: blobRef(319_488), name: "shot.png", width: 1440, height: 900 } } : { ok: true }),
    })
    await app.onInput(paste("'/Users/me/Desktop/Screen Shot.png'"))
    expect(sent.find((c) => c.type === "attachment.paste")).toMatchObject({ path: "'/Users/me/Desktop/Screen Shot.png'" })
    expect(text().some((line) => line.includes("[Image #1 · 1440×900 · 312 KB]"))).toBe(true)
  })

  test("several path lines paste as several attachments, none inserted as text", async () => {
    const { app, sent, text } = await harness({
      send: async (command) => {
        if (command.type !== "attachment.paste") return { ok: true }
        return command.path === "/tmp/a.png" ? { ok: true, result: { kind: "image", attachment: blobRef(512), name: "a.png" } } : { ok: true, result: { kind: "text", name: "b.txt", content: "hola" } }
      },
    })
    await app.onInput(paste("/tmp/a.png\n/tmp/b.txt"))
    expect(sent.filter((c) => c.type === "attachment.paste")).toHaveLength(2)
    expect(text().some((line) => line.includes("[Image #1 · 512 B]"))).toBe(true)
    expect(text().some((line) => line.includes("■ b.txt"))).toBe(true)
  })

  test("a project file resolves to an @mention inserted into the prompt, not a chip", async () => {
    const { app, text } = await harness({
      send: async (command) => (command.type === "attachment.paste" ? { ok: true, result: { kind: "mention", path: "src/index.ts" } } : { ok: true }),
    })
    await app.onInput(paste("/work/project/src/index.ts"))
    expect(text().some((line) => line.includes("@src/index.ts"))).toBe(true)
    expect(text().some((line) => line.includes("■"))).toBe(false)
  })

  test("a small text file outside the project becomes a chip labeled by its name", async () => {
    const { app, text } = await harness({
      send: async (command) => (command.type === "attachment.paste" ? { ok: true, result: { kind: "text", name: "notes.txt", content: "hola" } } : { ok: true }),
    })
    await app.onInput(paste("/elsewhere/notes.txt"))
    expect(text().some((line) => line.includes("■ notes.txt"))).toBe(true)
  })

  test("a path that fails resolution falls back to inserting that line as text", async () => {
    const { app, text } = await harness({
      send: async (command) => (command.type === "attachment.paste" ? { ok: false, error: { code: "invalid_command", message: "[ATTACHMENT]: not a file: /tmp/missing.png" } } : { ok: true }),
    })
    await app.onInput(paste("/tmp/missing.png"))
    expect(text().some((line) => line.includes("/tmp/missing.png"))).toBe(true)
    expect(text().some((line) => line.includes("■"))).toBe(false)
  })

  test("prose that merely starts with a slash is inserted as typed text, not resolved as a path", async () => {
    const { app, sent, text } = await harness()
    await app.onInput(paste("look at /etc/passwd for the format"))
    expect(sent.some((c) => c.type === "attachment.paste")).toBe(false)
    expect(text().some((line) => line.includes("look at /etc/passwd for the format"))).toBe(true)
  })
})

describe("/attach", () => {
  test("/attach <path> resolves and attaches exactly like a paste", async () => {
    const { app, sent, text } = await harness({
      send: async (command) => (command.type === "attachment.paste" ? { ok: true, result: { kind: "image", attachment: blobRef(2048), name: "diagram.png" } } : { ok: true }),
    })
    for (const key of "/attach /tmp/diagram.png") await app.onKey(key)
    await app.onKey("\r")
    expect(sent.find((c) => c.type === "attachment.paste")).toMatchObject({ path: "/tmp/diagram.png" })
    expect(text().some((line) => line.includes("[Image #1 · 2 KB]"))).toBe(true)
  })

  test("/attach with no argument asks for one instead of calling the daemon", async () => {
    const { app, sent, text } = await harness()
    for (const key of "/attach") await app.onKey(key)
    await app.onKey("\r")
    expect(sent.some((c) => c.type === "attachment.paste")).toBe(false)
    expect(text().some((line) => line.includes("usage: /attach <path>"))).toBe(true)
  })
})

describe("chips", () => {
  test("backspace on an empty prompt removes the last chip only", async () => {
    const { app, text } = await harness({
      send: async (command) => (command.type === "attachment.clipboard" ? { ok: true, result: { attachment: blobRef(1024), name: "clipboard.png" } } : { ok: true }),
    })
    await app.onKey("\x16")
    await app.onKey("\x16")
    expect(text().filter((line) => line.includes("[Image #")).length).toBeGreaterThan(0)
    await app.onKey("\x7f")
    const afterOne = text().find((line) => line.includes("#2"))
    expect(afterOne).toBeUndefined()
    expect(text().some((line) => line.includes("[Image #1"))).toBe(true)
  })

  test("backspace with text still in the prompt edits the text instead of removing a chip", async () => {
    const { app, text } = await harness({
      send: async (command) => (command.type === "attachment.clipboard" ? { ok: true, result: { attachment: blobRef(1024), name: "clipboard.png" } } : { ok: true }),
    })
    await app.onKey("\x16")
    await app.onKey("h")
    await app.onKey("\x7f")
    expect(text().some((line) => line.includes("[Image #1"))).toBe(true)
  })

  test('v1 has no "ctrl+v image" hint, so no view shows one', async () => {
    for (const mode of ["minimal", "balanced", "full"] as const) {
      const view = await harness({ mode })
      await view.app.onKey("x")
      expect(view.text().some((line) => line.includes("ctrl+v image"))).toBe(false)
    }
  })
})
