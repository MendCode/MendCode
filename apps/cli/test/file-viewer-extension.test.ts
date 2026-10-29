import { afterEach, expect, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { viewFile } from "../../../packages/daemon/src/file-view"
import { appHarness, extension, scratch } from "./extensions-harness"
import { numbered } from "./file-viewer-helpers"

const made: Array<ReturnType<typeof scratch>> = []
const store = globalThis as unknown as { __ext?: Record<string, unknown> }
afterEach(() => {
  for (const item of made.splice(0)) item.cleanup()
  delete store.__ext
})

function layout() {
  const next = scratch()
  made.push(next)
  store.__ext = {}
  mkdirSync(path.join(next.project, "src"), { recursive: true })
  writeFileSync(path.join(next.project, "AGENTS.md"), numbered(40, "rule"))
  return next
}

const reply = (command: Record<string, unknown>) =>
  command.type === "file.view"
    ? viewFile({ directory: String(command.directory), path: String(command.path), from: command.from as number | undefined, count: command.count as number | undefined }).then((result) => ({ ok: true, result })).catch((error) => ({ ok: false, error: { code: "invalid_command", message: String(error.message) } }))
    : undefined

test("an extension opens a file in the viewer with api actions.openFile, at a line range", async () => {
  const { dataDir, project, write } = layout()
  write("data/extensions/show.ts", extension("show", `api.command("show", "Open a file", (args, actions) => actions.openFile(args, { from: 5, to: 8 }))`))
  const h = await appHarness({ dataDir, directory: project, width: 160, height: 40, reply })
  await h.start({ onboarded: true, tier: "balanced" })
  h.message("hello", "world")
  await h.type("/show AGENTS.md")
  await h.key("\r")
  await Bun.sleep(40)
  h.app.render()
  expect(h.text()).toContain("‹ AGENTS.md · 40 lines")
  expect(h.text()).toContain("rule 5")
  expect(h.sent.filter((command) => command.type === "file.view").length).toBe(1)
})

test("an extension cannot open what the workspace does not hold", async () => {
  const { dataDir, project, write } = layout()
  write("data/extensions/show.ts", extension("show", `api.command("show", "Open a file", (args, actions) => actions.openFile(args))`))
  const h = await appHarness({ dataDir, directory: project, width: 160, height: 40, reply })
  await h.start({ onboarded: true, tier: "balanced" })
  h.message("hello", "world")
  await h.type("/show /etc/hosts")
  await h.key("\r")
  await Bun.sleep(40)
  h.app.render()
  expect(h.text()).not.toContain("‹ hosts")
  expect(h.text()).toContain("outside the workspace")
  expect(h.sent.filter((command) => command.type === "file.view")).toEqual([])
})
