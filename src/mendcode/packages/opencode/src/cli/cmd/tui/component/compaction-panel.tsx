import { createEffect, createMemo, createSignal, For, onCleanup, Show, type JSX } from "solid-js"
import type { BoxRenderable, MouseEvent, TextareaRenderable } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { SplitBorder } from "./border"
import { useTheme } from "../context/theme"
import { useMendTuiProfile } from "../context/mend"
import { useTextareaKeybindings } from "./textarea-keybindings"
import { Locale } from "@/util/locale"
import { errorMessage } from "@/util/error"
import { compactionArcadeFrames, compactionStageStates } from "@/mend/tui/presentation"

type SnakeDirection = "up" | "down" | "left" | "right"
type SnakePoint = { x: number; y: number }
type SnakeState = {
  body: SnakePoint[]
  food: SnakePoint
  direction: SnakeDirection
  pendingDirection: SnakeDirection
  score: number
  highScore: number
  alive: boolean
  paused: boolean
}

export type CompactionArcadeKeyEvent = {
  name: string
  sequence?: string
  preventDefault: () => void
  stopPropagation?: () => void
}

export type CompactionArcadeCellTone = "primary" | "muted" | "text" | "wall" | "empty" | "head" | "body" | "food" | "danger" | "accent"

export type CompactionArcadeCell = {
  text: string
  tone?: CompactionArcadeCellTone
}

export type CompactionArcadeRender = {
  title?: string
  status?: string
  lines?: string[]
  cells?: CompactionArcadeCell[][]
}

export type CompactionArcadeGame = {
  id: string
  label: string
  intervalMs?: number
  initialState: () => unknown
  tick?: (state: unknown) => unknown
  key?: (state: unknown, key: string) => unknown | undefined
  render: (state: unknown) => CompactionArcadeRender
}

const snakeSize = 16
const snakeWidth = snakeSize
const snakeHeight = snakeSize
const snakeCellWidth = 2

function sameSnakePoint(a: SnakePoint, b: SnakePoint) {
  return a.x === b.x && a.y === b.y
}

function oppositeSnakeDirection(a: SnakeDirection, b: SnakeDirection) {
  return (a === "up" && b === "down") || (a === "down" && b === "up") || (a === "left" && b === "right") || (a === "right" && b === "left")
}

function randomSnakeInt(max: number) {
  return Math.floor(Math.random() * max)
}

function randomSnakeRange(min: number, max: number) {
  return min + randomSnakeInt(Math.max(1, max - min + 1))
}

function snakeDelta(direction: SnakeDirection): SnakePoint {
  if (direction === "up") return { x: 0, y: -1 }
  if (direction === "down") return { x: 0, y: 1 }
  if (direction === "left") return { x: -1, y: 0 }
  return { x: 1, y: 0 }
}

function randomSnakeDirection(): SnakeDirection {
  return (["up", "down", "left", "right"] as const)[randomSnakeInt(4)] ?? "right"
}

function randomSnakeHead(direction: SnakeDirection): SnakePoint {
  const minCross = 3
  const maxCross = snakeSize - 4
  const minForward = 5
  const maxForward = snakeSize - 6
  if (direction === "right") return { x: randomSnakeRange(minCross, maxForward), y: randomSnakeRange(minCross, maxCross) }
  if (direction === "left") return { x: randomSnakeRange(minForward, maxCross), y: randomSnakeRange(minCross, maxCross) }
  if (direction === "down") return { x: randomSnakeRange(minCross, maxCross), y: randomSnakeRange(minCross, maxForward) }
  return { x: randomSnakeRange(minCross, maxCross), y: randomSnakeRange(minForward, maxCross) }
}

function initialSnakeState(highScore = 0): SnakeState {
  const direction = randomSnakeDirection()
  const head = randomSnakeHead(direction)
  const delta = snakeDelta(direction)
  const body = [head, { x: head.x - delta.x, y: head.y - delta.y }, { x: head.x - delta.x * 2, y: head.y - delta.y * 2 }]
  return {
    body,
    food: nextSnakeFood(body),
    direction,
    pendingDirection: direction,
    score: 0,
    highScore,
    alive: true,
    paused: false,
  }
}

function normalizedArcadeKey(name: string, sequence?: string) {
  if (sequence === "\u001b[A") return "up"
  if (sequence === "\u001b[B") return "down"
  if (sequence === "\u001b[C") return "right"
  if (sequence === "\u001b[D") return "left"
  const key = name.toLowerCase().replace(/^arrow/, "")
  if (key === " " || key === "spacebar") return "space"
  if (key === "esc") return "escape"
  return key
}

function snakeDirectionFromKey(name: string): SnakeDirection | undefined {
  const key = normalizedArcadeKey(name)
  if (key === "up" || key === "w") return "up"
  if (key === "down" || key === "s") return "down"
  if (key === "left" || key === "a") return "left"
  if (key === "right" || key === "d") return "right"
  return undefined
}

function nextSnakeFood(body: SnakePoint[]): SnakePoint {
  const open = Array.from({ length: snakeWidth * snakeHeight }, (_, index) => ({
    x: index % snakeWidth,
    y: Math.floor(index / snakeWidth),
  })).filter((point) => !body.some((item) => sameSnakePoint(item, point)))
  return open[randomSnakeInt(open.length)] ?? { x: 0, y: 0 }
}

function advanceSnake(state: SnakeState): SnakeState {
  if (!state.alive || state.paused) return state
  const direction = state.pendingDirection
  const head = state.body[0] ?? { x: 0, y: 0 }
  const nextHead =
    direction === "up"
      ? { x: head.x, y: head.y - 1 }
      : direction === "down"
        ? { x: head.x, y: head.y + 1 }
        : direction === "left"
          ? { x: head.x - 1, y: head.y }
          : { x: head.x + 1, y: head.y }
  const eating = sameSnakePoint(nextHead, state.food)
  const collisionBody = eating ? state.body : state.body.slice(0, -1)
  if (
    nextHead.x < 0 ||
    nextHead.y < 0 ||
    nextHead.x >= snakeWidth ||
    nextHead.y >= snakeHeight ||
    collisionBody.some((point) => sameSnakePoint(point, nextHead))
  ) {
    return { ...state, direction, alive: false, highScore: Math.max(state.highScore, state.score) }
  }
  const body = eating ? [nextHead, ...state.body] : [nextHead, ...state.body.slice(0, -1)]
  const score = eating ? state.score + 1 : state.score
  return {
    ...state,
    body,
    direction,
    score,
    highScore: Math.max(state.highScore, score),
    food: eating ? nextSnakeFood(body) : state.food,
  }
}

function turnSnake(state: SnakeState, direction: SnakeDirection): SnakeState {
  if (!state.alive) return state
  if (oppositeSnakeDirection(state.direction, direction)) return state
  return { ...state, pendingDirection: direction, paused: false }
}

function snakeRenderCell(text: string, tone: CompactionArcadeCellTone): CompactionArcadeCell {
  return { text: text.padEnd(snakeCellWidth, " ").slice(0, snakeCellWidth), tone }
}

function renderSnakeCells(state: SnakeState): CompactionArcadeCell[][] {
  const rows: CompactionArcadeCell[][] = [[{ text: "╭" + "─".repeat(snakeWidth * snakeCellWidth) + "╮", tone: "wall" }]]
  for (let y = 0; y < snakeHeight; y++) {
    rows.push([
      { text: "│", tone: "wall" },
      ...Array.from({ length: snakeWidth }, (_, x) => {
          const point = { x, y }
          if (sameSnakePoint(state.body[0] ?? { x: -1, y: -1 }, point)) return snakeRenderCell("◉", "head")
          if (state.body.slice(1).some((item) => sameSnakePoint(item, point))) return snakeRenderCell("●", "body")
          if (sameSnakePoint(state.food, point)) return snakeRenderCell("◆", "food")
          return snakeRenderCell("·", "empty")
        }),
      { text: "│", tone: "wall" },
    ])
  }
  rows.push([{ text: "╰" + "─".repeat(snakeWidth * snakeCellWidth) + "╯", tone: "wall" }])
  return rows
}

const snakeArcadeGame: CompactionArcadeGame = {
  id: "snake",
  label: "Snake",
  intervalMs: 150,
  initialState: () => initialSnakeState(),
  tick: (state) => advanceSnake(state as SnakeState),
  key: (state, name) => {
    const snake = state as SnakeState
    const key = normalizedArcadeKey(name)
    const direction = snakeDirectionFromKey(key)
    if (direction) return turnSnake(snake, direction)
    if (key === "space") return snake.alive ? { ...snake, paused: !snake.paused } : snake
    if (key === "r") return initialSnakeState(snake.highScore)
    return undefined
  },
  render: (state) => {
    const snake = state as SnakeState
    return {
      title: `Snake · Score ${snake.score} · Best ${snake.highScore}`,
      status: snake.alive ? (snake.paused ? "Paused" : "Focused controls active") : "Crash. Press R to reset.",
      cells: renderSnakeCells(snake),
    }
  },
}

const compactionArcadeGameRegistry = new Map<string, CompactionArcadeGame>([[snakeArcadeGame.id, snakeArcadeGame]])

export function registerCompactionArcadeGame(game: CompactionArcadeGame) {
  if (!game.id.trim()) throw new Error("Compaction arcade game id is required")
  compactionArcadeGameRegistry.set(game.id, game)
  return true
}

export function unregisterCompactionArcadeGame(id: string) {
  if (id === snakeArcadeGame.id) return false
  return compactionArcadeGameRegistry.delete(id)
}

export function registeredCompactionArcadeGame(id: string) {
  return compactionArcadeGameRegistry.get(id)
}

export function CompactionPanel(props: {
  reason: "auto" | "manual"
  overflow?: boolean
  resume?: boolean
  postPrompt?: string
  include?: string
  tailStartID?: string
  hasSummaryBody?: boolean
  summaryPreview?: string
  transcriptPreview?: string
  summaryContent?: JSX.Element
  modelOutputText?: string
  modelReasoningText?: string
  modelDetailLabel?: string
  scratchpad?: {
    key: string
    initialValue?: string
    loading?: boolean
    readOnly?: boolean
    onSave?: (value: string) => Promise<void>
    note?: string
  }
}) {
  const { theme } = useTheme()
  const mend = useMendTuiProfile()
  const textareaKeybindings = useTextareaKeybindings()
  const config = createMemo(() => mend.profile.presentation.compaction)
  const stages = createMemo(() =>
    compactionStageStates({
      hasSummary: props.hasSummaryBody,
      resume: props.resume,
      postPrompt: props.postPrompt,
      include: props.include,
      tailStartID: props.tailStartID,
    }),
  )
  const chips = createMemo(() =>
    [
      props.reason,
      props.overflow ? "overflow" : undefined,
      props.resume ? "resume" : undefined,
      props.tailStartID ? "preserved tail" : undefined,
      props.include ? "transcript kept" : undefined,
    ].filter((value): value is string => Boolean(value)),
  )
  const [arcadeTick, setArcadeTick] = createSignal(0)
  const [arcadeFocused, setArcadeFocused] = createSignal(false)
  const [arcadeState, setArcadeState] = createSignal<unknown>(snakeArcadeGame.initialState())
  const activeArcadeGame = createMemo(() => registeredCompactionArcadeGame(config().arcade))
  const arcadeRender = createMemo(() => activeArcadeGame()?.render(arcadeState()))
  const arcadeFrame = createMemo(() => {
    if (config().arcade === "off" || activeArcadeGame()) return []
    const frames = compactionArcadeFrames(config().arcade)
    const frame = frames[arcadeTick() % Math.max(1, frames.length)]
    return frame ? [frame] : []
  })

  const scratchpadEnabled = createMemo(() => config().allowScratchpad && Boolean(props.scratchpad))
  const scratchpadReadOnly = createMemo(() => Boolean(props.scratchpad?.readOnly))
  const followUpText = createMemo(() => (props.scratchpad?.initialValue ?? props.postPrompt ?? "").trim())
  const tailDetail = createMemo(() =>
    props.tailStartID
      ? `tail: ${Locale.truncate(props.tailStartID, 28)}`
      : props.include
        ? `tail: ${Locale.truncate(props.include, 32)}`
        : undefined,
  )
  const compactionDetails = createMemo(() =>
    [
      props.hasSummaryBody ? "packed" : "packing",
      props.reason,
      props.overflow ? "overflow" : undefined,
      tailDetail(),
      props.resume ? "resume" : undefined,
      followUpText() ? "follow-up saved" : undefined,
    ]
      .filter((value): value is string => Boolean(value))
      .join(" · "),
  )
  const modelOutputText = createMemo(() => props.modelOutputText?.trim())
  const modelReasoningText = createMemo(() => props.modelReasoningText?.trim())
  const modelDetailAvailable = createMemo(() => Boolean(modelOutputText() || modelReasoningText()))
  const [modelDetailExpanded, setModelDetailExpanded] = createSignal(false)
  const [draft, setDraft] = createSignal(props.scratchpad?.initialValue ?? "")
  const [saved, setSaved] = createSignal(props.scratchpad?.initialValue ?? "")
  const [saveState, setSaveState] = createSignal<"saved" | "pending" | "saving" | "local" | "error">(
    props.scratchpad?.onSave ? "saved" : "local",
  )
  const [saveFailure, setSaveFailure] = createSignal<string>()
  let scratchpadInput: TextareaRenderable | undefined
  let arcadeBox: BoxRenderable | undefined
  let lastScratchpadKey: string | undefined
  let lastArcadeGameID: string | undefined
  let saveTimer: ReturnType<typeof setTimeout> | undefined
  let saveTicket = 0

  function focusArcade() {
    if (!activeArcadeGame()) return
    setArcadeFocused(true)
    arcadeBox?.focus()
  }

  function blurArcade(event?: { preventDefault?: () => void; stopPropagation?: () => void }, input?: { consume?: boolean }) {
    setArcadeFocused(false)
    arcadeBox?.blur()
    if (input?.consume === false) return
    event?.preventDefault?.()
    event?.stopPropagation?.()
  }

  function consumeMouseEvent(event?: { preventDefault?: () => void; stopPropagation?: () => void }) {
    event?.preventDefault?.()
    event?.stopPropagation?.()
  }

  function arcadeCellColor(tone: CompactionArcadeCellTone | undefined) {
    if (tone === "head") return theme.success
    if (tone === "food") return theme.warning
    if (tone === "body") return theme.primary
    if (tone === "wall") return theme.borderActive
    if (tone === "empty" || tone === "muted") return theme.textMuted
    if (tone === "danger") return theme.error
    if (tone === "accent") return theme.accent
    if (tone === "text") return theme.text
    return theme.primary
  }

  function handleArcadeKey(event: CompactionArcadeKeyEvent) {
    const game = activeArcadeGame()
    if (!game) return false
    const key = normalizedArcadeKey(event.name, event.sequence)
    if (key === "escape") {
      blurArcade(event)
      return true
    }
    const next = game.key?.(arcadeState(), key)
    if (next === undefined) return false
    setArcadeState(next)
    event.preventDefault()
    event.stopPropagation?.()
    return true
  }

  createEffect(() => {
    if (config().arcade === "off") return
    const timer = setInterval(() => {
      const game = activeArcadeGame()
      if (game) {
        if (!arcadeFocused()) return
        setArcadeState((state) => game.tick?.(state) ?? state)
      }
      else setArcadeTick((value) => value + 1)
    }, activeArcadeGame()?.intervalMs ?? 240)
    onCleanup(() => clearInterval(timer))
  })

  createEffect(() => {
    const game = activeArcadeGame()
    const id = game?.id
    if (id === lastArcadeGameID) return
    lastArcadeGameID = id
    setArcadeFocused(false)
    if (game) setArcadeState(game.initialState())
  })

  useKeyboard((event) => {
    if (!arcadeFocused()) return
    if (scratchpadInput && !scratchpadInput.isDestroyed && scratchpadInput.focused) return
    if (handleArcadeKey(event)) return
    event.preventDefault()
    event.stopPropagation?.()
  })

  createEffect(() => {
    const scratchpad = props.scratchpad
    if (!scratchpadEnabled() || !scratchpad) return
    const key = scratchpad.key
    const initialValue = scratchpad.initialValue ?? ""
    if (key !== lastScratchpadKey) {
      lastScratchpadKey = key
      setDraft(initialValue)
      setSaved(initialValue)
      setSaveState(scratchpad.onSave ? "saved" : "local")
      setSaveFailure(undefined)
      if (scratchpadInput && !scratchpadInput.isDestroyed && scratchpadInput.plainText !== initialValue) scratchpadInput.setText(initialValue)
      return
    }
    if (scratchpad.loading) return
    if (draft() !== saved()) return
    if (saved() === initialValue) return
    setDraft(initialValue)
    setSaved(initialValue)
    setSaveState(scratchpad.onSave ? "saved" : "local")
    setSaveFailure(undefined)
    if (scratchpadInput && !scratchpadInput.isDestroyed && scratchpadInput.plainText !== initialValue) scratchpadInput.setText(initialValue)
  })

  createEffect(() => {
    const scratchpad = props.scratchpad
    const value = draft()
    if (!scratchpadEnabled() || !scratchpad) return
    if (scratchpadReadOnly()) return
    if (scratchpad.loading) return
    if (!scratchpad.onSave) {
      setSaveState("local")
      return
    }
    if (value === saved()) {
      if (saveState() === "pending" || saveState() === "saving") setSaveState("saved")
      return
    }
    if (saveTimer) clearTimeout(saveTimer)
    setSaveState("pending")
    const ticket = ++saveTicket
    saveTimer = setTimeout(async () => {
      setSaveState("saving")
      try {
        await scratchpad.onSave?.(value)
        if (ticket !== saveTicket) return
        setSaved(value)
        setSaveState("saved")
        setSaveFailure(undefined)
      } catch (error) {
        if (ticket !== saveTicket) return
        setSaveState("error")
        setSaveFailure(errorMessage(error))
      }
    }, 500)
    onCleanup(() => {
      if (saveTimer) clearTimeout(saveTimer)
    })
  })

  const scratchpadStatus = createMemo(() => {
    const scratchpad = props.scratchpad
    if (!scratchpadEnabled() || !scratchpad) return undefined
    if (scratchpad.loading) return "Loading scratchpad…"
    if (scratchpadReadOnly()) return followUpText() ? "Follow-up was sent after compaction." : undefined
    if (saveState() === "saving" || saveState() === "pending") return "Saving scratchpad…"
    if (saveState() === "error") return `Scratchpad save failed · ${saveFailure() ?? "Unknown error"}`
    if (!scratchpad.onSave) return scratchpad.note ?? "Scratchpad is local only in this view"
    return scratchpad.note ?? "Scratchpad saved to the compaction resume prompt"
  })

  if (config().style === "quiet") {
    return <box marginTop={1} border={["top"]} title=" Packing context " titleAlignment="center" borderColor={theme.borderActive} />
  }

  if (config().style === "minimal") {
    return (
      <box
        marginTop={1}
        paddingLeft={2}
        paddingRight={2}
        paddingTop={1}
        paddingBottom={1}
        border={["top"]}
        customBorderChars={SplitBorder.customBorderChars}
        borderColor={theme.borderActive}
        backgroundColor={theme.backgroundPanel}
        flexShrink={0}
      >
        <text fg={theme.text} wrapMode="none">
          <span style={{ fg: theme.borderActive, bold: true }}>◈</span> Packing context
        </text>
        <text fg={theme.textMuted} wrapMode="none">
          {props.hasSummaryBody ? "Context packed." : "Preparing a shorter context…"}
        </text>
      </box>
    )
  }

  return (
    <box
      marginTop={1}
      paddingLeft={2}
      paddingRight={2}
      paddingTop={1}
      paddingBottom={1}
      border={config().style === "minimal" ? ["top"] : ["top", "bottom"]}
      customBorderChars={SplitBorder.customBorderChars}
      borderColor={theme.borderActive}
      backgroundColor={theme.backgroundPanel}
      flexShrink={0}
    >
      <box width="100%">
        <text fg={theme.text} wrapMode="none">
          <span style={{ fg: theme.borderActive, bold: true }}>◈</span> Packing context
        </text>
      </box>
      <Show when={chips().length > 0}>
        <box flexDirection="row" gap={1} flexWrap="wrap" paddingTop={1}>
          <For each={chips()}>
            {(chip) => (
              <text fg={theme.text}>
                <span style={{ bg: theme.backgroundElement, fg: theme.textMuted }}> {chip} </span>
              </text>
            )}
          </For>
        </box>
      </Show>
      <Show when={config().showProgress}>
        <box flexDirection="row" gap={1} paddingTop={1} flexWrap="wrap">
          <For each={stages()}>
            {(stage, index) => {
              const color = createMemo(() => {
                if (stage.state === "done") return theme.borderActive
                if (stage.state === "active") return theme.primary
                return theme.textMuted
              })
              const glyph = createMemo(() => {
                if (stage.state === "done") return "●"
                if (stage.state === "active") return "◐"
                return "○"
              })
              return (
                <text fg={theme.textMuted} wrapMode="none">
                  <span style={{ fg: color() }}>{glyph()} {stage.label}</span>
                  <Show when={index() < stages().length - 1}>
                    <span style={{ fg: theme.textMuted }}> ─ </span>
                  </Show>
                </text>
              )
            }}
          </For>
        </box>
      </Show>
      <box paddingTop={1} flexDirection="column" border={["top"]} borderColor={theme.border} paddingLeft={1} paddingRight={1}>
        <text fg={theme.textMuted} wrapMode="none">
          Compacted memory · {props.hasSummaryBody ? "packed" : "packing"}
        </text>
        <Show
          when={props.hasSummaryBody}
          fallback={<text fg={theme.textMuted} wrapMode="none">Writing summary…</text>}
        >
          <Show when={props.summaryContent} fallback={<text fg={theme.text} wrapMode="word">{props.summaryPreview ? Locale.truncate(props.summaryPreview ?? "", 220) : "Summary output is not available yet."}</text>}>
            {props.summaryContent}
          </Show>
        </Show>
        <Show when={!props.hasSummaryBody && props.transcriptPreview && !activeArcadeGame()}>
          <text fg={theme.textMuted} wrapMode="word">Focus: {Locale.truncate(props.transcriptPreview ?? "", 120)}</text>
        </Show>
      </box>
      <Show when={activeArcadeGame() && arcadeRender()}>
        <box paddingTop={1} width="100%" flexDirection="column" alignItems="center">
          <box
            ref={(value: BoxRenderable) => {
              arcadeBox = value
            }}
            flexDirection="column"
            alignItems="center"
            border={["top", "bottom", "left", "right"]}
            borderColor={arcadeFocused() ? theme.borderActive : theme.border}
            paddingLeft={2}
            paddingRight={2}
            paddingTop={1}
            paddingBottom={1}
            onMouseDown={(event) => {
              focusArcade()
              event.preventDefault()
              event.stopPropagation()
            }}
            onKeyDown={(event) => {
              if (handleArcadeKey(event)) return
              event.preventDefault()
              event.stopPropagation?.()
            }}
          >
            <text fg={arcadeFocused() ? theme.primary : theme.textMuted} wrapMode="none">
              {arcadeFocused() ? "● GAME FOCUSED · Press Esc to type in chat" : "○ Click game to play · chat keeps typing until game is focused"}
            </text>
            <text fg={theme.textMuted} wrapMode="none">
              {arcadeRender()?.title} · ↑↓←→/WASD · Space pause · R reset
            </text>
            <For each={arcadeRender()?.cells ?? []}>
              {(row) => (
                <text wrapMode="none">
                  <For each={row}>{(cell) => <span style={{ fg: arcadeCellColor(cell.tone) }}>{cell.text}</span>}</For>
                </text>
              )}
            </For>
            <For each={arcadeRender()?.lines ?? []}>{(line) => <text fg={theme.primary} wrapMode="none">{line}</text>}</For>
            <Show when={arcadeRender()?.status}>
              {(status) => <text fg={status().startsWith("Crash") ? theme.error : theme.textMuted} wrapMode="none">{status()}</text>}
            </Show>
          </box>
        </box>
      </Show>
      <Show when={arcadeFrame().length > 0}>
        <box paddingTop={1} flexDirection="column">
          <For each={arcadeFrame()}>{(line) => <text fg={theme.primary}>{line}</text>}</For>
        </box>
      </Show>
      <Show when={scratchpadEnabled() && props.scratchpad && (!scratchpadReadOnly() || followUpText())}>
        <box paddingTop={1} flexDirection="column" border={["top"]} borderColor={theme.border} paddingLeft={1} paddingRight={1}>
          <text fg={theme.textMuted} wrapMode="none">
            {scratchpadReadOnly() ? "Follow-up" : "Scratchpad · click to focus"}
          </text>
          <Show
            when={!scratchpadReadOnly()}
            fallback={
              <text fg={followUpText() ? theme.text : theme.textMuted} wrapMode="word">
                {followUpText() ? Locale.truncate(followUpText(), 220) : "No follow-up message was written."}
              </text>
            }
          >
            <textarea
              ref={(value: TextareaRenderable) => {
                scratchpadInput = value
              }}
              minHeight={1}
              maxHeight={3}
              initialValue={draft()}
              placeholder="Write the follow-up to send after compaction…"
              placeholderColor={theme.textMuted}
              textColor={theme.text}
              focusedTextColor={theme.text}
              cursorColor={theme.text}
              keyBindings={textareaKeybindings()}
              onMouseDown={(_event: MouseEvent) => scratchpadInput?.focus()}
              onContentChange={() => {
                if (!scratchpadInput || scratchpadInput.isDestroyed) return
                setDraft(scratchpadInput.plainText)
              }}
            />
          </Show>
          <Show when={scratchpadStatus()}>
            <text fg={saveState() === "error" ? theme.error : theme.textMuted} wrapMode="none">{scratchpadStatus()}</text>
          </Show>
        </box>
      </Show>
      <Show when={modelDetailAvailable()}>
        <box paddingTop={1} flexDirection="column" border={["top"]} borderColor={theme.border} paddingLeft={1} paddingRight={1} onMouseDown={consumeMouseEvent} onMouseUp={consumeMouseEvent}>
          <text
            fg={theme.textMuted}
            wrapMode="none"
            onMouseUp={(event) => {
              consumeMouseEvent(event)
              setModelDetailExpanded((value) => !value)
            }}
          >
            {modelDetailExpanded() ? "▾ hide model reasoning/output" : "▸ show model reasoning/output"}
            <Show when={props.modelDetailLabel}>
              {(label) => <span style={{ fg: theme.textMuted }}> · {label()}</span>}
            </Show>
          </text>
          <Show when={modelDetailExpanded()}>
            <box paddingTop={1} flexDirection="column" border={["left"]} borderColor={theme.border} paddingLeft={1}>
              <Show when={modelReasoningText()}>
                {(reasoning) => (
                  <box flexDirection="column" paddingBottom={1}>
                    <text fg={theme.textMuted} wrapMode="none">Reasoning returned by compaction model</text>
                    <text fg={theme.text} wrapMode="char">{reasoning()}</text>
                  </box>
                )}
              </Show>
              <Show when={modelOutputText()}>
                {(output) => (
                  <box flexDirection="column">
                    <text fg={theme.textMuted} wrapMode="none">Output text returned by compaction model</text>
                    <text fg={theme.text} wrapMode="char">{output()}</text>
                  </box>
                )}
              </Show>
            </box>
          </Show>
        </box>
      </Show>
    </box>
  )
}
