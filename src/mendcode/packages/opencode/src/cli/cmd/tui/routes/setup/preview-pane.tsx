import { For, Show } from "solid-js"
import { HomeSurface } from "@tui/routes/home"
import { useTheme } from "@tui/context/theme"
import type { TuiHelperEditTarget } from "@/mend/tui/helper-edit"
import type { TuiSurfaceWorkspace } from "@/mend/tui/profile-actions"

const previewTargets: Array<{ id: TuiHelperEditTarget; label: string }> = [
  { id: "home", label: "New Chat" },
  { id: "session", label: "Session" },
  { id: "footer", label: "Footer" },
  { id: "chatInput", label: "Chat Input" },
]

function SurfaceLines(props: { text: string }) {
  return <box flexDirection="column">{props.text.split("\n").map((line) => <text>{line}</text>)}</box>
}

export function SetupPreviewPane(props: {
  target: TuiHelperEditTarget
  active?: TuiSurfaceWorkspace
  draft?: TuiSurfaceWorkspace
  draftChanged: boolean
  onTargetChange: (target: TuiHelperEditTarget) => void
  onFullscreen: () => void
}) {
  const { theme } = useTheme()
  const surface = () => (props.draftChanged ? props.draft : undefined)
  const sessionAscii = () => props.draft?.sessionAscii || props.active?.sessionAscii || ""

  return (
    <box flexDirection="column" flexGrow={1} minWidth={0} minHeight={0} borderColor={theme.border} borderStyle="single" paddingLeft={1} paddingRight={1} paddingTop={1}>
      <box flexDirection="row" justifyContent="space-between" flexShrink={0}>
        <text fg={theme.primary}>Preview</text>
        <text fg={theme.textMuted} onMouseDown={props.onFullscreen}>
          fullscreen
        </text>
      </box>
      <box flexDirection="row" gap={1} flexWrap="wrap" flexShrink={0}>
        <For each={previewTargets}>
          {(item) => (
            <text
              fg={props.target === item.id ? theme.primary : theme.textMuted}
              onMouseDown={() => props.onTargetChange(item.id)}
            >
              {props.target === item.id ? `[${item.label}]` : item.label}
            </text>
          )}
        </For>
      </box>
      <box flexGrow={1} minHeight={0} flexDirection="column" paddingTop={1}>
        <Show
          when={props.target === "home"}
          fallback={
            <box flexGrow={1} minHeight={0} alignItems="center" justifyContent="center" paddingLeft={2} paddingRight={2}>
              <Show
                when={props.target === "session"}
                fallback={
                  <box flexDirection="column" gap={1}>
                    <text fg={theme.text}>Exact {props.target} preview is tracked as residual.</text>
                    <text fg={theme.textMuted}>New Chat uses the real Home surface now; this target still edits the same isolated draft model.</text>
                  </box>
                }
              >
                <box flexDirection="column" gap={1}>
                  <text fg={theme.textMuted}>Session draft source</text>
                  <SurfaceLines text={sessionAscii()} />
                </box>
              </Show>
            </box>
          }
        >
          <HomeSurface disabled={true} showToast={false} surface={surface() ? { homeAscii: surface()?.homeAscii } : undefined} />
        </Show>
      </box>
    </box>
  )
}
