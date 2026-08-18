import { RGBA, ScrollBoxRenderable, type MouseEvent as OpenTuiMouseEvent, type SyntaxStyle } from "@opentui/core"
import { For, Match, Show, Switch, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { normalizeHexColor } from "../util/hex-colors"
import { extractMermaidSources, renderMermaidAsciiCard } from "../util/markdown-render"
import { styledPlanMarkdownSegments, type StyledPlanMarkdownSegment } from "../util/styled-plan-lines"

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
  streaming?: boolean
  stableTextMode?: boolean
  colorizeHex?: boolean
  streamingTail?: string
  streamingTailColorizeHex?: boolean
  streamingTailMode?: "text" | "markdown"
  source?: string
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

function hasInlineCodeSpan(line: string) {
  return /(^|[^\\])`[^`\n]+`/.test(line)
}

export function shouldColorizeHexMarkdownLine(line: string, inFence = false) {
  if (inFence) return false
  if (isMarkdownTableLine(line)) return false
  if (hasInlineCodeSpan(line)) return false
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

const MERMAID_ASCII_CARD_PATTERN = /(^|\n)\s*╭ Mermaid ASCII ·/m

export function isMermaidAsciiCardContent(content: string) {
  return MERMAID_ASCII_CARD_PATTERN.test(content)
}

export function mermaidAsciiCardViewport(content: string, width: number, maxRows = 28) {
  const lines = content.trimEnd().split("\n")
  const viewportWidth = Math.max(24, Math.floor(width))
  const naturalWidth = Math.max(1, ...lines.map((line) => Bun.stringWidth(line)))
  const contentRows = Math.max(1, lines.length)
  return {
    lines,
    viewportWidth,
    naturalWidth,
    contentRows,
    overflowX: naturalWidth > viewportWidth,
    overflowY: contentRows > maxRows,
    viewportRows: Math.min(contentRows, maxRows),
    centerPadding: naturalWidth < viewportWidth ? Math.floor((viewportWidth - naturalWidth) / 2) : 0,
  }
}

function mermaidCardHeading(content: string) {
  const match = MERMAID_ASCII_CARD_PATTERN.exec(content)
  if (!match || match.index === 0) return ""
  return content.slice(0, match.index + (match[1]?.length ?? 0)).trimEnd()
}

function stopMouseEvent(event?: unknown) {
  const value = event as { preventDefault?: () => void; stopPropagation?: () => void } | undefined
  value?.preventDefault?.()
  value?.stopPropagation?.()
}

export function mermaidCardConsumesWheel(
  event: Pick<OpenTuiMouseEvent, "modifiers" | "scroll">,
  position: Pick<ScrollBoxRenderable, "scrollHeight" | "scrollLeft" | "scrollTop" | "scrollWidth" | "viewport">,
) {
  let direction = event.scroll?.direction
  if (!direction) return false
  if (event.modifiers.shift) {
    direction = direction === "up" ? "left" : direction === "down" ? "right" : direction === "right" ? "down" : "up"
  }

  const maxX = Math.max(0, position.scrollWidth - position.viewport.width)
  const maxY = Math.max(0, position.scrollHeight - position.viewport.height)
  if (direction === "left") return position.scrollLeft > 0
  if (direction === "right") return position.scrollLeft < maxX
  if (direction === "up") return position.scrollTop > 0
  return position.scrollTop < maxY
}

function effectiveWheelDirection(event: Pick<OpenTuiMouseEvent, "modifiers" | "scroll">) {
  const direction = event.scroll?.direction
  if (!direction || !event.modifiers.shift) return direction
  return direction === "up" ? "left" : direction === "down" ? "right" : direction === "right" ? "down" : "up"
}

function parentScrollBox(renderable: ScrollBoxRenderable) {
  let current = renderable.parent
  while (current) {
    if (current instanceof ScrollBoxRenderable) return current
    current = current.parent
  }
}

function MermaidAsciiCard(props: StyledPlanMarkdownProps & { content: string; mermaidSource?: string }) {
  let scroll: ScrollBoxRenderable | undefined
  const [layoutLevel, setLayoutLevel] = createSignal(1)
  const viewportWidth = createMemo(() => Math.max(24, Math.floor(props.width ?? 80)))
  const layoutWidth = createMemo(() => {
    const multiplier = [0.72, 1, 1.5][layoutLevel()] ?? 1
    return Math.max(40, Math.floor(viewportWidth() * multiplier))
  })
  const displayContent = createMemo(() => {
    if (!props.mermaidSource) return props.content.trimEnd()
    const heading = mermaidCardHeading(props.content)
    const card = renderMermaidAsciiCard(props.mermaidSource, layoutWidth())
    return heading ? `${heading}\n\n${card}` : card
  })
  const viewport = createMemo(() => mermaidAsciiCardViewport(displayContent(), viewportWidth()))
  const centeredLines = createMemo(() => {
    const padding = " ".repeat(viewport().centerPadding)
    return viewport().lines.map((line) => `${padding}${line}`)
  })
  const contentWidth = createMemo(() => Math.max(viewport().viewportWidth, viewport().naturalWidth + viewport().centerPadding))
  const scrollHeight = createMemo(() => viewport().viewportRows + (viewport().overflowX ? 1 : 0))
  const center = (includeVertical = true) => {
    if (!scroll || scroll.isDestroyed) return
    scroll.scrollTo({
      x: Math.max(0, Math.floor((scroll.scrollWidth - scroll.viewport.width) / 2)),
      y: includeVertical ? Math.max(0, Math.floor((scroll.scrollHeight - scroll.viewport.height) / 2)) : 0,
    })
  }
  const pan = (direction: -1 | 1) => {
    if (!scroll || scroll.isDestroyed) return
    scroll.scrollBy({ x: direction * Math.max(4, Math.floor(viewportWidth() / 3)), y: 0 })
  }
  const setLevel = (value: number) => {
    setLayoutLevel(Math.max(0, Math.min(2, value)))
  }
  const handleMouseScroll = (event: OpenTuiMouseEvent) => {
    if (!scroll || scroll.isDestroyed) return
    if (mermaidCardConsumesWheel(event, scroll)) event.stopPropagation()
  }
  const routeVerticalWheelToTranscript = (event: OpenTuiMouseEvent) => {
    if (!scroll || scroll.isDestroyed) return
    const direction = effectiveWheelDirection(event)
    if (direction !== "up" && direction !== "down") return
    const transcript = parentScrollBox(scroll)
    if (!transcript || transcript.isDestroyed) return
    event.stopPropagation()
    transcript.processMouseEvent(event)
  }

  createEffect(() => {
    displayContent()
    const timer = setTimeout(() => center(false), 0)
    onCleanup(() => clearTimeout(timer))
  })

  return (
    <box flexDirection="column" width={viewportWidth()} flexShrink={0} overflow="hidden">
      <box width="100%" height={1} flexDirection="row" justifyContent="center" overflow="hidden">
        <Show when={props.mermaidSource}>
          <text fg={props.fg} wrapMode="none" onMouseUp={(event) => { stopMouseEvent(event); setLevel(layoutLevel() - 1) }}>
            [−]
          </text>
          <text fg={props.fg} wrapMode="none" onMouseUp={(event) => { stopMouseEvent(event); setLevel(1) }}>
            {layoutLevel() === 1 ? " [Fit] " : "  Fit  "}
          </text>
          <text fg={props.fg} wrapMode="none" onMouseUp={(event) => { stopMouseEvent(event); setLevel(layoutLevel() + 1) }}>
            [+]
          </text>
        </Show>
        <text fg={props.fg} wrapMode="none" onMouseUp={(event) => { stopMouseEvent(event); pan(-1) }}>
          {"  ◀ "}
        </text>
        <text fg={props.fg} wrapMode="none" onMouseUp={(event) => { stopMouseEvent(event); center() }}>
          Center
        </text>
        <text fg={props.fg} wrapMode="none" onMouseUp={(event) => { stopMouseEvent(event); pan(1) }}>
          {" ▶"}
        </text>
      </box>
      <scrollbox
        ref={(value: ScrollBoxRenderable) => (scroll = value)}
        width={viewport().viewportWidth}
        height={scrollHeight()}
        scrollX
        scrollY
        viewportOptions={{ paddingRight: viewport().overflowY ? 1 : 0 }}
        horizontalScrollbarOptions={{ visible: viewport().overflowX }}
        verticalScrollbarOptions={{ visible: viewport().overflowY }}
        onMouseScroll={handleMouseScroll}
      >
        <box flexDirection="column" width={contentWidth()} flexShrink={0} onMouseScroll={routeVerticalWheelToTranscript}>
          <text fg={props.fg} bg={props.bg} wrapMode="none">
            {centeredLines().join("\n") || " "}
          </text>
        </box>
      </scrollbox>
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

const MARKDOWN_SYNTAX_PATTERN = /(?:^\s{0,3}#{1,6}\s+\S|^\s{0,3}(?:[-*+] |\d+\. )|^\s{0,3}>\s|^\s*```|^\s*\|.*\|\s*$|\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|\[[^\]]+\]\([^)]+\))/m

export function shouldRenderStableTextPlain(content: string, stableTextMode?: boolean) {
  return Boolean(stableTextMode && !MARKDOWN_SYNTAX_PATTERN.test(content))
}

function PlanMarkdownSegment(props: StyledPlanMarkdownProps & { segment: StyledPlanMarkdownSegment; mermaidSource?: string }) {
  return (
    <Switch>
      <Match when={props.segment.kind === "text" && isMermaidAsciiCardContent(props.segment.content)}>
        <MermaidAsciiCard {...props} content={props.segment.content} mermaidSource={props.mermaidSource} />
      </Match>
      <Match when={props.segment.kind === "text" || shouldRenderStableTextPlain(props.segment.content, props.stableTextMode)}>
        <HexStyledLines content={props.segment.content} fallback={props.fg} colorize={props.colorizeHex} width={props.width} />
      </Match>
      <Match when={true}>
        <MarkdownSegment {...props} content={props.segment.content} />
      </Match>
    </Switch>
  )
}

function reuseStableSegments(previous: StyledPlanMarkdownSegment[], next: StyledPlanMarkdownSegment[]) {
  return next.map((segment, index) => {
    const prior = previous[index]
    return prior?.kind === segment.kind && prior.content === segment.content ? prior : segment
  })
}

export function StyledPlanMarkdown(props: StyledPlanMarkdownProps) {
  let previousSegments: StyledPlanMarkdownSegment[] = []
  let previousTailSegments: StyledPlanMarkdownSegment[] = []
  const segments = createMemo(() => {
    previousSegments = reuseStableSegments(previousSegments, styledPlanMarkdownSegments(props.content))
    return previousSegments
  })
  const streamingTail = createMemo(() => props.streamingTail ?? "")
  const streamingTailSegments = createMemo(() => {
    previousTailSegments = reuseStableSegments(previousTailSegments, styledPlanMarkdownSegments(streamingTail()))
    return previousTailSegments
  })
  const mermaidSources = createMemo(() => extractMermaidSources(props.source ?? ""))
  const mermaidSourceFor = (index: number) => {
    const cardIndex = segments().slice(0, index).filter((segment) => segment.kind === "text" && isMermaidAsciiCardContent(segment.content)).length
    return mermaidSources()[cardIndex]
  }

  return (
    <box flexDirection="column" flexShrink={0}>
      <For each={segments()}>
        {(segment, index) => <PlanMarkdownSegment {...props} segment={segment} mermaidSource={mermaidSourceFor(index())} />}
      </For>
      <Show when={streamingTail().length > 0}>
        <Switch>
          <Match when={props.streamingTailMode === "markdown"}>
            <For each={streamingTailSegments()}>
              {(segment) => <PlanMarkdownSegment {...props} segment={segment} colorizeHex={props.streamingTailColorizeHex ?? props.colorizeHex} />}
            </For>
          </Match>
          <Match when={true}>
            <HexStyledLines
              content={streamingTail()}
              fallback={props.fg}
              colorize={props.streamingTailColorizeHex ?? props.colorizeHex}
              width={props.width}
            />
          </Match>
        </Switch>
      </Show>
    </box>
  )
}
