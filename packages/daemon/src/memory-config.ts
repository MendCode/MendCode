import type { Settings } from "@mendcode/protocol"

/** Project overrides affect the same retrieval, generation and Dream paths as global settings. */
export function memorySettings(settings: Settings, directory?: string): Settings {
  return { ...settings, ...(directory ? settings.memoryProjects?.[directory] : {}) }
}
