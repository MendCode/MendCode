import type { MemoryEntry } from "@mendcode/protocol"
import { colorDepth, sgr } from "../../apps/cli/src/ui/theme"
import { createMemoryPageState, memoryPageKey, renderMemoryPage } from "../../apps/cli/src/view/memory-page"

const NOW = Date.UTC(2026, 8, 26, 12)
const HOUR = 3_600_000

function entry(memoryId: string, patch: Partial<MemoryEntry>): MemoryEntry {
  return { memoryId, scope: "project", directory: "/work/app", text: "", category: "", status: "pending", source: "agent", createdAt: NOW - 30 * HOUR, updatedAt: NOW - HOUR, ...patch } as MemoryEntry
}

const memories: MemoryEntry[] = [
  entry("p1", { text: "Use pnpm, never npm, in this repository; the lockfile is committed and CI runs pnpm install --frozen-lockfile.", category: "tooling" }),
  entry("p2", { scope: "user", text: "Prefers terse answers without filler.", category: "style", updatedAt: NOW - 3 * HOUR }),
  entry("p3", { text: "The daemon owns the SQLite store; the CLI never opens it directly. Every write goes through a protocol command and every read through a query, so the view layer stays pure and testable without IO. Never bypass this even in scripts.", category: "architecture", updatedAt: NOW - 9 * HOUR }),
  entry("p4", { directory: "/work/other-service", text: "Deploys go through the release workflow.", updatedAt: NOW - 30 * HOUR }),
  entry("s1", { status: "saved", source: "user", text: "Tests run with bun test." }),
]

const width = Number(process.argv[2] ?? 100)
const height = Number(process.argv[3] ?? 30)
const wantsDelete = process.argv[4] === "delete"
let state = createMemoryPageState()
state = memoryPageKey(state, "j", memories).state
if (wantsDelete) state = memoryPageKey(state, "d", memories).state
const depth = colorDepth({ COLORTERM: "truecolor" })
for (const line of renderMemoryPage({ memories, state, width, height, now: NOW, directory: "/work/app" })) {
  process.stdout.write(`${line.map((span) => { const style = sgr(span, depth); return style ? `${style}${span.text}\x1b[0m` : span.text }).join("")}\n`)
}
