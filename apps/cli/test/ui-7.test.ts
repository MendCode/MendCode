import { afterEach, describe, expect, test } from "bun:test"
import { createTranscript } from "../src/view/transcript"
import { homeIdentity } from "../src/view/home"
import { defaultHomeMascot } from "../src/view/mascot"
import { textWidth } from "../src/view/wrap"
import { createScreen } from "../src/ui/screen"
import path from "node:path"
import { cpSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { petPreviewBox, renderPetPicker } from "../src/view/pet-picker"
import { sizePet } from "../src/pets/frames"
import type { ImagePlacement } from "../src/ui/image-layer"
import { CUSTOMIZE_ROWS } from "../src/view/customize-page"
import { DEFAULT_TUI_PROFILE, PROMPT_CHROMES, readTuiProfile, writeTuiProfile } from "../src/view/tui-profile"
import { appHarness, cleanTemps, conversation, ids, mendRowIn, mendRows, NOW, tempDir } from "./session-ui-harness"

afterEach(cleanTemps)

describe("UI-7 pet off reproduction", () => {
  for (const [pet, images] of [["mend", "off"], ["user:tiny", "off"], ["user:tiny", "kitty"]] as const) for (const route of ["picker", "slash", "customize"]) test(`${pet}/${images}: ${route} removes rows and images in the next frame and persists`, async () => {
    const dataDir = tempDir()
    writeTuiProfile(dataDir, { ...DEFAULT_TUI_PROFILE, pet, images })
    const screen = createScreen({ columns: 100, rows: 30, write() {} }, { TERM_PROGRAM: "ghostty", COLORTERM: "truecolor" })
    const h = appHarness({ screen, dataDir, width: 100, height: 30, pets: { dirs: [{ dir: path.join(import.meta.dir, "fixtures/pets"), source: "user" }], cacheDir: path.join(dataDir, "cache"), images: images !== "off" } })
    h.app.applySettings({ onboarded: true, pet, reducedMotion: true })
    conversation(h.sessionId, (event) => h.app.onEvent(event)).exchange("Hello", "Ready")
    await h.app.imagesReady
    await h.app.petReady
    h.app.render()
    const petRows = () => h.frames.at(-1)!.flat().filter((span) => span.fgHex || span.bgHex || /\/[\[|]|\(o/.test(span.text))
    if (images === "kitty") expect(h.placements.at(-1)).toHaveLength(1)
    else expect(petRows().length).toBeGreaterThan(0)
    if (route === "picker") await h.type("/pet\ro")
    else if (route === "slash") await h.type("/pet off\r")
    else {
      await h.type("/customize\r")
      for (let i = 0; i < CUSTOMIZE_ROWS.indexOf("pet"); i++) await h.app.onKey("\x1b[B")
      await h.app.onKey(" ")
      await h.app.onKey("\x1b")
    }
    h.app.render()
    expect(h.app.page).toBe("chat")
    expect(petRows()).toEqual([])
    expect(h.placements.at(-1)).toEqual([])
    h.app.applySettings({ onboarded: true, pet, reducedMotion: true })
    h.app.render()
    expect(petRows()).toEqual([])
    expect(h.placements.at(-1)).toEqual([])
    expect(readTuiProfile(dataDir).pet).toBe("off")
    await h.type("\x03")
  })
})

async function customize(h: ReturnType<typeof appHarness>, field: typeof CUSTOMIZE_ROWS[number], key = " ") {
  await h.type("/customize\r")
  for (let i = 0; i < CUSTOMIZE_ROWS.indexOf(field); i++) await h.app.onKey("\x1b[B")
  await h.app.onKey(key)
  h.app.render()
}

test("message roles, meta and renderer descriptions preview live and persist; quota/today opt in", async () => {
  const dataDir = tempDir()
  const h = appHarness({ dataDir, width: 180, height: 50, directory: "/work/app" })
  h.app.applySettings({ onboarded: true })
  const chat = conversation(h.sessionId, h.app.onEvent)
  const turnId = ids("turn"), user = ids("item"), tool = ids("item"), answer = ids("item")
  chat.emit({ type: "turn.started", turnId, queueId: ids("queue") })
  for (const [itemId, kind, text] of [[user, "user_message", "Check this"], [tool, "tool_call", "file contents"], [answer, "agent_message", "Ready"]]) {
    chat.emit({ type: "item.started", turnId, itemId, kind, meta: kind === "tool_call" ? { tool: "read" } : {} })
    chat.emit({ type: "item.completed", itemId, status: "ok", text })
  }
  chat.emit({ type: "usage.recorded", turnId, provider: "local", model: "test-model", input: 100, output: 20, reasoning: 0, cacheRead: 0, cacheWrite: 0 })
  chat.emit({ type: "turn.completed", turnId })
  chat.emit({ type: "turn.completed", turnId })
  h.app.render()
  let rows = h.text()
  expect(rows.some((row) => row.includes("› Check this"))).toBe(true)
  expect(rows.some((row) => row.includes("• Ready"))).toBe(true)
  expect(rows.slice(0, -1).join("\n")).not.toMatch(/● You|◈|test-model/)
  const userRow = h.frames.at(-1)![rows.findIndex((row) => row.includes("Check this"))]!
  const tinted = userRow.filter((span) => span.bg === "promptBg").map((span) => span.text).join("")
  expect(tinted).toContain("Check this")
  expect(textWidth(tinted)).toBeGreaterThan(100)
  await customize(h, "messageMeta", "\x1b[D") // off -> full
  expect(h.text().join("\n")).toContain("test-model")
  await h.app.onKey("\x1b")
  rows = h.text()
  expect(rows.filter((row) => row.includes("◈"))).toHaveLength(1)
  const from = rows.findIndex((row) => row.includes("Ready"))
  expect(rows[from + 1]).toContain("◈")
  expect(readTuiProfile(dataDir).messageMeta).toBe("full")
  await customize(h, "userLabel")
  await h.app.onKey("\x1b")
  expect(h.text().join("\n")).toContain("› You Check this")
  await customize(h, "messageRenderer", "\x1b[D")
  expect(h.text().join("\n")).toContain("Markdown; diagrams shown as source")
  await h.app.onKey("\x1b")
  h.app.onGlobal({ type: "usage.today", gseq: 1, at: NOW, day: "2026-09-30", tokens: 2400, calls: 1 } as never)
  expect(h.text().at(-1)).not.toContain("today")
  await customize(h, "footerToday")
  await h.app.onKey("\x1b")
  expect(h.text().at(-1)).toContain("today 2,400")
  await customize(h, "contextBar", "\x1b[C")
  await h.app.onKey("\x1b")
  expect(readTuiProfile(dataDir).contextBar).toBe("off")
  expect(CUSTOMIZE_ROWS).not.toContain("showFooterContext" as never)
  await h.app.onKey("\x03")
})

test("one blank row between ordinary turns and classic remains selectable", async () => {
  const dataDir = tempDir()
  const h = appHarness({ dataDir, width: 100, height: 30 })
  const chat = conversation(h.sessionId, h.app.onEvent)
  chat.exchange("First", "One")
  chat.exchange("Second", "Two")
  const rows = h.text(), at = rows.findIndex((row) => row.includes("• One"))
  expect(rows[at + 1]!.trim()).toBe("")
  expect(rows[at + 2]).toContain("› Second")
  await customize(h, "messageLayout", "\x1b[C")
  await h.app.onKey("\x1b")
  expect(h.text().join("\n")).toContain("● You")
  expect(readTuiProfile(dataDir).messageMeta).toBe("full")
  await h.app.onKey("\x03")
})

for (const chrome of PROMPT_CHROMES) test(`${chrome}: footer outside input with legacy inside setting; no clipped tray at breakpoints`, async () => {
  for (const [width, height] of [[60, 20], [100, 30], [160, 45], [220, 60]]) {
    const dataDir = tempDir()
    writeTuiProfile(dataDir, { ...DEFAULT_TUI_PROFILE, promptChrome: chrome, statusPlacement: "inside" })
    const h = appHarness({ dataDir, width, height, directory: "/work/app" })
    conversation(h.sessionId, h.app.onEvent).exchange("Check", "Ready")
    await h.type("\x14")
    const rows = h.text(), footer = rows.findLastIndex((row) => /Build/.test(row))
    const bottom = rows.findLastIndex((row) => /─{10}|═{10}|={10}/.test(row))
    expect(h.frames.at(-1)).toHaveLength(height)
    expect(rows.every((row) => textWidth(row) <= width)).toBe(true)
    if (chrome === "minimal") { expect(rows[footer - 1]!.replace(/│/g, "").trim()).toBe("") }
    else expect(footer).toBeGreaterThan(bottom)
    await h.app.onKey("\x03")
  }
})

/** The last row of the chat's Mend at rest: colored half blocks, or v1's text mascot where the prompt's glyphs are ASCII; -1 when it is not drawn. */
function mendBottom(h: ReturnType<typeof appHarness>) {
  const at = mendRowIn(h.frames.at(-1)!, "done")
  return at >= 0 ? at + mendRows("done").length - 1 : h.text().findLastIndex((row) => /\/\|?\[\+\]\|?\\/.test(row))
}

test("customize turns off a pet inherited from daemon settings and the local override survives later settings", async () => {
  const dataDir = tempDir()
  const h = appHarness({ dataDir, width: 100, height: 30 })
  h.app.applySettings({ onboarded: true, pet: "mend", reducedMotion: true })
  conversation(h.sessionId, h.app.onEvent).exchange("Hello", "Ready")
  expect(mendBottom(h)).toBeGreaterThan(0)
  await customize(h, "pet")
  await h.app.onKey("\x1b")
  expect(mendBottom(h)).toBe(-1)
  expect(readTuiProfile(dataDir).pet).toBe("off")
  h.app.applySettings({ onboarded: true, pet: "mend" })
  expect(mendBottom(h)).toBe(-1)
  await h.app.onKey("\x03")
})

for (const chrome of PROMPT_CHROMES) test(`${chrome}: ASCII and pixel pets stand on the prompt's top edge`, async () => {
  for (const pet of ["mend", "user:tiny"]) {
    const dataDir = tempDir()
    writeTuiProfile(dataDir, { ...DEFAULT_TUI_PROFILE, pet, promptChrome: chrome, images: "off" })
    const h = appHarness({ dataDir, width: 100, height: 30, pets: { dirs: [{ dir: path.join(import.meta.dir, "fixtures/pets"), source: "user" }], cacheDir: path.join(dataDir, "cache"), images: false } })
    h.app.applySettings({ onboarded: true, pet, reducedMotion: true })
    conversation(h.sessionId, h.app.onEvent).exchange("Hello", "Ready")
    await h.app.petReady
    h.app.render()
    const rows = h.text()
    const inputRow = rows.findLastIndex((row) => row.includes("❭"))
    const lastPet = pet === "mend" ? mendBottom(h) : h.frames.at(-1)!.findLastIndex((row) => row.some((span) => span.fgHex || span.bgHex))
    expect(lastPet).toBe(inputRow - 2)
    await h.type("/pet off\r")
    await h.app.onKey("\x03")
  }
})

test("while a turn works, the built-in Mend stands on the prompt like a pixel pet, past the working line", async () => {
  const bottoms: number[] = []
  for (const pet of ["mend", "user:tiny"]) {
    const dataDir = tempDir()
    writeTuiProfile(dataDir, { ...DEFAULT_TUI_PROFILE, pet, images: "off" })
    const h = appHarness({ dataDir, width: 100, height: 30, pets: { dirs: [{ dir: path.join(import.meta.dir, "fixtures/pets"), source: "user" }], cacheDir: path.join(dataDir, "cache"), images: false } })
    h.app.applySettings({ onboarded: true, pet, reducedMotion: true })
    const chat = conversation(h.sessionId, h.app.onEvent)
    chat.exchange("Hello", "Ready")
    const turnId = ids("turn")
    chat.emit({ type: "turn.started", turnId, queueId: ids("queue") })
    chat.emit({ type: "foreground.state", state: "generating", turnId })
    await h.app.petReady
    h.app.render()
    const frame = h.frames.at(-1)!
    bottoms.push(frame.findLastIndex((row, index) => index < frame.findLastIndex((line) => line.some((span) => span.text.includes("❭"))) && row.some((span) => span.fgHex !== undefined && /[▀▄]/.test(span.text))))
    await h.app.onKey("\x03")
  }
  expect(bottoms[0]).toBeGreaterThan(0)
  expect(bottoms[0]).toBe(bottoms[1])
})

test("compact completion metadata preserves provider errors while default metadata stays off", () => {
  const t = createTranscript({ appearance: { messageMeta: "compact" } })
  const chat = conversation(ids("session"), t.apply)
  const turnId = ids("turn")
  chat.emit({ type: "turn.started", turnId, queueId: ids("queue") })
  chat.emit({ type: "turn.failed", turnId, error: { code: "rate_limit", message: "Try again later" } })
  const rows = t.viewport(100, 30).map((line) => line.text)
  expect(rows.join("\n")).toContain("Try again later")
  expect(rows.filter((row) => row.includes("◈"))).toHaveLength(1)
})

test("both logo composes mascot and wordmark around the same center", () => {
  for (const logoFont of ["mendcode", "compact", "solid", "outline"] as const) {
    const rows = homeIdentity({ logoKind: "both", logoFont })
    const mascot = defaultHomeMascot.split("\n")
    const width = Math.max(...rows.map(textWidth))
    const mascotWidth = Math.max(...mascot.map(textWidth))
    const offset = Math.floor((width - mascotWidth) / 2)
    expect(rows.slice(0, mascot.length)).toEqual(mascot.map((row) => " ".repeat(offset) + row))
    expect(rows[mascot.length]!.trim()).toBe("")
    expect(rows[mascot.length + 1]!.trim()).not.toBe("")
  }
})

test("both logo remains composed in every welcome mode at 100x30", async () => {
  for (const [homeLayout, homeRightPanel] of [["centered", "actions"], ["split", "actions"], ["split", "agentManager"]] as const) {
    const dataDir = tempDir()
    writeTuiProfile(dataDir, { ...DEFAULT_TUI_PROFILE, logoKind: "both", homeLayout, homeRightPanel })
    const h = appHarness({ dataDir, width: 100, height: 30 })
    h.app.onGlobal({ type: "session.activity", gseq: 1, at: NOW, sessionId: ids("session"), directory: "/work/app", title: "Check layout", state: "generating", updatedAt: NOW } as never)
    h.app.render()
    const text = h.text().join("\n")
    // Centered, the colored Mend stands above the wordmark (working with the session at work); the split box keeps the text identity.
    if (homeLayout === "centered") {
      for (const row of homeIdentity({ logoKind: "wordmark" }).filter((row) => row.trim())) expect(text).toContain(row.trim())
      expect(mendRowIn(h.frames.at(-1)!, "running", 2)).toBeGreaterThan(0)
    } else for (const row of homeIdentity({ logoKind: "both" }).filter((row) => row.trim())) expect(text).toContain(row)
    await h.app.onKey("\x03")
  }
})

test("quota and today customize toggles also work with a persisted footer list", async () => {
  const dataDir = tempDir()
  const h = appHarness({ dataDir, width: 180, height: 50 })
  h.app.applySettings({ onboarded: true, footer: ["branch"] })
  h.app.onGlobal({ type: "usage.today", gseq: 1, at: NOW, day: "2026-09-30", tokens: 2400, calls: 1 } as never)
  h.app.onGlobal({ type: "quota.snapshot", gseq: 2, at: NOW, provider: "codex", windows: [{ id: "7d", label: "7d", usedPercent: 35 }], fetchedAt: NOW, source: "test" } as never)
  for (const [field, marker] of [["footerToday", "today 2,400"], ["footerQuota", "codex 7d"]] as const) {
    await customize(h, field)
    await h.app.onKey("\x1b")
    expect(h.text().at(-1)).toContain(marker)
    await customize(h, field)
    await h.app.onKey("\x1b")
    expect(h.text().at(-1)).not.toContain(marker)
  }
  const saved = h.sentOf("settings.set").at(-1) as { patch: { footer: string[] } }
  expect(saved.patch.footer).toEqual(["branch"])
  expect(readTuiProfile(dataDir)).toMatchObject({ footerToday: false, footerQuota: false })
  await h.app.onKey("\x03")
})

test("legacy footer context stays hidden while Context bar styles preview and persist", async () => {
  const dataDir = tempDir()
  writeTuiProfile(dataDir, { ...DEFAULT_TUI_PROFILE, showFooterContext: true, statusRight: "context" })
  const h = appHarness({ dataDir, width: 100, height: 30 })
  h.app.applySettings({ onboarded: true, footer: ["context"] })
  const chat = conversation(h.sessionId, h.app.onEvent)
  const turnId = ids("turn")
  chat.emit({ type: "turn.started", turnId, queueId: ids("queue") })
  chat.emit({ type: "usage.recorded", turnId, provider: "faux", model: "test", input: 12000, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 })
  chat.emit({ type: "turn.completed", turnId })
  expect(h.text().at(-1)).not.toMatch(/ctx|context|%/)
  for (const style of ["bar", "percent", "both"]) {
    await customize(h, "contextStyle", "\x1b[C")
    await h.app.onKey("\x1b")
    expect(readTuiProfile(dataDir).contextStyle).toBe(style)
    const top = h.frames.at(-1)![0]!
    expect(top.some((span) => span.bg === "text")).toBe(style !== "percent")
    expect(h.text()[0]!.includes("%")).toBe(style !== "bar")
  }
  await h.app.onKey("\x03")
})

for (const chrome of PROMPT_CHROMES) test(`${chrome}: tray and multiline prompt keep the footer and both cursors visible at 60x20`, async () => {
  const dataDir = tempDir()
  writeTuiProfile(dataDir, { ...DEFAULT_TUI_PROFILE, promptChrome: chrome })
  const h = appHarness({ dataDir, width: 60, height: 20, directory: "/work/app" })
  conversation(h.sessionId, h.app.onEvent).exchange("Hello", "Ready")
  await h.type("\x1b[200~one\ntwo\nthree\nfour\nfive\nsix\x1b[201~\x18s")
  await h.type("tray note")
  expect(h.text().at(-1)).toContain("Build")
  let cursor = h.cursors.at(-1)!
  expect(h.text()[cursor.row]).toContain("tray note")
  await h.type("\x1b")
  expect(h.text().at(-1)).toContain("Build")
  cursor = h.cursors.at(-1)!
  expect(h.text()[cursor.row]).toContain("six")
  expect(h.app.editor.text).toBe("one\ntwo\nthree\nfour\nfive\nsix")
  expect(h.frames.at(-1)).toHaveLength(20)
  await h.app.onKey("\x03")
  await h.app.onKey("\x03")
})

test("/pet lists an installed pet under its own name beside the built-in Mend, and choosing it leaves its files as they were", async () => {
  const dataDir = tempDir(), petsDir = tempDir()
  const folder = path.join(petsDir, "mend-cat")
  cpSync(path.join(import.meta.dir, "fixtures/pets/tiny"), folder, { recursive: true })
  const manifest = JSON.stringify({ id: "mend-cat", displayName: "Mend Cat", description: "Pixel test", spritesheetPath: "spritesheet.png" })
  writeFileSync(path.join(folder, "pet.json"), manifest)
  writeTuiProfile(dataDir, { ...DEFAULT_TUI_PROFILE, pet: "user:mend-cat", images: "off" })
  const h = appHarness({ dataDir, width: 180, height: 50, pets: { dirs: [{ dir: petsDir, source: "user" }], cacheDir: path.join(dataDir, "cache"), images: false } })
  await h.type("/pet\r")
  const text = h.text().join("\n")
  expect(text).toMatch(/ MendAscii {3,}/)
  expect(text).toContain("Mend Cat · Source: user")
  await h.app.onKey("\r")
  // One pet: the start screen's mascot follows the choice.
  expect(readTuiProfile(dataDir)).toMatchObject({ pet: "user:mend-cat", homeMascot: "user:mend-cat" })
  expect(readFileSync(path.join(folder, "pet.json"), "utf8")).toBe(manifest)
  expect(readdirSync(petsDir)).toEqual(["mend-cat"])
  await h.app.onKey("\x03")
})

test("pixel preview caps at 16 rows, centers and scales with whole pixels", () => {
  const image = { width: 16, height: 16, rgba: new Uint8Array(16 * 16 * 4).fill(255) }
  for (const [width, height] of [[100, 30], [180, 50], [220, 60]]) {
    const placements: ImagePlacement[] = []
    renderPetPicker({ width, height, choices: [{ ref: "codex:greenie", name: "Mend", description: "", source: "MendCode (pixel)", image }], current: "codex:greenie", state: { selected: 0 }, graphics: true, placements })
    const p = placements[0]!
    expect(p.rows).toBeLessThanOrEqual(16)
    const panel = petPreviewBox(width, height, 1)
    expect(Math.abs(p.col + p.cols / 2 - (panel.col + panel.width / 2))).toBeLessThanOrEqual(0.5)
    const scaled = sizePet(image, p.cols, p.rows, { width: 1, height: 2 })
    const drawnRows = Array.from({ length: scaled.height }, (_, y) => scaled.rgba[y * scaled.width * 4 + 3]).filter((alpha) => alpha === 255).length
    expect(drawnRows % image.height).toBe(0)
  }
})
