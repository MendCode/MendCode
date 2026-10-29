import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs"
import path from "node:path"
import { tmpdir } from "node:os"
import { createClient } from "@mendcode/client"
import { startDaemon } from "@mendcode/daemon"
import { createFauxEngine } from "@mendcode/engine-faux"
import { TUI_DEFAULTS, TUI_OPERATIONS, type SessionId } from "@mendcode/protocol"
import { DEFAULT_TUI_PROFILE } from "../src/view/tui-profile"
import { parseAutomation, runAutomation, type AutomationDeps } from "../src/automation"
import { textWidth } from "../src/view/wrap"

const cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })
test("the native CLI and daemon share every profile default", () => {
  expect(TUI_DEFAULTS).toEqual(DEFAULT_TUI_PROFILE)
})
test("all ten control-plane commands parse, including v1 arguments, state and dry-run", () => {
  for (const operation of TUI_OPERATIONS) expect(parseAutomation(["control-plane", "tui", operation, ...(operation === "propose" ? ["--dry-run"] : []), "--dir", "/tmp/test-dir", "--json", "--state", "session"])).toMatchObject({ ok: true, command: { kind: "tui", operation, state: "session", dir: "/tmp/test-dir" } })
  expect(parseAutomation(["tui", "propose", "compact green", "--dry-run"])).toMatchObject({ ok: true, command: { argument: "compact green", dryRun: true } })
  expect(parseAutomation(["control-plane", "tui", "apply-preset", "--preset", "compact"])).toMatchObject({ ok: true, command: { argument: "compact" } })
  expect(parseAutomation(["tui", "preview", "--state", "fake"])).toMatchObject({ ok: false })
  expect(parseAutomation(["control-plane", "fake"])).toMatchObject({ ok: false })
  expect(parseAutomation(["tui", "propose", "compact"])).toMatchObject({ ok: false })
  expect(parseAutomation(["tui", "project", "--check"])).toMatchObject({ ok: true, command: { check: true } })
  expect(parseAutomation(["--dir", "/tmp/test-dir", "tui", "project", "--check"])).toMatchObject({ ok: true, command: { check: true } })
})
test("the CLI performs proposal/apply/rollback and exports actual native session frames through the daemon", async () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mend-cli-tui-")))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 0 }), log: () => {} })
  cleanup.push(() => daemon.stop())
  const client = createClient({ socketPath: daemon.socketPath, name: "tui-cli-test" })
  await client.connect()
  cleanup.push(() => client.close())
  const created = await client.send({ type: "session.create", directory: dir })
  const sessionId = (created.ok ? created.result?.sessionId : undefined) as SessionId
  let output = ""
  let errors = ""
  const deps: AutomationDeps = { client, cwd: dir, now: () => Date.now(), out: { write: (text) => { output += text } }, err: { write: (text) => { errors += text } }, listen() {} }
  const run = async (...args: string[]) => {
    const parsed = parseAutomation(["control-plane", "tui", ...args, "--json", "--dir", dir])
    if (parsed.ok !== true) throw new Error(JSON.stringify(parsed))
    output = ""
    expect(await runAutomation(parsed.command, deps)).toBe(0)
    return JSON.parse(output).data as Record<string, unknown>
  }
  const proposal = await run("propose", "compact green", "--dry-run")
  expect((await client.tuiQuery()).result?.profile).toMatchObject({ density: "comfortable" })
  const applied = await run("apply", String(proposal.proposalId))
  expect((await client.tuiQuery()).result?.profile).toMatchObject({ density: "compact" })
  await run("rollback", String(applied.backupId))
  for (const operation of ["preview", "project", "render"]) {
    const data = await run(operation, "--state", "session", "--session", sessionId)
    const files = data.artifacts as string[]
    for (const size of ["100x30", "180x50"]) {
      const frame = readFileSync(files.find((file) => file.endsWith("session-" + size + ".txt"))!, "utf8")
      const [cols, rows] = size.split("x").map(Number)
      const lines = frame.trimEnd().split("\n")
      // Preserve blank grid rows: only remove the final newline, not spaces.
      expect(frame.slice(0, -1).split("\n")).toHaveLength(rows!)
      expect(frame).not.toContain("\x1b")
      expect(lines.every((line) => textWidth(line) <= cols!)).toBe(true)
    }
  }
  expect(errors).toBe("")
})
