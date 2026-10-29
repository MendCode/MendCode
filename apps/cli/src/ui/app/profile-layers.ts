import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"
import { ACTIVATION_STATE_FILE, activationStateJson, parseActivationState, saveLook } from "@mendcode/protocol/wire"
import { normalizeTuiProfile, readTuiProfile, type TuiProfile } from "../../view/tui-profile"
import type { AppContext } from "./context"

/**
 * The terminal profile as layers. What is stored (`<dataDir>/tui/profile.json`) is the user's own and is only ever written by the
 * user's own changes. Over it come, in this order: a package's activation overlay and what a running extension asked for through
 * `api.settings.set`; both are in memory only. A key the user changes by hand while a layer holds it is `kept`: the user's value
 * wins from then on (docs/packages.md):
 *
 *   effective = kept (user, after the layer)  >  extension request  >  package overlay  >  the stored profile
 *
 * A kept key a package holds keeps its value in `activation.json`, in the slot of the packages that own the look then, not in the
 * stored profile: switching the look to another package and back finds it as it was left, and the other package (or no package)
 * never sees it. A kept key only an extension holds is written to the stored profile as before.
 *
 * Taking a layer away (disable, remove, reload) puts the stored value back for every key it still holds, and a key the user changed
 * directly in the meantime is left alone. Nothing here loads the activation code: that module is imported by extensions.ts only
 * when an enabled package declares an activation.
 */

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

export function createProfileLayers(ctx: AppContext, actions: { changeProfile(patch: Partial<TuiProfile>, options?: { layer?: boolean }): void }) {
  const { input, state } = ctx

  /** What would be on screen with no layers: the stored profile (this run's copy when there is no data dir). */
  const stored = (): Record<string, unknown> => input.dataDir ? readTuiProfile(input.dataDir) : state.profileBase

  /** A value as the profile would hold it (valid, clamped, in its canonical shape), so layers compare like with like. */
  const normalized = (key: string, value: unknown) => normalizeTuiProfile({ ...state.tuiProfile, [key]: value })[key as keyof TuiProfile]
  const onScreen = (key: string) => state.tuiProfile[key as keyof TuiProfile]

  const overlay = () => state.activation?.result.overlay ?? {}
  /** A key a package's overlay holds: a hand change to it is saved with the look's owners, not in the stored profile. */
  const packageHeld = (key: string) => key in overlay()

  /** The keys the layers want right now: the user's kept value where they kept one under a package, else what the layers ask. */
  function desired(): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries({ ...overlay(), ...state.profileRuntime })) if (!state.keptKeys.has(key)) out[key] = normalized(key, value)
    for (const [key, value] of Object.entries(state.keptValues)) if (state.keptKeys.has(key) && packageHeld(key)) out[key] = normalized(key, value)
    return out
  }

  /** The user chose `value` for a key a layer holds: kept, and (under a package) remembered with the look's owners. */
  function keepValue(key: string, value: unknown) {
    state.keptKeys.add(key)
    if (packageHeld(key)) state.keptValues[key] = value
  }

  /**
   * Makes the screen match the layers: applies what they want, and restores the stored value for keys they let go of. A key a layer
   * put on screen that something else changed since (the panel editor writes the profile directly) is the user's now: kept.
   */
  function sync() {
    const want = desired()
    const base = stored()
    const patch: Record<string, unknown> = {}
    let kept = false
    for (const key of Object.keys(state.profileApplied)) {
      const changedSince = !same(onScreen(key), state.profileApplied[key])
      if (changedSince && key in want) {
        keepValue(key, onScreen(key))
        if (packageHeld(key)) want[key] = onScreen(key)
        else delete want[key]
        kept = true
      }
      else if (!(key in want) && !changedSince) patch[key] = base[key]
    }
    for (const [key, value] of Object.entries(want)) if (!same(onScreen(key), value)) patch[key] = value
    state.profileApplied = want
    if (Object.keys(patch).length) actions.changeProfile(patch as Partial<TuiProfile>, { layer: true })
    if (kept) persistKept()
  }

  function persistKept() {
    const live = state.activation
    if (!input.dataDir || !live) return
    const file = path.join(input.dataDir, ACTIVATION_STATE_FILE)
    try {
      const current = existsSync(file) ? parseActivationState(JSON.parse(readFileSync(file, "utf8"))) : parseActivationState(undefined)
      const temporary = `${file}.${process.pid}.tmp`
      mkdirSync(path.dirname(file), { recursive: true })
      const values = Object.fromEntries(Object.entries(state.keptValues).filter(([key]) => state.keptKeys.has(key)))
      writeFileSync(temporary, activationStateJson(saveLook(current, live.result.signature, { kept: [...state.keptKeys], values })))
      renameSync(temporary, file)
    } catch (error) {
      ctx.fail(`[TUI]: could not save ${file}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return {
    sync,
    /** What a running extension asked for through `api.settings.set`: in memory, gone with the extension. */
    runtime(patch: Record<string, unknown>) {
      state.profileRuntime = { ...state.profileRuntime, ...patch }
      sync()
    },
    /** A new extension runtime replaces the old one: what the old one asked for goes with it. */
    resetRuntime() {
      state.profileRuntime = {}
    },
    /**
     * The user changed these keys by hand: the ones a layer holds are theirs from now on. Returns the keys a package holds, which the
     * caller leaves out of the stored profile (their value is saved with the look's owners).
     */
    userChanged(patch: Record<string, unknown>): string[] {
      const held: string[] = []
      for (const [key, value] of Object.entries(patch)) {
        if (!(key in state.profileApplied)) continue
        keepValue(key, normalized(key, value))
        // The change itself puts the value on screen; a package-held key stays in the layer with it, so letting go restores the stored one.
        if (packageHeld(key)) { held.push(key); state.profileApplied[key] = state.keptValues[key] } else delete state.profileApplied[key]
      }
      if (Object.keys(patch).some((key) => state.keptKeys.has(key))) persistKept()
      return held
    },
    /** `keep mine` on one key (or `use package` when `on` is false): a profile key or `keybindings:<key>`. */
    keep(key: string, on: boolean) {
      if (on && !key.startsWith("keybindings:")) keepValue(key, normalized(key, stored()[key]))
      else if (on) state.keptKeys.add(key)
      else { state.keptKeys.delete(key); delete state.keptValues[key] }
      persistKept()
      sync()
    },
    /** Keybinding keys the user chose in the keymap editor while a package binds the same key. */
    keepKeybindings(specs: readonly string[]) {
      const bound = new Set((state.activation?.keybindings ?? []).map((entry) => entry.spec))
      const mine = specs.filter((spec) => bound.has(spec))
      if (!mine.length) return false
      for (const spec of mine) state.keptKeys.add(`keybindings:${spec}`)
      persistKept()
      return true
    },
  }
}

export type ProfileLayers = ReturnType<typeof createProfileLayers>
