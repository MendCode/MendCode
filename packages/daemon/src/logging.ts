import { redactSecrets } from "@mendcode/protocol"

export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR"
const LEVELS = ["DEBUG", "INFO", "WARN", "ERROR"] as const
export function logLevel(value: string | undefined): LogLevel | undefined {
  if (value === undefined) return undefined
  if (!LEVELS.includes(value as LogLevel)) throw new Error("--log-level needs DEBUG|INFO|WARN|ERROR")
  return value as LogLevel
}

export function daemonLogger(level: () => LogLevel, output: (level: "info" | "warn" | "error", message: string) => void) {
  return (severity: "info" | "warn" | "error", message: string) => {
    if (LEVELS.indexOf(severity.toUpperCase() as LogLevel) >= LEVELS.indexOf(level())) output(severity, redactSecrets(message).text)
  }
}
