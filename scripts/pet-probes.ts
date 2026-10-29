import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { decodeSheet } from "../apps/cli/src/pets/decode"
import { frame, sizePet, pixelFit, DEFAULT_CELL_PIXELS, HALF_BLOCK_PIXELS } from "../apps/cli/src/pets/frames"
import { encodeImagePng } from "../apps/cli/src/ui/image-protocol"
import { renderPetPicker } from "../apps/cli/src/view/pet-picker"
import type { ImagePlacement } from "../apps/cli/src/ui/image-layer"
import { PET_BOX } from "../apps/cli/src/pets/pet-slot"
import { SPRITE_ROWS } from "../apps/cli/src/pets/sprite"

/** Same decoded atlas cell and sizing function the app sends; no terminal, providers, or persistent cache. */
export async function writePetProbes(directory: string, greenie: string) {
  mkdirSync(directory, { recursive: true })
  const manifest = JSON.parse(readFileSync(path.join(greenie, "pet.json"), "utf8"))
  const image = frame(await decodeSheet(path.join(greenie, manifest.spritesheetPath)), "idle", 0)
  const sizes: Record<string, unknown> = { source: { width: image.width, height: image.height }, cellPixels: DEFAULT_CELL_PIXELS }
  const write = (name: string, cols: number, rows: number, cell = DEFAULT_CELL_PIXELS) => {
    const out = sizePet(image, cols, rows, cell)
    writeFileSync(path.join(directory, `${name}.png`), encodeImagePng(out))
    // A second probe composites transparency over Mend's terminal background for viewers that ignore PNG alpha.
    const rgba = new Uint8Array(out.rgba.length)
    for (let i = 0; i < rgba.length; i += 4) {
      const alpha = out.rgba[i + 3]! / 255
      for (let k = 0; k < 3; k++) rgba[i + k] = Math.round(out.rgba[i + k]! * alpha + [8, 17, 13][k]! * (1 - alpha))
      rgba[i + 3] = 255
    }
    writeFileSync(path.join(directory, `${name}-mend-background.png`), encodeImagePng({ ...out, rgba }))
    sizes[name] = { cols, rows, cellPixels: cell, fit: pixelFit(image, out.width, out.height) }
  }
  writeFileSync(path.join(directory, "greenie-native.png"), encodeImagePng(image))
  write("greenie-chat", PET_BOX.cols, PET_BOX.rows)
  write("greenie-chat-halfblock", 24, 13, HALF_BLOCK_PIXELS)
  for (const [width, height] of [[100, 30], [180, 50]]) {
    const placements: ImagePlacement[] = []
    renderPetPicker({ choices: [{ ref: "mend", name: "Mend", description: "" }, { ref: "codex:greenie", name: manifest.displayName, description: manifest.description, source: "codex", states: [...SPRITE_ROWS], image }], current: "codex:greenie", state: { selected: 1 }, width: width!, height: height! - 1, graphics: true, placements })
    const preview = placements[0]!
    write(`greenie-preview-${width}x${height}`, preview.cols, preview.rows)
    write(`greenie-preview-halfblock-${width}x${height}`, preview.cols, preview.rows, HALF_BLOCK_PIXELS)
  }
  writeFileSync(path.join(directory, "pixels.json"), JSON.stringify(sizes, null, 2) + "\n")
}

if (import.meta.main) {
  const [directory, greenie] = process.argv.slice(2)
  if (!directory || !greenie) throw new Error("usage: pet-probes.ts <output-dir> <greenie-dir>")
  await writePetProbes(directory, greenie)
}
