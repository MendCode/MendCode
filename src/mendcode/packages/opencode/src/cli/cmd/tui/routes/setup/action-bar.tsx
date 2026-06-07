import { For } from "solid-js"
import { useTheme } from "@tui/context/theme"

export type SetupAction = {
  label: string
  active?: boolean
  disabled?: boolean
  onPress: () => void
}

export function SetupActionBar(props: { actions: SetupAction[] }) {
  const { theme } = useTheme()
  return (
    <box flexDirection="row" gap={2} flexWrap="wrap">
      <For each={props.actions}>
        {(action) => (
          <text
            fg={action.disabled ? theme.textMuted : action.active ? theme.primary : theme.text}
            onMouseDown={() => {
              if (action.disabled) return
              action.onPress()
            }}
          >
            {`[ ${action.label} ]`}
          </text>
        )}
      </For>
    </box>
  )
}
