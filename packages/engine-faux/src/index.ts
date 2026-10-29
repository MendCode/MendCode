import type { Clock, EnginePort, TurnOutcome } from "@mendcode/kernel"

/**
 * Deterministic engine for development, fixtures and tests (no network, no API keys).
 * Text commands in the user message drive its behavior:
 *   "/tool <ms>"   – runs a fake tool for <ms> milliseconds
 *   "/hang"        – starts a tool that never finishes (crash/recovery tests)
 *   "/ask"         – asks for approval before answering
 *   "/fail"        – ends the turn with an error
 *   "/usage" or "/faux-usage" – records token usage (the latter bypasses the TUI page)
 *   "/say TEXT"    – answers TEXT verbatim (scripted-run tests: JSON answers)
 *   "/faux-limit" – reports a synthetic usage limit (PTY smoke, no provider)
 *   "/graft"      – emits a synthetic graft trace (PTY smoke, no MCP process)
 *   "/faux-activity" – emits read/edit/write tools with declared file paths, a todo list and one timed call (right-panel review)
 *   "/thread-check @thread:ID" – acknowledges only a daemon-expanded snapshot
 * Anything else is echoed back in small deltas.
 */
export function createFauxEngine(options: { clock: Clock; deltaMs?: number }): EnginePort {
  const deltaMs = options.deltaMs ?? 5

  const sleep = (ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve) => {
      if (signal.aborted) return resolve()
      const timer = options.clock.setTimer(ms, resolve)
      signal.addEventListener("abort", () => (timer.cancel(), resolve()), { once: true })
    })

  /** Deterministic rich turn for visual fixtures: a tool with output, then Markdown with every block type. */
  async function demo(input: Parameters<EnginePort["runTurn"]>[0]): Promise<TurnOutcome> {
    const tool = input.newItemId()
    input.emit({ type: "item.started", itemId: tool, kind: "tool_call", meta: { tool: "bun test packages/kernel" } })
    for (const line of ["session-actor.test.ts:", "  ✓ queues during generation", "  ✓ cancel is targeted", "  ✓ Send now in one command", "job-scheduler.test.ts:", "  ✓ Dream yields to foreground", "", " 21 pass  0 fail"]) {
      input.emit({ type: "item.delta", itemId: tool, text: `${line}\n` })
      await sleep(deltaMs, input.signal)
    }
    input.emit({ type: "item.completed", itemId: tool, status: "ok" })
    const answer = input.newItemId()
    input.emit({ type: "item.started", itemId: answer, kind: "agent_message" })
    const markdown = [
      "## Result",
      "",
      "The **kernel** tests pass. The key change is in `session-actor.ts`:",
      "",
      "- the actor owns the queue, never Dream",
      "- `Send now` promotes in **one** command",
      "- cancel requires a `turnId`",
      "",
      "```ts",
      "if (active.turnId !== command.turnId) return mismatch()",
      "```",
      "",
      "> Next: measure with [the soak](benchmarks/soak.ts).",
    ].join("\n")
    for (let i = 0; i < markdown.length; i += 12) {
      input.emit({ type: "item.delta", itemId: answer, text: markdown.slice(i, i + 12) })
      await sleep(deltaMs, input.signal)
    }
    input.emit({ type: "item.completed", itemId: answer, status: "ok", text: markdown })
    return { status: "ok" }
  }

  return {
    async runTurn(input): Promise<TurnOutcome> {
      const text = input.text.trim()
      if (text === "/faux-limit") return { status: "error", code: "usage_limit_reached", message: 'faux 429 usage_limit_reached {"resets_in_seconds":3600}' }
      if (text === "/graft") {
        const itemId = input.newItemId()
        input.emit({ type: "item.started", itemId, kind: "tool_call", meta: { tool: "mcp__graft__graft_trace_calls: renderToolCard" } })
        input.emit({ type: "item.completed", itemId, status: "ok", text: [
          "renderToolCard · function · apps/cli/src/view/tool-card.ts:L237-L252",
          "  calls ← defaultBody (apps/cli/src/view/transcript.ts:L399-L514)",
          "  calls ← toolCardTest (apps/cli/test/tool-card.test.ts:L7-L40)",
          "  calls → cardRows (apps/cli/src/view/tool-card.ts:L254-L317) [depth 1]",
          "  calls → computerCard (apps/cli/src/view/computer-card.ts:L7-L39) [depth 2]",
        ].join("\n") })
        return { status: "ok" }
      }
      if (text === "/faux-activity") {
        // Synthetic session activity for the right-panel review: tools declaring files, a todo list and a timed, priced call.
        for (const [tool, path] of [["read", "src/panel.ts"], ["edit", "src/panel.ts"], ["write", "src/orbit.ts"]] as const) {
          const itemId = input.newItemId()
          input.emit({ type: "item.started", itemId, kind: "tool_call", meta: { tool: `${tool}: ${path}` } })
          await sleep(deltaMs, input.signal)
          input.emit({ type: "item.completed", itemId, status: "ok", text: `${tool} ${path}`, meta: { path, savedTokens: 120, filter: "graft" } })
        }
        const todo = input.newItemId()
        input.emit({ type: "item.started", itemId: todo, kind: "tool_call", meta: { tool: "todo" } })
        input.emit({ type: "item.completed", itemId: todo, status: "ok", text: "[x] Read the panel code\n[~] Fix the next cycle\n[ ] Add regression tests" })
        input.emit({ type: "usage", provider: "faux", model: "echo", input: 12_000, output: 900, reasoning: 200, cacheRead: 9_000, cacheWrite: 0, costMicros: 20_000, profile: { estimatedTokens: { instructions: 0, memory: 0, history: 0, toolResults: 0, toolSchemas: 0, media: 0, total: 0 }, firstTokenMs: 500, durationMs: 9_000, toolCount: 4, imageCount: 0 } })
      }
      if (text === "/fail") return { status: "error", code: "faux_failure", message: "requested failure" }
      if (text === "/demo") return demo(input)
      if (text.startsWith("/tool") || text === "/hang") {
        const itemId = input.newItemId()
        input.emit({ type: "item.started", itemId, kind: "tool_call", meta: { tool: "faux" } })
        if (text === "/hang") {
          await new Promise<void>((resolve) => input.signal.addEventListener("abort", () => resolve(), { once: true }))
          return { status: "ok" }
        }
        await sleep(Number(text.split(/\s+/)[1] ?? 50), input.signal)
        if (input.signal.aborted) return { status: "ok" }
        input.emit({ type: "item.completed", itemId, status: "ok", text: "tool done" })
      }
      if (text === "/ask") {
        const answer = await input.ask({ kind: "approval", title: "faux tool", detail: "run faux tool?" })
        if (answer.kind !== "approve") return { status: "ok" }
      }
      if (text === "/faux-question") {
        await input.ask({ kind: "question", title: "faux question", detail: "Choose a direction", options: [{ label: "First" }, { label: "Second" }] })
      }
      if (text === "/usage" || text === "/faux-usage") {
        input.emit({ type: "usage", provider: "faux", model: "echo", input: text.length, output: text.length + 6, reasoning: 0, cacheRead: 0, cacheWrite: 0 })
      }
      const itemId = input.newItemId()
      input.emit({ type: "item.started", itemId, kind: "agent_message" })
      const reply = text.startsWith("/thread-check ")
        ? text.includes("<thread-snapshot ") ? "faux thread snapshot received" : "faux thread snapshot missing"
        : text.startsWith("/say ") ? text.slice(5) : `echo: ${text}`
      for (let i = 0; i < reply.length; i += 8) {
        if (input.signal.aborted) return { status: "ok" }
        input.emit({ type: "item.delta", itemId, text: reply.slice(i, i + 8) })
        await sleep(deltaMs, input.signal)
      }
      input.emit({ type: "item.completed", itemId, status: "ok", text: reply })
      return { status: "ok" }
    },
    needsCompaction: () => false,
    compact: async () => ({ status: "ok" }),
    // Explicitly synthetic, stateless data for the real /context path in offline PTY checks.
    contextReport: async () => ({
      model: "faux fixture", contextWindow: 32_000, compactAtTokens: 24_000,
      estimatedTokens: 6_000, images: 0,
      sections: [
        { id: "system", label: "Fixture system", chars: 4_000, tokens: 1_000 },
        { id: "tools", label: "Fixture tools", chars: 4_000, tokens: 1_000, count: 2 },
        { id: "history", label: "Fixture messages", chars: 16_000, tokens: 4_000, count: 8 },
      ],
      largest: [{ role: "assistant", chars: 8_000, tokens: 2_000, preview: "Synthetic PTY context; no provider or local files read." }],
      files: [{ path: "src/fixture/long-directory/context-example.ts", reads: 2, edits: 1, tokens: 800 }],
    }),
  }
}
