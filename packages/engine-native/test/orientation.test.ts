import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { Settings } from "@mendcode/protocol"
import { createNativeEngine, memoryHistory } from "../src"
import { MAX_ORIENTATION_CHARS, MAX_ORIENTATION_PATHS, gitBranch, orientationBlock, projectCommands, topLevelTree } from "../src/orientation"
import { scriptedProvider, stop, turn } from "./harness"

function project() {
  const root = mkdtempSync(path.join(tmpdir(), "orientation-"))
  mkdirSync(path.join(root, ".git"))
  writeFileSync(path.join(root, ".git", "HEAD"), "ref: refs/heads/feature/x\n")
  writeFileSync(path.join(root, "AGENTS.md"), "rules")
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }))
  writeFileSync(path.join(root, "bun.lock"), "")
  writeFileSync(path.join(root, ".gitignore"), "# generated\ngenerated\n*.log\n")
  mkdirSync(path.join(root, "src"))
  writeFileSync(path.join(root, "src", "index.ts"), "")
  mkdirSync(path.join(root, "node_modules"))
  mkdirSync(path.join(root, "generated"))
  return root
}

describe("orientation block", () => {
  test("names the cwd, branch, package manager, test command, loaded instruction files and the tree without ignored folders", () => {
    const root = project()
    const block = orientationBlock({ cwd: root })
    expect(block).toContain(`cwd: ${root}`)
    expect(block).toContain("git branch: feature/x")
    expect(block).toContain("package manager bun")
    expect(block).toContain("tests: bun run test (bun test)")
    expect(block).toContain("do not search for them): AGENTS.md")
    expect(block).toContain("src/\n")
    expect(block).toContain("src/index.ts")
    expect(block).not.toContain("node_modules")
    expect(block).not.toContain("generated")
  })

  test("says so when no instruction file exists", () => {
    const root = mkdtempSync(path.join(tmpdir(), "orientation-"))
    mkdirSync(path.join(root, ".git"))
    expect(orientationBlock({ cwd: root })).toContain("no project instruction file")
  })

  test("the tree and the block are bounded", () => {
    const root = mkdtempSync(path.join(tmpdir(), "orientation-"))
    for (let index = 0; index < 400; index += 1) writeFileSync(path.join(root, `file-${String(index).padStart(3, "0")}-${"x".repeat(60)}.txt`), "")
    const tree = topLevelTree(root)
    expect(tree.paths).toHaveLength(MAX_ORIENTATION_PATHS)
    expect(tree.omitted).toBe(250)
    expect(orientationBlock({ cwd: root }).length).toBeLessThan(MAX_ORIENTATION_CHARS + 100)
  })

  test("a git worktree's .git file leads to its HEAD; other manifests name their test command", () => {
    const root = mkdtempSync(path.join(tmpdir(), "orientation-"))
    const git = path.join(root, "gitdir")
    mkdirSync(git)
    writeFileSync(path.join(git, "HEAD"), "ref: refs/heads/wt\n")
    writeFileSync(path.join(root, ".git"), `gitdir: ${git}\n`)
    writeFileSync(path.join(root, "Cargo.toml"), "")
    expect(gitBranch(root)).toBe("wt")
    expect(projectCommands(root)).toBe("cargo · tests: cargo test")
    expect(gitBranch(mkdtempSync(path.join(tmpdir(), "no-git-")))).toBeUndefined()
  })
})

describe("orientation feature", () => {
  const run = async (settings: Settings, second = false) => {
    const root = project()
    const { provider, requests } = scriptedProvider([stop("a"), stop("b")])
    const engine = createNativeEngine({ provider, history: memoryHistory(), tools: [], cwdFor: () => root, system: () => "sys", compactionPrompt: "summarize", permissionPolicy: () => settings })
    const firstTurn = turn({ text: "first task" })
    await engine.runTurn(firstTurn.input)
    if (second) await engine.runTurn(turn({ text: "second task", sessionId: firstTurn.input.sessionId }).input)
    return { requests, root }
  }
  const userTexts = (request: { messages: ReadonlyArray<{ role: string; content?: unknown }> }) => request.messages.filter((message) => message.role === "user").map((message) => String(message.content))

  test("on in the balanced tier: only the first user message carries it, before the text, and the system prompt does not", async () => {
    const { requests, root } = await run({ tier: "balanced" }, true)
    const first = userTexts(requests[0]!)[0]!
    expect(first.startsWith("<orientation>")).toBe(true)
    expect(first).toContain(`cwd: ${root}`)
    expect(first.endsWith("first task")).toBe(true)
    expect(userTexts(requests[1]!)).toEqual([first, "second task"])
    expect(JSON.stringify(requests[0]!.system)).not.toContain("<orientation>")
  })

  test("off without a tier, in minimalist, and when switched off", async () => {
    for (const settings of [{}, { tier: "minimalist" }, { tier: "balanced", features: { orientation: false } }] as Settings[]) {
      const { requests } = await run(settings)
      expect(userTexts(requests[0]!)).toEqual(["first task"])
    }
  })

  test("a tier can switch it on or off through features.orientation", async () => {
    const { requests } = await run({ tier: "minimalist", features: { orientation: true } })
    expect(userTexts(requests[0]!)[0]!.startsWith("<orientation>")).toBe(true)
  })
})
