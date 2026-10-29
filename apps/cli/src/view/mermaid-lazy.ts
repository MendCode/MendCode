/**
 * Loads the mermaid diagram renderer on first use (P5): its layout engine is pure code with no runtime
 * dependency, but its ~3 MB of parsed bytecode is otherwise paid by every session, whether or not it ever
 * shows a diagram. `ensureMermaid` is synchronous (safe to call from the pure `renderMarkdown`): it
 * returns the renderer once loaded, or kicks off the import and returns undefined meanwhile. The caller
 * shows a placeholder for that one frame; `onMermaidLoaded` lets the app request a fresh frame once the
 * module lands, and `mermaidGeneration` lets the transcript's render cache invalidate that one time.
 */
type MermaidModule = typeof import("./mermaid")

let mod: MermaidModule | undefined
let pending: Promise<MermaidModule> | undefined
let generation = 0
const onLoad: Array<() => void> = []

export function ensureMermaid(): MermaidModule["renderMermaid"] | undefined {
  if (mod) return mod.renderMermaid
  pending ??= import("./mermaid").then((loaded) => {
    mod = loaded
    generation++
    for (const callback of onLoad.splice(0)) callback()
    return loaded
  })
  return undefined
}

/** Bumped once, the moment the module finishes loading; 0 forever in a session that never needs it. */
export function mermaidGeneration() {
  return generation
}

/**
 * Registered callbacks fire once, in order, the moment the module loads (never, if it never is needed).
 * Always asynchronous, even when the module already loaded: a caller registering mid-construction (as
 * `createApp` does) must never have it fire before its own closure finishes initializing.
 */
export function onMermaidLoaded(callback: () => void) {
  if (mod) queueMicrotask(callback)
  else onLoad.push(callback)
}
