import { createResource, createSignal } from "solid-js"
import { useKeyboard } from "@opentui/solid"
import { useDialog } from "@tui/ui/dialog"
import { DialogSelect } from "@tui/ui/dialog-select"
import { DialogConfirm } from "@tui/ui/dialog-confirm"
import { DialogPrompt } from "@tui/ui/dialog-prompt"
import { useToast } from "@tui/ui/toast"
import { useTheme } from "@tui/context/theme"
import { SessionID, MessageID } from "@/session/schema"
import { readEvolutionPolicy, writeEvolutionConsent, type EvolutionConfig } from "@/mend/evolution/config"
import { listEvolutionEvidence, recordEvolutionEvidence } from "@/mend/evolution/evidence"
import { readEvolutionCandidates, type EvolutionCandidate } from "@/mend/evolution/candidates"
import { promoteEvolutionCandidate, rejectEvolutionCandidate, rollbackEvolutionCandidate } from "@/mend/evolution/promotion"
import { readEvolutionRunStatus, runEvolution } from "@/mend/evolution/runner"
import { resolveModelRoles } from "@/mend/config/models"
import { readMemoryConfig } from "@/mend/memory/config"
import { registerMemoryWorkspace } from "@/mend/memory/workspaces"
import { listMemoryProposals, rollbackEvolutionMemoryProposal } from "@/mend/memory/proposals"

type Props = { root: string; onChange: () => void; onModel: (role: string) => void; onMemory: () => void }

export function EvolutionDialog(props: Props) {
  const dialog = useDialog()
  const toast = useToast()
  const [state] = createResource(async () => ({
    policy: await readEvolutionPolicy(props.root),
    run: await readEvolutionRunStatus(props.root),
    roles: await resolveModelRoles(props.root),
    memory: await readMemoryConfig(props.root),
    evidence: await listEvolutionEvidence(props.root),
    candidates: await readEvolutionCandidates(props.root),
    memories: (await listMemoryProposals(props.root, "applied")).filter((proposal) => proposal.source === "evolution" && proposal.resolution !== "archived" && proposal.appliedEntryRevision),
  }))
  const reopen = () => dialog.replace(() => <EvolutionDialog {...props} />)
  const modelSummary = (roleName: string | null | undefined) => {
    const role = roleName ? state()?.roles.roles[roleName] : undefined
    return role?.configured ? `${role.providerID}/${role.modelID} · authentication checked at run admission` : "Not configured; runs are blocked without a selected role"
  }
  const perform = async (action: () => Promise<unknown>) => {
    try {
      await action()
      props.onChange()
      reopen()
    } catch {
      toast.show({ variant: "error", message: "Evolution blocked. Check consent, model readiness, evidence and any changes since review.", duration: 6000 })
      reopen()
    }
  }
  const save = (patch: Partial<EvolutionConfig>) => perform(async () => {
    const current = await readEvolutionPolicy(props.root)
    await writeEvolutionConsent(props.root, { ...current.config, ...patch })
  })
  const modes = () => dialog.replace(() => <DialogSelect
    title="Learning mode: project consent"
    options={[
      { title: "Off", value: "off", description: "Stop new learning and cancel Evolution runs. Keep saved memory and approved skills." },
      { title: "Observe", value: "observe", description: "Only bounded local metadata. No text retention, model calls or proposals." },
      { title: "Suggest", value: "suggest", description: "Review-only proposals. Processing requires separate consent; execution follows your schedule." },
      { title: "Auto-safe (limited)", value: "auto-safe", description: "Auto-add only exact user corrections: Project language: TypeScript/JavaScript/Python/Rust/Go. Empty project memory required; everything else needs review." },
    ].map((item) => ({ ...item, onSelect: async () => {
      const confirmed = await DialogConfirm.show(dialog, "Adopt Evolution?", "This replaces legacy automatic learning for this project. Saved memory use is unchanged. No service or model call starts here.")
      if (confirmed) await save({ mode: item.value as EvolutionConfig["mode"] })
      else reopen()
    } }))}
  />)
  const review = (page = 0) => {
    const entries = state()?.candidates ?? []
    dialog.replace(() => <DialogSelect title={`Capability proposals: page ${page + 1}`} options={[
      ...entries.slice(page * 10, page * 10 + 10).map((candidate) => ({
        title: candidate.name, value: candidate.id, description: `${candidate.kind} · ${candidate.status}`,
        onSelect: () => dialog.replace(() => <EvolutionCandidateReview root={props.root} candidate={candidate} onDone={reopen} onChange={props.onChange} />),
      })),
      ...(page > 0 ? [{ title: "Previous page", value: "previous", onSelect: () => review(page - 1) }] : []),
      ...((page + 1) * 10 < entries.length ? [{ title: "Next page", value: "next", onSelect: () => review(page + 1) }] : []),
      { title: entries.length ? "Back" : "No capability proposals. Back", value: "back", onSelect: reopen },
    ]} />)
  }
  const revertMemories = (page = 0) => {
    const entries = state()?.memories ?? []
    dialog.replace(() => <DialogSelect title={`Revert Evolution memory: page ${page + 1}`} options={[
      ...entries.slice(page * 10, page * 10 + 10).map((proposal) => ({
        title: proposal.text.slice(0, 80), value: proposal.id, description: "Archive only if unchanged since promotion. Available even with Evolution Off.",
        onSelect: async () => {
          const confirmed = await DialogConfirm.show(dialog, "Revert this memory?", `${proposal.text}\n\nThe original is archived, not deleted. Its graph projection becomes inactive. Later edits block this action.`)
          if (!confirmed) return reopen()
          await perform(() => rollbackEvolutionMemoryProposal(proposal.id, proposal.appliedEntryRevision!, props.root))
        },
      })),
      ...(page > 0 ? [{ title: "Previous page", value: "previous", onSelect: () => revertMemories(page - 1) }] : []),
      ...((page + 1) * 10 < entries.length ? [{ title: "Next page", value: "next", onSelect: () => revertMemories(page + 1) }] : []),
      { title: entries.length ? "Back" : "No reversible Evolution memories. Back", value: "back", onSelect: reopen },
    ]} />)
  }
  return <DialogSelect title="Memory & Evolution" options={state() ? [
    {
      title: `Mode: ${state()!.policy.adopted ? state()!.policy.config.mode : "Legacy memory learning"}`,
      value: "mode", description: state()!.policy.reason ?? "Project-only consent. Stored memory remains independent.", onSelect: modes,
    },
    {
      title: `Provider processing: ${state()!.policy.config.remoteProcessing ? "allowed" : "blocked"}`,
      value: "processing", description: "Local storage does not mean local inference. Authorized evidence may be sent to the selected provider.",
      onSelect: async () => {
        if (state()!.policy.config.remoteProcessing) return save({ remoteProcessing: false })
        const confirmed = await DialogConfirm.show(dialog, "Allow model processing?", "Authorized manual or scheduled Evolution runs may send the retained evidence to the configured model provider and consume quota or paid usage. No transcript or tool execution is included. Existing Setup budget controls still apply.")
        if (confirmed) await save({ remoteProcessing: true })
        else reopen()
      },
    },
    { title: `Last run: ${state()!.run.status}`, value: "refresh", description: "Last recorded state, not a live heartbeat. Select to refresh; no polling or provider call.", onSelect: reopen },
    { title: "Choose memory extractor", value: "extractor", description: modelSummary(state()!.memory.extractorRole), onSelect: () => props.onModel(state()!.memory.extractorRole || "memoryExtractor") },
    { title: "Choose capability distiller", value: "distiller", description: modelSummary(state()!.policy.config.distillerRole), onSelect: async () => {
      const current = await readEvolutionPolicy(props.root)
      await writeEvolutionConsent(props.root, { ...current.config, distillerRole: "evolutionDistiller" })
      props.onModel("evolutionDistiller")
    } },
    ...(["skills", "workflows"] as const).map((key) => ({
      title: `${key === "skills" ? "Skill" : "Workflow"} proposals: ${state()!.policy.config.outputs[key] ? "on" : "off"}`,
      value: key, description: "Draft only; explicit review and approval required. Never automatically executed.",
      onSelect: () => save({ outputs: { ...state()!.policy.config.outputs, [key]: !state()!.policy.config.outputs[key] } }),
    })),
    { title: `Record correction (${state()!.evidence.length} retained)`, value: "correction", description: "Or begin a chat message with Correction: or Corrección:. No assistant output is treated as your correction.", onSelect: async () => {
      const text = await DialogPrompt.show(dialog, "Project correction", { placeholder: "A durable project fact or correction" })
      if (!text) return reopen()
      await perform(async () => {
        const result = await recordEvolutionEvidence(props.root, { source: "correction", sessionID: SessionID.descending(), turnID: MessageID.ascending(), outcome: "observed", text })
        if (!result.recorded) throw new Error(result.reason)
      })
    } },
    ...(["toolResults", "testResults"] as const).map((key) => ({
      title: `${key === "toolResults" ? "Tool" : "Test"} evidence: ${state()!.policy.config.sources[key] ? "on" : "off"}`,
      value: key, description: "Host completion metadata only. Never stdout; Observe stores no text.",
      onSelect: () => save({ sources: { ...state()!.policy.config.sources, [key]: !state()!.policy.config.sources[key] } }),
    })),
    { title: `Execution: ${state()!.policy.config.execution}`, value: "schedule", description: "Daily uses the existing Dream service; enabling this does not start a service. Missed windows need a manual run.", onSelect: async () => {
      if (state()!.policy.config.execution === "daily") return save({ execution: "manual", dailyAt: null, timezone: null })
      const dailyAt = await DialogPrompt.show(dialog, "Daily time (HH:mm)", { placeholder: "10:00" })
      if (!dailyAt) return reopen()
      const timezone = await DialogPrompt.show(dialog, "Timezone (IANA or UTC)", { placeholder: "UTC" })
      if (!timezone) return reopen()
      const confirmed = await DialogConfirm.show(dialog, "Enable daily processing?", `The existing Dream service may process retained evidence at ${dailyAt} (${timezone}) and consume provider quota. At most one attempt per day; no automatic retry or late catch-up.`)
      if (!confirmed) return reopen()
      await perform(async () => {
        const current = await readEvolutionPolicy(props.root)
        await writeEvolutionConsent(props.root, { ...current.config, execution: "daily", dailyAt, timezone })
        await registerMemoryWorkspace({ root: props.root })
      })
    } },
    { title: "Run once", value: "run", description: "One run per project, at most five candidates, 60-second timeout, no tools.", onSelect: () => perform(async () => {
      toast.show({ variant: "info", message: "Evolution running. Off cancels this run.", duration: 4000 })
      const result = await runEvolution(props.root)
      toast.show({ variant: "success", message: result.status === "empty" ? "No current evidence to process." : "Evolution proposals are ready for review.", duration: 4000 })
    }) },
    { title: "Stop current run", value: "stop", description: "Invalidates in-flight work without deleting saved data.", onSelect: () => save({}) },
    { title: "Review memory proposals", value: "memories", onSelect: props.onMemory },
    { title: `Revert Evolution memories (${state()!.memories.length})`, value: "revert-memories", onSelect: () => revertMemories() },
    { title: `Review capabilities (${state()!.candidates.length})`, value: "capabilities", onSelect: () => review() },
  ] : [{ title: state.error ? "Unable to read Evolution state" : "Loading local Evolution state", value: "loading" }]} />
}

function EvolutionCandidateReview(props: { root: string; candidate: EvolutionCandidate; onDone: () => void; onChange: () => void }) {
  const { theme } = useTheme()
  const toast = useToast()
  const [busy, setBusy] = createSignal(false)
  const act = async (action: "approve" | "reject" | "rollback") => {
    if (busy()) return
    setBusy(true)
    try {
      const handler = action === "approve" ? promoteEvolutionCandidate : action === "reject" ? rejectEvolutionCandidate : rollbackEvolutionCandidate
      await handler(props.root, props.candidate.id, props.candidate.hash)
      props.onChange()
      props.onDone()
    } catch {
      toast.show({ variant: "error", message: "Candidate changed or policy blocked this action. Nothing will be overwritten without a fresh review.", duration: 5000 })
    } finally { setBusy(false) }
  }
  useKeyboard((event) => {
    if (busy()) return
    if (event.name === "a" && props.candidate.status === "pending") void act("approve")
    if (event.name === "r" && props.candidate.status === "pending") void act("reject")
    if (event.name === "u" && ["active", "blocked"].includes(props.candidate.status)) void act("rollback")
  })
  return <box padding={2} gap={1}>
    <text fg={theme.primary}>{props.candidate.name} · {props.candidate.kind} · {props.candidate.status}</text>
    <text>{props.candidate.description}</text>
    <text fg={theme.textMuted}>New project artifact. Schema validation is not proof of usefulness. Approval never starts a workflow.</text>
    <text fg={theme.textMuted}>Evidence: {props.candidate.evidenceIDs.join(", ")}</text>
    <scrollbox height={16}><text>{props.candidate.content}</text></scrollbox>
    <text fg={theme.textMuted}>{busy() ? "Applying reviewed action…" : props.candidate.status === "pending" ? "a approve · r reject · esc close" : "u revert if unchanged · esc close"}</text>
  </box>
}
