import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { openStore } from "@mendcode/store"
import { createIdFactory } from "@mendcode/protocol/wire"
import { collectUninstallPlan, type UninstallDeps } from "@mendcode/upgrade/uninstall"
import { parseUninstallArgs } from "@mendcode/upgrade/uninstall-args"
import { createUninstallPrompt } from "../src/ui/uninstall-prompt"
import type { Line } from "../src/ui/theme"

export function uninstallHarness() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "mend-uninstall-")))
  const home = path.join(root, "home")
  const dir = path.join(home, ".mendcode-v2")
  const bin = path.join(home, ".local", "bin")
  const store = openStore({ dir })
  const sessionId = createIdFactory()("session")
  store.createSession({ id: sessionId, directory: "/work/project", title: "Keep this history" })
  store.settings.set({ onboarded: true })
  store.close()
  const files: Record<string, string> = {
    "providers.json": '{"local":{"apiKey":"fixture-secret-never-print"}}',
    "tui/profile.json": '{"theme":"matrix"}', "extensions/demo.ts": "export default {}",
    "blobs/attachment": "file contents", "keys/secrets.key": "fixture encryption key",
    "scratchpads/project.txt": "project notes", "goals/goal.md": "goal", "reviews/session.json": "review",
    "builtin/build/prompt.md": "cached prompt", "pets-cache/preview": "cached pet",
    "bin/mendcode-next": "v2 managed binary", "bin/mendcode-next.prev": "v2 previous binary",
    "personal.txt": "unrelated file", "notes-link-target": "unrelated file",
  }
  for (const [name, contents] of Object.entries(files)) {
    const file = path.join(dir, name)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, contents)
  }
  mkdirSync(bin, { recursive: true })
  const binary = path.join(bin, "mendcode")
  const payload = "fixture v2 release binary"
  writeFileSync(binary, payload)
  writeFileSync(path.join(bin, ".mendcode-v2-install"), `schema=mendcode-v2.install.v1\nbinary=mendcode\nsha256=${createHash("sha256").update(payload).digest("hex")}\ntier=minimalist\n`)
  writeFileSync(path.join(bin, "mendcode-next"), '#!/bin/sh\n# mendcode-next dev wrapper\nexec bun "/work/v2/apps/cli/src/entry.ts" "$@"\n')
  let out = "", err = ""
  const deps: UninstallDeps = { home, env: {}, platform: "darwin", defaultDir: dir, out: { write: (text) => { out += text } }, err: { write: (text) => { err += text } } }
  const command = (...args: string[]) => {
    const parsed = parseUninstallArgs(["uninstall", "--dir", dir, ...args])
    if (!parsed.ok) throw new Error(parsed.message)
    return parsed.command
  }
  const ui = (width: number, height: number, args: string[] = [], overrides: Partial<UninstallDeps> = {}) => {
    const parsed = command(...args)
    const plan = collectUninstallPlan(parsed, { ...deps, ...overrides })
    const frames: Line[][] = []
    const finishes: boolean[] = []
    const app = createUninstallPrompt({ plan, size: () => ({ width, height }), draw: (rows) => frames.push(rows), finish: (value) => finishes.push(value), ...(parsed.dryRun ? { dryRun: true } : {}) })
    app.render()
    return { app, plan, frames, finishes }
  }
  return { root, home, dir, bin, binary, sessionId, deps, command, ui, output: () => ({ out, err }), cleanup: () => rmSync(root, { recursive: true, force: true }) }
}
