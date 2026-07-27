import { TextAttributes } from "@opentui/core"
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid"
import * as Clipboard from "@tui/util/clipboard"
import { createSignal } from "solid-js"
import { InstallationVersion } from "@mendcode/core/installation/version"
import { win32FlushInputBuffer } from "../win32"
import { getScrollAcceleration } from "../util/scroll"
import { defaultActivityMascotStates } from "@/mend/tui/mascot"

export function ErrorComponent(props: {
  error: Error
  reset: () => void
  onBeforeExit?: () => Promise<void>
  onExit: () => Promise<void>
  mode?: "dark" | "light"
}) {
  const term = useTerminalDimensions()
  const renderer = useRenderer()

  const handleExit = async () => {
    await props.onBeforeExit?.()
    renderer.setTerminalTitle("")
    renderer.destroy()
    win32FlushInputBuffer()
    await props.onExit()
  }

  const [copied, setCopied] = createSignal(false)

  const issueURL = new URL("https://github.com/MendCode/MendCode/issues/new?template=bug-report.yml")

  const isLight = props.mode === "light"
  const colors = {
    bg: isLight ? "#f5f7f9" : "#101215",
    panel: isLight ? "#e9edf1" : "#171a1f",
    text: isLight ? "#1b2229" : "#edf1f4",
    muted: isLight ? "#64707b" : "#9ca6b0",
    border: isLight ? "#c8d0d9" : "#343b44",
    error: isLight ? "#b4233c" : "#ff8d8d",
    primary: isLight ? "#2f6ebd" : "#e4a276",
    primaryText: isLight ? "#f5f7f9" : "#101215",
  }
  const errorName = props.error.name && props.error.name !== "Error" ? props.error.name : "Unexpected error"
  const errorText = props.error.message || "No additional error message was provided."
  const errorStack = props.error.stack || "No stack trace was available."
  const errorMascot = defaultActivityMascotStates.error ?? defaultActivityMascotStates.idle ?? "[x_x]"
  const stackHeight = () => Math.max(3, Math.min(8, Math.floor(term().height * 0.28)))

  if (props.error.message) {
    issueURL.searchParams.set("title", `mendcode-tui: fatal: ${props.error.message}`)
  }

  if (props.error.stack) {
    issueURL.searchParams.set(
      "description",
      "```\n" + props.error.stack.substring(0, 6000 - issueURL.toString().length) + "...\n```",
    )
  }

  issueURL.searchParams.set("mendcode-version", InstallationVersion)

  const copyIssueURL = () => {
    void Clipboard.copy(issueURL.toString())
      .then(() => setCopied(true))
      .catch(() => undefined)
  }

  useKeyboard((evt) => {
    if (evt.ctrl && evt.name === "c") {
      void handleExit()
      return
    }
    if (evt.name === "r") {
      props.reset()
      return
    }
    if (evt.name === "c") {
      copyIssueURL()
      return
    }
    if (evt.name === "q" || evt.name === "escape") void handleExit()
  })

  return (
    <box
      width="100%"
      height="100%"
      flexDirection="column"
      gap={1}
      paddingLeft={2}
      paddingRight={2}
      paddingTop={1}
      paddingBottom={1}
      backgroundColor={colors.bg}
      overflow="hidden"
    >
      <box flexDirection="row" justifyContent="space-between" width="100%" flexShrink={0}>
        <text fg={colors.muted} wrapMode="none">
          MENDCODE / TUI RECOVERY
        </text>
        <text fg={colors.error} attributes={TextAttributes.BOLD} wrapMode="none">
          [!] ERROR
        </text>
      </box>
      <box
        flexDirection="column"
        flexGrow={1}
        minHeight={0}
        justifyContent="center"
        alignItems="center"
        overflow="hidden"
      >
        <box
          width="100%"
          maxWidth={Math.max(1, Math.min(86, term().width - 4))}
          flexDirection="column"
          gap={1}
          borderStyle="single"
          borderColor={colors.error}
          backgroundColor={colors.panel}
          paddingLeft={2}
          paddingRight={2}
          paddingTop={1}
          paddingBottom={1}
          overflow="hidden"
        >
          <box flexDirection="row" gap={2} alignItems="center">
            <text fg={colors.error} wrapMode="none">
              {errorMascot}
            </text>
            <box flexDirection="column" gap={1} flexGrow={1} minWidth={0}>
              <text fg={colors.text} attributes={TextAttributes.BOLD} wrapMode="word">
                The TUI stopped unexpectedly.
              </text>
              <text fg={colors.muted} wrapMode="word">
                Reset the interface to try again, or exit and return to your shell.
              </text>
            </box>
          </box>
          <box flexDirection="column" gap={1} minWidth={0} minHeight={0}>
            <text fg={colors.error} attributes={TextAttributes.BOLD} wrapMode="none">
              EXCEPTION / {errorName}
            </text>
            <text fg={colors.text} wrapMode="word">
              {errorText}
            </text>
            <scrollbox height={stackHeight()} minHeight={3} scrollAcceleration={getScrollAcceleration()}>
              <text fg={colors.muted} wrapMode="word">
                {errorStack}
              </text>
            </scrollbox>
          </box>
          <box flexDirection="row" gap={1} flexWrap="wrap" paddingTop={1}>
            <box onMouseUp={props.reset} backgroundColor={colors.primary} paddingLeft={1} paddingRight={1}>
              <text fg={colors.primaryText} attributes={TextAttributes.BOLD}>
                [r] Reset TUI
              </text>
            </box>
            <box
              onMouseUp={handleExit}
              borderStyle="single"
              borderColor={colors.border}
              paddingLeft={1}
              paddingRight={1}
            >
              <text fg={colors.text}>[q] Exit</text>
            </box>
            <box
              onMouseUp={copyIssueURL}
              borderStyle="single"
              borderColor={colors.border}
              paddingLeft={1}
              paddingRight={1}
            >
              <text fg={colors.text}>[c] Copy diagnostics</text>
            </box>
          </box>
        </box>
      </box>
      <box flexDirection="column" gap={0} flexShrink={0}>
        <text fg={colors.muted} wrapMode="word">
          {copied() ? "Diagnostic link copied to the clipboard." : "Nothing is sent automatically."}
        </text>
        <text fg={colors.muted} wrapMode="word">
          Shortcuts: [r] reset, [q] exit, [c] copy diagnostics, [Ctrl+C] exit
        </text>
      </box>
    </box>
  )
}
