import { RGBA, type SyntaxStyle } from "@opentui/core"
import { For, Match, Show, Switch, createMemo } from "solid-js"
import { normalizeHexColor } from "../util/hex-colors"
import { styledPlanMarkdownSegments } from "../util/styled-plan-lines"

type StyledPlanMarkdownProps = {
  content: string
  syntaxStyle: SyntaxStyle
  width?: number
  fg: RGBA
  bg: RGBA
  conceal?: boolean
  tableOptions?: {
    style?: "grid"
    widthMode?: "full"
    columnFitter?: "balanced"
    wrapMode?: "char"
  }
  stableTextMode?: boolean
  colorizeHex?: boolean
  streamingTail?: string
  streamingTailColorizeHex?: boolean
}

const HEX_PATTERN = /(^|[^A-Za-z0-9_])(#(?:[0-9A-Fa-f]{3}|[0-9A-Fa-f]{6}))(?![A-Za-z0-9_])/g
const HEX_TEST_PATTERN = /(^|[^A-Za-z0-9_])#(?:[0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})(?![A-Za-z0-9_])/

export function hasStyledHexColors(content: string) {
  return HEX_TEST_PATTERN.test(content)
}

function wrapDisplayLine(line: string, width: number) {
  const maxWidth = Math.max(1, Math.floor(width))
  if (!line || Bun.stringWidth(line) <= maxWidth) return [line]

  const lines: string[] = []
  let current = ""
  const pushWideWord = (word: string) => {
    let chunk = ""
    for (const char of word) {
      const next = `${chunk}${char}`
      if (Bun.stringWidth(next) <= maxWidth) {
        chunk = next
        continue
      }
      if (chunk) lines.push(chunk)
      chunk = char
    }
    return chunk
  }

  for (const part of line.split(/(\s+)/)) {
    if (!part) continue
    const next = `${current}${part}`
    if (!current || Bun.stringWidth(next) <= maxWidth) {
      current = next
      continue
    }
    lines.push(current.trimEnd())
    current = Bun.stringWidth(part) <= maxWidth ? part.trimStart() : pushWideWord(part.trimStart())
  }
  if (current) lines.push(current.trimEnd())
  return lines.length ? lines : [line]
}

export function wrapMarkdownDisplayCodeBlocks(content: string, width: number | undefined) {
  if (!width || width <= 0) return content
  let inFence = false
  const wrapped: string[] = []
  for (const line of content.split("\n")) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      wrapped.push(line)
      continue
    }
    wrapped.push(...(inFence ? wrapDisplayLine(line, Math.max(1, width - 1)) : [line]))
  }
  return wrapped.join("\n")
}

function isBoxDrawingLine(line: string) {
  return /^\s*[│├┌┐└┘┬┴┼╭╮╰╯─━╞╪╡]/.test(line)
}

export function wrapPlainDisplayText(content: string, width: number | undefined) {
  if (!width || width <= 0) return content
  return content
    .split("\n")
    .flatMap((line) => (isBoxDrawingLine(line) ? [line] : wrapDisplayLine(line, Math.max(1, width - 1))))
    .join("\n")
}

function foregroundFor(hex: string) {
  const color = normalizeHexColor(hex)
  if (!color) return RGBA.fromInts(255, 255, 255)
  const red = Number.parseInt(color.slice(1, 3), 16)
  const green = Number.parseInt(color.slice(3, 5), 16)
  const blue = Number.parseInt(color.slice(5, 7), 16)
  const luminance = (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255
  return luminance > 0.55 ? RGBA.fromInts(0, 0, 0) : RGBA.fromInts(255, 255, 255)
}

function isMarkdownTableLine(line: string) {
  const trimmed = line.trim()
  return trimmed.length > 1 && trimmed.startsWith("|") && trimmed.endsWith("|")
}

export function shouldColorizeHexMarkdownLine(line: string, inFence = false) {
  if (inFence) return false
  if (isMarkdownTableLine(line)) return false
  return hasStyledHexColors(line)
}

function HexStyledLine(props: { line: string; fallback: RGBA; colorize?: boolean }) {
  const parts = createMemo(() => {
    const items: Array<{ text: string; hex?: string }> = []
    let cursor = 0
    HEX_PATTERN.lastIndex = 0
    for (const match of props.line.matchAll(HEX_PATTERN)) {
      const prefix = match[1] ?? ""
      const index = (match.index ?? 0) + prefix.length
      if (index > cursor) items.push({ text: props.line.slice(cursor, index) })
      const display = match[2] ?? ""
      const hex = normalizeHexColor(display)
      items.push({ text: display, hex })
      cursor = index + display.length
    }
    if (cursor < props.line.length) items.push({ text: props.line.slice(cursor) })
    if (items.length === 0) items.push({ text: props.line || " " })
    return items
  })

  return (
    <box flexDirection="row" flexShrink={0}>
      <For each={parts()}>
        {(part) =>
          props.colorize !== false && part.hex ? (
            <box
              backgroundColor={RGBA.fromHex(part.hex)}
              width={Bun.stringWidth(part.text)}
              height={1}
              flexShrink={0}
              overflow="hidden"
            >
              <text fg={foregroundFor(part.hex)} wrapMode="none">
                {part.text}
              </text>
            </box>
          ) : (
            <text fg={props.fallback} wrapMode="none">
              {part.text}
            </text>
          )
        }
      </For>
    </box>
  )
}

function HexStyledLines(props: { content: string; fallback: RGBA; colorize?: boolean; width?: number }) {
  const content = createMemo(() => wrapPlainDisplayText(props.content, props.width))
  return (
    <box flexDirection="column" flexShrink={0}>
      <For each={content().split("\n")}>
        {(line) => <HexStyledLine line={line} fallback={props.fallback} colorize={props.colorize} />}
      </For>
    </box>
  )
}

function MarkdownSegment(props: StyledPlanMarkdownProps & { content: string }) {
  const displayContent = createMemo(() => wrapMarkdownDisplayCodeBlocks(props.content, props.width))
  const chunks = createMemo(() => {
    const result: Array<{ kind: "markdown" | "hex"; content: string }> = []
    const markdown: string[] = []
    const flushMarkdown = () => {
      if (markdown.length === 0) return
      result.push({ kind: "markdown", content: markdown.join("\n") })
      markdown.length = 0
    }

    let inFence = false
    for (const line of displayContent().split("\n")) {
      if (/^\s*```/.test(line)) {
        markdown.push(line)
        inFence = !inFence
        continue
      }
      if (shouldColorizeHexMarkdownLine(line, inFence)) {
        flushMarkdown()
        result.push({ kind: "hex", content: line })
        continue
      }
      markdown.push(line)
    }
    flushMarkdown()
    return result
  })

  return (
    <box flexDirection="column" flexShrink={0}>
      <For each={chunks()}>
        {(chunk) => (
          <Switch>
            <Match when={chunk.kind === "hex"}>
              <HexStyledLine line={chunk.content} fallback={props.fg} colorize={props.colorizeHex} />
            </Match>
            <Match when={true}>
              <Show when={chunk.content.trim().length > 0} fallback={<text fg={props.fg}> </text>}>
                <markdown
                  syntaxStyle={props.syntaxStyle}
                  streaming={false}
                  width={props.width}
                  content={chunk.content}
                  tableOptions={props.tableOptions}
                  conceal={props.conceal}
                  fg={props.fg}
                  bg={props.bg}
                />
              </Show>
            </Match>
          </Switch>
        )}
      </For>
    </box>
  )
}

export function StyledPlanMarkdown(props: StyledPlanMarkdownProps) {
  const segments = createMemo(() => styledPlanMarkdownSegments(props.content))
  const streamingTail = createMemo(() => props.streamingTail ?? "")

  return (
    <box flexDirection="column" flexShrink={0}>
      <For each={segments()}>
        {(segment) => (
          <Switch>
            <Match when={props.stableTextMode || segment.kind === "text"}>
              <HexStyledLines content={segment.content} fallback={props.fg} colorize={props.colorizeHex} width={props.width} />
            </Match>
            <Match when={true}>
              <MarkdownSegment {...props} content={segment.content} />
            </Match>
          </Switch>
        )}
      </For>
      <Show when={streamingTail().length > 0}>
        <HexStyledLines
          content={streamingTail()}
          fallback={props.fg}
          colorize={props.streamingTailColorizeHex ?? props.colorizeHex}
        />
      </Show>
    </box>
  )
}
