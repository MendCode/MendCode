import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { isViewSlot, VIEW_SLOT_NAMES } from "@mendcode/extension-api/views"

/**
 * `mendcode view scaffold <slot>` and /customize > Views: a commented starter file in the user's extensions folder.
 * Only the file system; no daemon, no zod. The daemon's watcher picks the new file up (hot reload).
 */

export { viewStarter, viewFileName } from "@mendcode/extension-api/view-starter"
import { viewStarter, viewFileName } from "@mendcode/extension-api/view-starter"

export type ScaffoldResult = { ok: true; file: string } | { ok: false; message: string }

/** Writes the starter for `slot` into `<dataDir>/extensions`; never overwrites a file (`force` replaces it). */
export function scaffoldView(options: { dataDir: string; slot: string; force?: boolean }): ScaffoldResult {
  if (!isViewSlot(options.slot)) return { ok: false, message: `unknown slot "${options.slot}"; slots: ${VIEW_SLOT_NAMES.join(", ")}` }
  const folder = path.join(options.dataDir, "extensions")
  const file = path.join(folder, viewFileName(options.slot))
  if (existsSync(file) && !options.force) return { ok: false, message: `${file} exists; edit it or pass --force` }
  mkdirSync(folder, { recursive: true })
  writeFileSync(file, viewStarter(options.slot))
  return { ok: true, file }
}
