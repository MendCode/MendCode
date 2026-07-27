export const SHELL_OUTPUT_UPDATE_INTERVAL = 250
export const SHELL_LIVE_OUTPUT_MAX_CHARS = 30_000
export const SHELL_LIVE_OUTPUT_DELTA_MAX_CHARS = 32_000

export function shellLiveOutput(text: string) {
  if (text.length <= SHELL_LIVE_OUTPUT_MAX_CHARS) return text
  return "...\n\n" + text.slice(-SHELL_LIVE_OUTPUT_MAX_CHARS)
}

export function createShellOutputDeltaBuffer(maxChars = SHELL_LIVE_OUTPUT_DELTA_MAX_CHARS) {
  const limit = Math.max(1, Math.floor(maxChars))
  let value = ""
  let omitted = 0

  return {
    append(text: string) {
      if (!text) return
      if (text.length >= limit) {
        omitted += value.length + text.length - limit
        value = text.slice(-limit)
        return
      }
      const keep = limit - text.length
      if (value.length > keep) {
        omitted += value.length - keep
        value = value.slice(-keep)
      }
      value += text
    },
    hasPending() {
      return value.length > 0
    },
    take() {
      if (!value) return ""
      if (omitted === 0) {
        const result = value
        value = ""
        return result
      }

      const notice = `[Live output throttled: omitted ${omitted} chars]\n`
      const result = notice + value.slice(-Math.max(0, limit - notice.length))
      value = ""
      omitted = 0
      return result
    },
  }
}

export * as ShellOutput from "./shell-output"
