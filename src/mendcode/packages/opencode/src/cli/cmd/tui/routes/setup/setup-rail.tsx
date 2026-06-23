import { For, Show } from "solid-js"
import { setupSteps, type SetupState } from "@/mend/setup/state"
import type { SetupStepID } from "@tui/context/route"
import { useTheme } from "@tui/context/theme"

const labels: Record<SetupStepID, string> = {
  provider: "Connect Provider",
  models: "Models",
  budget: "Budget",
  package: "Package",
  prompt: "Prompt",
  tui: "TUI Profile",
  memory: "Memory",
  permissions: "Permissions",
}

export type SetupRailStepStatus = "complete" | "optional" | "pending" | "auth blocked"

export function setupRailStepStatus(
  step: SetupStepID,
  state?: SetupState,
  summary?: { authReady?: boolean; authBlocked?: boolean },
): SetupRailStepStatus {
  if (step === "provider" && summary?.authBlocked) return "auth blocked"
  if (state?.completedSteps.includes(step)) return "complete"
  if (step === "package" || step === "tui" || step === "memory" || step === "permissions") return "optional"
  return "pending"
}

export function summaryLabel(label: string, value: string | undefined) {
  const text = `${label} ${value || "unset"}`
  return text.length > 22 ? `${text.slice(0, 21)}...` : text
}

function statusColor(status: SetupRailStepStatus, theme: ReturnType<typeof useTheme>["theme"]) {
  if (status === "complete") return theme.success
  if (status === "auth blocked") return theme.warning
  return theme.textMuted
}

export function SetupRail(props: {
  active: SetupStepID
  state?: SetupState
  complete: boolean
  minimal?: boolean
  narrow: boolean
  summary: {
    model?: string
    prompt?: string
    budget?: string
    packageTitle?: string
    authReady?: boolean
    authBlocked?: boolean
    memory?: string
    permissions?: string
  }
  onSelect: (step: SetupStepID) => void
}) {
  const { theme } = useTheme()
  return (
    <box width={props.narrow ? "100%" : 30} flexShrink={0} borderColor={theme.border} borderStyle="single" paddingLeft={1} paddingRight={1} paddingTop={1} paddingBottom={1}>
      <For each={setupSteps}>
        {(step, index) => {
          const status = () => setupRailStepStatus(step, props.state, props.summary)
          return (
            <box flexDirection="row" justifyContent="space-between" onMouseDown={() => props.onSelect(step)}>
              <text fg={props.active === step ? theme.primary : theme.text}>
                {index() + 1}. {labels[step]}
              </text>
              <text fg={statusColor(status(), theme)}>{status()}</text>
            </box>
          )
        }}
      </For>
      <box height={1} />
      <text fg={props.complete ? theme.success : theme.textMuted}>
        {props.complete ? "Ready to finish" : props.minimal ? "Minimal mode active" : "Incomplete setup visible"}
      </text>
      <Show when={!props.narrow}>
        <box flexGrow={1} />
        <box flexDirection="column">
          <text fg={theme.primary}>Live Summary</text>
          <text fg={theme.textMuted}>{summaryLabel("Model", props.summary.model)}</text>
          <text fg={theme.textMuted}>{summaryLabel("Prompt", props.summary.prompt || "focus")}</text>
          <text fg={theme.textMuted}>{summaryLabel("Budget", props.summary.budget || "unknown")}</text>
          <text fg={theme.textMuted}>{summaryLabel("Package", props.summary.packageTitle || "default")}</text>
          <text fg={theme.textMuted}>{summaryLabel("Memory", props.summary.memory || "off")}</text>
          <text fg={theme.textMuted}>{summaryLabel("Perms", props.summary.permissions || "approval")}</text>
          <text fg={theme.textMuted}>Auth {props.summary.authReady ? "ready" : "incomplete"}</text>
        </box>
      </Show>
    </box>
  )
}
