export const PROJECT_OPERATIONS = ["init", "config-show", "context-status", "context-refresh", "context-show", "focus-status", "focus-list", "focus-show", "focus-use", "package-show", "package-set"] as const
export type ProjectOperation = typeof PROJECT_OPERATIONS[number]
export type ProjectPackagePatch = {
  id?: string | undefined
  title?: string | undefined
  description?: string | undefined
  version?: string | undefined
  kind?: string | undefined
  channel?: string | undefined
  sourceType?: string | undefined
  sourceURL?: string | undefined
  compatMendcode?: string | undefined
  compatRuntimePack?: string | undefined
}
export type ProjectControlInput =
  | { operation: Exclude<ProjectOperation, "focus-show" | "focus-use" | "package-set"> }
  | { operation: "focus-show"; focusID?: import("./prompt-data").PromptFocusChoice | undefined }
  | { operation: "focus-use"; focusID: import("./prompt-data").PromptFocusChoice }
  | { operation: "package-set"; patch: ProjectPackagePatch }
