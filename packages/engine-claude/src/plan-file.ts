import { readdirSync, readFileSync, statSync } from "node:fs"
import os from "node:os"
import path from "node:path"

/** Claude Code keeps the plan it is working on in `<config dir>/plans/<name>.md`; the name is its own. */
const plansDir = () => path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "plans")
const RECENT = 6

/**
 * The file that holds the plan an `ExitPlanMode` call submits, or undefined. A path the call names is taken only inside Claude Code's
 * plans folder; otherwise the newest plans there are compared with the submitted text. A file is returned only when its text is the
 * plan, so a path the model made up, or an older plan, never stands for this one.
 */
export function claudePlanFile(plan: string, named: unknown): string | undefined {
  const dir = plansDir()
  const same = (file: string) => {
    try { return readFileSync(file, "utf8").trim() === plan.trim() } catch { return false }
  }
  if (typeof named === "string" && named.endsWith(".md")) {
    const resolved = path.resolve(named)
    if (path.dirname(resolved) === dir && same(resolved)) return resolved
  }
  try {
    const newest = readdirSync(dir).filter((name) => name.endsWith(".md")).map((name) => ({ file: path.join(dir, name), at: statSync(path.join(dir, name)).mtimeMs })).sort((a, b) => b.at - a.at).slice(0, RECENT)
    return newest.find((entry) => same(entry.file))?.file
  } catch { return undefined }
}
