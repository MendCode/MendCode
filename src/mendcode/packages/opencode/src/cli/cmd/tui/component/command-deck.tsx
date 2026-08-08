import { TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { For, Show, createMemo, type JSX } from "solid-js"
import type { Route } from "@tui/context/route"
import { useTheme } from "@tui/context/theme"

export type CommandDeckPage = "loops" | "workflows" | "stats" | "memory" | "changes" | "setup"

type CommandDeckText = string | (() => string)

type CommandDeckProps = {
  page: CommandDeckPage
  subtitle?: CommandDeckText
  status?: CommandDeckText
  summary?: CommandDeckText
  rail?: JSX.Element
  context?: JSX.Element
  footer?: CommandDeckText
  children: JSX.Element
}

type CommandDeckContextProps = {
  title: string
  rows?: Array<[string, string]>
  children?: JSX.Element
}

const PAGE_LABELS: Record<CommandDeckPage, string> = {
  loops: "LOOPS",
  workflows: "WORKFLOWS",
  stats: "STATS",
  memory: "MEMORY",
  changes: "CHANGES",
  setup: "SETUP",
}

function readText(value: CommandDeckText | undefined, fallback = "") {
  if (typeof value === "function") return value()
  return value ?? fallback
}

function wrapFooter(value: string, width: number) {
  const tokens = value.split(/\s{2,}| · /).map((token) => token.trim()).filter(Boolean)
  if (tokens.length === 0) return [""]
  const lines: string[] = []
  let line = ""
  for (const token of tokens) {
    const next = line ? `${line}   ${token}` : token
    if (line && next.length > width) {
      lines.push(line)
      line = token
      continue
    }
    line = next
  }
  if (line) lines.push(line)
  return lines
}

export function commandDeckLayout(input: { width: number; height: number; hasRail?: boolean; hasContext?: boolean }) {
  const width = Math.max(0, input.width)
  const height = Math.max(0, input.height)
  const hasRail = input.hasRail ?? true
  const hasContext = input.hasContext ?? true
  const wide = width >= 120 && height >= 24
  const railWidth = Math.min(48, Math.max(24, Math.floor(width * 0.2)))
  const contextWidth = Math.min(50, Math.max(30, Math.floor(width * 0.24)))
  const sideWidth = (hasRail ? railWidth : 0) + (hasContext ? contextWidth : 0)
  const sideChrome = sideWidth === 0 ? 2 : sideWidth + (hasRail && hasContext ? 4 : 3)
  return {
    wide,
    compact: width < 96 || height < 22,
    railWidth,
    contextWidth,
    contentWidth: Math.max(30, width - (wide ? sideChrome : 2)),
  }
}

export function commandDeckRouteTarget(route: Route, page: CommandDeckPage): Route {
  const returnTo = "returnTo" in route ? route.returnTo : undefined
  const returnProps = returnTo ? { returnTo } : {}
  if (page === "setup") return { type: "setup", ...returnProps }
  if (page === "stats") {
    return {
      type: "stats",
      scope: route.type === "stats" ? (route.scope ?? "global") : "global",
      ...returnProps,
    }
  }
  if (page === "memory") return { type: "memory", ...returnProps }
  if (page === "changes") return { type: "changes", ...returnProps }
  if (page === "workflows") return { type: "workflows", ...returnProps }
  return { type: "loops", ...returnProps }
}

function Rail(props: {
  content?: JSX.Element
}) {
  return (
    <Show when={props.content}>
      {props.content}
    </Show>
  )
}

export function CommandDeckContext(props: CommandDeckContextProps) {
  const { theme } = useTheme()
  return (
    <box flexDirection="column" minHeight={0} flexGrow={1} gap={1} overflow="hidden">
      <text fg={theme.primary} attributes={TextAttributes.BOLD} wrapMode="none">
        {props.title}
      </text>
      <For each={props.rows ?? []}>
        {(row) => (
          <box flexDirection="row" minHeight={1} overflow="hidden" gap={1}>
            <text fg={theme.textMuted} width={9} flexShrink={0} wrapMode="none">
              {row[0]}
            </text>
            <text fg={theme.text} flexGrow={1} minWidth={0} wrapMode="word">
              {row[1]}
            </text>
          </box>
        )}
      </For>
      {props.children}
    </box>
  )
}

export function CommandDeck(props: CommandDeckProps) {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const layout = createMemo(() => commandDeckLayout({
    ...dimensions(),
    hasRail: Boolean(props.rail),
    hasContext: Boolean(props.context),
  }))
  const status = createMemo(() => readText(props.status, "LIVE"))
  const subtitle = createMemo(() => readText(props.subtitle))
  const summary = createMemo(() => readText(props.summary))
  const footer = createMemo(() => readText(props.footer, "↑↓ Navigate   Enter Open   r Refresh   ? Help   q Back"))
  const footerLines = createMemo(() => wrapFooter(footer(), Math.max(20, dimensions().width - 2)))

  return (
    <box
      flexDirection="column"
      width="100%"
      height="100%"
      paddingLeft={1}
      paddingRight={1}
      paddingTop={1}
      paddingBottom={1}
      gap={1}
    >
      <box flexDirection="row" height={1} overflow="hidden">
        <text fg={theme.primary} attributes={TextAttributes.BOLD} wrapMode="none">
          MENDCODE / {PAGE_LABELS[props.page]}
        </text>
        <box flexGrow={1} />
        <text
          fg={status() === "ERROR" ? theme.error : status() === "PAUSED" || status() === "STALE" || status() === "SYNCING" ? theme.warning : theme.textMuted}
          wrapMode="none"
        >
          ● {status()}
        </text>
      </box>
      <box flexDirection="row" height={1} overflow="hidden">
        <text fg={theme.textMuted} wrapMode="none">
          {subtitle()}
        </text>
        <box flexGrow={1} />
        <text fg={theme.textMuted} wrapMode="none">
          {summary()}
        </text>
      </box>
      <Show
        when={layout().wide}
        fallback={
          <box flexDirection="column" flexGrow={1} minHeight={0} gap={1}>
            {props.children}
            <Show when={props.context}>
              <box borderStyle="single" borderColor={theme.border} paddingLeft={1} paddingRight={1} minHeight={0}>
                {props.context}
              </box>
            </Show>
          </box>
        }
      >
        <box flexDirection="row" flexGrow={1} minHeight={0} gap={1}>
          <Show when={props.rail}>
            <box
              width={layout().railWidth}
              minHeight={0}
              borderStyle="single"
              borderColor={theme.border}
              paddingLeft={1}
              paddingRight={1}
            >
              <Rail content={props.rail} />
            </box>
          </Show>

          <box flexGrow={1} minWidth={0} minHeight={0} overflow="hidden">
            {props.children}
          </box>
          <Show when={props.context}>
            <box
              width={layout().contextWidth}
              minHeight={0}
              borderStyle="single"
              borderColor={theme.border}
              paddingLeft={1}
              paddingRight={1}
            >
              {props.context}
            </box>
          </Show>
        </box>
      </Show>
      <box flexDirection="column" height={footerLines().length} overflow="hidden">
        <For each={footerLines()}>
          {(line) => (
            <text fg={theme.textMuted} wrapMode="none">
              {line}
            </text>
          )}
        </For>
      </box>
    </box>
  )
}
