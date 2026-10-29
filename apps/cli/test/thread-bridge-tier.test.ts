import { expect, test } from "bun:test"
import { createIdFactory } from "@mendcode/protocol"
import { createApp } from "../src/ui/app"
import { glyphs, type Line } from "../src/ui/theme"

const ids = createIdFactory()

function harness(settings: Record<string, unknown>) {
  const frames: Line[][] = []
  const patches: Array<Record<string, unknown>> = []
  const screen = { size: { width: 120, height: 30 }, draw: (rows: Line[]) => void frames.push(rows) } as unknown as Parameters<typeof createApp>[0]["screen"]
  const app = createApp({
    sessionId: ids("session"), screen, directory: "/work/app", exit() {}, schedule: (fn) => fn(), glyphs: glyphs({}), now: () => 1_800_000_000_000, mode: "full",
    send: (async (command: { type: string; patch?: Record<string, unknown> }) => {
      if (command.type === "settings.get") return { ok: true, result: { settings } }
      if (command.type === "settings.set") { patches.push(command.patch!); return { ok: true, result: { settings: { ...settings, ...command.patch } } } }
      return { ok: true }
    }) as never,
  })
  const type = async (text: string) => { for (const key of text) await app.onKey(key) }
  const text = () => frames.at(-1)!.map((line) => line.map((span) => span.text).join("")).join("\n")
  return { app, patches, type, text }
}

test("/tier thread_mcp on claude turns the bridge on for Claude Code, keeping the engines already opted in", async () => {
  const h = harness({ tier: "full", threadMcp: { codex: true }, features: { pets: true } })
  await h.type("/tier thread_mcp on claude acp:Gemini\r")
  expect(h.patches.at(-1)).toEqual({ threadMcp: { codex: true, claude: true, acp: { Gemini: true } }, features: { pets: true, thread_mcp: true } })
  expect(h.text()).toContain("thread bridge on for claude, acp:Gemini")
})

test("/tier thread_mcp off codex takes one engine out and leaves the feature alone; an unknown engine is refused", async () => {
  const h = harness({ tier: "full", threadMcp: { claude: true, codex: true } })
  await h.type("/tier thread_mcp off codex\r")
  expect(h.patches.at(-1)).toEqual({ threadMcp: { claude: true, codex: false } })
  await h.type("/tier thread_mcp on cursor\r")
  expect(h.patches).toHaveLength(1)
  expect(h.text()).toContain("thread_mcp engines: claude, codex, acp:<name> (not cursor)")
})
