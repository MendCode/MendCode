import { afterAll, describe, expect, test } from "bun:test"
import { readdirSync } from "node:fs"
import path from "node:path"
import { tuiProblems } from "@mendcode/protocol/wire"
import { BUILT_IN_PETS } from "../src/pets/builtin"
import { IMAGE_ONLY_REASON, petNeedsImages, usablePetRef } from "../src/pets/image-gate"
import { listPets } from "../src/pets/manifest"
import { createPetSlot } from "../src/pets/pet-slot"
import { loadSprite } from "../src/pets/sprite"
import { isPetMascot } from "../src/ui/app/home-mascot"
import { petPickerKey } from "../src/view/pet-picker"
import { DEFAULT_TUI_PROFILE, normalizeHomeMascot, readTuiProfile } from "../src/view/tui-profile"
import { hasHalfBlocks, mascotScene, petStore, type PetStore } from "./mascot-scene"
import { cleanTemps, tempDir } from "./session-ui-harness"

afterAll(() => cleanTemps())

const BUILT_IN = { dir: "", source: "builtin" as const }
const MENDGIRL = "builtin:mendgirl"

/** The store's pets with the built-in ones listed first, as the terminal lists them (`main.ts`). */
const withBuiltIns = (store: PetStore): PetStore => ({ ...store, pets: (images = false) => { const own = store.pets(images); return { ...own, dirs: [BUILT_IN, ...own.dirs] } } })

describe("MendGirl, the built-in pet", () => {
  test("is listed only through a builtin entry, before the user's pets, as builtin:mendgirl", async () => {
    const store = petStore()
    await store.importPath(path.join(import.meta.dir, "fixtures", "pets", "tiny", "spritesheet.png"), { name: "Tiny" })
    const own = (await listPets(store.pets().dirs)).pets.map((pet) => pet.ref)
    expect(own.some((ref) => ref.startsWith("builtin:"))).toBe(false)
    const all = (await listPets(withBuiltIns(store).pets().dirs)).pets
    expect(all.map((pet) => pet.ref)).toEqual([MENDGIRL, ...own])
    expect(all[0]).toMatchObject({ id: "mendgirl", displayName: "MendGirl", layout: { art: "smooth", cell: { width: 200, height: 198 }, columns: 6 } })
  })

  test("its sheet decodes into 200 x 198 frames for every state, with the layout's timings, cached under its own name", async () => {
    const cacheDir = tempDir("mcev-mendgirl-cache-")
    const pet = BUILT_IN_PETS[0]!
    const sprite = await loadSprite({ pet, cacheDir })
    const layout = pet.layout!
    expect([...sprite.rows.keys()].sort()).toEqual(Object.keys(layout.states).sort())
    for (const [row, frames] of sprite.rows) {
      expect(frames.length, row).toBe(layout.states[row as keyof typeof layout.states]!.length)
      for (const frame of frames) expect([frame.width, frame.height, frame.rgba.byteLength]).toEqual([200, 198, 200 * 198 * 4])
      expect(sprite.timing?.get(row)).toEqual(layout.states[row as keyof typeof layout.states]!.map(([, ms]) => ms))
    }
    // A drawn frame is not empty, and its corners are transparent.
    const idle = sprite.rows.get("idle")![0]!
    expect(idle.rgba[3]).toBe(0)
    expect(idle.rgba.filter((_, at) => at % 4 === 3 && idle.rgba[at]! > 0).length).toBeGreaterThan(200 * 198 / 4)
    expect(readdirSync(cacheDir).filter((name) => name.endsWith(".sprite"))).toEqual([expect.stringMatching(/^builtin\+mendgirl-[0-9a-z]+\.sprite$/)])
  })

  test("its sheet is in Ink's neutrals: no frame keeps the old brand's mint or green", async () => {
    const sprite = await loadSprite({ pet: BUILT_IN_PETS[0]!, cacheDir: tempDir("mcev-mendgirl-green-") })
    let green = 0
    for (const frame of new Set([...sprite.rows.values()].flat())) {
      const { rgba } = frame
      for (let at = 0; at < rgba.length; at += 4) {
        const [r, g, b] = [rgba[at]!, rgba[at + 1]!, rgba[at + 2]!]
        // Clearly green: green leads both other channels by a visible margin.
        if (rgba[at + 3]! >= 128 && g - Math.max(r, b) > 16) green++
      }
    }
    // The old sheet had about 240,000 such pixels; the lossy WebP leaves a few stray ones at colored edges.
    expect(green).toBeLessThan(20)
  })

  test("beside the prompt it degrades like any detailed imported pet: a picture with an image protocol, the ASCII Mend in half blocks", async () => {
    const slot = createPetSlot({ dirs: [BUILT_IN], cacheDir: tempDir("mcev-mendgirl-slot-"), now: () => 0, reducedMotion: () => true, onChange() {}, say(message) { throw new Error(message) } })
    await slot.choose(MENDGIRL)
    for (const size of ["small", "medium", "large"] as const) expect(slot.halfBlockLegible(size), size).toBe(false)
    const drawn = slot.draw()!
    expect(drawn.image?.image.width).toBe(drawn.cols * 8)
    expect(drawn.lines).toHaveLength(drawn.rows)
    slot.stop()
  })

  test("is a valid pet and mascot reference, and never the default", () => {
    expect(isPetMascot(MENDGIRL)).toBe(true)
    expect(normalizeHomeMascot(MENDGIRL)).toBe(MENDGIRL)
    expect(tuiProblems({ homeMascot: MENDGIRL })).toEqual([])
    expect(DEFAULT_TUI_PROFILE).toMatchObject({ homeMascot: "mend", pet: "" })
  })

  test("/pet lists it right after MendAscii as Built-in, without rename or delete; enter chooses it, and /mascot mendgirl puts it on the start screen", async () => {
    const store = withBuiltIns(petStore())
    const { h } = await mascotScene({ store, graphics: { env: { TERM_PROGRAM: "ghostty" } } })
    await h.type("/pet\r")
    // Its preview decodes the sheet once: the list arrives when that is done.
    for (let turn = 0; turn < 50 && !h.text().join("\n").includes("MendGirl"); turn++) {
      await Bun.sleep(40)
      h.app.render()
    }
    await h.type("\x1b[B")
    h.app.render()
    const rows = h.text()
    const ascii = rows.findIndex((row) => / MendAscii {3,}/.test(row))
    expect(ascii).toBeGreaterThanOrEqual(0)
    expect(rows[ascii + 1]).toMatch(/ MendGirl {3,}/)
    const page = rows.join("\n")
    expect(page).toContain("MendGirl · Source: Built-in")
    expect(page).not.toContain("d delete")
    await h.type("\r")
    expect(readTuiProfile(store.dir)).toMatchObject({ pet: MENDGIRL, homeMascot: MENDGIRL })
    await h.type("\x1b")
    await h.type("/mascot mend\r")
    await Bun.sleep(20)
    expect(readTuiProfile(store.dir).homeMascot).toBe("mend")
    await h.type("/mascot mendgirl\r")
    await Bun.sleep(40)
    expect(readTuiProfile(store.dir)).toMatchObject({ logoKind: "both", homeMascot: MENDGIRL })
  }, 20_000)

  test("without a terminal that draws images, /pet shows MendGirl unavailable with its reason, enter does not choose her, and the ASCII Mend stays", async () => {
    const store = withBuiltIns(petStore())
    const { h } = await mascotScene({ store })
    await h.type("/pet\r")
    for (let turn = 0; turn < 50 && !h.text().join("\n").includes("MendGirl"); turn++) {
      await Bun.sleep(40)
      h.app.render()
    }
    await h.type("\x1b[B")
    h.app.render()
    expect(h.text().join("\n")).toContain(`Unavailable here: ${IMAGE_ONLY_REASON}`)
    await h.type("\r")
    h.app.render()
    expect(readTuiProfile(store.dir)).toMatchObject({ pet: "", homeMascot: "mend" })
    expect(h.text().join("\n")).toContain("MendGirl")
  }, 20_000)

  test("a saved choice of MendGirl in a terminal without images shows MendAscii on the start screen and loads no pet, and the choice is kept", async () => {
    const store = withBuiltIns(petStore())
    const { h, frame, placement } = await mascotScene({ store, ref: MENDGIRL })
    h.app.render()
    expect(h.app.mascotAnimating).toBe(false)
    expect(placement()).toBeUndefined()
    expect(hasHalfBlocks(frame())).toBe(true)
    expect(readTuiProfile(store.dir)).toMatchObject({ homeMascot: MENDGIRL })
    expect(h.text().join("\n")).not.toContain("Pet not found")
  }, 20_000)
})

describe("the default pet list", () => {
  test("is MendAscii and MendGirl only: a pets folder with a pet that repeats MendGirl by name or id lists the built-in alone", async () => {
    const store = petStore()
    await store.importPath(path.join(import.meta.dir, "fixtures", "pets", "tiny", "spritesheet.png"), { name: "MendGirl" })
    await store.importPath(path.join(import.meta.dir, "fixtures", "pets", "tiny", "spritesheet.png"), { name: "Other" })
    const listed = await listPets(withBuiltIns(store).pets().dirs)
    expect(listed.pets.map((pet) => pet.displayName)).toEqual(["MendGirl", "Other"])
    expect(listed.pets[0]!.ref).toBe(MENDGIRL)
    expect(listed.skipped.some((entry) => entry.reason.includes("repeats the built-in pet MendGirl"))).toBe(true)
    expect((await listPets([BUILT_IN])).pets.map((pet) => pet.ref)).toEqual([MENDGIRL])
  })

  test("the image gate: MendGirl needs pictures, every other pet does not; without pictures she is MendAscii", () => {
    expect(petNeedsImages(MENDGIRL)).toBe(true)
    expect(petNeedsImages("user:photo")).toBe(false)
    expect(petNeedsImages("mend")).toBe(false)
    expect(usablePetRef(MENDGIRL, true)).toBe(MENDGIRL)
    expect(usablePetRef(MENDGIRL, false)).toBe("mend")
    expect(usablePetRef("user:photo", false)).toBe("user:photo")
    expect(usablePetRef("", false)).toBe("")
  })

  test("the picker ignores enter and space on an unavailable pet, and still turns the shown pet off with space elsewhere", () => {
    const choices = [{ ref: "builtin:x", name: "X", description: "", disabled: IMAGE_ONLY_REASON }, { ref: "user:y", name: "Y", description: "" }]
    expect(petPickerKey({ selected: 0 }, "\r", choices, "").action).toEqual({ type: "none" })
    expect(petPickerKey({ selected: 0 }, " ", choices, "user:y").action).toEqual({ type: "none" })
    expect(petPickerKey({ selected: 1 }, "\r", choices, "").action).toEqual({ type: "choose", ref: "user:y" })
    expect(petPickerKey({ selected: 1 }, " ", choices, "user:y").action).toEqual({ type: "choose", ref: "off" })
  })
})
