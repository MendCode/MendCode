import { createMemo, createSignal, For, Show } from "solid-js"
import type { TuiThemeCurrent } from "@mendcode/plugin/tui"
import { Locale } from "@/util/locale"
import {
  agentViewCommandStateRank,
  formatAgentViewCommandSummary,
  isAgentViewCommandActionable,
  type AgentViewCommand,
} from "../util/agent-view"

export function AgentCommandPanel(props: {
  commands: readonly AgentViewCommand[]
  sessionID: string
  width: number
  height?: number
  busyID?: string
  theme: Pick<TuiThemeCurrent, "text" | "textMuted" | "accent" | "error">
  onUpdate: (command: AgentViewCommand, state: "accepted" | "rejected") => void
  onOpenSession?: (sessionID: string) => void
}) {
  const [expanded, setExpanded] = createSignal(false)
  const active = createMemo(() =>
    props.commands
      .filter((command) => agentViewCommandStateRank(command) < 2)
      .toSorted(
        (a, b) =>
          Number(b.targetSessionID === props.sessionID && isAgentViewCommandActionable(b)) -
            Number(a.targetSessionID === props.sessionID && isAgentViewCommandActionable(a)) ||
          agentViewCommandStateRank(a) - agentViewCommandStateRank(b) ||
          b.time.updated - a.time.updated,
      ),
  )
  const history = createMemo(() =>
    props.commands
      .filter((command) => agentViewCommandStateRank(command) >= 2)
      .toSorted((a, b) => b.time.updated - a.time.updated),
  )
  const visible = createMemo(() => [...active().slice(0, 4), ...(expanded() ? history().slice(0, 4) : [])])
  const rows = () => (
    <>
      <For each={visible()}>
        {(command) => {
          const incoming = () => command.targetSessionID === props.sessionID
          const actionable = () => incoming() && isAgentViewCommandActionable(command)
          const busy = () => props.busyID === command.id
          const sender = () =>
            incoming() ? command.payload?.sourceTitle || command.sourceSessionID : command.targetSessionID
          const relatedSessionID = () => (incoming() ? command.sourceSessionID : command.targetSessionID)
          const canOpen = () =>
            Boolean(props.onOpenSession && relatedSessionID() && relatedSessionID() !== props.sessionID)
          const trailingWidth = () => (canOpen() ? 7 : 0) + (actionable() ? 19 : 0)
          return (
            <box width="100%" flexDirection="column" flexShrink={0}>
              <box width="100%" flexDirection="row" gap={1}>
                <text fg={props.theme.text} wrapMode="none" flexGrow={1} minWidth={0}>
                  {Locale.truncate(
                    `${incoming() ? "←" : "→"} ${Locale.truncate(sender().replace(/\s+/g, " "), 24)} · ${formatAgentViewCommandSummary(command)}`,
                    Math.max(1, props.width - trailingWidth()),
                  )}
                </text>
                <Show when={canOpen()}>
                  <text
                    id={`agent-command-open-${command.id}`}
                    fg={props.theme.textMuted}
                    wrapMode="none"
                    flexShrink={0}
                    onMouseUp={() => {
                      const sessionID = relatedSessionID()
                      if (sessionID) props.onOpenSession?.(sessionID)
                    }}
                  >
                    [open]
                  </text>
                </Show>
                <Show when={actionable()}>
                  <text
                    id={`agent-command-accept-${command.id}`}
                    fg={busy() ? props.theme.textMuted : props.theme.accent}
                    wrapMode="none"
                    flexShrink={0}
                    onMouseUp={() => {
                      if (!busy()) props.onUpdate(command, "accepted")
                    }}
                  >
                    [accept]
                  </text>
                  <text
                    id={`agent-command-reject-${command.id}`}
                    fg={busy() ? props.theme.textMuted : props.theme.error}
                    wrapMode="none"
                    flexShrink={0}
                    onMouseUp={() => {
                      if (!busy()) props.onUpdate(command, "rejected")
                    }}
                  >
                    [reject]
                  </text>
                </Show>
              </box>
              <Show when={expanded() && command.error}>
                <text fg={props.theme.textMuted} wrapMode="none">
                  {Locale.truncate(command.error!.replace(/\s+/g, " "), props.width)}
                </text>
              </Show>
            </box>
          )
        }}
      </For>
      <Show when={active().length > 4 || (expanded() && history().length > 4)}>
        <text fg={props.theme.textMuted} wrapMode="none">
          More commands in Agent View
        </text>
      </Show>
    </>
  )

  return (
    <Show when={props.commands.length > 0}>
      <box width={props.width} height={props.height} flexDirection="column" flexShrink={0}>
        <text
          id="agent-command-history-toggle"
          fg={props.theme.textMuted}
          wrapMode="none"
          onMouseUp={() => setExpanded((value) => !value)}
        >
          {history().length > 0 ? (expanded() ? "▾ " : "▸ ") : ""}Commands
          {active().length > 0 ? ` · ${active().length} active` : ""}
          {history().length > 0 ? ` · ${history().length} past` : ""}
        </text>
        <Show
          when={props.height !== undefined}
          fallback={rows()}
        >
          <scrollbox height={Math.max(1, props.height! - 1)} width="100%">
            {rows()}
          </scrollbox>
        </Show>
      </box>
    </Show>
  )
}
