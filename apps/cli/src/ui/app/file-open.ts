import { featureOn } from "@mendcode/protocol/wire"
import { findFileRefs, parseOpenTarget, refAt, resolveRef, type FileRef, type RefContext } from "../../view/file-ref"
import type { Line } from "../theme"
import type { AppContext } from "./context"
import type { FileViewerController } from "./file-viewer"
import { preload } from "../lazy-pages"

/**
 * The file viewer as the terminal sees it before it is used (docs/file-viewer.md): the checks a click needs, and the entry points
 * every other part calls. The viewer itself (`file-viewer.ts`, its renderer and the highlighter) is loaded on the first file opened,
 * so a terminal that never opens one pays nothing at startup.
 */
export function createFileOpen(ctx: AppContext, deps: { insertPrompt(text: string): void }) {
  const { input, state, say } = ctx
  let controller: FileViewerController | undefined
  let loading: Promise<FileViewerController> | undefined
  const load = () => (loading ??= Promise.all([import("./file-viewer"), preload("fileViewer")]).then(([module]) => (controller = module.createFileViewer(ctx, deps))))

  /** What a click on a path does: `auto` follows the `file_viewer` feature (balanced and full), `editor` leaves the path to the terminal's own link. */
  const clickMode = (): "panel" | "editor" => {
    const setting = state.tuiProfile.pathClick
    return setting === "auto" ? (featureOn(state.settingsNow, "file_viewer") ? "panel" : "editor") : setting
  }

  const context = (): RefContext => {
    const home = input.env?.HOME ?? process.env.HOME
    const roots = [input.directory, ...(state.settingsNow.additionalDirectories ?? [])].filter((root): root is string => !!root)
    return { cwd: input.directory ?? process.cwd(), ...(home ? { home } : {}), roots }
  }

  /** Opens what `ref` points at. True when the click was a path (opened, or refused with a line saying why). */
  function openRef(ref: Pick<FileRef, "raw" | "line" | "endLine">, options: { explicit?: boolean; /** Once it is open (not refused, not missing). */ opened?: () => void } = {}): boolean {
    const resolved = resolveRef(ref, context())
    if (!resolved.ok) {
      if (resolved.reason === "outside") say(`not opened: ${ref.raw} is outside the workspace`, "warning")
      else if (options.explicit) say(`not opened: ${ref.raw} is not a usable path`, "warning")
      return resolved.reason === "outside" || !!options.explicit
    }
    void load().then((viewer) => viewer.open(resolved, { quietMissing: !options.explicit && !ref.raw.includes("/") })).then((opened) => { if (opened) options.opened?.() })
    return true
  }

  return {
    clickMode,
    /** A click on `text[at]` in the transcript: opens the path under it when the setting says so. */
    clickPath(text: string, at: number): boolean {
      if (clickMode() !== "panel" || state.page !== "chat" || !input.directory) return false
      const ref = refAt(text, at)
      return !!ref && openRef(ref)
    },
    /** `/open <path>[:line[-line]]`, and an extension's `openFile`. */
    openTarget(text: string): boolean {
      const target = parseOpenTarget(text)
      if (!target) {
        say("usage: /open <path>[:line[-line]]", "warning")
        return false
      }
      return openRef(target, { explicit: true })
    },
    openFile(file: string, lines?: { from: number; to?: number }): void {
      openRef({ raw: file, ...(lines ? { line: lines.from, ...(lines.to && lines.to >= lines.from ? { endLine: lines.to } : {}) } : {}) }, { explicit: true })
    },
    /** Opens a reference the user picked (a key, a list); says why when it cannot. `opened` runs once the viewer shows it. */
    openRef: (ref: Pick<FileRef, "raw" | "line" | "endLine">, opened?: () => void): void => void openRef(ref, { explicit: true, ...(opened ? { opened } : {}) }),
    /** The references in `text` that point inside the workspace, in reading order and once each. */
    refsIn(text: string): FileRef[] {
      const seen = new Set<string>()
      return findFileRefs(text).filter((ref) => {
        const key = `${ref.raw}:${ref.line ?? ""}:${ref.endLine ?? ""}`
        if (seen.has(key) || !resolveRef(ref, context()).ok) return false
        seen.add(key)
        return true
      })
    },
    /** True once a file is open; the viewer exists by then. */
    key: (raw: string): Promise<boolean> => (state.fileViewer && controller ? controller.key(raw) : Promise.resolve(false)),
    close: () => controller?.close(),
    refresh: () => { if (state.fileViewer && controller) void controller.refresh() },
    syncPage(width: number) {
      if (state.fileViewer && controller) controller.syncPage(width)
      else if (state.page === "file") state.page = "chat"
    },
    slotRows: (width: number, height: number): Line[] => controller?.slotRows(width, height) ?? [],
    tabRow: (width: number): Line => controller!.tabRow(width),
    pageRows: (width: number, height: number): Line[] => controller?.pageRows(width, height) ?? [],
  }
}
