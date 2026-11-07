import fs from "node:fs"
import path from "node:path"
import type { SidebarWidget } from "@mendcode/protocol"
import { normalizeTuiProfile, type TuiProfile } from "../../view/tui-profile"
import { panelChoiceOf, presetOf, resolvePanel, type PanelChoice } from "../../view/sidebar-spec"
import type { AppContext } from "./context"

/** Sessions whose own look is kept; the oldest is dropped past this. */
const KEPT_SESSIONS = 200

/**
 * A session's own look: profile keys, plus `panelPreset` when `/panel <preset>` chose the panel. The choice is only the preset's id: it
 * resolves to the profile's own version of that preset when the profile has one (sidebar-spec.ts `resolvePanel`), so a session never
 * holds a copy that could shadow the profile's panel. `sidebarWidgets` stays for a list the session built itself (`/panel widget`).
 */
export type SessionLook = Partial<TuiProfile> & { panelPreset?: PanelChoice }

/**
 * What a slash command shows or hides belongs to the session it was typed in: `/panel` (shown, hidden, a preset, an added card, the
 * width), `/sidebar`, `/timestamps`, `/thinking`, `/scrollbar` (`changeProfile(patch, { session: true })`). The stored profile
 * (`/customize`, `tui/profile.json`) stays every terminal's default and is not written; another terminal, or another session in
 * this one, keeps its own screen. Each session's choices are kept in `tui/session-look.json`, so the session shows them again after
 * a restart, in any terminal that opens it.
 */
export const sessionLookPath = (dataDir: string) => path.join(dataDir, "tui", "session-look.json")

/**
 * The kept looks, each run through the profile's own validation (an unknown or broken key is dropped). A kept list of cards that is
 * exactly a built-in preset is read as that preset's id: older builds stored the built-in copy, which hid the profile's own version.
 */
export function readSessionLook(dataDir: string | undefined): Map<string, SessionLook> {
  const looks = new Map<string, SessionLook>()
  if (!dataDir) return looks
  try {
    const parsed = JSON.parse(fs.readFileSync(sessionLookPath(dataDir), "utf8")) as Record<string, Record<string, unknown>>
    for (const [sessionId, look] of Object.entries(parsed ?? {})) {
      if (!look || typeof look !== "object" || Array.isArray(look)) continue
      const valid = normalizeTuiProfile(look)
      const kept: SessionLook = Object.fromEntries(Object.keys(look).filter((key) => key in valid).map((key) => [key, valid[key as keyof TuiProfile]]))
      const choice = panelChoiceOf(look.panelPreset)
      const copied = kept.sidebarWidgets?.length ? presetOf(kept.sidebarWidgets) : "custom"
      if (choice || copied !== "custom") {
        delete kept.sidebarWidgets
        kept.panelPreset = choice ?? (copied as PanelChoice)
      }
      looks.set(sessionId, kept)
    }
  } catch {
    // No file yet, or one that cannot be read: no session has a look of its own.
  }
  return looks
}

/** Saves the looks (the newest `KEPT_SESSIONS`); an error is the caller's to show. */
export function writeSessionLook(dataDir: string, looks: Map<string, SessionLook>): { ok: true } | { ok: false; error: string } {
  const file = sessionLookPath(dataDir)
  const temp = `${file}.${process.pid}.tmp`
  const kept = [...looks].filter(([, look]) => Object.keys(look).length).slice(-KEPT_SESSIONS)
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(temp, `${JSON.stringify(Object.fromEntries(kept))}\n`)
    fs.renameSync(temp, file)
    return { ok: true }
  } catch (error) {
    fs.rmSync(temp, { force: true })
    return { ok: false, error: `[TUI]: could not save ${file}: ${error instanceof Error ? error.message : String(error)}` }
  }
}

/** The panel the profile shows without a session's choice: an enabled profile's layer, else the panel's file as last read. */
export function profilePanel(state: AppContext["state"]): readonly SidebarWidget[] {
  const layered = state.profileApplied.sidebarWidgets
  return Array.isArray(layered) ? (layered as SidebarWidget[]) : state.panelSpec ?? state.profileBase.sidebarWidgets
}

/** A kept look as the screen applies it: a panel choice becomes the cards it resolves to now, never a stored copy. */
export function appliedLook(look: SessionLook, profile: readonly SidebarWidget[]): Partial<TuiProfile> {
  const { panelPreset, ...rest } = look
  return panelPreset ? { ...rest, sidebarWidgets: resolvePanel(panelPreset, profile).widgets } : rest
}

/** Puts `patch` on the current session's look (most recent last) and saves it. `panel` keeps a preset's id in place of its cards. */
export function keepSessionLook(ctx: AppContext, patch: Partial<TuiProfile>, panel?: PanelChoice | null) {
  const { state, input } = ctx
  const look: SessionLook = { ...state.sessionLook.get(state.sessionId), ...patch }
  if (panel) {
    delete look.sidebarWidgets
    look.panelPreset = panel
  } else if ("sidebarWidgets" in patch || panel === null) delete look.panelPreset
  if (panel === null) delete look.sidebarWidgets
  state.sessionLook.delete(state.sessionId)
  state.sessionLook.set(state.sessionId, look)
  if (!input.dataDir) return
  const saved = writeSessionLook(input.dataDir, state.sessionLook)
  if (!saved.ok) ctx.fail(saved.error)
}

/**
 * The terminal moved from `previous` to the current session: the keys either one set go back to the default or to the new one's.
 * Returns whether the panel's cards must be asked of the daemon again (the previous session had its own, the new one has none).
 */
export function switchSessionLook(ctx: AppContext, previous: string, apply: (patch: Partial<TuiProfile>) => void): boolean {
  const { state } = ctx
  const ownPanel = (look: SessionLook) => "sidebarWidgets" in look || "panelPreset" in look
  const leftLook = state.sessionLook.get(previous) ?? {}
  const ownLook = state.sessionLook.get(state.sessionId) ?? {}
  const left = appliedLook(leftLook, profilePanel(state))
  const own = appliedLook(ownLook, profilePanel(state))
  const patch: Record<string, unknown> = {}
  for (const key of new Set([...Object.keys(left), ...Object.keys(own)])) {
    // The panel's cards come from the daemon's spec (right-sidebar.ts `loadSpec`), not from the profile.
    if (key === "sidebarWidgets" && !(key in own)) continue
    // Under a session's own value is what the terminal would show without it: a profile or extension layer, else the stored profile.
    patch[key] = key in own ? own[key as keyof TuiProfile] : key in state.profileApplied ? state.profileApplied[key] : state.profileBase[key as keyof TuiProfile]
  }
  if (Object.keys(patch).length) apply(patch as Partial<TuiProfile>)
  return ownPanel(leftLook) && !ownPanel(ownLook)
}
