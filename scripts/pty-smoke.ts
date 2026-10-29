// Real compiled CLI + compiled daemon, OS PTY, offline faux engine, throwaway HOME/data/project.
// bun scripts/pty-smoke.ts [--short] [--frames DIR]
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import type { SessionId } from "@mendcode/protocol"
import { openStore } from "@mendcode/store"
import { compiledTarget, seedDataDir, type Target } from "./perf"
import { createPtyScreen } from "./pty-screen"
import { parseSlash } from "../apps/cli/src/view/commands"
import { addMcpConfig } from "../packages/daemon/src/mcp-config"
import { DEFAULT_TUI_PROFILE, readTuiProfile, writeTuiProfile } from "../apps/cli/src/view/tui-profile"
import { presetOf } from "../apps/cli/src/view/sidebar-spec"
import { TIER_BUNDLES, type Tier } from "@mendcode/protocol/wire"

const ROOT = path.resolve(import.meta.dir, "..")
type Frame = { name: string, cols: number, rows: number, file: string }

async function until(check: () => boolean, label: string, timeout = 8000) {
  const deadline = Date.now() + timeout
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`PTY smoke timed out: ${label}`)
    await Bun.sleep(10)
  }
}

export async function runPtySmoke(options: { short?: boolean, tuiBugs?: boolean, panelReview?: boolean, frames: string, tier?: Tier, size?: readonly [number, number], ascii?: boolean, target?: Target }) {
  if (typeof Bun.Terminal !== "function") throw new Error("PTY smoke requires Bun.Terminal on macOS or Linux")
  const temp = realpathSync(mkdtempSync(path.join(tmpdir(), "mend-pty-smoke-")))
  const dir = path.join(temp, "data")
  const home = path.join(temp, "home")
  const directory = path.join(temp, "project")
  // Deliberately do not inherit credentials, provider configuration, proxies or startup hooks.
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, TMPDIR: temp, XDG_CONFIG_HOME: home, XDG_DATA_HOME: home, TERM: "xterm-256color", LANG: "en_US.UTF-8", MENDCODE_TERMINAL_MODE: "0", MENDCODE_IMAGES: "off", MENDCODE_GLYPHS: "unicode", MENDCODE_THEME: options.ascii ? "terminal" : "mend" }
  let [cols, rows] = options.size ?? [100, 30]
  const screen = createPtyScreen(cols, rows)
  const decoder = new TextDecoder()
  const frames: Frame[] = []
  let daemon: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined
  let cli: Bun.Subprocess | undefined
  let terminal: Bun.Terminal | undefined
  let client: ReturnType<typeof createClient> | undefined
  let daemonError = ""
  const capture = (name: string) => {
    const file = path.resolve(options.frames, `${name}-${cols}x${rows}.txt`)
    const text = screen.text()
    if (screen.unsupported.length) throw new Error(`unsupported terminal sequences: ${screen.unsupported.join(", ")}`)
    if (/Unhandled|panic:|crashed|TypeError:|ReferenceError:/.test(text)) throw new Error(`CLI crash in ${name}`)
    if (text.slice(0, -1).split("\n").length !== rows) throw new Error(`bad screen height in ${name}`)
    if (text.slice(0, -1).split("\n").some((row) => Bun.stringWidth(row) !== cols)) throw new Error(`bad cell width in ${name}`)
    writeFileSync(file, text)
    const ansi = screen.ansi()
    if (options.ascii && /\x1b\[(?:[0-9]+;)*(?:38|48);/.test(ansi)) throw new Error(`extended colour in ASCII frame ${name}`)
    writeFileSync(file.replace(/\.txt$/, ".ansi"), ansi)
    frames.push({ name, cols, rows, file })
  }
  const keys = async (text: string) => {
    if (cli?.exitCode !== null) throw new Error(`CLI exited ${cli?.exitCode}: ${screen.text()}`)
    terminal!.write(text)
    await Bun.sleep(80)
  }
  const waitScreen = async (match: RegExp, label: string) => {
    try { await until(() => match.test(screen.text()), label) }
    catch (error) {
      capture(`failed-${label}`)
      throw error
    }
  }
  const command = async (text: string) => {
    // Faux engine triggers are plain text, not local paths or partial slash completions.
    if (text.startsWith("/") && !parseSlash(text)) await keys(`${text} `)
    else await keys(`\x1b[200~${text}\x1b[201~`)
    await keys("\r")
  }
  try {
    for (const folder of [dir, home, directory, options.frames]) mkdirSync(folder, { recursive: true })
    const target = options.target ?? await compiledTarget(path.join(temp, "build"))
    const long = seedDataDir({ dir, directory, messages: options.short ? 0 : 120 })
    const store = openStore({ dir })
    try {
      const tier = options.tier ?? "balanced"
      store.settings.set({ onboarded: true, tier, view: TIER_BUNDLES[tier].view, ...(options.tuiBugs ? { pet: "user:tiny", features: { pets: true }, reducedMotion: true } : {}) })
      store.renameSession(long.sessionId, "Long smoke transcript")
      if (options.tier && !options.short) {
        const turn = store.turns.list(long.sessionId).at(-1)!
        store.turns.snapshots.put(long.sessionId, turn.turnId, {
          root: directory, scope: "tools", complete: true, sealed: true,
          summary: { root: directory, omittedFiles: 0, complete: true, files: [{
            path: "src/fixture/replay.ts", status: "modified", additions: 2, deletions: 2,
            binary: false, truncated: false,
            diff: "@@ -1,2 +1,2 @@\n-old first\n+new first\n context\n@@ -20,2 +20,2 @@\n-old second\n+new second\n context\n",
          }] },
        })
      }
    } finally { store.close() }
    if (options.tuiBugs) cpSync(path.join(ROOT, "apps/cli/test/fixtures/pets/tiny"), path.join(dir, "pets/tiny"), { recursive: true })
    if (options.tier) {
      const bundle = TIER_BUNDLES[options.tier]
      const saved = writeTuiProfile(dir, { ...DEFAULT_TUI_PROFILE, density: bundle.density, theme: options.ascii ? "terminal" : "mend", ...(options.ascii ? { promptBorder: "ascii" } : {}) })
      if (!saved.ok) throw new Error(saved.error)
      addMcpConfig({ dir, directory, scope: "project", name: "pty-pending", config: { command: "never-start-pty-fixture", args: ["--offline"] }, pending: true })
    }
    daemon = Bun.spawn([...target.daemon, "--dir", dir, "--engine", "faux", "--cwd", directory, "--local-only", "--pure"], { cwd: directory, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
    const stderr = new Response(daemon.stderr).text().then((text) => { daemonError = text.trim().split("\n").slice(-14).join("\n") })
    const ready = daemon.stdout.getReader()
    const readyDecoder = new TextDecoder()
    let output = ""
    await Promise.race([
      (async () => {
        while (!output.includes("\n")) {
          const chunk = await ready.read()
          if (chunk.done) {
            await daemon!.exited
            await stderr
            throw new Error(`daemon exited ${daemon!.exitCode}: ${daemonError}`)
          }
          output += readyDecoder.decode(chunk.value, { stream: true })
        }
      })(),
      Bun.sleep(8000).then(() => { throw new Error("daemon readiness timeout") }),
    ])
    ready.releaseLock()
    const { socketPath } = JSON.parse(output.split("\n")[0]!) as { socketPath: string }
    let turns = 0
    let deltas = 0
    let pause = ""
    let compacted = false
    let toolStarted = 0
    client = createClient({ socketPath, name: "pty-smoke", reconnect: false, onEvent: (event) => {
      if (event.type === "turn.completed") turns++
      if (event.type === "item.delta") deltas++
      if (event.type === "usage.limit") pause = event.state
      if (event.type === "compaction.updated") compacted = event.state === "skipped" || event.state === "packed"
      if (event.type === "item.started" && event.kind === "tool_call") toolStarted++
    } })
    await client.connect()
    const watch = async () => {
      const reply = await client!.send({ type: "session.list", directory })
      if (!reply.ok) throw new Error(reply.error.message)
      const sessions = reply.result?.sessions as Array<{ sessionId: SessionId }>
      for (const session of sessions) {
        const window = await client!.loadWindow(session.sessionId)
        if (!window.ok) throw new Error(window.error.message)
        await client!.subscribe(session.sessionId, window.window.lastSeq)
      }
      return sessions
    }
    const openTerminal = () => {
      terminal = new Bun.Terminal({ cols, rows, name: "xterm-256color", data: (_terminal, bytes) => screen.feed(decoder.decode(bytes, { stream: true })) })
      cli = Bun.spawn([...target.cli, "--dir", dir, "--engine", "faux", "--pure"], { cwd: directory, env, terminal })
    }
    const quit = async () => {
      await keys("\x18")
      await keys("q")
      await until(() => cli!.exitCode !== null, "cli-exit")
      if (cli!.exitCode !== 0) throw new Error(`CLI exit ${cli!.exitCode}`)
    }
    /** `/panel` through every preset and verb, from the current screen; frames are named `<label>-...`. */
    const panelReviewFlow = async () => {
      const tier = options.tier ?? "balanced"
      const header = (preset: string) => new RegExp(`${preset} · /panel`)
      const step = async (text: string, match: RegExp, name: string) => {
        await command(text)
        await waitScreen(match, name)
        await Bun.sleep(120)
        capture(name)
      }
      const cycle = (tier === "full" ? ["pulse", "crew", "ledger", "focus", "full", "galaxy"] : ["pulse", "crew", "ledger", "focus", "full"])
      const phase = async (label: string) => {
        if (tier === "minimalist") {
          for (const [index, text] of ["/panel", "/panel next", "/panel crew", "/sidebar preset crew", "/panel edit", "/panel off"].entries()) {
            await command(text)
            await Bun.sleep(250)
            if (text !== "/panel off" && !/presets need/.test(screen.text())) throw new Error(`minimalist ${text} did not explain the refusal`)
            if (/ · \/panel/.test(screen.text())) throw new Error(`minimalist ${text} opened the panel`)
            capture(`${label}-refused-${index}`)
          }
          return
        }
        // From a clean profile the bare command opens pulse; later it brings back whatever preset was left.
        await step(label === "home" ? "/panel" : "/panel pulse", header("pulse"), `${label}-open`)
        for (let index = 0; index < cycle.length; index++) await step("/panel next", header(cycle[(index + 1) % cycle.length]!), `${label}-next-${index + 1}`)
        for (const preset of cycle) await step(`/panel ${preset}`, header(preset), `${label}-${preset}`)
        if (tier !== "full") {
          await step("/panel galaxy", /Galaxy needs full tier/, `${label}-galaxy-refused`)
          if (!header("full").test(screen.text())) throw new Error("a refused galaxy replaced the previous preset")
        } else {
          await keys("\x1b}")
          await keys("\t")
          await keys("]")
          await keys("l")
          await Bun.sleep(150)
          capture(`${label}-galaxy-focused`)
          await keys("\x1b")
        }
        await command("/panel off")
        await until(() => !/ · \/panel/.test(screen.text()), `${label}-off`)
        capture(`${label}-off`)
        await keys("\x18B")
        await waitScreen(header(cycle.at(-1)!), `${label}-toggle-key`)
        capture(`${label}-toggle-key`)
        await step("/sidebar preset crew", header("crew"), `${label}-alias-preset`)
        await command("/sidebar right")
        await until(() => !/ · \/panel/.test(screen.text()), `${label}-alias-right`)
        capture(`${label}-alias-right`)
        await command("/panel")
        await waitScreen(header("crew"), `${label}-back`)
        await command("/panel edit")
        await waitScreen(/Widget/, `${label}-edit`)
        capture(`${label}-edit`)
        await keys("\x1b")
      }
      await phase("home")
      if (tier !== "minimalist") await command("/panel off")
      const before = turns
      await command("/faux-activity")
      await until(() => turns > before, "activity-complete")
      const beforeTool = toolStarted
      await command("/tool 4000")
      await until(() => toolStarted > beforeTool, "activity-tool-started")
      await command("queued review message")
      await phase("active")
      if (tier !== "minimalist") {
        await step("/panel pulse", header("pulse"), "active-pulse-final")
        await step("/panel galaxy", tier === "full" ? header("galaxy") : /Galaxy needs full tier/, "active-galaxy-final")
        await step("/panel focus", header("focus"), "active-focus-final")
        await Bun.sleep(4200)
        await quit()
        const saved = readTuiProfile(dir)
        if (presetOf(saved.sidebarWidgets) !== "focus" || !saved.rightSidebar) throw new Error(`panel state was not persisted: ${presetOf(saved.sidebarWidgets)} ${saved.rightSidebar}`)
        screen.resize(cols, rows)
        terminal?.close()
        openTerminal()
        await waitScreen(header("focus"), "restart-panel")
        capture("restart-focus")
      }
      await quit()
      const result = { target: "compiled", nativePty: true, engine: "faux", tier, panelReview: true, ascii: !!options.ascii, frames, streamedDeltas: deltas, completedTurns: turns, cliExit: 0 }
      writeFileSync(path.join(options.frames, "result.json"), JSON.stringify(result, null, 2) + "\n")
      return result
    }
    openTerminal()
    await waitScreen(/MendCode|mendcode/i, "home")
    await Bun.sleep(150)
    capture("home")
    const beforeNew = await watch()
    await command("/new")
    const sessions = await watch()
    const current = sessions.find((session) => !beforeNew.some((previous) => previous.sessionId === session.sessionId))?.sessionId
    if (!current) throw new Error("new chat was not created by the keys")
    capture("new-chat")
    if (options.panelReview) return await panelReviewFlow()
    const completed = turns
    const beforeDeltas = deltas
    await command("PTY streaming answer " + (options.tuiBugs ? "short sample" : "abcdefgh ".repeat(32)))
    await until(() => deltas > beforeDeltas, "stream-delta")
    await waitScreen(/echo: PTY streaming answer/, "streaming")
    capture("streaming")
    await until(() => turns > completed, "stream-complete")
    await Bun.sleep(80)
    capture("answer")
    if (options.tuiBugs) {
      for (const chunk of ["\x1b[200~", "split plain text", "\x1b[201~", "\x1b[200~\x1b[201~"]) await keys(chunk)
      await waitScreen(/split plain text/, "text-paste")
      if (/no image in the clipboard/.test(screen.text())) throw new Error("text paste read image clipboard")
      capture("text-paste")
      await keys("\x15")
      await keys(`\x1b[200~${path.join(dir, "pets/tiny/spritesheet.png")}\x1b[201~`)
      await waitScreen(/Image #1/, "image-chip")
      if (screen.text().includes("spritesheet.png")) throw new Error("attached path remains in prompt")
      capture("image-chip")
      await keys("\x7f")
      await command("/settings")
      await waitScreen(/theme preview/, "settings-preview")
      for (const row of ["theme", "view", "motion", "pet", "footer"]) {
        await waitScreen(new RegExp(`${row} preview`), `settings-${row}`)
        capture(`settings-${row}`)
        if (row === "view" || row === "motion" || row === "theme") {
          await keys("\x1b[C")
          capture(`settings-${row}-changed`)
          await keys("\x1b[D")
        }
        await keys("\x1b[B")
      }
      capture("settings-permission")
      await keys("\x1b")
    }
    await command("/ask")
    await waitScreen(/run faux tool\?/, "approval")
    capture("approval")
    const approved = turns
    await keys(options.tier === "minimalist" ? "a" : "\r")
    await until(() => turns > approved, "approval-resolved")
    await Bun.sleep(80)
    capture("approved")
    if (options.tuiBugs) {
      const beforeQuestion = turns
      await command("/faux-question")
      await waitScreen(/faux question/, "question")
      capture("question")
      await keys("\r")
      await until(() => turns > beforeQuestion, "question-resolved")
    }
    if (!options.short) {
      for (const tier of options.tier ? [options.tier] : ["minimalist", "balanced", "full"]) {
        await command(`/tier ${tier}`)
        await waitScreen(new RegExp(`tier ${tier} · view`), `tier-${tier}`)
        capture(`tier-${tier}`)
        await command("/tier")
        await waitScreen(/Bundles/, `tier-panel-${tier}`)
        capture(`tier-panel-${tier}`)
        await keys("\x1b")
      }
      for (const preset of options.tier ? ["pulse", "full"] : ["pulse"]) {
        await command(`/sidebar preset ${preset}`)
        await waitScreen(options.tier === "minimalist" ? /presets need/ : new RegExp(`${preset} preset`), preset)
        capture(preset)
        if (options.tier && options.tier !== "minimalist") {
          await keys("\x1b}")
          await keys("\x1b[6~")
          capture(`${preset}-scrolled`)
          await keys("\x1b")
        }
      }
      // Preserve room for the full map and the approval/queue panels on short terminals.
      if (options.tier && options.tier !== "minimalist") await command("/sidebar right")
      const graftTurn = turns
      await command("/graft")
      await until(() => turns > graftTurn, "graft-complete")
      if (options.tier !== "minimalist") await keys("\x0f")
      await waitScreen(options.tier === "minimalist" ? /renderToolCard/ : /callers.*callees/, "graft")
      capture("graft-expanded")
      for (const size of options.size ? [] : [[60, 20], [100, 30], [180, 50]] as const) {
        cols = size[0]
        rows = size[1]
        screen.resize(cols, rows)
        const frame = screen.frames
        terminal!.resize(cols, rows)
        // Bun.Terminal changes the size but does not notify this child's foreground group.
        cli!.kill("SIGWINCH")
        await until(() => screen.frames > frame, `resize-${cols}x${rows}`)
        await waitScreen(/renderToolCard/, `graft-${cols}x${rows}`)
        capture("graft-resize")
      }
      const beforeCompact = turns
      await command("/compact")
      await until(() => compacted && turns > beforeCompact, "compaction-complete")
      await command("/compaction")
      await waitScreen(/Compaction/, "compaction")
      capture("compaction")
      await keys("m")
      await waitScreen(/No summary/, "compaction-memory")
      capture("compaction-memory")
      await keys("\x1b")
      const beforeThread = turns
      await command(`/thread-check @thread:${long.sessionId} `)
      await until(() => turns > beforeThread, "thread-attached")
      await waitScreen(/faux thread snapshot received/, "thread")
      capture("thread")
      const beforeQueue = turns
      const beforeTool = toolStarted
      await command("/tool 3000")
      await until(() => toolStarted > beforeTool, "queue-tool-started")
      if (options.tier) capture("queue-tool")
      await command("queued smoke message")
      if (options.tier) {
        capture("queue-submitted")
        writeFileSync(path.join(options.frames, "queue-debug.json"), JSON.stringify(await client.send({ type: "queue.list", sessionId: current }), null, 2))
      }
      await command("/queue")
      if (options.tier) capture("queue-open")
      await waitScreen(/Queued · 1/, "queue-panel")
      await waitScreen(/queued smoke message/, "queue")
      capture("queue")
      await keys("\x1b")
      await until(() => turns >= beforeQueue + 2, "queue-drained")
      if (options.tier) {
        const beforeUsage = turns
        await command("/faux-usage")
        await until(() => turns > beforeUsage, "usage-recorded")
        const pages = [
          ["/mcp", /pending approval/, "mcp-pending"],
          ["/tree", /type (to )?search/i, "tree"],
          ["/changes replay", /message changes/i, "changes-replay"],
          ["/extensions", /extensions/i, "extensions"],
          ["/usage", /usage/i, "usage"],
          ["/context", /context/i, "context"],
          ["/pr", /Pull requests/, "pr"],
          ["/acp", /ACP agents/, "acp"],
        ] as const
        for (const [slash, match, name] of pages) {
          await command(slash)
          await waitScreen(match, name)
          await Bun.sleep(150)
          capture(name)
          if (name === "mcp-pending") {
            await keys("\x1b[6~")
            capture("mcp-pending-details")
          }
          if (name === "usage") for (const tab of ["2", "3", "4", "5", "6"]) {
            await keys(tab)
            capture(`usage-tab-${tab}`)
          }
          if (name === "context") for (const tab of ["2", "3"]) {
            await keys(tab)
            capture(`context-tab-${tab}`)
          }
          await keys("\x1b")
        }
      }
      await command("/faux-limit")
      await until(() => pause === "scheduled", "usage-limit")
      await waitScreen(options.tier === "minimalist" ? /esc cancel/ : /resume at reset \(armed\)/, "usage-limit-bar")
      capture("usage-limit")
      if (!options.tier) {
        await command("/tier minimalist")
        await waitScreen(/limit reached · resumes .*esc cancel/, "limit-tier")
        capture("usage-limit-minimalist")
      }
      // Open the pre-seeded long transcript via the actual session picker.
      await command("/sessions")
      await waitScreen(/Long smoke transcript/, "sessions")
      capture("sessions")
      // Filter the actual session picker, then open the selected fixture by Enter.
      await keys("Long smoke transcript")
      await keys("\r")
      await waitScreen(/\(118\)/, "long-transcript")
      capture("long-bottom")
      const bottom = screen.text()
      await keys("\x1b[5~")
      if (screen.text() === bottom) throw new Error("Page Up did not change the long transcript")
      capture("long-page-up")
      // Home reaches the loaded window's top and fetches the preceding page without losing the anchor.
      // Keep using the actual key until every earlier window has been loaded.
      for (let page = 0; page < 8 && !/\(0\)/.test(screen.text()); page++) await keys("\x1b[H")
      await waitScreen(/\(0\)/, "long-top")
      capture("long-top")
      await keys("\x1b[F")
      await waitScreen(/\(118\)/, "long-end")
      capture("long-end")
      if (options.tier) {
        await command("/changes replay")
        await waitScreen(/step 1\/2/, "replay-hunk")
        capture("changes-replay-hunk-1")
        await keys("\x1b[C")
        await waitScreen(/step 2\/2/, "replay-next")
        capture("changes-replay-hunk-2")
        await keys("\x1b")
        await keys("\x1b")
      }
    }
    await keys("\x18")
    await keys("q")
    await until(() => cli!.exitCode !== null, "cli-exit")
    if (cli!.exitCode !== 0) throw new Error(`CLI exit ${cli!.exitCode}`)
    const result = { target: "compiled", nativePty: true, engine: "faux", tier: options.tier, ascii: !!options.ascii, short: !!options.short, frames, streamedDeltas: deltas, completedTurns: turns, cliExit: cli!.exitCode }
    writeFileSync(path.join(options.frames, "result.json"), JSON.stringify(result, null, 2) + "\n")
    return result
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (cli) { try { capture("failed-final") } catch { /* Keep the original failure. */ } }
    try { writeFileSync(path.join(options.frames, "failure.json"), JSON.stringify({ status: /EPERM|EACCES/.test(message) ? "blocked" : "failed", message, frames }, null, 2) + "\n") } catch { /* Preserve the original error if the evidence directory itself is unwritable. */ }
    throw error
  } finally {
    client?.close()
    if (cli && cli.exitCode === null) {
      cli.kill("SIGKILL")
      await cli.exited
    }
    terminal?.close()
    if (daemon && daemon.exitCode === null) {
      daemon.kill("SIGTERM")
      await Promise.race([daemon.exited, Bun.sleep(2000)])
      if (daemon.exitCode === null) {
        daemon.kill("SIGKILL")
        await daemon.exited
      }
    }
    rmSync(temp, { recursive: true, force: true })
  }
}

export async function runPtyMatrix(frames: string) {
  const build = realpathSync(mkdtempSync(path.join(tmpdir(), "mend-pty-matrix-")))
  try {
    const target = await compiledTarget(build)
    const results = []
    for (const ascii of [false, true]) for (const tier of ["minimalist", "balanced", "full"] as const) for (const size of [[60, 20], [100, 30], [180, 50]] as const) {
      const name = `${ascii ? "ascii" : "colour"}-${tier}-${size.join("x")}`
      console.log(`PTY ${name}`)
      results.push(await runPtySmoke({ frames: path.join(frames, name), target, tier, size, ascii }))
    }
    writeFileSync(path.join(frames, "matrix.json"), JSON.stringify(results, null, 2) + "\n")
    return { cases: results.length, frames: results.reduce((sum, result) => sum + result.frames.length, 0) }
  } finally { rmSync(build, { recursive: true, force: true }) }
}

/** The right panel against a fresh compiled daemon: every preset and verb, at four sizes in each tier, from home and from a session with activity. */
export async function runPanelReview(frames: string, tiers: readonly Tier[] = ["full", "balanced", "minimalist"]) {
  const build = realpathSync(mkdtempSync(path.join(tmpdir(), "mend-panel-review-")))
  try {
    const target = await compiledTarget(build)
    const results = []
    for (const tier of tiers) for (const size of [[60, 20], [100, 30], [180, 50], [220, 60]] as const) {
      const name = `${tier}-${size.join("x")}`
      console.log(`PTY panel ${name}`)
      results.push(await runPtySmoke({ frames: path.join(frames, name), target, tier, size, panelReview: true }))
    }
    writeFileSync(path.join(frames, "panel-review.json"), JSON.stringify(results.map(({ tier, frames: list }) => ({ tier, frames: list.length })), null, 2) + "\n")
    return { cases: results.length, frames: results.reduce((sum, result) => sum + result.frames.length, 0) }
  } finally { rmSync(build, { recursive: true, force: true }) }
}

export async function runTuiBugs(frames: string) {
  const temp = realpathSync(mkdtempSync(path.join(tmpdir(), "mend-tui-bugs-build-")))
  try {
    const target = await compiledTarget(temp)
    const results = []
    for (const size of [[100, 30], [200, 60]] as const) results.push(await runPtySmoke({ frames: path.join(frames, size.join("x")), target, tier: "full", size, tuiBugs: true }))
    writeFileSync(path.join(frames, "tui-bugs.json"), JSON.stringify(results, null, 2) + "\n")
    return { cases: results.length, frames: results.reduce((sum, result) => sum + result.frames.length, 0) }
  } finally { rmSync(temp, { recursive: true, force: true }) }
}

if (import.meta.main) {
  const at = process.argv.indexOf("--frames")
  const frames = at >= 0 ? process.argv[at + 1] : path.join(ROOT, "captures/pty-smoke")
  if (!frames) throw new Error("--frames requires a directory")
  console.log(JSON.stringify(await (process.argv.includes("--panel-review") ? runPanelReview(frames, (process.argv.includes("--tiers") ? process.argv[process.argv.indexOf("--tiers") + 1]!.split(",") as Tier[] : ["full", "balanced", "minimalist"])) : process.argv.includes("--tui-bugs") ? runTuiBugs(frames) : process.argv.includes("--matrix") ? runPtyMatrix(frames) : runPtySmoke({ short: process.argv.includes("--short"), frames })), null, 2))
}
