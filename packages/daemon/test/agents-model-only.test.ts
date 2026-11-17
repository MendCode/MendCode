import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { SessionId } from "@mendcode/protocol"
import { createAgentRegistry } from "../src/agents"

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function registry() {
  const dir = mkdtempSync(path.join(tmpdir(), "agents-model-only-"))
  dirs.push(dir)
  mkdirSync(path.join(dir, "agents"), { recursive: true })
  writeFileSync(path.join(dir, "agents", "mendy.md"), "---\ndescription: A bot\nmode: primary\nmodel: claude-opus\nbot:\n  shape: square\n  color: success\n---\nYou are mendy.")
  const asked: string[] = []
  const spy = (label: string, text: string) => (..._args: unknown[]) => { asked.push(label); return text }
  const agents = createAgentRegistry({
    layers: () => [{ dir, source: "user" }],
    isTrusted: () => true,
    directoryOf: () => dir,
    selected: () => "mendy",
    modelExists: () => true,
    botsOn: () => true,
    botMemory: spy("memory", "- a note"),
    botRecall: spy("recall", "# digest"),
    botSkills: spy("skills", "skills"),
    botOverview: spy("overview", "overview"),
    botHint: spy("hint", "hint"),
  })
  return { agents, asked }
}

const session = "ses_01HZZZZZZZZZZZZZZZZZZZZZZZ" as SessionId

test("a turn's profile of a bot builds its whole prompt: memory, digest, skills, overview and hint", () => {
  const { agents, asked } = registry()
  const profile = agents.port().primary(session)
  expect(profile?.prompt).toContain("# digest")
  expect(asked.sort()).toEqual(["hint", "memory", "overview", "recall", "skills"])
})

test("asking a bot's model alone reads none of that: a chat opening never waits for the bot's memory, digest or overview", () => {
  const { agents, asked } = registry()
  const profile = agents.port().primary(session, undefined, { prompt: false })
  expect(profile?.model).toBe("claude-opus")
  expect(profile?.prompt).toBe("You are mendy.")
  expect(asked).toEqual([])
})
