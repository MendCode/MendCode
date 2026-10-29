import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { createToolDefine } from "../src"
import { makeContext, useTempDir } from "./helpers"

const tempDir = useTempDir()

const script = `#!/bin/sh
read line
printf '{"name":"zod","version":"4.6.5","weekly":[1,2,3]}\\n'
`
const base = {
  name: "pkg_info",
  description: "Package facts",
  script: { file: "pkg_info.sh", content: script },
  args: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  render: { type: "stack", children: [{ type: "badge", text: "{{result.name}}" }, { type: "sparkline", values: "{{result.weekly}}" }] },
}

describe("tool_define", () => {
  test("writes an executable script and a manifest, and a test run returns the output and its render", async () => {
    const project = tempDir()
    const tool = createToolDefine({ userDir: tempDir() })
    const result = await tool.execute({ ...base, test: { name: "zod" } }, makeContext({ cwd: project }))
    expect(result.isError).toBe(false)
    expect(result.output).toContain("defined custom__pkg_info in .mendcode/tools")
    expect(result.output).toContain('"version":"4.6.5"')
    expect(result.render).toEqual({ type: "stack", children: [{ type: "badge", text: "zod" }, { type: "sparkline", values: [1, 2, 3] }] })
    const dir = join(project, ".mendcode", "tools")
    expect(JSON.parse(readFileSync(join(dir, "pkg_info.json"), "utf8"))).toMatchObject({ command: ["/bin/sh", "./pkg_info.sh"], render: base.render })
    expect(statSync(join(dir, "pkg_info.sh")).mode & 0o111).not.toBe(0)
  })

  test("invalid definitions are refused before anything is written", async () => {
    const project = tempDir()
    const tool = createToolDefine({ userDir: tempDir() })
    const bad = await tool.execute({ ...base, render: { type: "script", src: "x" } }, makeContext({ cwd: project }))
    expect(bad.isError).toBe(true)
    expect(bad.output).toContain("render.type")
    const badArgs = await tool.execute({ ...base, args: { type: "object", properties: { n: { type: "weird" } } } }, makeContext({ cwd: project }))
    expect(badArgs.output).toContain("args:")
    const noShebang = await tool.execute({ ...base, runner: "direct", script: { file: "x", content: "echo hi" } }, makeContext({ cwd: project }))
    expect(noShebang.output).toContain("shebang")
    expect(existsSync(join(project, ".mendcode", "tools", "pkg_info.json"))).toBe(false)
  })

  test("an existing tool is kept unless replace is set; user scope writes to the user's tools", async () => {
    const project = tempDir()
    const userDir = tempDir()
    const tool = createToolDefine({ userDir })
    await tool.execute(base, makeContext({ cwd: project }))
    expect((await tool.execute(base, makeContext({ cwd: project }))).output).toContain("already exists")
    expect((await tool.execute({ ...base, replace: true }, makeContext({ cwd: project }))).isError).toBe(false)
    await tool.execute({ ...base, scope: "user" }, makeContext({ cwd: project }))
    expect(existsSync(join(userDir, "tools", "pkg_info.json"))).toBe(true)
  })

  test("the approval preview shows the manifest and the script", async () => {
    const tool = createToolDefine({ userDir: tempDir() })
    const preview = await tool.preview!(base, makeContext({ cwd: tempDir() }))
    expect(preview).toContain("project tool custom__pkg_info")
    expect(preview).toContain('"command"')
    expect(preview).toContain("printf")
  })
})
