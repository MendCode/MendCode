import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { boot, put } from "../packages/daemon/test/native-harness"
import { parseAutomation, runAutomation, type AutomationDeps } from "../apps/cli/src/automation"
import type { CatalogPrompt } from "../apps/cli/src/catalog-automation"
import { catalogPromptHarness } from "../apps/cli/test/catalog-harness"
import { fit } from "../apps/cli/src/view/deck"
import { editorRows } from "../apps/cli/src/view/editor"
import { textWidth } from "../apps/cli/src/view/wrap"

/** Actual daemon/CLI commands and the same prompt app factory used by the terminal. All data is temporary. */
export async function renderB66Frames(directory: string, sizes: string[]) {
  mkdirSync(directory, { recursive: true })
  const h = await boot()
  try {
    const reports = new Map<string, string>()
    const prompts: Array<{ name: string; request: CatalogPrompt; answer: string }> = []
    const run = async (name: string, args: string[], answers?: string[], expected = 0) => {
      const parsed = parseAutomation(args)
      if (parsed.ok !== true) throw new Error(JSON.stringify(parsed))
      let output = ""
      const deps: AutomationDeps = { client: h.client, cwd: h.project, now: Date.now, listen: () => {}, onInterrupt: () => {}, out: { write: (text) => { output += text } }, err: { write: (text) => { output += text } },
        ...(answers ? { prompt: async (request: CatalogPrompt) => {
          const answer = answers.shift()
          if (answer === undefined) throw new Error("Missing fixture answer")
          prompts.push({ name: `${name}-${request.label.toLowerCase().replaceAll(" ", "-")}`, request, answer })
          return answer
        } } : {}),
      }
      const code = await runAutomation(parsed.command, deps)
      if (code !== expected) throw new Error(`${name} exited ${code}: ${output}`)
      reports.set(name, output.split(h.dir).join("/tmp/b66-data").split(h.project).join("/tmp/b66-project").replace(/ses_[a-z0-9]+/gi, "ses_debug_fixture"))
    }
    await run("agent-create", ["agent", "create", "--path", h.dir, "--description", "Review diffs", "--name", "reviewer", "--mode", "primary", "--permissions", "read,grep", "--model", "chatgpt/gpt-6-luna"])
    await run("agent-wizard", ["agent", "create"], ["project", "Inspect project files", "read,glob,grep", "all"])
    await run("agent-list", ["agent", "list"])
    await run("agent-debug", ["debug", "agent", "reviewer"])
    put(path.join(h.project, "README.md"), "# Fixture project\n\nAgent tooling reads this file without calling a provider.\n")
    await run("agent-debug-read", ["debug", "agent", "reviewer", "--tool", "read", "--params", '{"path":"README.md"}'])
    await run("agent-debug-denied", ["debug", "agent", "reviewer", "--tool", "write", "--params", '{"path":"README.md","content":"overwrite"}'], undefined, 1)
    await run("agent-create-duplicate", ["agent", "create", "--path", h.dir, "--description", "Review diffs", "--name", "reviewer", "--mode", "primary", "--permissions", "read"], undefined, 1)
    for (const size of sizes.length ? sizes : ["100x30", "180x50"]) {
      const match = /^(\d+)x(\d+)$/.exec(size)
      if (!match || Number(match[1]) < 40 || Number(match[2]) < 15) throw new Error(`Invalid size: ${size}`)
      const width = Number(match[1]), height = Number(match[2])
      const save = (name: string, rows: string[]) => {
        if (rows.length !== height || rows.some((row) => textWidth(row) !== width || row.includes("\x1b"))) throw new Error(`Invalid frame: ${name} ${size}`)
        writeFileSync(path.join(directory, `${name}-${size}.txt`), rows.join("\n").split(h.project).join("/tmp/b66-project").split(h.dir).join("/tmp/b66-data").split("\n").map((row) => fit([{ text: row }], width).map((span) => span.text).join("")).join("\n") + "\n")
      }
      for (const [name, output] of reports) {
        const rows = editorRows(output.trimEnd(), width).map((row) => row.text)
        for (let page = 0; page * height < rows.length; page++) save(`${name}${rows.length > height ? `-p${page + 1}` : ""}`, Array.from({ length: height }, (_, row) => fit([{ text: rows[page * height + row] ?? "" }], width).map((span) => span.text).join("")))
      }
      for (const { name, request, answer } of prompts) {
        const prompt = { ...request, ...(request.options ? {} : { initial: answer }) }
        const app = catalogPromptHarness(prompt, width, height)
        save(`${name}-initial`, app.text())
        if (request.multiple) {
          for (const [index, option] of request.options!.entries()) {
            if ((request.initial?.split(",").includes(option.value) ?? false) !== answer.split(",").includes(option.value)) app.app.key(" ")
            if (index + 1 < request.options!.length) app.app.key("\x1b[B")
          }
        } else if (request.options) {
          const selected = Math.max(0, request.options.findIndex((option) => option.value === answer))
          for (let index = 0; index < selected; index++) app.app.key("\x1b[B")
        }
        save(name, app.text())
      }
      const invalid = catalogPromptHarness({ title: "Create agent", label: "Description", validate: () => "Description must be 1–300 characters", initial: " " }, width, height)
      invalid.app.key("\r")
      save("agent-description-invalid", invalid.text())
    }
  } finally { await h.cleanup() }
}
