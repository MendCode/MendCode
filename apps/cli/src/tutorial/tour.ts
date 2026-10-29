import type { Tier } from "@mendcode/protocol/wire"
import type { Bindings } from "../ui/keymap"
import { keyText } from "../ui/key-labels"
import type { Glyphs } from "../ui/theme"
import type { TuiProfile } from "../view/tui-profile"
import type { PresentationMode } from "../view/transcript"
import { KEY, keysFor, lessonsFor, type Flag, type Lesson, type Signals } from "./lessons"
import type { TutorialStats } from "./engine"
import type { Sandbox, SandboxOptions } from "./sandbox"

/**
 * The tour: which lesson is current, how many of its steps the practice chat has really done, and the keys that move
 * between lessons. It watches the practice chat (the commands it sent, the pages it showed, its prompt) after every key
 * and every engine event, so a lesson completes when the thing happened, and never because time passed.
 */
/** Columns of the lesson rail, and the terminal width from which it stands beside the practice chat instead of above it. */
export const RAIL_WIDTH = 36
export const WIDE_TUTORIAL = 110
/** The right panel needs this many columns in the practice chat to stand beside the chat (narrower, it covers it). */
const PANEL_COLUMNS = 110
export const RAIL = { next: "\x1bn", back: "\x1bb", skip: "\x1bs", show: "\x1bm", leave: "\x1bq", leaveAlt: "\x11" } as const
export const RAIL_NAMES = { next: "alt+n", back: "alt+b", skip: "alt+s", show: "alt+m", leave: "alt+q" } as const
/** The rail's keys as the user reads them (Option on a Mac); `RAIL_NAMES` stays canonical. */
export const railNames = (): { [K in keyof typeof RAIL_NAMES]: string } => ({ next: keyText(RAIL_NAMES.next), back: keyText(RAIL_NAMES.back), skip: keyText(RAIL_NAMES.skip), show: keyText(RAIL_NAMES.show), leave: keyText(RAIL_NAMES.leave) })

export type TourOptions = {
  bindings: Bindings
  tier: Tier | undefined
  /** The user's terminal look, the practice chat's starting point. */
  profile: TuiProfile
  glyphs: Glyphs
  mode: PresentationMode
  reducedMotion: boolean
  accessible: boolean
  /** Cells the practice chat gets, to decide which lessons the terminal can show. */
  width: number
  done: readonly string[]
  /** `/tutorial all`: every lesson, whatever the tier or terminal. */
  all?: boolean
  /** The user's tier and view for the practice chat. */
  settings?: Record<string, unknown>
  now(): number
  /** The practice chat changed on its own (a streamed answer): repaint. */
  onChange(): void
  onExit(): void
  /** Lessons finished or skipped, saved so `/tutorial` resumes. */
  onProgress(done: string[]): void
  makeSandbox(options: SandboxOptions): Sandbox
  /** Pause for `show me`; tests pass an instant one. */
  sleep?(ms: number): Promise<void>
  /** Pause between the pieces of a scripted answer; tests pass a short one. */
  engineSleep?: SandboxOptions["sleep"]
  /** Waits at most this long for the chat to do something during `show me`. */
  waitMs?: number
  lessons?: readonly Lesson[]
}

export type StepView = { label: string; done: boolean }
export type TourView = {
  lessons: Array<{ id: string; title: string; state: "done" | "skipped" | "current" | "todo" }>
  index: number
  total: number
  /** Lessons done or skipped. */
  finished: number
  lesson: Lesson | undefined
  steps: StepView[]
  complete: boolean
  hint: string
  echo: string
  ended: boolean
  note: string
}

const ARROWS = new Set<string>([KEY.up, KEY.down, KEY.left, KEY.right, "\x1bOA", "\x1bOB", "\x1bOC", "\x1bOD"])

export function createTour(options: TourOptions) {
  const lessons = lessonsFor({ tier: options.tier, wide: (options.width >= WIDE_TUTORIAL ? options.width - RAIL_WIDTH - 1 : options.width) >= PANEL_COLUMNS, panel: options.tier !== "minimalist", all: options.all === true }, options.lessons)
  const doneIds = new Set(options.done.filter((id) => lessons.some((lesson) => lesson.id === id)))
  const skippedIds = new Set<string>()
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  // A finished tour starts again from the first lesson; it only ends by going past the last one.
  if (lessons.length > 0 && lessons.every((lesson) => doneIds.has(lesson.id))) doneIds.clear()
  let index = Math.max(0, lessons.findIndex((lesson) => !doneIds.has(lesson.id)))
  let ended = lessons.length === 0
  let stepsDone = 0
  let echo = ""
  let note = ""
  let showing = false
  let disposed = false
  const flags = new Set<Flag>()
  const pages = new Set<string>()
  let sentStart = 0
  let statsStart: TutorialStats = { turnsStarted: 0, turnsCompleted: 0, cancelled: 0, resolved: [], queued: 0, created: 0, undone: 0, model: "", effort: "" }
  let lookAtStart = ""
  /** The panel's cards when it opened in this lesson: opening it already shows a preset, so "change the preset" is measured from there. */
  let widgetsAtOpen: string | undefined
  let sessionAtStart = ""
  let discardedText = ""
  /** Nothing has been said in the practice chat yet, so the first lesson needs no new chat. */
  let fresh = true

  const sandbox = options.makeSandbox({
    width: 60, height: 20, glyphs: options.glyphs, profile: { ...options.profile }, mode: options.mode, reducedMotion: options.reducedMotion, accessible: options.accessible, now: options.now, bindings: options.bindings, ...(options.engineSleep ? { sleep: options.engineSleep } : {}), ...(options.settings ? { settings: options.settings } : {}),
    onFrame: () => { evaluate(); options.onChange() },
    onExit: () => options.onExit(),
  })
  const engine = sandbox.engine
  engine.onChange(() => { evaluate(); options.onChange() })

  const profileNow = () => sandbox.app.accessibility.profile
  const look = () => JSON.stringify({ ...profileNow(), tutorialDone: "" })
  const widgets = () => JSON.stringify(profileNow().sidebarWidgets)
  const delta = (): TutorialStats => ({
    ...engine.stats,
    turnsStarted: engine.stats.turnsStarted - statsStart.turnsStarted,
    turnsCompleted: engine.stats.turnsCompleted - statsStart.turnsCompleted,
    cancelled: engine.stats.cancelled - statsStart.cancelled,
    resolved: engine.stats.resolved.slice(statsStart.resolved.length),
    queued: engine.stats.queued - statsStart.queued,
    created: engine.stats.created - statsStart.created,
    undone: engine.stats.undone - statsStart.undone,
  })
  const signals = (): Signals => ({
    sent: engine.sent.slice(sentStart), pages, page: sandbox.app.page, editor: sandbox.app.editor.text, stats: delta(), busy: engine.busy, asking: engine.asking,
    edited: engine.edited, flags, look: look(), lookAtStart, rightBar: profileNow().rightSidebar, widgets: widgets(), widgetsAtOpen: widgetsAtOpen ?? widgets(), session: sandbox.app.sessionId, sessionAtStart,
  })

  function current(): Lesson | undefined { return ended ? undefined : lessons[index] }

  /** Looks at the practice chat and advances the steps it has really completed. */
  function evaluate() {
    if (disposed) return
    const lesson = current()
    if (!lesson) return
    pages.add(sandbox.app.page)
    if (profileNow().rightSidebar && widgetsAtOpen === undefined) widgetsAtOpen = widgets()
    if (!profileNow().rightSidebar) widgetsAtOpen = undefined
    if (engine.asking === "approval") flags.add("sawApproval")
    if (engine.asking === "question") flags.add("sawQuestion")
    if (engine.busy) flags.add("sawBusy")
    const now = signals()
    while (stepsDone < lesson.steps.length && lesson.steps[stepsDone]!.done(now)) stepsDone += 1
    if (stepsDone >= lesson.steps.length && !doneIds.has(lesson.id)) {
      doneIds.add(lesson.id)
      note = "done"
      options.onProgress([...doneIds, ...skippedIds])
    }
  }

  async function typeLine(text: string) {
    for (const char of text) await sandbox.key(char)
    await sandbox.key(KEY.enter)
  }

  async function backToChat() {
    for (let attempt = 0; attempt < 4 && sandbox.app.page !== "chat"; attempt++) await sandbox.key(KEY.esc)
  }

  async function begin(next: number) {
    index = Math.max(0, Math.min(lessons.length, next))
    if (index >= lessons.length) { ended = true; note = ""; return }
    ended = false
    const lesson = lessons[index]!
    stepsDone = 0
    note = ""
    echo = ""
    flags.clear()
    pages.clear()
    if (engine.busy) engine.interrupt()
    await engine.quiet(async () => {
      await backToChat()
      sandbox.app.editor.replaceAll("")
      engine.resetWorkspace()
      // Each lesson starts on a clean chat and without the last lesson's panel, so what is on screen is what the lesson is about.
      if (profileNow().rightSidebar && lesson.id !== "panel") await typeLine("/panel off")
      if (!fresh) await typeLine("/new")
    })
    fresh = false
    sentStart = engine.sent.length
    statsStart = { ...engine.stats, resolved: [...engine.stats.resolved] }
    lookAtStart = look()
    widgetsAtOpen = undefined
    sessionAtStart = sandbox.app.sessionId
    discardedText = ""
    sandbox.app.editor.replaceAll(lesson.prefill ?? "")
    if (doneIds.has(lesson.id)) stepsDone = lesson.steps.length
    evaluate()
  }

  /** Notes what a key did to the practice chat, for the steps that are about a gesture and not a command. */
  function observe(key: string, before: { editor: string; page: string }) {
    const after = { editor: sandbox.app.editor.text, page: sandbox.app.page }
    const onChat = after.page === "chat" || before.page === "chat"
    if (onChat && after.editor.startsWith("/")) flags.add("menuOpened")
    if (before.editor.startsWith("/") && (ARROWS.has(key) || key === KEY.tab)) flags.add("menuBrowsed")
    if (key === KEY.enter && before.editor.startsWith("/") && !after.editor.startsWith("/")) flags.add("commandRan")
    if (onChat && after.editor.includes("@")) flags.add("mentionOpened")
    const cards = keysFor(options.bindings, "tools.expand").raw
    if (cards && cards[0] === key && before.page === "chat") flags.add("cardsOpened")
    if (key === KEY.up && before.editor === "" && after.editor !== "" && before.page === "chat") flags.add("recalled")
    if (before.editor.length >= 12 && after.editor === "" && key !== KEY.enter && before.page === "chat") { flags.add("discarded"); discardedText = before.editor }
    if (flags.has("discarded") && key === KEY.up && before.editor === "" && after.editor === discardedText && discardedText !== "") flags.add("restored")
  }

  async function press(key: string) {
    const before = { editor: sandbox.app.editor.text, page: sandbox.app.page }
    await sandbox.key(key)
    observe(key, before)
    evaluate()
  }

  /** A key from the user: rail chords move the tour, Enter after a finished lesson goes on, everything else is the practice chat's. */
  async function key(raw: string): Promise<void> {
    if (disposed) return
    if (raw === RAIL.leave || raw === RAIL.leaveAlt) { options.onExit(); return }
    if (showing) return
    if (raw === RAIL.next) return advance()
    if (raw === RAIL.back) { await begin(index - 1); options.onChange(); return }
    if (raw === RAIL.skip) { const lesson = current(); if (lesson) { if (!doneIds.has(lesson.id)) skippedIds.add(lesson.id); options.onProgress([...doneIds, ...skippedIds]) } await begin(index + 1); options.onChange(); return }
    if (raw === RAIL.show) { void showMe(); return }
    if (ended) {
      if (raw === KEY.enter || raw === KEY.esc) options.onExit()
      return
    }
    const lesson = current()
    // A finished lesson hands Enter to the tour unless the chat is mid-turn or asking: then Enter is still the chat's.
    const idle = !engine.busy && engine.pending === 0
    if (raw === KEY.enter && lesson && stepsDone >= lesson.steps.length && idle) return advance()
    await press(raw)
    options.onChange()
  }

  async function advance() {
    const lesson = current()
    if (lesson && !doneIds.has(lesson.id) && !skippedIds.has(lesson.id)) skippedIds.add(lesson.id)
    if (lesson) options.onProgress([...doneIds, ...skippedIds])
    await begin(index + 1)
    options.onChange()
  }

  const poll = async (until: () => boolean) => {
    const limit = options.waitMs ?? 20_000
    let waited = 0
    while (!until() && waited < limit && !disposed) { await sleep(50); waited += 50 }
  }

  /** `show me`: the tour presses the keys itself, naming each one, so the lesson completes the same way a user's would. */
  async function showMe() {
    const lesson = current()
    if (!lesson || showing) return
    showing = true
    try {
      for (const action of lesson.show(options.bindings)) {
        if (disposed) return
        if (action.type === "text") {
          echo = "typing"
          options.onChange()
          for (const char of action.text) { await press(char === "\n" ? KEY.enter : char); await sleep(40) }
          if (action.text.endsWith("\r")) await sleep(200)
        } else if (action.type === "keys") {
          echo = action.echo
          options.onChange()
          await sleep(350)
          for (const raw of action.keys) await press(raw)
          await sleep(250)
        } else {
          echo = "waiting"
          options.onChange()
          if (action.until === "asking") await poll(() => engine.asking !== undefined)
          else if (action.until === "idle") await poll(() => !engine.busy && engine.pending === 0)
          else if (action.until === "busy") await poll(() => engine.busy)
          else if (action.until === "page") await poll(() => sandbox.app.page === action.page)
          else await poll(() => sandbox.app.page === "chat")
        }
      }
    } finally {
      showing = false
      echo = ""
      evaluate()
      options.onChange()
    }
    return undefined
  }

  const view = (): TourView => {
    const lesson = current()
    return {
      lessons: lessons.map((item, i) => ({ id: item.id, title: item.title, state: doneIds.has(item.id) ? "done" : skippedIds.has(item.id) ? "skipped" : i === index && !ended ? "current" : "todo" })),
      index, total: lessons.length, finished: lessons.filter((item) => doneIds.has(item.id) || skippedIds.has(item.id)).length, lesson,
      steps: lesson ? lesson.steps.map((step, i) => ({ label: step.label, done: i < stepsDone })) : [],
      complete: lesson ? stepsDone >= lesson.steps.length : false,
      hint: lesson ? lesson.hint(options.bindings) : "", echo, ended, note,
    }
  }

  return {
    sandbox,
    lessons,
    view,
    key,
    /** Starts at the first lesson not done yet. */
    start: () => begin(index),
    showMe,
    get ended() { return ended },
    get showing() { return showing },
    dispose() {
      if (disposed) return
      disposed = true
      sandbox.dispose()
    },
  }
}
export type Tour = ReturnType<typeof createTour>
