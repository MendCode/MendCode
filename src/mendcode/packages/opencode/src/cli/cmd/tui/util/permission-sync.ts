export const PERMISSION_SYNC_RETRY_DELAYS_MS = [250, 750, 1500] as const

type PermissionRule = {
  permission: string
  pattern: string
  action: string
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined
  const value = error as { code?: unknown; cause?: unknown }
  if (typeof value.code === "string") return value.code
  return value.cause === error ? undefined : errorCode(value.cause)
}

function errorText(error: unknown) {
  if (error instanceof Error) {
    const cause = error.cause instanceof Error ? error.cause.message : ""
    return `${error.message} ${cause}`
  }
  if (typeof error === "string") return error
  return String(error)
}

export function isTransientPermissionSyncError(error: unknown) {
  const code = errorCode(error)
  if (code && ["ECONNABORTED", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE"].includes(code)) return true
  return /fetch failed|network|socket connection|connection (?:aborted|closed|refused|reset|lost)|timed out/i.test(
    errorText(error),
  )
}

export function sessionPermissionModeSynced(
  rules: readonly PermissionRule[] | undefined,
  permissionName: string,
  mode: string,
) {
  const current = rules?.findLast((rule) => rule.permission === permissionName)
  return current?.action === "allow" && current.pattern === mode
}

function waitForRetry(ms: number, signal: AbortSignal) {
  return new Promise<boolean>((resolve) => {
    if (signal.aborted) {
      resolve(false)
      return
    }

    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (result: boolean) => {
      if (timer) clearTimeout(timer)
      signal.removeEventListener("abort", abort)
      resolve(result)
    }
    const abort = () => finish(false)
    timer = setTimeout(() => finish(true), ms)
    signal.addEventListener("abort", abort, { once: true })
  })
}

export async function syncPermissionModeWithRetry(input: {
  mode: string
  permissionName: string
  signal: AbortSignal
  read: () => Promise<readonly PermissionRule[] | undefined>
  write: () => Promise<void>
  retryDelaysMs?: readonly number[]
}) {
  const retryDelays = input.retryDelaysMs ?? PERMISSION_SYNC_RETRY_DELAYS_MS

  for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
    if (input.signal.aborted) return false

    if (attempt > 0) {
      if (!(await waitForRetry(retryDelays[attempt - 1]!, input.signal))) return false
      try {
        const current = await input.read()
        if (sessionPermissionModeSynced(current, input.permissionName, input.mode)) return true
      } catch {
        // The read is only reconciliation. The bounded write retry below may still recover.
      }
    }

    try {
      await input.write()
      return true
    } catch (error) {
      if (input.signal.aborted) return false
      if (!isTransientPermissionSyncError(error) || attempt === retryDelays.length) throw error
    }
  }

  return false
}
