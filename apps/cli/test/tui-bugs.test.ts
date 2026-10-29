import { afterAll, expect, test } from "bun:test"
import path from "node:path"
import { appHarness, cleanTemps, conversation, ids, NOW, tempDir } from "./session-ui-harness"
import { renderSettingsPage, SETTINGS_GROUPS } from "../src/view/settings-page"
import { DEFAULT_TUI_PROFILE, writeTuiProfile } from "../src/view/tui-profile"
import { SIDEBAR_PRESETS } from "../src/view/sidebar-spec"
import { textWidth } from "../src/view/wrap"
import { setTheme } from "../src/ui/theme"
import { settingsPreview } from "../src/view/settings-preview"
import { glyphs } from "../src/ui/theme"
import { createTicks } from "../src/ui/app/ticks"

afterAll(() => { cleanTemps(); setTheme("mend") })

for (const [width, height] of [[100, 30], [200, 60]] as const) {
  test(`settings previews and explanations fill the detail pane at ${width}x${height}`, () => {
    const values = { settings: { onboarded: true }, theme: "mend", view: "balanced", reducedMotion: false }
    const draw = (row: number, next = values) => renderSettingsPage({ state: { row }, values: next, width, height })
    const text = (rows: ReturnType<typeof draw>) => rows.map((line) => line.map((span) => span.text).join("")).join("\n")
    for (let row = 0; row < 5; row++) {
      const rows = draw(row)
      const shown = text(rows)
      expect(shown).toContain("Explain this change")
      expect(shown).toContain("patch keeps")
      expect(shown).toContain("src/input.ts")
      expect(shown).toContain("reading")
      expect(rows).toHaveLength(height)
      expect(rows.every((line) => textWidth(line.map((span) => span.text).join("")) <= width)).toBe(true)
    }
    expect(text(draw(1, { ...values, view: "full" }))).not.toBe(text(draw(1)))
    expect(text(draw(2, { ...values, reducedMotion: true }))).not.toBe(text(draw(2)))
    expect(text(draw(4, { ...values, settings: { onboarded: true, footer: ["branch"] } }))).toContain("preview")
    for (let row = 5; row < SETTINGS_GROUPS.flatMap((group) => group.rows).length; row++) expect(text(draw(row))).toContain("Stored:")
  })

  for (const graphics of [false, true]) test(`pet stays before panels (${graphics ? "image" : "halfblock"}) at ${width}x${height}`, async () => {
    const dataDir = tempDir()
    const directory = tempDir()
    const h = appHarness({ width, height, dataDir, directory, pets: { dirs: [{ dir: path.join(import.meta.dir, "fixtures/pets"), source: "user" }], cacheDir: tempDir(), images: graphics } })
    h.app.applySettings({ onboarded: true, tier: "full", pet: "user:tiny", reducedMotion: true })
    await h.app.petReady
    const chat = conversation(h.sessionId, (event) => h.app.onEvent(event))
    chat.exchange("request", "answer")
    h.app.render()
    const petRows = () => h.frames.at(-1)!.flatMap((line, row) => line.some((span) => span.fgHex && /[▀▄]/.test(span.text)) ? [row] : [])
    const clear = h.text()
    expect(graphics ? h.placements.at(-1)!.some((p) => p.slot === "pet") : petRows().length > 0).toBe(true)
    const turnId = ids("turn")
    chat.emit({ type: "turn.started", turnId, queueId: ids("queue") })
    const check = (needle: string) => {
      h.app.render()
      const top = h.text().findIndex((line) => line.includes(needle))
      expect(top).toBeGreaterThanOrEqual(0)
      expect(petRows().every((row) => row < top)).toBe(true)
      for (const placement of h.placements.at(-1)!.filter((p) => p.slot === "pet")) expect(placement.row + placement.rows).toBeLessThanOrEqual(top)
      expect(h.text()).toHaveLength(height)
    }
    let requestId = ids("request")
    chat.emit({ type: "server.request", requestId, turnId, kind: "approval", title: "Run command", detail: "APPROVAL DETAIL" })
    check("APPROVAL DETAIL")
    const withPet = h.text()
    const withPetFrame = h.frames.at(-1)!
    h.app.applySettings({ onboarded: true, tier: "full", pet: "off", reducedMotion: true })
    await h.app.petReady
    h.app.render()
    const top = withPet.findIndex((line) => line.includes("APPROVAL DETAIL")) - 1
    expect(withPet.slice(top)).toEqual(h.text().slice(top))
    expect(withPetFrame.slice(top)).toEqual(h.frames.at(-1)!.slice(top))
    h.app.applySettings({ onboarded: true, tier: "full", pet: "user:tiny", reducedMotion: true })
    await h.app.petReady
    chat.emit({ type: "server.request.resolved", requestId })
    requestId = ids("request")
    chat.emit({ type: "server.request", requestId, turnId, kind: "question", title: "QUESTION DETAIL", detail: "Choose a direction", options: [{ label: "First", value: "first" }] })
    check("QUESTION DETAIL")
    chat.emit({ type: "server.request.resolved", requestId })
    chat.emit({ type: "queue.changed", queue: [{ queueId: ids("queue"), preview: "QUEUED MESSAGE" }] })
    check("QUEUED MESSAGE")
    chat.emit({ type: "usage.limit", turnId, state: "scheduled", provider: "faux", message: "limit", resetsAt: NOW + 3600000 })
    check("resume at reset")
    expect(clear.join("\n")).toContain("answer")
  })
}

test("the pet stands on the prompt while a turn works: the working line does not lift it", async () => {
  const h = appHarness({ width: 100, height: 30, dataDir: tempDir(), directory: tempDir(), pets: { dirs: [{ dir: path.join(import.meta.dir, "fixtures/pets"), source: "user" }], cacheDir: tempDir(), images: false } })
  h.app.applySettings({ onboarded: true, tier: "full", pet: "user:tiny", reducedMotion: true })
  await h.app.petReady
  const chat = conversation(h.sessionId, (event) => h.app.onEvent(event))
  chat.exchange("request", "answer")
  h.app.render()
  const petRows = () => h.frames.at(-1)!.flatMap((line, row) => line.some((span) => span.fgHex && /[▀▄]/.test(span.text)) ? [row] : [])
  const resting = Math.max(...petRows())
  const before = h.text()
  const turnId = ids("turn")
  chat.emit({ type: "turn.started", turnId, queueId: ids("queue") })
  chat.emit({ type: "foreground.state", state: "generating", turnId })
  h.app.render()
  // The working line took the row above the prompt; the pet's last row is still that row, beside it.
  expect(h.text()[resting]).not.toBe(before[resting])
  expect(h.text()[resting]!.trim().replace(/[▀▄\s]+$/, "")).not.toBe("")
  expect(Math.max(...petRows())).toBe(resting)
})

test("the pet stays while the transcript scrolls: a row reaching its cells is cut short and the jump pill stops before it", async () => {
  const width = 100
  const h = appHarness({ width, height: 30, dataDir: tempDir(), directory: tempDir(), pets: { dirs: [{ dir: path.join(import.meta.dir, "fixtures/pets"), source: "user" }], cacheDir: tempDir(), images: false } })
  h.app.applySettings({ onboarded: true, tier: "full", pet: "user:tiny", reducedMotion: true })
  await h.app.petReady
  const chat = conversation(h.sessionId, (event) => h.app.onEvent(event))
  // Every row is as wide as the chat column, so there is never a free corner for the pet.
  chat.exchange("request", Array.from({ length: 60 }, (_, i) => `row ${i} ${"wide ".repeat(30)}`).join("\n\n"))
  h.app.render()
  const petRows = () => h.frames.at(-1)!.flatMap((line, row) => line.some((span) => span.fgHex && /[▀▄]/.test(span.text)) ? [row] : [])
  const rows = petRows()
  expect(rows.length).toBeGreaterThan(0)
  for (const row of rows) expect(textWidth(h.text()[row]!)).toBeLessThanOrEqual(width)
  expect(rows.some((row) => h.text()[row]!.includes("…"))).toBe(true)
  for (let i = 0; i < 5; i++) {
    await h.app.onKey("\x1b[<64;10;10M")
    h.app.render()
    expect(petRows()).toEqual(rows)
  }
  // Off the bottom: the pill is on a pet row, whole, to the left of the pet.
  const pill = h.text().findIndex((line) => line.includes("End"))
  expect(rows).toContain(pill)
  const petFrom = h.frames.at(-1)![pill]!.reduce((at, span) => at.found ? at : span.fgHex && /[▀▄]/.test(span.text) ? { ...at, found: true } : { ...at, col: at.col + textWidth(span.text) }, { col: 0, found: false }).col
  expect(h.text()[pill]!.indexOf("End") + 3).toBeLessThan(petFrom)
})

test("motion preview animates normally and stays stable with reduced motion", () => {
  const values = { settings: {}, theme: "mend", view: "balanced", reducedMotion: false }
  const draw = (now: number, reducedMotion = false) => settingsPreview({ values: { ...values, reducedMotion }, width: 60, height: 18, now, glyphs: glyphs({}) })
  expect(draw(0)).not.toEqual(draw(600))
  expect(draw(0, true)).toEqual(draw(600, true))
})

test("settings pulse stops on reduced motion, explanation rows and page exit", () => {
  const state = { page: "settings", settingsPageState: { row: 2 }, transcript: { foreground: "idle", blocks: () => [] }, agentSessions: new Map(), turnState: {}, reducedMotion: false, pulse: undefined as ReturnType<typeof setInterval> | undefined, pulseOn: true }
  const ticks = createTicks({ state, schedule() {}, input: {} } as never, { chatWidth: () => 100, sessionTitle: () => "", render() {} })
  try {
    ticks.syncPulse()
    expect(state.pulse).toBeDefined()
    const pulse = state.pulse
    ticks.syncPulse()
    expect(state.pulse).toBe(pulse)
    state.reducedMotion = true
    ticks.syncPulse()
    expect(state.pulse).toBeUndefined()
    state.reducedMotion = false
    ticks.syncPulse()
    state.settingsPageState.row = 5
    ticks.syncPulse()
    expect(state.pulse).toBeUndefined()
    state.settingsPageState.row = 2
    ticks.syncPulse()
    state.page = "chat"
    ticks.syncPulse()
    expect(state.pulse).toBeUndefined()
  } finally { if (state.pulse) clearInterval(state.pulse) }
})

test("pet reserves the collapsed right sheet", async () => {
  const dataDir = tempDir()
  writeTuiProfile(dataDir, { ...DEFAULT_TUI_PROFILE, panelNarrow: "sheet", rightSidebar: true, sidebarWidgets: structuredClone(SIDEBAR_PRESETS.pulse) })
  const h = appHarness({ width: 100, height: 30, dataDir, directory: tempDir(), pets: { dirs: [{ dir: path.join(import.meta.dir, "fixtures/pets"), source: "user" }], cacheDir: tempDir(), images: true } })
  h.app.applySettings({ onboarded: true, tier: "full", pet: "user:tiny", reducedMotion: true })
  await h.app.petReady
  h.app.render()
  const top = h.text().findIndex((line) => line.includes("Agent"))
  expect(top).toBeGreaterThanOrEqual(0)
  for (const p of h.placements.at(-1)!.filter((p) => p.slot === "pet")) expect(p.row + p.rows).toBeLessThanOrEqual(top)
})

test("a kitty pet image leaves the rows under it whole (it is transparent); a pet without that protocol cuts them at its edge", async () => {
  const frame = async (kitty: boolean) => {
    const dataDir = tempDir()
    writeTuiProfile(dataDir, { ...DEFAULT_TUI_PROFILE, panelNarrow: "sheet", rightSidebar: false })
    const rows: string[][] = []
    const placed: Array<Array<{ slot: string; row: number; rows: number; col: number }>> = []
    const screen = { size: { width: 100, height: 24 }, draw: (lines: Array<Array<{ text: string }>>, _cursor?: unknown, images?: Array<{ slot: string; row: number; rows: number; col: number }>) => { rows.push(lines.map((line) => line.map((span) => span.text).join(""))); placed.push(images ?? []) }, write() {}, ...(kitty ? { imageProtocol: "kitty" } : {}) }
    const h = appHarness({ width: 100, height: 24, dataDir, directory: tempDir(), screen: screen as never, pets: { dirs: [{ dir: path.join(import.meta.dir, "fixtures/pets"), source: "user" }], cacheDir: tempDir(), images: true } })
    h.app.applySettings({ onboarded: true, tier: "full", pet: "user:tiny", reducedMotion: true })
    await h.app.petReady
    const sessionId = h.sessionId
    const chat = conversation(sessionId, (event) => h.app.onEvent(event))
    chat.exchange("q", Array.from({ length: 30 }, (_, n) => `line ${n} ${"wide text ".repeat(12)}`).join("\n\n"))
    h.app.render()
    const pet = placed.at(-1)!.find((p) => p.slot === "pet")!
    return { under: rows.at(-1)!.slice(pet.row, pet.row + pet.rows), pet }
  }
  const kitty = await frame(true)
  const other = await frame(false)
  expect(kitty.pet).toBeDefined()
  // Under the kitty image the text runs on into the pet's columns; without it those columns are blank.
  expect(kitty.under.some((row) => row.slice(kitty.pet.col).trim() !== "")).toBe(true)
  expect(other.under.every((row) => row.slice(other.pet.col).trim() === "")).toBe(true)
})

test("what the launch has to say shows once in the notice slot over the prompt, not in the footer", async () => {
  const h = appHarness({ width: 100, height: 24, dataDir: tempDir(), directory: tempDir(), notice: "updated to the new build" })
  await h.app.start()
  h.app.render()
  const rows = h.text()
  expect(rows.join("\n")).toContain("updated to the new build")
  expect(rows.at(-1)).not.toContain("updated to the new build")
})
