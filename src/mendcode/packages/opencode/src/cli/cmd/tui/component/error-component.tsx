import { RGBA, TextAttributes, type TerminalColors } from "@opentui/core"
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid"
import * as Clipboard from "@tui/util/clipboard"
import { createSignal, onMount } from "solid-js"
import { InstallationVersion } from "@mendcode/core/installation/version"
import { win32FlushInputBuffer } from "../win32"
import { getScrollAcceleration } from "../util/scroll"
import { defaultActivityMascotStates } from "@/mend/tui/mascot"

type RecoveryColors = {
  bg: RGBA
  panel: RGBA
  text: RGBA
  muted: RGBA
  border: RGBA
  error: RGBA
  primary: RGBA
  primaryText: RGBA
  info: RGBA
}

function parseColor(value: string | null | undefined, fallback: RGBA) {
  if (!value) return fallback
  try {
    return RGBA.fromHex(value)
  } catch {
    return fallback
  }
}

function blend(base: RGBA, tint: RGBA, amount: number) {
  return RGBA.fromValues(
    base.r + (tint.r - base.r) * amount,
    base.g + (tint.g - base.g) * amount,
    base.b + (tint.b - base.b) * amount,
    1,
  )
}

function luminance(color: RGBA) {
  return 0.299 * color.r + 0.587 * color.g + 0.114 * color.b
}

function recoveryColors(terminal: TerminalColors | undefined, mode: "dark" | "light"): RecoveryColors {
  const fallbackBg = RGBA.fromHex(mode === "light" ? "#f5f7f9" : "#101215")
  const fallbackText = RGBA.fromHex(mode === "light" ? "#1b2229" : "#edf1f4")
  const fallbackError = RGBA.fromHex(mode === "light" ? "#b4233c" : "#ff8d8d")
  const fallbackPrimary = RGBA.fromHex(mode === "light" ? "#2f6ebd" : "#e4a276")
  const color = (index: number, fallback: RGBA) => parseColor(terminal?.palette[index], fallback)
  const bg = parseColor(terminal?.defaultBackground, color(0, fallbackBg))
  const text = parseColor(terminal?.defaultForeground, color(7, fallbackText))
  const primary = color(6, fallbackPrimary)

  return {
    bg,
    panel: blend(bg, text, mode === "light" ? 0.04 : 0.08),
    text,
    muted: blend(bg, text, mode === "light" ? 0.56 : 0.68),
    border: blend(bg, text, mode === "light" ? 0.24 : 0.28),
    error: color(1, fallbackError),
    primary,
    primaryText: luminance(primary) > 0.5 ? bg : text,
    info: color(4, primary),
  }
}

export function ErrorComponent(props: {
  error: Error
  reset: () => void
  onBeforeExit?: () => Promise<void>
  onExit: () => Promise<void>
  mode?: "dark" | "light"
}) {
  const term = useTerminalDimensions()
  const renderer = useRenderer()
  const mode = props.mode ?? "dark"
  const [colors, setColors] = createSignal(recoveryColors(undefined, mode))

  onMount(() => {
    void renderer
      .getPalette({ size: 16 })
      .then((terminal) => setColors(recoveryColors(terminal, mode)))
      .catch(() => undefined)
  })

  const handleExit = async () => {
    await props.onBeforeExit?.()
    renderer.setTerminalTitle("")
    renderer.destroy()
    win32FlushInputBuffer()
    await props.onExit()
  }

  const [copied, setCopied] = createSignal(false)

  const issueURL = new URL("https://github.com/MendCode/MendCode/issues/new?template=bug-report.yml")

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
      backgroundColor={colors().bg}
      overflow="hidden"
    >
      <box flexDirection="row" justifyContent="space-between" width="100%" flexShrink={0}>
        <text fg={colors().muted} wrapMode="none">
          MENDCODE / TUI RECOVERY
        </text>
        <text fg={colors().error} attributes={TextAttributes.BOLD} wrapMode="none">
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
          borderColor={colors().error}
          backgroundColor={colors().panel}
          paddingLeft={2}
          paddingRight={2}
          paddingTop={1}
          paddingBottom={1}
          overflow="hidden"
        >
          <box flexDirection="row" gap={2} alignItems="center">
            <text fg={colors().error} wrapMode="none">
              {errorMascot}
            </text>
            <box flexDirection="column" gap={1} flexGrow={1} minWidth={0}>
              <text fg={colors().text} attributes={TextAttributes.BOLD} wrapMode="word">
                The TUI stopped unexpectedly.
              </text>
              <text fg={colors().muted} wrapMode="word">
                Reset the interface to try again, or exit and return to your shell.
              </text>
            </box>
          </box>
          <box flexDirection="column" gap={1} minWidth={0} minHeight={0}>
            <text fg={colors().error} attributes={TextAttributes.BOLD} wrapMode="none">
              EXCEPTION / {errorName}
            </text>
            <text fg={colors().text} wrapMode="word">
              {errorText}
            </text>
            <scrollbox height={stackHeight()} minHeight={3} scrollAcceleration={getScrollAcceleration()}>
              <text fg={colors().muted} wrapMode="word">
                {errorStack}
              </text>
            </scrollbox>
          </box>
          <box flexDirection="column" gap={1} paddingTop={1}>
            <text fg={colors().muted} attributes={TextAttributes.BOLD} wrapMode="none">
              RECOVERY ACTIONS
            </text>
            <box flexDirection="row" gap={1} flexWrap="wrap">
              <box
                onMouseUp={props.reset}
                flexDirection="row"
                gap={1}
                alignItems="center"
                borderStyle="single"
                borderColor={colors().primary}
                backgroundColor={colors().primary}
                paddingLeft={1}
                paddingRight={1}
              >
                <text fg={colors().primaryText} attributes={TextAttributes.BOLD} wrapMode="none">
                  [r]
                </text>
                <text fg={colors().primaryText} attributes={TextAttributes.BOLD} wrapMode="none">
                  Reset interface
                </text>
              </box>
              <box
                onMouseUp={handleExit}
                flexDirection="row"
                gap={1}
                alignItems="center"
                borderStyle="single"
                borderColor={colors().border}
                backgroundColor={colors().panel}
                paddingLeft={1}
                paddingRight={1}
              >
                <text fg={colors().text} attributes={TextAttributes.BOLD} wrapMode="none">
                  [q]
                </text>
                <text fg={colors().text} wrapMode="none">
                  Exit
                </text>
              </box>
              <box
                onMouseUp={copyIssueURL}
                flexDirection="row"
                gap={1}
                alignItems="center"
                borderStyle="single"
                borderColor={colors().info}
                backgroundColor={colors().panel}
                paddingLeft={1}
                paddingRight={1}
              >
                <text fg={colors().info} attributes={TextAttributes.BOLD} wrapMode="none">
                  [c]
                </text>
                <text fg={colors().text} wrapMode="none">
                  {copied() ? "Copied" : "Copy diagnostics"}
                </text>
              </box>
            </box>
          </box>
        </box>
      </box>
      <box flexDirection="column" gap={0} flexShrink={0}>
        <text fg={colors().muted} wrapMode="word">
          {copied() ? "Diagnostic link copied to the clipboard." : "Nothing is sent automatically."}
        </text>
        <text fg={colors().muted} wrapMode="word">
          Shortcuts: [r] reset, [q] exit, [c] copy diagnostics, [Ctrl+C] exit
        </text>
      </box>
    </box>
  )
}
