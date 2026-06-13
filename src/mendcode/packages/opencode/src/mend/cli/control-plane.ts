import { readFile } from "fs/promises"
import path from "path"
import { mendPaths } from "../config/paths"
import { readPromptMode, cyclePromptMode, writePromptMode } from "../prompt/mode"
import { mendStatusSummary, integrationStatus } from "../commands/status"
import { readActiveTuiProfile, applyTuiProposal, rollbackTuiPreset, applyTuiPreset } from "../tui/profile-actions"
import { tuiPreviewPlan, tuiProbe, tuiRuntimePlan, writeTuiPreview, writeTuiProjection, writeTuiProposal, writeTuiRender } from "../tui/evidence"
import { loadMendTuiProfile, validateMendTuiProfile } from "../profile"
import { modelPresets, modelRoleProjection, readModelsConfig, refreshGeneratedRuntimeModelConfig, resolveModelRoles, validateProviderModelID, writeGlobalModelsConfig } from "../config/models"
import { mendMcpStatus, writeMendMcpServer } from "../config/mcp"
import { baselineUpstream, contextRefresh, contextShow, contextStatus, focusList, focusShow, focusStatus, focusUse, initProject, packageMetadata, packageMetadataSet, readMendConfig, syncGlobalPrimaryAgentModels, syncProject } from "../config/project"
import { mflowDoctor, mflowPlan, mflowStatus, worktreeAdopt, worktreeCreate, worktreeDoctor, worktreeOpen, worktreePlan, worktreeRemove, worktreeReset, worktreeStatus } from "../config/worktree"
import { activateTsm, deactivateTsm, removeTsm, setupTsm, tsmDoctor, tsmPlan, tsmStatus, type TsmState } from "../config/tsm"
import { activateMflow, deactivateMflow, mflowControlStatus, MFLOW_PUBLIC_RELAY, MFLOW_PUBLIC_RELAY_WARNING, removeMflowConfig, type MflowRelayMode } from "../config/mflow"
import { applyRuntimePack, deleteLocalRuntimePack, formatRuntimePackPlan, rollbackRuntimePack, runtimePackArtifactCandidates, runtimePackPlan } from "../runtime/pack"
import { budgetDoctor, budgetStatus } from "../runtime/budget"
import { promptSourcesStatus } from "../prompt/sources"
import { composePromptPolicy } from "../prompt/compose"
import { aiEnvStatus, aiStatus, providerAuthInventory, providerAuthStatus, providerLoginPlan, setupDoctor, setupPlan, setupReadiness } from "../runtime/readiness"
import { accumulateSessionTelemetry, buildRunPlan, executeRunPlan, parseRunArgs, readChatSession, redactedRunPlanOutput, transcriptPrompt, writeChatSession } from "../runtime/run"
import { providerRunAdapterInventory, providerSmoke } from "../runtime/provider-adapters"
import { providerLogin } from "../runtime/auth"
import { exportPlan } from "../runtime/export"
import { adapterStatus, checkRuntime, collectStatus, doctorLines, donorConfigPathsReport, ownedRuntimeStatus, toolchainStatus, upstreamInspect, upstreamStatus } from "../runtime/system"
import { adoptOwnedRuntime, ownedRuntimePlan } from "../runtime/adoption"
import { runBenchmark } from "../runtime/bench"
import { runtimeRegistryAdd, runtimeRegistryApply, runtimeRegistryList, runtimeRegistryPreview, runtimeRegistryPublishPlan, runtimeRegistryRemove, runtimeRegistrySearch, runtimeRegistryShow, runtimeRegistrySign, runtimeRegistrySmoke, runtimeRegistryStatus } from "../runtime/registry"
import { disableAllMendPackages, listMendPackages, removeMendPackage, setMendPackageEnabled } from "../runtime/packages"
import { appendMemoryEntry, deleteMemoryEntry, memoryStatus, readMemoryEntries, refreshMemoryIndex, updateMemoryEntry } from "../memory/store"
import { formatMemoryBlock, retrieveMemory } from "../memory/retrieve"
import { writeGlobalMemoryConfig, writeProjectMemoryConfig } from "../memory/config"
import { applyMemoryProposal, autoProposeMemoriesFromSession, importCodexMemories, listMemoryProposals, proposeMemoriesWithExtractor, proposeMemory, rejectMemoryProposal } from "../memory/proposals"
import { readPermissionsConfig, writePermissionsConfig, type PermissionMode } from "../config/permissions"

async function readJson(file: string) {
  return JSON.parse(await readFile(file, "utf8"))
}

function relative(root: string, file: string) {
  const value = path.relative(root, file)
  return value.startsWith("..") ? file : value
}

function optionValue(args: string[], name: string) {
  const index = args.indexOf(name)
  if (index === -1) return null
  const value = args[index + 1]
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${name}`)
  return value
}

function shellProjectRoot() {
  return path.resolve(process.env.MENDCODE_SHELL_CWD || process.cwd())
}

async function tui(args: string[]) {
  const root = shellProjectRoot()
  const sub = args[0] || "status"
  const loadedProfile = await loadMendTuiProfile(root)
  const profile = loadedProfile.profile
  const validation = validateMendTuiProfile(profile)
  if (sub === "status") {
    console.log(JSON.stringify({ ok: validation.ok, path: relative(root, loadedProfile.activePath), profile, runtimeProof: { status: "runtime-owned-profile-control-plane", readsProfileJson: true, touchesProtectedDonorHotPaths: false }, failures: validation.failures }, null, 2))
    if (!validation.ok) process.exitCode = 1
    return
  }
  if (sub === "schema") {
    console.log(JSON.stringify(await readJson(mendPaths().tuiSchema), null, 2))
    return
  }
  if (sub === "profile") {
    console.log(JSON.stringify({ path: relative(root, loadedProfile.activePath), profile, validation }, null, 2))
    if (!validation.ok) process.exitCode = 1
    return
  }
  if (sub === "apply") {
    const result = await applyTuiProposal(args[1] || "", root)
    console.log(JSON.stringify({ ok: true, proposalID: result.proposalID, backupPath: relative(root, result.backupPath), profilePath: relative(root, result.profilePath) }, null, 2))
    return
  }
  if (sub === "apply-preset") {
    const preset = args[1]
    if (preset !== "compact" && preset !== "comfortable" && preset !== "spacious" && preset !== "toggle-worktree") throw new Error("Usage: mend tui apply-preset <compact|comfortable|spacious|toggle-worktree>")
    const result = await applyTuiPreset(preset, root)
    console.log(JSON.stringify({ ok: true, preset, backupPath: relative(root, result.backupPath), profilePath: relative(root, result.profilePath), profile: result.profile.profile }, null, 2))
    return
  }
  if (sub === "rollback") {
    const result = await rollbackTuiPreset(root)
    console.log(JSON.stringify({ ok: true, restoredFrom: relative(root, result.restoredFrom), profilePath: relative(root, result.profilePath) }, null, 2))
    return
  }
  if (sub === "preview") {
    const stateIndex = args.indexOf("--state")
    const state = stateIndex === -1 ? "home" : args[stateIndex + 1] || "home"
    const { preview, jsonPath, textPath } = await writeTuiPreview({ root, state })
    console.log(preview.text)
    console.log(`\npreview: ${relative(root, jsonPath)}`)
    console.log(`text: ${relative(root, textPath)}`)
    return
  }
  if (sub === "propose") {
    const dryRun = args.includes("--dry-run")
    const preference = args.slice(1).filter((arg) => arg !== "--dry-run").join(" ").trim()
    if (!dryRun) throw new Error('TUI propose is gated: use `mend tui propose "<preference>" --dry-run`')
    const { proposal, proposalPath, proposalDir } = await writeTuiProposal(preference, root)
    console.log(JSON.stringify({ ...proposal, proposalPath: relative(root, proposalPath), previewDir: relative(root, proposalDir), profile: undefined }, null, 2))
    if (!proposal.validation.ok) process.exitCode = 1
    return
  }
  if (sub === "project") {
    const result = await writeTuiProjection({ root, check: args.includes("--check") })
    console.log(JSON.stringify(result, null, 2))
    if (result.check && result.check.exitCode !== 0) process.exitCode = result.check.exitCode || 1
    return
  }
  if (sub === "render") {
    const proof = await writeTuiRender(root)
    console.log(proof.renderedText)
    console.log(`\nproof: ${relative(root, path.join(root, ".mendcode", "tui", "renders", "latest.json"))}`)
    console.log(`text: ${relative(root, path.join(root, ".mendcode", "tui", "renders", "latest.txt"))}`)
    return
  }
  if (sub === "preview-plan") {
    console.log(JSON.stringify(await tuiPreviewPlan(root), null, 2))
    return
  }
  if (sub === "runtime-plan") {
    const plan = await tuiRuntimePlan(root)
    console.log(JSON.stringify(plan, null, 2))
    if (plan.failures.length) process.exitCode = 1
    return
  }
  if (sub === "probe") {
    const result = await tuiProbe(root)
    console.log(JSON.stringify(result, null, 2))
    if (result.exitCode !== 0) process.exitCode = result.exitCode || 1
    return
  }
  throw new Error("Usage: mend tui <status|schema|profile|apply|apply-preset|rollback|preview|propose|project|render|preview-plan|runtime-plan|probe>")
}

async function prompt(args: string[]) {
  const sub = args[0] || "mode"
  if (sub === "sources") {
    console.log(JSON.stringify(await promptSourcesStatus(), null, 2))
    return
  }
  if (sub === "build") {
    let mode = "focus"
    let focusID = "codex"
    let modelID: string | null = null
    let role: string | null = null
    let workflow: string | null = null
    let showFull = false
    for (let i = 1; i < args.length; i++) {
      if (args[i] === "--mode") mode = args[++i]!
      else if (args[i] === "--focus") focusID = args[++i]!
      else if (args[i] === "--model") modelID = args[++i]!
      else if (args[i] === "--role") role = args[++i]!
      else if (args[i] === "--workflow") workflow = args[++i]!
      else if (args[i] === "--show-full") showFull = true
      else throw new Error("Usage: mend-control-plane prompt build [--mode minimal|focus|full] [--focus <id>] [--model <modelID>] [--role <role>] [--workflow <workflow>] [--show-full]")
    }
    const policy = await composePromptPolicy({ mode, focusID, modelID, role, workflow })
    console.log(JSON.stringify({
      mode: policy.mode,
      focusID: policy.focusID,
      modelID,
      role,
      workflow,
      basePromptSource: policy.basePromptSource,
      usesMendCodeHarnessPrompt: policy.usesMendCodeHarnessPrompt,
      usesOpenCodeGenericProviderPrompt: policy.usesOpenCodeGenericProviderPrompt,
      fallbackReason: policy.fallbackReason,
      includeProjectInstructions: policy.includeProjectInstructions,
      includeSkillsByDefault: policy.includeSkillsByDefault,
      includeCustomInstructions: policy.includeCustomInstructions,
      includeMcpContext: policy.includeMcpContext,
      source: policy.source,
      sections: policy.sections.map((section) => ({
        id: section.id,
        label: section.label,
        source: section.source,
        bytes: section.bytes,
        preview: section.preview,
      })),
      basePromptBytes: policy.basePromptBytes,
      instructionsBytes: policy.instructionsBytes,
      instructionsPreview: policy.instructionsPreview,
      policyInstructionsBytes: policy.policyInstructionsBytes,
      policyInstructionsPreview: policy.policyInstructionsPreview,
      ...(showFull ? { instructions: policy.instructions } : {}),
      printsFullPrompt: showFull,
      note: "Use run/chat --prompt-mode to execute with this policy. This command does not call providers.",
    }, null, 2))
    return
  }
  if (sub === "mode") {
    const requested = args[1]
    console.log(JSON.stringify(requested ? await writePromptMode(requested) : await readPromptMode(), null, 2))
    return
  }
  if (sub === "cycle-mode") {
    console.log(JSON.stringify(await cyclePromptMode(), null, 2))
    return
  }
  throw new Error("Usage: mend prompt <sources|build|mode|cycle-mode>")
}

async function run(args: string[]) {
  const parsed = parseRunArgs(args, "run")
  if (!parsed.prompt) throw new Error("Usage: mend run [--json] [--dry-run] <prompt>")
  const plan = await buildRunPlan({ prompt: parsed.prompt, dryRun: parsed.dryRun, promptMode: parsed.promptMode, focusID: parsed.focusID })
  if (parsed.dryRun || plan.blockers.length) {
    console.log(JSON.stringify(redactedRunPlanOutput(plan), null, 2))
    if (!parsed.dryRun) process.exitCode = 1
    return
  }
  const { result, record } = await executeRunPlan({ plan, prompt: parsed.prompt })
  const output = {
    mode: "run",
    selected: plan.selected,
    ok: result.ok,
    status: result.status,
    outputText: result.outputText || null,
    response: result.ok ? { id: result.id, model: result.model, rawShape: result.rawShape } : { statusText: result.statusText, errorPreview: result.errorPreview },
    telemetry: result.telemetry || null,
    budgetGate: plan.budgetGate,
    promptPolicy: plan.promptPolicy,
    runRecord: { id: record.id, path: path.relative(mendPaths().root, mendPaths().runHistory), storedFullPrompt: false, storedFullOutput: false },
    wouldRunDonorRuntime: false,
    secretsPrinted: false,
  }
  if (parsed.json || !result.ok) console.log(JSON.stringify(output, null, 2))
  else process.stdout.write(`${result.outputText || ""}\n`)
  if (!result.ok) process.exitCode = 1
}

async function chat(args: string[]) {
  const parsed = parseRunArgs(args, "chat")
  if (!parsed.prompt) throw new Error("Usage: mend chat [--json] [--dry-run] [--session <id>] <message>")
  const session = await readChatSession(parsed.sessionID)
  const messages = [...(session.messages || []), { role: "user", content: parsed.prompt }]
  const transcript = transcriptPrompt(messages)
  const plan = {
    ...(await buildRunPlan({ prompt: transcript, dryRun: parsed.dryRun, promptMode: parsed.promptMode, focusID: parsed.focusID })),
    mode: parsed.dryRun ? "chat-dry-run" : "chat",
    session: {
      id: session.id,
      path: session.storage?.path || path.relative(mendPaths().root, path.join(mendPaths().runHistory, "..", "chat", `${session.id}.json`)),
      previousMessages: session.messages?.length || 0,
      nextMessages: messages.length,
      ignoredByGit: true,
      storesFullLocalTranscript: true,
    },
  }
  if (parsed.dryRun || plan.blockers.length) {
    console.log(JSON.stringify(redactedRunPlanOutput(plan), null, 2))
    if (!parsed.dryRun) process.exitCode = 1
    return
  }
  const { result, record } = await executeRunPlan({ plan, prompt: transcript, messages })
  session.messages = messages
  session.messages.push({ role: "assistant", content: result.outputText || "", ok: result.ok, runRecordID: record.id, at: new Date().toISOString() })
  session.updatedAt = new Date().toISOString()
  accumulateSessionTelemetry(session, result.telemetry)
  await writeChatSession(session)
  const memory = result.ok
    ? { skipped: false, queued: true, reason: "memory extraction queued", proposals: [], callsProviders: false, writesMemory: false }
    : { skipped: true, reason: "run failed", proposals: [], callsProviders: false, writesMemory: false }
  if (result.ok) {
    void autoProposeMemoriesFromSession(structuredClone(session)).catch(() => {})
  }
  const output = {
    mode: "chat",
    session: plan.session,
    selected: plan.selected,
    ok: result.ok,
    status: result.status,
    outputText: result.outputText || null,
    telemetry: result.telemetry || null,
    budgetGate: plan.budgetGate,
    promptPolicy: plan.promptPolicy,
    memory,
    sessionTelemetry: session.telemetry,
    runRecord: { id: record.id, path: path.relative(mendPaths().root, mendPaths().runHistory), storedFullPrompt: false, storedFullOutput: false },
    wouldRunDonorRuntime: false,
    secretsPrinted: false,
  }
  if (parsed.json || !result.ok) console.log(JSON.stringify(output, null, 2))
  else process.stdout.write(`${result.outputText || ""}\n`)
  if (!result.ok) process.exitCode = 1
}

async function models(args: string[]) {
  const root = mendPaths().root
  const paths = mendPaths(root)
  const sub = args[0] || "status"
  const resolved = await resolveModelRoles(root)
  if (sub === "status") {
    console.log(JSON.stringify({ enabled: resolved.enabled, focus: resolved.focus, generatedRuntimeModel: resolved.defaultModel, generatedRuntimeSmallModel: resolved.smallModel, configuredRoles: Object.fromEntries(Object.entries(resolved.roles).map(([name, role]: any) => [name, role.configured ? role.runtimeModel : null])), warnings: resolved.warnings }, null, 2))
    return
  }
  if (sub === "show") {
    console.log(JSON.stringify(resolved, null, 2))
    return
  }
  if (sub === "plan") {
    const projection = await modelRoleProjection(root)
    console.log(JSON.stringify(projection, null, 2))
    if (projection.failures.length) process.exitCode = 1
    return
  }
  if (sub === "presets") {
    console.log(JSON.stringify({ presets: modelPresets, secretsIncluded: false, pricingSource: "official OpenAI docs captured 2026-05-06" }, null, 2))
    return
  }
  if (sub === "set-default") {
    const providerID = args[1]
    const modelID = args[2]
    const dryRun = args.includes("--dry-run")
    const authMode = optionValue(args, "--auth-mode")
    const failures = validateProviderModelID(providerID, modelID)
    if (failures.length) throw new Error(`Invalid model mapping:\n${failures.map((x) => `- ${x}`).join("\n")}`)
    const config = await readModelsConfig(root)
    config.roles.default = { ...(config.roles.default || {}), providerID: providerID!, modelID: modelID!, ...(authMode ? { authMode } : {}), reason: "Explicit default model configured by mend models set-default." }
    if (args.includes("--enable")) config.enabled = true
    const refresh = !dryRun
      ? (await writeGlobalModelsConfig(config), await syncGlobalPrimaryAgentModels(root), await refreshGeneratedRuntimeModelConfig(root))
      : null
    console.log(JSON.stringify({ mode: dryRun ? "dry-run" : "write", path: relative(root, paths.modelsConfig), enabled: config.enabled === true, defaultModel: config.enabled === true ? `${providerID}/${modelID}` : null, authMode: authMode || "unknown-or-api-key", writesSecrets: false, writesConfig: !dryRun, refresh, note: "Runtime control-plane writes models.yaml and refreshes generated runtime model compatibility config on real writes." }, null, 2))
    return
  }
  if (sub === "use-preset") {
    const presetID = args[1] as keyof typeof modelPresets
    const preset = modelPresets[presetID]
    if (!preset) throw new Error(`Unknown preset: ${presetID || "missing"}\nAvailable: ${Object.keys(modelPresets).join(", ")}`)
    return models(["set-default", preset.providerID, preset.modelID, "--auth-mode", preset.authMode, ...(args.includes("--enable") ? ["--enable"] : []), ...(args.includes("--dry-run") ? ["--dry-run"] : [])])
  }
  throw new Error("Usage: mend-control-plane models <status|show|plan|presets|set-default|use-preset>")
}

async function mflow(args: string[]) {
  const root = shellProjectRoot()
  const sub = args[0] || "status"
  if (sub === "status") {
    console.log(JSON.stringify(await mflowControlStatus(root), null, 2))
    return
  }
  if (sub === "activate") {
    const relay = (optionValue(args, "--relay") || "public") as MflowRelayMode
    const signaling = optionValue(args, "--url") || optionValue(args, "--signaling") || undefined
    const room = optionValue(args, "--room") || undefined
    const secret = optionValue(args, "--secret") || undefined
    const hookPriorityRaw = optionValue(args, "--priority")
    const hookPriority = hookPriorityRaw === null ? undefined : Number(hookPriorityRaw)
    console.log(JSON.stringify(await activateMflow({
      relayMode: relay,
      signaling,
      room,
      secret,
      generateSecret: !secret,
      storeSecret: args.includes("--store-secret"),
      hookPriority,
      publicRelayNoticeAccepted: args.includes("--accept-public-relay-limits") || relay !== "public",
    }, root), null, 2))
    return
  }
  if (sub === "deactivate") {
    console.log(JSON.stringify(await deactivateMflow(root), null, 2))
    return
  }
  if (sub === "remove") {
    console.log(JSON.stringify(await removeMflowConfig(root), null, 2))
    return
  }
  if (sub === "setup") {
    const readline = await import("readline/promises")
    const { stdin: input, stdout: output } = await import("process")
    const rl = readline.createInterface({ input, output })
    try {
      console.log("mflow setup for MendCode")
      console.log("1) Public fair-use relay")
      console.log("2) Custom/self-hosted relay URL")
      const relayChoice = (await rl.question("Relay [1/2]: ")).trim() || "1"
      const relayMode: MflowRelayMode = relayChoice === "2" ? "custom" : "public"
      let signaling: string | undefined
      let publicRelayNoticeAccepted = true
      if (relayMode === "custom") {
        signaling = (await rl.question("Relay URL (ws:// or wss://): ")).trim()
      } else {
        console.log(MFLOW_PUBLIC_RELAY_WARNING)
        const accepted = (await rl.question("Use public relay with these limits? [y/N]: ")).trim().toLowerCase()
        publicRelayNoticeAccepted = accepted === "y" || accepted === "yes"
        signaling = MFLOW_PUBLIC_RELAY
      }
      const room = (await rl.question(`Room [${root.split("/").pop() || "mendcode"}/mflow]: `)).trim() || undefined
      const generate = ((await rl.question("Generate room secret? [Y/n]: ")).trim().toLowerCase() || "y") !== "n"
      const secret = generate ? undefined : (await rl.question("Room secret: ")).trim()
      const storeSecret = (await rl.question("Store secret in .mflow/config.toml? [y/N]: ")).trim().toLowerCase() === "y"
      console.log(JSON.stringify(await activateMflow({
        relayMode,
        signaling,
        room,
        secret,
        generateSecret: generate,
        storeSecret,
        publicRelayNoticeAccepted,
      }, root), null, 2))
    } finally {
      rl.close()
    }
    return
  }
  const result = sub === "plan" ? await mflowPlan(root) : sub === "doctor" ? await mflowDoctor(root) : sub === "legacy-status" ? await mflowStatus(root) : null
  if (!result) throw new Error("Usage: mend-control-plane mflow <status|setup|activate|deactivate|remove|plan|doctor>")
  console.log(JSON.stringify(result, null, 2))
  if ("ok" in result && result.ok === false) process.exitCode = 1
}

async function tsm(args: string[]) {
  const root = shellProjectRoot()
  const sub = args[0] || "status"
  const muxBackend = optionValue(args, "--mux") as TsmState["defaultMuxBackend"] | null
  const result = sub === "status"
    ? await tsmStatus(root)
    : sub === "plan" || sub === "install"
      ? await tsmPlan(root)
      : sub === "setup"
        ? await setupTsm(root)
        : sub === "activate"
          ? await activateTsm(root, { muxBackend: muxBackend || undefined })
          : sub === "deactivate"
            ? await deactivateTsm(root)
            : sub === "remove"
              ? await removeTsm(root)
              : sub === "doctor"
                ? await tsmDoctor(root)
                : null
  if (!result) throw new Error("Usage: mend-control-plane tsm <status|plan|setup|install|activate|deactivate|remove|doctor>")
  console.log(JSON.stringify(result, null, 2))
  if ("ok" in result && result.ok === false) process.exitCode = 1
}

async function worktree(args: string[]) {
  const root = shellProjectRoot()
  const sub = args[0] || "status"
  const rest = args.slice(1)
  const result = sub === "status"
    ? await worktreeStatus(root)
    : sub === "plan"
      ? await worktreePlan(rest, root)
      : sub === "create"
        ? await worktreeCreate(rest, root)
        : sub === "open"
          ? await worktreeOpen(rest, root)
          : sub === "adopt"
            ? await worktreeAdopt(rest, root)
            : sub === "remove"
              ? await worktreeRemove(rest, root)
              : sub === "reset"
                ? await worktreeReset(rest, root)
                : sub === "doctor"
                  ? await worktreeDoctor(root)
                  : null
  if (!result) throw new Error("Usage: mend-control-plane worktree <status|plan|create|open|adopt|remove|reset|doctor>")
  console.log(JSON.stringify(result, null, 2))
  if ("ok" in result && result.ok === false) process.exitCode = 1
}

async function runtimeConfig(args: string[]) {
  const sub = args[0] || "status"
  if (sub === "status" || sub === "preview") {
    const plan = await runtimePackPlan(sub, mendPaths().root)
    console.log(args.includes("--json") ? JSON.stringify(plan, null, 2) : formatRuntimePackPlan(plan))
    return
  }
  if (sub === "apply") {
    const plan = await applyRuntimePack(mendPaths().root)
    console.log(args.includes("--json") ? JSON.stringify(plan, null, 2) : formatRuntimePackPlan(plan))
    return
  }
  if (sub === "rollback") {
    const plan = await rollbackRuntimePack(mendPaths().root)
    console.log(args.includes("--json") ? JSON.stringify(plan, null, 2) : formatRuntimePackPlan(plan))
    return
  }
  throw new Error("Usage: mend-control-plane runtime-config <status|preview|apply|rollback> [--json]")
}

async function runtimeCommand(args: string[]) {
  const root = mendPaths().root
  const sub = args[0] || "configure"
  if (sub === "status") {
    console.log(JSON.stringify(ownedRuntimeStatus(root), null, 2))
    return
  }
  if (sub === "configure") return runtimeConfig(args.slice(1))
  if (sub === "plan") {
    console.log(JSON.stringify(ownedRuntimePlan(root), null, 2))
    return
  }
  if (sub === "adopt") {
    console.log(JSON.stringify(await adoptOwnedRuntime(args.slice(1), root), null, 2))
    return
  }
  if (sub === "registry") {
    const action = args[1] || "status"
    if (action === "status") console.log(JSON.stringify(await runtimeRegistryStatus(root), null, 2))
    else if (action === "list") console.log(JSON.stringify(await runtimeRegistryList(root), null, 2))
    else if (action === "add") console.log(JSON.stringify(await runtimeRegistryAdd(args.slice(2), root), null, 2))
    else if (action === "remove") console.log(JSON.stringify(await runtimeRegistryRemove(args[2], root), null, 2))
    else if (action === "preview") console.log(JSON.stringify(await runtimeRegistryPreview(args[2] || "local", root), null, 2))
    else if (action === "apply") console.log(JSON.stringify(await runtimeRegistryApply(args[2], root), null, 2))
    else if (action === "search") console.log(JSON.stringify(await runtimeRegistrySearch(args[2] || "", args[3] || "local", root), null, 2))
    else if (action === "show") console.log(JSON.stringify(await runtimeRegistryShow(args[2], args[3] || "local", root), null, 2))
    else if (action === "publish-plan") console.log(JSON.stringify(await runtimeRegistryPublishPlan(args[2] || "local", root), null, 2))
    else if (action === "sign") console.log(JSON.stringify(await runtimeRegistrySign(args[2] || "local", root), null, 2))
    else if (action === "smoke") console.log(JSON.stringify(await runtimeRegistrySmoke(args[2] || "local", args.includes("--execute"), root), null, 2))
    else throw new Error("Usage: mend-control-plane runtime registry <status|list|add|remove|preview|apply|search|show|publish-plan|sign|smoke>")
    return
  }
  throw new Error("Usage: mend-control-plane runtime <status|configure [status|preview|apply|rollback]|plan|adopt|registry>")
}

async function bench() {
  const result = await runBenchmark(mendPaths().root)
  console.log(`benchmark output: ${result.output}`)
  if (result.exitCode !== 0) process.exitCode = result.exitCode
}

async function budget(args: string[]) {
  const sub = args[0] || "status"
  const result = sub === "status" ? await budgetStatus() : sub === "doctor" ? await budgetDoctor() : null
  if (!result) throw new Error("Usage: mend-control-plane budget <status|doctor>")
  console.log(JSON.stringify(result, null, 2))
  if ("ok" in result && result.ok === false) process.exitCode = 1
}

async function providers(args: string[]) {
  const sub = args[0] || "status"
  if (sub === "auth" || sub === "status") {
    console.log(JSON.stringify(providerAuthInventory(), null, 2))
    return
  }
  if (sub === "adapters") {
    console.log(JSON.stringify(await providerRunAdapterInventory(), null, 2))
    return
  }
  if (sub === "smoke") {
    const summary = await providerSmoke(args.slice(1))
    console.log(JSON.stringify(summary, null, 2))
    if (summary.mode === "execute" && summary.executedCount > 0 && summary.okCount !== summary.executedCount) process.exitCode = 1
    return
  }
  throw new Error("Usage: mend-control-plane providers <status|auth|adapters|smoke>")
}

async function mcp(args: string[]) {
  const sub = args[0] || "status"
  if (sub === "status" || sub === "preview") {
    console.log(JSON.stringify(await mendMcpStatus(mendPaths().root), null, 2))
    return
  }
  if (sub === "add-local") {
    const name = args[1]
    const command = args.slice(2)
    if (!name || !command.length) throw new Error("Usage: mend-control-plane mcp add-local <name> <command> [args...]")
    console.log(JSON.stringify(await writeMendMcpServer(name, { type: "local", command }, mendPaths().root), null, 2))
    return
  }
  throw new Error("Usage: mend-control-plane mcp <status|preview|add-local>")
}

async function memory(args: string[]) {
  const sub = args[0] || "status"
  const root = shellProjectRoot()
  if (sub === "status") {
    console.log(JSON.stringify(await memoryStatus(root), null, 2))
    return
  }
  if (sub === "search") {
    const query = args.slice(1).filter((arg) => !arg.startsWith("--")).join(" ").trim()
    const result = await retrieveMemory({ root, query, cwd: root })
    console.log(JSON.stringify({
      query,
      enabled: result.enabled,
      use: result.use,
      callsProviders: false,
      summaries: result.summaries,
      entries: result.entries,
      lines: result.lines,
    }, null, 2))
    return
  }
  if (sub === "preview") {
    const query = args.slice(1).filter((arg, index, all) => {
      const prev = all[index - 1]
      return !arg.startsWith("--") && prev !== "--provider" && prev !== "--model"
    }).join(" ").trim()
    const providerID = optionValue(args, "--provider") || "openai"
    const modelID = optionValue(args, "--model") || "gpt-5.2"
    const result = await retrieveMemory({ root, query, cwd: root, providerID, modelID })
    const model = { id: modelID, providerID, api: { id: modelID } } as any
    console.log(JSON.stringify({
      query,
      providerID,
      modelID,
      enabled: result.enabled,
      use: result.use,
      callsProviders: false,
      entries: result.entries,
      promptBlock: formatMemoryBlock({ model, lines: result.lines }),
    }, null, 2))
    return
  }
  if (sub === "add") {
    const scope = optionValue(args, "--scope") === "global" ? "global" : "project"
    const tags = (optionValue(args, "--tags") || "").split(",").map((item) => item.trim()).filter(Boolean)
    const text = args.slice(1).filter((arg, index, all) => {
      const prev = all[index - 1]
      return !arg.startsWith("--") && prev !== "--scope" && prev !== "--tags"
    }).join(" ").trim()
    if (!text) throw new Error("Usage: mend memory add <text> [--scope global|project] [--tags a,b]")
    const entry = await appendMemoryEntry({ scope, text, tags, cwd: root, source: "manual-cli" }, root)
    console.log(JSON.stringify({ ok: true, entry, callsProviders: false, readsSecrets: false }, null, 2))
    return
  }
  if (sub === "edit") {
    const scope = optionValue(args, "--scope") === "global" ? "global" : "project"
    const id = args[1]
    const text = args.slice(2).filter((arg, index, all) => {
      const prev = all[index - 1]
      return !arg.startsWith("--") && prev !== "--scope"
    }).join(" ").trim()
    if (!id || !text) throw new Error("Usage: mend memory edit <entry-id> <text> [--scope global|project]")
    const entry = await updateMemoryEntry(scope, id, { text }, root)
    console.log(JSON.stringify({ ok: true, entry, callsProviders: false, readsSecrets: false }, null, 2))
    return
  }
  if (sub === "delete") {
    const scope = optionValue(args, "--scope") === "global" ? "global" : "project"
    const id = args[1]
    if (!id) throw new Error("Usage: mend memory delete <entry-id> [--scope global|project]")
    console.log(JSON.stringify({ ...(await deleteMemoryEntry(scope, id, root)), callsProviders: false, readsSecrets: false }, null, 2))
    return
  }
  if (sub === "propose") {
    const scope = optionValue(args, "--scope") === "global" ? "global" : "project"
    const tags = (optionValue(args, "--tags") || "").split(",").map((item) => item.trim()).filter(Boolean)
    const fromFile = optionValue(args, "--from-file")
    const maxProposals = optionValue(args, "--max-proposals")
    const text = args.slice(1).filter((arg, index, all) => {
      const prev = all[index - 1]
      return !arg.startsWith("--") && prev !== "--scope" && prev !== "--tags" && prev !== "--from-file" && prev !== "--max-proposals"
    }).join(" ").trim()
    if (fromFile) {
      const file = path.resolve(root, fromFile)
      const fileText = await readFile(file, "utf8")
      const result = await proposeMemoriesWithExtractor({ scope, text: fileText, tags, cwd: root, source: "model-file-extract", evidence: path.relative(root, file), maxProposals: maxProposals ? Number(maxProposals) : undefined }, root)
      console.log(JSON.stringify(result, null, 2))
      return
    }
    if (!text) throw new Error("Usage: mend memory propose <text> [--scope global|project] [--tags a,b] OR mend memory propose --from-file <path> [--max-proposals n]")
    const proposal = await proposeMemory({ scope, text, tags, cwd: root, source: "manual-cli-proposal" }, root)
    console.log(JSON.stringify({ ok: true, proposal, callsProviders: false, readsSecrets: false, writesMemory: false }, null, 2))
    return
  }
  if (sub === "list") {
    const scopeArg = optionValue(args, "--scope")
    if (scopeArg === "global" || scopeArg === "project") {
      const entries = await readMemoryEntries(scopeArg, root)
      console.log(JSON.stringify({ scope: scopeArg, entries, callsProviders: false, readsSecrets: false }, null, 2))
      return
    }
    const status = optionValue(args, "--status") as any
    const proposals = await listMemoryProposals(root, status || "pending")
    console.log(JSON.stringify({ status: status || "pending", proposals, callsProviders: false, readsSecrets: false }, null, 2))
    return
  }
  if (sub === "import-codex") {
    const result = await importCodexMemories({
      codexMemoryDir: optionValue(args, "--from") || undefined,
      apply: args.includes("--apply"),
      maxProposals: optionValue(args, "--max-proposals") ? Number(optionValue(args, "--max-proposals")) : undefined,
    }, root)
    console.log(JSON.stringify(result, null, 2))
    return
  }
  if (sub === "apply") {
    const result = await applyMemoryProposal(args[1] || "", root)
    console.log(JSON.stringify({ ok: true, proposal: result.proposal, entry: result.entry, callsProviders: false, readsSecrets: false }, null, 2))
    return
  }
  if (sub === "reject") {
    const proposal = await rejectMemoryProposal(args[1] || "", root)
    console.log(JSON.stringify({ ok: true, proposal, callsProviders: false, readsSecrets: false, writesMemory: false }, null, 2))
    return
  }
  if (sub === "index") {
    console.log(JSON.stringify(await refreshMemoryIndex(root), null, 2))
    return
  }
  if (sub === "config") {
    const updates: Record<string, unknown> = {}
    if (args.includes("--enable")) updates.enabled = true
    if (args.includes("--disable")) {
      updates.enabled = false
      updates.use = false
      updates.generate = false
    }
    if (args.includes("--use")) updates.use = true
    if (args.includes("--no-use")) updates.use = false
    if (args.includes("--input")) updates.use = true
    if (args.includes("--no-input")) updates.use = false
    if (args.includes("--generate")) updates.generate = true
    if (args.includes("--no-generate")) updates.generate = false
    if (args.includes("--output")) updates.generate = true
    if (args.includes("--no-output")) updates.generate = false
    const maxPromptTokens = optionValue(args, "--max-prompt-tokens")
    if (maxPromptTokens) updates.maxPromptTokens = Number(maxPromptTokens)
    const maxEntries = optionValue(args, "--max-entries")
    if (maxEntries) updates.maxEntries = Number(maxEntries)
    const projectMaxEntries = optionValue(args, "--project-max-entries")
    if (projectMaxEntries) updates.projectMaxEntries = Number(projectMaxEntries)
    const globalCompactionMaxEntries = optionValue(args, "--global-compaction-max-entries")
    if (globalCompactionMaxEntries) updates.globalCompactionMaxEntries = Number(globalCompactionMaxEntries)
    const result = args.includes("--project")
      ? await writeProjectMemoryConfig(updates, root)
      : await writeGlobalMemoryConfig(updates, root)
    console.log(JSON.stringify({ ...result, callsProviders: false, readsSecrets: false }, null, 2))
    return
  }
  throw new Error("Usage: mend-control-plane memory <status|search <query>|preview <query>|add <text>|edit <entry-id> <text>|delete <entry-id>|propose <text|--from-file path>|list [--status pending|applied|rejected|all]|apply <proposal-id>|reject <proposal-id>|import-codex [--from path] [--apply]|index|config [--enable|--disable|--input|--no-input|--output|--no-output|--use|--no-use|--generate|--no-generate|--max-prompt-tokens n|--max-entries n|--project-max-entries n|--global-compaction-max-entries n|--project]>")
}

async function auth(args: string[]) {
  const sub = args[0] || "status"
  if (sub === "status") {
    console.log(JSON.stringify(await providerAuthStatus(args[1] || null), null, 2))
    return
  }
  if (sub === "login-plan") {
    console.log(JSON.stringify(providerLoginPlan(args[1]!, optionValue(args, "--method")), null, 2))
    return
  }
  if (sub === "login") {
    const providerID = args[1]!
    const method = optionValue(args, "--method")
    console.log(JSON.stringify(await providerLogin(providerID, method, { execute: args.includes("--execute"), open: args.includes("--open") }), null, 2))
    return
  }
  throw new Error("Usage: mend-control-plane auth <status [providerID]|login-plan <providerID> [--method browser|headless|api-key]|login openai --method browser|headless --execute [--open]>")
}

async function setup(args: string[]) {
  const sub = args[0] || "status"
  const result = sub === "status" ? await setupReadiness() : sub === "plan" ? await setupPlan() : sub === "doctor" ? await setupDoctor() : null
  if (!result) throw new Error("Usage: mend-control-plane setup <status|plan|doctor>")
  console.log(JSON.stringify(result, null, 2))
  if ("ok" in result && result.ok === false) process.exitCode = 1
}

const selectablePackageArtifacts = ["commands", "agents", "modes", "skills", "plugins", "prompts", "mcp", "context", "extensions"] as const
const selectablePackageSettings = ["models", "focus", "budget", "memory", "permissions", "tuiProfile", "worktreePolicy"] as const

function packageOptionValue(args: string[], name: string) {
  const index = args.indexOf(name)
  if (index === -1) return undefined
  const value = args[index + 1]
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${name}`)
  return value
}

function packageOptionList(args: string[], name: string) {
  const values: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== name) continue
    const value = args[i + 1]
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${name}`)
    values.push(...value.split(",").map((item) => item.trim()).filter(Boolean))
    i++
  }
  return values
}

async function packageSelectionFromArgs(args: string[], root: string) {
  const includes = packageOptionList(args, "--include")
  const excludes = new Set(packageOptionList(args, "--exclude"))
  if (!includes.length && !excludes.size) return undefined
  const candidates = await runtimePackArtifactCandidates(root)
  const includeAll = includes.length === 0 || includes.includes("all")
  const wanted = new Set(includeAll ? [...selectablePackageArtifacts, ...selectablePackageSettings] : includes)
  const unknown = [...wanted, ...excludes].filter((item) => item !== "all" && !selectablePackageArtifacts.includes(item as any) && !selectablePackageSettings.includes(item as any))
  if (unknown.length) throw new Error(`Unknown package include/exclude target: ${unknown.join(", ")}`)

  const selection: Record<string, unknown> = {}
  for (const key of selectablePackageArtifacts) {
    if (!wanted.has(key) || excludes.has(key)) selection[key] = []
    else selection[key] = candidates[key]
  }
  for (const key of selectablePackageSettings) {
    if (!wanted.has(key) || excludes.has(key)) selection[key] = false
  }
  return selection
}

async function packages(args: string[]) {
  const root = mendPaths().root
  const sub = args[0] || "status"
  if (sub === "status" || sub === "list") {
    console.log(JSON.stringify(await listMendPackages(root), null, 2))
    return
  }
  if (sub === "create" || sub === "update") {
    const createArgs = args.slice(1)
    const selection = await packageSelectionFromArgs(createArgs, root)
    const metadata = {
      id: packageOptionValue(createArgs, "--id"),
      title: packageOptionValue(createArgs, "--title") || packageOptionValue(createArgs, "--name"),
      description: packageOptionValue(createArgs, "--description"),
      kind: packageOptionValue(createArgs, "--kind"),
      channel: packageOptionValue(createArgs, "--channel"),
      sourceType: packageOptionValue(createArgs, "--source-type"),
      sourceURL: packageOptionValue(createArgs, "--source-url"),
      compatMendcode: packageOptionValue(createArgs, "--compat-mendcode"),
      compatRuntimePack: packageOptionValue(createArgs, "--compat-runtime-pack"),
      version: packageOptionValue(createArgs, "--version"),
      ...(selection !== undefined ? { selection } : {}),
    }
    if (Object.values(metadata).some((value) => value !== undefined)) await packageMetadataSet(metadata, root)
    const plan = await applyRuntimePack(root)
    console.log(args.includes("--json") ? JSON.stringify(plan, null, 2) : formatRuntimePackPlan(plan))
    return
  }
  if (sub === "delete-local") {
    const result = await deleteLocalRuntimePack(root)
    await syncProject(root)
    console.log(JSON.stringify(result, null, 2))
    return
  }
  if (sub === "install" || sub === "use") {
    const sourceID = args[1]
    if (!sourceID) throw new Error("Usage: mend packages install <source-id>")
    const result = await runtimeRegistryApply(sourceID, root)
    console.log(JSON.stringify(result, null, 2))
    return
  }
  if (sub === "enable") {
    const result = await setMendPackageEnabled(args[1], true, root)
    await syncProject(root)
    console.log(JSON.stringify(result, null, 2))
    return
  }
  if (sub === "disable" || sub === "deselect") {
    const result = await setMendPackageEnabled(args[1], false, root)
    await syncProject(root)
    console.log(JSON.stringify(result, null, 2))
    return
  }
  if (sub === "disable-all" || sub === "deselect-all") {
    const result = await disableAllMendPackages(root)
    await syncProject(root)
    console.log(JSON.stringify(result, null, 2))
    return
  }
  if (sub === "remove" || sub === "delete") {
    const result = await removeMendPackage(args[1], root)
    await syncProject(root)
    console.log(JSON.stringify(result, null, 2))
    return
  }
  if (sub === "search") {
    console.log(JSON.stringify(await runtimeRegistrySearch(args[1] || "", args[2] || "official", root), null, 2))
    return
  }
  if (sub === "show") {
    console.log(JSON.stringify(await runtimeRegistryShow(args[1], args[2] || "official", root), null, 2))
    return
  }
  if (sub === "sources") {
    console.log(JSON.stringify(await runtimeRegistryList(root), null, 2))
    return
  }
  if (sub === "add-source") {
    console.log(JSON.stringify(await runtimeRegistryAdd(args.slice(1), root), null, 2))
    return
  }
  if (sub === "remove-source") {
    console.log(JSON.stringify(await runtimeRegistryRemove(args[1], root), null, 2))
    return
  }
  throw new Error("Usage: mend-control-plane packages <status|list|create [--id id] [--title name] [--description text] [--include all|skills,modes,...] [--exclude models,budget,...] [--version x.y.z]|update ...|delete-local|install <source-id>|enable <id>|disable <id>|disable-all|remove <id>|search [query] [source-id]|show <pack-id> [source-id]|sources|add-source ...|remove-source <source-id>>")
}

function parsePermissionMode(value: string | null): PermissionMode {
  if (value === "approval" || value === "smart" || value === "full_access") return value
  throw new Error("Permission mode must be one of: approval, smart, full_access")
}

async function permissions(args: string[]) {
  const sub = args[0] || "status"
  if (sub === "status") {
    console.log(JSON.stringify(await readPermissionsConfig(), null, 2))
    return
  }
  if (sub === "set-default") {
    const mode = parsePermissionMode(args[1] || null)
    console.log(JSON.stringify(await writePermissionsConfig({ mode }), null, 2))
    return
  }
  if (sub === "set-reviewer-role") {
    const reviewerRole = args[1]
    if (!reviewerRole) throw new Error("Usage: mend-control-plane permissions set-reviewer-role <role>")
    console.log(JSON.stringify(await writePermissionsConfig({ reviewerRole }), null, 2))
    return
  }
  throw new Error("Usage: mend-control-plane permissions <status|set-default approval|smart|full_access|set-reviewer-role <role>>")
}

async function ai(args: string[]) {
  const sub = args[0] || "status"
  if (sub === "env" && (args[1] || "status") === "status") {
    console.log(JSON.stringify(await aiEnvStatus(), null, 2))
    return
  }
  if (sub === "status") {
    console.log(JSON.stringify(await aiStatus(), null, 2))
    return
  }
  throw new Error("Usage: mend-control-plane ai <status|env status>")
}

async function exportCommand(args: string[]) {
  const sub = args[0] || "plan"
  if (sub !== "plan") throw new Error("Usage: mend-control-plane export plan")
  console.log(JSON.stringify(exportPlan(), null, 2))
}

async function system(args: string[]) {
  const root = mendPaths().root
  const sub = args[0] || "status"
  if (sub === "status") {
    console.log(JSON.stringify(collectStatus(root), null, 2))
    return
  }
  if (sub === "doctor") {
    const result = await doctorLines(root)
    for (const line of result.lines) console.log(line)
    if (result.failures.length) {
      for (const failure of result.failures) console.error(`fail\tdiagnostic\t${failure}`)
      process.exitCode = 1
    }
    return
  }
  if (sub === "check") {
    const failures = await checkRuntime(root)
    if (failures.length) {
      console.error(failures.map((x) => `FAIL: ${x}`).join("\n"))
      process.exitCode = 1
      return
    }
    console.log("ok: MendCode owned-runtime boundary is valid, donor identity guard is active, and donor reference paths are untouched")
    return
  }
  if (sub === "toolchain") {
    const status = toolchainStatus(root)
    console.log(JSON.stringify(status, null, 2))
    if (status.failures.length) process.exitCode = 1
    return
  }
  if (sub === "config-paths") {
    console.log(JSON.stringify(donorConfigPathsReport(root), null, 2))
    return
  }
  if (sub === "adapter-status") {
    console.log(JSON.stringify(adapterStatus(root), null, 2))
    return
  }
  if (sub === "upstream-status") {
    const status = await upstreamStatus(root)
    console.log(JSON.stringify(status, null, 2))
    if (status.failures.length) process.exitCode = 1
    return
  }
  if (sub === "upstream-inspect") {
    console.log(JSON.stringify(await upstreamInspect(args[1], root), null, 2))
    return
  }
  throw new Error("Usage: mend-control-plane system <status|doctor|check|toolchain|config-paths|adapter-status|upstream-status|upstream-inspect>")
}

async function project(args: string[]) {
  const root = mendPaths().root
  const sub = args[0] || "sync"
  if (sub === "init") {
    const result = await initProject(root)
    console.log(`initialized ${result.initialized}`)
    return
  }
  if (sub === "sync") {
    const result = await syncProject(root)
    console.log(`generated ${result.generatedConfig} for focus=${result.focus} model=${result.model}`)
    return
  }
  if (sub === "config-show") {
    console.log(JSON.stringify(readMendConfig(root), null, 2))
    return
  }
  if (sub === "context-status") {
    console.log(JSON.stringify(contextStatus(root), null, 2))
    return
  }
  if (sub === "context-refresh") {
    const result = await contextRefresh(root)
    console.log(`refreshed ${result.summary} (${result.present}/${result.total} inputs)`)
    return
  }
  if (sub === "context-show") {
    console.log(await contextShow(root))
    return
  }
  if (sub === "focus-status") {
    console.log(JSON.stringify(focusStatus(root), null, 2))
    return
  }
  if (sub === "focus-list") {
    for (const profile of focusList()) console.log(`${profile.id}\t${profile.publicName}`)
    return
  }
  if (sub === "focus-show") {
    console.log(JSON.stringify(focusShow(args[1], root), null, 2))
    return
  }
  if (sub === "focus-use") {
    const result = await focusUse(args[1], root)
    console.log(`active focus: ${result.active}`)
    return
  }
  if (sub === "upstream-baseline") {
    const result = await baselineUpstream(args[1], root)
    console.log(`recorded observed upstream baseline: ${result.target}`)
    return
  }
  if (sub === "package-show") {
    console.log(JSON.stringify(packageMetadata(root), null, 2))
    return
  }
  if (sub === "package-set") {
    const value = (name: string) => optionValue(args, name)
    const result = await packageMetadataSet({
      id: value("--id"),
      title: value("--title"),
      description: value("--description"),
      version: value("--version"),
      kind: value("--kind"),
      channel: value("--channel"),
      sourceType: value("--source-type"),
      sourceURL: value("--source-url"),
      compatMendcode: value("--compat-mendcode"),
      compatRuntimePack: value("--compat-runtime-pack"),
    }, root)
    console.log(JSON.stringify(result, null, 2))
    return
  }
  throw new Error("Usage: mend-control-plane project <init|sync|config-show|context-status|context-refresh|context-show|focus-status|focus-list|focus-show|focus-use|upstream-baseline|package-show|package-set>")
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2)
  if (cmd === "status") {
    console.log(await mendStatusSummary())
    return
  }
  if (cmd === "runtime-config") return runtimeConfig(args)
  if (cmd === "runtime") return runtimeCommand(args)
  if (cmd === "bench") return bench()
  if (cmd === "tui") return tui(args)
  if (cmd === "prompt") return prompt(args)
  if (cmd === "run") return run(args)
  if (cmd === "chat") return chat(args)
  if (cmd === "models") return models(args)
  if (cmd === "budget") return budget(args)
  if (cmd === "providers") return providers(args)
  if (cmd === "mcp") return mcp(args)
  if (cmd === "memory") return memory(args)
  if (cmd === "permissions") return permissions(args)
  if (cmd === "auth") return auth(args)
  if (cmd === "setup") return setup(args)
  if (cmd === "packages") return packages(args)
  if (cmd === "ai") return ai(args)
  if (cmd === "export") return exportCommand(args)
  if (cmd === "system") return system(args)
  if (cmd === "project") return project(args)
  if (cmd === "mflow") return mflow(args)
  if (cmd === "tsm") return tsm(args)
  if (cmd === "worktree") return worktree(args)
  if (cmd === "mflow-status") {
    console.log(await integrationStatus("mflow"))
    return
  }
  if (cmd === "tsm-status") {
    console.log(await integrationStatus("tsm"))
    return
  }
  throw new Error("Usage: mend-control-plane <status|runtime|runtime-config|bench|tui|prompt|models|budget|providers|mcp|memory|permissions|auth|setup|packages|ai|export|system|project|worktree|mflow|tsm|mflow-status|tsm-status>")
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
