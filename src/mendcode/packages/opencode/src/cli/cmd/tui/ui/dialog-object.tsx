import { ScrollBoxRenderable, TextAttributes } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { createMemo, For, Show } from "solid-js"
import { useTheme } from "../context/theme"
import { useTuiConfig } from "../context/tui-config"
import { getScrollAcceleration } from "../util/scroll"
import { useDialog, type DialogContext } from "./dialog"

type DialogObjectProps = {
  title: string
  value: unknown
  onConfirm?: () => void
}

type RenderNode = {
  key?: string
  value: unknown
  depth: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function entries(value: unknown): RenderNode[] {
  if (Array.isArray(value)) return value.map((item, index) => ({ key: `[${index}]`, value: item, depth: 0 }))
  if (isRecord(value)) return Object.entries(value).map(([key, item]) => ({ key, value: item, depth: 0 }))
  return [{ value, depth: 0 }]
}

function valueLabel(value: unknown) {
  if (value === null) return "null"
  if (value === undefined) return "undefined"
  if (typeof value === "string") return value || '""'
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value)
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? "" : "s"}`
  if (isRecord(value)) return `${Object.keys(value).length} field${Object.keys(value).length === 1 ? "" : "s"}`
  return String(value)
}

function nodeChildren(node: RenderNode) {
  return entries(node.value).map((child) => ({ ...child, depth: node.depth + 1 }))
}

function normalizeValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (Array.isArray(value)) {
    if (seen.has(value)) return "[Circular]"
    seen.add(value)
    return value.map((item) => normalizeValue(item, seen))
  }
  if (isRecord(value)) {
    if (seen.has(value)) return "[Circular]"
    seen.add(value)
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalizeValue(item, seen)]))
  }
  return value
}

function RenderValue(props: { node: RenderNode }) {
  const { theme } = useTheme()
  const complex = createMemo(() => Array.isArray(props.node.value) || isRecord(props.node.value))
  const label = createMemo(() => valueLabel(props.node.value))
  const valueColor = createMemo(() => {
    const value = props.node.value
    if (value === null || value === undefined) return theme.textMuted
    if (typeof value === "boolean") return value ? theme.success : theme.warning
    if (typeof value === "number" || typeof value === "bigint") return theme.accent
    if (complex()) return theme.textMuted
    return theme.text
  })

  return (
    <box paddingLeft={Math.min(props.node.depth * 2, 10)} flexDirection="column" gap={complex() ? 0 : undefined}>
      <box flexDirection="row" gap={1}>
        <Show when={props.node.key}>
          {(key) => (
            <text fg={theme.text} attributes={TextAttributes.BOLD} flexShrink={0}>
              {key()}:
            </text>
          )}
        </Show>
        <text fg={valueColor()} wrapMode="word">
          {label()}
        </text>
      </box>
      <Show when={complex()}>
        <For each={nodeChildren(props.node)}>{(child) => <RenderValue node={child} />}</For>
      </Show>
    </box>
  )
}

export function DialogObject(props: DialogObjectProps) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const tuiConfig = useTuiConfig()
  const scrollAcceleration = createMemo(() => getScrollAcceleration(tuiConfig))
  const rows = createMemo(() => entries(normalizeValue(props.value)))
  const bodyHeight = createMemo(() => Math.max(4, Math.min(22, dimensions().height - 9)))
  let scroll: ScrollBoxRenderable | undefined

  useKeyboard((evt) => {
    if (evt.name === "return") {
      evt.preventDefault()
      evt.stopPropagation()
      props.onConfirm?.()
      dialog.clear()
      return
    }
    if (evt.name === "up") {
      evt.preventDefault()
      scroll?.scrollBy(-1)
    }
    if (evt.name === "down") {
      evt.preventDefault()
      scroll?.scrollBy(1)
    }
    if (evt.name === "pageup") {
      evt.preventDefault()
      scroll?.scrollBy(-bodyHeight())
    }
    if (evt.name === "pagedown") {
      evt.preventDefault()
      scroll?.scrollBy(bodyHeight())
    }
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between" flexShrink={0}>
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          {props.title}
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <scrollbox
        ref={(r: ScrollBoxRenderable) => (scroll = r)}
        height={bodyHeight()}
        paddingRight={1}
        scrollAcceleration={scrollAcceleration()}
        verticalScrollbarOptions={{
          trackOptions: {
            backgroundColor: theme.backgroundPanel,
            foregroundColor: theme.borderActive,
          },
        }}
      >
        <For each={rows()}>{(node) => <RenderValue node={node} />}</For>
      </scrollbox>
      <box flexDirection="row" justifyContent="flex-end" flexShrink={0}>
        <box
          paddingLeft={3}
          paddingRight={3}
          backgroundColor={theme.primary}
          onMouseUp={() => {
            props.onConfirm?.()
            dialog.clear()
          }}
        >
          <text fg={theme.selectedListItemText}>ok</text>
        </box>
      </box>
    </box>
  )
}

export function showDialogObject(dialog: DialogContext, title: string, value: unknown) {
  return new Promise<void>((resolve) => {
    dialog.replace(
      () => <DialogObject title={title} value={value} onConfirm={() => resolve()} />,
      () => resolve(),
    )
    dialog.setSize("xlarge")
  })
}
