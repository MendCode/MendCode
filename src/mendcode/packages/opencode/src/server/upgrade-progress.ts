import { GlobalBus } from "@/bus/global"
import { TuiEvent } from "@/cli/cmd/tui/event"
import { updateLabel, type DownloadProgress, type UpdatePhase } from "@/installation/progress"

export function reportUpgradePhase(version: string, phase: UpdatePhase, progress?: DownloadProgress) {
  const label = updateLabel(phase, progress)
  GlobalBus.emit("event", {
    directory: "global",
    payload: {
      type: TuiEvent.ToastShow.type,
      properties: { title: `Update v${version}`, message: `${label}…`, variant: "info", duration: 930_000 },
    },
  })
}

export function reportUpgradeOutcome(version: string, error?: string) {
  GlobalBus.emit("event", {
    directory: "global",
    payload: {
      type: TuiEvent.ToastShow.type,
      properties: {
        title: error ? "Update Failed" : "Restart Required",
        message: error ?? `Installer for v${version} finished. Restart to finish checking the update.`,
        variant: error ? "error" : "info",
        duration: 10_000,
      },
    },
  })
}
