import { readdir, readFile } from "fs/promises"
import { existsSync } from "fs"
import { mendPaths } from "../config/paths"
import { globalMendTuiProfilePath } from "../profile"
import { readActiveTuiProfile } from "../tui/profile-actions"
import { readPromptMode } from "../prompt/mode"
import { readModelsConfig, resolveModelRoles } from "../config/models"
import { resolvePromptFocusForRole } from "../prompt/focus-resolver"
import { mendTuiCapabilityVersion, visibleCustomizationCapabilities } from "../tui/capabilities"
import { listActiveCustomizations } from "../tui/customization-state"
import { mflowControlStatus } from "../config/mflow"

async function readJson(file: string) {
  try { return JSON.parse(await readFile(file, "utf8")) } catch { return null }
}

export async function mendStatusSummary(root?: string) {
  const profile = await readActiveTuiProfile(root)
  const prompt = await readPromptMode(root)
  return [
    `Profile: ${profile.profile}`,
    `Theme: ${profile.theme.palette}`,
    `Density: ${profile.layout.density}`,
    `Widgets: ${profile.widgets.enabled.join(", ") || "none"}`,
    `Prompt mode: ${prompt.mode} (${prompt.live})`,
    `Customization contract: v${mendTuiCapabilityVersion()} · ${visibleCustomizationCapabilities().map((item) => `${item.id}=${item.tier}`).join(", ")}`,
    `Active customization surfaces: ${listActiveCustomizations().map((item) => `${item.surface}:${item.source}`).join(", ") || "none"}`,
    `Config: ${globalMendTuiProfilePath()}`,
  ].join("\n")
}

async function countFiles(dir: string, suffix?: string) {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries.filter((entry) => entry.isFile() && (!suffix || entry.name.endsWith(suffix))).length
  } catch {
    return 0
  }
}

export async function mendRuntimeConfigurationSummary(root?: string) {
  const paths = mendPaths(root)
  const [profile, prompt, models] = await Promise.all([readActiveTuiProfile(root), readPromptMode(root), readModelsConfig(root)])
  const resolved = await resolveModelRoles(root)
  const defaultRole = models.roles.default
  const focusResolution = resolvePromptFocusForRole(defaultRole)
  const focusCount = await countFiles(`${paths.mendDir}/focus`, ".yaml")
  const commandCount = await countFiles(`${paths.mendDir}/commands`, ".md")
  const contextFiles = [
    ".mendcode/context/project.md",
    ".mendcode/context/summary.md",
    ".mendcode/context/refresh.json",
  ].filter((file) => existsSync(`${paths.root}/${file}`))

  return [
    `Root: ${paths.root}`,
    `Runtime config: ${paths.mendConfig}`,
    `Active prompt mode: ${prompt.mode}`,
    `Default model policy: ${resolved.enabled ? resolved.defaultModel || "enabled but unset" : "runtime default"}`,
    `Focus resolver: ${focusResolution.focusID} (${focusResolution.source}; ${focusResolution.reason})`,
    `Focus profiles: ${focusCount} local .mendcode/focus/*.yaml`,
    `Command packs: ${commandCount} local .mendcode/commands/*.md`,
    `Context docs: ${contextFiles.join(", ") || "none"}`,
    `TUI profile: ${profile.profile} / ${profile.theme.palette} / ${profile.layout.density}`,
    `Customization capabilities: v${mendTuiCapabilityVersion()} · ${visibleCustomizationCapabilities().length} surfaced / ${listActiveCustomizations().length} active`,
    "Marketplace: local official catalog and runtime registry are implemented for .mendcode packs; remote publication is opt-in.",
    "Teams: registry preview/apply supports approval-gated shared config; local secrets are excluded.",
  ].join("\n")
}

export async function integrationStatus(kind: "mflow" | "tsm", root?: string) {
  if (kind === "mflow") return mflowStatusSummary(root)
  const paths = mendPaths(root)
  const file = paths.tsmPlan
  const data = await readJson(file)
  if (!existsSync(file)) return `${kind.toUpperCase()}: no plan file at ${file}`
  const status = data?.status || data?.mode || "planned/off"
  const repo = data?.repository || data?.repo || data?.source || "not configured"
  return `${kind.toUpperCase()}: ${status}\nRepo: ${repo}\nPlan: ${file}`
}

export async function mflowStatusSummary(root?: string) {
  const status = await mflowControlStatus(root)
  const config = status.config
  const daemon = summarizeMflowDaemon(status.daemon.output)
  const locks = summarizeMflowLocks(status.locks.output)
  return [
    `Mode: ${status.mode}`,
    `Enabled: ${config.enabled ? "yes" : "no"}`,
    `Relay: ${config.relayMode === "public" ? "public fair-use" : "custom"} (${config.signaling})`,
    `Room: ${config.room}`,
    `Queue priority: ${config.hookPriority}`,
    `MCP: ${status.files.mcp}`,
    `Runtime config: ${status.files.runtimeConfig}`,
    `Hook scaffold: ${status.files.plugin}`,
    `Local secret file: ${status.files.secretStoredLocally ? "yes" : "no"}`,
    `Daemon: ${status.daemon.running ? "running" : "not running"}`,
    `Daemon state: ${daemon.state}`,
    `Peers: ${daemon.peers}`,
    `Files: ${daemon.files}`,
    `Ops/s: ${daemon.ops}`,
    `Uptime: ${daemon.uptime}`,
    daemon.dashboard ? `Dashboard: ${daemon.dashboard}` : undefined,
    `Locks: ${status.locks.checked ? "available" : "unavailable"}`,
    locks,
    "",
    "Public relay: shared fair-use; use custom relay for private code, larger teams, or custom limits.",
  ].filter((line): line is string => typeof line === "string").join("\n")
}

function pickLine(output: string | undefined, label: string) {
  return output?.match(new RegExp(`^\\s*${label}:\\s*(.+)$`, "m"))?.[1]?.trim()
}

function summarizeMflowDaemon(output: string | undefined) {
  return {
    state: pickLine(output, "State") || "unknown",
    peers: pickLine(output, "Peers") || "unknown",
    files: pickLine(output, "Files") || "unknown",
    ops: pickLine(output, "Ops/s") || "unknown",
    uptime: pickLine(output, "Uptime") || "unknown",
    dashboard: output?.match(/https:\/\/\S+\/dashboard/)?.[0],
  }
}

function summarizeMflowLocks(output: string | undefined) {
  const text = output?.trim()
  if (!text) return "No lock output."
  if (/no active locks/i.test(text)) return "No active locks."
  return text.split(/\r?\n/).slice(0, 4).join("\n")
}
