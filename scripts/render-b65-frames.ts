import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import type { Settings, ThemeFile } from "@mendcode/protocol"
import { createFauxEngine } from "../packages/engine-faux/src"
import { startDaemon } from "../packages/daemon/src"
import { nativeTheme, legacyTheme } from "../packages/protocol/test/theme-fixtures"
import { parseAutomation, runAutomation, type AutomationDeps } from "../apps/cli/src/automation"
import { appHarness } from "../apps/cli/test/session-ui-harness"
import { registerThemes, setTheme } from "../apps/cli/src/ui/theme"
import { themesFromFiles } from "../apps/cli/src/ui/theme-files"
import { DEFAULT_TUI_PROFILE, writeTuiProfile } from "../apps/cli/src/view/tui-profile"
import { CUSTOMIZE_ROWS } from "../apps/cli/src/view/customize-page"
import { editorRows } from "../apps/cli/src/view/editor"
import { fit } from "../apps/cli/src/view/deck"
import { textWidth } from "../apps/cli/src/view/wrap"

export async function renderB65Frames(directory: string, sizes: string[]) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mendcode-b65-frames-")))
  const project = path.join(dir, "project")
  const other = path.join(dir, "other")
  mkdirSync(project)
  mkdirSync(other)
  writeFileSync(path.join(project, "forest.json"), JSON.stringify(nativeTheme))
  writeFileSync(path.join(project, "legacy.json"), JSON.stringify(legacyTheme))
  writeFileSync(path.join(project, "invalid.json"), "{}")
  const reports = new Map<string, string>()
  const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }) }).catch((error) => { rmSync(dir, { recursive: true, force: true }); throw error })
  const client = createClient({ socketPath: daemon.socketPath, name: "B65 frames" })
  try {
    await client.connect()
    const run = async (name: string, args: string[], expected = 0) => {
      const parsed = parseAutomation([...args, "--dir", dir])
      if (parsed.ok !== true) throw new Error(JSON.stringify(parsed))
      let output = ""
      const deps: AutomationDeps = { client, cwd: project, now: Date.now, listen: () => {}, onInterrupt: () => {}, out: { write: (text) => { output += text } }, err: { write: (text) => { output += text } } }
      const code = await runAutomation(parsed.command, deps)
      if (code !== expected) throw new Error(`${name} exited ${code}: ${output}`)
      reports.set(name, output.replaceAll(dir, "/tmp/b65-data"))
    }
    await run("validate", ["theme", "validate", "forest.json"])
    await run("validate-v1", ["theme", "validate", "legacy.json"])
    await run("validate-invalid", ["theme", "validate", "invalid.json", "--json"], 1)
    await run("install-project", ["theme", "install", "legacy.json", "--name", "Forest_Mode"])
    await run("install-user", ["theme", "install", "forest.json", "--scope", "global", "--name", "user-forest"])
    await run("select-user", ["theme", "select", "user-forest", "--scope", "user"])
    await run("select-project", ["theme", "select", "Forest_Mode"])
    await run("install-invalid", ["theme", "install", "invalid.json", "--json"], 1)
    await run("select-missing", ["theme", "select", "missing", "--json"], 1)
    const settingsReply = await client.send({ type: "settings.get" })
    if (!settingsReply.ok) throw new Error("settings unavailable")
    const settings = (settingsReply.result as { settings: Settings }).settings
    for (const size of sizes.length ? sizes : ["100x30", "180x50"]) {
      const match = /^(\d+)x(\d+)$/.exec(size)
      if (!match || Number(match[1]) < 20 || Number(match[2]) < 10) throw new Error(`invalid size: ${size}`)
      const width = Number(match[1]), height = Number(match[2])
      const save = (name: string, rows: string[]) => {
        if (rows.length !== height || rows.some((row) => textWidth(row) > width || row.includes("\x1b"))) throw new Error(`invalid source frame ${name} ${size}`)
        const normalized = rows.map((row) => row.replaceAll(dir, "/tmp/b65-data"))
        const fitted = normalized.map((row) => fit([{ text: row }], width).map((span) => span.text).join(""))
        if (fitted.length !== height || fitted.some((row) => textWidth(row) !== width || row.includes("\x1b"))) throw new Error(`invalid frame ${name} ${size}`)
        writeFileSync(path.join(directory, `${name}-${size}.txt`), fitted.join("\n") + "\n")
      }
      for (const [name, output] of reports) {
        const rows = editorRows(output.trimEnd(), width).map((row) => row.text)
        for (let page = 0; page * height < rows.length; page++) save(`${name}${rows.length > height ? `-p${page + 1}` : ""}`, Array.from({ length: height }, (_, row) => rows[page * height + row] ?? ""))
      }
      for (const [scope, cwd] of [["project", project], ["user", other]] as const) {
        const filesReply = await client.send({ type: "themes.list", directory: cwd })
        if (!filesReply.ok) throw new Error("themes unavailable")
        registerThemes(themesFromFiles((filesReply.result as { themes: ThemeFile[] }).themes).themes)
        writeTuiProfile(dir, { ...DEFAULT_TUI_PROFILE, theme: settings.theme ?? "", homeLayout: "split", homeRightPanel: "actions", logoKind: "both", pet: "off" })
        const fixture = appHarness({ width, height, directory: cwd, dataDir: dir, env: { USER: "Developer" }, reply: (command) => client.send(command) })
        fixture.app.applySettings({ ...settings, onboarded: true })
        await Bun.sleep(10)
        fixture.app.render()
        save(`home-${scope}-theme`, fixture.text())
        await fixture.type("/customize\r")
        for (let row = 0; row < CUSTOMIZE_ROWS.indexOf("theme"); row++) await fixture.app.onKey("\x1b[B")
        fixture.app.render()
        save(`customize-${scope}-theme`, fixture.text())
      }
    }
  } finally {
    client.close()
    await daemon.stop()
    registerThemes([])
    setTheme("mend")
    rmSync(dir, { recursive: true, force: true })
  }
}
