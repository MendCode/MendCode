import { renderEnvironmentPage, type EnvironmentPageState } from "../src/view/environment-page"
import { expect, test } from "bun:test"
import { createApp } from "../src/ui/app"
import { glyphs, type Line } from "../src/ui/theme"
import { createIdFactory } from "@mendcode/protocol"

const ids = createIdFactory({ now: () => 1_700_000_000_000, random: (size) => new Uint8Array(size).fill(1) })
function harness(mode: "minimal" | "balanced" | "full", privacy?: { target: boolean; pending: number }) {
  const frames: Line[][] = [], sent: Record<string, unknown>[] = []
  let encrypted = false
  const entries: { name: string; scope: string; updatedAt: number }[] = []
  const app = createApp({ sessionId: ids("session"), directory: "/project", mode, exit() {}, schedule: (fn) => fn(), glyphs: glyphs({}),
    screen: { size: { width: 100, height: 30 }, draw: (rows: Line[]) => frames.push(rows) } as never,
    send: (async (command: Record<string, unknown>) => {
      sent.push(command)
      if (command.type === "privacy.set") encrypted = command.enabled as boolean
      if (command.type === "privacy.get" || command.type === "privacy.set") return { ok: true, result: { enabled: encrypted, ...privacy } }
      if (command.type === "env.set") entries.push({ name: command.name as string, scope: command.scope as string, updatedAt: 1 })
      if (command.type === "env.remove") entries.splice(0)
      if (String(command.type).startsWith("env.")) return { ok: true, result: { entries, native: true } }
      return { ok: true }
    }) as never,
  })
  const text = () => frames.flat().map((line) => line.map((span) => span.text).join("")).join("\n")
  const key = async (value: string) => { await app.onKey(value); await Bun.sleep(2) }
  const open = async (command: string) => { await app.onInput(command); await key("\r") }
  return { app, sent, text, key, open }
}

for (const mode of ["minimal", "balanced", "full"] as const) test(`/env works in ${mode}; values never render or enter chat history, privacy requires confirmation`, async () => {
  const h = harness(mode)
  await h.open("/env")
  expect(h.app.page).toBe("env")
  await h.key("a")
  await h.app.onInput("\x1b[200~ELEVENLABS_API_KEY\x1b[201~")
  await h.key("\r")
  const value = "very-private-voice-fixture"
  await h.app.onInput(`\x1b[200~${value}\x1b[201~`)
  expect(h.text()).not.toContain(value)
  await h.key("\r")
  expect(h.sent).toContainEqual({ type: "env.set", sessionId: h.app.sessionId, name: "ELEVENLABS_API_KEY", scope: "project", value })
  expect(h.sent.some((command) => command.type === "user.submit" || command.type === "prompt.record")).toBe(false)
  expect(h.text()).not.toContain(value)
  await h.key("p")
  expect(h.sent.some((command) => command.type === "privacy.set")).toBe(false)
  await h.key("y")
  expect(h.sent).toContainEqual({ type: "privacy.set", enabled: true })
  await h.key("x"); await h.key("y")
  expect(h.sent.some((command) => command.type === "env.remove")).toBe(true)
  await h.key("\x1b")
  expect(h.app.page).toBe("chat")
})

for (const target of [true, false]) test(`/privacy renders incomplete conversion toward ${target ? "ON" : "OFF"} and toggles its target`, async () => {
  const h = harness("balanced", { target, pending: 2 })
  await h.open("/privacy")
  expect(h.text()).toContain(`Chat encryption: INCOMPLETE · 2 pending · target ${target ? "ON" : "OFF"}`)
  expect(h.text()).not.toContain("Chat encryption: ON · AES-256-GCM")
  await h.key("y")
  expect(h.sent).toContainEqual({ type: "privacy.set", enabled: !target })
})

test("canceling a credential edit discards its value without saving", async () => {
  const h = harness("balanced")
  await h.open("/env"); await h.key("a"); await h.key("API_KEY"); await h.key("\r"); await h.key("unsaved-private"); await h.key("\x1b")
  expect(h.sent.some((command) => command.type === "env.set")).toBe(false)
  expect(h.text()).not.toContain("unsaved-private")
})

test("the page is two standard panels: credentials with a colour per scope, privacy facts beside them; stacked when narrow", () => {
  const now = Date.UTC(2026, 9, 13, 12)
  const state: EnvironmentPageState = { entries: [{ name: "PLANE_API_KEY", scope: "global", updatedAt: now }, { name: "TMP", scope: "session", updatedAt: now }], selected: 0, loading: false, busy: false, error: "", scope: "project", encrypted: false }
  const wide = renderEnvironmentPage(state, 150, 20, { now })
  const rows = wide.map((line) => line.map((span) => span.text).join(""))
  const top = rows.find((row) => row.includes("─ Credentials "))!
  expect(top).toContain("─ Privacy ")
  expect(rows.join("\n")).toContain("Chat encryption: OFF · readable SQLite")
  expect(rows.join("\n")).toContain("Off by default in every tier")
  const tone = (text: string) => wide.flat().find((span) => span.text.trim() === text)?.fg
  expect(tone("global")).toBeDefined()
  expect(tone("global")).not.toBe(tone("session"))
  expect(wide.flat().find((span) => span.text.includes("Chat encryption: OFF"))?.fg).toBe("muted")
  expect(renderEnvironmentPage({ ...state, encrypted: true }, 150, 20, { now }).flat().find((span) => span.text.includes("Chat encryption: ON"))?.fg).toBe("success")
  const narrow = renderEnvironmentPage(state, 78, 30, { now }).map((line) => line.map((span) => span.text).join(""))
  expect(narrow.find((row) => row.includes("─ Credentials "))).not.toContain("Privacy")
  expect(narrow.some((row) => row.includes("─ Privacy "))).toBe(true)
  for (const row of [...rows, ...narrow]) expect(row.length).toBeLessThanOrEqual(150)
})
