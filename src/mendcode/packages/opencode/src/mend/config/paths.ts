import path from "path"
import { fileURLToPath } from "url"
import { existsSync } from "fs"

export function mendRuntimeRoot() {
  const here = path.dirname(fileURLToPath(import.meta.url))
  let current = here
  for (let i = 0; i < 12; i++) {
    if (existsSync(path.join(current, ".mendcode")) && existsSync(path.join(current, "src", "mendcode", "packages", "opencode", "src", "mend", "assets"))) return current
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return path.resolve(here, "../../../../../../..")
}

export function mendPaths(root = mendRuntimeRoot()) {
  return {
    root,
    donorRuntimeRoot: path.join(root, ".agents", "vendor", "opencode"),
    donorRuntimePackage: path.join(root, ".agents", "vendor", "opencode", "packages", "opencode"),
    ownedRuntimeRoot: path.join(root, "src", "mendcode"),
    ownedRuntimePackage: path.join(root, "src", "mendcode", "packages", "opencode"),
    runtimeControlPlane: path.join(root, "src", "mendcode", "packages", "opencode", "src", "mend", "cli", "control-plane.ts"),
    runtimeAssetsRoot: path.join(root, "src", "mendcode", "packages", "opencode", "src", "mend", "assets"),
    runtimeTuiAssets: path.join(root, "src", "mendcode", "packages", "opencode", "src", "mend", "assets", "tui"),
    runtimePromptEvidenceAssets: path.join(root, "src", "mendcode", "packages", "opencode", "src", "mend", "assets", "prompt-sources"),
    mendDir: path.join(root, ".mendcode"),
    mendConfig: path.join(root, ".mendcode", "mendcode.json"),
    generatedDir: path.join(root, ".mendcode", "generated"),
    generatedOpencodeConfig: path.join(root, ".mendcode", "generated", "opencode.json"),
    modelRoleProjectionState: path.join(root, ".mendcode", "generated", "model-role-projection.json"),
    tuiProfile: path.join(root, ".mendcode", "tui", "profile.json"),
    tuiBackupDir: path.join(root, ".mendcode", "tui", "backups"),
    tuiProposalDir: path.join(root, ".mendcode", "tui", "proposals"),
    tuiPreviewDir: path.join(root, ".mendcode", "tui", "previews"),
    tuiRuntimeDir: path.join(root, ".mendcode", "tui", "runtime"),
    tuiSurfaceDir: path.join(root, ".mendcode", "tui", "surfaces"),
    tuiSurfacePlugin: path.join(root, ".mendcode", "tui", "surfaces", "plugin.tsx"),
    tuiSurfaceHomeAscii: path.join(root, ".mendcode", "tui", "surfaces", "home.ascii"),
    tuiSurfaceSessionAscii: path.join(root, ".mendcode", "tui", "surfaces", "session.ascii"),
    tuiSurfaceMetadata: path.join(root, ".mendcode", "tui", "surfaces", "legacy-surface-metadata.json"),
    tuiRenderDir: path.join(root, ".mendcode", "tui", "renders"),
    tuiRenderState: path.join(root, ".mendcode", "tui", "renders", "latest.json"),
    tuiRenderText: path.join(root, ".mendcode", "tui", "renders", "latest.txt"),
    tuiPreviewPlan: path.join(root, ".mendcode", "tui", "previews", "preview-plan.json"),
    tuiRuntimePlan: path.join(root, ".mendcode", "tui", "runtime-plan.json"),
    tuiProbeRunDir: path.join(root, ".mendcode", "runs", "tui-probe", "latest"),
    tuiDefaultProfile: path.join(root, "src", "mendcode", "packages", "opencode", "src", "mend", "assets", "tui", "default-profile.json"),
    tuiSchema: path.join(root, "src", "mendcode", "packages", "opencode", "src", "mend", "assets", "tui", "schema.json"),
    promptSourcesRoot: path.join(root, "src", "mendcode", "packages", "opencode", "src", "mend", "assets", "prompt-sources"),
    promptSourcesMetadata: path.join(root, "src", "mendcode", "packages", "opencode", "src", "mend", "assets", "prompt-sources", "sources.json"),
    promptMode: path.join(root, ".mendcode", "prompt-mode.json"),
    setupState: path.join(root, ".mendcode", "setup", "state.json"),
    memoryDir: path.join(root, ".mendcode", "memory"),
    memoryConfig: path.join(root, ".mendcode", "memory", "config.json"),
    memorySummary: path.join(root, ".mendcode", "memory", "memory_summary.md"),
    memoryEntries: path.join(root, ".mendcode", "memory", "entries.jsonl"),
    memoryIndex: path.join(root, ".mendcode", "memory", "index.json"),
    modelsConfig: path.join(root, ".mendcode", "models.yaml"),
    mcpDir: path.join(root, ".mendcode", "mcp"),
    budgetSpendState: path.join(root, ".mendcode", "budget", "spend-state.json"),
    runHistory: path.join(root, ".mendcode", "runs", "history.jsonl"),
    runtimeRegistryCacheDir: path.join(root, ".mendcode", "cache", "registry"),
    packageDir: path.join(root, ".mendcode", "packages"),
    packageInstalledDir: path.join(root, ".mendcode", "packages", "installed"),
    packageState: path.join(root, ".mendcode", "packages", "state.json"),
    mflowPlan: path.join(root, ".mendcode", "worktree", "mflow-plan.json"),
    tsmPlan: path.join(root, ".mendcode", "worktree", "tsm-plan.json"),
    docsTuiPersonalization: path.join(root, "docs", "tui-personalization.md"),
  }
}
