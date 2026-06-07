import { existsSync } from "fs"
import { mkdir, readFile, writeFile } from "fs/promises"
import { spawnSync } from "child_process"
import path from "path"
import { mendPaths } from "../config/paths"
import { readActiveTuiProfile } from "./profile-actions"
import { mergeMendTuiProfile, validateMendTuiProfile, type MendTuiProfile } from "../profile"
import { readPromptMode, type MendPromptMode } from "../prompt/mode"

const sourceFiles = [
  "packages/opencode/specs/tui-plugins.md",
  "packages/plugin/src/tui.ts",
  "packages/opencode/src/cli/cmd/tui/routes/home.tsx",
  "packages/opencode/src/cli/cmd/tui/routes/session/index.tsx",
  "packages/opencode/src/cli/cmd/tui/plugin/runtime.ts",
  "packages/opencode/src/cli/cmd/tui/plugin/slots.tsx",
  "packages/opencode/test/cli/tui/slot-replace.test.tsx",
  "packages/opencode/test/cli/tui/plugin-lifecycle.test.ts",
  "packages/opencode/test/cli/tui/plugin-loader-pure.test.ts",
]

export function protectedTuiHotPaths() {
  return [
    "packages/opencode/src/cli/cmd/tui/routes/session/index.tsx",
    "packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx",
    "packages/opencode/src/cli/cmd/tui/context/sync.tsx",
    "packages/opencode/src/cli/cmd/tui/context/sync-v2.tsx",
    "packages/opencode/src/cli/cmd/tui/worker.ts",
    "packages/opencode/src/cli/cmd/tui/thread.ts",
    "packages/opencode/src/cli/cmd/tui/attach.ts",
    "packages/opencode/src/session/prompt.ts",
  ]
}

async function writeJson(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`)
}

async function readTextIfExists(file: string) {
  try {
    return await readFile(file, "utf8")
  } catch {
    return ""
  }
}

function slug(value: string) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

function visibleLength(text: string) {
  return [...String(text)].length
}

function clampText(text: string, width: number) {
  const value = String(text)
  if (visibleLength(value) <= width) return value.padEnd(width, " ")
  if (width <= 1) return "..."
  return `${[...value].slice(0, width - 1).join("")}.`
}

function borderChars(kind?: string) {
  if (kind === "none") return { tl: " ", tr: " ", bl: " ", br: " ", h: " ", v: " ", tm: " ", bm: " " }
  if (kind === "heavy") return { tl: "┏", tr: "┓", bl: "┗", br: "┛", h: "━", v: "┃", tm: "┳", bm: "┻" }
  if (kind === "single") return { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│", tm: "┬", bm: "┴" }
  return { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│", tm: "┬", bm: "┴" }
}

function widgetLines(profile: MendTuiProfile, input: { resource?: any; promptMode?: MendPromptMode } = {}) {
  return profile.widgets.order.map((id) => {
    const widget = profile.widgets.config?.[id] || input.resource?.widgets?.[id] || { label: id, value: "configured" }
    const value = id === "prompt-mode" ? input.promptMode : widget.value || widget.surface || "configured"
    return `${widget.label || id}: ${value}`
  })
}

export async function buildTuiPreview(input: { state?: string; root?: string; profile?: MendTuiProfile } = {}) {
  const paths = mendPaths(input.root)
  const state = input.state || "home"
  if (!["home", "session", "diff", "error"].includes(state)) throw new Error("Usage: mend tui preview [--state home|session|diff|error]")
  const profile = input.profile || (await readActiveTuiProfile(paths.root))
  const promptMode = (await readPromptMode(paths.root)).mode
  const validation = validateMendTuiProfile(profile)
  if (!validation.ok) throw new Error(`Invalid TUI profile:\n${validation.failures.join("\n")}`)
  const width = Math.max(64, Number(profile.layout.width) || 88)
  const sidebarWidth = profile.layout.zones.sidebar.compact ? 20 : Math.min(Math.max(22, Number(profile.layout.zones.sidebar.width) || 28), width - 36)
  const mainWidth = width - sidebarWidth - 3
  const b = borderChars(profile.layout.borders)
  const stateLines: Record<string, string[]> = {
    home: ["Home", "New MendCode session", "Provider/model/status surfaces read live config", "Internal runtime commands guarded"],
    session: ["Session", "Transcript zone", "Prompt zone bottom", "Sidebar carries metadata"],
    diff: ["Diff", "Review patch preview", "Accept/reject stays gated", "No donor hot-path patch"],
    error: ["Error", "Profile validation and rollback surface", "Last good profile retained", "Apply remains explicit"],
  }
  const sidebarLines = [profile.identity.productName, profile.identity.tagline, `density: ${profile.layout.density}`, `theme: ${profile.theme.palette || profile.theme.mode}`, "", ...widgetLines(profile, { promptMode })]
  const mainLines = [
    ...stateLines[state]!,
    "",
    `accent ${profile.theme.tokens.accent}`,
    `surface model=${profile.surfaces.model.visible ? "on" : "off"} provider=${profile.surfaces.provider.visible ? "on" : "off"} status=${profile.surfaces.status.visible ? "on" : "off"}`,
    "source mend/assets/tui + .mendcode/tui/profile.json",
    "Runtime seam: plugin slots/theme/config only",
  ]
  const rowCount = Math.max(sidebarLines.length, mainLines.length)
  const rows: string[] = []
  const top = `${b.tl}${b.h.repeat(sidebarWidth)}${b.tm}${b.h.repeat(mainWidth)}${b.tr}`
  const bottom = `${b.bl}${b.h.repeat(sidebarWidth)}${b.bm}${b.h.repeat(mainWidth)}${b.br}`
  for (let i = 0; i < rowCount; i++) rows.push(`${b.v}${clampText(sidebarLines[i] || "", sidebarWidth)}${b.v}${clampText(mainLines[i] || "", mainWidth)}${b.v}`)
  const text = [top, ...rows, bottom].join("\n")
  return {
    version: 0,
    state,
    generatedAt: new Date().toISOString(),
    status: "schema-driven-preview",
    profilePath: path.relative(paths.root, paths.tuiProfile),
    schemaPath: path.relative(paths.root, paths.tuiSchema),
    profile,
    validation,
    writesDonorConfig: false,
    rendersDonorTui: false,
    touchesProtectedDonorHotPaths: false,
    artifactKind: "json+ansi-text-snapshot",
    text,
  }
}

export async function writeTuiPreview(input: { state?: string; root?: string; profile?: MendTuiProfile; dir?: string } = {}) {
  const paths = mendPaths(input.root)
  const dir = input.dir || paths.tuiPreviewDir
  await mkdir(dir, { recursive: true })
  const preview = await buildTuiPreview({ state: input.state, root: paths.root, profile: input.profile })
  const jsonPath = path.join(dir, `${preview.state}.json`)
  const textPath = path.join(dir, `${preview.state}.ansi.txt`)
  await writeJson(jsonPath, { ...preview, text: undefined, textPath: path.relative(paths.root, textPath) })
  await writeFile(textPath, `${preview.text}\n`)
  return { preview, jsonPath, textPath }
}

export async function writeTuiProposal(preference: string, root?: string) {
  if (!preference) throw new Error('Usage: mend tui propose "<natural language preference>" --dry-run')
  const paths = mendPaths(root)
  const current = await readActiveTuiProfile(paths.root)
  const next = mergeMendTuiProfile(JSON.parse(JSON.stringify(current)))
  const normalized = preference.toLowerCase()
  const patch: any[] = []
  if (/compact|compacto|pequen|pequeñ|tight/.test(normalized)) {
    next.layout.density = "compact"
    next.layout.spacing = "tight"
    next.layout.zones.sidebar.compact = true
    next.layout.zones.sidebar.width = 20
    patch.push({ op: "replace", path: "/layout/density", value: "compact" })
    patch.push({ op: "replace", path: "/layout/spacing", value: "tight" })
    patch.push({ op: "replace", path: "/layout/zones/sidebar/compact", value: true })
  }
  if (/verde|green/.test(normalized)) {
    next.theme.palette = /oscuro|dark/.test(normalized) ? "mend-green-dark" : "mend-green"
    next.theme.mode = /oscuro|dark/.test(normalized) ? "dark" : next.theme.mode
    next.theme.tokens = { ...next.theme.tokens, accent: "#22c55e", background: "#06130d", foreground: "#dcfce7", muted: "#86efac", border: "#14532d" }
    patch.push({ op: "replace", path: "/theme/palette", value: next.theme.palette })
    patch.push({ op: "merge", path: "/theme/tokens", value: next.theme.tokens })
  }
  if (/sin .*worktree|no .*worktree|disable .*worktree|without .*worktree/.test(normalized)) {
    next.widgets.enabled = next.widgets.enabled.filter((id) => id !== "worktree")
    next.widgets.order = next.widgets.order.filter((id) => id !== "worktree")
    patch.push({ op: "remove", path: "/widgets/enabled/worktree" })
    patch.push({ op: "remove", path: "/widgets/order/worktree" })
  }
  if (patch.length === 0) patch.push({ op: "test", path: "/", value: "no deterministic rule matched; profile unchanged" })
  const id = `${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${slug(preference) || "proposal"}`
  next.rollback = { ...next.rollback, enabled: true, lastAppliedProposal: null, previousProfilePath: null, updatedAt: current.rollback?.updatedAt || null }
  const validation = validateMendTuiProfile(next)
  const proposal = {
    version: 0,
    id,
    generatedAt: new Date().toISOString(),
    preference,
    status: validation.ok ? "valid-dry-run" : "invalid",
    dryRunOnly: true,
    schemaPath: path.relative(paths.root, paths.tuiSchema),
    baseProfilePath: path.relative(paths.root, paths.tuiProfile),
    patch,
    previewStates: ["home", "session", "diff", "error"],
    profile: next,
    validation,
    writesDonorConfig: false,
    touchesProtectedDonorHotPaths: false,
  }
  const proposalDir = path.join(paths.tuiProposalDir, id)
  await mkdir(proposalDir, { recursive: true })
  const proposalPath = path.join(proposalDir, "proposal.json")
  await writeJson(proposalPath, proposal)
  for (const state of proposal.previewStates) await writeTuiPreview({ state, root: paths.root, profile: next, dir: proposalDir })
  return { proposal, proposalPath, proposalDir }
}

function tuiThemeFromProfile(profile: MendTuiProfile) {
  const t = profile.theme.tokens
  return {
    "$schema": "https://mendcode.ai/theme.json",
    defs: { mendBackground: t.background, mendBackgroundPanel: t.backgroundPanel || "#0b1f16", mendForeground: t.foreground, mendMuted: t.muted, mendAccent: t.accent, mendBorder: t.border, mendError: "#ef4444", mendWarning: "#f59e0b", mendSuccess: "#22c55e", mendInfo: "#38bdf8" },
    theme: {
      primary: { dark: "mendAccent", light: "mendAccent" },
      secondary: { dark: "mendMuted", light: "mendMuted" },
      accent: { dark: "mendAccent", light: "mendAccent" },
      error: { dark: "mendError", light: "mendError" },
      warning: { dark: "mendWarning", light: "mendWarning" },
      success: { dark: "mendSuccess", light: "mendSuccess" },
      info: { dark: "mendInfo", light: "mendInfo" },
      text: { dark: "mendForeground", light: "mendForeground" },
      textMuted: { dark: "mendMuted", light: "mendMuted" },
      background: { dark: "mendBackground", light: "mendBackground" },
      backgroundPanel: { dark: "mendBackgroundPanel", light: "mendBackgroundPanel" },
      backgroundElement: { dark: "mendBackgroundPanel", light: "mendBackgroundPanel" },
      border: { dark: "mendBorder", light: "mendBorder" },
      borderActive: { dark: "mendAccent", light: "mendAccent" },
      borderSubtle: { dark: "mendBorder", light: "mendBorder" },
    },
  }
}

function tuiPluginSource(profile: MendTuiProfile, themePath: string) {
  const enabled = new Set(profile.widgets.enabled)
  const widgets = profile.widgets.order.filter((id) => enabled.has(id)).map((id) => {
    const widget = profile.widgets.config?.[id] || {}
    return { id, label: widget.label || id, value: widget.value || widget.surface || "configured" }
  })
  return `/** @jsxImportSource @opentui/solid */
const profile = ${JSON.stringify({ identity: profile.identity, theme: profile.theme, layout: profile.layout, widgets }, null, 2)}
const muted = profile.theme.tokens.muted
const accent = profile.theme.tokens.accent
function WidgetList() {
  return <box flexDirection="column">{profile.widgets.map((widget) => <box><text fg={accent}>{widget.label}</text><text fg={muted}>: {widget.value}</text></box>)}</box>
}
export default {
  id: "mendcode.tui.profile",
  tui: async (api) => {
    try {
      await api.theme.install(${JSON.stringify(themePath)})
      if (api.theme.has(${JSON.stringify(slug(profile.theme.palette) || "mendcode-theme")})) await api.theme.set(${JSON.stringify(slug(profile.theme.palette) || "mendcode-theme")})
    } catch {}
    api.command.register(() => [{ title: "TUI profile", value: "mendcode.tui.profile", description: "Open active TUI profile projection", category: "System" }])
    api.slots.register({ slots: {
      home_logo() { return <box flexDirection="column"><text fg={accent}>{profile.identity.productName}</text><text fg={muted}>{profile.identity.tagline}</text></box> },
      home_footer() { return <text fg={muted}>MendCode profile: {profile.layout.density} - donor guarded</text> },
      sidebar_title() { return <text fg={accent}>{profile.identity.productName}</text> },
      sidebar_content() { return <WidgetList /> },
      sidebar_footer() { return <text fg={muted}>profile: {profile.theme.palette}</text> },
      session_prompt_right() { return <text fg={muted}>{profile.layout.density}</text> },
    } })
  },
}
`
}

export async function writeTuiProjection(input: { root?: string; check?: boolean } = {}) {
  const paths = mendPaths(input.root)
  const profile = await readActiveTuiProfile(paths.root)
  const validation = validateMendTuiProfile(profile)
  if (!validation.ok) throw new Error(`Invalid TUI profile:\n${validation.failures.join("\n")}`)
  const outputDir = path.join(paths.tuiRuntimeDir, "latest")
  await mkdir(outputDir, { recursive: true })
  const pluginPath = path.join(outputDir, "mendcode-tui-plugin.tsx")
  const themeName = slug(profile.theme.palette) || "mendcode-theme"
  const themePath = path.join(outputDir, `${themeName}.json`)
  const configPath = path.join(outputDir, "tui.json")
  const projectionPath = path.join(outputDir, "projection.json")
  const buildOut = path.join(outputDir, "mendcode-tui-plugin.check.js")
  await writeJson(themePath, tuiThemeFromProfile(profile))
  await writeFile(pluginPath, tuiPluginSource(profile, themePath))
  await writeJson(configPath, { "$schema": "https://mendcode.ai/tui.json", theme: themeName, plugin: [`file://${pluginPath}`], plugin_enabled: { "mendcode.tui.profile": true } })
  const result: any = {
    version: 0,
    generatedAt: new Date().toISOString(),
    status: "projected-isolated-opencode-tui-plugin",
    profilePath: path.relative(paths.root, paths.tuiProfile),
    schemaPath: path.relative(paths.root, paths.tuiSchema),
    outputDir: path.relative(paths.root, outputDir),
    pluginPath: path.relative(paths.root, pluginPath),
    themePath: path.relative(paths.root, themePath),
    tuiConfigPath: path.relative(paths.root, configPath),
    pluginID: "mendcode.tui.profile",
    themeName,
    slotsProjected: ["home_logo", "home_footer", "sidebar_title", "sidebar_content", "sidebar_footer", "session_prompt_right"],
    widgetsProjected: profile.widgets.order.filter((id) => profile.widgets.enabled.includes(id)),
    rendersDonorTui: false,
    writesDonorConfig: false,
    touchesProtectedDonorHotPaths: false,
    check: null,
    note: "Projection is generated under ignored .mendcode/tui/runtime. It is ready for isolated donor-compatible config usage, but it is not a full-screen interactive runtime proof by itself.",
  }
  if (input.check) {
    const build = spawnSync("bun", ["build", pluginPath, "--outfile", buildOut, "--external", "@opentui/solid/jsx-runtime", "--external", "@opentui/solid"], { cwd: paths.root, encoding: "utf8", stdio: "pipe", env: process.env })
    result.check = { command: `bun build ${path.relative(paths.root, pluginPath)} --outfile ${path.relative(paths.root, buildOut)} --external @opentui/solid/jsx-runtime --external @opentui/solid`, exitCode: build.status, stdout: build.stdout, stderr: build.stderr, outputPath: path.relative(paths.root, buildOut) }
    if (build.status !== 0) result.status = "projection-check-failed"
  }
  await writeJson(projectionPath, result)
  return { ...result, projectionPath: path.relative(paths.root, projectionPath) }
}

export async function buildTuiRenderProof(root?: string) {
  const paths = mendPaths(root)
  const profile = await readActiveTuiProfile(paths.root)
  const promptMode = (await readPromptMode(paths.root)).mode
  const resource = {
    version: 0,
    identity: { productName: "MendCode", subtitle: "coding agent harness", status: "runtime proof" },
    layout: { width: 72, sidebarWidth: 24 },
    widgets: {},
  }
  const width = Math.max(48, Number(resource.layout?.width) || 72)
  const sidebarWidth = Math.min(Math.max(18, Number(resource.layout?.sidebarWidth) || 24), width - 24)
  const mainWidth = width - sidebarWidth - 3
  const sidebarLines = [resource.identity?.productName || "MendCode", resource.identity?.subtitle || "coding agent harness", "", ...widgetLines(profile, { resource, promptMode }), "", `Profile: ${profile.profile}`, "Donor: guarded"]
  const mainLines = [resource.identity.status, "mend run/chat: ready", "tool/apply: next sprint", "TUI source: mend/assets/tui", "state: .mendcode/tui", "hot paths: untouched", "render: terminal text proof"]
  const rowCount = Math.max(sidebarLines.length, mainLines.length)
  const top = `┌${"─".repeat(sidebarWidth)}┬${"─".repeat(mainWidth)}┐`
  const bottom = `└${"─".repeat(sidebarWidth)}┴${"─".repeat(mainWidth)}┘`
  const rows: string[] = []
  for (let i = 0; i < rowCount; i++) rows.push(`│${clampText(sidebarLines[i] || "", sidebarWidth)}│${clampText(mainLines[i] || "", mainWidth)}│`)
  const renderedText = [top, ...rows, bottom].join("\n")
  return {
    version: 0,
    generatedAt: new Date().toISOString(),
    status: "rendered-terminal-proof",
    resourcePath: null,
    archivedResourcePath: path.relative(paths.root, path.join(paths.root, "docs", "evidence", "tui", "default-render.json")),
    profilePath: path.relative(paths.root, paths.tuiProfile),
    textPath: path.relative(paths.root, paths.tuiRenderText),
    dimensions: { width, sidebarWidth, mainWidth, rows: rowCount },
    profile: profile.profile,
    sidebarWidgets: profile.widgets.order,
    rendersMendCodeTui: true,
    rendersDonorTui: false,
    writesDonorConfig: false,
    touchesProtectedDonorHotPaths: false,
    protectedHotPaths: protectedTuiHotPaths(),
    renderedText,
  }
}

export async function writeTuiRender(root?: string) {
  const paths = mendPaths(root)
  const proof = await buildTuiRenderProof(paths.root)
  await writeJson(paths.tuiRenderState, { ...proof, renderedText: undefined })
  await mkdir(path.dirname(paths.tuiRenderText), { recursive: true })
  await writeFile(paths.tuiRenderText, `${proof.renderedText}\n`)
  return proof
}

async function readUpstreamRuntimeCommit(root: string) {
  try {
    const state = JSON.parse(await readFile(path.join(root, ".mendcode", "upstream.json"), "utf8"))
    return state.runtimeCommit || null
  } catch {
    return null
  }
}

export async function tuiPreviewPlan(root?: string) {
  const paths = mendPaths(root)
  const profile = await readActiveTuiProfile(paths.root)
  const plan = {
    version: 0,
    generatedAt: new Date().toISOString(),
    source: path.relative(paths.root, paths.tuiProfile),
    status: "preview-plan-only",
    profile: profile.profile || null,
    projectedIdentity: {
      productName: "MendCode",
      publicRuntimeIdentity: "mend",
      donorRuntimeIdentity: "guarded-internal-opencode",
    },
    sidebarWidgets: profile.widgets.enabled || [],
    rendererTargets: ["status-json", "future-safe-preview-harness"],
    writesPreviewArtifact: true,
    rendersDonorTui: false,
    touchesProtectedDonorHotPaths: false,
    rollback: profile.rollback || { enabled: true },
    requiredBeforeRuntimePatch: ["ADR", "tests", "runtime/render evidence", "rollback plan"],
  }
  await writeJson(paths.tuiPreviewPlan, plan)
  return { ...plan, path: path.relative(paths.root, paths.tuiPreviewPlan) }
}

export async function tuiRuntimePlan(root?: string) {
  const paths = mendPaths(root)
  const engineRoot = path.join(paths.root, ".agents", "vendor", "opencode")
  const slotNames = new Set<string>()
  const testFiles: string[] = []
  for (const rel of sourceFiles) {
    const text = await readTextIfExists(path.join(engineRoot, rel))
    if (!text) continue
    if (rel.includes("/test/")) testFiles.push(rel)
    for (const match of text.matchAll(/<TuiPluginRuntime\.Slot\s+name="([^"]+)"/g)) slotNames.add(match[1]!)
    for (const match of text.matchAll(/\bname:\s*"([^"]+)"/g)) {
      if (rel.includes("slot") || rel.includes("feature-plugins")) slotNames.add(match[1]!)
    }
  }
  const protectedSet = new Set(protectedTuiHotPaths())
  const requiredProfileWidgets = ["focus", "budget"]
  const profile = await readActiveTuiProfile(paths.root)
  const profileWidgets = Array.isArray(profile.widgets.enabled) ? profile.widgets.enabled : []
  const plan = {
    version: 0,
    generatedAt: new Date().toISOString(),
    status: "adr-ready-runtime-plan",
    donorCommit: await readUpstreamRuntimeCommit(paths.root),
    profilePath: path.relative(paths.root, paths.tuiProfile),
    profileWidgets,
    sourceFiles,
    donorSlotsObserved: [...slotNames].sort(),
    pluginApiEvidence: {
      configFile: "tui.json",
      moduleShape: "default export { id, tui }",
      targetExclusive: true,
      localFilePluginsSupported: true,
      slotsRegisterSupported: true,
      pureModeSkipsExternalPlugins: true,
    },
    safestFirstRuntimeProof: {
      approach: "MendCode-owned local TUI plugin file plus generated local tui.json in an isolated temp/config dir",
      commandShape: "future mend tui probe --pure|--render",
      allowed: ["read donor TUI plugin spec/types/tests", "generate isolated temp plugin/config", "run donor TUI plugin loader tests/probe only with explicit runtime command"],
      blocked: ["edit protected donor hot paths", "run public donor auth/account/update commands", "claim rendered sidebar integration without terminal render evidence"],
    },
    protectedHotPaths: protectedTuiHotPaths(),
    readsProtectedDonorHotPaths: sourceFiles.some((rel) => protectedSet.has(rel)),
    touchesProtectedDonorHotPaths: false,
    rendersDonorTui: false,
    writesDonorConfig: false,
    requiredBeforePatch: ["ADR accepted", "isolated probe command", "runtime/render evidence", "rollback plan"],
    failures: requiredProfileWidgets.filter((widget) => !profileWidgets.includes(widget)).map((widget) => `tui profile missing required widget: ${widget}`),
  }
  await writeJson(paths.tuiRuntimePlan, plan)
  return { ...plan, path: path.relative(paths.root, paths.tuiRuntimePlan) }
}

export async function tuiProbe(root?: string) {
  const paths = mendPaths(root)
  const runDir = paths.tuiProbeRunDir
  await mkdir(runDir, { recursive: true })
  const pluginPath = path.join(runDir, "mendcode-tui-probe.ts")
  const tuiConfigPath = path.join(runDir, "tui.json")
  const resultPath = path.join(runDir, "probe-result.json")
  const enginePkg = path.join(paths.root, ".agents", "vendor", "opencode", "packages", "opencode")
  const profile = await readActiveTuiProfile(paths.root)
  await writeFile(
    pluginPath,
    `export default {
  id: "mendcode.tui.probe",
  tui: async (api) => {
    api.command.register(() => [{ title: "TUI probe", value: "mendcode.probe", description: "Isolated TUI plugin probe", category: "System" }])
    api.slots.register({ id: "mendcode.tui.probe.slots", slots: { sidebar_title() { return null }, sidebar_content() { return null }, sidebar_footer() { return null } } })
  },
}
`,
  )
  await writeJson(tuiConfigPath, {
    "$schema": "https://mendcode.ai/tui.json",
    plugin: [`file://${pluginPath}`],
    plugin_enabled: { "mendcode.tui.probe": true },
  })
  const testTargets = ["test/cli/tui/plugin-loader-pure.test.ts", "test/cli/tui/slot-replace.test.tsx"]
  const bun = spawnSync("bun", ["test", ...testTargets], { cwd: enginePkg, encoding: "utf8", stdio: "pipe", env: process.env })
  const result = {
    version: 0,
    generatedAt: new Date().toISOString(),
    status: bun.status === 0 ? "passed" : "failed",
    runDir: path.relative(paths.root, runDir),
    pluginPath: path.relative(paths.root, pluginPath),
    tuiConfigPath: path.relative(paths.root, tuiConfigPath),
    profileWidgets: profile.widgets.enabled,
    donorTests: testTargets.map((target) => path.join(path.relative(paths.root, enginePkg), target)),
    command: ["bun", "test", ...testTargets].join(" "),
    cwd: path.relative(paths.root, enginePkg),
    exitCode: bun.status,
    stdout: bun.stdout,
    stderr: bun.stderr,
    rendersDonorTui: false,
    writesDonorConfig: false,
    touchesProtectedDonorHotPaths: false,
    note: ".mendcode/runs is ignored; this is local runtime evidence only, not a committed artifact.",
  }
  await writeJson(resultPath, result)
  return { ...result, resultPath: path.relative(paths.root, resultPath) }
}
