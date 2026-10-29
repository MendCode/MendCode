import type { AdapterOptions, HarnessAdapter } from "../lib/types"

export const HARNESS_NAMES = ["mendcode", "codex", "claude-code", "fake"] as const
export type HarnessName = (typeof HARNESS_NAMES)[number]

export function isHarnessName(value: string): value is HarnessName {
  return (HARNESS_NAMES as readonly string[]).includes(value)
}

/** One adapter per run. Modules load lazily so `fake` never imports the product's client and `codex` never touches it either. */
export async function createAdapter(name: HarnessName, options: AdapterOptions): Promise<HarnessAdapter> {
  switch (name) {
    case "fake":
      return (await import("./fake")).createFakeAdapter(options)
    case "codex":
      return (await import("./codex")).createCodexAdapter(options)
    case "claude-code":
      return (await import("./claude-code")).createClaudeCodeAdapter(options)
    case "mendcode":
      return (await import("./mendcode")).createMendcodeAdapter(options)
  }
}
