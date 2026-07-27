import { TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { For, Show, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js"
import { useMendTuiProfile } from "../context/mend"
import { useTheme } from "../context/theme"
import { renderAsciiText } from "./ascii-text"
import {
  FIRST_RUN_INTRO_STATIC_MS,
  FIRST_RUN_INTRO_TOTAL_MS,
  firstRunIntroLayout,
  firstRunIntroPhaseAt,
  firstRunIntroWordmarkProgress,
} from "../util/first-run-intro"
import { activityMascotText } from "@/mend/tui/mascot"
import { Locale } from "@/util/locale"

function maxLineWidth(value: string) {
  return value.split("\n").reduce((max, line) => Math.max(max, Bun.stringWidth(line)), 0)
}

function AsciiLines(props: { text: string; color: ReturnType<typeof useTheme>["theme"]["text"] }) {
  return (
    <box flexDirection="column" alignItems="center">
      <For each={props.text.split("\n")}>
        {(line) => <text fg={props.color} wrapMode="none" selectable={false}>{line}</text>}
      </For>
    </box>
  )
}

function Wordmark(props: { text: string; progress: number }) {
  const { theme } = useTheme()
  const cells = createMemo(() => {
    const lines = props.text.split("\n")
    const width = Math.max(1, ...lines.map((line) => Array.from(line).length))
    const revealUntil = Math.ceil(width * Math.max(0, Math.min(1, props.progress)))
    return lines.map((line) =>
      Array.from(line).map((char, index) => ({
        char: char === " " ? " " : index < revealUntil ? char : "·",
        active: char !== " " && index < revealUntil,
      })),
    )
  })

  return (
    <box flexDirection="column" alignItems="center">
      <For each={cells()}>
        {(line) => (
          <box flexDirection="row">
            <For each={line}>
              {(cell) => (
                <text fg={cell.active ? theme.primary : theme.textMuted} wrapMode="none" selectable={false}>
                  {cell.char}
                </text>
              )}
            </For>
          </box>
        )}
      </For>
    </box>
  )
}

export function FirstRunIntro(props: {
  run: number
  animationsEnabled: () => boolean
  handoffLabel?: () => string | undefined
  onComplete: () => void
}) {
  const dimensions = useTerminalDimensions()
  const { theme } = useTheme()
  const mend = useMendTuiProfile()
  const [elapsed, setElapsed] = createSignal(0)
  const productName = createMemo(() => mend.profile.identity.productName.trim() || "MendCode")
  const logoFont = createMemo(() => mend.profile.identity.logoFont || "mendcode")
  const plainTerminal = process.env.TERM === "dumb" || process.env.NO_COLOR !== undefined
  const layout = createMemo(() => (plainTerminal ? "plain" : firstRunIntroLayout(dimensions())))
  const phase = createMemo(() => firstRunIntroPhaseAt(elapsed()))
  const wordmarkProgress = createMemo(() => firstRunIntroWordmarkProgress(elapsed()))
  const fullWordmark = createMemo(() => renderAsciiText(productName(), logoFont()))
  const compactName = createMemo(() => Locale.truncate(productName(), Math.max(8, dimensions().width - 8)))
  const wordmark = createMemo(() => {
    const value = fullWordmark()
    if (maxLineWidth(value) <= Math.max(20, dimensions().width - 8)) return value
    return compactName()
  })
  const mascotState = createMemo(() => {
    if (phase() === "mend") return "patching" as const
    if (phase() === "identity") return "done" as const
    return "idle" as const
  })
  const mascot = createMemo(() => activityMascotText(mend.profile, mascotState()))
  const tagline = createMemo(() => mend.profile.identity.tagline.trim())
  let startedAt = 0
  let timer: ReturnType<typeof setInterval> | undefined
  let staticTimer: ReturnType<typeof setTimeout> | undefined
  let finished = false

  const stop = () => {
    if (timer) {
      clearInterval(timer)
      timer = undefined
    }
    if (staticTimer) {
      clearTimeout(staticTimer)
      staticTimer = undefined
    }
  }

  const finish = () => {
    if (finished) return
    finished = true
    stop()
    props.onComplete()
  }

  const tick = () => {
    const next = performance.now() - startedAt
    setElapsed(Math.min(FIRST_RUN_INTRO_TOTAL_MS, next))
    if (next >= FIRST_RUN_INTRO_TOTAL_MS) finish()
  }

  const restart = () => {
    stop()
    finished = false
    startedAt = performance.now()

    if (!props.animationsEnabled()) {
      setElapsed(1460)
      staticTimer = setTimeout(finish, FIRST_RUN_INTRO_STATIC_MS)
      return
    }

    setElapsed(0)
    timer = setInterval(tick, 16)
  }

  createEffect(on([() => props.run, props.animationsEnabled], restart))
  onCleanup(stop)

  const handoff = createMemo(() => props.handoffLabel?.() || productName().toUpperCase())
  const signal = () => (layout() === "plain" ? "... >" : "·  ·  >")
  const compactLine = createMemo(() => {
    if (phase() === "signal") return `${signal()} ${compactName()}`
    if (phase() === "mascot") return `${compactName()}  ·`
    if (phase() === "mend") {
      const name = compactName()
      const count = Math.max(1, Math.ceil(name.length * wordmarkProgress()))
      return `${name.slice(0, count)}${"·".repeat(Math.max(0, name.length - count))}`
    }
    return compactName()
  })

  return (
    <Show
      when={phase() === "handoff"}
      fallback={
        <box
          position="absolute"
          zIndex={6000}
          left={0}
          top={0}
          width={dimensions().width}
          height={dimensions().height}
          backgroundColor={theme.background}
          justifyContent="center"
          alignItems="center"
          overflow="hidden"
        >
          <Show
            when={layout() === "full"}
            fallback={
              <Show
                when={layout() === "compact"}
                fallback={<text fg={theme.primary} wrapMode="none" selectable={false}>{`${compactLine()}  >  Setup`}</text>}
              >
                <box flexDirection="column" alignItems="center" gap={1}>
                  <Show when={phase() !== "signal" && mascot()}>
                    {(value) => <AsciiLines text={value()} color={theme.text} />}
                  </Show>
                  <text fg={phase() === "identity" ? theme.primary : theme.textMuted} wrapMode="none" selectable={false}>
                    {`${compactLine()}  >  Setup`}
                  </text>
                </box>
              </Show>
            }
          >
            <box flexDirection="column" alignItems="center" gap={1}>
              <Show when={phase() !== "signal" && mascot()}>
                {(value) => <AsciiLines text={value()} color={theme.text} />}
              </Show>
              <Show when={phase() === "signal"}>
                <text fg={theme.textMuted} wrapMode="none" selectable={false}>{signal()}</text>
              </Show>
              <Show when={phase() === "mend" || phase() === "identity"}>
                <Wordmark text={wordmark()} progress={phase() === "identity" ? 1 : wordmarkProgress()} />
              </Show>
              <Show when={phase() === "identity" && tagline()}>
                <text fg={theme.textMuted} wrapMode="none" selectable={false}>{tagline()}</text>
              </Show>
            </box>
          </Show>
        </box>
      }
    >
      <box
        position="absolute"
        zIndex={6000}
        left={0}
        top={1}
        width={dimensions().width}
        height={1}
        paddingLeft={1}
        paddingRight={1}
        flexDirection="row"
        overflow="hidden"
      >
        <text fg={theme.primary} attributes={TextAttributes.BOLD} wrapMode="none" selectable={false}>
          {handoff()}
        </text>
      </box>
    </Show>
  )
}
