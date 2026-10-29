import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createCodeGraphTools } from "@mendcode/codegraph"
import { createInstructionLoader, createMemorySelector, createSkillLoader, loadSystemPrompt } from "@mendcode/engine-native"
import { createIdFactory, type MemoryEntry } from "@mendcode/protocol"
import { TIER_BUNDLES, effectiveSettings, type Tier } from "@mendcode/protocol/wire"
import { BUILTIN_TOOLS } from "@mendcode/tools"
import { systemPartsWith } from "../src/extensions/prompt-files"
import { composePromptParts, createPromptModes } from "../src/prompt-modes"
import { ADAPTERS, lineageReport, prefixParts, recordLineage, type Adapter, type Turn } from "../../engine-native/test/prefix-harness"

const cleanup: Array<() => unknown> = []
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn() })
function temp() {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mend-prefix-")))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const memoryIds = createIdFactory()
const saved = (text: string, patch: Partial<MemoryEntry> = {}): MemoryEntry => ({ memoryId: memoryIds("memory"), scope: "project", directory: "/repo", text, category: "commands", status: "saved", source: "user", createdAt: 0, updatedAt: 1_000, ...patch })
const MEMORIES = [
  saved("Never commit secrets", { pinned: true }),
  saved("Tests run with bun test <file>"),
  saved("Pagination helpers live in src/paginate.ts"),
  saved("Empty pages return an empty items array and pageCount 1"),
  saved("Package manager is pnpm"),
  saved("Commit messages are plain, no trailers"),
  ...Array.from({ length: 30 }, (_, index) => saved(`Ambient project note number ${index} about the layout of the repository`, { category: "layout" })),
]

/** The words of the prompt that a memory shares: a stand-in for the daemon's full-text ranking, enough to make the ranking depend on the prompt. */
const related = (prompt: string) => {
  const words = new Set(prompt.toLowerCase().match(/[a-z]{4,}/g) ?? [])
  return MEMORIES.map((memory) => ({ memory, rank: -(memory.text.toLowerCase().match(/[a-z]{4,}/g) ?? []).filter((word) => words.has(word)).length })).filter((hit) => hit.rank < 0)
}

const TURNS: Turn[] = [
  { text: "Fix the pagination bug in src/paginate.ts", steps: [
    // A content search through `shell`, the one tool every tier lists for it (minimalist defers `grep`: docs/tool-discovery.md).
    { calls: [{ name: "read", args: { path: "src/paginate.ts" } }, { name: "shell", args: { command: "rg -n paginate src" } }], usage: { input: 3000, output: 40 } },
    { text: "Fixed.", usage: { input: 400, output: 20, cacheRead: 3000 } },
  ] },
  { text: "Now cover the empty page case with a test", steps: [
    { calls: [{ name: "read", args: { path: "test/paginate.test.ts" } }], usage: { input: 500, output: 20, cacheRead: 3400 } },
    { text: "Added.", usage: { input: 400, output: 20, cacheRead: 3800 } },
  ] },
  { text: "Rename the package manager note in the docs", steps: [{ text: "Done.", usage: { input: 500, output: 20, cacheRead: 4200 } }] },
]

async function lineage(adapter: Adapter, tier: Tier, options: { memoryFor?: (prompt: string) => MemoryEntry[] } = {}) {
  const dir = temp(), root = temp()
  mkdirSync(path.join(root, ".git"))
  writeFileSync(path.join(root, "AGENTS.md"), "# Rules\nRuntime: Bun. Plain commit messages.\n")
  mkdirSync(path.join(root, ".mendcode", "skills", "release"), { recursive: true })
  writeFileSync(path.join(root, ".mendcode", "skills", "release", "SKILL.md"), "---\nname: release\ndescription: Cut a release.\n---\nBody.")
  createPromptModes(dir).set(root, { mode: TIER_BUNDLES[tier].promptMode })
  const packaged = await loadSystemPrompt()
  const skills = createSkillLoader({ userDir: dir })
  const instructions = createInstructionLoader()
  const port = options.memoryFor
    ? { visible: () => MEMORIES.slice(0, 4), related: ({ prompt }: { prompt: string }) => options.memoryFor!(prompt).map((memory, index) => ({ memory, rank: index - 10 })), links: () => [] }
    : { visible: () => MEMORIES, related: ({ prompt }: { prompt: string }) => related(prompt), links: () => [] }
  const selector = createMemorySelector(port,{ settings: () => ({ memoryEnabled: true, memoryUse: true }) })
  const system = (cwd: string, context?: { sessionId: never; prompt: string }) => composePromptParts(dir, cwd, systemPartsWith({
    files: {}, root: cwd, packaged,
    rest: [
      { id: "instructions", label: "project instructions", text: instructions(cwd) },
      { id: "skills", label: "skills", text: skills.block(cwd) },
      { id: "memory", label: "memory", text: selector.block({ directory: "/repo", prompt: context?.prompt ?? "", ...(context ? { sessionId: context.sessionId } : {}) }) },
    ],
  })).parts.map((part) => part.text).join("\n\n")
  const calls = await recordLineage({
    adapter, turns: TURNS, cwd: root, system: system as never,
    tools: [...BUILTIN_TOOLS.filter((tool) => ["read", "grep", "glob", "ls", "edit", "write", "shell"].includes(tool.name)), ...createCodeGraphTools({ cacheDir: path.join(dir, "codegraph") })],
    promptCache: "smart",
    engineOptions: { permissionPolicy: () => effectiveSettings({ tier }) },
  })
  return { calls, report: lineageReport(adapter, calls) }
}

const withoutMemory = (text: string) => text.replace(/<mendcode_memory>.*?<\/mendcode_memory>/gs, "").replace(/<mendcode_memory>.*?<\/mendcode_memory>/gs, "")

describe("the prompt each mode sends keeps the prefix of the call before it", () => {
  for (const tier of ["minimalist", "balanced", "full"] as const) for (const adapter of ADAPTERS) {
    test(`${TIER_BUNDLES[tier].promptMode} prompt mode (${tier}), ${adapter}: calls of a turn extend the previous one, a new turn breaks it only through the memory block`, async () => {
      const { report, calls } = await lineage(adapter, tier)
      const bytes = report.map((entry) => `${entry.from}→${entry.to}${entry.crossTurn ? "*" : ""} ${(entry.share * 100).toFixed(1)}% (${entry.sharedBytes}/${entry.previousBytes}B, first difference: ${entry.firstDifference})`)
      console.info(`${TIER_BUNDLES[tier].promptMode}/${adapter} [${calls[0]!.body.tools?.length ?? 0} tools]: ${bytes.join(" · ")}`)
      for (const [index, entry] of report.entries()) {
        if (!entry.crossTurn) { expect(entry, `${entry.from}→${entry.to}`).toMatchObject({ share: 1, firstDifference: "none" }); continue }
        if (entry.firstDifference === "none") continue
        // The memory block is ranked for the user's latest prompt and sits in the system prompt: when a new prompt brings a
        // memory in, the text after it (and every message) is new to the provider's cache. Nothing else may differ.
        expect(entry.firstDifference, `${entry.from}→${entry.to}`).toBe("system")
        expect(withoutMemory(prefixParts(adapter, calls[index + 1]!.body).system)).toBe(withoutMemory(prefixParts(adapter, calls[index]!.body).system))
      }
    })
  }
})

describe("a memory block that does not change leaves the prefix whole across turns", () => {
  test("memory ranked in a different order for the next prompt keeps its text, so nothing is re-read", async () => {
    const { report } = await lineage("responses", "balanced", { memoryFor: (prompt) => (prompt.includes("empty") ? [...MEMORIES.slice(0, 4)].reverse() : MEMORIES.slice(0, 4)) })
    for (const entry of report) expect(entry, `${entry.from}→${entry.to}`).toMatchObject({ share: 1, firstDifference: "none" })
  })
})
