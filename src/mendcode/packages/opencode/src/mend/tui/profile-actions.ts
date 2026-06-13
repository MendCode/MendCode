import { mkdir, readFile, writeFile, copyFile, rm, readdir } from "fs/promises"
import { spawnSync } from "child_process"
import { existsSync } from "fs"
import path from "path"
import { mendPaths } from "../config/paths"
import type { MendTuiProfile } from "../profile"
import { globalMendTuiProfilePath, loadMendTuiProfile, mergeMendTuiProfile, validateMendTuiProfile } from "../profile"
import { MEND_TUI_CAPABILITY_CONTRACT_VERSION } from "./capabilities"

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T
  } catch {
    return fallback
  }
}

async function writeJson(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`)
}

export async function readActiveTuiProfile(root?: string) {
  return (await loadMendTuiProfile(root)).profile
}

export async function writeActiveTuiProfile(profile: MendTuiProfile, root?: string) {
  const validation = validateMendTuiProfile(profile)
  if (!validation.ok) throw new Error(validation.failures.join("\n"))
  await writeJson(globalMendTuiProfilePath(), profile)
}

export async function snapshotTuiProfile(root?: string) {
  const paths = mendPaths(root)
  const profilePath = globalMendTuiProfilePath()
  const backupDir = path.join(path.dirname(profilePath), "backups")
  await mkdir(backupDir, { recursive: true })
  const id = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)
  const backup = path.join(backupDir, `${id}-runtime.json`)
  if (existsSync(profilePath)) await copyFile(profilePath, backup)
  else if (existsSync(paths.tuiProfile)) await copyFile(paths.tuiProfile, backup)
  else await writeJson(backup, await readActiveTuiProfile(root))
  return backup
}

export async function applyTuiPreset(preset: "compact" | "comfortable" | "spacious" | "toggle-worktree" | "toggle-prompt-right" | "toggle-footer" | "toggle-sidebar", root?: string) {
  const paths = mendPaths(root)
  const current = await readActiveTuiProfile(root)
  const backup = await snapshotTuiProfile(root)
  const next = mergeMendTuiProfile(current)
  if (preset === "compact") {
    next.profile = "compact-runtime"
    next.layout.density = "compact"
    next.layout.spacing = "tight"
    next.layout.zones.sidebar.compact = true
    next.layout.zones.sidebar.width = 20
  }
  if (preset === "comfortable") {
    next.profile = "comfortable-runtime"
    next.layout.density = "comfortable"
    next.layout.spacing = "normal"
    next.layout.zones.sidebar.compact = false
    next.layout.zones.sidebar.width = 28
  }
  if (preset === "spacious") {
    next.profile = "spacious-runtime"
    next.layout.density = "spacious"
    next.layout.spacing = "loose"
    next.layout.zones.sidebar.compact = false
    next.layout.zones.sidebar.width = 34
  }
  if (preset === "toggle-worktree") {
    const enabled = new Set(next.widgets.enabled)
    if (enabled.has("worktree")) enabled.delete("worktree")
    else enabled.add("worktree")
    next.widgets.enabled = [...enabled]
    next.widgets.order = next.widgets.order.filter((id) => enabled.has(id))
    if (enabled.has("worktree") && !next.widgets.order.includes("worktree")) next.widgets.order.push("worktree")
  }
  if (preset === "toggle-prompt-right") {
    next.layout.zones.prompt.rightSurface = next.layout.zones.prompt.rightSurface === false
  }
  if (preset === "toggle-footer") {
    next.layout.zones.footer.enabled = next.layout.zones.footer.enabled === false
  }
  if (preset === "toggle-sidebar") {
    next.layout.zones.sidebar.enabled = next.layout.zones.sidebar.enabled === false
  }
  next.rollback = {
    ...next.rollback,
    enabled: true,
    lastAppliedProposal: `runtime:${preset}`,
    previousProfilePath: path.relative(paths.root, backup),
    updatedAt: new Date().toISOString(),
  }
  await writeActiveTuiProfile(next, root)
  return { profile: next, backupPath: backup, profilePath: globalMendTuiProfilePath() }
}

export async function applyTuiProposal(proposalID: string, root?: string) {
  if (!proposalID) throw new Error("Usage: mendcode tui apply <proposal-id>")
  const paths = mendPaths(root)
  const proposalPath = path.join(paths.tuiProposalDir, proposalID, "proposal.json")
  const proposal = await readJson<{ profile?: MendTuiProfile } | undefined>(proposalPath, undefined)
  if (!proposal?.profile) throw new Error(`Unknown TUI proposal: ${proposalID}`)
  const next = mergeMendTuiProfile(proposal.profile)
  const validation = validateMendTuiProfile(next)
  if (!validation.ok) throw new Error(`Refusing invalid TUI proposal ${proposalID}:\n${validation.failures.join("\n")}`)
  const backup = await snapshotTuiProfile(root)
  next.rollback = {
    ...next.rollback,
    enabled: true,
    lastAppliedProposal: proposalID,
    previousProfilePath: path.relative(paths.root, backup),
    updatedAt: new Date().toISOString(),
  }
  await writeActiveTuiProfile(next, root)
  return { profile: next, proposalID, backupPath: backup, profilePath: globalMendTuiProfilePath() }
}

export async function rollbackTuiPreset(root?: string) {
  const paths = mendPaths(root)
  const current = await readActiveTuiProfile(root)
  const backupRel = current.rollback.previousProfilePath
  if (!backupRel) throw new Error("No rollback profile recorded")
  const backupPath = path.resolve(paths.root, backupRel)
  const previous = mergeMendTuiProfile(await readJson<unknown>(backupPath, undefined))
  previous.rollback = { ...previous.rollback, enabled: true, lastAppliedProposal: null, previousProfilePath: null, updatedAt: new Date().toISOString() }
  await writeActiveTuiProfile(previous, root)
  return { profile: previous, restoredFrom: backupPath, profilePath: globalMendTuiProfilePath() }
}

const defaultHomeAscii = String.raw`
MendCode
terminal-first coding

Ask anything.
`.trim()

const defaultSessionAscii = `
+ chat ---------------------------------------------+
| transcript preview                                |
+---------------------------------------------------+
`.trim()

export type MendLegacySurfaceMetadata = {
  contractVersion: string
  generatedAt: string
  surfaces: Array<{
    file: string
    mappedSurface: string
    runtimeSlot: string
    notes: string
    alternatives: string[]
  }>
}

function buildLegacySurfaceMetadata(input: { homeAscii: string; sessionAscii: string }): MendLegacySurfaceMetadata {
  return {
    contractVersion: MEND_TUI_CAPABILITY_CONTRACT_VERSION,
    generatedAt: new Date().toISOString(),
    surfaces: [
      {
        file: "home.ascii",
        mappedSurface: "home.logo",
        runtimeSlot: "home_logo",
        notes: `Legacy ASCII keeps home branding safe-first. ${input.homeAscii.trim() ? "Content present." : "Content empty; fallback remains host-owned."}`,
        alternatives: ["home.bottom", "sidebar.title"],
      },
      {
        file: "session.ascii",
        mappedSurface: "sidebar.content",
        runtimeSlot: "sidebar_content",
        notes: `Legacy session ASCII is classified as sidebar content compatibility, not prompt/parser takeover. ${input.sessionAscii.trim() ? "Content present." : "Content empty; fallback remains host-owned."}`,
        alternatives: ["session.prompt.visual", "session.prompt.right"],
      },
    ],
  }
}

async function writeLegacySurfaceMetadata(input: { root: string; homeAscii: string; sessionAscii: string }) {
  const paths = mendPaths(input.root)
  const metadata = buildLegacySurfaceMetadata({ homeAscii: input.homeAscii, sessionAscii: input.sessionAscii })
  await writeJson(paths.tuiSurfaceMetadata, metadata)
  return metadata
}

export async function readLegacyTuiSurfaceMetadata(root?: string) {
  const paths = mendPaths(root)
  const fallback = buildLegacySurfaceMetadata({
    homeAscii: await readText(paths.tuiSurfaceHomeAscii, defaultHomeAscii),
    sessionAscii: await readText(paths.tuiSurfaceSessionAscii, defaultSessionAscii),
  })
  return readJson<MendLegacySurfaceMetadata>(paths.tuiSurfaceMetadata, fallback)
}

function surfacePluginSource(input: { homeAscii: string; sessionAscii: string }) {
  return `/** @jsxImportSource @opentui/solid */
const homeAscii = ${JSON.stringify(input.homeAscii)}
const sessionAscii = ${JSON.stringify(input.sessionAscii)}
function Lines(props) {
  return <box flexDirection="column">{props.text.split("\\n").map((line) => <text>{line}</text>)}</box>
}
export default {
  id: "mendcode.tui.surfaces",
  tui: async (api) => {
    api.command.register(() => [{ title: "Edit TUI surfaces", value: "mendcode.tui.surfaces", description: "Edit local TUI surfaces", category: "System" }])
    api.slots.register({ slots: {
      home_logo() { return <Lines text={homeAscii} /> },
      home_bottom() { return <text>MendCode TUI source active</text> },
      sidebar_content() { return <Lines text={sessionAscii} /> },
      session_prompt_right() { return <text>mend</text> },
    } })
  },
}
`
}

async function readText(file: string, fallback: string) {
  try {
    return await readFile(file, "utf8")
  } catch {
    return fallback
  }
}

export async function ensureTuiSurfaceWorkspace(root?: string) {
  const paths = mendPaths(root)
  await mkdir(paths.tuiSurfaceDir, { recursive: true })
  let homeAscii = await readText(paths.tuiSurfaceHomeAscii, defaultHomeAscii)
  let sessionAscii = await readText(paths.tuiSurfaceSessionAscii, defaultSessionAscii)
  const homeNeedsRewrite = homeAscii.includes(".mendcode/tui/surfaces")
  const sessionNeedsRewrite = sessionAscii.includes(".mendcode/tui/surfaces")
  homeAscii = homeAscii.replace("Ask anything. Change this file from .mendcode/tui/surfaces/home.ascii", "Ask anything.")
  sessionAscii = sessionAscii.replace("\n\nEdit .mendcode/tui/surfaces/session.ascii", "")
  if (!existsSync(paths.tuiSurfaceHomeAscii)) await writeFile(paths.tuiSurfaceHomeAscii, `${homeAscii}\n`)
  if (!existsSync(paths.tuiSurfaceSessionAscii)) await writeFile(paths.tuiSurfaceSessionAscii, `${sessionAscii}\n`)
  if (homeNeedsRewrite) await writeFile(paths.tuiSurfaceHomeAscii, `${homeAscii}\n`)
  if (sessionNeedsRewrite) await writeFile(paths.tuiSurfaceSessionAscii, `${sessionAscii}\n`)
  await writeFile(paths.tuiSurfacePlugin, surfacePluginSource({ homeAscii, sessionAscii }))
  const metadata = await writeLegacySurfaceMetadata({ root: paths.root, homeAscii, sessionAscii })
  return {
    dir: paths.tuiSurfaceDir,
    pluginPath: paths.tuiSurfacePlugin,
    homeAsciiPath: paths.tuiSurfaceHomeAscii,
    sessionAsciiPath: paths.tuiSurfaceSessionAscii,
    metadataPath: paths.tuiSurfaceMetadata,
    metadata,
    homeAscii,
    sessionAscii,
  }
}

export async function readTuiSurfaceWorkspace(root?: string) {
  await ensureTuiSurfaceWorkspace(root)
  const paths = mendPaths(root)
  return {
    dir: paths.tuiSurfaceDir,
    pluginPath: paths.tuiSurfacePlugin,
    homeAsciiPath: paths.tuiSurfaceHomeAscii,
    sessionAsciiPath: paths.tuiSurfaceSessionAscii,
    homeAscii: await readText(paths.tuiSurfaceHomeAscii, defaultHomeAscii),
    sessionAscii: await readText(paths.tuiSurfaceSessionAscii, defaultSessionAscii),
  }
}

export type TuiSurfaceWorkspace = Awaited<ReturnType<typeof readTuiSurfaceWorkspace>>

function draftPaths(root?: string) {
  const paths = mendPaths(root)
  const dir = path.join(paths.mendDir, "tui", "drafts", "current")
  return {
    ...paths,
    draftDir: dir,
    draftPlugin: path.join(dir, "plugin.tsx"),
    draftHomeAscii: path.join(dir, "home.ascii"),
    draftSessionAscii: path.join(dir, "session.ascii"),
  }
}

async function ensureTuiSurfaceDraft(root?: string) {
  const paths = draftPaths(root)
  const active = await readTuiSurfaceWorkspace(paths.root)
  await mkdir(paths.draftDir, { recursive: true })
  const homeAscii = await readText(paths.draftHomeAscii, active.homeAscii)
  const sessionAscii = await readText(paths.draftSessionAscii, active.sessionAscii)
  if (!existsSync(paths.draftHomeAscii)) await writeFile(paths.draftHomeAscii, `${homeAscii.trimEnd()}\n`)
  if (!existsSync(paths.draftSessionAscii)) await writeFile(paths.draftSessionAscii, `${sessionAscii.trimEnd()}\n`)
  await writeFile(paths.draftPlugin, surfacePluginSource({ homeAscii, sessionAscii }))
  return {
    dir: paths.draftDir,
    pluginPath: paths.draftPlugin,
    homeAsciiPath: paths.draftHomeAscii,
    sessionAsciiPath: paths.draftSessionAscii,
    homeAscii,
    sessionAscii,
  }
}

export async function readTuiSurfaceDraft(root?: string) {
  return ensureTuiSurfaceDraft(root)
}

export async function resetTuiSurfaceDraft(root?: string) {
  const paths = draftPaths(root)
  await rm(paths.draftDir, { recursive: true, force: true })
  return ensureTuiSurfaceDraft(paths.root)
}

export async function restoreTuiSurfaceDraft(input: { homeAscii: string; sessionAscii: string }, root?: string) {
  const paths = draftPaths(root)
  await mkdir(paths.draftDir, { recursive: true })
  await writeFile(paths.draftHomeAscii, `${input.homeAscii.trimEnd()}\n`)
  await writeFile(paths.draftSessionAscii, `${input.sessionAscii.trimEnd()}\n`)
  return ensureTuiSurfaceDraft(paths.root)
}

function checkTuiPlugin(input: { root: string; pluginPath: string; outputPath: string }) {
  const check = spawnSync(
    "bun",
    ["build", input.pluginPath, "--outfile", input.outputPath, "--external", "@opentui/solid/jsx-runtime", "--external", "@opentui/solid"],
    {
      cwd: input.root,
      encoding: "utf8",
      stdio: "pipe",
      env: process.env,
    },
  )
  return {
    exitCode: check.status,
    stdout: check.stdout,
    stderr: check.stderr,
    outputPath: input.outputPath,
  }
}

export async function checkTuiSurfaceDraft(root?: string) {
  const paths = draftPaths(root)
  const draft = await ensureTuiSurfaceDraft(paths.root)
  return {
    ...draft,
    check: checkTuiPlugin({
      root: paths.root,
      pluginPath: draft.pluginPath,
      outputPath: path.join(paths.draftDir, "plugin.check.js"),
    }),
  }
}

export async function applyTuiSurfaceDraftPatch(
  input: { homeAscii?: string; sessionAscii?: string; pluginSource?: string },
  root?: string,
) {
  const paths = draftPaths(root)
  const before = await ensureTuiSurfaceDraft(paths.root)
  const next = {
    homeAscii: input.homeAscii ?? before.homeAscii,
    sessionAscii: input.sessionAscii ?? before.sessionAscii,
  }
  await restoreTuiSurfaceDraft(next, paths.root)
  if (input.pluginSource) await writeFile(paths.draftPlugin, `${input.pluginSource.trimEnd()}\n`)
  const updated = {
    dir: paths.draftDir,
    pluginPath: paths.draftPlugin,
    homeAsciiPath: paths.draftHomeAscii,
    sessionAsciiPath: paths.draftSessionAscii,
    homeAscii: await readText(paths.draftHomeAscii, next.homeAscii),
    sessionAscii: await readText(paths.draftSessionAscii, next.sessionAscii),
  }
  const check = checkTuiPlugin({
    root: paths.root,
    pluginPath: paths.draftPlugin,
    outputPath: path.join(paths.draftDir, "plugin.check.js"),
  })
  if (check.exitCode !== 0) {
    await restoreTuiSurfaceDraft(before, paths.root)
    return {
      ...updated,
      check,
      reverted: true,
    }
  }
  return {
    ...updated,
    check,
    reverted: false,
  }
}

export async function applyTuiSurfaceDraft(root?: string) {
  const paths = draftPaths(root)
  const active = await readTuiSurfaceWorkspace(paths.root)
  const draft = await ensureTuiSurfaceDraft(paths.root)
  const id = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)
  const historyDir = path.join(paths.mendDir, "tui", "history", id)
  await mkdir(historyDir, { recursive: true })
  await writeFile(path.join(historyDir, "before.home.ascii"), `${active.homeAscii.trimEnd()}\n`)
  await writeFile(path.join(historyDir, "before.session.ascii"), `${active.sessionAscii.trimEnd()}\n`)
  await writeFile(path.join(historyDir, "after.home.ascii"), `${draft.homeAscii.trimEnd()}\n`)
  await writeFile(path.join(historyDir, "after.session.ascii"), `${draft.sessionAscii.trimEnd()}\n`)
  await writeFile(paths.tuiSurfaceHomeAscii, `${draft.homeAscii.trimEnd()}\n`)
  await writeFile(paths.tuiSurfaceSessionAscii, `${draft.sessionAscii.trimEnd()}\n`)
  const updated = await ensureTuiSurfaceWorkspace(paths.root)
  const nextDraft = await resetTuiSurfaceDraft(paths.root)
  return { ...updated, draft: nextDraft, historyDir }
}

export async function restoreLatestTuiSurfaceHistory(root?: string) {
  const paths = draftPaths(root)
  const historyRoot = path.join(paths.mendDir, "tui", "history")
  const entries = await readdir(historyRoot, { withFileTypes: true }).catch(() => [])
  const latest = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .at(-1)
  if (!latest) throw new Error("No applied TUI surface history found")
  const historyDir = path.join(historyRoot, latest)
  const homeAscii = await readText(path.join(historyDir, "before.home.ascii"), defaultHomeAscii)
  const sessionAscii = await readText(path.join(historyDir, "before.session.ascii"), defaultSessionAscii)
  await mkdir(paths.tuiSurfaceDir, { recursive: true })
  await writeFile(paths.tuiSurfaceHomeAscii, `${homeAscii.trimEnd()}\n`)
  await writeFile(paths.tuiSurfaceSessionAscii, `${sessionAscii.trimEnd()}\n`)
  const restored = await ensureTuiSurfaceWorkspace(paths.root)
  const draft = await resetTuiSurfaceDraft(paths.root)
  return { ...restored, draft, historyDir }
}

export async function restoreTuiSurfaceWorkspace(input: { homeAscii: string; sessionAscii: string }, root?: string) {
  const paths = mendPaths(root)
  await mkdir(paths.tuiSurfaceDir, { recursive: true })
  await writeFile(paths.tuiSurfaceHomeAscii, `${input.homeAscii.trimEnd()}\n`)
  await writeFile(paths.tuiSurfaceSessionAscii, `${input.sessionAscii.trimEnd()}\n`)
  const restored = await ensureTuiSurfaceWorkspace(paths.root)
  const buildOut = path.join(paths.tuiSurfaceDir, "plugin.check.js")
  return {
    ...restored,
    check: checkTuiPlugin({ root: paths.root, pluginPath: restored.pluginPath, outputPath: buildOut }),
  }
}
