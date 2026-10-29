import type { Line } from "../ui/theme"
import type { PetImage } from "../pets/decode"
import { pixelFit } from "../pets/frames"
import { toHalfBlocks } from "../pets/halfblock"
import type { ImagePlacement } from "../ui/image-layer"
import { isWide } from "../ui/breakpoints"
import { boxPanel, beside } from "./deck"
import { appearancePage, focusedWindow } from "./appearance-layout"
import { rowsWidth } from "./logo-fonts"
import { textWidth, terminalText } from "./wrap"
import { actionRow, renderPetPlan } from "./pet-plan"
import { PET_GENERATED_STATES, type PetPlan, type PetProgress } from "../../../../packages/protocol/src/pet-data"

/** One installed pet as `/pet` lists it; `image` is native RGBA; `preview` is text-cell art. */
export type PetChoice = { ref: string; name: string; description: string; source?: string; states?: string[]; /** States the generator drew; the other atlas rows repeat idle. */ generated?: string[]; /** Made by `/pet import`: `preview` is its half-block picture, already resized for its kind of art. */ imported?: boolean; preview?: Line[]; image?: PetImage; /** The cells `image` is drawn in: every pet's share of the preview box (`pet-slot.ts`). */ cells?: { cols: number; rows: number } }
export type PetPickerState = { selected: number; /** The generated pet's highlighted state, for `r`. */ state?: number }
/** `fill` closes the page and puts a slash command in the editor: regenerate, rename and delete reuse the commands that already confirm. */
export type PetPickerAction = { type: "none" } | { type: "close" } | { type: "choose"; ref: string } | { type: "fill"; text: string }

export function createPetPickerState(choices: readonly PetChoice[], current: string | undefined): PetPickerState {
  return { selected: Math.max(0, choices.findIndex((choice) => choice.ref === current)) }
}

/** Only pets the generator made get the state list and actions; installed bitmap pets keep the plain source/states card. */
function isGenerated(choice: PetChoice): boolean {
  return choice.ref.startsWith("user:") && choice.generated !== undefined
}

export function petPickerKey(state: PetPickerState, key: string, choices: readonly PetChoice[]): { state: PetPickerState; action: PetPickerAction } {
  const move = (by: number) => ({ state: { selected: Math.min(Math.max(0, choices.length - 1), Math.max(0, state.selected + by)) }, action: { type: "none" } as const })
  if (key === "\x1b" || key === "q") return { state, action: { type: "close" } }
  if (key === "\x1b[A" || key === "k") return move(-1)
  if (key === "\x1b[B" || key === "j") return move(1)
  if (key === "o") return { state, action: { type: "choose", ref: "off" } }
  const chosen = choices[state.selected]
  if (chosen && isGenerated(chosen)) {
    const at = Math.min(state.state ?? 0, PET_GENERATED_STATES.length - 1)
    const step = (by: number) => ({ state: { ...state, state: Math.min(PET_GENERATED_STATES.length - 1, Math.max(0, at + by)) }, action: { type: "none" } as const })
    if (key === "\x1b[C" || key === "l") return step(1)
    if (key === "\x1b[D" || key === "h") return step(-1)
    if (key === "r") return { state, action: { type: "fill", text: `/pet regen ${chosen.ref} ${PET_GENERATED_STATES[at]}` } }
    if (key === "n") return { state, action: { type: "fill", text: `/pet rename ${chosen.ref} ` } }
    if (key === "d") return { state, action: { type: "fill", text: `/pet delete ${chosen.ref} --confirm` } }
  }
  // An imported pet is the user's too: the same rename and delete, through the commands that confirm.
  if (chosen?.imported) {
    if (key === "n") return { state, action: { type: "fill", text: `/pet rename ${chosen.ref} ` } }
    if (key === "d") return { state, action: { type: "fill", text: `/pet delete ${chosen.ref} --confirm` } }
  }
  if (key === "\r" && chosen) return { state, action: { type: "choose", ref: chosen.ref } }
  return { state, action: { type: "none" } }
}

/** Panel geometry shared with PNG probes. Coordinates include the page's two-cell inset and header. */
export function petPreviewBox(width: number, height: number, count: number) {
  const inner = Math.max(8, width - 4)
  const available = Math.max(6, height - 2)
  const wide = isWide(width)
  const listWidth = wide ? Math.min(48, Math.floor(inner / 3)) : inner
  const gap = height < 26 ? 0 : 1
  const listHeight = wide ? available : Math.min(Math.max(4, count + 3), Math.max(4, Math.floor(available / 3)))
  return { listWidth, listHeight, width: wide ? inner - listWidth - 2 : inner, height: wide ? available : available - listHeight - gap, col: wide ? 2 + listWidth + 2 : 2, row: wide ? 2 : 2 + listHeight + gap, gap, wide }
}

function wordRows(text: string, width: number): Line[] {
  const rows: Line[] = []
  let row = ""
  for (const word of terminalText(text).split(" ")) {
    if (row && textWidth(row + " " + word) > width) { rows.push([{ text: row, fg: "muted" }]); row = "" }
    row += (row ? " " : "") + word
  }
  if (row) rows.push([{ text: row, fg: "muted" }])
  return rows
}

/**
 * A generated pet: the sprite at its real size (32 cells by 16 rows, or an exact integer division when the terminal is short)
 * beside one row per state saying whether it was drawn or repeats idle, then the actions.
 */
function generatedPreview(input: { choice: PetChoice; panel: ReturnType<typeof petPreviewBox>; cols: number; state: number; tall: boolean; graphics: boolean; placements: ImagePlacement[] | undefined }): Line[] {
  const { choice, panel, cols } = input
  const drawn = new Set(choice.generated ?? [])
  const head: Line[] = [[{ text: terminalText(choice.name), fg: "primary", bold: true }, { text: " · experimental", fg: "muted" }], ...(input.tall ? wordRows(choice.description, cols).slice(0, 2) : []), []]
  const room = Math.max(0, panel.height - 2 - head.length - 2)
  const image = choice.image
  const fit = image && room > 0 ? pixelFit(image, Math.max(1, Math.min(cols - 26, 32)), Math.max(1, Math.min(room, 16)) * 2) : undefined
  const artCols = fit?.width ?? 0
  const artRows = fit ? fit.height / 2 : 0
  let art: Line[] = []
  if (fit && image) {
    if (input.graphics) {
      art = Array.from({ length: artRows }, (): Line => [])
      input.placements?.push({ slot: "pet-preview", key: `${choice.ref}/idle/0/preview`, image, row: panel.row + 1 + head.length, col: panel.col + 2, cols: artCols, rows: artRows })
    } else art = toHalfBlocks(image, artCols, artRows)
  } else art = [[{ text: image ? "Enlarge terminal for pixel preview" : "Preview unavailable", fg: "muted" }]]
  const states: Line[] = PET_GENERATED_STATES.map((name, index): Line => [
    { text: index === input.state ? "▸ " : "  ", fg: "primary" },
    { text: name.padEnd(9), fg: index === input.state ? "primary" : "text", bold: index === input.state },
    { text: drawn.has(name) ? "generated" : "fallback idle", fg: "muted" },
  ])
  const block = beside([{ lines: art, width: Math.max(artCols, fit ? 0 : cols - 26) }, { lines: states, width: 26 }], 3)
  return [...head, ...block, [], actionRow([["r", "regenerate state"], ["n", "rename"], ["d", "delete"], ["enter", "use"]])]
}

/** Crisp bitmap preview or the official text mascot, never converted to an image. */
export function renderPetPicker(input: { choices: readonly PetChoice[] | undefined; current: string | undefined; state: PetPickerState; width: number; height: number; graphics?: boolean; placements?: ImagePlacement[]; plan?: PetPlan | undefined; progress?: PetProgress | undefined; busy?: boolean | undefined; error?: string | undefined; /** The same list choosing the start screen's mascot (`/mascot`) instead of the prompt's pet. */ mascot?: boolean }): Line[] {
  if (input.plan) return renderPetPlan({ plan: input.plan, width: input.width, height: input.height, progress: input.progress, ...(input.busy ? { busy: true } : {}), ...(input.error ? { error: input.error } : {}) })
  const { choices, state, width, height } = input
  const panel = petPreviewBox(width, height, choices?.length ?? 0)
  const selected = choices?.[state.selected]
  const listRows = choices?.map((choice, index): Line => [
    { text: index === state.selected ? "❯ " : "  ", fg: "primary" },
    { text: choice.ref === input.current ? "● " : "  ", fg: "success" },
    { text: terminalText(choice.name), fg: index === state.selected ? "primary" : "text", bold: index === state.selected },
  ]) ?? [[{ text: "Loading pets…", fg: "muted" }]]
  const list = boxPanel({ title: "Pets", body: focusedWindow(listRows, state.selected, panel.listHeight - 3), width: panel.listWidth, height: panel.listHeight, compact: true })
  const cols = panel.width - 4
  if (selected && isGenerated(selected)) {
    // The card is as tall as its content; beside it the list shrinks to match instead of running to the bottom of the page.
    const content = generatedPreview({ choice: selected, panel, cols, state: state.state ?? 0, tall: height >= 26, graphics: input.graphics === true, placements: input.placements })
    const cardHeight = Math.min(panel.height, content.length + 2)
    const preview = boxPanel({ body: content, width: panel.width, height: cardHeight, compact: true })
    const listHeight = panel.wide ? Math.min(panel.listHeight, Math.max(cardHeight, (choices?.length ?? 0) + 3)) : panel.listHeight
    const shortList = boxPanel({ title: "Pets", body: focusedWindow(listRows, state.selected, listHeight - 3), width: panel.listWidth, height: listHeight, compact: true })
    const body = panel.wide ? beside([{ lines: shortList, width: panel.listWidth }, { lines: preview, width: panel.width }], 2) : [...list, ...Array.from({ length: panel.gap }, (): Line => []), ...preview]
    return appearancePage({ title: input.mascot ? "Mascot" : "Pet", subtitle: `now ${choices?.find((choice) => choice.ref === input.current)?.name ?? "off"} · ${choices?.length} available`, body, hints: "↑↓ pet · ←→ state · esc back", width, height })
  }
  const info: Line[] = selected ? [
    [{ text: terminalText(selected.name), fg: "primary", bold: true }, { text: terminalText(` · Source: ${selected.source ?? selected.ref}`), fg: "muted" }],
    ...(height >= 26 ? wordRows(selected.description, cols) : []),
    ...wordRows(`States: ${(selected.states ?? []).join(", ")}`, cols),
  ] : []
  const rows = Math.max(0, panel.height - 2 - info.length)
  let art = selected?.preview ?? []
  let graphicsArt = false
  if (selected?.image && rows > 0) {
    const image = selected.image
    const artCols = Math.min(cols, selected.cells?.cols ?? 32)
    const artRows = Math.min(rows, selected.cells?.rows ?? 16)
    if (input.graphics) {
      art = []
      graphicsArt = true
      // Every pet stands on the same floor: the bottom of the 16-row stage, centered in the free rows.
      const stage = Math.min(rows, 16)
      input.placements?.push({ slot: "pet-preview", key: `${selected.ref}/idle/0/preview`, image, row: panel.row + 1 + info.length + Math.floor((rows - stage) / 2) + stage - artRows, col: panel.col + 2 + Math.floor((cols - artCols) / 2), cols: artCols, rows: artRows })
    } else if (selected.preview) art = selected.preview.slice(0, rows)
    else if (pixelFit(image, artCols, artRows * 2)) art = toHalfBlocks(image, artCols, artRows)
    else art = [[{ text: "Enlarge terminal for pixel preview", fg: "muted" }]]
  } else if (selected && !selected.image && !selected.preview) art = [[{ text: "Preview unavailable", fg: "muted" }]]
  // ASCII is kept at one character per cell and centered, with no resampling.
  if (!graphicsArt) {
    const pad = Math.max(0, Math.floor((cols - rowsWidth(art.map((line) => line.map((span) => span.text).join("")))) / 2))
    art = art.map((line) => [{ text: " ".repeat(pad) }, ...line])
    const top = Math.max(0, Math.floor((rows - art.length) / 2))
    art = [...Array.from({ length: top }, (): Line => []), ...art]
  }
  const preview = boxPanel({ body: [...info, ...art], width: panel.width, height: panel.height, compact: true })
  const body = panel.wide ? beside([{ lines: list, width: panel.listWidth }, { lines: preview, width: panel.width }], 2) : [...list, ...Array.from({ length: panel.gap }, (): Line => []), ...preview]
  const current = choices?.find((choice) => choice.ref === input.current)?.name ?? "off"
  const own = selected?.imported ? " · n rename · d delete" : ""
  return appearancePage({ title: input.mascot ? "Mascot" : "Pet", subtitle: `now ${current}${choices ? ` · ${choices.length} available` : ""}`, body, hints: input.mascot ? `↑↓ select · enter start screen · o title only${own} · esc back` : `↑↓ select · enter choose · o off${own} · esc back`, width, height })
}
