import type { Editor } from "./editor"
import type { Vim, VimMode, VimResult } from "./vim"

/**
 * The prompt's vim layer, loaded the first time vim mode is on (the `vimMode` profile setting). Until then it reads as plain insert
 * mode, which is also what the real layer is in before any key. `load()` starts the import and is cheap to call again; the first
 * frame that shows the vim label or cursor and every key handled while the setting is on call it, so the module is there before
 * the first vim key in practice. A key that arrives before it loads goes on to the prompt unchanged.
 */
export type LazyVim = Vim & { load(): Promise<void> }

export function createLazyVim(editor: Editor): LazyVim {
  let real: Vim | undefined
  let pending: Promise<void> | undefined
  const load = () => (pending ??= import("./vim").then((module) => { real = module.createVim(editor) }))
  const start = () => { void load() }
  return {
    load,
    get mode(): VimMode { return real?.mode ?? "insert" },
    get pending() { return real?.pending ?? "" },
    get label() { if (!real) start(); return real?.label ?? "-- INSERT --" },
    get cursorShape(): "bar" | "block" { if (!real) start(); return real?.cursorShape ?? "bar" },
    place(target: number) { if (real) real.place(target); else editor.moveTo(target) },
    reset() { real?.reset() },
    key(seq: string): VimResult { if (!real) { start(); return "pass" } return real.key(seq) },
  }
}
