import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { BOT_COLORS, BOT_SHAPES, parseAgentFile, readLayerAgents, type ExtensionLayer } from "../src"

const cleanups: string[] = []
afterEach(() => { for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const temp = () => { const dir = mkdtempSync(path.join(tmpdir(), "bots-")); cleanups.push(dir); return dir }

const file = (frontmatter: string) => `---\ndescription: A calm reviewer\n${frontmatter}\n---\nYou review.`
const parse = (text: string) => parseAgentFile({ text, stem: "calm", file: "/x/calm.md", source: "user" })
const problem = (text: string) => { const result = parse(text); return "problem" in result ? result.problem : undefined }

describe("bot identity in an agent file", () => {
  test("a bot block gives shape, color, avatar and origin; origin defaults to mendcode", () => {
    const result = parse(file("bot:\n  shape: diamond\n  color: success\n  avatar: ~/faces/calm.png"))
    expect(result).toMatchObject({ agent: { name: "calm", bot: { shape: "diamond", color: "success", avatar: "~/faces/calm.png", origin: "mendcode" } } })
    expect(parse(file("bot:\n  origin: hermes"))).toMatchObject({ agent: { bot: { origin: "hermes" } } })
    expect(parse(file("bot: {}"))).toMatchObject({ agent: { bot: { origin: "mendcode" } } })
  })

  test("a file without the block is a plain agent, and the block never lands in options", () => {
    const plain = parse(file("effort: high"))
    expect(plain).toMatchObject({ agent: { name: "calm" } })
    expect("agent" in plain && plain.agent.bot).toBeUndefined()
    const bot = parse(file("bot:\n  shape: circle"))
    expect("agent" in bot && bot.agent.options).toBeUndefined()
  })

  test("invalid values are named as problems", () => {
    expect(problem(file("bot:\n  shape: blob"))).toContain("bot.shape")
    expect(problem(file("bot:\n  color: '#00ff00'"))).toContain("bot.color")
    expect(problem(file("bot:\n  color: green"))).toContain("bot.color")
    expect(problem(file("bot:\n  origin: Not A Connector"))).toContain("bot.origin")
    expect(problem(file("bot:\n  mood: happy"))).toContain("bot")
    expect(problem(file("bot: yes"))).toContain("bot")
    expect(problem(file(`bot:\n  avatar: ${"a".repeat(5000)}`))).toContain("bot.avatar")
  })

  test("the shape and color lists are the ones a bot may use", () => {
    expect(BOT_SHAPES.length).toBeGreaterThan(2)
    expect(BOT_COLORS).toEqual(["primary", "secondary", "accent", "success", "warning", "error", "info"])
  })

  test("bots are global: a project agent file keeps working as an agent but its bot block is ignored with a problem", () => {
    const user = temp()
    const project = temp()
    for (const [dir, name] of [[user, "mine"], [project, "theirs"]] as const) {
      mkdirSync(path.join(dir, "agents"), { recursive: true })
      writeFileSync(path.join(dir, "agents", `${name}.md`), file("bot:\n  shape: circle"))
    }
    const layers: ExtensionLayer[] = [{ dir: user, source: "user" }, { dir: project, source: "project" }]
    const found = readLayerAgents(layers, { projectTrusted: true })
    expect(found.agents.find((agent) => agent.name === "mine")?.bot).toMatchObject({ shape: "circle" })
    expect(found.agents.find((agent) => agent.name === "theirs")).toBeDefined()
    expect(found.agents.find((agent) => agent.name === "theirs")?.bot).toBeUndefined()
    expect(found.problems.some((issue) => issue.message.includes("bots are global"))).toBe(true)
  })
})

describe("the protocol's copy of the lists", () => {
  test("shapes and colors equal the parser's, and the flag is a real experimental flag", async () => {
    const wire = await import("@mendcode/protocol/wire")
    expect([...wire.BOT_SHAPES]).toEqual([...BOT_SHAPES])
    expect([...wire.BOT_COLORS]).toEqual([...BOT_COLORS])
    expect(wire.EXPERIMENTAL_FLAGS.some((flag) => flag.id === "bots")).toBe(true)
  })
})
