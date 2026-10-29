import { createIdFactory, type ModelsReport, type ProviderInfo } from "@mendcode/protocol"
import { createApp } from "../src/ui/app"
import { glyphs, type Line } from "../src/ui/theme"

const ids = createIdFactory()
export const plain = (line: Line) => line.map((span) => span.text).join("")

/** A provider as `providers.list` reports it. */
export function info(id: string, over: Partial<ProviderInfo> = {}): ProviderInfo {
  return { id, type: "openai-compatible", baseUrl: `https://${id}.example/v1`, enabled: true, hasKey: true, source: "config", models: [], ...over }
}

export const REPORT: ModelsReport = {
  engine: "native",
  selectable: true,
  models: [
    { id: "gpt-6-luna", name: "GPT-6 Luna", efforts: ["low", "medium", "high"], defaultEffort: "medium", contextWindow: 272_000 },
    { id: "gpt-6-sol", name: "GPT-6 Sol", efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "medium", contextWindow: 272_000 },
    { id: "claude-opus", name: "Claude Opus", efforts: [], engine: "claude" },
    { id: "anthropic:claude-sonnet-5-5", name: "Claude Sonnet 5.5", efforts: ["low", "medium", "high"], contextWindow: 200_000, provider: "anthropic" },
    { id: "openrouter:google/gemini-3-pro", name: "Gemini 3 Pro", efforts: ["low", "medium", "high"], provider: "openrouter" },
  ],
  defaults: { model: "gpt-6-luna" },
  roles: {},
  effective: { model: "gpt-6-luna" },
}

type Reply = (command: Record<string, unknown>) => unknown | Promise<unknown>

/**
 * The app on a 100x36 screen with a mocked daemon. `reply` answers first (undefined falls through to a small default
 * daemon: an empty provider list, the model report above, and `{ ok: true }` for the rest). Every frame drawn and every
 * command sent is kept, so a test can assert that something never appeared in either.
 */
export function providersHarness(options: { reply?: Reply; dataDir?: string; width?: number; height?: number } = {}) {
  const frames: Line[][] = []
  const sent: Array<Record<string, unknown>> = []
  const screen = { size: { width: options.width ?? 100, height: options.height ?? 36 }, draw: (rows: Line[]) => void frames.push(rows) } as unknown as Parameters<typeof createApp>[0]["screen"]
  const app = createApp({
    sessionId: ids("session"),
    screen,
    directory: "/work/app",
    ...(options.dataDir ? { dataDir: options.dataDir } : {}),
    exit() {},
    schedule: (fn) => fn(),
    glyphs: glyphs({}),
    now: () => 1_800_000_000_000,
    random: () => 0,
    mode: "balanced",
    send: (async (command: Record<string, unknown>) => {
      sent.push(command)
      const custom = await options.reply?.(command)
      if (custom !== undefined) return custom
      if (command.type === "providers.list") return { ok: true, result: { providers: [] } }
      if (command.type === "models.list" || command.type === "session.model.set") return { ok: true, result: REPORT }
      return { ok: true }
    }) as never,
  })
  const text = () => frames.at(-1)!.map(plain).join("\n")
  /** Raw stdin (typed text, pastes, escape sequences), then a frame. */
  const type = async (data: string) => {
    await app.onInput(data)
    await Bun.sleep(8)
    app.render()
  }
  /** Runs a slash command through the prompt. */
  const run = async (command: string) => {
    await app.onInput(command)
    await app.onKey("\r")
    await Bun.sleep(8)
    app.render()
  }
  /** Every frame drawn so far as one string, for "never appeared" assertions. */
  const everything = () => frames.map((frame) => frame.map(plain).join("\n")).join("\n")
  const commands = (name: string) => sent.filter((command) => command.type === name)
  return { app, sent, frames, text, type, run, everything, commands }
}
