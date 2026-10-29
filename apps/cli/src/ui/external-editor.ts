import type { EditRequest, EditResult } from "@mendcode/editor-launch"

/**
 * The prompt's "open in $EDITOR". This client may not run programs, so the launcher lives in its own package and is
 * loaded by a dynamic import, only the first time the action is used (the type import below is erased).
 */
export type EditorLauncher = (request: EditRequest) => EditResult | Promise<EditResult>

export async function loadEditorLauncher(): Promise<EditorLauncher> {
  return (await import("@mendcode/editor-launch")).editExternally
}
