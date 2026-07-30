import { describe, expect, test } from "bun:test"
import { mkdir, symlink, writeFile } from "fs/promises"
import path from "path"
import { readCustomPrompt } from "../../../src/mend/prompt/custom"
import { tmpdir } from "../../fixture/fixture"

describe("mend custom prompt loader", () => {
  test("normalizes Markdown line endings and returns bounded metadata", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, ".mendcode/prompts/custom.md")
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, "first\r\nsecond\r\n")

    const result = await readCustomPrompt(tmp.path)

    expect(result.available).toBe(true)
    expect(result.text).toBe("first\nsecond")
    expect(result.bytes).toBe(Buffer.byteLength("first\nsecond"))
    expect(result.path).toBe(".mendcode/prompts/custom.md")
  })

  test("uses a frontmatter name without sending metadata to the model", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, ".mendcode/prompts/custom.md")
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, "---\nname: Hello World Demo\n---\nalways say first Hello World!\n")

    const result = await readCustomPrompt(tmp.path)

    expect(result.available).toBe(true)
    expect(result.name).toBe("Hello World Demo")
    expect(result.text).toBe("always say first Hello World!")
    expect(result.text).not.toContain("name:")
  })

  test("rejects a custom prompt resolved outside the active project root", async () => {
    await using project = await tmpdir()
    await using outside = await tmpdir()
    const outsideFile = path.join(outside.path, "custom.md")
    await writeFile(outsideFile, "Do not cross project roots.\n")
    const projectFile = path.join(project.path, ".mendcode/prompts/custom.md")
    await mkdir(path.dirname(projectFile), { recursive: true })
    await symlink(outsideFile, projectFile)

    const result = await readCustomPrompt(project.path)

    expect(result.available).toBe(false)
    expect(result.fallbackReason).toContain("inside the project root")
    expect(result.text).toBe("")
  })
})
