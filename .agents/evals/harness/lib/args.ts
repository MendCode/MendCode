export type ParsedArgs = { flags: Map<string, string | true>; positionals: string[] }

/** `--key value`, `--key=value` and bare `--flag`. A value never starts with `--`. */
export function parseArgs(argv: readonly string[], booleanFlags: readonly string[] = []): ParsedArgs {
  const flags = new Map<string, string | true>()
  const positionals: string[] = []
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]!
    if (!token.startsWith("--")) {
      positionals.push(token)
      continue
    }
    const equals = token.indexOf("=")
    if (equals > 0) {
      flags.set(token.slice(2, equals), token.slice(equals + 1))
      continue
    }
    const key = token.slice(2)
    const next = argv[index + 1]
    if (booleanFlags.includes(key) || next === undefined || next.startsWith("--")) flags.set(key, true)
    else {
      flags.set(key, next)
      index++
    }
  }
  return { flags, positionals }
}

export function stringFlag(args: ParsedArgs, key: string): string | undefined {
  const value = args.flags.get(key)
  if (value === undefined) return undefined
  if (value === true) throw new Error(`--${key} needs a value`)
  return value
}

export function requiredFlag(args: ParsedArgs, key: string): string {
  const value = stringFlag(args, key)
  if (value === undefined || value === "") throw new Error(`--${key} is required`)
  return value
}

export function intFlag(args: ParsedArgs, key: string, fallback: number, min = 1): number {
  const raw = stringFlag(args, key)
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min) throw new Error(`--${key} must be an integer >= ${min}`)
  return value
}

export function listFlag(args: ParsedArgs, key: string): string[] | undefined {
  const raw = stringFlag(args, key)
  return raw === undefined ? undefined : raw.split(",").map((item) => item.trim()).filter(Boolean)
}

export function rejectUnknown(args: ParsedArgs, known: readonly string[]): void {
  for (const key of args.flags.keys()) if (!known.includes(key)) throw new Error(`unknown option --${key}`)
  if (args.positionals.length > 0) throw new Error(`unexpected argument ${args.positionals[0]}`)
}
