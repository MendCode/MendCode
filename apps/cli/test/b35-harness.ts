import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { readFileApi } from "../../../packages/daemon/src/file-rest"
import type { FileContent, FileSearchMatch } from "@mendcode/protocol"
import { appHarness, conversation, tempDir } from "./session-ui-harness"

/** API fixtures in the existing chat renderer; no new terminal page or command. */
export async function fileApiHarness(width: number, height: number) {
  const project = tempDir(), dataDir = tempDir()
  mkdirSync(path.join(project, "src"))
  writeFileSync(path.join(project, "src/app.ts"), "export function execute() {\n  return 42\n}\n")
  const h = appHarness({ width, height, dataDir, directory: project, version: "0.0.1-dev", remote: { host: "127.0.0.1", readOnly: false } })
  h.app.applySettings({ onboarded: true, pet: "off" })
  await h.app.start()
  const thread = conversation(h.sessionId, (event) => h.app.onEvent(event))
  const content = (await readFileApi({ directory: project, input: { operation: "file.read", path: "src/app.ts" } })).value as FileContent
  thread.exchange("Read src/app.ts", `\`\`\`typescript\n${content.content}\n\`\`\``)
  const search = async () => {
    const matches = (await readFileApi({ directory: project, input: { operation: "find.text", pattern: "execute" } })).value as FileSearchMatch[]
    thread.exchange("Find execute", matches.map((match) => `${match.path.text}:${match.line_number}  ${match.lines.text.trim()}`).join("\n"))
    h.app.render()
  }
  h.app.render()
  return { ...h, content, search }
}
