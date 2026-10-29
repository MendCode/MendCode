import { describe, expect, test } from "bun:test"
import { createVirtualClock } from "@mendcode/kernel"
import { CLAUDE_PROBE_TEXT, probeClaudeQuota, type ClaudeTransport } from "../src"

/** A stand-in for one `claude` process that answers what the probe writes, line by line, like the real stream-json protocol. */
function fakeProcess(script: { onInit?(push: (message: unknown) => void): void; onUser?(push: (message: unknown) => void): void; stderr?: string }) {
  const queue: string[] = []
  let wake: (() => void) | undefined
  let done = false
  const written: any[] = []
  let closed = 0
  const push = (message: unknown) => { queue.push(JSON.stringify(message)); wake?.() }
  const transport: ClaudeTransport = {
    write(line) {
      const message = JSON.parse(line)
      written.push(message)
      if (message.type === "control_request" && message.request?.subtype === "initialize") (script.onInit ?? ((p) => p({ type: "control_response", response: { subtype: "success", request_id: message.request_id } })))(push)
      if (message.type === "user") script.onUser?.(push)
    },
    lines: (async function* () {
      while (!done || queue.length) {
        if (queue.length) { yield queue.shift()!; continue }
        await new Promise<void>((resolve) => (wake = resolve))
      }
    })(),
    close() { closed += 1; done = true; wake?.() },
    exited: Promise.resolve(0),
    stderrTail: () => script.stderr ?? "",
  }
  return { transport, written, closed: () => closed }
}

const rateLimit = { type: "rate_limit_event", rate_limit_info: { status: "allowed", unifiedWindows: { five_hour: { utilization: 0.42, resetsAt: 1_791_036_000 }, seven_day: { utilization: 0.1, resetsAt: 1_791_400_000 } } } }

describe("claude quota probe", () => {
  test("one word, every tool off, no saved session, Haiku: and the windows of the rate_limit_event are reported", async () => {
    const fake = fakeProcess({ onUser(push) { push({ type: "system", subtype: "init", session_id: "x" }); push(rateLimit); push({ type: "result", subtype: "success", is_error: false }) } })
    let args: string[] = []
    let cwd = ""
    const reported: any[] = []
    await probeClaudeQuota({ model: "haiku", cwd: "/work", clock: createVirtualClock(5), transportFactory: (input) => { args = input.args; cwd = input.cwd; return fake.transport }, onQuota: (quota) => reported.push(quota) })
    // The process starts exactly where the caller said (the daemon gives it a private empty folder), never in some other cwd.
    expect(cwd).toBe("/work")
    expect(args).toContain("--model")
    expect(args[args.indexOf("--model") + 1]).toBe("haiku")
    expect(args[args.indexOf("--tools") + 1]).toBe("")
    expect(args).toContain("--no-session-persistence")
    // The user's own Claude Code hooks (a desktop notification per finished turn) never run for a probe.
    expect(JSON.parse(args[args.indexOf("--settings") + 1]!)).toEqual({ disableAllHooks: true })
    expect(args.some((arg) => arg.startsWith("--resume"))).toBe(false)
    const users = fake.written.filter((message) => message.type === "user")
    expect(users).toHaveLength(1)
    expect(users[0].message.content).toEqual([{ type: "text", text: CLAUDE_PROBE_TEXT }])
    expect(CLAUDE_PROBE_TEXT.length).toBeLessThanOrEqual(2)
    expect(reported).toHaveLength(1)
    expect(reported[0]).toMatchObject({ provider: "claude", windows: [{ label: "5h", usedPercent: 42 }, { label: "7d", usedPercent: 10 }] })
    expect(fake.closed()).toBeGreaterThanOrEqual(1)
  })

  test("the message is written only after Claude Code answered its initialize", async () => {
    let answerInit: (() => void) | undefined
    const fake = fakeProcess({
      onInit(push) { answerInit = () => push({ type: "control_response", response: { subtype: "success", request_id: "mend-probe-1" } }) },
      onUser(push) { push(rateLimit); push({ type: "result", subtype: "success" }) },
    })
    const done = probeClaudeQuota({ model: "haiku", cwd: "/work", transportFactory: () => fake.transport, onQuota: () => {} })
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(fake.written.map((message) => message.type)).toEqual(["control_request"])
    answerInit!()
    await done
    expect(fake.written.map((message) => message.type)).toEqual(["control_request", "user"])
  })

  test("a permission question is refused: a probe runs nothing", async () => {
    const fake = fakeProcess({ onUser(push) { push({ type: "control_request", request_id: "q1", request: { subtype: "can_use_tool", tool_name: "Bash" } }); push(rateLimit); push({ type: "result", subtype: "success" }) } })
    await probeClaudeQuota({ model: "haiku", cwd: "/work", transportFactory: () => fake.transport, onQuota: () => {} })
    const answer = fake.written.find((message) => message.type === "control_response")
    expect(answer.response.response.behavior).toBe("deny")
  })

  test("an answer with no rate_limit_event is a failure that names the last line of stderr", async () => {
    const fake = fakeProcess({ stderr: "Not logged in · Please run /login", onUser(push) { push({ type: "result", subtype: "success" }) } })
    await expect(probeClaudeQuota({ model: "haiku", cwd: "/work", transportFactory: () => fake.transport, onQuota: () => {} })).rejects.toThrow(/no rate limits.*Not logged in/)
    expect(fake.closed()).toBeGreaterThanOrEqual(1)
  })

  test("a process that never answers is stopped when the time runs out", async () => {
    const clock = createVirtualClock(0)
    const fake = fakeProcess({})
    const done = probeClaudeQuota({ model: "haiku", cwd: "/work", clock, timeoutMs: 1_000, transportFactory: () => fake.transport, onQuota: () => {} })
    await new Promise((resolve) => setTimeout(resolve, 5))
    clock.advance(1_000)
    await expect(done).rejects.toThrow(/timed out/)
    expect(fake.closed()).toBeGreaterThanOrEqual(1)
  })

  test("cancelling stops the process", async () => {
    const controller = new AbortController()
    const fake = fakeProcess({})
    const done = probeClaudeQuota({ model: "haiku", cwd: "/work", signal: controller.signal, transportFactory: () => fake.transport, onQuota: () => {} })
    await new Promise((resolve) => setTimeout(resolve, 5))
    controller.abort()
    await expect(done).rejects.toThrow(/cancelled/)
  })
})
