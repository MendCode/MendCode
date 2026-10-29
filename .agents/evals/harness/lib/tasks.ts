import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import type { Task, TaskMeta } from "./types"

export const HARNESS_ROOT = path.resolve(import.meta.dir, "..")
export const TASKS_DIR = path.join(HARNESS_ROOT, "tasks")

export function listTaskIds(tasksDir = TASKS_DIR): string[] {
  return readdirSync(tasksDir)
    .filter((name) => statSync(path.join(tasksDir, name)).isDirectory())
    .sort()
}

export function parseMeta(raw: unknown, id: string): TaskMeta {
  const meta = raw as Partial<TaskMeta> | null
  if (!meta || typeof meta.category !== "string" || meta.category === "") throw new Error(`[TASK]: ${id}: meta.category must be a non-empty string`)
  if (!Number.isInteger(meta.expectedSteps) || (meta.expectedSteps as number) < 1) throw new Error(`[TASK]: ${id}: meta.expectedSteps must be a positive integer`)
  if (!Number.isInteger(meta.timeoutSeconds) || (meta.timeoutSeconds as number) < 1) throw new Error(`[TASK]: ${id}: meta.timeoutSeconds must be a positive integer`)
  return { category: meta.category, expectedSteps: meta.expectedSteps as number, timeoutSeconds: meta.timeoutSeconds as number }
}

export function loadTask(id: string, tasksDir = TASKS_DIR): Task {
  const dir = path.join(tasksDir, id)
  if (!existsSync(dir)) throw new Error(`[TASK]: unknown task ${id}`)
  const need = (relative: string) => {
    const full = path.join(dir, relative)
    if (!existsSync(full)) throw new Error(`[TASK]: ${id}: missing ${relative}`)
    return full
  }
  const meta = parseMeta(JSON.parse(readFileSync(need("meta.json"), "utf8")), id)
  return {
    id,
    dir,
    repoDir: need("repo"),
    prompt: readFileSync(need("prompt.md"), "utf8").trim(),
    meta,
    checkScript: need("check.sh"),
    checkDir: path.join(dir, "check"),
    solutionPatch: path.join(dir, "solution.patch"),
  }
}

/** `all` or a comma-separated list of task ids. */
export function selectTasks(spec: string, tasksDir = TASKS_DIR): Task[] {
  const available = listTaskIds(tasksDir)
  const ids = spec === "all" ? available : spec.split(",").map((item) => item.trim()).filter(Boolean)
  if (ids.length === 0) throw new Error("[TASK]: no tasks selected")
  const unknown = ids.filter((id) => !available.includes(id))
  if (unknown.length > 0) throw new Error(`[TASK]: unknown task(s) ${unknown.join(", ")}; available: ${available.join(", ")}`)
  return ids.map((id) => loadTask(id, tasksDir))
}
