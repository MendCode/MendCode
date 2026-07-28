type Env = Record<string, string | undefined>

function envFlag(value: string | undefined) {
  if (value === undefined) return undefined
  const normalized = value.trim().toLowerCase()
  if (!normalized || normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") return false
  return true
}

export function tuiFastBootEnabled(env: Env = process.env) {
  return envFlag(env.MENDCODE_FAST_BOOT) ?? envFlag(env.OPENCODE_FAST_BOOT) ?? true
}

export function initialTuiPluginReady(fastBoot: boolean) {
  return fastBoot
}

export function syncReadyForStatus(status: "loading" | "partial" | "complete") {
  return status !== "loading"
}

export function syncBootstrapReadiness(input: { fastBoot: boolean; continueSession?: boolean }) {
  return {
    blockProviderMetadata: !input.fastBoot,
    blockProviderUxMetadata: !input.fastBoot,
    blockSessionList: Boolean(input.continueSession),
  }
}

export function isCurrentTuiBootstrap(input: {
  generation: number
  currentGeneration: number
  workspace?: string
  currentWorkspace?: string
}) {
  return input.generation === input.currentGeneration && input.workspace === input.currentWorkspace
}

export function themeModeWaitMs(fastBoot: boolean) {
  return fastBoot ? 50 : 1000
}
