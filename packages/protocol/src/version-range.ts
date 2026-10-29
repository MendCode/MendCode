/**
 * The version ranges a package's `compatibility.mendcode` may use, checked at enable (docs/packages.md). Pure and tiny on
 * purpose: `>=1.2.0`, `^0.3`, `~1.2.3`, `1.x`, `*`, an exact `1.2.3`, and several of them joined by spaces (all must hold).
 * A pre-release or build suffix on the app's version is ignored: `0.0.1-dev` counts as `0.0.1`.
 */

type Triple = readonly [number, number, number]

const PART = /^(?:\d+|x|X|\*)$/
const OPERATOR = /^(>=|<=|>|<|=|\^|~)$/

/** `1.2` is `{ triple: [1, 2, 0], fixed: 2 }`; `1.x` is fixed 1; `x` is fixed 0. */
function parsePartial(text: string): { triple: [number, number, number]; fixed: number } | undefined {
  const parts = text.split(/[-+]/, 1)[0]!.split(".")
  if (parts.length > 3 || parts.some((part) => !PART.test(part))) return undefined
  const triple: [number, number, number] = [0, 0, 0]
  let fixed = 0
  for (const part of parts) {
    if (!/^\d+$/.test(part)) break
    triple[fixed] = Number(part)
    fixed++
  }
  return { triple, fixed }
}

/** `1.2.3` as numbers; undefined when it is not a version. A pre-release or build suffix is dropped. */
export function parseVersion(text: string): Triple | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(text.trim())
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined
}

const compare = (a: Triple, b: Triple) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]

function comparator(token: string): ((version: Triple) => boolean) | undefined {
  if (token === "*" || token === "x" || token === "X") return () => true
  const match = /^(>=|<=|>|<|=|\^|~)?(.+)$/.exec(token)
  if (!match) return undefined
  const partial = parsePartial(match[2]!)
  if (!partial) return undefined
  const operator = match[1] ?? ""
  const { triple, fixed } = partial
  /** The first version above everything `triple` stands for: `1.2` stands for 1.2.x, so 1.3.0. */
  const above: Triple = fixed === 3 ? [triple[0], triple[1], triple[2] + 1] : fixed === 2 ? [triple[0], triple[1] + 1, 0] : [triple[0] + 1, 0, 0]
  if (operator === "" || operator === "=") return (version) => version.slice(0, fixed).every((part, index) => part === triple[index])
  if (operator === ">=") return (version) => compare(version, triple) >= 0
  if (operator === ">") return (version) => fixed > 0 && compare(version, above) >= 0
  if (operator === "<=") return (version) => fixed > 0 && compare(version, above) < 0
  if (operator === "<") return (version) => compare(version, triple) < 0
  const upper: Triple = operator === "~" ? (fixed === 1 ? [triple[0] + 1, 0, 0] : [triple[0], triple[1] + 1, 0]) : triple[0] > 0 || fixed === 1 ? [triple[0] + 1, 0, 0] : triple[1] > 0 || fixed === 2 ? [0, triple[1] + 1, 0] : [0, 0, triple[2] + 1]
  return (version) => compare(version, triple) >= 0 && compare(version, upper) < 0
}

/** `">=", "1.2.0"` (an operator written apart from its version) become `">=1.2.0"`. */
function tokens(range: string): string[] {
  const out: string[] = []
  for (const token of range.trim().split(/\s+/).filter(Boolean)) {
    if (out.length && OPERATOR.test(out.at(-1)!)) out[out.length - 1] = `${out.at(-1)}${token}`
    else out.push(token)
  }
  return out
}

/** Why `range` cannot be read, or undefined when it can. */
export function versionRangeProblem(range: string): string | undefined {
  const list = tokens(range)
  if (list.length === 0) return "empty version range"
  if (list.length > 4) return "at most four comparators"
  return list.every((token) => comparator(token)) ? undefined : `cannot read version range "${range}" (use >=1.2.0, ^0.3, ~1.2.3, 1.x or an exact version)`
}

/** Whether `version` is inside `range`; undefined when either cannot be read. */
export function versionSatisfies(version: string, range: string): boolean | undefined {
  const parsed = parseVersion(version)
  const checks = tokens(range).map(comparator)
  if (!parsed || !checks.length || checks.some((check) => !check)) return undefined
  return checks.every((check) => check!(parsed))
}

/** The one line the enable refusal shows when the manifest asks for a newer app or extension API than this one. */
export function compatibilityProblem(input: { compatibility?: { mendcode?: string | undefined; api?: number | undefined } | undefined; appVersion?: string | undefined; apiVersion: number }): string | undefined {
  const wanted = input.compatibility
  if (!wanted) return undefined
  if (wanted.api !== undefined && wanted.api > input.apiVersion) return `needs extension API ${wanted.api} or newer (this MendCode has ${input.apiVersion}); update MendCode`
  if (wanted.mendcode && input.appVersion && versionSatisfies(input.appVersion, wanted.mendcode) === false) return `needs MendCode ${wanted.mendcode} (this is ${input.appVersion}); update MendCode or install an older release of the package`
  return undefined
}
