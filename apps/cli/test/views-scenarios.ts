import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { SessionSummary } from "@mendcode/protocol"
import type { CommandReply } from "@mendcode/client"
import type { Line } from "../src/ui/theme"
import { DEFAULT_TUI_PROFILE, writeTuiProfile, type TuiProfile } from "../src/view/tui-profile"
import { appHarness, ids, NOW, plain, tempDir } from "./session-ui-harness"

/**
 * Realistic sessions drawn through the real app at 100x30 and 200x60. `views-golden.test.ts` compares each frame
 * with the recorded one (`test/fixtures/views-golden`): the view-slot contract must not change the default look.
 * Regenerate only after a deliberate visual change: `bun apps/cli/test/views-scenarios.ts --write`.
 */
export const SIZES = [{ width: 100, height: 30 }, { width: 200, height: 60 }] as const
export type Scenario = { name: string; run(size: (typeof SIZES)[number]): Promise<Line[]> }

const reply = (result: unknown) => ({ ok: true, result }) as CommandReply

/** A session with every kind of transcript block: messages, reasoning, tool calls of several kinds, a failure and a turn end. */
export function conversation(h: ReturnType<typeof appHarness>) {
  let seq = 0
  let clock = NOW - 600_000
  const emit = (body: Record<string, unknown>) => {
    clock += 1_000
    h.app.onEvent({ sessionId: h.sessionId, seq: ++seq, at: clock, ...body } as never)
  }
  const message = (turnId: string, kind: "user_message" | "agent_message" | "reasoning", text: string) => {
    const itemId = ids("item")
    emit({ type: "item.started", turnId, itemId, kind })
    emit({ type: "item.completed", itemId, status: "ok", text })
    return itemId
  }
  const tool = (turnId: string, title: string, text: string, status: "ok" | "error" = "ok", meta: Record<string, unknown> = {}) => {
    const itemId = ids("item")
    emit({ type: "item.started", turnId, itemId, kind: "tool_call", meta: { tool: title } })
    emit({ type: "item.completed", itemId, status, text, meta })
    return itemId
  }
  const turn = ids("turn")
  emit({ type: "turn.started", turnId: turn, queueId: ids("queue") })
  message(turn, "user_message", "Why does the second session see the first one's config? Please look at src/store.ts and fix it.")
  message(turn, "reasoning", "The cache key might ignore the directory. I should read the store module first and check how the key is built before touching anything.")
  tool(turn, "read: src/store.ts", Array.from({ length: 14 }, (_, i) => `${String(i + 1).padStart(6)}\tconst line${i} = cache.get(name)`).join("\n"))
  tool(turn, "grep: cache.get", "src/store.ts:12:const hit = cache.get(name)\nsrc/store.ts:40:return cache.get(key) ?? load(key)\nsrc/config.ts:7:cache.get(path)")
  tool(turn, "shell: bun test src/store.test.ts", "bun test v1.3\n\n3 pass\n1 fail\nerror: expected \"a\" received \"b\"\n", "error", { exitCode: 1, durationMs: 1840 })
  tool(turn, "edit: src/store.ts", "Edited src/store.ts\n- const key = name\n+ const key = `${directory}:${name}`", "ok")
  message(turn, "agent_message", "The cache key ignored the directory.\n\n```ts\nconst key = `${directory}:${name}`\nreturn cache.get(key) ?? load(key)\n```\n\n- both sessions now get their own entry\n- the **test** passes after the change\n\nSee [the docs](https://example.com) for details.")
  emit({ type: "turn.completed", turnId: turn })
  const second = ids("turn")
  emit({ type: "turn.started", turnId: second, queueId: ids("queue") })
  message(second, "user_message", "Thanks. Run the whole suite once more.")
  tool(second, "shell: bun test", "bun test v1.3\n\n212 pass\n0 fail\n", "ok", { exitCode: 0, durationMs: 9100 })
  message(second, "agent_message", "All 212 tests pass.")
  emit({ type: "turn.completed", turnId: second })
  h.app.render()
  return { emit, message, tool }
}

function session(size: (typeof SIZES)[number], sessions: SessionSummary[] = [], profile: Partial<TuiProfile> = {}, mode: "minimal" | "balanced" | "full" = "balanced") {
  const current = ids("session")
  const dir = tempDir()
  writeTuiProfile(dir, { ...DEFAULT_TUI_PROFILE, ...profile })
  return appHarness({ ...size, mode, sessionId: current, dataDir: dir, directory: "/work/app", reply: (command) => (command.type === "session.list" ? reply({ sessions: sessions.map((s) => ({ ...s, sessionId: s.sessionId || current })) }) : undefined) })
}

const summary = (title: string, minutesAgo: number, patch: Partial<SessionSummary> = {}): SessionSummary => ({ sessionId: ids("session"), title, directory: "/work/app", createdAt: NOW - 3_600_000, updatedAt: NOW - minutesAgo * 60_000, lastSeq: 0, state: "idle", queued: 0, ...patch }) as SessionSummary

export const SCENARIOS: Scenario[] = [
  {
    name: "session",
    async run(size) {
      const h = session(size, [summary("Cache key bug", 2), summary("Earlier work", 90), summary("Release notes", 300, { state: "generating" })])
      h.app.applySettings({})
      await Bun.sleep(5)
      conversation(h)
      await Bun.sleep(2)
      h.app.render()
      return h.frames.at(-1)!
    },
  },
  {
    name: "session-top",
    async run(size) {
      const h = session(size, [], { reasoning: "expanded" })
      h.app.applySettings({})
      conversation(h)
      for (let i = 0; i < 6; i++) await h.type("\x1b[5~")
      return h.frames.at(-1)!
    },
  },
  {
    name: "approval",
    async run(size) {
      const h = session(size)
      h.app.applySettings({})
      conversation(h)
      const turnId = ids("turn")
      h.app.onEvent({ sessionId: h.sessionId, seq: 500, at: NOW, type: "turn.started", turnId, queueId: ids("queue") } as never)
      h.app.onEvent({ sessionId: h.sessionId, seq: 501, at: NOW, type: "server.request", requestId: ids("request"), turnId, kind: "approval", title: "shell", detail: "rm -rf build && bun run build --minify", tool: "shell", permission: "execute", permissionContext: { name: "bash", patterns: ["rm -rf build && bun run build --minify"], always: ["bun run build *"] } } as never)
      h.app.render()
      return h.frames.at(-1)!
    },
  },
  {
    name: "question",
    async run(size) {
      const h = session(size)
      h.app.applySettings({})
      conversation(h)
      const turnId = ids("turn")
      h.app.onEvent({ sessionId: h.sessionId, seq: 500, at: NOW, type: "turn.started", turnId, queueId: ids("queue") } as never)
      h.app.onEvent({ sessionId: h.sessionId, seq: 501, at: NOW, type: "server.request", requestId: ids("request"), turnId, kind: "question", title: "Which test runner should I use?", detail: "The repo has both.", options: [{ label: "bun test", description: "fast, already used" }, { label: "vitest" }] } as never)
      h.app.render()
      return h.frames.at(-1)!
    },
  },
  {
    name: "home",
    async run(size) {
      const h = session(size, [summary("Cache key bug", 2, { state: "generating" }), summary("Earlier work", 90)])
      h.app.applySettings({})
      await Bun.sleep(5)
      h.app.render()
      return h.frames.at(-1)!
    },
  },
  {
    name: "slash",
    async run(size) {
      const h = session(size)
      h.app.applySettings({})
      conversation(h)
      await h.type("/")
      return h.frames.at(-1)!
    },
  },
  {
    name: "slash-search",
    async run(size) {
      const h = session(size)
      h.app.applySettings({})
      conversation(h)
      await h.type("/mod")
      return h.frames.at(-1)!
    },
  },
  {
    name: "queue-limit",
    async run(size) {
      const h = session(size)
      h.app.applySettings({})
      conversation(h)
      const turnId = ids("turn")
      h.app.onEvent({ sessionId: h.sessionId, seq: 500, at: NOW, type: "turn.started", turnId, queueId: ids("queue") } as never)
      h.app.onEvent({ sessionId: h.sessionId, seq: 501, at: NOW, type: "foreground.state", state: "generating", turnId } as never)
      h.app.onEvent({ sessionId: h.sessionId, seq: 502, at: NOW, type: "queue.changed", queue: [{ queueId: ids("queue"), preview: "also update the changelog", delivery: "queue" }, { queueId: ids("queue"), preview: "and bump the version", delivery: "steer" }] } as never)
      h.app.onEvent({ sessionId: h.sessionId, seq: 503, at: NOW, type: "usage.limit", turnId, state: "waiting", provider: "faux", message: "limit", resetsAt: NOW + 3_600_000 } as never)
      h.app.render()
      return h.frames.at(-1)!
    },
  },
]

/** The rows between turns and the one-line tool rows: a `!command`, a failed turn, a compaction, a plan, saved memory. */
function leftovers(h: ReturnType<typeof appHarness>) {
  const { emit, message, tool } = conversation(h)
  const turn = ids("turn")
  emit({ type: "turn.started", turnId: turn, queueId: ids("queue") })
  const shell = ids("item")
  emit({ type: "item.started", turnId: turn, itemId: shell, kind: "user_message", meta: { shell: true } })
  emit({ type: "item.completed", itemId: shell, status: "ok", text: "ls -la src" })
  tool(turn, "plan_submit", "## Plan\n\n1. Read the store\n2. Fix the key\n3. Run the suite", "ok")
  tool(turn, "memory_save", "Saved to memory: the cache key includes the directory", "ok", { memorySaved: true })
  message(turn, "agent_message", "Done.")
  emit({ type: "turn.failed", turnId: turn, error: { code: "rate_limit", message: "provider said slow down\nretry in 30s" } })
  const packing = ids("turn")
  const item = ids("item")
  emit({ type: "turn.started", turnId: packing, queueId: ids("queue") })
  emit({ type: "compaction.updated", turnId: packing, reason: "manual", state: "writing", followUp: "" })
  emit({ type: "item.started", turnId: packing, itemId: item, kind: "compaction", meta: { compactionMethod: "memory", tailTurns: 2, tailTokens: 248 } })
  emit({ type: "item.completed", itemId: item, status: "ok", text: "## Current task\n\nKeep the latest constraint and continue." })
  emit({ type: "compaction.updated", turnId: packing, reason: "manual", state: "packed", followUp: "" })
  emit({ type: "turn.completed", turnId: packing })
  h.app.render()
}

SCENARIOS.push(
  {
    name: "leftovers",
    async run(size) {
      const h = session(size)
      h.app.applySettings({})
      leftovers(h)
      return h.frames.at(-1)!
    },
  },
  {
    name: "minimal-session",
    async run(size) {
      const h = session(size, [], {}, "minimal")
      h.app.applySettings({})
      leftovers(h)
      return h.frames.at(-1)!
    },
  },
)

export const digest = (rows: Line[]) => createHash("sha1").update(JSON.stringify(rows)).digest("hex").slice(0, 16)

/** One recorded frame: its plain rows, then the hash of every span (colors and styles included). */
export const record = (rows: Line[]) => `${digest(rows)}\n${rows.map((row) => plain(row).trimEnd()).join("\n")}\n`

export const goldenPath = (name: string, size: (typeof SIZES)[number]) => path.join(import.meta.dir, "fixtures", "views-golden", `${name}-${size.width}x${size.height}.txt`)

if (import.meta.main && process.argv.includes("--write")) {
  for (const scenario of SCENARIOS) {
    for (const size of SIZES) {
      const file = goldenPath(scenario.name, size)
      mkdirSync(path.dirname(file), { recursive: true })
      writeFileSync(file, record(await scenario.run(size)))
    }
  }
  console.log(`wrote ${SCENARIOS.length * SIZES.length} frames`)
  process.exit(0)
}
export const readGolden = (name: string, size: (typeof SIZES)[number]) => readFileSync(goldenPath(name, size), "utf8")
