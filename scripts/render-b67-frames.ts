import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { b67Harness } from "../packages/daemon/test/b67-harness"
import { parseAutomation, runAutomation, type AutomationDeps } from "../apps/cli/src/automation"
import { fit } from "../apps/cli/src/view/deck"
import { textWidth } from "../apps/cli/src/view/wrap"

function terminalRows(output: string, width: number) {
  const rows: string[] = []
  for (const source of output.trimEnd().split("\n")) {
    let row = "", columns = 0
    for (const character of source) {
      const text = character === "\t" ? " ".repeat(8 - columns % 8) : character
      for (const cell of text) {
        const size = textWidth(cell)
        if (columns + size > width) { rows.push(row); row = ""; columns = 0 }
        row += cell
        columns += size
      }
    }
    rows.push(row)
  }
  return rows
}

/** CLI donor surfaces use their real plain output, captured through the automation harness. */
export async function renderB67Frames(directory: string, sizes: string[]) {
  mkdirSync(directory, { recursive: true })
  const h = await b67Harness()
  try {
    const git = (...args: string[]) => {
      const result = Bun.spawnSync(["git", ...args], { cwd: h.project, stdout: "pipe", stderr: "pipe" })
      if (result.exitCode) throw new Error(result.stderr.toString())
    }
    git("init", "--quiet")
    git("add", ".")
    git("-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "--quiet", "-m", "fixture")
    await h.client.send({ type: "session.create", directory: h.project, title: "Support diagnostics" })
    h.put(path.join(h.dir, "skills", "audit", "SKILL.md"), "---\nname: audit\ndescription: Review local sources\n---\nInspect source.\n")
    const before = await h.client.debug(h.project, { operation: "snapshot.track" })
    if (!before.ok) throw new Error(before.error.message)
    const hash = (before.report.data as { hash: string }).hash
    h.put(path.join(h.project, "README.md"), "Updated project notes\n")
    const reports = new Map<string, string>()
    const cases: Array<[string, string[]]> = [
      ["db-path", ["db", "path"]], ["db-tsv", ["db", "SELECT title, directory FROM sessions", "--format", "tsv"]], ["db-json", ["db", "SELECT title FROM sessions", "--format", "json"]],
      ["debug-agent", ["debug", "agent", "build"]], ["debug-agent-tool", ["debug", "agent", "build", "--tool", "read", "--params", '{"path":"README.md"}', "--approve"]],
      ...["config", "info", "paths", "scrap", "skill", "startup"].map((command): [string, string[]] => [`debug-${command}`, ["debug", command]]),
      ["debug-file-search", ["debug", "file", "search", "app"]], ["debug-file-read", ["debug", "file", "read", "README.md"]], ["debug-file-status", ["debug", "file", "status"]], ["debug-file-list", ["debug", "file", "list", "."]], ["debug-file-tree", ["debug", "file", "tree"]],
      ["debug-lsp-diagnostics", ["debug", "lsp", "diagnostics", "src/app.fake"]], ["debug-lsp-symbols", ["debug", "lsp", "symbols", "execute"]], ["debug-lsp-document-symbols", ["debug", "lsp", "document-symbols", `file://${h.project}/src/app.fake`]],
      ["debug-rg-files", ["debug", "rg", "files"]], ["debug-rg-tree", ["debug", "rg", "tree"]], ["debug-rg-search", ["debug", "rg", "search", "execute"]],
      ["debug-snapshot-track", ["debug", "snapshot", "track"]], ["debug-snapshot-patch", ["debug", "snapshot", "patch", hash]], ["debug-snapshot-diff", ["debug", "snapshot", "diff", hash]],
      ["debug-help", ["debug", "--help"]], ["db-help", ["db", "--help"]],
      ["db-shell", ["db"]], ["debug-wait", ["debug", "wait", "--timeout-ms", "1"]],
      ["debug-error", ["debug", "file", "read", "../outside.txt"]], ["db-write-rejected", ["db", "DELETE FROM sessions"]],
    ]
    for (const [name, args] of cases) {
      const parsed = parseAutomation(args)
      if (parsed.ok !== true) throw new Error(JSON.stringify(parsed))
      let output = ""
      const deps = { client: h.client, cwd: h.project, out: { write: (text: string) => { output += text } }, err: { write: (text: string) => { output += text } }, now: Date.now, listen: () => {}, onInterrupt: () => {}, sqlLines: async function* () { yield "SELECT 42 AS value;"; yield ".quit" } } as AutomationDeps
      const code = await runAutomation(parsed.command, deps)
      if (code !== (name.endsWith("error") || name === "db-write-rejected" ? 1 : 0)) throw new Error(`${name}: ${output}`)
      reports.set(name, output)
    }
    for (const size of sizes.length ? sizes : ["100x30", "180x50"]) {
      const match = /^(\d+)x(\d+)$/.exec(size)
      if (!match) throw new Error(`invalid size ${size}`)
      const width = Number(match[1]), height = Number(match[2])
      for (const [name, output] of reports) {
        const lines = terminalRows(output, width)
        for (let page = 0; page < Math.max(1, Math.ceil(lines.length / height)); page++) {
          const rows = Array.from({ length: height }, (_, row) => fit([{ text: lines[page * height + row] ?? "" }], width).map((span) => span.text).join(""))
          if (rows.some((row) => textWidth(row) !== width || row.includes("\x1b"))) throw new Error(`invalid frame ${name}`)
          writeFileSync(path.join(directory, `${name}${lines.length > height ? `-p${page + 1}` : ""}-${size}.txt`), rows.join("\n") + "\n")
        }
      }
    }
  } finally { await h.cleanup() }
}
