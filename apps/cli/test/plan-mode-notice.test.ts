import { afterEach, expect, test } from "bun:test"
import { appHarness, cleanTemps, conversation, tempDir } from "./session-ui-harness"
import { planModeNotice, planModelId } from "../src/view/plan-mode-notice"

afterEach(cleanTemps)

const report = { engine: "native", selectable: true, models: [], defaults: { model: "gpt-6-luna" }, effective: { model: "gpt-6-luna" }, roles: { plan: { model: "gpt-6-astra" } } }

async function planSession() {
  const h = appHarness({ dataDir: tempDir(), width: 120, height: 30, reply: (command) => command.type === "models.list" ? { ok: true, result: report } as never : undefined })
  h.app.applySettings({ onboarded: true, tier: "balanced" })
  await h.type("")
  await Bun.sleep(5)
  return { h, chat: conversation(h.sessionId, h.app.onEvent) }
}

test("entering plan mode says it is read-only, who plans and that the user reviews; the footer names the plan model", async () => {
  const { h, chat } = await planSession()
  chat.emit({ type: "session.permission", mode: "plan" })
  await Bun.sleep(5)
  h.app.render()
  const screen = h.text().join("\n")
  expect(screen).toContain("Plan mode: read-only · GPT-6-Astra plans · you review first")
  expect(screen).toMatch(/Plan · GPT-6-Astra/)
  expect(screen).not.toMatch(/Plan · plan mode/)
  expect(screen).not.toMatch(/Plan · GPT-6-Luna/)
})

test("/plan with text enters plan mode and sends the text as the message; bare /plan only changes the mode", async () => {
  const { h } = await planSession()
  await h.type("/plan add a retry to fetch\r")
  await Bun.sleep(5)
  const commands = h.sent.filter((command) => command.type === "session.permission.set" || command.type === "user.submit")
  expect(commands).toMatchObject([{ type: "session.permission.set", mode: "plan" }, { type: "user.submit", text: "add a retry to fetch" }])
  await h.type("/plan\r")
  await Bun.sleep(5)
  expect(h.sent.filter((command) => command.type === "user.submit")).toHaveLength(1)
  expect(h.sent.filter((command) => command.type === "session.permission.set")).toHaveLength(2)
})

test("/plan with text while already planning sends the text and does not leave plan mode", async () => {
  const { h, chat } = await planSession()
  chat.emit({ type: "session.permission", mode: "plan" })
  await Bun.sleep(5)
  await h.type("/plan and the tests\r")
  await Bun.sleep(5)
  expect(h.sent.filter((command) => command.type === "session.permission.set")).toHaveLength(0)
  expect(h.sent.filter((command) => command.type === "user.submit")).toMatchObject([{ text: "and the tests" }])
})

test("/plan with text sends nothing when the daemon refuses the mode change", async () => {
  const h = appHarness({ dataDir: tempDir(), width: 120, height: 30, reply: (command) => command.type === "session.permission.set" ? { ok: false, error: { code: "invalid", message: "no" } } as never : undefined })
  h.app.applySettings({ onboarded: true, tier: "balanced" })
  await h.type("/plan add a retry\r")
  await Bun.sleep(5)
  expect(h.sent.filter((command) => command.type === "user.submit")).toHaveLength(0)
})

test("leaving plan mode names the agent and the model that run now, and other mode changes say nothing", async () => {
  const { h, chat } = await planSession()
  chat.emit({ type: "session.permission", mode: "plan" })
  chat.emit({ type: "session.permission", mode: "ask" })
  await Bun.sleep(5)
  h.app.render()
  expect(h.text().join("\n")).toMatch(/Plan mode off: build runs on .*luna/i)
  expect(h.text().join("\n")).toMatch(/Plan mode off: build runs on .*luna.* · ask before edits/i)
  expect(planModeNotice({ from: "plan", to: "full", report: undefined, planModel: undefined, buildModel: undefined, agent: undefined })).toBe("Plan mode off: build · full access")
  expect(planModeNotice({ from: "ask", to: "edits", report: undefined, planModel: undefined, buildModel: undefined, agent: undefined })).toBeUndefined()
  expect(planModeNotice({ from: "plan", to: "plan", report: undefined, planModel: undefined, buildModel: undefined, agent: undefined })).toBeUndefined()
})

test("the plan model is the plan role, else the session's own", () => {
  expect(planModelId(report as never, "gpt-6-luna")).toBe("gpt-6-astra")
  expect(planModelId({ ...report, roles: {} } as never, "gpt-6-luna")).toBe("gpt-6-luna")
})

test("an engine that runs the whole session plans on the session's model, whatever the plan role says", () => {
  const claude = { ...report, models: [{ id: "claude-opus", name: "Claude Opus", engine: "claude" }, { id: "gpt-6-luna", name: "GPT-6-Luna" }] }
  expect(planModelId(claude as never, "claude-opus")).toBe("claude-opus")
  expect(planModelId(claude as never, "acp:agent/model")).toBe("acp:agent/model")
  expect(planModelId(claude as never, "gpt-6-luna")).toBe("gpt-6-astra")
})

test("on a Claude Code session the notice and the footer name the session's model, not the plan role", async () => {
  const claude = { ...report, models: [{ id: "claude-opus", name: "Claude Opus", engine: "claude" }], defaults: { model: "claude-opus" }, effective: { model: "claude-opus" } }
  const h = appHarness({ dataDir: tempDir(), width: 120, height: 30, reply: (command) => command.type === "models.list" ? { ok: true, result: claude } as never : undefined })
  h.app.applySettings({ onboarded: true, tier: "balanced" })
  await h.type("")
  await Bun.sleep(5)
  conversation(h.sessionId, h.app.onEvent).emit({ type: "session.permission", mode: "plan" })
  await Bun.sleep(5)
  h.app.render()
  const screen = h.text().join("\n")
  expect(screen).toContain("Plan mode: read-only · Opus plans · you review first")
  expect(screen).not.toMatch(/Astra/)
})

test("leaving plan mode with Shift+Tab or /plan returns to the mode the session had before it; without one the cycle order stands", async () => {
  const { h, chat } = await planSession()
  const modes = () => h.sent.filter((command) => command.type === "session.permission.set").map((command) => (command as { mode: string }).mode)
  chat.emit({ type: "session.permission", mode: "full" })
  chat.emit({ type: "session.permission", mode: "plan" })
  await Bun.sleep(5)
  await h.app.onKey("\x1b[Z")
  await Bun.sleep(5)
  expect(modes()).toEqual(["full"])
  chat.emit({ type: "session.permission", mode: "full" })
  chat.emit({ type: "session.permission", mode: "plan" })
  await Bun.sleep(5)
  await h.type("/plan\r")
  await Bun.sleep(5)
  expect(modes()).toEqual(["full", "full"])
  // Other steps of the cycle are unchanged.
  chat.emit({ type: "session.permission", mode: "ask" })
  await Bun.sleep(5)
  await h.app.onKey("\x1b[Z")
  await Bun.sleep(5)
  expect(modes().at(-1)).toBe("edits")
})

test("a session that entered plan mode from ask before edits goes back to it", async () => {
  const { h, chat } = await planSession()
  chat.emit({ type: "session.permission", mode: "plan" })
  await Bun.sleep(5)
  await h.app.onKey("\x1b[Z")
  await Bun.sleep(5)
  expect(h.sent.filter((command) => command.type === "session.permission.set").map((command) => (command as { mode: string }).mode)).toEqual(["ask"])
})
