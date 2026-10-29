import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createIdFactory, type SessionEvent, type SessionId, type Settings } from "@mendcode/protocol"
import { createApp } from "../src/ui/app"
import { glyphs, type Line } from "../src/ui/theme"
import type { PresentationMode } from "../src/view/transcript"

/** Shared by the extension and keybinding tests: a temp data dir and project, and an app drawn into frames. */

export const plain = (line: Line) => line.map((span) => span.text).join("")
const ids = createIdFactory()

export function scratch() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "mend-ext-")))
  const dataDir = path.join(root, "data")
  const project = path.join(root, "project")
  mkdirSync(dataDir, { recursive: true })
  mkdirSync(project, { recursive: true })
  return {
    root,
    dataDir,
    project,
    /** Writes `source` at `relative` under the root (folders are created) and returns its path. */
    write(relative: string, source: string) {
      const file = path.join(root, relative)
      mkdirSync(path.dirname(file), { recursive: true })
      writeFileSync(file, source)
      return file
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

export type HarnessOptions = {
  sessionId?: SessionId
  dataDir?: string
  directory?: string
  /** The user's home, so a directory under it is shown as `~/…`. */
  home?: string
  width?: number
  height?: number
  mode?: PresentationMode
  settings?: Settings
  /** Shown as the terminal's version (home, /status). */
  version?: string
  daemonBuildId?: string
  reply?: (command: Record<string, unknown>) => unknown | Promise<unknown>
  /** Replaces the synchronous scheduler, to count coalesced frames. */
  schedule?: (fn: () => void) => void
  /** The prompt editor's external launcher, terminal hand-over and environment (see createApp). */
  editorLauncher?: Parameters<typeof createApp>[0]["editorLauncher"]
  terminal?: Parameters<typeof createApp>[0]["terminal"]
  env?: Record<string, string | undefined>
  /** False like `--no-approve`: no startup trust prompt. */
  trustPrompt?: boolean
}

export async function appHarness(options: HarnessOptions = {}) {
  const frames: Line[][] = []
  const sent: Array<Record<string, unknown>> = []
  const sessionId = options.sessionId ?? ids("session")
  /** Raw control output outside the frames (the bell, OSC 52). */
  const written: string[] = []
  const screen = { size: { width: options.width ?? 100, height: options.height ?? 30 }, draw: (rows: Line[]) => void frames.push(rows), write: (data: string) => void written.push(data) } as unknown as Parameters<typeof createApp>[0]["screen"]
  const app = createApp({
    sessionId,
    screen,
    ...(options.editorLauncher ? { editorLauncher: options.editorLauncher } : {}),
    ...(options.terminal ? { terminal: options.terminal } : {}),
    ...(options.env ? { env: options.env } : {}),
    ...(options.trustPrompt !== undefined ? { trustPrompt: options.trustPrompt } : {}),
    directory: options.directory ?? "/work/app",
    ...(options.home ? { home: options.home } : {}),
    ...(options.dataDir ? { dataDir: options.dataDir } : {}),
    ...(options.version ? { version: options.version } : {}),
    ...(options.daemonBuildId ? { daemonBuildId: options.daemonBuildId } : {}),
    exit() {},
    schedule: options.schedule ?? ((fn) => fn()),
    glyphs: glyphs({}),
    now: () => 1_800_000_000_000,
    random: () => 0,
    mode: options.mode ?? "balanced",
    send: (async (command: Record<string, unknown>) => {
      sent.push(command)
      return (await options.reply?.(command)) ?? { ok: true }
    }) as never,
  })
  let seq = 0
  const event = (body: Record<string, unknown>) => app.onEvent({ sessionId, seq: ++seq, at: 0, ...body } as SessionEvent)
  return {
    app,
    sent,
    frames,
    written,
    event,
    sessionId,
    /** Pushes the settings like the daemon's first `settings.get` and waits for the extension modules to load. */
    async start(settings: Settings = options.settings ?? {}) {
      app.applySettings(settings)
      await app.extensionsReady
      app.render()
    },
    rows: () => frames.at(-1)!.map(plain),
    text: () => frames.at(-1)!.map(plain).join("\n"),
    async key(value: string) {
      await app.onKey(value)
      await Bun.sleep(2)
      app.render()
    },
    async type(value: string) {
      await app.onInput(value)
      await Bun.sleep(2)
      app.render()
    },
    /** A turn that never finishes: the foreground is working and the working row shows. */
    working() {
      const turnId = ids("turn")
      event({ type: "turn.started", turnId, queueId: ids("queue") })
      event({ type: "foreground.state", state: "generating", turnId })
      app.render()
    },
    /** One finished turn with a user message and an assistant reply (the transcript leaves the home screen). */
    message(user: string, assistant: string) {
      const turnId = ids("turn")
      event({ type: "turn.started", turnId, queueId: ids("queue") })
      const one = ids("item")
      event({ type: "item.started", turnId, itemId: one, kind: "user_message" })
      event({ type: "item.completed", itemId: one, status: "ok", text: user })
      const two = ids("item")
      event({ type: "item.started", turnId, itemId: two, kind: "agent_message" })
      event({ type: "item.completed", itemId: two, status: "ok", text: assistant })
      app.render()
    },
    /** A finished tool call whose card title is `title` ("shell: make"). */
    tool(title: string, output: string, status: "ok" | "error" = "ok", toolInput?: string) {
      const turn = ids("turn")
      event({ type: "turn.started", turnId: turn, queueId: ids("queue") })
      const item = ids("item")
      event({ type: "item.started", turnId: turn, itemId: item, kind: "tool_call", meta: { tool: title } })
      event({ type: "item.completed", itemId: item, status, text: output, ...(toolInput !== undefined ? { toolInput } : {}) })
      app.render()
    },
  }
}

/** The text of an extension module; plain objects need no import, so the files resolve anywhere. */
export const extension = (name: string, body: string) => `export default { name: ${JSON.stringify(name)}, tui(api) {\n${body}\n} }\n`
