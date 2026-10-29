import { colorDepth, sgr } from "../../apps/cli/src/ui/theme"
import { createAgentsPageState, renderAgentsPage, type AgentSession, type AgentShell, type AgentSubtask } from "../../apps/cli/src/view/agents-page"
import { textWidth } from "../../apps/cli/src/view/wrap"

const NOW = 1_800_000_000_000
const SEC = 1000
const MIN = 60 * SEC
const HOUR = 60 * MIN

function session(id: string, over: Partial<AgentSession> = {}): AgentSession {
  return { sessionId: id, title: `session ${id}`, directory: "/Users/dev/Code/MendCodeV2", state: "generating", updatedAt: NOW - SEC, queued: 0, ...over }
}

const sessions: AgentSession[] = [
  session("a", { title: "fix flaky reconnect", since: NOW - 3 * MIN - 5 * SEC, state: "generating", tool: "read: src/session.ts", queued: 2 }),
  session("b", { title: "review dream scheduler", state: "waiting_approval", since: NOW - 40 * SEC, pending: "Run command", directory: "/Users/dev/Code/repos/codeconfig" }),
  session("c", { title: "release notes", state: "tool", since: NOW - 10 * MIN, tool: "shell: bun test" }),
  session("d", { title: "held queue", state: "queued", queued: 3 }),
  session("e", { title: "optimize parser performance", state: "compacting", since: NOW - 2 * HOUR }),
  session("f", { title: "add memory persistence", state: "generating", since: NOW - 45 * MIN, tool: "write: src/memory.ts", queued: 1 }),
]

const subtasks: AgentSubtask[] = [
  { itemId: "i1", title: "task: find every reference to createSession", latest: "grep: createSession" },
  { itemId: "i2", title: "task: refactor to use context manager", latest: "edit: src/context.ts" },
]

const shells: AgentShell[] = [
  { id: "s1", sessionId: "a", command: "bun run dev --watch --port 3000", startedAt: NOW - 5 * MIN, status: "running" },
  { id: "s2", sessionId: "c", command: "bun test --coverage", startedAt: NOW - 8 * MIN, endedAt: NOW - 3 * MIN, status: "exited", exitCode: 0 },
  { id: "s3", sessionId: "e", command: "cargo build --release", startedAt: NOW - 30 * MIN, endedAt: NOW - 25 * MIN, status: "exited", exitCode: 2 },
]

const titles = {
  a: "fix flaky reconnect",
  c: "release notes",
  e: "optimize parser performance",
}

const width = Number(process.argv[2] ?? 120)
const height = Number(process.argv[3] ?? 35)
const depth = colorDepth({ COLORTERM: "truecolor" })

const lines = renderAgentsPage({
  sessions,
  subtasks,
  shells,
  titles,
  state: createAgentsPageState(),
  currentSessionId: "a",
  width,
  height,
  now: NOW,
})

for (const line of lines) {
  let out = ""
  let used = 0
  for (const span of line) {
    const style = sgr(span, depth)
    out += style ? `${style}${span.text}\x1b[0m` : span.text
    used += textWidth(span.text)
  }
  process.stdout.write(`${out}\n`)
}
