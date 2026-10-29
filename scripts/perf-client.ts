// Child process of scripts/perf.ts: the v2 terminal client against a real daemon, measured in a fresh process (RSS must not
// include the orchestrator). Prints one JSON line. Wiring mirrors apps/cli/src/main.ts: real client, real app, real screen
// (the differential renderer encodes every frame) writing into a byte counter instead of a terminal.
import type { SessionEvent, SessionId, Settings } from "@mendcode/protocol"

const MB = 1048576
const rssMB = () => +(process.memoryUsage().rss / MB).toFixed(1)
/** JS heap in use at each settled sample: tells heap growth from native memory the runtime keeps. */
const heapMB: Record<string, number> = {}
const settled = (label: string) => { Bun.gc(true); heapMB[label] = +(process.memoryUsage().heapUsed / MB).toFixed(1); return rssMB() }
const arg = (name: string, fallback?: string) => {
  const at = process.argv.indexOf(`--${name}`)
  const value = at >= 0 ? process.argv[at + 1] : fallback
  if (value === undefined) throw new Error(`perf-client: --${name} is required`)
  return value
}
/** `--solo`: this process hosts the daemon (apps/cli/src/solo.ts) and reaches it in memory, as a terminal does in solo mode. */
const solo = process.argv.includes("--solo")
const socketPath = solo ? "" : arg("socket")
const sessionId = arg("session") as SessionId
const directory = arg("directory")
const dataDir = arg("data-dir")
const lastSeq = Number(arg("last-seq"))
const scrollPresses = Number(arg("scroll-presses", "120"))
const deltas = Number(arg("deltas", "400"))
const columns = Number(arg("columns", "120"))
const rows = Number(arg("rows", "40"))

const rssBoot = rssMB()
const started = performance.now()
const { createClient } = await import("@mendcode/client")
const { createApp } = await import("../apps/cli/src/ui/app")
const { createScreen } = await import("../apps/cli/src/ui/screen")
const importMs = performance.now() - started
const rssImported = rssMB()

let bytes = 0
const screen = createScreen({ write: (data) => void (bytes += data.length), columns, rows, isTTY: false }, { MENDCODE_TERMINAL_TITLE: "0", MENDCODE_MOUSE: "0", ...(process.env.MENDCODE_GC_FRAMES === undefined ? {} : { MENDCODE_GC_FRAMES: process.env.MENDCODE_GC_FRAMES }) })
const queue: Array<() => void> = []
const flush = () => { for (const fn of queue.splice(0)) fn() }
let app: ReturnType<typeof createApp> | undefined
const hostStarted = performance.now()
const hosted = solo ? await (await import("../apps/cli/src/launcher")).ensureDaemon({ dir: dataDir, engine: "faux", cwd: directory, solo: true, timeoutMs: 30_000 }) : undefined
if (solo && !hosted?.host) throw new Error("perf-client: --solo did not host the daemon")
const hostMs = performance.now() - hostStarted
const rssHosted = rssMB()
const client = createClient({
  ...(hosted?.host ? { loopback: () => hosted.host!.attach, socketPath: hosted.socketPath } : { socketPath }),
  name: "perf-client", reconnect: false, onEvent: (event) => app?.onEvent(event), onGlobal: (event) => app?.onGlobal(event), onConnection: (state) => app?.onConnection(state),
})
await client.connect()
app = createApp({
  sessionId,
  screen,
  send: (command) => client.send(command),
  subscribe: (id, afterSeq) => client.subscribe(id, afterSeq),
  events: { loadWindow: (id) => client.loadWindow(id), loadBefore: (id, firstSeq) => client.loadBefore(id, firstSeq) },
  exit: () => undefined,
  directory,
  dataDir,
  home: dataDir,
  version: "perf",
  schedule: (fn) => void queue.push(fn),
})
const saved = await client.send({ type: "settings.get" })
if (saved.ok) app.applySettings(saved.result?.settings as Settings)
screen.enter()
await app.start()
flush()
app.render()
const firstFrameMs = performance.now() - started
await Bun.sleep(100)
flush()
const rssIdle = settled("idle")

/** The distribution of a list of durations in milliseconds. */
function stats(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b)
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0
  const round = (n: number) => +n.toFixed(3)
  return { samples: sorted.length, p50: round(at(0.5)), p95: round(at(0.95)), max: round(sorted.at(-1) ?? 0) }
}
async function timed(samples: number[], work: () => unknown) {
  const begin = performance.now()
  await work()
  flush()
  samples.push(performance.now() - begin)
}

// Idle frames: a redraw with nothing changed (the diff finds no row to write).
const idle: number[] = []
for (let i = 0; i < 100; i++) await timed(idle, () => app!.render())

// Scrolling: page up through the history (this lays out older blocks and fetches earlier pages), then page down again.
const up: number[] = []
const down: number[] = []
for (let i = 0; i < scrollPresses; i++) { await timed(up, () => app!.onInput("\x1b[5~")); await Bun.sleep(0) }
const rssScrolledUp = settled("scrolledUp")
for (let i = 0; i < scrollPresses; i++) await timed(down, () => app!.onInput("\x1b[6~"))
await app.onInput("\x1b[F")
flush()

// Streaming: one answer arriving as small deltas, one frame per delta (the worst case: the real renderer coalesces to ~60 fps).
const WORDS = ["the", "daemon", "owns", "state", "`render()`", "keeps", "frames", "cheap", "while", "text", "streams", "in", "**bold**", "and", "lists"]
let seq = lastSeq
const emit = (event: Record<string, unknown>) => app!.onEvent({ sessionId, seq: ++seq, at: Date.now(), ...event } as SessionEvent)
const turnId = "turn_perfstream"
emit({ type: "turn.started", turnId, queueId: "queue_perfstream" })
emit({ type: "item.started", turnId, itemId: "item_perfstream", kind: "agent_message" })
flush()
const stream: number[] = []
for (let i = 0; i < deltas; i++) {
  const text = `${[1, 7, 4, 11].map((step) => WORDS[(i * step) % WORDS.length]).join(" ")} ${i % 10 === 9 ? "\n\n" : ""}`
  await timed(stream, () => emit({ type: "item.delta", itemId: "item_perfstream", text }))
}
emit({ type: "item.completed", itemId: "item_perfstream", status: "ok" })
emit({ type: "turn.completed", turnId })
flush()
const rssAfter = settled("afterStream")

console.log(JSON.stringify({
  startupMs: { import: +importMs.toFixed(1), firstFrame: +firstFrameMs.toFixed(1), ...(solo ? { hosted: +hostMs.toFixed(1) } : {}) },
  rssMB: { boot: rssBoot, imported: rssImported, ...(solo ? { hosted: rssHosted } : {}), idle: rssIdle, scrolledUp: rssScrolledUp, afterStream: rssAfter },
  frameMs: { idle: stats(idle), scrollUp: stats(up), scrollDown: stats(down), stream: stats(stream) },
  heapMB,
  screenBytes: bytes,
}))
client.close()
await hosted?.host?.stop()
process.exit(0)
