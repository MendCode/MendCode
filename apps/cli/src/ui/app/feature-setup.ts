import type { Settings, VoiceReport } from "@mendcode/protocol"
import { featureOn } from "@mendcode/protocol/wire"
import type { AppContext } from "./context"
import { setupPage } from "./setup-confirm"

/** Loaded only by an explicit setup command, never by startup or a streaming frame. */
export async function voiceSetup(ctx: AppContext, valid: boolean) {
  const { input, state } = ctx
  if (!valid) return setupPage(ctx, "Voice setup", "Usage: /voice setup")
  await setupPage(ctx, "Voice setup", "Checking dictation readiness…")
  const page = state.textPage
  const [settingsReply, statusReply] = await Promise.all([input.send({ type: "settings.get" }), input.send({ type: "voice.control", action: "status" })])
  if (state.page !== "text" || state.textPage !== page) return
  if (!settingsReply.ok || !statusReply.ok) return setupPage(ctx, "Voice setup", !settingsReply.ok ? settingsReply.error.message : !statusReply.ok ? statusReply.error.message : "Unable to check voice")
  const settings = settingsReply.result?.settings as Settings | undefined
  if (!settings) return setupPage(ctx, "Voice setup", "Unable to read settings. Retry /voice setup.")
  const status = statusReply.result as unknown as VoiceReport
  const allowed = featureOn(settings, "voice", { safeMode: input.safeMode })
  const text = ["Voice setup · full tier", `${status.provider}/${status.model}`, status.provider === "local" ? "Speech stays on this Mac." : "Recorded audio is uploaded to the configured transcription provider and may be billed.", !allowed ? "Voice is unavailable in this tier or override. Use /tier full or /tier voice on, then retry." : status.ready ? "Already ready. Nothing changed. Use /voice to dictate." : status.issue ?? "Enable dictation.", "No recording, installation or OS permission change happens during setup."]
  return setupPage(ctx, "Voice setup", text.join("\n"), !allowed || status.ready ? undefined : async () => {
    const fresh = await input.send({ type: "settings.get" })
    const now = fresh.ok ? fresh.result?.settings as Settings : undefined
    if (!now || JSON.stringify(now.voice) !== JSON.stringify(settings.voice) || !featureOn(now, "voice", { safeMode: input.safeMode })) return setupPage(ctx, "Voice setup", "Voice settings changed. Run /voice setup again.")
    const applying = state.textPage
    const saved = await input.send({ type: "settings.set", patch: { voice: { ...now.voice, enabled: true } } })
    if (state.page !== "text" || state.textPage !== applying) return
    if (!saved.ok) return setupPage(ctx, "Voice setup", saved.error.message)
    const check = await input.send({ type: "voice.control", action: "status" })
    if (state.page !== "text" || state.textPage !== applying) return
    const result = check.ok ? check.result as unknown as VoiceReport : undefined
    await setupPage(ctx, "Voice setup", result?.ready ? "Voice ready. Use /voice or hold space to dictate." : `Voice enabled, but not ready.\n${result?.issue ?? (!check.ok ? check.error.message : "Check /voice status")}\nConnect the transcription provider with /connect if credentials are missing. OS microphone and speech permissions must be granted by you on first use.`)
  })
}

export async function graphSetup(ctx: AppContext, settings: Settings, valid: boolean) {
  const { input, state } = ctx
  const directory = input.directory
  if (!valid) return setupPage(ctx, "Graph setup", "Usage: /graph setup")
  if (!directory || input.remote) return setupPage(ctx, "Graph setup", "Open a local project session to build its code graph.")
  if (!featureOn(settings, "codegraph", { safeMode: input.safeMode })) return setupPage(ctx, "Graph setup", "Code graph requires balanced tier or a codegraph override. Use /tier balanced or /tier codegraph on, then retry.")
  return setupPage(ctx, "Graph setup", `Code graph · balanced tier\nProject: ${directory}\n${settings.projectConfig?.[directory]?.codegraph_index === "on" ? "Indexing already enabled." : "Enable indexing for this project."}\nBuild or refresh the local code graph. This reads source and uses local CPU and disk; no model calls or uploads.\nProtected folders remain excluded. Global defaults and autopilot are unchanged.`, async () => {
    const current = await input.send({ type: "settings.get" })
    const fresh = current.ok ? current.result?.settings as Settings : undefined
    if (!fresh || !featureOn(fresh, "codegraph", { safeMode: input.safeMode })) return setupPage(ctx, "Graph setup", "Code graph is now disabled or settings could not be read. Retry setup.")
    const applying = state.textPage
    if (fresh.projectConfig?.[directory]?.codegraph_index !== "on") {
      const entry = { ...fresh.projectConfig?.[directory], codegraph_index: "on" as const }
      const saved = await input.send({ type: "settings.set", patch: { projectConfig: { ...fresh.projectConfig, [directory]: entry } } })
      if (state.page !== "text" || state.textPage !== applying) return
      if (!saved.ok) return setupPage(ctx, "Graph setup", saved.error.message)
    }
    await setupPage(ctx, "Graph setup", "Indexing source files…")
    const page = state.textPage
    const built = await input.send({ type: "codegraph.overview", directory })
    if (state.page !== "text" || state.textPage !== page) return
    const report = built.ok ? built.result as { state?: string; reason?: string; total?: { files: number; symbols: number } } : undefined
    return setupPage(ctx, "Graph setup", report?.state === "ready" ? `Graph ready: ${report.total?.files ?? 0} files, ${report.total?.symbols ?? 0} symbols.\nGraph tools can now navigate this project.` : `Indexing enabled, but the graph is not ready.\n${report?.reason ?? (!built.ok ? built.error.message : "Try /graph setup again.")}`)
  })
}
