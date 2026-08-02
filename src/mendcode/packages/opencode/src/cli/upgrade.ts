import { Flag } from "@mendcode/core/flag/flag"
import { Installation } from "@/installation"
import { InstallationVersion } from "@mendcode/core/installation/version"
import semver from "semver"

export const SKIPPED_UPDATE_VERSION_KEY = "mendcode_skipped_version"

export function skippedUpdateVersion(store: Record<string, unknown>) {
  const value = store[SKIPPED_UPDATE_VERSION_KEY]
  return typeof value === "string" ? value : undefined
}

export function shouldNotifyUpdate(autoupdate: boolean | "notify" | undefined, kind: Installation.ReleaseType) {
  return autoupdate !== true || kind !== "patch"
}

export function updateAction(
  autoupdate: boolean | "notify" | undefined,
  current: string,
  latest: string,
): "none" | "notify" | "upgrade" {
  if (!semver.gt(latest, current)) return "none"
  return shouldNotifyUpdate(autoupdate, Installation.getReleaseType(current, latest)) ? "notify" : "upgrade"
}

export async function checkUpgrade(autoupdate: boolean | "notify" | undefined) {
  if (autoupdate === false || Flag.OPENCODE_DISABLE_AUTOUPDATE) return
  if (Installation.isLocal()) return
  const method = await Installation.method()
  const latest = await Installation.latest(method).catch(() => {})
  if (!latest) return

  if (Flag.OPENCODE_ALWAYS_NOTIFY_UPDATE) {
    return { type: "notify" as const, version: latest }
  }

  const action = updateAction(autoupdate, InstallationVersion, latest)
  if (action === "none") return
  if (action === "notify") return { type: "notify" as const, version: latest }

  if (method === "unknown") return
  const updated = await Installation.upgrade(method, latest)
    .then(() => true)
    .catch(() => false)
  if (updated) return { type: "updated" as const, version: latest }
}
