import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import path from "node:path"
import { tmpdir } from "node:os"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { TUI_DEFAULTS, type GlobalEvent, type SessionId } from "@mendcode/protocol"
import { startDaemon } from "../src"
import { createTuiControl } from "../src/tui-control"
import { promptContextParts } from "../src/prompt-context"

const cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })
function tmp() {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mend-tui-control-")))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
test("data-only schema covers CLI defaults, rejects bad profiles before writing, and preserves sidebar fields", () => {
  const dir = tmp()
  const control = createTuiControl(dir)
  const schema = control.run({ operation: "schema" })
  expect(Object.keys(schema.schema?.properties as object).sort()).toEqual(Object.keys(TUI_DEFAULTS).sort())
  expect(schema.profile).toEqual(TUI_DEFAULTS)
  expect(() => control.run({ operation: "apply", profile: { messageRenderer: "invalid" } })).toThrow("messageRenderer")
  expect(() => control.run({ operation: "apply", profile: { injected: true } })).toThrow("unknown field")
  expect(() => control.run({ operation: "apply", profile: { sidebarWidgets: [{ type: "fake" }] } })).toThrow("sidebar")
  expect(existsSync(schema.path)).toBe(false)
  control.run({ operation: "apply", profile: { username: "Nora", sidebarWidgets: [{ type: "context", options: {} }] } })
  control.run({ operation: "apply-preset", argument: "compact" })
  expect(control.run({ operation: "profile" }).profile).toMatchObject({ density: "compact", username: "Nora", sidebarWidgets: [{ type: "context" }] })
})
test("propose never applies, apply backs up, rollback restores, and traversal is refused", () => {
  const dir = tmp()
  const control = createTuiControl(dir)
  const proposal = control.run({ operation: "propose", argument: "compact green without worktree", dryRun: true })
  expect(proposal.profile).toMatchObject({ density: "compact", theme: "mendcode", showProject: false })
  expect(control.run({ operation: "profile" }).profile.density).toBe("comfortable")
  expect(proposal.proposalId).toBeTruthy()
  const applied = control.run({ operation: "apply", argument: proposal.proposalId })
  expect(control.run({ operation: "status" }).profile.density).toBe("compact")
  expect(applied.backupId).toBeTruthy()
  control.run({ operation: "rollback" })
  expect(control.run({ operation: "status" }).profile.density).toBe("comfortable")
  expect(() => control.run({ operation: "apply", argument: "../../outside" })).toThrow("id")
  expect(() => control.run({ operation: "rollback", argument: "missing" })).toThrow("Unknown")
})
test("preview and project preserve the live profile and save native artifacts", () => {
  const control = createTuiControl(tmp())
  const projected = control.run({ operation: "project", profile: { density: "compact" }, state: "session" })
  expect(JSON.parse(readFileSync(projected.artifacts![0]!, "utf8"))).toMatchObject({ architecture: "native-line-grid", state: "session", profile: { density: "compact" } })
  const rendered = control.run({ operation: "render", frames: [{ name: "home-100x30", lines: ["MendCode", "Build"] }] })
  expect(readFileSync(rendered.artifacts!.at(-1)!, "utf8")).toBe("MendCode\nBuild\n")
  expect(control.run({ operation: "status" }).profile.density).toBe("comfortable")
})
test("prompt modes apply v1 boundaries, use full native capabilities, and refuse escaped custom sources", () => {
  const dir = tmp()
  const project = tmp()
  const control = createTuiControl(dir)
  const parts = [{ id: "base", label: "native", text: "native harness" }, { id: "instructions", label: "project", text: "keep project rules" }]
  control.run({ operation: "apply", profile: { promptContext: "minimal" } })
  // The user's project instructions are in every mode, minimal and custom included; minimal also carries the one-line docs pointer.
  expect(promptContextParts(dir, project, parts)).toMatchObject([{ text: expect.stringContaining("Read before editing") }, { id: "self-knowledge", text: expect.stringContaining("docs --search <words>") }, { id: "instructions", text: "keep project rules" }])
  expect(promptContextParts(dir, project, parts)).toHaveLength(3)
  control.run({ operation: "apply", profile: { promptContext: "full" } })
  expect(promptContextParts(dir, project, parts).at(-1)?.id).toBe("capabilities")
  control.run({ operation: "apply", profile: { promptContext: "custom" } })
  expect(promptContextParts(dir, project, parts).map((part) => part.id)).toEqual(["boundary", "instructions"])
  const folder = path.join(project, ".mendcode", "prompts")
  mkdirSync(folder, { recursive: true })
  writeFileSync(path.join(folder, "custom.md"), "---\nname: Test prompt\n---\nWork at {{cwd}}")
  expect(promptContextParts(dir, project, parts)[1]?.text).toBe("Work at " + project)
  expect(promptContextParts(dir, project, parts).map((part) => part.id)).toEqual(["boundary", "base", "instructions"])
  const external = path.join(tmp(), "prompt.md")
  writeFileSync(external, "must not be loaded")
  symlinkSync(external, path.join(folder, "elsewhere.md"))
  // Rename to preserve the existing fixture; no product/user data is involved.
  renameSync(path.join(folder, "custom.md"), path.join(folder, "original.md"))
  renameSync(path.join(folder, "elsewhere.md"), path.join(folder, "custom.md"))
  expect(promptContextParts(dir, project, parts).map((part) => part.id)).toEqual(["boundary", "instructions"])
})

test("TUI commands and clipboard text are validated over the wire, with live profile events and legacy images", async () => {
  const dir = tmp()
  const changes: GlobalEvent[] = []
  const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), log: () => {}, engine: ({ clock }) => createFauxEngine({ clock }), clipboard: { readText: async () => "clipboard text", read: async () => ({ bytes: new Uint8Array([1, 2]), mime: "image/png" }) } })
  cleanup.push(() => daemon.stop())
  const client = createClient({ socketPath: daemon.socketPath, name: "tui-parity", onGlobal: (event) => changes.push(event) })
  await client.connect()
  cleanup.push(() => client.close())
  expect(await client.tuiQuery("schema")).toMatchObject({ ok: true, result: { valid: true } })
  expect(await client.send({ type: "attachment.clipboard", text: true })).toMatchObject({ ok: true, result: { kind: "text", text: "clipboard text" } })
  expect(await client.send({ type: "attachment.clipboard" })).toMatchObject({ ok: true, result: { name: "clipboard.png", attachment: { bytes: 2 } } })
  expect(await client.tuiChange({ operation: "apply", profile: { messageRenderer: "plain" } })).toMatchObject({ ok: true, result: { profile: { messageRenderer: "plain" } } })
  expect(changes.some((event) => event.type === "tui.changed" && event.profile.messageRenderer === "plain")).toBe(true)
  expect(await client.tuiChange({ operation: "apply", profile: { messageRenderer: "bad" } })).toMatchObject({ ok: false })
})
