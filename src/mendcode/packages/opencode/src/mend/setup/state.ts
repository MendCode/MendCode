import { existsSync } from "fs"
import { mkdir, readFile, writeFile } from "fs/promises"
import path from "path"
import { mendPaths } from "../config/paths"

export type SetupStepID = "provider" | "models" | "budget" | "package" | "prompt" | "tui" | "memory" | "permissions"

export type SetupState = {
  version: 0
  completedOnce: boolean
  currentStep: SetupStepID
  completedSteps: SetupStepID[]
  dismissedAt: string | null
  lastOpenedAt: string | null
  updatedAt: string | null
}

export const setupSteps: SetupStepID[] = ["provider", "models", "budget", "package", "tui", "prompt", "memory", "permissions"]
export const requiredSetupSteps: SetupStepID[] = ["provider", "models", "budget", "prompt"]

export const defaultSetupState: SetupState = {
  version: 0,
  completedOnce: false,
  currentStep: "provider",
  completedSteps: [],
  dismissedAt: null,
  lastOpenedAt: null,
  updatedAt: null,
}

function normalizeStep(step: unknown): SetupStepID {
  return setupSteps.includes(step as SetupStepID) ? (step as SetupStepID) : "provider"
}

function normalizeState(input: unknown): SetupState {
  const record = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {}
  const completedSteps = Array.isArray(record.completedSteps)
    ? record.completedSteps.filter((step): step is SetupStepID => setupSteps.includes(step as SetupStepID))
    : []
  const complete = requiredSetupSteps.every((step) => completedSteps.includes(step))
  return {
    version: 0,
    completedOnce: record.completedOnce === true || complete,
    currentStep: normalizeStep(record.currentStep),
    completedSteps: [...new Set(completedSteps)],
    dismissedAt: typeof record.dismissedAt === "string" ? record.dismissedAt : null,
    lastOpenedAt: typeof record.lastOpenedAt === "string" ? record.lastOpenedAt : null,
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : null,
  }
}

async function writeSetupState(state: SetupState, root?: string) {
  const file = mendPaths(root).setupState
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(state, null, 2)}\n`)
  return state
}

export async function readSetupState(root?: string) {
  const file = mendPaths(root).setupState
  if (!existsSync(file)) return defaultSetupState
  try {
    return normalizeState(JSON.parse(await readFile(file, "utf8")))
  } catch {
    return defaultSetupState
  }
}

export async function openSetupState(step?: SetupStepID, root?: string) {
  const current = await readSetupState(root)
  return writeSetupState({
    ...current,
    currentStep: step || current.currentStep,
    lastOpenedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }, root)
}

export async function markSetupStepComplete(step: SetupStepID, root?: string) {
  const current = await readSetupState(root)
  const completedSteps = [...new Set([...current.completedSteps, step])]
  const completedOnce = current.completedOnce || requiredSetupSteps.every((required) => completedSteps.includes(required))
  return writeSetupState({
    ...current,
    completedOnce,
    currentStep: step,
    completedSteps,
    updatedAt: new Date().toISOString(),
  }, root)
}

export async function setSetupCurrentStep(step: SetupStepID, root?: string) {
  const current = await readSetupState(root)
  return writeSetupState({ ...current, currentStep: step, updatedAt: new Date().toISOString() }, root)
}

export async function dismissSetup(root?: string) {
  const current = await readSetupState(root)
  const now = new Date().toISOString()
  return writeSetupState({ ...current, dismissedAt: now, updatedAt: now }, root)
}

export function isSetupComplete(state: SetupState) {
  return state.completedOnce || requiredSetupSteps.every((step) => state.completedSteps.includes(step))
}
