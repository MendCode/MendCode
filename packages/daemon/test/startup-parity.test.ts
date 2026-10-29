import { afterEach, expect, test } from "bun:test"
import { mkdirSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { Command, createIdFactory, isReadOnlyCommand } from "@mendcode/protocol"
import { parseStartup, prepareStartup, prepareRunSubmission } from "../../../apps/cli/src/startup"
import { createHeadlessRun } from "../../../apps/cli/src/run"
import { writeDiagnosticsSnapshot } from "../src/diagnostics"
import { boot, put, say, stop, callTool, type NativeHarness } from "./native-harness"

const harnesses: NativeHarness[] = []
afterEach(async () => { for (const h of harnesses.splice(0)) await h.cleanup() })
async function start(options: Parameters<typeof boot>[0] = {}) {
  const h = await boot(options)
  harnesses.push(h)
  return h
}

test("startup model, variant, agent and optional title reach native execution", async () => {
  const h = await start({ steps: [stop("Selected.")] })
  const options = parseStartup(["run", "review", "--model", "openai/gpt-6-sol", "--variant", "high", "--agent", "plan", "--title"])
  const selected = await prepareStartup(h.client, options, h.project, "review")
  expect(h.store.sessionModel(selected.sessionId)).toEqual({ model: "gpt-6-sol", variant: "high" })
  const detail = await h.client.getSession(selected.sessionId)
  expect(detail.ok && detail.session.title).toBe("review")
  expect(detail.ok && detail.session.permission).toBe("plan")
  await say(h, selected.sessionId, "review")
  expect(h.requests[0]?.model).toBe("gpt-6-sol")
  const models = await h.client.send({ type: "models.list", sessionId: selected.sessionId })
  expect(models.ok && models.result?.effective).toMatchObject({ model: "gpt-6-sol", effort: "high" })
})

test("invalid primary agent and unknown model create no sessions", async () => {
  const h = await start()
  for (const args of [["--agent", "explore"], ["--agent", "missing"], ["--model", "missing"]]) {
    await expect(prepareStartup(h.client, parseStartup(args), h.project)).rejects.toThrow()
  }
  const listed = await h.client.send({ type: "session.list", directory: h.project })
  expect(listed.ok && listed.result?.sessions).toEqual([])
})

test("continue selects a project root, fork copies transcript without altering its parent", async () => {
  const h = await start({ steps: [stop("Original answer.")] })
  const original = await prepareStartup(h.client, parseStartup(["run", "go", "--title=Original"]), h.project)
  await say(h, original.sessionId, "Original question")
  const fork = await prepareStartup(h.client, parseStartup(["--session", original.sessionId, "--fork", "--title=Branch", "--model", "gpt-6-sol"]), h.project)
  expect(fork.sessionId).not.toBe(original.sessionId)
  const detail = await h.client.inspectSession(fork.sessionId)
  expect(detail.ok && JSON.stringify(detail.snapshot)).toContain("Original answer.")
  expect(h.store.sessionModel(original.sessionId)).toBeUndefined()
  expect(h.store.sessionModel(fork.sessionId)).toEqual({ model: "gpt-6-sol" })
  await h.client.send({ type: "session.create", directory: h.project, parentId: fork.sessionId })
  const continued = await prepareStartup(h.client, parseStartup(["--continue"]), h.project)
  expect(continued.sessionId).toBe(fork.sessionId)
})

test("headless command preserves arguments and attaches UTF-8, images and bounded directory listings", async () => {
  const h = await start({ steps: [stop("Reviewed.")] })
  put(path.join(h.project, ".mendcode/commands/review.md"), "Review $ARGUMENTS")
  put(path.join(h.project, "notes.txt"), "project notes")
  mkdirSync(path.join(h.project, "folder"))
  put(path.join(h.project, "folder/child.txt"), "not implicitly read")
  writeFileSync(path.join(h.project, "shot.png"), new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]))
  const options = parseStartup(["run", "changes", "--command", "review", "--file", "notes.txt", "shot.png", "folder"], { cwd: h.project })
  const selected = await prepareStartup(h.client, options, h.project)
  const submission = await prepareRunSubmission(h.client, options, selected.sessionId, h.project, "changes")
  expect(submission.type).toBe("commands.execute")
  if (submission.type !== "commands.execute") throw new Error("not a command")
  expect(submission.args).toBe("changes")
  expect(submission.contextText).toContain("\n\n[notes.txt]\nproject notes")
  expect(submission.attachments?.[0]?.mime).toBe("image/png")
  expect(submission.contextText).toContain("child.txt")
  expect(submission.contextText).not.toContain("not implicitly read")
  expect((await h.client.send(submission)).ok).toBe(true)
})

test("missing attachments and binary content fail before user.submit", async () => {
  const h = await start()
  writeFileSync(path.join(h.project, "binary.bin"), new Uint8Array([255, 254, 0]))
  const selected = await prepareStartup(h.client, parseStartup([]), h.project)
  for (const file of ["missing.txt", "binary.bin"]) await expect(prepareRunSubmission(h.client, parseStartup(["run", "--file", file]), selected.sessionId, h.project, "")).rejects.toThrow()
  expect(h.requests).toHaveLength(0)
})

test("diagnostics reports process memory; heap capture is private and never read-only", async () => {
  const h = await start()
  const report = await h.client.diagnosticsResources()
  expect(report.ok && report.report.memory?.rss).toBeGreaterThan(0)
  expect(report.ok && report.report.pid).toBe(process.pid)
  const ids = createIdFactory()
  expect(Command.parse({ type: "diagnostics.snapshot", id: ids("command"), clientId: ids("client") }).type).toBe("diagnostics.snapshot")
  expect(isReadOnlyCommand("diagnostics.snapshot")).toBe(false)
  const file = await writeDiagnosticsSnapshot(h.dir, (target) => { writeFileSync(target!, "snapshot"); return target! })
  expect(file.startsWith(path.join(h.dir, "diagnostics/daemon-"))).toBe(true)
  expect(statSync(file).mode & 0o777).toBe(0o600)
  expect(statSync(path.dirname(file)).mode & 0o777).toBe(0o700)
})

test("headless permission bypass does not defeat an explicit plan-agent denial", async () => {
  const h = await start({ steps: [callTool("write", { file: "denied.txt", content: "no" }), stop("Denied.")] })
  const selected = await prepareStartup(h.client, parseStartup(["run", "go", "--agent", "plan", "--dangerously-skip-permissions"]), h.project)
  let out = ""
  const run = createHeadlessRun({ client: h.client, sessionId: selected.sessionId, prompt: "go", json: false, approve: true, out: { write: (text: string) => { out += text } }, err: { write() {} } })
  await h.client.subscribe(selected.sessionId, 0)
  const timer = setInterval(() => { for (const event of h.events.splice(0)) run.onEvent(event) }, 5)
  try {
    expect(await run.start()).toBe(0)
    expect(out).toContain("Denied.")
    expect(h.requests[1]?.messages.some((message) => JSON.stringify(message).toLowerCase().includes("denied"))).toBe(true)
  } finally { clearInterval(timer) }
})
