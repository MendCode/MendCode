/**
 * The start screen with an imported pet as its mascot, through the real pieces: the daemon's import (`pet-generator.ts`)
 * writes the pet into a data directory, the app harness draws the home from it. Shared by the tests and by
 * `scripts/render-mascot-docs.ts`; nothing here makes an image call.
 */
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { Settings } from "@mendcode/protocol"
import { createBudgets } from "../../../packages/daemon/src/budgets"
import { createPetGenerator } from "../../../packages/daemon/src/pet-generator"
import { encodeImagePng } from "../../../packages/tools/src/pet-png"
import type { PetImage } from "../src/pets/decode"
import type { ImagePlacement } from "../src/ui/image-layer"
import type { Line } from "../src/ui/theme"
import { DEFAULT_TUI_PROFILE, writeTuiProfile, type TuiProfile } from "../src/view/tui-profile"
import { appHarness, tempDir } from "./session-ui-harness"

type ImportInput = { name?: string; frames?: { columns: number; rows: number }; key?: boolean; filter?: "pixel" | "smooth"; ms?: number }
export type Imported = { petId: string; ref: string; name: string; art: string; frames: number; cell: { width: number; height: number }; states: string[]; keyed: boolean; decodedBytes: number; storedBytes: number; notes: string[] }

/** A data directory and the daemon's pet manager over it. */
export function petStore(settings: Settings = { tier: "full" }) {
  const dir = tempDir("mcev-q-pets-")
  const budgets = createBudgets({ dir, settings: () => settings, seed: () => ({ costMicros: 0, knownCalls: 0, unknownCalls: 0 }) })
  let calls = 0
  const generator = createPetGenerator({ dir, settings: () => settings, budgets, image: () => async () => { calls++; throw new Error("no image call is made by an import") } })
  return {
    dir,
    generator,
    get imageCalls() { return calls },
    pets: (images = false) => ({ dirs: [{ dir: path.join(dir, "pets"), source: "user" as const }], cacheDir: path.join(dir, "cache"), images }),
    /** Imports a picture already on disk. */
    importPath: async (file: string, input: ImportInput = {}) => (await generator.manage("scene", { action: "import", path: file, ...input })) as unknown as Imported,
    /** Writes `image` as a PNG beside the store and imports it. */
    async importImage(image: PetImage, input: ImportInput & { file?: string } = {}) {
      const { file, ...rest } = input
      const source = path.join(tempDir("mcev-q-src-"), file ?? "character.png")
      writeFileSync(source, encodeImagePng(image))
      return (await generator.manage("scene", { action: "import", path: source, ...rest })) as unknown as Imported
    },
  }
}
export type PetStore = ReturnType<typeof petStore>

/** A screen that takes an image layer, as a terminal with a graphics protocol does: the app then places pictures instead of half blocks. */
function graphicsScreen(width: number, height: number) {
  let layer: { protocol?: string } | undefined
  return {
    size: { width, height },
    draw() {},
    write() {},
    setTitle() {},
    get imageProtocol() { return layer?.protocol ?? "off" },
    setImages(next?: { protocol?: string }) { layer = next },
  }
}

/**
 * The start screen of a new session with `ref` as its mascot, after the pet has loaded. `graphics` gives the terminal an
 * image protocol (and the size of one cell in pixels); without it the mascot is half blocks.
 */
export async function mascotScene(input: { store: PetStore; ref?: string; width?: number; height?: number; profile?: Partial<TuiProfile> | "saved"; settings?: object; env?: Record<string, string>; graphics?: { env: Record<string, string>; cell?: { width: number; height: number } }; directory?: string; version?: string }) {
  const [width, height] = [input.width ?? 100, input.height ?? 32]
  // `profile: "saved"` starts the app on the profile file already in the data directory.
  if (input.profile !== "saved") writeTuiProfile(input.store.dir, { ...DEFAULT_TUI_PROFILE, ...(input.ref ? { logoKind: "both" as const, homeMascot: input.ref } : {}), ...(input.profile as Partial<TuiProfile> | undefined) })
  const directory = input.directory ?? tempDir("mcev-q-project-")
  mkdirSync(directory, { recursive: true })
  const env = { COLORTERM: "truecolor", ...input.graphics?.env, ...input.env }
  const h = appHarness({
    dataDir: input.store.dir, directory, width, height, mode: "full", pets: input.store.pets(), env,
    ...(input.version ? { version: input.version } : {}),
    ...(input.graphics ? { screen: graphicsScreen(width, height) as never, ...(input.graphics.cell ? { imageAnswers: { cellPixels: input.graphics.cell } } : {}) } : {}),
    reply: async (command) => {
      if (command.type === "packages.list") return { ok: true, result: { directory, packages: [] } }
      if (command.type !== "pet.manage") return { ok: true }
      // As the daemon answers: a refused operation is a reply, not a thrown error.
      try { return { ok: true, result: await input.store.generator.manage("scene", command.input) } }
      catch (error) { return { ok: false, error: { code: "invalid_command", message: error instanceof Error ? error.message : "Pet operation failed" } } as never }
    },
  })
  h.app.applySettings({ onboarded: true, tier: "full", ...input.settings })
  await h.app.imagesReady
  // The pet module, the folder listing and the sheet load in turn; each asks for a frame when it is done.
  for (let turn = 0; turn < 8; turn++) {
    h.app.render()
    await Bun.sleep(15)
  }
  h.app.render()
  await Bun.sleep(0)
  return { h, frame: (): Line[] => h.frames.at(-1)!, placement: (): ImagePlacement | undefined => h.placements.at(-1)?.find((placement) => placement.slot === "home-pet") }
}

export const hasHalfBlocks = (lines: readonly Line[]) => lines.some((line) => line.some((span) => span.fgHex !== undefined && /[▀▄]/.test(span.text)))
