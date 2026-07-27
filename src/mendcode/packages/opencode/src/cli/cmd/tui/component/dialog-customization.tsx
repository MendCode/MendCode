import { Keybind } from "@/util/keybind"
import {
  DEFAULT_MEND_TUI_CUSTOMIZATION,
  readMendTuiCustomization,
  resetMendTuiCustomization,
  writeMendTuiCustomization,
  type MendTuiCustomizationBooleanKey,
} from "@/mend/tui/customization"
import { useKV } from "@tui/context/kv"
import { useTheme } from "@tui/context/theme"
import { useToast } from "@tui/ui/toast"
import { useDialog } from "@tui/ui/dialog"
import { DialogSelect, type DialogSelectOption } from "@tui/ui/dialog-select"
import { createMemo, createSignal } from "solid-js"

export type TuiCustomizationAction = {
  value: string
  title: string
  category: string
  description: string
  status?: string
  onSelect: () => void | Promise<void>
}

type ToggleDefinition = {
  key: MendTuiCustomizationBooleanKey
  title: string
  category: string
  description: string
}

const TOGGLES: ToggleDefinition[] = [
  {
    key: "projectPath",
    title: "Project location",
    category: "Session chrome",
    description: "Show the active project path and branch in the session header.",
  },
  {
    key: "sessionTitle",
    title: "Session title",
    category: "Session chrome",
    description: "Show the current chat title in the session header.",
  },
  {
    key: "contextBar",
    title: "Context bar",
    category: "Session chrome",
    description: "Show context usage and token progress in the session header.",
  },
  {
    key: "diffCount",
    title: "Diff line count",
    category: "Session chrome",
    description: "Show added and removed line totals for the active project.",
  },
  {
    key: "diffFiles",
    title: "Diff file count",
    category: "Session chrome",
    description: "Show how many files changed beside the diff totals.",
  },
  {
    key: "terminalTitle",
    title: "Terminal window title",
    category: "Window",
    description: "Keep the MendCode/session title synchronized with the terminal window.",
  },
]

function toggleTitle(enabled: boolean, title: string) {
  return `${enabled ? "[on]" : "[off]"} ${title}`
}

export function DialogCustomization(props: { actions?: TuiCustomizationAction[] }) {
  const kv = useKV()
  const dialog = useDialog()
  const toast = useToast()
  const { theme } = useTheme()
  const customization = createMemo(() => readMendTuiCustomization((key, fallback) => kv.get(key, fallback)))
  const [selectedValue, setSelectedValue] = createSignal("toggle:projectPath")
  const selectedIsToggle = createMemo(() => selectedValue().startsWith("toggle:"))
  const space = Keybind.parse("space").at(0)

  function toggle(key: MendTuiCustomizationBooleanKey) {
    const current = customization()
    writeMendTuiCustomization((name, fallback) => kv.get(name, fallback), kv.set, { [key]: !current[key] })
  }

  function reset() {
    resetMendTuiCustomization(kv.set)
    toast.show({ variant: "info", message: "TUI customization reset to defaults.", duration: 2500 })
  }

  const options = createMemo<DialogSelectOption<string>[]>(() => {
    const current = customization()
    const toggles = TOGGLES.map((item) => ({
      title: toggleTitle(current[item.key], item.title),
      value: `toggle:${item.key}`,
      category: item.category,
      description: item.description,
      footer: space ? Keybind.toString(space) : "space",
      onSelect: () => toggle(item.key),
    }))
    const actions = (props.actions ?? []).map((item) => ({
      title: item.title,
      value: item.value,
      category: item.category,
      description: item.description,
      footer: [item.status, "enter"].filter(Boolean).join(" · "),
      onSelect: () => void item.onSelect(),
    }))
    return [
      ...toggles,
      {
        title: `${current.sessionAccent === "random" ? "[on]" : "[off]"} Random session accent`,
        value: "toggle:sessionAccent",
        category: "Window",
        description: "Use a deterministic accent color per session instead of the theme accent.",
        footer: space ? Keybind.toString(space) : "space",
        onSelect: () =>
          writeMendTuiCustomization((name, fallback) => kv.get(name, fallback), kv.set, {
            sessionAccent: current.sessionAccent === "random" ? DEFAULT_MEND_TUI_CUSTOMIZATION.sessionAccent : "random",
          }),
      },
      ...actions,
      {
        title: "Reset TUI customization",
        value: "reset",
        category: "Maintenance",
        description: "Restore the default enabled chrome and theme accent without touching profile files.",
        footer: "enter",
        onSelect: reset,

        gutter: () => <text fg={theme.warning}>!</text>,
      },
    ]
  })

  return (
    <DialogSelect
      title="Customize TUI"
      variant="command"
      flat={true}
      placeholder="search visual settings"
      options={options()}
      onMove={(item) => setSelectedValue(item.value)}
      keybind={
        space && selectedIsToggle()
          ? [
              {
                title: "toggle",
                keybind: space,
                onTrigger: (item) => {
                  if (item.value.startsWith("toggle:")) item.onSelect?.(dialog)
                },
              },
            ]
          : undefined
      }
    />
  )
}
