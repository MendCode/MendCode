import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createInstructionLoader, createSkillLoader, createSkillTool, loadSystemPrompt } from "@mendcode/engine-native"
import { TIER_BUNDLES, type PromptMode, type Tier } from "@mendcode/protocol/wire"
import { systemPartsWith } from "../src/extensions/prompt-files"
import { composePromptParts, createPromptModes } from "../src/prompt-modes"

const cleanup: Array<() => unknown> = []
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn() })
function temp() {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mend-tier-instr-")))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** A realistic AGENTS.md (about 1.6 KB) and five skills: the project context a coding agent should always see. */
const AGENTS_MD = `# Project rules
Runtime: Bun. Package manager: pnpm; never use npm or yarn. TypeScript strict, no semicolons, 2 spaces.
Run \`bun test <file>\` for focused checks and \`./node_modules/.bin/tsc -p tsconfig.base.json --noEmit\` before committing.
Never edit generated files under dist/. Keep prompts in config files, not in source.
Commits: plain messages, no trailers. Do not push or touch main.
## Layout
- packages/engine-native: the agent loop and tools wiring.
- packages/daemon: sessions, prompt modes, commands.
- apps/cli: the terminal client; it must not import zod or the protocol schemas.
## Testing
Add a regression test that fails before the fix. Do not mock the database; use temp directories.
Report configuration, mock and live verification separately.
`
const SKILLS: Array<[string, string]> = [
  ["release", "Cut a release: bump version, changelog, tag, and verify the pipeline."],
  ["migrate", "Write and check a database migration with a rollback plan."],
  ["debug-flaky", "Find the cause of a flaky test by bisecting and repeating runs."],
  ["api-review", "Review an API change for compatibility, errors and docs."],
  ["perf-trace", "Profile a slow path and report measured numbers, not guesses."],
]

async function project() {
  const root = temp()
  mkdirSync(path.join(root, ".git"))
  writeFileSync(path.join(root, "AGENTS.md"), AGENTS_MD)
  for (const [name, description] of SKILLS) {
    mkdirSync(path.join(root, ".mendcode", "skills", name), { recursive: true })
    writeFileSync(path.join(root, ".mendcode", "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\nBody of ${name}.`)
  }
  return root
}

/** The system prompt a native turn sends in `mode`, composed the way the daemon does (instructions and skills as parts, then the mode policy). */
async function prompt(root: string, mode: PromptMode, options: { memory?: string } = {}) {
  const dir = temp()
  createPromptModes(dir).set(root, { mode })
  const packaged = await loadSystemPrompt()
  const skills = createSkillLoader({ userDir: dir })
  const parts = systemPartsWith({
    files: {}, root, packaged,
    rest: [{ id: "instructions", label: "project instructions", text: createInstructionLoader()(root) }, { id: "skills", label: "skills", text: skills.block(root) }, { id: "memory", label: "memory", text: options.memory ?? "" }],
  })
  const composed = composePromptParts(dir, root, parts)
  return { parts: composed.parts, text: composed.parts.map((part) => part.text).join("\n\n"), tokens: Math.ceil(composed.parts.map((part) => part.text).join("\n\n").length / 4) }
}

/** Estimated tokens (chars over four) the fixture project adds to the system prompt of each tier's prompt mode. */
const PROJECT_CONTEXT_BUDGET: Record<Tier, number> = { minimalist: 204, balanced: 346, full: 346 }

describe("project instructions and the skill catalog in every prompt mode", () => {
  test("project instructions are in minimal, focus, full and custom; the skill catalog is in focus and full only", async () => {
    const root = await project()
    for (const mode of ["minimal", "focus", "full", "custom"] as const) {
      const built = await prompt(root, mode)
      expect(built.text, `${mode}: AGENTS.md`).toContain("Never edit generated files under dist/")
      expect(built.parts.some((part) => part.id === "instructions"), `${mode}: instructions part`).toBe(true)
    }
    for (const mode of ["focus", "full"] as const) {
      const built = await prompt(root, mode)
      expect(built.text, `${mode}: catalog`).toContain("- release: Cut a release")
      expect(built.text, `${mode}: catalog block`).toContain("<available_skills>")
    }
    for (const mode of ["minimal", "custom"] as const) expect((await prompt(root, mode)).text, `${mode}: no catalog`).not.toContain("<available_skills>")
  })

  test("without project files every mode is as small as before: nothing is added when there is nothing to add", async () => {
    const root = temp()
    for (const mode of ["minimal", "focus", "full"] as const) {
      const built = await prompt(root, mode)
      expect(built.parts.some((part) => part.id === "instructions" || part.id === "skills")).toBe(false)
    }
  })

  test("the skill tool lists the skills when the prompt has no catalog (minimal)", async () => {
    const root = await project()
    const minimal = await prompt(root, "minimal")
    expect(minimal.text).not.toContain("<available_skills>")
    const tool = createSkillTool(createSkillLoader({ userDir: temp() }))
    const listing = await tool.execute({}, { cwd: root, signal: new AbortController().signal })
    for (const [name, description] of SKILLS) expect(listing.output).toContain(`- ${name}: ${description}`)
  })

  test("the context a tier adds for this project is measured, ordered by tier and stays within the stored per-tier numbers", async () => {
    const root = await project()
    const empty = temp()
    const delta: Record<string, number> = {}
    for (const tier of ["minimalist", "balanced", "full"] as Tier[]) {
      const mode = TIER_BUNDLES[tier].promptMode
      delta[tier] = (await prompt(root, mode)).tokens - (await prompt(empty, mode)).tokens
    }
    console.info(`tier context delta for the fixture project (AGENTS.md + 5 skills), estimated tokens: ${JSON.stringify(delta)}`)
    // minimal: instructions only; focus: instructions plus the compact catalog; full: the same as focus (its extras are not project files).
    expect(delta.minimalist).toBeGreaterThan(0)
    expect(delta.balanced).toBeGreaterThan(delta.minimalist!)
    // Each side is a chars-over-four estimate rounded up on its own, so the same text can differ by one token between modes.
    expect(delta.full).toBeGreaterThanOrEqual(delta.balanced! - 1)
    // Stored with the measured values (chars over four; a difference of one is the rounding of two separate estimates). Before this
    // change the same project cost 0 / 0 / 346: minimal and focus dropped AGENTS.md and focus dropped the catalog.
    for (const tier of ["minimalist", "balanced", "full"] as Tier[]) expect(delta[tier]!, tier).toBeLessThanOrEqual(PROJECT_CONTEXT_BUDGET[tier] + 1)
  })

  test("a larger AGENTS.md stays inside the loader's size caps in every mode", async () => {
    const root = await project()
    writeFileSync(path.join(root, "AGENTS.md"), "rule\n".repeat(20_000))
    for (const mode of ["minimal", "focus", "full"] as const) {
      const built = await prompt(root, mode)
      const instructions = built.parts.find((part) => part.id === "instructions")!.text
      expect(instructions.length, mode).toBeLessThan(16_500)
      expect(instructions).toContain("[… truncated at 16000 characters]")
    }
  })
})
