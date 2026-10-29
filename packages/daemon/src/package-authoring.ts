import type { Command, Settings } from "@mendcode/protocol"
import { authorLocalPackage, deleteLocalPackage } from "@mendcode/packages"

type AuthorCommand = Extract<Command, { type: "packages.create" | "packages.update" | "packages.delete-local" }>

export function createPackageAuthoring(input: { settings: () => Settings; prompt: (directory: string) => { mode: string; focusID: string }; tui: () => Record<string, unknown>; reload: (directory: string) => Promise<unknown>; now: () => number }) {
  return async (command: AuthorCommand) => {
    if (command.type === "packages.delete-local") {
      const report = deleteLocalPackage(command.directory)
      await input.reload(command.directory)
      return report
    }
    const current = input.settings()
    const models = Object.fromEntries(Object.entries(current.models ?? {}).map(([role, model]) => [role, { model: model.model, ...(model.effort ? { effort: model.effort } : {}), ...(model.variant ? { variant: model.variant } : {}) }]))
    const memory = { ...Object.fromEntries(Object.entries(current).filter(([key, value]) => key.startsWith("memory") && (["number", "boolean"].includes(typeof value) || key === "memoryMaintenance" || key === "memoryPolicies"))), ...current.memoryProjects?.[command.directory] }
    const report = authorLocalPackage({
      directory: command.directory, action: command.type === "packages.create" ? "create" : "update",
      ...(command.metadata ? { metadata: command.metadata } : {}), ...(command.include ? { include: command.include } : {}), ...(command.exclude ? { exclude: command.exclude } : {}),
      settings: { models, focus: input.prompt(command.directory), memory, permissions: { ...(current.defaultPermission ? { defaultPermission: current.defaultPermission } : {}), ...(current.permission ? { rules: current.permission } : {}), ...(current.permissionReviewerRole ? { reviewerRole: current.permissionReviewerRole } : {}) }, tuiProfile: input.tui() }, now: input.now,
    })
    // Authoring produces an available local package; it never installs modules or grants trust.
    await input.reload(command.directory)
    return report
  }
}
