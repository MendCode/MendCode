import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createNativeEngine, createInstructionLoader, loadSystemPrompt, type ModelRequest } from "@mendcode/engine-native"
import { PROMPT_FAMILIES, promptFocusLabel, type PromptBuildReport } from "@mendcode/protocol/wire"
import type { SessionId as ProtocolSessionId } from "@mendcode/protocol"
import { startDaemon } from "../src"
import { composePromptParts, createPromptModes, promptBuildReport, readProjectPrompt } from "../src/prompt-modes"
import { familyForModel, resolveFocus } from "../src/prompt-focus"
import { systemPartsWith } from "../src/extensions/prompt-files"
import { promptFileOverrides } from "../src/prompt-context"

const cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })
function temp() {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mend-b05-")))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
function put(root: string, relative: string, text: string) {
  const file = path.join(root, relative)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, text)
  return file
}
const parts = [{ id: "base", label: "native", text: "native harness" }, { id: "instructions", label: "project", text: "project rules" }, { id: "skills", label: "skills", text: "skill catalogue" }, { id: "append", label: "extension", text: "extension append" }, { id: "memory", label: "memory", text: "memory rules" }]

test("project modes and all six families persist independently of folder profiles and other projects", () => {
  const dir = temp(), project = temp(), other = temp()
  const modes = createPromptModes(dir)
  expect(modes.status(project)).toMatchObject({ mode: "focus", focusID: "auto", available: ["minimal", "focus", "guide", "full"] })
  for (const focusID of PROMPT_FAMILIES) {
    modes.set(project, { mode: "full", focusID })
    expect(createPromptModes(dir).status(project)).toMatchObject({ mode: "full", focusID, resolvedFocus: focusID })
    expect(composePromptParts(dir, project, parts).parts.find((p) => p.id === "focus")?.text).toContain(focusID)
  }
  expect(modes.status(other)).toMatchObject({ mode: "focus", focusID: "auto" })
  expect(() => modes.set(project, { mode: "wrong" as never })).toThrow()
})
test("cycle skips unavailable custom, includes it when ready, and recovers after it disappears", () => {
  const dir = temp(), project = temp()
  const modes = createPromptModes(dir)
  expect(modes.cycle(project).mode).toBe("guide")
  expect(modes.cycle(project).mode).toBe("full")
  expect(modes.cycle(project).mode).toBe("minimal")
  put(project, ".mendcode/prompts/custom.md", "---\r\nname: 'API work'\r\n---\r\nWork at {{cwd}}")
  expect(modes.status(project).customPrompt).toMatchObject({ name: "API work", available: true })
  modes.set(project, { mode: "full" })
  expect(modes.cycle(project).mode).toBe("custom")
  expect(modes.cycle(project).mode).toBe("minimal")
  modes.set(project, { mode: "custom" })
  writeFileSync(path.join(project, ".mendcode/prompts/custom.md"), "")
  expect(modes.cycle(project).mode).toBe("minimal")
})
test("custom files are bounded, nonempty, project-contained, named and hot-reloaded", () => {
  const root = temp(), external = temp()
  const file = put(root, ".mendcode/prompts/custom.md", "# Backend\nUse tests")
  expect(readProjectPrompt(root).status).toMatchObject({ name: "Backend", available: true })
  writeFileSync(file, "---\nname: Empty\n---\n")
  expect(readProjectPrompt(root).status.available).toBe(false)
  writeFileSync(file, "é".repeat(17_000))
  expect(readProjectPrompt(root).status.fallbackReason).toContain("32768")
  rmSync(file)
  symlinkSync(put(external, "outside.md", "outside"), file)
  expect(readProjectPrompt(root).status.fallbackReason).toContain("inside the project")
})
test("mode composition matches preset boundaries, memory stays independent and custom does not inherit presets", () => {
  const dir = temp(), root = temp()
  const build = (mode: "minimal" | "focus" | "guide" | "full" | "custom") => composePromptParts(dir, root, parts, { mode })
  // The user's instructions are in every mode; the skill catalog is a focus/full choice (minimal and custom leave it to the skill tool).
  // Every mode but custom carries the one-line pointer to `mendcode docs` right after the boundary. APPEND_SYSTEM.md (`append`) is
  // the user's own text, like the instructions, so every mode carries it.
  expect(build("minimal").parts.map((p) => p.id)).toEqual(["base", "self-knowledge", "instructions", "append", "memory"])
  // Memory is chosen per user message, so in focus, guide and full it is the last part and everything before it is a stable prefix.
  expect(build("focus").parts.map((p) => p.id)).toEqual(["base", "instructions", "skills", "append", "boundary", "self-knowledge", "focus", "memory"])
  expect(build("guide").parts.map((p) => p.id)).toEqual(["base", "instructions", "skills", "append", "boundary", "self-knowledge", "focus", "focus-guide", "memory"])
  expect(build("full").parts.map((p) => p.id)).toEqual([...parts.map((p) => p.id).filter((id) => id !== "memory"), "boundary", "self-knowledge", "focus", "focus-guide", "capabilities", "memory"])
  expect(build("custom").parts.map((p) => p.id)).toEqual(["boundary", "instructions", "append", "memory"])
  put(root, ".mendcode/prompts/custom.md", "---\nname: Custom\n---\nWork at {{cwd}}")
  const custom = build("custom")
  expect(custom.parts.map((p) => p.id)).toEqual(["boundary", "base", "instructions", "append", "memory"])
  expect(custom.parts[1]?.text).toBe(`Work at ${root}`)
  expect(promptBuildReport(custom, {}).instructions).toBeUndefined()
})
test("full loads family context without duplicating the instruction hierarchy; reports redact secrets", () => {
  const dir = temp(), root = temp()
  put(root, "AGENTS.md", "project hierarchy")
  put(root, "GEMINI.md", "checkpoint rules")
  const instructions = createInstructionLoader()(root)
  const composed = composePromptParts(dir, root, [{ id: "base", label: "native", text: "native" }, { id: "instructions", label: "project", text: instructions }], { mode: "full", focusID: "gemini", modelID: "gemini-test", role: "review", workflow: "edit" })
  expect(composed.parts.filter((p) => p.text.includes("project hierarchy"))).toHaveLength(1)
  expect(composed.parts.find((p) => p.id === "focus-context:GEMINI.md")?.text).toBe("checkpoint rules")
  const token = "sk-proj-" + "s".repeat(64)
  put(root, ".mendcode/prompts/custom.md", "private " + token)
  const custom = composePromptParts(dir, root, parts, { mode: "custom" })
  const report = promptBuildReport(custom, { showFull: true })
  expect(JSON.stringify(report)).not.toContain(token)
  expect(report.printsFullPrompt).toBe(true)
})

test("build bindings change review/edit and model guidance only inside focus/full, never the runtime model", () => {
  const dir = temp(), root = temp()
  const build = (mode: "minimal" | "focus" | "full" | "custom", focusID: "codex" | "claude" = "codex", role = "review") => composePromptParts(dir, root, parts, { mode, focusID, modelID: "openai:gpt-6-astra", role, workflow: "edit" })
  expect(build("focus").parts.find((part) => part.id === "model-behavior")?.text).toContain("model alias")
  const reviewed = build("full")
  expect(reviewed.parts.find((part) => part.id === "review")?.text).toContain("does not grant permission to edit")
  expect(reviewed.parts.some((part) => part.id === "editing")).toBe(false)
  expect(build("focus", "codex", "main").parts.find((part) => part.id === "editing")?.text).toContain("focused patches")
  expect(build("focus", "claude").parts.some((part) => part.id === "model-behavior")).toBe(false)
  for (const mode of ["minimal", "custom"] as const) expect(build(mode).parts.some((part) => ["binding", "model-behavior", "review", "editing"].includes(part.id))).toBe(false)
  expect(createPromptModes(dir).status(root)).toMatchObject({ mode: "focus", focusID: "auto" })
})

test("auto follows the model: every family's ids map to it, open-weight and local-host ids map to local, and unknown ids get no vendor's guidance", () => {
  const cases: Array<[string | undefined, string]> = [
    ["claude-sonnet-5-5", "claude"], ["anthropic:claude-opus-5", "claude"], ["anthropic/claude-sonnet-4-5-20250929", "claude"], ["openrouter/anthropic/claude-3", "claude"], ["sonnet", "claude"], ["opus", "claude"],
    ["gpt-6-sol", "codex"], ["gpt-5-codex", "codex"], ["openai/gpt-oss-120b", "codex"], ["o3-mini", "codex"], ["o4", "codex"], ["codex", "codex"], ["chatgpt:gpt-6-luna", "codex"], ["openai/beta", "codex"],
    ["gemini-3-pro", "gemini"], ["google/gemini-3-pro", "gemini"],
    ["kimi-k2-5", "kimi"], ["moonshotai/kimi-k2", "kimi"], ["moonshot-v1", "kimi"],
    ["deepseek-v4-pro", "deepseek"], ["openrouter/deepseek/deepseek-v3.2", "deepseek"],
    ["mistral-large", "mistral"], ["codestral-latest", "mistral"], ["devstral-2", "mistral"],
    ["glm-5.1", "glm"], ["z-ai/glm-5", "glm"], ["zai:glm-4.6", "glm"], ["zhipuai/glm-4.5-air", "glm"], ["openrouter/z.ai/glm-5", "glm"],
    ["minimax-m2.5", "minimax"], ["MiniMax-M2", "minimax"], ["mini-max/m2", "minimax"], ["openrouter/minimax/minimax-m2", "minimax"],
    ["grok-code-fast-1", "grok"], ["xai:grok-4", "grok"], ["x-ai/grok-4-fast", "grok"],
    ["local:test", "local"], ["llama-3.3-70b", "local"], ["qwen3-coder", "local"], ["ollama:qwen2.5-coder:7b", "local"], ["ollama:llama3.1:8b", "local"], ["lmstudio:google/gemma-3-12b", "local"], ["lm-studio:my-model", "local"], ["llamacpp/anything", "local"], ["phi4", "local"],
    ["ollama:deepseek-r1:7b", "local"], ["openrouter/deepseek/deepseek-r1", "deepseek"],
    ["default", "neutral"], ["engine default", "neutral"], ["", "neutral"], [undefined, "neutral"], ["acme-1", "neutral"], ["acme:custom-model:latest", "neutral"],
  ]
  for (const [model, family] of cases) expect([model, familyForModel(model)]).toEqual([model, family])
  // A look-alike inside a word is not a family: `bigpt` and `video` do not match `gpt` or `o\d`.
  expect(familyForModel("bigpt-4")).toBe("neutral")
  expect(resolveFocus("auto", "claude-sonnet-5-5")).toBe("claude")
  expect(resolveFocus("gemini", "claude-sonnet-5-5")).toBe("gemini")
})

test("a Claude model gets Claude guidance under the default family; an explicit family still wins and persists; a saved codex is kept", () => {
  const dir = temp(), project = temp(), legacy = temp()
  const call = (focusID?: "auto" | "codex" | "gemini") => composePromptParts(dir, project, parts, { mode: "focus", modelID: "claude-sonnet-5-5", ...(focusID ? { focusID } : {}) })
  const focus = (composed: ReturnType<typeof call>) => composed.parts.find((part) => part.id === "focus")
  expect(createPromptModes(dir).status(project, "claude-sonnet-5-5")).toMatchObject({ focusID: "auto", resolvedFocus: "claude" })
  expect(promptFocusLabel(createPromptModes(dir).status(project, "claude-sonnet-5-5"))).toBe("auto → claude")
  expect(focus(call())).toMatchObject({ label: "auto → claude focus", text: expect.stringContaining("MendCode focus: claude (auto).") })
  expect(call().parts.find((part) => part.id === "model-behavior")?.label).toBe("Claude Sonnet 5 guidance")
  // An explicit family wins over the model, in the call and after a restart.
  createPromptModes(dir).set(project, { focusID: "gemini" })
  expect(createPromptModes(dir).status(project, "claude-sonnet-5-5")).toMatchObject({ focusID: "gemini", resolvedFocus: "gemini" })
  expect(focus(call())).toMatchObject({ label: "gemini focus", text: expect.stringContaining("MendCode focus: gemini.") })
  expect(call().parts.some((part) => part.id === "model-behavior")).toBe(false)
  expect(focus(call("auto"))?.label).toBe("auto → claude focus")
  // A `codex` saved before `auto` existed stays: it cannot be told apart from a deliberate choice.
  writeFileSync(path.join(dir, "prompt-context.json"), JSON.stringify({ [realpathSync(legacy)]: { mode: "focus", focusID: "codex" } }))
  expect(createPromptModes(dir).status(legacy, "claude-sonnet-5-5")).toMatchObject({ focusID: "codex", resolvedFocus: "codex" })
  expect(composePromptParts(dir, legacy, parts, { modelID: "claude-sonnet-5-5" }).parts.find((part) => part.id === "focus")?.text).toContain("MendCode focus: codex.")
  // Going back to auto is a choice like any other.
  createPromptModes(dir).set(legacy, { focusID: "auto" })
  expect(createPromptModes(dir).status(legacy, "claude-sonnet-5-5")).toMatchObject({ focusID: "auto", resolvedFocus: "claude" })
})

test("switching the session's model changes the guidance on the next call, and an unknown model gets neutral guidance rather than another vendor's", () => {
  const dir = temp(), project = temp()
  createPromptModes(dir).set(project, { mode: "focus" })
  const text = (modelID: string | undefined) => composePromptParts(dir, project, parts, { mode: "focus", ...(modelID ? { modelID } : {}) }).parts.filter((part) => ["focus", "model-behavior"].includes(part.id)).map((part) => `${part.label}: ${part.text}`).join("\n")
  const claude = text("claude-sonnet-5-5"), gpt = text("gpt-6-astra"), unknown = text("acme-1")
  expect(claude).toContain("MendCode focus: claude")
  expect(claude).toContain("Claude Sonnet 5 guidance")
  expect(gpt).toContain("MendCode focus: codex")
  expect(gpt).toContain("GPT-6 Astra compatibility")
  expect(gpt).not.toContain("Claude")
  expect(unknown).toContain("MendCode focus: neutral")
  for (const other of ["AGENTS.md hierarchy", "Plan complex work", "checkpoints", "shell tools", "cache usage", "turn and cost limits"]) expect(unknown).not.toContain(other)
  expect(text(undefined)).toContain("MendCode focus: neutral")
  // The status of a call that names no model reads the project's main model through the injected resolver.
  const following = createPromptModes(dir, { defaultModel: () => "gemini-3-pro" })
  expect(following.status(project)).toMatchObject({ focusID: "auto", resolvedFocus: "gemini" })
  expect(following.status(project, "kimi-k2-5")).toMatchObject({ resolvedFocus: "kimi" })
  expect(following.sources(project, "deepseek-v4-pro")).toMatchObject({ focusID: "auto", resolvedFocus: "deepseek", focusLabel: "auto → deepseek", neutral: { id: "neutral" } })
  expect(createPromptModes(dir).status(project)).toMatchObject({ resolvedFocus: "neutral" })
})

test("wire commands, typed client, daemon restart and real native requests share the chosen policy without provider services", async () => {
  const dir = temp(), project = temp()
  put(project, "AGENTS.md", "PROJECT_RULE")
  put(project, ".mendcode/APPEND_SYSTEM.md", "APPEND_RULE")
  put(project, ".mendcode/skills/a/SKILL.md", "---\nname: a\ndescription: SKILL_RULE\n---\nInstructions")
  const requests: ModelRequest[] = []
  const packaged = await loadSystemPrompt()
  const instructions = createInstructionLoader()
  const boot = async () => {
    const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), defaultDirectory: project, log: () => {}, engine: ({ store, skills, extensions }) => createNativeEngine({
      provider: {
        id: "fake", model: "test",
        async *stream(request) {
          requests.push(request)
          yield { type: "text", delta: "done" }
          yield { type: "finish", reason: "stop" }
        },
      },
      tools: [], compactionPrompt: "Summarize", history: { load: async () => undefined, save: async () => {}, replace: async () => {} }, cwdFor: (id) => store.sessionDirectory(id)!,
      system: (root) => composePromptParts(dir, root, systemPartsWith({ root, packaged, files: promptFileOverrides(dir, root, extensions.prompts), rest: [{ id: "instructions", label: "project instructions", text: instructions(root) }, { id: "skills", label: "skills", text: skills.block(root) }] })).parts.map((p) => p.text).join("\n\n"),
    }) })
    cleanup.push(() => daemon.stop())
    const client = createClient({ socketPath: daemon.socketPath, name: "b05-test" })
    await client.connect()
    cleanup.push(() => client.close())
    return { daemon, client }
  }
  const h = await boot()
  expect(await h.client.promptStatus(project)).toMatchObject({ ok: true, result: { mode: "focus" } })
  const created = await h.client.send({ type: "session.create", directory: project })
  const sessionId = (created.ok ? created.result?.sessionId : undefined) as ProtocolSessionId
  for (const mode of ["minimal", "focus", "full", "custom"] as const) {
    if (mode === "custom") put(project, ".mendcode/prompts/custom.md", "CUSTOM_RULE")
    expect(await h.client.promptSet(project, { mode, focusID: "claude" })).toMatchObject({ ok: true, result: { mode, focusID: "claude" } })
    const before = requests.length
    const built = await h.client.promptBuild(project, { mode, focusID: "claude", showFull: true })
    expect(requests).toHaveLength(before)
    expect(await h.client.send({ type: "user.submit", sessionId, text: mode, attachments: [] })).toMatchObject({ ok: true })
    for (let i = 0; i < 100 && requests.length === before; i++) await Bun.sleep(5)
    expect(requests[before]?.system).toBe(built.ok ? (built.result as PromptBuildReport).instructions : "failed")
    expect(requests[before]?.system.includes("PROJECT_RULE"), `${mode}: the user's AGENTS.md is in every mode`).toBe(true)
    expect(requests[before]?.system.includes("SKILL_RULE")).toBe(mode === "focus" || mode === "full")
    expect(requests[before]?.system.includes("APPEND_RULE"), `${mode}: APPEND_SYSTEM.md is in every mode`).toBe(true)
    expect(requests[before]?.system.includes("CUSTOM_RULE")).toBe(mode === "custom")
    await Bun.sleep(5)
  }
  h.client.close()
  await h.daemon.stop()
  const restarted = await boot()
  expect(await restarted.client.promptStatus(project)).toMatchObject({ ok: true, result: { mode: "custom", focusID: "claude" } })
  expect(await restarted.client.send({ type: "prompt.sources", directory: project })).toMatchObject({ ok: true, result: { profileMapping: "undecided" } })
})
