import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { tmpdir } from "node:os"
import { createClient } from "@mendcode/client"
import { startDaemon } from "../packages/daemon/src"
import type { SessionEvent } from "@mendcode/protocol"
import { fakeGithub, githubEvent } from "../packages/daemon/test/github-fake"
import { parseAutomation, runAutomation, type AutomationDeps } from "../apps/cli/src/automation"
import { appHarness, cleanTemps, conversation } from "../apps/cli/test/session-ui-harness"
import { parseStartup, prepareStartup } from "../apps/cli/src/startup"
import { DEFAULT_TUI_PROFILE, writeTuiProfile } from "../apps/cli/src/view/tui-profile"
import { fit } from "../apps/cli/src/view/deck"
import { textWidth, wrap } from "../apps/cli/src/view/wrap"

export async function renderB48Frames(directory: string, sizes: string[]) {
  mkdirSync(directory, { recursive: true })
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mend-b48-frames-"))), project = path.join(dir, "project")
  mkdirSync(project)
  const fake = fakeGithub(project)
  let listener: ((event: SessionEvent) => void) | undefined
  const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), githubProcess: fake.process, log: () => {}, engine: () => ({ needsCompaction: () => false, compact: async () => ({ status: "ok" }), async runTurn(input) {
    const itemId = input.newItemId()
    input.emit({ type: "item.started", itemId, kind: "agent_message" })
    input.emit({ type: "item.delta", itemId, text: "The parser now rejects malformed options and preserves empty input." })
    input.emit({ type: "item.completed", itemId, status: "ok", text: "The parser now rejects malformed options and preserves empty input." })
    return { status: "ok" }
  } }) })
  const client = createClient({ socketPath: daemon.socketPath, name: "b48-frames", onEvent: (event) => listener?.(event) })
  try {
    await client.connect()
    const reports = new Map<string, string>()
    for (const [name, args] of [
      ["github-help", ["github", "--help"]],
      ["github-install-preview", ["github", "install", "--model", "openai/model"]],
      ["github-install-written", ["github", "install", "--model", "openai/model", "--write"]],
      ["github-run-local", ["github", "run", "--event", githubEvent(), "--token", "local-fake"]],
      ["github-run-review", ["github", "run", "--event", githubEvent("pull_request_review_comment"), "--token", "local-fake"]],
      ["github-run-published", ["github", "run", "--event", githubEvent(), "--token", "local-fake", "--publish"]],
      ["github-run-schedule", ["github", "run", "--event", githubEvent("schedule"), "--token", "local-fake", "--prompt", "Check parser"]],
      ["github-run-missing-token", ["github", "run", "--event", githubEvent()]],
      ["pr-checkout", ["pr", "42", "--no-tui"]],
    ] as const) {
      const parsed = parseAutomation([...args])
      if (parsed.ok !== true) throw new Error(`Invalid frame command ${name}`)
      let output = ""
      const deps: AutomationDeps = { client, cwd: project, env: {}, listen: (fn) => { listener = fn }, now: Date.now, onInterrupt() {}, out: { write: (text) => { output += text } }, err: { write: (text) => { output += text } } }
      const code = await runAutomation(parsed.command, deps)
      if (code !== (name === "github-run-missing-token" ? 64 : 0)) throw new Error(`Frame command failed: ${name}: ${output}`)
      // Session IDs and random branch suffixes are omitted from visual evidence, not from runtime output.
      reports.set(name, output.replace(/session: [^\n]+/g, "session: local fixture").replace(/mendcode\/((?:pr|issue)\d+|schedule|dispatch)-[a-f0-9]{8}/g, "mendcode/$1-fixture"))
    }
    const checked = await client.checkoutPr(project, 42)
    if (!checked.ok) throw new Error(checked.error.message)
    const selected = await prepareStartup(client, parseStartup(["--cwd", checked.report.directory]), checked.report.directory, "")
    writeTuiProfile(dir, { ...DEFAULT_TUI_PROFILE, homeLayout: "split", homeRightPanel: "actions", pet: "off", images: "off" })
    for (const size of sizes.length ? sizes : ["100x30", "180x50"]) {
      const match = /^(\d+)x(\d+)$/.exec(size)
      if (!match) throw new Error("Invalid frame size")
      const width = Number(match[1]), height = Number(match[2])
      const save = (name: string, rows: string[]) => {
        if (rows.length !== height || rows.some((row) => textWidth(row) !== width || row.includes("\x1b"))) throw new Error(`Invalid frame ${name}`)
        writeFileSync(path.join(directory, `${name}-${size}.txt`), rows.join("\n") + "\n")
      }
      for (const [name, output] of reports) {
        const rows = wrap(output.trimEnd(), width)
        for (let page = 0; page * height < rows.length; page++) save(`${name}${rows.length > height ? `-p${page + 1}` : ""}`, Array.from({ length: height }, (_, index) => fit([{ text: rows[page * height + index] ?? "" }], width).map((span) => span.text).join("")))
      }
      const h = appHarness({ width, height, dataDir: dir, directory: selected.directory, sessionId: selected.sessionId })
      h.app.applySettings({ onboarded: true })
      h.app.render()
      save("pr-home", h.text().map((row) => fit([{ text: row }], width).map((span) => span.text).join("")))
      conversation(h.sessionId, h.app.onEvent).exchange("Review PR #42", "The parser handles empty input. The malformed option path needs a guard before dispatch.")
      h.app.render()
      save("pr-session", h.text().map((row) => fit([{ text: row }], width).map((span) => span.text).join("")))
      await h.app.onKey("\x03")
    }
  } finally { client.close(); await daemon.stop(); cleanTemps(); rmSync(dir, { recursive: true, force: true }) }
}
