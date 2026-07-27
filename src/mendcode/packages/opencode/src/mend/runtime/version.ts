import { readFileSync } from "fs"
import path from "path"
import { mendPaths } from "../config/paths"

export function mendRuntimeVersion(root = mendPaths().root) {
  try {
    const pkg = JSON.parse(readFileSync(path.join(mendPaths(root).ownedRuntimePackage, "package.json"), "utf8"))
    if (typeof pkg.version === "string" && pkg.version) return pkg.version
  } catch {}
  return process.env.MENDCODE_VERSION || "0.0.0"
}
