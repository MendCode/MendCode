import { RGBA } from "@opentui/core"
import { For, Show, createMemo } from "solid-js"
import { useTheme } from "@tui/context/theme"
import { extractHexColors } from "../util/hex-colors"

export function HexColorSwatches(props: { content: string; visible: boolean }) {
  const { theme } = useTheme()
  const colors = createMemo(() => (props.visible ? extractHexColors(props.content) : []))

  return (
    <Show when={colors().length > 0}>
      <box flexDirection="row" gap={2} marginTop={1}>
        <For each={colors()}>
          {(color) => (
            <text wrapMode="none" fg={theme.textMuted}>
              <span style={{ fg: RGBA.fromHex(color.hex) }}>■</span>
              <span> {color.display}</span>
            </text>
          )}
        </For>
      </box>
    </Show>
  )
}
