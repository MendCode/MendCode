import { PROCESS_MODES } from "./process-modes"

export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR"
const LEVELS = ["DEBUG", "INFO", "WARN", "ERROR"] as const

/** Global logging flags are removed before either command parser sees them. */
export function parseGlobalOptions(argv: string[]) {
  const args: string[] = []
  let printLogs = false
  let pure = false
  let safeMode = false
  let offline = false
  let logLevel: LogLevel | undefined
  let trace: boolean | undefined
  let approve: boolean | undefined
  let strictConfig = false
  let processMode: (typeof PROCESS_MODES)[number] | undefined
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!
    if (token === "--") { args.push(...argv.slice(i)); break }
    if (token === "--process" || token.startsWith("--process=")) {
      const value = token === "--process" ? argv[++i] : token.slice(10)
      const mode = PROCESS_MODES.find((entry) => entry === value)
      if (!mode) throw new Error("--process needs auto|solo|daemon")
      processMode = mode
      continue
    }
    if (token === "--pure" || token === "--pure=true") pure = true
    else if (token === "--pure=false") pure = false
    else if (token === "--safe-mode" || token === "--safe-mode=true") safeMode = true
    else if (token === "--safe-mode=false") safeMode = false
    else if (token === "--offline" || token === "--offline=true") offline = true
    else if (token === "--offline=false") offline = false
    else if (token === "--print-logs" || token === "--print-logs=true") printLogs = true
    else if (token === "--trace" || token === "--trace=true") trace = true
    else if (token === "--no-trace" || token === "--trace=false") trace = false
    else if (token.startsWith("--trace=")) throw new Error("--trace needs true|false")
    else if (token === "--approve") { approve = true; args.push(token) } // stays in args: run, session send, github run and debug agent read it as "approve tool calls"
    else if (token === "--no-approve") approve = false
    else if (token.startsWith("--approve=")) throw new Error("--approve takes no value; use --no-approve to decline")
    else if (token === "--strict-config" || token === "--strict-config=true") strictConfig = true
    else if (token === "--strict-config=false") strictConfig = false
    else if (token === "--no-print-logs" || token === "--print-logs=false") printLogs = false
    else if (token === "--log-level" || token.startsWith("--log-level=")) {
      const level = token === "--log-level" ? argv[++i] : token.slice(12)
      if (!LEVELS.includes(level as LogLevel)) throw new Error("--log-level needs DEBUG|INFO|WARN|ERROR")
      logLevel = level as LogLevel
    } else args.push(token === "-h" ? "--help" : token === "-v" ? "--version" : token)
  }
  return { args, printLogs, ...(processMode ? { processMode } : {}), ...(strictConfig ? { strictConfig: true } : {}), ...(pure ? { pure: true } : {}), ...(safeMode ? { safeMode: true } : {}), ...(offline ? { offline: true } : {}), ...(logLevel ? { logLevel } : {}), ...(trace === undefined ? {} : { trace }), ...(approve === undefined ? {} : { approve }) }
}

/** Diagnostics never echo argv, prompts or credential-bearing responses. */
export function cliLogger(options: { printLogs: boolean; logLevel?: LogLevel }, err: { write(text: string): unknown }) {
  return (level: LogLevel, message: string) => {
    if (options.printLogs && LEVELS.indexOf(level) >= LEVELS.indexOf(options.logLevel ?? "INFO")) err.write(`${level} [CLI] ${message}\n`)
  }
}
