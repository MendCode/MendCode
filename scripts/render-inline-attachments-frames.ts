import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { cleanTemps, conversation, plain } from "../apps/cli/test/session-ui-harness"
import { bench, paste, type Bench } from "../apps/cli/test/inline-attachments-helpers"
import { activeTheme, sgr, type Line, type Span } from "../apps/cli/src/ui/theme"
import type { TuiProfile } from "../apps/cli/src/view/tui-profile"

/**
 * The inline attachment frames: every one is a screen of the real wired app (appHarness: createApp, the real editor, prompt and
 * transcript; the daemon is the bench's fake that resolves a few paths). Usage: `bun scripts/render-inline-attachments-frames.ts [directory]`.
 * Writes, for each scene, `<name>.txt` and `<name>.ansi` (the dark theme, `mend`) and `<name>.roles.txt`: every span of the frame tagged
 * with its theme role and attributes, for the dark theme and then the light one (`paper`), with the color each role has in it.
 * `PREVIEW.txt` is the owner's sentence.
 */
const target = process.argv[2] ?? path.join(import.meta.dir, "../.agents/runs/frames/inline-attachments")
mkdirSync(target, { recursive: true })

const THEMES = [{ label: "dark", name: "mend" }, { label: "light", name: "paper" }] as const
const SHOT = "/shots/one.png"
const SHOT2 = "/shots/two.png"
const PDF = "/docs/design-spec.pdf"
const NOTES = "/docs/notes.txt"
const FOLDER = "/repos/codeconfig"
const SENTENCE = "configura mi mend de mi pc que tenga un package de seda 9.7 de "

function tag(span: Span): string {
  const parts = [`fg=${span.fg ?? span.fgHex ?? "(terminal)"}`]
  if (span.bg || span.bgHex) parts.push(`bg=${span.bg ?? span.bgHex}`)
  for (const attribute of ["bold", "dim", "italic", "underline", "strike"] as const) if (span[attribute]) parts.push(attribute)
  if (span.link) parts.push("link")
  return parts.join(" ")
}

/** The rows that matter: from the first non-empty row to the last, every span tagged; a run of padding told by its length. */
function rolesOf(lines: Line[]): string[] {
  return lines.map((line, row) => {
    const merged: Span[] = []
    for (const span of line) {
      const last = merged.at(-1)
      if (last && tag(last) === tag(span)) last.text += span.text
      else merged.push({ ...span })
    }
    const shown = (text: string) => JSON.stringify(text.replace(/ {4,}/g, (run) => `<${run.length} spaces>`))
    return `${String(row).padStart(2)}| ${merged.filter((span) => span.text !== "").map((span) => `[${tag(span)}] ${shown(span.text)}`).join(" ")}`
  })
}

const roleTable = () => Object.entries(activeTheme().colors as Record<string, string>).map(([role, hex]) => `  ${role.padEnd(12)} ${hex}`)

type Act = (b: Bench) => Promise<void>

async function scene(name: string, setup: { width?: number; height?: number; profile?: Partial<TuiProfile> }, act: Act): Promise<string[]> {
  const sections: string[] = []
  let text: string[] = []
  for (const theme of THEMES) {
    const b = bench({ width: setup.width ?? 100, height: setup.height ?? 30, profile: { ...setup.profile, theme: theme.name } })
    await act(b)
    b.h.app.render()
    const lines = b.h.frames.at(-1) ?? []
    sections.push(`== ${theme.label} (${theme.name}) ==`, ...rolesOf(lines), "", `roles in ${theme.name}:`, ...roleTable(), "")
    if (theme.label === "dark") {
      text = lines.map(plain)
      writeFileSync(path.join(target, `${name}.txt`), text.join("\n") + "\n")
      writeFileSync(path.join(target, `${name}.ansi`), lines.map((line) => line.map((span) => sgr(span, "truecolor") + span.text + "\x1b[0m").join("")).join("\n") + "\n")
      console.log(`${name}: ${text.length} rows`)
    }
  }
  writeFileSync(path.join(target, `${name}.roles.txt`), sections.join("\n") + "\n")
  return text
}

const owner: Act = async (b) => {
  await b.type(SENTENCE)
  await b.type(paste(SHOT))
  await b.type(paste(FOLDER))
}

// Before: the chip row over the prompt, nothing in the text (the `above` setting is the behaviour before tokens).
await scene("before-above-chips", { profile: { attachmentChips: "above" } }, async (b) => {
  await b.type(SENTENCE)
  await b.type(paste(SHOT))
})
// The owner's exact sentence with an image and a folder pasted at the end.
const preview = await scene("owner-sentence", {}, owner)
// A token in the middle of a sentence, pasted with the cursor between two words.
await scene("mid-sentence", {}, async (b) => {
  await b.type("compara esto con aquello y dime cual es mejor")
  for (let n = 0; n < "con aquello y dime cual es mejor".length + 1; n++) await b.type("\x1b[D")
  await b.type(paste(SHOT))
})
// Sixty columns of prompt: a long sentence with three tokens, none of them cut.
await scene("wrap-60", { width: 66 }, async (b) => {
  await b.type("configura mi mend de mi pc que tenga un package de seda 9.7 de ")
  await b.type(paste(SHOT))
  await b.type(paste(PDF))
  await b.type("y luego revisa ")
  await b.type(paste(FOLDER))
  await b.type("antes de seguir")
})
// Several tokens of every kind in a row.
await scene("several-tokens", {}, async (b) => {
  await b.type("compara ")
  await b.type(paste(`${SHOT}\n${SHOT2}\n${PDF}\n${NOTES}\n${FOLDER}`))
})
// The sent message in the transcript: submit, then the daemon reports the message as it stored it.
await scene("sent-in-transcript", {}, async (b) => {
  await owner(b)
  await b.type("y dime que falta")
  await b.type("\r")
  const sent = b.submitted()!
  const chat = conversation(b.h.sessionId, (event) => b.h.app.onEvent(event))
  chat.emit({ type: "turn.started", turnId: "turn_1", queueId: "queue_1" })
  chat.emit({ type: "item.started", turnId: "turn_1", itemId: "item_u1", kind: "user_message" })
  chat.emit({ type: "item.completed", itemId: "item_u1", status: "ok", text: sent.text, attachments: sent.attachments })
  chat.emit({ type: "item.started", turnId: "turn_1", itemId: "item_a1", kind: "agent_message" })
  chat.emit({ type: "item.completed", itemId: "item_a1", status: "ok", text: "Veo la captura y la carpeta; sigo con el paquete." })
  chat.emit({ type: "turn.completed", turnId: "turn_1" })
})
await scene("above-setting", { profile: { attachmentChips: "above" } }, owner)
await scene("both-setting", { profile: { attachmentChips: "both" } }, owner)

writeFileSync(path.join(target, "PREVIEW.txt"), preview.join("\n") + "\n")
cleanTemps()
