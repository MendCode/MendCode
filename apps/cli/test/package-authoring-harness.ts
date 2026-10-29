import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { authorLocalPackage, createPackageRegistry, deleteLocalPackage, listPackages } from "../../../packages/packages/src"
import { appHarness, NOW, tempDir } from "./session-ui-harness"

export function packageAuthoringHarness(width = 100, height = 30) {
  const directory = tempDir("mend-author-project-"), userDir = tempDir("mend-author-user-")
  mkdirSync(path.join(directory, ".mendcode/commands"), { recursive: true })
  mkdirSync(path.join(directory, ".mendcode/skills/review"), { recursive: true })
  writeFileSync(path.join(directory, ".mendcode/commands/review.md"), "Review $ARGUMENTS")
  writeFileSync(path.join(directory, ".mendcode/skills/review/SKILL.md"), "# Review\nCheck changed boundaries")
  const registry = () => createPackageRegistry({ directory, userDir })
  const author = (action: "create" | "update", version = "1.0.0") => authorLocalPackage({ directory, action, metadata: { id: "review-kit", title: "Review Kit", description: "Project review command and skill", version }, include: ["commands", "skills"], now: () => NOW })
  const h = appHarness({ width, height, directory, dataDir: userDir, reply: async (command) => {
    if (command.type === "packages.search") return { ok: true, result: registry().search(command.query, command.sourceId) }
    if (command.type === "packages.sources") return { ok: true, result: { sources: registry().sources() } }
    if (command.type === "packages.preview") return { ok: true, result: registry().preview(command.name, command.sourceId, command.scope) }
    if (command.type === "packages.list") return { ok: true, result: { directory, packages: listPackages({ directory, userDir }) } }
    if (command.type === "packages.install-catalog") {
      await registry().install(command.name, command.sourceId, command.scope, command.replace, () => NOW)
      return { ok: true, result: { directory, packages: listPackages({ directory, userDir }) } }
    }
    return { ok: true }
  } })
  h.app.applySettings({ onboarded: true, pet: "off" })
  return { ...h, directory, userDir, author, registry, deleteLocal: () => deleteLocalPackage(directory) }
}
