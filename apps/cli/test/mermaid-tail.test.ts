import { afterAll, describe, expect, test } from "bun:test"
import path from "node:path"
import type { EventsWindow, SessionEvent } from "@mendcode/protocol"
import type { WindowReply } from "@mendcode/client"
import { ensureMermaid } from "../src/view/mermaid-lazy"
import { renderMermaid } from "../src/view/mermaid"
import { appHarness, cleanTemps, conversation, ids, plain } from "./session-ui-harness"

afterAll(cleanTemps)

const cli = path.join(import.meta.dir, "..")
const SEQUENCE = "```mermaid\nsequenceDiagram\n participant T as Tú\n participant C as Chat\n T->>C: Envías Markdown\n C-->>T: Lo muestra con formato\n```"
const FLOWCHART = "```mermaid\nflowchart TD\n A[Inicio] --> B[Fin]\n```"
const longText = Array.from({ length: 30 }, (_, n) => `linea ${n}`).join("\n\n")

function textOf(source: string, width = 80) {
  const result = renderMermaid(source, width)
  if (!("lines" in result)) throw new Error(result.note)
  return result.lines.map(plain)
}

async function loaded() {
  ensureMermaid()
  await Bun.sleep(100)
}

function window(events: SessionEvent[]): WindowReply {
  return { ok: true, window: { events, firstSeq: events[0]?.seq ?? 0, lastSeq: events.at(-1)?.seq ?? 0, sessionLastSeq: events.at(-1)?.seq ?? 0, more: false } satisfies EventsWindow }
}

function session(answer: string) {
  const sessionId = ids("session")
  const events: SessionEvent[] = []
  const chat = conversation(sessionId, (event) => events.push(event))
  chat.exchange("hola", answer)
  return { sessionId, events, chat }
}

/** Rows of the transcript body that sit between the top of the screen and the prompt's first rule. */
function bodyRows(rows: string[]) {
  const rule = rows.findIndex((row) => /─{30,}/.test(row))
  return rows.slice(0, rule < 0 ? rows.length : rule)
}
const lastContent = (rows: string[]) => bodyRows(rows).map((row) => row.trimEnd()).filter(Boolean).at(-1) ?? ""

describe("sequence diagrams mirror their participants below the last message", () => {
  test("the lifelines end in a second row of boxes, like mermaid's mirrorActors default", () => {
    const rows = textOf("sequenceDiagram\n participant T as Tú\n participant C as Chat\n T->>C: Envías Markdown\n C-->>T: Lo muestra con formato")
    expect(rows.filter((row) => row.includes("│ Tú │"))).toHaveLength(2)
    expect(rows.filter((row) => row.includes("│ Chat │"))).toHaveLength(2)
    expect(rows.at(-1)).toMatch(/^└─+┘\s+└─+┘$/)
    expect(rows.at(-3)).toMatch(/^┌─*┴─*┐\s+┌─*┴─*┐$/)
    expect(rows.at(-4)).toContain("┆")
    expect(rows.at(-2)).toContain("│ Tú │")
  })

  test("mirrorActors: false in an init directive or front matter keeps the single top row", () => {
    const body = "sequenceDiagram\n participant T as Tú\n participant C as Chat\n T->>C: Envías Markdown"
    for (const source of [`%%{init: {"sequence": {"mirrorActors": false}}}%%\n${body}`, `---\nconfig:\n  sequence:\n    mirrorActors: false\n---\n${body}`]) {
      const rows = textOf(source)
      expect(rows.filter((row) => row.includes("│ Tú │"))).toHaveLength(1)
      expect(rows.at(-1)).toContain("├")
    }
    expect(textOf(`%%{init: {"sequence": {"mirrorActors": true}}}%%\n${body}`).filter((row) => row.includes("│ Tú │"))).toHaveLength(2)
  })

  test("activations, notes and blocks still render inside a mirrored diagram and the output stays within the width", () => {
    const rows = textOf("sequenceDiagram\n participant A\n participant B\n loop cada minuto\n A->>+B: ping\n Note over A,B: espera\n B-->>-A: pong\n end", 60)
    expect(rows.some((row) => row.includes("loop"))).toBe(true)
    expect(rows.some((row) => row.includes("espera"))).toBe(true)
    expect(rows.filter((row) => row.includes("│ A │"))).toHaveLength(2)
    for (const row of rows) expect([...row].length).toBeLessThanOrEqual(60)
  })
})

describe("the transcript ends on the last row of a lazily rendered diagram", () => {
  test("resuming a session whose last answer ends with a sequence diagram shows the mirrored boxes right above the prompt", async () => {
    await loaded()
    const { sessionId, events } = session(`${longText}\n\n${SEQUENCE}`)
    const h = appHarness({ sessionId, width: 100, height: 24, mode: "minimal", events: { loadWindow: async () => window(events), loadBefore: async () => window([]) } })
    await h.app.start()
    expect(lastContent(h.text())).toMatch(/└─+┘\s+└─+┘/)
    expect(h.text().join("\n")).toContain("Lo muestra con formato")
    const before = h.text()
    await h.app.onKey("\x1b[F")
    await h.app.onKey("\x1b[<65;10;5M")
    expect(h.text()).toEqual(before)
  })

  test("a session whose last answer ends with a flowchart shows its last box above the prompt", async () => {
    await loaded()
    const { sessionId, events } = session(`${longText}\n\n${FLOWCHART}`)
    const h = appHarness({ sessionId, width: 100, height: 24, mode: "minimal", events: { loadWindow: async () => window(events), loadBefore: async () => window([]) } })
    await h.app.start()
    expect(lastContent(h.text())).toContain("└")
    expect(h.text().join("\n")).toContain("Fin")
  })

  test("a live answer that finishes with a diagram keeps its last row visible, and switching sessions opens cleanly", async () => {
    await loaded()
    const first = session("respuesta inicial")
    const other = session("otra sesion")
    const h = appHarness({
      sessionId: first.sessionId,
      width: 100,
      height: 24,
      mode: "minimal",
      reply: (command) => command.type === "session.create" ? { ok: true, result: { sessionId: other.sessionId } } : undefined,
      events: { loadWindow: async (id) => window(id === first.sessionId ? first.events : other.events), loadBefore: async () => window([]) },
    })
    await h.app.start()
    const next = first.events.length
    first.chat.exchange("dibuja", `${longText}\n\n${SEQUENCE}`)
    for (const event of first.events.slice(next)) h.app.onEvent(event)
    h.app.render()
    expect(lastContent(h.text())).toMatch(/└─+┘\s+└─+┘/)
    await h.type("/new\r")
    expect(h.app.sessionId).toBe(other.sessionId)
    expect(h.text().join("\n")).toContain("otra sesion")
  })
})

describe("line counts follow the diagram module's lazy load", () => {
  test("the layout totals include the real diagram once it replaces the placeholder (fresh process)", () => {
    const script = `const { conversation, ids } = await import("./test/session-ui-harness.ts")
const { createTranscript } = await import("./src/view/transcript.ts")
const transcript = createTranscript({})
const chat = conversation(ids("session"), (event) => transcript.apply(event))
chat.exchange("hola", ${JSON.stringify(`intro\n\n${SEQUENCE}`)})
const placeholder = transcript.totalLines(80)
await new Promise((resolve) => setTimeout(resolve, 150))
const total = transcript.totalLines(80)
const shown = transcript.viewport(80, 10000, 0).length
const top = transcript.viewport(80, 4, Math.max(0, total - 4)).map((line) => line.text)
console.log(JSON.stringify({ placeholder, total, shown, top }))`
    const result = Bun.spawnSync(["bun", "-e", script], { cwd: cli, stdout: "pipe", stderr: "pipe" })
    expect(result.stderr.toString()).toBe("")
    const { placeholder, total, shown, top } = JSON.parse(result.stdout.toString().trim()) as { placeholder: number; total: number; shown: number; top: string[] }
    expect(shown).toBeGreaterThan(placeholder)
    expect(total).toBe(shown)
    expect(top.join("\n")).toContain("hola")
  })
})
