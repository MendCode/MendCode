import { TextAttributes } from "@opentui/core"
import { useTheme } from "@tui/context/theme"
import { useDialog } from "./dialog"
import { useKeyboard } from "@opentui/solid"
import { useKeybind } from "@tui/context/keybind"
import { useMendTuiProfile } from "@tui/context/mend"
import path from "path"
import { mendTuiCapabilityVersion, visibleCustomizationCapabilities } from "@/mend/tui/capabilities"
import { listActiveCustomizations } from "@/mend/tui/customization-state"

export function DialogHelp() {
  const dialog = useDialog()
  const { theme } = useTheme()
  const keybind = useKeybind()
  const mend = useMendTuiProfile()
  const capabilities = visibleCustomizationCapabilities()
  const active = listActiveCustomizations()

  useKeyboard((evt) => {
    if (evt.name === "return" || evt.name === "escape") {
      evt.preventDefault()
      evt.stopPropagation()
      dialog.clear()
    }
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          Help
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc/enter
        </text>
      </box>
      <box paddingBottom={1}>
        <text fg={theme.textMuted}>
          Press {keybind.print("command_list")} to see all available actions and commands in any context.
        </text>
      </box>
      <box flexDirection="column" paddingBottom={1}>
        <text fg={theme.textMuted}>Product: {mend.profile.identity.productName}</text>
        <text fg={theme.textMuted}>Active profile: {path.relative(process.cwd(), mend.activePath)}</text>
        <text fg={theme.textMuted}>Default profile: {path.relative(process.cwd(), mend.defaultPath)}</text>
        <text fg={theme.textMuted}>Customization contract: v{mendTuiCapabilityVersion()} · {capabilities.length} visible · {active.length} active</text>
        <text fg={theme.textMuted}>Inspect them from Ctrl+P → Customization capabilities.</text>
      </box>
      <box flexDirection="row" justifyContent="flex-end" paddingBottom={1}>
        <box paddingLeft={3} paddingRight={3} backgroundColor={theme.primary} onMouseUp={() => dialog.clear()}>
          <text fg={theme.selectedListItemText}>ok</text>
        </box>
      </box>
    </box>
  )
}
