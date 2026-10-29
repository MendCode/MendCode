import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { appHarness, cleanTemps } from "../apps/cli/test/session-ui-harness"
import { boot } from "../packages/daemon/test/native-harness"
import { parseAutomation, runAutomation, type AutomationDeps } from "../apps/cli/src/automation"
import { fit } from "../apps/cli/src/view/deck"
import { textWidth, wrap } from "../apps/cli/src/view/wrap"

export async function renderB43Frames(directory: string, sizes: string[]) {
  const h = await boot()
  try {
    writeFileSync(path.join(h.project, "AGENTS.md"), "Read repository contracts before editing.")
    mkdirSync(path.join(h.project, "docs"))
    writeFileSync(path.join(h.project, "docs", "api.md"), "# API contracts\n")
    writeFileSync(path.join(h.project, "package.json"), JSON.stringify({ name: "local-api", scripts: { test: "bun test" } }))
    const external = path.join(h.dir, "local-skills", "review")
    mkdirSync(external, { recursive: true })
    writeFileSync(path.join(external, "SKILL.md"), "---\nname: review\ndescription: Review API contracts and their callers\n---\nRead the changed contract and verify its callers.\n")
    const settings = await h.client.send({ type: "settings.set", patch: { skills: { paths: [path.dirname(external)] } } })
    if (!settings.ok) throw new Error(settings.error.message)
    const reports = new Map<string, string>()
    for (const [name, args] of [
      ["project-init", ["init"]],
      ["project-config-show", ["config-show"]],
      ["project-context-status", ["context-status"]],
      ["project-context-refresh", ["context-refresh"]],
      ["project-context-show", ["context-show"]],
      ["project-focus-status", ["focus-status"]],
      ["project-focus-list", ["focus-list"]],
      ["project-focus-show", ["focus-show", "claude"]],
      ["project-focus-use", ["focus-use", "claude"]],
      ["project-package-show", ["package-show"]],
      ["project-package-set", ["package-set", "--title", "Local API", "--version", "2.0", "--id", "local-api"]],
    ] as const) {
      const parsed = parseAutomation(["control-plane", "project", ...args])
      if (parsed.ok !== true) throw new Error(JSON.stringify(parsed))
      let output = ""
      const deps: AutomationDeps = { client: h.client, cwd: h.project, now: () => Date.now(), out: { write: (text) => { output += text } }, err: { write: (text) => { output += text } }, listen() {}, onInterrupt() {} }
      if (await runAutomation(parsed.command, deps) !== 0) throw new Error(output)
      reports.set(name, output.replaceAll(h.project, "/work/local-api").replaceAll(h.dir, "/tmp/mend-data"))
    }
    for (const size of sizes.length ? sizes : ["100x30", "180x50"]) {
      const match = /^(\d+)x(\d+)$/.exec(size)
      if (!match) throw new Error(`Invalid size: ${size}`)
      const width = Number(match[1]), height = Number(match[2])
      const save = (name: string, rows: string[]) => {
        if (rows.length !== height || rows.some((row) => textWidth(row) !== width || row.includes("\x1b"))) throw new Error(`Invalid frame ${name} ${size}`)
        writeFileSync(path.join(directory, `${name}-${size}.txt`), rows.join("\n") + "\n")
      }
      for (const [name, output] of reports) {
        const rows = wrap(output.trimEnd(), width)
        for (let page = 0; page * height < rows.length; page++) save(`${name}${rows.length > height ? `-p${page + 1}` : ""}`, Array.from({ length: height }, (_, row) => fit([{ text: rows[page * height + row] ?? "" }], width).map((span) => span.text).join("")))
      }
      const app = appHarness({ width, height, directory: h.project, dataDir: h.dir, reply: async (command) => ["prompt.status", "prompt.set", "prompt.cycle", "skills.list", "skills.load", "skills.set"].includes(command.type) ? h.client.send(command) : { ok: true } })
      app.app.applySettings({ onboarded: true })
      const frame = (name: string) => {
        app.app.render()
        save(name, app.frames.at(-1)!.map((line) => fit(line, width).map((span) => span.text).join("")))
      }
      await app.type("/skills\r")
      await app.type("review")
      frame("skills-external")
      await app.app.onKey("\x0c")
      frame("skills-external-body")
      await app.app.onKey("\x1b")
      await app.app.onKey("\x1b")
      await app.type("/prompt-mode\r")
      await app.app.onKey("2")
      await app.app.onKey("\x1b[B")
      frame("prompt-focus-project")
      await app.app.onKey("\x03")
    }
  } finally { cleanTemps(); await h.cleanup() }
}
