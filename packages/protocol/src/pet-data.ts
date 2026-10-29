export const PET_CORE_STATES = ["idle", "running", "waiting", "review", "failed"] as const
export const PET_OPTIONAL_STATES = ["waving", "jumping"] as const
export const PET_GENERATED_STATES = [...PET_CORE_STATES, ...PET_OPTIONAL_STATES] as const
export type GeneratedPetState = (typeof PET_GENERATED_STATES)[number]
/** States only an import brings (a folder or file named after one): never generated, never a row of a `--frames` sheet. A pet without one shows another state instead. */
export const PET_IMPORT_STATES = ["thinking", "compacting", "agents", "sleeping"] as const
export const PET_STATES = [...PET_GENERATED_STATES, ...PET_IMPORT_STATES] as const
export type PetState = (typeof PET_STATES)[number]
/** The most frames `/pet new --frames` draws for one state: each is one more image call. */
export const PET_MAX_FRAMES = 4
export type PetPlan = {
  planId: string
  description: string
  states: GeneratedPetState[]
  /** Frames drawn for each state: 1 is one still pose, more a small loop around it. Absent means 1. */
  frames?: number
  calls: number
  /** What the user said one image call costs. Absent when they gave no price: nothing is assumed or estimated then. */
  unitUsd?: number
  estimatedUsd?: number
  model: string
  prompt: string
  expires: number
  petId?: string
}

/** One call of a running generation: the reference sheet, or one state. */
/** `frame` counts from 1, on a state drawn in more than one frame. */
export type PetProgressStep = { label: "reference" | GeneratedPetState; frame?: number; status: "pending" | "working" | "done" | "failed" }
export type PetProgress = { planId: string; steps: PetProgressStep[] }

/** How a pet's picture is resized: pixel art keeps its own colors, smooth artwork is averaged. */
export const PET_ART_KINDS = ["pixel", "smooth"] as const
export type PetArtKind = (typeof PET_ART_KINDS)[number]

/**
 * The sheet of an imported pet (`/pet import`): equal cells in reading order, and for each state the cells it plays with
 * how long each stays (ms). Unlike the Codex atlas (8 fixed columns, fixed frame counts and timings) a state has as many
 * frames as its source had, and a frame used twice is stored once.
 */
export type PetLayout = { art: PetArtKind; cell: { width: number; height: number }; columns: number; states: Partial<Record<PetState, Array<[cell: number, ms: number]>>> }

export const PET_LAYOUT_LIMITS = { cellSide: 1024, cells: 256, frameMs: { min: 20, max: 10_000 } } as const

/** The layout in an imported pet's manifest, or nothing when it is absent or not usable (the pet is then skipped by the loader). */
export function readPetLayout(value: unknown): PetLayout | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const { art, cell, columns, states } = value as Record<string, unknown>
  const whole = (n: unknown, max: number): n is number => typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= max
  if (!PET_ART_KINDS.includes(art as PetArtKind) || typeof cell !== "object" || cell === null || typeof states !== "object" || states === null) return undefined
  const { width, height } = cell as Record<string, unknown>
  if (!whole(width, PET_LAYOUT_LIMITS.cellSide) || !whole(height, PET_LAYOUT_LIMITS.cellSide) || !whole(columns, PET_LAYOUT_LIMITS.cells)) return undefined
  const out: PetLayout["states"] = {}
  for (const state of PET_STATES) {
    const frames = (states as Record<string, unknown>)[state]
    if (frames === undefined) continue
    if (!Array.isArray(frames) || frames.length < 1 || frames.length > PET_LAYOUT_LIMITS.cells) return undefined
    const list: Array<[number, number]> = []
    for (const frame of frames) {
      if (!Array.isArray(frame) || !Number.isInteger(frame[0]) || frame[0] < 0 || frame[0] >= PET_LAYOUT_LIMITS.cells || typeof frame[1] !== "number" || !(frame[1] >= PET_LAYOUT_LIMITS.frameMs.min && frame[1] <= PET_LAYOUT_LIMITS.frameMs.max)) return undefined
      list.push([frame[0], frame[1]])
    }
    out[state] = list
  }
  return out.idle ? { art: art as PetArtKind, cell: { width, height }, columns, states: out } : undefined
}

/** Folder and file names an import reads as a state (`typing/` is `running`); anything else is ignored with a note. */
export const PET_STATE_NAMES: Readonly<Record<string, PetState>> = {
  idle: "idle", rest: "idle", default: "idle",
  running: "running", working: "running", typing: "running", busy: "running",
  waiting: "waiting", approval: "waiting", asking: "waiting",
  failed: "failed", error: "failed", sad: "failed",
  review: "review", done: "review", happy: "review", success: "review",
  waving: "waving", wave: "waving", hello: "waving",
  jumping: "jumping", jump: "jumping", celebrate: "jumping",
  thinking: "thinking", think: "thinking", reasoning: "thinking",
  compacting: "compacting", compact: "compacting", packing: "compacting",
  agents: "agents", agent: "agents", subagents: "agents", delegating: "agents",
  sleeping: "sleeping", sleep: "sleeping", asleep: "sleeping",
}
