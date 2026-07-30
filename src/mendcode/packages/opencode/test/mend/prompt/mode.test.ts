import { describe, expect, test } from "bun:test"
import { mkdir, writeFile } from "fs/promises"
import path from "path"
import {
  availablePromptModes,
  cyclePromptMode,
  promptModeLabel,
  readPromptMode,
  writePromptMode,
} from "../../../src/mend/prompt/mode"
import { tmpdir } from "../../fixture/fixture"

describe("mend prompt modes", () => {
  test("keeps legacy modes and cycles custom only when its file is available", async () => {
    await using tmp = await tmpdir()
    const customFile = path.join(tmp.path, ".mendcode/prompts/custom.md")
    await mkdir(path.dirname(customFile), { recursive: true })
    await writeFile(customFile, "Project-specific instructions\n")
    await mkdir(path.join(tmp.path, ".mendcode"), { recursive: true })
    await writeFile(path.join(tmp.path, ".mendcode/prompt-mode.json"), JSON.stringify({ version: 0, mode: "dev-js" }))

    expect((await readPromptMode(tmp.path)).mode).toBe("full")
    expect(await availablePromptModes(tmp.path)).toEqual(["minimal", "focus", "full", "custom"])

    await writePromptMode("custom", tmp.path)
    expect((await readPromptMode(tmp.path)).mode).toBe("custom")
    expect((await cyclePromptMode(tmp.path)).mode).toBe("minimal")
  })

  test("uses the project-defined custom name for the visible prompt label", async () => {
    await using tmp = await tmpdir()
    const customFile = path.join(tmp.path, ".mendcode/prompts/custom.md")
    await mkdir(path.dirname(customFile), { recursive: true })
    await writeFile(customFile, "---\nname: Hello World Demo\n---\nalways say first Hello World!\n")
    await writePromptMode("custom", tmp.path)

    const state = await readPromptMode(tmp.path)

    expect(promptModeLabel(state)).toBe("Hello World Demo")
    expect(state.customPrompt.text).toBe("always say first Hello World!")
  })

  test("keeps an unavailable persisted custom mode safe and out of the cycle", async () => {
    await using tmp = await tmpdir()
    await writePromptMode("custom", tmp.path)

    const state = await readPromptMode(tmp.path)
    expect(state.mode).toBe("custom")
    expect(state.customPrompt.available).toBe(false)
    expect(await availablePromptModes(tmp.path)).toEqual(["minimal", "focus", "full"])
    expect((await cyclePromptMode(tmp.path)).mode).toBe("minimal")
  })
})
