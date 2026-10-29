import { createPromptModes } from "../../../packages/daemon/src/prompt-modes"
import { appHarness, tempDir } from "./session-ui-harness"
import type { CommandReply } from "@mendcode/client"

export function b05Harness(width = 100, height = 30) {
  const dataDir = tempDir(), directory = tempDir()
  const modes = createPromptModes(dataDir)
  let error = ""
  const h = appHarness({ width, height, dataDir, directory, reply: (command) => {
    const result = command.type === "prompt.status" ? modes.status(directory) : command.type === "prompt.set" ? error ? undefined : modes.set(directory, { ...(command.mode ? { mode: command.mode } : {}), ...(command.focusID ? { focusID: command.focusID } : {}) }) : command.type === "prompt.cycle" ? modes.cycle(directory) : command.type === "models.list" ? { engine: "faux", selectable: false, models: [], defaults: { model: "local:test" }, effective: { model: "local:test" }, roles: {} } : command.type === "daemon.info" ? { engine: "faux", dataDir, pid: 1, buildId: "b05-local" } : command.type === "mcp.status" ? { servers: [], issues: [] } : command.type === "memory.list" ? { memories: [] } : command.type === "recipes.list" ? { recipes: [] } : undefined
    return command.type === "prompt.set" && error ? { ok: false, error: { code: "invalid_command", message: error } } : { ok: true, ...(result ? { result } : {}) } as CommandReply
  } })
  h.app.applySettings({ onboarded: true })
  return { ...h, directory, dataDir, modes, refuse: (message: string) => { error = message } }
}
