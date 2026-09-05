import fs from "node:fs"

export const BACKEND_PREPARATION_TIMEOUT_MS = 15 * 60_000
export type BackendPhase = "backup" | "migration" | "ready" | "failed"

export function reportBackendPhase(phase: BackendPhase) {
  const file = process.env.MENDCODE_BACKEND_STARTUP_FILE
  const token = process.env.MENDCODE_BACKEND_STARTUP_TOKEN
  if (!file || !token) return
  const temporary = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temporary, JSON.stringify({ pid: process.pid, token, phase }), { mode: 0o600 })
  fs.renameSync(temporary, file)
}

export function readBackendPhase(file: string, pid: number, token: string): BackendPhase | undefined {
  try {
    const stat = fs.lstatSync(file)
    if (!stat.isFile() || stat.size > 1024) return
    const value = JSON.parse(fs.readFileSync(file, "utf8"))
    if (value.pid !== pid || value.token !== token) return
    if (["backup", "migration", "ready", "failed"].includes(value.phase)) return value.phase
  } catch { /* The child may not have published its first phase yet. */ }
}

export async function waitForBackend<T>(input: {
  connect: () => Promise<T | undefined>
  alive: () => boolean
  phase: () => BackendPhase | undefined
  progress: (phase: BackendPhase) => void
  timeoutMs?: number
  preparationTimeoutMs?: number
  pollMs?: number
}) {
  const started = Date.now()
  let readyAt: number | undefined
  let previous: BackendPhase | undefined
  while (input.alive()) {
    const phase = input.phase()
    if (phase !== previous && phase) { input.progress(phase); previous = phase }
    if (phase === "failed") return
    if (phase === "ready") readyAt ??= Date.now()
    const preparing = phase === "backup" || phase === "migration"
    const deadline = preparing
      ? started + (input.preparationTimeoutMs ?? BACKEND_PREPARATION_TIMEOUT_MS)
      : (readyAt ?? started) + (input.timeoutMs ?? 30_000)
    if (Date.now() >= deadline) return
    const connection = await input.connect()
    if (connection) return connection
    await new Promise((resolve) => setTimeout(resolve, input.pollMs ?? 100))
  }
}
