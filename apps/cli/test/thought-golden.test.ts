import { describe, expect, test } from "bun:test"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { createIdFactory, type SessionEvent } from "@mendcode/protocol"
import { glyphs } from "../src/ui/theme"
import { createTranscript, type PresentationMode } from "../src/view/transcript"
import { DEFAULT_TUI_PROFILE, TOOL_DENSITIES } from "../src/view/tui-profile"
import { DENSITY_NOW, densitySession } from "./density-session"
import { record } from "./views-scenarios"

/**
 * The thought blocks (`Thought: … · 1.5s` over a left bar and a muted body, and the `Thinking…` row) are liked exactly as they are:
 * this pins their rows and every span's role and attributes. A change to how they look is a decision, not a side effect of the
 * tool cards: rewrite the goldens (`MENDCODE_WRITE_GOLDENS=1 bun test apps/cli/test/thought-golden.test.ts`) only on purpose.
 */
const ids = createIdFactory()
const goldenFile = (name: string) => path.join(import.meta.dir, "fixtures", "thought-golden", `${name}.txt`)

function thought({ done, ms, text }: { done: boolean; ms: number; text: string }) {
  const sessionId = ids("session")
  const turnId = ids("turn")
  const itemId = ids("item")
  let seq = 0
  let at = DENSITY_NOW - 60_000
  const emit = (event: Record<string, unknown>, advance = 100) => ({ sessionId, seq: ++seq, at: (at += advance), ...event }) as SessionEvent
  return [
    emit({ type: "turn.started", turnId, queueId: ids("queue") }),
    emit({ type: "item.started", turnId, itemId, kind: "reasoning" }),
    emit({ type: "item.delta", itemId, text }),
    ...(done ? [emit({ type: "item.completed", itemId, status: "ok" }, ms)] : []),
  ]
}

function frame(events: readonly SessionEvent[], mode: PresentationMode, width: number, density?: (typeof TOOL_DENSITIES)[number]) {
  const appearance = { ...DEFAULT_TUI_PROFILE, ...(density ? { toolDensity: density } : {}) }
  const t = createTranscript({ appearance, glyphs: glyphs({}), mode, now: () => DENSITY_NOW })
  t.setAppearance({ ...appearance, reasoning: "auto", toolOutput: "auto", timestamps: false })
  for (const event of events) t.apply(event)
  return t.viewport(width, 400).filter((line) => line.kind === "reasoning").map((line) => line.spans)
}

function pinned(name: string, rows: ReturnType<typeof frame>) {
  const body = record(rows)
  if (process.env.MENDCODE_WRITE_GOLDENS) {
    mkdirSync(path.dirname(goldenFile(name)), { recursive: true })
    writeFileSync(goldenFile(name), body)
  }
  expect(body).toBe(readFileSync(goldenFile(name), "utf8"))
}

const BODY = "Order of the topics\nThe index is built from ORDER, so packages has to be added there; the file itself exists."
const LONG = `Weigh the options\n${Array.from({ length: 20 }, (_, i) => `Consideration ${i + 1}: a line of the model's reasoning that is long enough to be a real thought and not a stub.`).join("\n")}`

describe("thought blocks are pinned", () => {
  test("a finished thought in the full view: the title with its time, the left bar, the muted body", () => {
    pinned("finished-full-100", frame(thought({ done: true, ms: 1500, text: BODY }), "full", 100))
    pinned("finished-full-60", frame(thought({ done: true, ms: 1500, text: BODY }), "full", 60))
  })

  test("a long thought is cut to the full view's rows", () => {
    pinned("long-full-100", frame(thought({ done: true, ms: 12_000, text: LONG }), "full", 100))
  })

  test("the thought that is still running is the Thinking row", () => {
    pinned("running-full-100", frame(thought({ done: false, ms: 0, text: BODY }), "full", 100))
  })

  test("balanced draws them as it always did", () => {
    pinned("finished-balanced-100", frame(thought({ done: true, ms: 1500, text: BODY }), "balanced", 100))
  })

  test("the owner's session draws the same thoughts in every tool density", () => {
    const { events } = densitySession("ses_thought")
    const rows = TOOL_DENSITIES.map((density) => frame(events, "full", 100, density))
    expect(rows[1]).toEqual(rows[0]!)
    expect(rows[2]).toEqual(rows[0]!)
    pinned("session-full-100", rows[0]!)
  })
})
