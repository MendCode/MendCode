import { afterEach, expect, test } from "bun:test"
import { peerCommandsHarness } from "./agent-commands-harness"
import { cleanTemps, NOW } from "./session-ui-harness"
import { textWidth } from "../src/view/wrap"

afterEach(cleanTemps)

test("command list selects exact records and target accept/reject refreshes real state", async () => {
  const h = peerCommandsHarness()
  await h.type("/agents commands\r")
  expect(h.app.page).toBe("agent-commands")
  expect(h.text().join("\n")).toContain("Client recovery")
  await h.type("a")
  expect(h.sentOf("session.agent-command.update")[0]).toMatchObject({ sessionId: h.target, commandId: h.commands[0]!.commandId, state: "accepted" })
  await h.type("x")
  expect(h.sentOf("session.agent-command.update")[1]).toMatchObject({ commandId: h.commands[1]!.commandId, state: "rejected" })
  await h.type("2")
  expect(h.text().join("\n")).toContain("completed")
  expect(h.text().join("\n")).toContain("Client recovery")
})

test("outgoing rows cannot approve, Enter opens the exact related session", async () => {
  const h = peerCommandsHarness()
  await h.type("/agents commands\r")
  await h.type("j")
  await h.type("j")
  await h.type("a")
  expect(h.sentOf("session.agent-command.update")).toHaveLength(0)
  await h.type("\r")
  expect(h.app.sessionId).toBe(h.source)
  expect(h.app.page).toBe("chat")
})

test("slash requests use protocol create and invalid input does not submit a turn", async () => {
  for (const [action, value, kind] of [["summary", "remaining work", "request_summary"], ["rename", "Client recovery", "rename"], ["tag", "ui,review", "tag"], ["pause", "review", "pause_after_turn"], ["stop", "review", "stop"], ["message", "Status?", "send_message"]]) {
    const h = peerCommandsHarness()
    await h.type(`/agents ${action} ${h.source} ${value}\r`)
    expect(h.sentOf("session.agent-command.create")[0]).toMatchObject({ sessionId: h.target, targetSessionId: h.source, request: { kind } })
    expect(h.sentOf("user.submit")).toHaveLength(0)
    await h.app.onKey("\x03")
  }
  const h = peerCommandsHarness()
  await h.type("/agents rename\r")
  expect(h.sentOf("session.agent-command.create")).toHaveLength(0)
  expect(h.sentOf("user.submit")).toHaveLength(0)
})

test("policy tab lists permissions, history exposes results and failure reasons", async () => {
  const h = peerCommandsHarness(180, 50)
  await h.type("/agents policy\r")
  expect(h.text().join("\n")).toContain("session.summary.read")
  expect(h.text().join("\n")).toContain("Pause and stop run only after the target accepts")
  await h.type("2")
  expect(h.text().join("\n")).toContain("Reconnect preserves queued commands")
  await h.type("j")
  expect(h.text().join("\n")).toContain("Target turn interrupted")
})

test("control requests say what accepting does and can be accepted or rejected", async () => {
  const h = peerCommandsHarness(180, 50)
  await h.type("/agents commands\r")
  await h.type("j")
  await h.type("j")
  await h.type("j")
  expect(h.text().join("\n")).toContain("Accepting")
  await h.type("a")
  expect(h.sentOf("session.agent-command.update").at(-1)).toMatchObject({ state: "accepted" })
})

test("push updates refresh this session's inbox, failures can be retried", async () => {
  const h = peerCommandsHarness()
  await h.type("/agents commands\r")
  const reads = h.sentOf("session.agent-command.list").length
  h.app.onGlobal({ type: "agent-commands.changed", gseq: 1, at: NOW, sourceSessionId: h.source, targetSessionId: h.target })
  await Bun.sleep(5)
  expect(h.sentOf("session.agent-command.list").length).toBe(reads + 1)
  h.setError("Inbox unavailable")
  await h.type("r")
  expect(h.text().join("\n")).toContain("Inbox unavailable")
  h.setError("")
  await h.type("r")
  expect(h.text().join("\n")).not.toContain("Inbox unavailable")
  await h.type("\x1b")
  expect(h.app.page).toBe("chat")
})

test("active/history/policy and errors fit compact through full-grid terminals", async () => {
  for (const [width, height] of [[60, 20], [100, 30], [160, 45], [180, 50], [220, 60]]) {
    const h = peerCommandsHarness(width, height)
    await h.type("/agents commands\r")
    for (const tab of ["1", "2", "3"]) {
      await h.type(tab)
      expect(h.text()).toHaveLength(height!)
      for (const row of h.text()) expect(textWidth(row)).toBeLessThanOrEqual(width!)
      expect(h.text().slice(0, 3).join("\n")).toContain("esc")
    }
    await h.app.onKey("\x03")
  }
})


test("Agent View applies command metadata without changing session navigation ids; c opens the inbox", async () => {
  for (const [width, height] of [[60, 20], [100, 30], [160, 45], [180, 50], [220, 60]]) {
    const h = peerCommandsHarness(width, height)
    h.setReport({ ...h.report(), metadata: [{ sessionId: h.target, title: "Client recovery", tags: ["client", "review"] }] })
    await h.type("/agents\r")
    expect(h.text().join("\n")).toContain("Client recovery")
    expect(h.text().join("\n")).toContain("#client #review")
    expect(h.text().join("\n")).toContain("working")
    expect(h.text().join("\n")).toContain("┌")
    expect(h.text().slice(0, 3).join("\n")).toContain(width! < 70 ? "c" : "c commands")
    for (const row of h.text()) expect(textWidth(row)).toBeLessThanOrEqual(width!)
    await h.type("2")
    expect(h.text().join("\n")).toContain("No finished shells")
    expect(h.text().join("\n")).toContain("┌")
    await h.type("c")
    expect(h.app.page).toBe("agent-commands")
    await h.app.onKey("\x03")
  }
})
