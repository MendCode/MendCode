import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { NATIVE_DEFAULTS, loadSystemPrompt, type SystemPart } from "@mendcode/engine-native"
import { PROMPT_FAMILIES, PROMPT_MODES, promptCostLine, promptCostOf, promptCostWarning, type PromptFocus, type PromptMode } from "@mendcode/protocol/wire"
import { BUILTIN_TOOLS } from "@mendcode/tools"
import { parseSlash } from "../../../apps/cli/src/view/commands"
import { PROGRAM_NAME } from "@mendcode/program"
import { CARDS_DIR, OPERATOR_GUIDE_FILE, OPERATOR_GUIDE_TEMPLATE, cardTopics, operatorGuide, slashCommands } from "../src/operator-guide"
import { familyForModel, resolveFocus } from "../src/prompt-focus"
import { PROMPT_BUDGETS, familyGuidance, focusBasics, guideText, modelNote, operatorGuideText, parseFamilyGuidance, selfKnowledgeText } from "../src/prompt-guidance"
import { composePromptParts, createPromptModes } from "../src/prompt-modes"
import pinned from "./fixtures/prompt-focus-pre-guide.json"

const repo = path.resolve(import.meta.dir, "../../..")
const FAMILIES: PromptFocus[] = [...PROMPT_FAMILIES, "neutral"]
const cleanup: string[] = []
afterEach(() => { for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const temp = () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mend-guidance-")))
  cleanup.push(dir)
  return dir
}

/** The packaged base prompt with a user's instructions and memory left out: what the budgets are measured against. */
const baseParts = async (root: string): Promise<SystemPart[]> => [{ id: "base", label: "base prompt", text: (await loadSystemPrompt())(root) }]
const compose = async (mode: PromptMode, family: PromptFocus, place = { dir: temp(), root: temp() }) => {
  const { dir, root } = place
  return composePromptParts(dir, root, await baseParts(root), { mode, focusID: family === "neutral" ? "auto" : family, ...(family === "neutral" ? { modelID: "acme-1" } : {}) })
}
const joined = (parts: SystemPart[]) => parts.map((part) => part.text).join("\n\n")
const tokens = (parts: SystemPart[]) => Math.ceil(joined(parts.filter((part) => part.text)).length / 4)

describe("family guidance files", () => {
  test("every family has a prompt file with a header, a provenance note and a body inside its budget; neutral has none", () => {
    expect(familyGuidance("neutral")).toBeUndefined()
    for (const family of PROMPT_FAMILIES) {
      const guidance = familyGuidance(family)!
      expect(guidance.family).toBe(family)
      expect(guidance.provenance.length).toBeGreaterThan(60)
      expect(guidance.provenance).toMatch(/^Original MendCode text/)
      expect(guidance.body.length).toBeGreaterThan(800)
      expect(guidance.body.length).toBeLessThanOrEqual(PROMPT_BUDGETS.guide.family)
      expect(guidance.body).not.toContain("<!--")
      expect(guidance.body).not.toContain("{{")
      const labels = guidance.notes.map((note) => note.label)
      expect(new Set(labels).size).toBe(labels.length)
      for (const note of guidance.notes) {
        expect(note.text.length).toBeGreaterThan(40)
        expect(note.text.length).toBeLessThanOrEqual(PROMPT_BUDGETS.guide.modelNote)
      }
    }
  })
  test("families that began as vendor prompts in v1 say their text is rewritten, and none claims vendor text", () => {
    for (const family of ["codex", "gemini", "kimi", "mistral"] as const) expect(familyGuidance(family)!.provenance).toMatch(/v1 shipped .* rewritten/)
    for (const family of PROMPT_FAMILIES) expect(familyGuidance(family)!.provenance).not.toMatch(/copied|verbatim from|licensed under/i)
    for (const family of ["codex", "claude", "gemini", "kimi", "deepseek", "mistral", "grok"] as const) expect(familyGuidance(family)!.provenance).toMatch(/text is reproduced/)
  })
  test("the working basics are short, shared and static", () => {
    const basics = focusBasics()
    expect(basics.length).toBeGreaterThan(500)
    expect(basics.length).toBeLessThanOrEqual(PROMPT_BUDGETS.guide.basics)
    for (const tool of ["todo", "shell", "loop", "task", "edit", "question"]) expect(basics).toContain(`\`${tool}`)
    expect(basics).not.toMatch(/\d{4}-\d{2}-\d{2}|\{\{/)
    expect(guideText("neutral")).toBe(basics)
    expect(guideText("codex")).toBe(`${basics}\n\n${familyGuidance("codex")!.body}`)
  })
  test("each guidance file names only tools the native engine ships", () => {
    // The built-in set plus the tools the engine and daemon add per session (checked in their own tests).
    const known = new Set([...BUILTIN_TOOLS.map((tool) => tool.name), "todo", "task", "loop", "question", "skill", "tool_search", "memory"])
    for (const name of ["read", "edit", "apply_patch", "write", "grep", "glob", "ls", "shell", "shell_output"]) expect(known.has(name)).toBe(true)
    for (const text of [focusBasics(), ...PROMPT_FAMILIES.flatMap((family) => [familyGuidance(family)!.body, ...familyGuidance(family)!.notes.map((note) => note.text)])]) {
      for (const [, name] of text.matchAll(/`([a-z_]+)`/g)) {
        if (/^(oldString|offset|limit|background|path|tail|true|false)$/.test(name!)) continue
        expect(known.has(name!)).toBe(true)
      }
    }
  })
  test("the parser reads header fields, body and model notes in order and refuses a file without a header", () => {
    const parsed = parseFamilyGuidance("---\nfamily: codex\nprovenance: p\n---\nbody line\n<!-- model \"A note\" /alpha/i -->\nnote A\n<!-- model \"B note\" /beta/ -->\nnote B\n")
    expect(parsed).toMatchObject({ family: "codex", provenance: "p", body: "body line" })
    expect(parsed.notes.map((note) => [note.label, note.text, note.match.test("ALPHA")])).toEqual([["A note", "note A", true], ["B note", "note B", false]])
    expect(() => parseFamilyGuidance("no header")).toThrow("[GUIDANCE]")
    expect(() => parseFamilyGuidance("---\nfamily: codex\n---\nbody")).toThrow("provenance")
  })
})

describe("model notes", () => {
  const label = (family: PromptFocus, model: string | undefined) => modelNote(family, model)?.label
  test("reasoning and non-reasoning variants of one family get different notes", () => {
    expect(label("deepseek", "deepseek-reasoner")).toBe("DeepSeek reasoning model notes")
    expect(label("deepseek", "deepseek-chat")).toBe("DeepSeek non-thinking notes")
    expect(label("deepseek", "deepseek-v4-pro")).toBeUndefined()
    expect(label("codex", "o3-mini")).toBe("OpenAI reasoning model notes")
    expect(label("codex", "gpt-5-codex")).toBe("Codex-tuned model notes")
    expect(label("codex", "gpt-6-luna")).toBe("GPT-6 Luna low-effort notes")
    expect(label("codex", "gpt-6-sol")).toBeUndefined()
    expect(label("mistral", "devstral-latest")).toBe("Devstral notes")
    expect(label("mistral", "codestral-latest")).toBe("Codestral notes")
    expect(label("mistral", "magistral-medium")).toBe("Magistral notes")
    expect(label("mistral", "mistral-large-latest")).toBeUndefined()
  })
  test("size variants of Claude and Gemini are told apart, version digits included", () => {
    expect(label("claude", "claude-opus-5")).toBe("Claude Opus notes")
    expect(label("claude", "claude-haiku-4-5")).toBe("Claude Haiku notes")
    expect(label("gemini", "gemini-2.5-flash")).toBe("Gemini Flash notes")
    expect(label("gemini", "gemini-2.5-flash-lite")).toBe("Gemini Flash notes")
    expect(label("gemini", "google/gemini-3-pro-preview")).toBe("Gemini Pro notes")
    expect(label("gemini", "gemini-2.5-pro")).toBe("Gemini Pro notes")
  })
  test("no model, no note; a note of another family never applies; neutral has none", () => {
    expect(modelNote("claude", undefined)).toBeUndefined()
    expect(modelNote("claude", "  ")).toBeUndefined()
    expect(label("claude", "gpt-6-astra")).toBeUndefined()
    expect(label("local", "qwen3-coder")).toBeUndefined()
    expect(modelNote("neutral", "gpt-6-luna")).toBeUndefined()
  })
})

describe("auto resolution reaches the new families, explicit still wins", () => {
  test("model and provider ids", () => {
    for (const [id, family] of [["glm-5.1", "glm"], ["minimax-m2", "minimax"], ["grok-code-fast-1", "grok"], ["ollama:llama3.1:8b", "local"], ["lmstudio:unknown", "local"], ["qwen3-coder-plus", "local"]] as const) expect(familyForModel(id)).toBe(family)
    expect(familyForModel("acme-1")).toBe("neutral")
  })
  test("an explicit family wins over the model", () => {
    for (const family of PROMPT_FAMILIES) expect(resolveFocus(family, "claude-sonnet-5-5")).toBe(family)
    expect(resolveFocus("auto", "glm-5.1")).toBe("glm")
  })
})

describe("focus is what it was before the provider guide", () => {
  /** The inputs the fixture was generated with, from main before the guide existed (root /proj/example, no memory). */
  const parts: SystemPart[] = [{ id: "base", label: "base prompt", text: "BASE PROMPT /proj/example" }, { id: "instructions", label: "project instructions", text: "project rules" }, { id: "skills", label: "skills", text: "skill catalogue" }]
  const old = ["codex", "claude", "gemini", "kimi", "deepseek", "mistral", "neutral"]
  const models = [undefined, "gpt-6-astra", "gpt-5.6", "claude-sonnet-5-5", "claude-opus-5", "deepseek-v4-pro", "kimi-k2.5"]
  /** The composed parts without the one-line docs pointer, which the fixture predates: what is left must be the pinned output byte for byte. */
  const withoutPointer = (composed: ReturnType<typeof composePromptParts>) => composed.parts.filter((part) => part.id !== "self-knowledge")
  test("minimal and focus parts are identical to the pre-change output for every earlier family, model and role, plus exactly the one-line docs pointer", () => {
    const dir = temp()
    let checked = 0
    for (const mode of ["minimal", "focus"] as const) for (const family of old) for (const model of models) for (const [role, workflow] of [[undefined, undefined], ["review", undefined], [undefined, "edit"]] as const) {
      const binding = { mode, focusID: family === "neutral" ? "auto" : family, ...(family === "neutral" ? { modelID: "acme-1" } : model ? { modelID: model } : {}), ...(role ? { role } : {}), ...(workflow ? { workflow } : {}) } as Parameters<typeof composePromptParts>[3]
      const key = `${mode}|${family}|${model ?? "-"}|${role ?? "-"}|${workflow ?? "-"}`
      const composed = composePromptParts(dir, "/proj/example", parts, binding)
      const pointers = composed.parts.filter((part) => part.id === "self-knowledge")
      expect([key, pointers.map((part) => part.text)]).toEqual([key, [selfKnowledgeText()]])
      const result = withoutPointer(composed).map((part) => ({ id: part.id, label: part.label, text: part.text }))
      expect([key, createHash("sha256").update(JSON.stringify(result)).digest("hex")]).toEqual([key, (pinned.hashes as Record<string, string>)[key]!])
      checked++
    }
    expect(checked).toBe(Object.keys(pinned.hashes).length)
  })
  test("the focus parts of each earlier family are readable in the fixture and carry only the one-line family note", () => {
    const dir = temp()
    for (const family of old) {
      const expected = (pinned.texts as Record<string, Array<{ id: string; label: string; text: string }>>)[family]!
      const composed = composePromptParts(dir, "/proj/example", parts, { mode: "focus", focusID: family === "neutral" ? "auto" : family as never, ...(family === "neutral" ? { modelID: "acme-1" } : {}) })
      const actual = withoutPointer(composed)
      expect(actual).toEqual(expected)
      expect(composed.parts.map((part) => part.id).slice(0, 6)).toEqual(["base", "instructions", "skills", "boundary", "self-knowledge", "focus"])
      expect(actual.some((part) => part.id === "focus-guide")).toBe(false)
      expect(joined(actual)).not.toContain("Working here:")
    }
  })
  test("the four new families get a one-line note of the order of the old ones", () => {
    const dir = temp()
    for (const family of ["glm", "minimax", "grok", "local"] as const) {
      const text = composePromptParts(dir, "/proj/example", parts, { mode: "focus", focusID: family }).parts.find((part) => part.id === "focus")!.text
      expect(text.startsWith(`MendCode focus: ${family}.`)).toBe(true)
      expect(text.length).toBeGreaterThan(120)
      expect(text.length).toBeLessThan(260)
      expect(text).not.toContain("\n")
    }
  })
})

describe("composition by mode", () => {
  test("modes are ordered minimal, focus, guide, full, then custom", () => {
    expect([...PROMPT_MODES]).toEqual(["minimal", "focus", "guide", "full", "custom"])
  })
  test("minimal is the boundary, byte for byte as before, then the one-line docs pointer, for every family", async () => {
    for (const family of FAMILIES) {
      const dir = temp(), root = temp()
      const composed = composePromptParts(dir, root, await baseParts(root), { mode: "minimal", focusID: family === "neutral" ? "auto" : family })
      expect(joined(composed.parts)).toBe(`You are MendCode, a coding assistant working in ${root}. Answer directly. Read before editing, preserve unrelated work and verify changes with the available tools. Follow the user's scope, runtime permissions and budgets. Use loop tools for scheduled or repeated work, inspect existing loops first and never set an iteration cap to zero. Configured budgets are authoritative; do not infer limits from a provider name. Do not invent successful tests or tool results. Do not expose secrets.\n\n${selfKnowledgeText()}`)
    }
  })
  test("guide is focus plus the basics and the family file inside the guide budget; full adds the operator guide inside the full budget", async () => {
    for (const family of FAMILIES) {
      const place = { dir: temp(), root: temp() }
      const focus = await compose("focus", family, place), guide = await compose("guide", family, place), full = await compose("full", family, place)
      const added = guide.parts.find((part) => part.id === "focus-guide")!
      expect(added.text).toBe(guideText(family))
      expect(added.text.length).toBeLessThanOrEqual(PROMPT_BUDGETS.guide.basics + PROMPT_BUDGETS.guide.family)
      expect(guide.parts.filter((part) => part.id !== "focus-guide")).toEqual(focus.parts)
      expect(joined(guide.parts).length).toBeLessThanOrEqual(PROMPT_BUDGETS.composed.guide)
      expect(joined(full.parts).length).toBeLessThanOrEqual(PROMPT_BUDGETS.composed.full)
      expect(full.parts.find((part) => part.id === "capabilities")?.text).toBe(operatorGuideText())
      expect(full.parts.some((part) => part.id === "focus-guide")).toBe(true)
      for (const part of ["capabilities", "focus-guide"]) expect(focus.parts.some((item) => item.id === part)).toBe(false)
    }
  })
  test("custom mode inherits no family guidance and no guide", async () => {
    const dir = temp(), root = temp()
    const text = joined(composePromptParts(dir, root, await baseParts(root), { mode: "custom", focusID: "codex" }).parts)
    expect(text).not.toContain("Working here:")
    expect(text).not.toContain("operator guide")
  })
  test("guide text is static: no per-call variable in it", async () => {
    for (const family of FAMILIES) for (const mode of ["guide", "full"] as const) {
      const first = await compose(mode, family), second = await compose(mode, family)
      const stable = (composed: typeof first) => composed.parts.filter((part) => ["focus-guide", "capabilities"].includes(part.id)).map((part) => part.text)
      expect(stable(first)).toEqual(stable(second))
      for (const text of stable(first)) expect(text).not.toMatch(/\/(?:var|tmp|private|Users)\/|\b20\d\d-\d\d-\d\d\b/)
    }
  })
  test("a model note rides in its own part after the guide and only in guide and full, for the matching model", async () => {
    const dir = temp(), root = temp()
    const parts = await baseParts(root)
    const ids = (mode: PromptMode, modelID: string) => composePromptParts(dir, root, parts, { mode, modelID }).parts.map((part) => part.id)
    expect(ids("guide", "claude-opus-5")).toContain("model-guidance")
    expect(ids("guide", "claude-opus-5").indexOf("model-guidance")).toBeGreaterThan(ids("guide", "claude-opus-5").indexOf("focus-guide"))
    expect(ids("full", "claude-opus-5")).toContain("model-guidance")
    expect(ids("focus", "claude-opus-5")).not.toContain("model-guidance")
    expect(ids("guide", "gpt-6-sol")).not.toContain("model-guidance")
  })
})

describe("token cost of each mode", () => {
  test("the costs are the real composed text of the family, in characters over four, and rise with the mode", async () => {
    for (const family of FAMILIES) {
      const dir = temp()
      const modelID = family === "neutral" ? "acme-1" : `${family}-test`
      const status = createPromptModes(dir).status("/project", modelID)
      expect(status.costs?.map((cost) => cost.mode)).toEqual(["minimal", "focus", "guide", "full"])
      // The measured text is the packaged base prompt under the fixed root /project, with the model bound as in a real call.
      const base: SystemPart[] = [{ id: "base", label: "base prompt", text: readFileSync(NATIVE_DEFAULTS.systemPromptFile, "utf8").replaceAll("{{cwd}}", "/project") }]
      for (const mode of ["minimal", "focus", "guide", "full"] as const) {
        const cost = promptCostOf(status, mode)!
        expect(cost.tokens).toBe(tokens(composePromptParts(dir, "/project", base, { mode, modelID, focusID: "auto" }).parts))
        expect(cost.overFocus).toBe(cost.tokens - promptCostOf(status, "focus")!.tokens)
      }
      const [minimal, focus, guide, full] = status.costs!
      expect(minimal!.tokens).toBeLessThan(focus!.tokens)
      expect(focus!.tokens).toBeLessThan(guide!.tokens)
      expect(guide!.tokens).toBeLessThan(full!.tokens)
      expect(focus!.overFocus).toBe(0)
    }
  })
  test("the notice line says what the mode adds on every call, and only guide and full carry the warning", () => {
    const costs = [{ mode: "minimal" as const, tokens: 137, overFocus: -400 }, { mode: "focus" as const, tokens: 570, overFocus: 0 }, { mode: "guide" as const, tokens: 1190, overFocus: 620 }, { mode: "full" as const, tokens: 2800, overFocus: 2230 }]
    expect(promptCostLine(costs[0])).toBe("minimal · 137 tokens per call")
    expect(promptCostLine(costs[1])).toBe("focus · 570 tokens per call")
    expect(promptCostLine(costs[2])).toBe("guide · +620 tokens per call (1,190 total)")
    expect(promptCostLine(costs[3])).toBe("full · +2,230 tokens per call (2,800 total)")
    expect(promptCostLine(undefined)).toBe("")
    expect(["minimal", "focus", "custom"].map((mode) => promptCostWarning(mode as PromptMode))).toEqual(["", "", ""])
    expect(promptCostWarning("guide")).toBe("sent with every call")
    expect(promptCostWarning("full")).toBe("sent with every call")
  })
  test("the guide's cost is about the guide text added, and a project prompt file adds a custom cost", () => {
    const dir = temp(), project = temp()
    const before = createPromptModes(dir).status(project, "gpt-6-sol")
    expect(promptCostOf(before, "custom")).toBeUndefined()
    expect(promptCostOf(before, "guide")!.overFocus).toBeGreaterThanOrEqual(Math.floor(guideText("codex").length / 4))
    mkdirSync(path.join(project, ".mendcode/prompts"), { recursive: true })
    writeFileSync(path.join(project, ".mendcode/prompts/custom.md"), "Work carefully. ".repeat(40))
    const after = createPromptModes(dir).status(project, "gpt-6-sol")
    expect(promptCostOf(after, "custom")!.tokens).toBeGreaterThan(150)
    expect(after.costs!.at(-1)!.mode).toBe("custom")
  })
})

describe("composed system prompt snapshots", () => {
  /** A fixed root and base keep the snapshots about the guidance text alone. */
  const snapshot = (mode: PromptMode, family: PromptFocus, modelID?: string) => {
    const dir = temp()
    return composePromptParts(dir, "/proj/example", [{ id: "base", label: "base prompt", text: "BASE PROMPT /proj/example" }], { mode, focusID: family === "neutral" ? "auto" : family, ...(modelID ? { modelID } : {}) }).parts.map((part) => `## [${part.id}] ${part.label}\n${part.text}`).join("\n\n").replace(/Docs revision: \w+/, "Docs revision: <hash of the source docs>")
  }
  for (const [family, model] of [["codex", "gpt-6-sol"], ["local", "ollama:qwen2.5-coder:7b"]] as const) {
    for (const mode of ["minimal", "focus", "guide", "full"] as const) test(`${family} ${mode}`, () => { expect(snapshot(mode, family, model)).toMatchSnapshot() })
  }
})

describe("operator guide", () => {
  const copyOfRepo = () => {
    const copy = temp()
    cpSync(path.join(repo, "docs"), path.join(copy, "docs"), { recursive: true })
    cpSync(path.join(repo, "packages/daemon/prompts"), path.join(copy, "packages/daemon/prompts"), { recursive: true })
    cpSync(path.join(repo, CARDS_DIR), path.join(copy, CARDS_DIR), { recursive: true })
    return copy
  }
  test("the checked-in guide is what the generator produces (bun scripts/self-knowledge.ts)", () => {
    expect(readFileSync(path.join(repo, OPERATOR_GUIDE_FILE), "utf8")).toBe(operatorGuide(repo))
  })
  test("it stays inside the full budget, points at the cards by topic and cites no repository path", () => {
    const guide = operatorGuideText()
    expect(guide.length).toBeLessThanOrEqual(PROMPT_BUDGETS.full.operatorGuide)
    for (const topic of cardTopics(repo)) expect(guide).toContain(topic)
    expect(guide).toContain(`${PROGRAM_NAME} docs <topic>`)
    expect(guide).not.toMatch(/docs\/[\w-]+\.md|packages\/(?:daemon|protocol|engine)|apps\/|scripts\//)
    for (const name of slashCommands(guide)) expect(parseSlash(`/${name}`)).toBeDefined()
    expect(guide).not.toMatch(/\{\{|\[\[/)
  })
  test("it keeps the rules a model must not trade away, and names no skill or MCP server MendCode would ship", () => {
    const guide = operatorGuideText()
    expect(guide).toMatch(/Never change permissions, sandbox, trust, proxy or credentials/)
    expect(guide).toMatch(/never print or ask for secrets/)
    expect(guide).toMatch(/Tier, prompt mode, permission mode and process mode are four different things/)
    expect(guide).not.toMatch(/`mendcode` skill|mendcode-extensions/)
  })
  test("a topic added to the cards folder shows up in the guide", () => {
    const copy = copyOfRepo()
    writeFileSync(path.join(copy, CARDS_DIR, "zebra.md"), "---\nsummary: a test topic\ndocs: tiers\n---\nText.\n")
    expect(operatorGuide(copy)).toContain(", zebra")
    expect(operatorGuide(copy)).not.toBe(operatorGuide(repo))
  })
  test("the generator refuses a template that names a command, setting or doc the docs do not have", () => {
    const copy = copyOfRepo()
    const file = path.join(copy, OPERATOR_GUIDE_TEMPLATE)
    const template = readFileSync(file, "utf8")
    for (const bad of ["`/no-such-command`", "[[setting:noSuchSettingKey]]", "docs/no-such-doc.md"]) {
      writeFileSync(file, `${template}\n${bad}\n`)
      expect(() => operatorGuide(copy)).toThrow("[GUIDE]")
    }
  })
})

describe("the docs pointer: one line in every mode but custom", () => {
  test("it is short, says the terminal's own parts are MendCode's and not the project's, and names the search command", () => {
    const line = selfKnowledgeText()
    expect(line.length).toBeLessThanOrEqual(PROMPT_BUDGETS.selfKnowledge)
    expect(line).toContain(`${PROGRAM_NAME} docs --search <words>`)
    expect(line).toContain("You run inside MendCode")
    expect(line).toMatch(/screen \(start screen, logo, sidebars, bars, prompt, footer, labels\), keys, slash commands, Galaxy panel, pet, agents, models, settings and your own tools, hooks and system prompt are MendCode's, not the project's/)
    expect(line).not.toMatch(/\n|\{\{/)
  })
  test("a lasting rule is an extension: gpt-6-luna answered \"block rm -rf\" and \"never read private/\" with a promise", () => {
    expect(selfKnowledgeText()).toContain("A rule the user sets for later (block, always, before or when X do Y) is an extension, not a promise or a one-time check.")
  })
  test("the search is scoped to those parts: an unscoped \"first run docs\" made gpt-6-luna open a coding task with a docs search", () => {
    const line = selfKnowledgeText()
    expect(line).toContain(`for those only, first run \`${PROGRAM_NAME} docs --search <words>\``)
    expect(line).not.toMatch(/project's: first run/)
  })
  test("minimal, focus, guide and full carry it once, right after the boundary, for every family; custom does not", async () => {
    for (const family of FAMILIES) for (const mode of ["minimal", "focus", "guide", "full"] as const) {
      const { parts } = await compose(mode, family)
      const ids = parts.map((part) => part.id)
      expect(ids.filter((id) => id === "self-knowledge")).toHaveLength(1)
      const boundary = ids.findIndex((id) => id === (mode === "minimal" ? "base" : "boundary"))
      expect(ids[boundary + 1]).toBe("self-knowledge")
      expect(parts[boundary + 1]!.text).toBe(selfKnowledgeText())
    }
    const dir = temp(), root = temp()
    expect(composePromptParts(dir, root, await baseParts(root), { mode: "custom", focusID: "codex" }).parts.some((part) => part.id === "self-knowledge")).toBe(false)
  })
  test("minimal stays small with it: the boundary and the pointer, a quarter the size of focus", async () => {
    for (const family of FAMILIES) {
      const place = { dir: temp(), root: "/project" }
      const minimal = joined((await compose("minimal", family, place)).parts), focus = joined((await compose("focus", family, place)).parts)
      // 920: the pointer names the screen's parts (look requests) and MendCode's behavior (extensions): 428 bytes (PROMPT_BUDGETS.selfKnowledge).
      expect(minimal.length).toBeLessThanOrEqual(920)
      expect(minimal.length * 3).toBeLessThan(focus.length)
      expect(minimal).toContain(selfKnowledgeText())
    }
  })
  test("full no longer sends a map of repository docs, and its self-knowledge is the pointer plus the short guide", async () => {
    const { parts } = await compose("full", "codex")
    const added = parts.filter((part) => ["self-knowledge", "capabilities"].includes(part.id)).map((part) => part.text.length).reduce((sum, size) => sum + size, 0)
    expect(added).toBeLessThanOrEqual(PROMPT_BUDGETS.selfKnowledge + PROMPT_BUDGETS.full.operatorGuide)
    expect(joined(parts)).not.toMatch(/docs\/[\w-]+\.md/)
  })
})
