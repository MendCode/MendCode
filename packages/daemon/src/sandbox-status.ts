import { sandboxBackend, type SandboxBackend } from "@mendcode/tools"
import type { SandboxStatus, Settings } from "@mendcode/protocol"

/** What `/sandbox` shows: the effective setting and whether this system can enforce it (a missing backend refuses commands, it never runs them unconfined). */
export function sandboxStatus({ settings, backend: given }: { settings: Pick<Settings, "sandbox">; /** Tests: `null` means this system has none; omitted detects it. */ backend?: SandboxBackend | null }): SandboxStatus {
  const backend = given === undefined ? sandboxBackend() : given
  const mode = settings.sandbox?.mode ?? "off"
  const network = settings.sandbox?.network ?? "off"
  const writableRoots = [...(settings.sandbox?.writableRoots ?? [])]
  const base = { mode, network, writableRoots, ...(backend ? { backend: backend.name } : {}) } as const
  if (mode === "off") return { ...base, enforced: false, detail: backend ? `off; ${backend.name} available` : "off; no sandbox backend on this system (macOS sandbox-exec or Linux bwrap)" }
  if (!backend) return { ...base, enforced: false, detail: `${mode} is set but no sandbox backend exists here (macOS sandbox-exec or Linux bwrap): agent commands are refused until /sandbox off` }
  return { ...base, enforced: true, detail: `${mode} through ${backend.name}, network ${network}${mode === "workspace-write" ? ", writes limited to the project and temp directories" : ", no writes"}` }
}
