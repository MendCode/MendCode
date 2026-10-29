import type { CommandInput, CommandReply } from "@mendcode/client"
import { appHarness, tempDir, type Harness } from "./session-ui-harness"
import { DEFAULT_TUI_PROFILE, writeTuiProfile, type TuiProfile } from "../src/view/tui-profile"

/**
 * The bench for inline attachment tokens: the wired app with a fake daemon that resolves a handful of paths (an image, a PDF, a text
 * file, a folder) and the clipboard image, and keeps every command the terminal sent. Shared by the tests and by
 * `scripts/render-inline-attachments-frames.ts`, so a frame is a screen of the real app.
 */

export const PASTE_START = "\x1b[200~"
export const PASTE_END = "\x1b[201~"
export const paste = (text: string) => `${PASTE_START}${text}${PASTE_END}`

const sha = (seed: string) => seed.repeat(64).slice(0, 64)
/** The blob refs the fake daemon hands out, by path. */
export const FILES: Record<string, Record<string, unknown>> = {
  "/shots/one.png": { kind: "image", attachment: { sha256: sha("1"), bytes: 315_187, mime: "image/png" }, name: "one.png", width: 1262, height: 540 },
  "/shots/two.png": { kind: "image", attachment: { sha256: sha("2"), bytes: 98_304, mime: "image/png" }, name: "two.png", width: 800, height: 600 },
  "/docs/design-spec.pdf": { kind: "document", attachment: { sha256: sha("3"), bytes: 2_048_000, mime: "application/pdf" }, name: "design-spec.pdf" },
  "/docs/notes.txt": { kind: "text", name: "notes.txt", content: "line one\nline two" },
  "/repos/codeconfig": { kind: "text", name: "codeconfig", content: "<path>/repos/codeconfig</path>\n<type>directory</type>\n<entries>\nAGENTS.md\nclaude/\ncodex/\n</entries>\n(3 of 3 entries)", directory: true },
}

export type BenchOptions = {
  width?: number
  height?: number
  profile?: Partial<TuiProfile>
  /** Extra answers for the fake daemon; `undefined` falls through to the bench's own. */
  reply?: (command: CommandInput) => CommandReply | undefined
  mode?: "minimal" | "balanced" | "full"
}

export function bench(options: BenchOptions = {}) {
  let clipboard = 0
  const dataDir = tempDir()
  writeTuiProfile(dataDir, { ...DEFAULT_TUI_PROFILE, ...options.profile })
  const h = appHarness({
    dataDir,
    width: options.width ?? 100,
    height: options.height ?? 30,
    ...(options.mode ? { mode: options.mode } : {}),
    reply: (command) => {
      const own = options.reply?.(command)
      if (own) return own
      if (command.type === "attachment.paste") {
        const found = FILES[String(command.path).replace(/^['"]|['"]$/g, "")]
        return found ? { ok: true, result: found } as CommandReply : { ok: false, error: { code: "invalid_command", message: `[ATTACHMENT]: not a file or directory: ${command.path}` } } as CommandReply
      }
      if (command.type === "attachment.clipboard") {
        clipboard++
        return { ok: true, result: { attachment: { sha256: sha(String(clipboard + 3)), bytes: 20_480, mime: "image/png" }, name: "clipboard.png", width: 640, height: 480 } } as CommandReply
      }
      return undefined
    },
  })
  h.app.applySettings({ onboarded: true, tier: "balanced", reducedMotion: true })
  h.app.render()
  const prompt = () => {
    const rows = h.text()
    const first = rows.findIndex((row) => row.includes("❭"))
    if (first < 0) return ""
    const last = rows.findIndex((row, index) => index > first && /^\s*[─━-]{10,}/.test(row))
    return rows.slice(first, last < 0 ? first + 1 : last).map((row) => row.trimEnd()).join("\n")
  }
  return {
    h,
    dataDir,
    /** What a terminal does when it opens: the saved draft comes back into an empty prompt. */
    start: async () => {
      await h.app.start()
      await Bun.sleep(5)
      h.app.render()
    },
    /** The editor's text, exactly (the drawn prompt trims the end of its rows). */
    get text() { return h.app.editor.text },
    /** Terminal input (text, keys, a paste), then a frame. */
    type: (input: string) => h.type(input),
    /** The prompt's rows as drawn: from the lead row down to the rule that closes it. */
    prompt,
    /** The last user.submit the terminal sent. */
    submitted: () => h.sentOf("user.submit").at(-1) as (CommandInput & { text: string; attachments: Array<Record<string, unknown>> }) | undefined,
  }
}
export type Bench = ReturnType<typeof bench>
export type { Harness }
