import { mkdtempSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import path from "node:path"
import { createIdFactory, type SessionEvent } from "@mendcode/protocol"
import { createApp } from "../../apps/cli/src/ui/app"
import { colorDepth, glyphs, sgr, type Line } from "../../apps/cli/src/ui/theme"
import type { PresentationMode } from "../../apps/cli/src/view/transcript"
import { textWidth } from "../../apps/cli/src/view/wrap"

/**
 * Frames of the area around the prompt (working row, chrome, status row, approval, question, queue, popup),
 * printed as ANSI: `bun benchmarks/fixtures/prompt-area-fixture.ts <scenario> [mode] [width] [height]`.
 * `all` prints every scenario, separated by a title line.
 */
const SCENARIOS = ["home", "typing", "busy", "retrying", "approval", "question", "queue", "slash", "scrolled", "shell", "status", "topbar", "toast", "dock", "leader", "pet"] as const
type Scenario = (typeof SCENARIOS)[number]

const NOW = 1_800_000_000_000
const ids = createIdFactory()

const DIFF = ["src/view/footer.ts", "", "@@ -12,3 +12,4 @@", " const GAP = \"  \"", "-const KEPT = new Set([\"state\"])", "+const KEPT = new Set([\"state\", \"notice\"])", "+const MAX = 8"].join("\n")

async function frame(scenario: Scenario, mode: PresentationMode, width: number, height: number): Promise<Line[]> {
  let last: Line[] = []
  const screen = { size: { width, height }, draw: (rows: Line[]) => void (last = rows) } as unknown as Parameters<typeof createApp>[0]["screen"]
  const sessionId = ids("session")
  const send = async (command: { type: string }) => {
    if (command.type === "models.list") return { ok: true, result: { engine: "codex", selectable: true, models: [], defaults: { model: "gpt-6-luna" }, roles: {}, effective: { model: "gpt-6-luna", effort: "high" } } }
    if (command.type === "git.branch") return { ok: true, result: { branch: "feature/footer-notice" } }
    if (command.type === "changes.query") return { ok: true, result: { files: [{ path: "a.ts", status: "modified", additions: 142, deletions: 31 }, { path: "b.ts", status: "added", additions: 30, deletions: 0 }] } }
    if (command.type === "loop.list") return { ok: true, result: { loops: [{ loopId: "loop-1", directory: "/Users/dev/Code/MendCodeV2", state: "active" }] } }
    return { ok: true }
  }
  const app = createApp({
    sessionId,
    screen,
    send: send as never,
    exit() {},
    schedule: (fn) => fn(),
    glyphs: glyphs({}),
    now: () => NOW,
    random: () => 0,
    mode,
    directory: "/Users/dev/Code/MendCodeV2",
    home: "/Users/dev",
    version: "v0.2.0",
    ...(scenario === "pet"
      ? { pets: { dirs: [{ dir: path.join(process.env.CODEX_HOME ?? path.join(homedir(), ".codex"), "pets"), source: "codex" as const }], cacheDir: mkdtempSync(path.join(tmpdir(), "mend-pet-fixture-")), images: false } }
      : {}),
  })
  app.applySettings({})
  await Bun.sleep(5)
  let seq = 0
  const turnId = ids("turn")
  const ev = (patch: Record<string, unknown>, at = NOW) => app.onEvent({ sessionId, seq: ++seq, at, ...patch } as SessionEvent)
  const message = (kind: "user_message" | "agent_message", text: string) => {
    const itemId = ids("item")
    ev({ type: "item.started", turnId, itemId, kind })
    ev({ type: "item.completed", itemId, status: "ok", text })
  }
  const startTurn = (secondsAgo: number) => {
    ev({ type: "turn.started", turnId, queueId: ids("queue") }, NOW - secondsAgo * 1000)
    ev({ type: "foreground.state", state: "generating", turnId })
  }
  const conversation = () => {
    app.onGlobal({ type: "session.activity", gseq: 1, at: NOW, sessionId, directory: "/Users/dev/Code/MendCodeV2", title: "Keep the footer notice on narrow terminals", state: "idle", updatedAt: NOW } as never)
    ev({ type: "usage.recorded", turnId, provider: "codex", model: "gpt-6-luna", input: 61_000, output: 2_000, reasoning: 0, cacheRead: 0, cacheWrite: 0 })
    message("user_message", "make the footer keep the notice when the terminal is narrow")
    message("agent_message", "I'll check how the footer drops segments and keep the notice.")
  }

  if (scenario === "home") app.render()
  else if (scenario === "typing") {
    await app.onInput("explain how the queue promotes a message")
  } else if (scenario === "busy") {
    conversation()
    startTurn(42)
    const itemId = ids("item")
    ev({ type: "item.started", turnId, itemId, kind: "tool_call", meta: { tool: "shell: bun test apps/cli" } })
    ev({ type: "foreground.state", state: "tool", turnId })
    ev({ type: "item.delta", itemId, text: "bun test v1.3.13\n" })
  } else if (scenario === "pet") {
    // Codex pets are read only; the frame cache goes to a temp dir. PET picks one (default codex:greenie).
    conversation()
    app.applySettings({ pet: process.env.PET ?? "codex:greenie" })
    for (let i = 0; i < 200 && !last.some((row) => row.some((span) => span.fgHex && /[▀▄]/.test(span.text))); i++) {
      await Bun.sleep(10)
      app.render()
    }
  } else if (scenario === "retrying") {
    conversation()
    startTurn(75)
    ev({ type: "turn.retrying", turnId, attempt: 2, nextAt: NOW + 12_000, message: "429 Too Many Requests: rate limit reached for gpt-6-luna on this organization, try again shortly" })
  } else if (scenario === "approval") {
    conversation()
    startTurn(9)
    ev({ type: "foreground.state", state: "waiting_approval", turnId })
    ev({ type: "server.request", requestId: ids("request"), turnId, kind: "approval", title: "Edit files", detail: DIFF, tool: "edit", permission: "write" })
    await Bun.sleep(20)
    app.render()
  } else if (scenario === "question") {
    conversation()
    startTurn(15)
    ev({ type: "foreground.state", state: "waiting_approval", turnId })
    ev({
      type: "server.request",
      requestId: ids("request"),
      turnId,
      kind: "question",
      title: "Which footer segments should stay when the terminal is narrow?",
      detail: "",
      options: [
        { label: "Notice only", description: "Drop everything else first" },
        { label: "State and notice", description: "Matches the current behavior" },
        { label: "Nothing", description: "Let the footer overflow and clip" },
      ],
    })
  } else if (scenario === "queue") {
    conversation()
    startTurn(28)
    const shellId = ids("queue")
    ev({ type: "queue.added", queueId: shellId, text: "bun test apps/cli", attachments: [], shell: true })
    ev({ type: "queue.changed", queue: [{ queueId: ids("queue"), preview: "also add a test for the narrow case", attachments: 0 }, { queueId: shellId, preview: "bun test apps/cli", attachments: 0 }] })
  } else if (scenario === "slash") {
    conversation()
    await app.onInput("/")
  } else if (scenario === "shell") {
    conversation()
    await app.onKey("!")
  } else if (scenario === "status") {
    conversation()
    app.onGlobal({ type: "status.line", gseq: 1, at: NOW, directory: "/Users/dev/Code/MendCodeV2", left: [{ text: "main", fg: "#22c55e", bold: true }, { text: "3 changed", fg: "#f59e0b" }], right: [{ text: "12:04", fg: "#38bdf8" }], problems: [] } as never)
  } else if (scenario === "topbar") {
    conversation()
    await Bun.sleep(10)
  } else if (scenario === "toast") {
    conversation()
    app.onGlobal({ type: "dream.changed", gseq: 2, at: NOW, run: { directory: "/Users/dev/Code/MendCodeV2", status: "done", proposed: 2 } } as never)
  } else if (scenario === "dock") {
    conversation()
    const todo = ids("item")
    ev({ type: "item.started", turnId, itemId: todo, kind: "tool_call", meta: { tool: "todo" } })
    ev({ type: "item.completed", itemId: todo, status: "ok", text: "[x] find where the footer drops segments\n[~] keep the notice when narrow\n[ ] add the narrow-terminal test\n[ ] update the docs" })
    startTurn(20)
    const task = ids("item")
    ev({ type: "item.started", turnId, itemId: task, kind: "tool_call", meta: { tool: "task: explore the footer tests" } })
    await app.onKey("\x14")
  } else if (scenario === "leader") {
    conversation()
    await app.onKey("\x18")
  } else if (scenario === "scrolled") {
    for (let i = 0; i < 30; i++) message("agent_message", `line ${i}: the footer keeps state and notice`)
    await app.onInput("\x1b[5~")
  }
  app.render()
  return last
}

function ansi(rows: Line[]) {
  const depth = colorDepth({ COLORTERM: "truecolor" })
  return rows
    .map((line) => {
      let out = ""
      let used = 0
      for (const span of line) {
        const style = sgr(span, depth)
        out += style ? `${style}${span.text}\x1b[0m` : span.text
        used += textWidth(span.text)
      }
      return out
    })
    .join("\n")
}

const [scenarioArg = "all", modeArg = "balanced", widthArg = "120", heightArg = "40"] = process.argv.slice(2)
const mode = modeArg as PresentationMode
const wanted = scenarioArg === "all" ? [...SCENARIOS] : [scenarioArg as Scenario]
for (const scenario of wanted) {
  if (!SCENARIOS.includes(scenario)) throw new RangeError(`[FIXTURE]: unknown scenario "${scenario}" (${SCENARIOS.join(", ")})`)
  if (wanted.length > 1) process.stdout.write(`--- ${scenario} ${mode} ${widthArg}x${heightArg}\n`)
  process.stdout.write(`${ansi(await frame(scenario, mode, Number(widthArg), Number(heightArg)))}\n`)
}
// A busy scenario leaves the app's repaint timer running; the fixture only wants the frame.
process.exit(0)
