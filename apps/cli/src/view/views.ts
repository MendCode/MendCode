import { HOST_OPTIONS_ROW, VIEW_SLOTS, type PromptFrameModel, type ViewModels, type ViewSlot } from "@mendcode/extension-api/views"
import { activeTheme, type Glyphs, type Line } from "../ui/theme"
import { BUILTIN_VIEWS, HOST_BLOCKS, builtinFrame, type BuiltinResult, type FrameParts } from "./view-builtins"
import { rebase, secure, validArgFor } from "./view-safety"

/**
 * The view-slot host (docs/views.md). Every part of the terminal that a user or package may redraw asks the host:
 * a custom view registered through the extension runtime answers first, then the built-in renderer of the same slot,
 * which receives the same typed input. A terminal without extensions never loads the runtime and pays one property read.
 *
 * Kept free of zod and of the extension runtime so the startup graph stays small (`test/footprint.test.ts`).
 */

/** A clickable region of a drawn view: cells `from..to` of `row` (relative to the first row of the view) run `action` on `arg`. */
export type ViewHit = { row: number; from: number; to: number; action: string; arg?: string | number }
export type Drawn = { lines: Line[]; hits: ViewHit[]; /** A custom view drew these lines. */ custom: boolean }

export type ViewEnvValues = { width: number; height: number; theme: { name: string; colors: Readonly<Record<string, string>> }; ascii: boolean; now: number }

/** What a custom view call returns to the host (see `extensions/views.ts`). */
export type CustomResult = { lines: Line[]; hits: ViewHit[] } | { frame: FrameParts }
export type ViewCallOptions = {
  /** The transcript item the view draws; part of the memo key. */
  id?: string
  /** How the result is remembered: `input` (the model and the clock), `static` (the model only: finished transcript items), `none` (streaming items). */
  memo?: "input" | "static" | "none"
  /** Adds data only a custom view needs (a pre-rendered body); called when a custom view will actually run. */
  prepare?: (model: never) => unknown
  /** Whether `arg` is acceptable for `action` of this model. */
  validArg(action: string, arg: string | number | undefined): boolean
}

/** What the lazily loaded runtime offers the host. */
export type CustomViews = {
  has(slot: ViewSlot): boolean
  call(slot: ViewSlot, model: unknown, env: ViewEnvValues, options: ViewCallOptions): CustomResult | undefined
}

export type LineSlot = Exclude<ViewSlot, "prompt.frame">
/** Where a view is drawn: the cells it may use, and for transcript items which item and what else its result depends on. */
export type DrawAt = { width: number; height: number; id?: string; memo?: ViewCallOptions["memo"]; prepare?: (model: never) => unknown; /** Terminal-side values for the built-in only (never shown to a custom view). */ extra?: Record<string, unknown> }

export type ViewHostOptions = {
  /** The runtime's views, once the extension modules loaded; read at every draw so a reload takes effect at once. */
  custom?: () => CustomViews | undefined
  glyphs: Glyphs
  ascii?: () => boolean
  now?: () => number
  /** Slots the user switched off (`disabledViews` in the profile). */
  disabled?: () => readonly string[]
}

const hostOptions = (slot: ViewSlot) => VIEW_SLOTS[slot].hostOptions === true
/** Slots whose custom view gets the built-in's rows (`builtin`), to add a line under a message instead of redrawing it. */
const WITH_BUILTIN: ReadonlySet<ViewSlot> = new Set(["message.user", "message.assistant", "turn.status"])

/**
 * A `hostOptions` slot's rows: the view's own rows with the terminal's option block in the place of the row that holds only
 * `{options}`, or under them when there is none. The block's rows and click regions are the terminal's alone: the view's regions
 * are not carried over (its actions are empty), and when the screen is short the view's rows are cut, never the block's.
 */
export function composeHostBlock(lines: Line[], block: { rows: Line[]; hits: ViewHit[] }, height: number): { lines: Line[]; hits: ViewHit[] } {
  const marker = lines.findIndex((line) => line.map((span) => span.text).join("").trim() === HOST_OPTIONS_ROW)
  let before = marker < 0 ? lines : lines.slice(0, marker)
  let after = marker < 0 ? [] : lines.slice(marker + 1)
  const room = Math.max(0, height - block.rows.length)
  before = before.slice(0, room)
  after = after.slice(0, Math.max(0, room - before.length))
  return { lines: [...before, ...block.rows, ...after], hits: block.hits.map((hit) => ({ ...hit, row: hit.row + before.length })) }
}

export function createViewHost(options: ViewHostOptions) {
  const live = (slot: ViewSlot) => {
    const custom = options.custom?.()
    return custom && !options.disabled?.().includes(slot) && custom.has(slot) ? custom : undefined
  }
  const env = (at: { width: number; height: number }): ViewEnvValues => {
    const theme = activeTheme()
    return { width: at.width, height: at.height, theme: { name: theme.name, colors: theme.colors }, ascii: options.ascii?.() ?? false, now: options.now?.() ?? Date.now() }
  }
  /** The custom view's answer, when there is one. */
  function custom<S extends LineSlot>(slot: S, model: ViewModels[S], at: DrawAt): Drawn | undefined {
    const runtime = live(slot)
    if (!runtime) return undefined
    // A slot whose options grant or refuse something: the terminal's own block is drawn first, so the view knows its size.
    const block = hostOptions(slot) ? HOST_BLOCKS[slot as "approval" | "question"](builtinInput(slot, model, at) as never) : undefined
    const shown = block ? { ...model, optionRows: block.rows.length } : model
    const result = runtime.call(slot, shown, env(at), {
      ...(at.id !== undefined ? { id: at.id } : {}),
      ...(at.memo ? { memo: at.memo } : {}),
      ...(WITH_BUILTIN.has(slot) ? { prepare: (prepared: never) => ({ ...(at.prepare ? at.prepare(prepared) as object : prepared as object), builtin: builtin(slot, model, at).lines }) } : at.prepare ? { prepare: at.prepare } : {}),
      validArg: (action, arg) => validArgFor(slot, model, action, arg),
    })
    if (!result || !("lines" in result)) return undefined
    const secured = secure(slot, model, result.lines, at, options.glyphs)
    if (block) return { ...composeHostBlock(secured.lines, block, at.height), custom: true }
    return { lines: secured.lines, hits: rebase(result.hits, secured), custom: true }
  }
  const builtinInput = <S extends LineSlot>(slot: S, model: ViewModels[S], at: DrawAt) =>
    ({ ...model, width: at.width, height: at.height, ascii: options.ascii?.() ?? false, now: options.now?.() ?? Date.now(), ...(at.extra ? { extra: at.extra } : {}) })
  /** The built-in renderer of the slot, through the same typed input. */
  function builtin<S extends LineSlot>(slot: S, model: ViewModels[S], at: DrawAt): Drawn {
    const input = builtinInput(slot, model, at)
    const built: BuiltinResult = (BUILTIN_VIEWS[slot] as (input: unknown, glyphs: Glyphs) => BuiltinResult)(input, options.glyphs)
    return Array.isArray(built) ? { lines: built, hits: [], custom: false } : { lines: built.lines, hits: built.hits ?? [], custom: false }
  }
  return {
    /** Whether a custom view is installed for `slot` (cheap: callers use it to skip building optional data). */
    hasCustom: (slot: ViewSlot) => live(slot) !== undefined,
    custom,
    builtin,
    /** Draws a slot that yields lines: the custom view when one answers, else the built-in. */
    draw: <S extends LineSlot>(slot: S, model: ViewModels[S], at: DrawAt): Drawn => custom(slot, model, at) ?? builtin(slot, model, at),
    /**
     * Draws the envelope slots (`page`, `overlay`, `bar`): the terminal draws the built-in rows first, a custom view then
     * receives them in its model and may return a replacement. Without a custom view the rows come back untouched and the
     * model is never built.
     */
    wrap<S extends "page" | "overlay" | "bar">(slot: S, make: () => Omit<ViewModels[S], "body" | "rows">, rows: Line[], at: { width: number; height: number }): Line[] {
      if (!live(slot)) return rows
      const model = { ...make(), [slot === "page" ? "body" : "rows"]: rows } as unknown as ViewModels[S]
      return custom(slot, model, at)?.lines ?? rows
    },
    /** The frame around the prompt: the custom parts when a view answers, else the built-in preset. `rich: false` (the bare minimal view) is never customised. */
    frame(model: PromptFrameModel & { rich: boolean }, at: { width: number }) {
      const runtime = model.rich ? live("prompt.frame") : undefined
      if (runtime) {
        const { rich: _rich, ...shown } = model
        const result = runtime.call("prompt.frame", shown, env({ width: at.width, height: 3 }), { validArg: () => false })
        if (result && "frame" in result) return builtinFrame.fromParts(result.frame, { width: at.width, lead: model.lead, rich: model.rich })
      }
      return builtinFrame.builtin(model, { width: at.width, glyphs: options.glyphs })
    },
  }
}

export type ViewHost = ReturnType<typeof createViewHost>

/** A host with no custom views, for code that draws without an app (tests, previews). */
export const plainViewHost = (glyphs: Glyphs) => createViewHost({ glyphs })
