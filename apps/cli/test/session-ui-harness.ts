import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createIdFactory, type SessionEvent, type SessionId } from "@mendcode/protocol"
import type { CommandInput, CommandReply } from "@mendcode/client"
import { createApp } from "../src/ui/app"
import { glyphs, type Line } from "../src/ui/theme"
import type { PresentationMode } from "../src/view/transcript"
import { mendChatLines, mendSpriteLines } from "../src/view/mend-sprite"

/** Shared by the session-history, dock, sidebar and pagination tests: an app on a fake screen and a scripted conversation. */
export const ids = createIdFactory()
export const NOW = new Date(2026, 8, 30, 12, 0).getTime()

/** The built-in Mend's lines: the chat's beside the prompt, or the start screen's at `scale`. */
const mendLines = (phase: string, scale?: number) => (scale === undefined ? mendChatLines(phase) : mendSpriteLines(phase, scale))
/** The built-in Mend's rows as text (half blocks, trimmed): how a test finds it on screen without reading colors. */
export const mendRows = (phase = "idle", scale?: number) => mendLines(phase, scale).map((line) => line.map((span) => span.text).join("").trim())
/** Whether `frame` shows Mend in `phase` (its eyes are colors, so the colored spans of each row are compared): the row of its antennas, or -1. Without `scale`, the chat's Mend. */
export function mendRowIn(frame: readonly Line[], phase = "idle", scale?: number): number {
  const colored = (line: readonly Line[number][]) => JSON.stringify(line.filter((span) => span.fgHex).map(({ text, fgHex, bgHex }) => ({ text, fgHex, bgHex })))
  const want = mendLines(phase, scale).map((line) => colored(line).slice(1, -1))
  return frame.findIndex((_, at) => want.every((row, offset) => colored(frame[at + offset] ?? []).includes(row)))
}
export const plain = (line: Line) => line.map((span) => span.text).join("")

const temps: string[] = []
/** A fresh temporary directory (the tests never touch a real data dir or project). */
export function tempDir(prefix = "mendcode-session-ui-") {
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  temps.push(dir)
  return dir
}
export function cleanTemps() {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
}

export type HarnessOptions = {
  tuiControl?: boolean
  trace?: Parameters<typeof createApp>[0]["trace"]
  editorLauncher?: Parameters<typeof createApp>[0]["editorLauncher"]
  startup?: Parameters<typeof createApp>[0]["startup"]
  diagnostics?: Parameters<typeof createApp>[0]["diagnostics"]
  remote?: Parameters<typeof createApp>[0]["remote"]
  terminal?: Parameters<typeof createApp>[0]["terminal"]
  screen?: Parameters<typeof createApp>[0]["screen"]
  /** What the launch has to say (a config problem, a new build). */
  notice?: string
  env?: Parameters<typeof createApp>[0]["env"]
  /** The OS the key hints are written for (`darwin` says Option); unset keeps them canonical, so no test depends on the host. */
  platform?: string
  /** The macOS keyboard layout id the Option characters are read for; unset is the default layout. */
  keyboardLayout?: () => string | undefined
  /** The home and file access `/terminal-setup` writes the terminal's config through; unset, the page only prints. */
  terminalConfig?: Parameters<typeof createApp>[0]["terminalConfig"]
  pets?: Parameters<typeof createApp>[0]["pets"]
  imageAnswers?: Parameters<typeof createApp>[0]["imageAnswers"]
  version?: string
  width?: number
  height?: number
  /** Answers a command; `undefined` means the default `{ ok: true }`. */
  reply?: (command: CommandInput) => CommandReply | undefined | Promise<CommandReply>
  dataDir?: string
  directory?: string
  mode?: PresentationMode
  sessionId?: SessionId
  events?: Parameters<typeof createApp>[0]["events"]
  /** A clock the test moves; the default stands still at NOW. */
  now?: () => number
  launchDirectory?: string
  safeMode?: boolean
  daemon?: Parameters<typeof createApp>[0]["daemon"]
  /** The terminal profile in use, as a host that has no data dir hands it in. */
  hostProfile?: Parameters<typeof createApp>[0]["profile"]
}

export function appHarness(options: HarnessOptions = {}) {
  const frames: Line[][] = []
  /** Inline mode: the finished lines each frame handed to the screen to write above its region. */
  const committed: Line[][] = []
  const cursors: Array<{ row: number; col: number } | undefined> = []
  const placements: Array<import("../src/ui/image-layer").ImagePlacement[]> = []
  const sent: CommandInput[] = []
  const written: string[] = []
  const titles: string[] = []
  const subscriptions: Array<{ sessionId: SessionId; afterSeq: number }> = []
  const size = { width: options.width ?? 120, height: options.height ?? 40 }
  const screen = { size, draw: (rows: Line[], cursor?: { row: number; col: number }, images?: import("../src/ui/image-layer").ImagePlacement[]) => { frames.push(rows); cursors.push(cursor); placements.push(images ?? []) }, write: (data: string) => void written.push(data), setTitle: (title: string) => void titles.push(title) } as unknown as Parameters<typeof createApp>[0]["screen"]
  const activeScreen = options.screen ?? screen
  if (options.screen) {
    const draw = options.screen.draw.bind(options.screen)
    options.screen.draw = (rows, cursor, images, finished) => { frames.push(rows); cursors.push(cursor); placements.push(images ?? []); if (finished?.length) committed.push(finished); return draw(rows, cursor, images, finished) }
  }
  const sessionId = options.sessionId ?? ids("session")
  const app = createApp({
    ...(options.tuiControl ? { tuiControl: true } : {}),
    ...(options.safeMode ? { safeMode: true, pure: true } : {}),
    ...(options.trace ? { trace: options.trace } : {}),
    ...(options.editorLauncher ? { editorLauncher: options.editorLauncher } : {}),
    ...(options.terminal ? { terminal: options.terminal } : {}),
    ...(options.notice ? { notice: options.notice } : {}),
    sessionId,
    screen: activeScreen,
    ...(options.env ? { env: options.env } : {}),
    ...(options.platform ? { platform: options.platform } : {}),
    ...(options.keyboardLayout ? { keyboardLayout: options.keyboardLayout } : {}),
    ...(options.terminalConfig ? { terminalConfig: options.terminalConfig } : {}),
    ...(options.pets ? { pets: options.pets } : {}),
    ...(options.imageAnswers ? { imageAnswers: options.imageAnswers } : {}),
    send: async (command) => {
      sent.push(command)
      return options.reply?.(command) ?? { ok: true }
    },
    subscribe: async (sessionId, afterSeq) => {
      subscriptions.push({ sessionId, afterSeq })
      return { ok: true }
    },
    ...(options.version ? { version: options.version } : {}),
    ...(options.events ? { events: options.events } : {}),
    ...(options.startup ? { startup: options.startup } : {}),
    ...(options.diagnostics ? { diagnostics: options.diagnostics } : {}),
    ...(options.remote ? { remote: options.remote } : {}),
    ...(options.daemon ? { daemon: options.daemon } : {}),
    ...(options.hostProfile ? { profile: options.hostProfile } : {}),
    exit() {},
    schedule: (fn) => fn(),
    glyphs: glyphs({}),
    now: options.now ?? (() => NOW),
    ...(options.launchDirectory ? { launchDirectory: options.launchDirectory } : {}),
    random: () => 0,
    ...(options.mode ? { mode: options.mode } : {}),
    ...(options.dataDir ? { dataDir: options.dataDir } : {}),
    ...(options.directory ? { directory: options.directory } : {}),
  })
  const text = () => (frames.at(-1) ?? []).map(plain)
  /** Raw terminal input (text and keys, `\r` for enter), then one more frame for whatever settled. */
  const type = async (input: string) => {
    await app.onInput(input)
    await Bun.sleep(2)
    app.render()
  }
  return { app, frames, committed, cursors, placements, sent, written, titles, subscriptions, size, text, type, sessionId, sentOf: (type: string) => sent.filter((command) => command.type === type) }
}
export type Harness = ReturnType<typeof appHarness>

/** A scripted session: each call appends events with rising `seq` and `at`, and hands them to `sink` (the app or a transcript). */
export function conversation(sessionId: SessionId, sink: (event: SessionEvent) => void) {
  let seq = 0
  let clock = NOW - 3_600_000
  const emit = (event: Record<string, unknown>) => {
    clock += 1_000
    sink({ sessionId, seq: ++seq, at: clock, ...event } as SessionEvent)
  }
  const message = (turnId: string, kind: "user_message" | "agent_message", text: string) => {
    const itemId = ids("item")
    emit({ type: "item.started", turnId, itemId, kind })
    emit({ type: "item.completed", itemId, status: "ok", text })
    return itemId
  }
  return {
    emit,
    /** A finished turn: the user's message and the agent's answer. */
    exchange(user: string, answer: string) {
      const turnId = ids("turn")
      emit({ type: "turn.started", turnId, queueId: ids("queue") })
      const itemId = message(turnId, "user_message", user)
      message(turnId, "agent_message", answer)
      emit({ type: "turn.completed", turnId })
      return { turnId, itemId }
    },
    undo: (turnId: string) => emit({ type: "turn.reverted", turnId }),
    redo: (turnId: string) => emit({ type: "turn.restored", turnId }),
  }
}
