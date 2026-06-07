import type { TextareaRenderable } from "@opentui/core"
import { For, Show, createSignal, onCleanup } from "solid-js"
import { useTheme } from "@tui/context/theme"
import type { TuiHelperEditTarget } from "@/mend/tui/helper-edit"

export type SetupHelperChatSubmitResult = {
  status: string
  changed: boolean
  diagnostics: string[]
  model?: string | null
}

export type SetupHelperChatRef = {
  focused: boolean
  focus(): void
  blur(): void
  submit(): void
}

type HelperMessage = {
  role: "user" | "helper" | "system"
  text: string
}

export function SetupHelperChat(props: {
  target: TuiHelperEditTarget
  disabled?: boolean
  lastEdit?: string
  ref?: (ref: SetupHelperChatRef | undefined) => void
  onSubmit: (instruction: string, target: TuiHelperEditTarget) => Promise<SetupHelperChatSubmitResult>
}) {
  let textarea: TextareaRenderable | undefined
  const { theme } = useTheme()
  const [input, setInput] = createSignal("")
  const [running, setRunning] = createSignal(false)
  const [messages, setMessages] = createSignal<HelperMessage[]>([
    {
      role: "system",
      text: "Helper edits the draft only. Apply is required before the active TUI changes.",
    },
  ])

  const append = (message: HelperMessage) => setMessages((items) => [...items, message].slice(-8))

  const submit = async () => {
    if (running() || props.disabled) return
    const instruction = input().trim()
    if (!instruction) return
    setRunning(true)
    append({ role: "user", text: instruction })
    textarea?.clear()
    setInput("")
    try {
      const result = await props.onSubmit(instruction, props.target)
      const diagnostics = result.diagnostics.length ? `: ${result.diagnostics.join("; ")}` : ""
      const model = result.model ? ` · ${result.model}` : ""
      append({
        role: "helper",
        text: `${result.changed ? "Draft updated" : "No draft change"} · ${result.status}${model}${diagnostics}`,
      })
    } catch (error) {
      append({
        role: "helper",
        text: `Error: ${error instanceof Error ? error.message : String(error)}`,
      })
    } finally {
      setRunning(false)
    }
  }

  const ref: SetupHelperChatRef = {
    get focused() {
      return textarea?.focused ?? false
    },
    focus() {
      textarea?.focus()
    },
    blur() {
      textarea?.blur()
    },
    submit() {
      void submit()
    },
  }
  onCleanup(() => props.ref?.(undefined))

  return (
    <box flexDirection="column" gap={1} minHeight={0}>
      <box flexDirection="row" justifyContent="space-between" flexShrink={0}>
        <text fg={theme.primary}>Helper AI</text>
        <text fg={theme.textMuted}>{running() ? "running" : props.lastEdit || "idle"}</text>
      </box>
      <box flexDirection="column" gap={1} flexGrow={1} minHeight={0}>
        <For each={messages()}>
          {(message) => (
            <box flexDirection="row" gap={1}>
              <text fg={message.role === "user" ? theme.primary : message.role === "helper" ? theme.text : theme.textMuted}>
                {message.role === "user" ? "You" : message.role === "helper" ? "Helper" : "Info"}
              </text>
              <text fg={message.role === "system" ? theme.textMuted : theme.text}>{message.text}</text>
            </box>
          )}
        </For>
      </box>
      <box border={["left"]} borderColor={running() ? theme.primary : theme.border} paddingLeft={1} paddingTop={1} paddingBottom={1} flexShrink={0}>
        <textarea
          ref={(value: TextareaRenderable) => {
            textarea = value
            props.ref?.(ref)
          }}
          placeholder="Describe the TUI change"
          placeholderColor={theme.textMuted}
          minHeight={2}
          maxHeight={6}
          textColor={props.disabled || running() ? theme.textMuted : theme.text}
          focusedTextColor={props.disabled || running() ? theme.textMuted : theme.text}
          cursorColor={props.disabled || running() ? theme.backgroundElement : theme.primary}
          keyBindings={[{ name: "return", action: "submit" }]}
          onSubmit={() => void submit()}
          onContentChange={() => setInput(textarea?.plainText ?? "")}
          onKeyDown={(event) => {
            if (props.disabled || running()) {
              event.preventDefault()
            }
          }}
          onMouseDown={(event) => event.target?.focus()}
        />
        <box flexDirection="row" gap={2} paddingTop={1}>
          <text fg={theme.text}>
            enter <span style={{ fg: theme.textMuted }}>send</span>
          </text>
          <text fg={theme.text}>
            esc <span style={{ fg: theme.textMuted }}>blur</span>
          </text>
          <Show when={running()}>
            <text fg={theme.primary}>working...</text>
          </Show>
        </box>
      </box>
    </box>
  )
}
