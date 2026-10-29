/**
 * The pictures of the start-screen mascot in docs/customize.md, exported from the real code: a placeholder character
 * built by arithmetic (`apps/cli/test/mascot-sample.ts`, not artwork) is imported through the daemon's `/pet import`, the
 * app harness draws the start screen with it, and `mascot-raster.ts` turns those rows (and, for a terminal with an image
 * protocol, the picture the image layer would send) into pixels. No image generator is involved. Usage:
 *
 *   bun scripts/render-mascot-docs.ts [directory] [--evidence]
 *
 * The directory defaults to docs/assets. It writes `mascot-welcome.png` (the start screen with the picture drawn by the
 * terminal's image protocol), `mascot-welcome-halfblocks.png` (the same in half blocks) and `mascot-compare.png` (pixel art
 * and smooth art, in half blocks and through the image protocol, at the three sizes). `--evidence` adds the inputs, every
 * input at every size, the other layouts, themes and color depths, used to review a change to the resizing.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { hasHalfBlocks, mascotScene, petStore, type Imported, type PetStore } from "../apps/cli/test/mascot-scene"
import { onBackground, sampleSprite, sheetOf, smoothSample } from "../apps/cli/test/mascot-sample"
import { cleanTemps, plain } from "../apps/cli/test/session-ui-harness"
import type { PetImage } from "../apps/cli/src/pets/decode"
import { createHomePet, HOME_PET_SIZES, type HomePetSize } from "../apps/cli/src/pets/home-pet"
import { activeTheme, setTheme, type Line } from "../apps/cli/src/ui/theme"
import type { TuiProfile } from "../apps/cli/src/view/tui-profile"
import { encodeImagePng } from "../packages/tools/src/pet-png"
import { overlayImage, rasterLines, rasterRow, type Raster } from "./mascot-raster"

const output = path.resolve(process.argv.slice(2).find((arg) => !arg.startsWith("--")) ?? path.join(import.meta.dir, "../docs/assets"))
const evidence = process.argv.includes("--evidence")
mkdirSync(output, { recursive: true })

/** The project the screen names on its first row; made for the run and removed after it. */
const PROJECT = "/tmp/mcev-q-demo/acme-api"
/** A terminal with the kitty graphics protocol, and a cell of 10 x 20 pixels (the raster's cell, so the picture maps one to one). */
const CELL = 10
const KITTY = { env: { TERM_PROGRAM: "ghostty" }, cell: { width: CELL, height: CELL * 2 } }
const save = (name: string, image: Raster) => writeFileSync(path.join(output, name), encodeImagePng(image))
const theme = () => ({ background: activeTheme().background, colors: activeTheme().colors })

/** The start screen as pixels: its rows, and over them the picture when the terminal draws it. */
async function welcome(input: { store: PetStore; ref: string; width: number; height: number; graphics?: boolean; profile?: Partial<TuiProfile>; env?: Record<string, string>; depth?: "truecolor" | "256" }): Promise<{ raster: Raster; lines: Line[]; picture: boolean }> {
  const scene = await mascotScene({ store: input.store, ref: input.ref, width: input.width, height: input.height, directory: PROJECT, version: "2.0.0", ...(input.profile ? { profile: input.profile } : {}), ...(input.env ? { env: input.env } : {}), ...(input.graphics ? { graphics: KITTY } : {}) })
  const lines = scene.frame()
  const raster = rasterLines(lines, { cols: input.width, rows: input.height, theme: theme(), cell: CELL, ...(input.depth ? { depth: input.depth } : {}) })
  const placed = scene.placement()
  if (placed) overlayImage(raster, placed.image, placed, CELL)
  return { raster, lines, picture: placed !== undefined || hasHalfBlocks(lines) }
}

const stack = (parts: Raster[]): Raster => {
  const width = Math.max(...parts.map((part) => part.width))
  const height = parts.reduce((sum, part) => sum + part.height, 0)
  const out: Raster = { width, height, rgba: new Uint8Array(width * height * 4) }
  const background = rasterLines([], { cols: 1, rows: 1, theme: theme(), cell: 1 }).rgba.subarray(0, 4)
  for (let at = 0; at < width * height; at++) out.rgba.set(background, at * 4)
  let y = 0
  for (const part of parts) {
    for (let row = 0; row < part.height; row++) out.rgba.set(part.rgba.subarray(row * part.width * 4, (row + 1) * part.width * 4), ((y + row) * width) * 4)
    y += part.height
  }
  return out
}

/** One pet at one size, twice: its half blocks, and the picture an image protocol shows in the same box; a caption under each. */
async function compare(store: PetStore, pet: Imported, size: HomePetSize, label: string, cell = CELL): Promise<Raster> {
  const home = createHomePet({ ...store.pets(), now: () => 0, moving: () => false, onChange() {} })
  await home.choose(pet.ref)
  const box = home.boxes(size)[0]!
  const cols = HOME_PET_SIZES.large.cols + 2
  const rows = HOME_PET_SIZES[size].rows + 3
  const left = Math.floor((cols - box.cols) / 2)
  const caption = (text: string): Line[] => [[], [{ text: ` ${text}`, fg: "muted" }]]
  const blocks = rasterLines([[], ...home.lines(box.cols, box.rows).map((line): Line => [{ text: " ".repeat(left) }, ...line]), ...caption(`${label} ${size} half blocks ${box.cols}x${box.rows}`)], { cols, rows, theme: theme(), cell })
  const picture = rasterLines([[], ...Array.from({ length: box.rows }, (): Line => []), ...caption(`${label} ${size} image protocol`)], { cols, rows, theme: theme(), cell })
  overlayImage(picture, home.image(box.cols, box.rows, { width: cell, height: cell * 2 })!.image, { row: 1, col: left, cols: box.cols, rows: box.rows }, cell)
  home.stop()
  return rasterRow([blocks, picture], 0, activeTheme().background)
}

try {
  setTheme("mend")
  const store = petStore()
  const pixel = sampleSprite()
  const smooth = smoothSample()
  const inputs: Array<[string, PetImage, Parameters<PetStore["importImage"]>[1]]> = [
    ["a-pixel-64", pixel, { name: "Pixel sample" }],
    ["b-smooth-512", smooth, { name: "Smooth sample" }],
    ["c-smooth-flat-background-512", onBackground(smooth, [120, 200, 240]), { name: "Keyed smooth sample" }],
    ["c-pixel-flat-background-64", onBackground(pixel, [255, 0, 255]), { name: "Keyed pixel sample" }],
    ["d-pixel-sheet-4x1", sheetOf([sampleSprite(), sampleSprite({ lift: 1 }), sampleSprite({ eyes: "closed", lift: 1 }), sampleSprite({ eyes: "closed" })]), { name: "Animated sample", frames: { columns: 4, rows: 1 }, ms: 220 }],
  ]
  const pets = new Map<string, Imported>()
  for (const [name, image, options] of inputs) {
    pets.set(name, await store.importImage(image, { ...options, file: `${name}.png` }))
    if (evidence) writeFileSync(path.join(output, `input-${name}.png`), encodeImagePng(image))
  }
  const [pixelPet, smoothPet] = [pets.get("a-pixel-64")!, pets.get("b-smooth-512")!]

  save("mascot-welcome.png", (await welcome({ store, ref: smoothPet.ref, width: 100, height: 32, graphics: true })).raster)
  save("mascot-welcome-halfblocks.png", (await welcome({ store, ref: smoothPet.ref, width: 100, height: 32 })).raster)
  save("mascot-compare.png", stack([await compare(store, pixelPet, "medium", "pixel art"), await compare(store, smoothPet, "medium", "smooth art"), await compare(store, smoothPet, "large", "smooth art")]))

  if (evidence) {
    const report: string[] = []
    for (const [name] of inputs) {
      const pet = pets.get(name)!
      report.push(`${name}: art=${pet.art} cell=${pet.cell.width}x${pet.cell.height} frames=${pet.frames} keyed=${pet.keyed} decoded=${pet.decodedBytes}B stored=${pet.storedBytes}B`)
      // At a 16-pixel-wide cell (a dense display) the picture has room to show what the box can hold.
      save(`sprite-${name}.png`, stack(await Promise.all((["small", "medium", "large"] as const).map((size) => compare(store, pet, size, name.slice(0, 1), 16)))))
    }
    for (const [name, ref] of [["pixel", pixelPet.ref], ["smooth", smoothPet.ref]] as const) {
      for (const size of ["small", "medium", "large"] as const) for (const graphics of [false, true]) {
        const shot = await welcome({ store, ref, width: 110, height: 40, graphics, profile: { mascotSize: size } })
        save(`welcome-${name}-${size}-${graphics ? "kitty" : "halfblocks"}-110x40.png`, shot.raster)
      }
      // Heights from tall to short at 100 columns: above the title, beside it, a smaller box, then the ASCII mascot.
      for (const height of [36, 32, 30, 28, 26, 24]) {
        const shot = await welcome({ store, ref, width: 100, height })
        save(`welcome-${name}-medium-halfblocks-100x${height}.png`, shot.raster)
        report.push(`welcome ${name} medium 100x${height}: ${shot.picture ? "picture" : "ASCII fallback"}`)
      }
    }
    save("welcome-smooth-256-colors-100x32.png", (await welcome({ store, ref: smoothPet.ref, width: 100, height: 32, depth: "256", env: { COLORTERM: "" } })).raster)
    save("welcome-smooth-narrow-80x32.png", (await welcome({ store, ref: smoothPet.ref, width: 80, height: 32 })).raster)
    save("welcome-smooth-mascot-only-80x32.png", (await welcome({ store, ref: smoothPet.ref, width: 80, height: 32, profile: { logoKind: "mascot" } })).raster)
    save("welcome-ascii-glyphs-100x32.png", (await welcome({ store, ref: smoothPet.ref, width: 100, height: 32, env: { MENDCODE_GLYPHS: "ascii" } })).raster)
    setTheme("paper")
    save("welcome-smooth-light-theme-kitty-100x32.png", (await welcome({ store, ref: smoothPet.ref, width: 100, height: 32, graphics: true })).raster)
    save("welcome-smooth-light-theme-halfblocks-100x32.png", (await welcome({ store, ref: smoothPet.ref, width: 100, height: 32 })).raster)
    setTheme("terminal")
    writeFileSync(path.join(output, "welcome-16-colors-100x32.txt"), `${(await welcome({ store, ref: smoothPet.ref, width: 100, height: 32 })).lines.map((line) => plain(line).trimEnd()).join("\n")}\n`)
    writeFileSync(path.join(output, "report.txt"), `${report.join("\n")}\nimage calls made: ${store.imageCalls}\n`)
  }
} finally {
  setTheme("mend")
  cleanTemps()
  rmSync("/tmp/mcev-q-demo", { recursive: true, force: true })
}
