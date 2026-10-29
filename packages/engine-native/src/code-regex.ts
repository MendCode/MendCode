import { CodeError } from "./code-parser"
import { CRegExp } from "./code-values"

/**
 * Native regular expressions cannot be interrupted, so Code Mode only accepts patterns whose backtracking is bounded:
 * no backreferences, no quantified group containing an unbounded quantifier, no unbounded quantified alternation, and a
 * per-operation input cap derived from the longest chain of overlapping unbounded atoms (about n^degree steps).
 */
const MAX_PATTERN = 500
const INPUT_CAP = 16_384
const STEP_BUDGET = 2e9
const PROBES = [...Array.from({ length: 128 }, (_, code) => String.fromCharCode(code)), "é", "世", "😀", " "]
type Atom = { set: boolean[]; min: number; unbounded: boolean }
type Parsed = { atoms: Atom[]; unbounded: boolean; alternation: boolean }

function unsafe(message: string): never { throw new CodeError("UnsafeRegExp", `Unsupported regular expression: ${message}`) }

function classOf(source: string, flags: string): boolean[] {
  let probe: RegExp
  try { probe = new RegExp(`^(?:${source})$`, flags.replace(/[gymd]/g, "")) } catch { return PROBES.map(() => true) }
  return PROBES.map((char) => { try { return probe.test(char) } catch { return true } })
}

function analyze(pattern: string, flags: string): number {
  let at = 0
  type Quantifier = { min: number; max: number; unbounded: boolean }
  const quantifier = (): Quantifier | undefined => {
    const char = pattern[at]
    let result: Quantifier | undefined
    if (char === "*") { at++; result = { min: 0, max: Infinity, unbounded: true } }
    else if (char === "+") { at++; result = { min: 1, max: Infinity, unbounded: true } }
    else if (char === "?") { at++; result = { min: 0, max: 1, unbounded: false } }
    else if (char === "{") {
      const found = /^\{(\d+)(?:(,)(\d*))?\}/.exec(pattern.slice(at))
      if (!found) return undefined
      at += found[0].length
      const min = Number(found[1]), max = found[2] ? found[3] === "" ? Infinity : Number(found[3]) : min
      result = { min, max, unbounded: max > 100 }
    }
    if (result && (pattern[at] === "?" || pattern[at] === "+")) at++
    return result
  }
  function sequence(depth: number): Parsed {
    if (depth > 16) unsafe("groups nest too deeply")
    const atoms: Atom[] = []
    let unbounded = false, alternation = false
    while (at < pattern.length) {
      const char = pattern[at]!
      if (char === ")") break
      if (char === "|") { alternation = true; at++; continue }
      if (char === "^" || char === "$") { at++; continue }
      let atomSource = "", group: Parsed | undefined, zeroWidth = false
      if (char === "(") {
        at++
        let lookaround = false
        if (pattern.startsWith("?:", at)) at += 2
        else if (pattern.startsWith("?=", at) || pattern.startsWith("?!", at)) { at += 2; lookaround = true }
        else if (pattern.startsWith("?<=", at) || pattern.startsWith("?<!", at)) { at += 3; lookaround = true }
        else if (pattern.startsWith("?<", at)) { const end = pattern.indexOf(">", at); if (end < 0) unsafe("bad group name"); at = end + 1 }
        else if (pattern[at] === "?") unsafe("unknown group syntax")
        group = sequence(depth + 1)
        if (pattern[at] !== ")") unsafe("unbalanced group")
        at++
        zeroWidth = lookaround
      } else if (char === "[") {
        let end = at + 1
        if (pattern[end] === "^") end++
        if (pattern[end] === "]") end++
        while (end < pattern.length && pattern[end] !== "]") end += pattern[end] === "\\" ? 2 : 1
        if (end >= pattern.length) unsafe("unclosed character class")
        atomSource = pattern.slice(at, end + 1); at = end + 1
      } else if (char === "\\") {
        const next = pattern[at + 1] ?? ""
        if (/[1-9]/.test(next) || next === "k") unsafe("backreferences are not supported")
        if (next === "b" || next === "B") { at += 2; continue }
        const extra = (next === "p" || next === "P") && pattern[at + 2] === "{" ? pattern.indexOf("}", at) - at - 1 : next === "u" && pattern[at + 2] === "{" ? pattern.indexOf("}", at) - at - 1 : next === "x" ? 2 : next === "u" ? 4 : next === "c" ? 1 : 0
        const length = 2 + Math.max(0, extra)
        atomSource = pattern.slice(at, at + length); at += length
      } else if (char === "." ) { atomSource = "."; at++ }
      else { atomSource = char; at++ }
      const quant = quantifier()
      if (group) {
        if (quant && quant.max > 1 && group.unbounded) unsafe("quantified groups cannot contain unbounded quantifiers")
        if (quant?.unbounded && group.alternation) unsafe("unbounded quantified alternation")
        if (quant?.unbounded) {
          atoms.push({ set: PROBES.map((_, index) => group.atoms.some((atom) => atom.set[index])), min: quant.min, unbounded: true })
          unbounded = true
        } else {
          for (const atom of group.atoms) atoms.push(zeroWidth || quant?.min === 0 ? { ...atom, min: 0 } : atom)
          unbounded ||= group.unbounded
        }
        continue
      }
      const atom: Atom = { set: classOf(atomSource, flags), min: quant?.min ?? 1, unbounded: quant?.unbounded ?? false }
      atoms.push(atom)
      unbounded ||= atom.unbounded
    }
    return { atoms, unbounded, alternation }
  }
  const parsed = sequence(0)
  if (at < pattern.length) unsafe("unbalanced group")
  const atoms = parsed.atoms
  const overlap = (a: Atom, b: Atom) => a.set.some((value, index) => value && b.set[index])
  // Longest chain of unbounded atoms whose backtracking multiplies: overlapping classes with only optional or absorbable atoms between.
  const chain = new Array<number>(atoms.length).fill(0)
  let degree = 0
  for (let j = 0; j < atoms.length; j++) {
    if (!atoms[j]!.unbounded) continue
    chain[j] = 1
    for (let i = 0; i < j; i++) {
      if (!atoms[i]!.unbounded || !chain[i] || !overlap(atoms[i]!, atoms[j]!)) continue
      let linked = true
      for (let k = i + 1; k < j && linked; k++) linked = atoms[k]!.min === 0 || overlap(atoms[k]!, atoms[i]!)
      if (linked) chain[j] = Math.max(chain[j]!, chain[i]! + 1)
    }
    degree = Math.max(degree, chain[j]!)
  }
  const anchored = pattern.startsWith("^") && !flags.includes("m")
  return degree + (anchored ? 0 : 1)
}

/** Validates and builds a RegExp value. Throws UnsafeRegExp/InvalidDataValue instead of risking an uninterruptible match. */
export function compileRegExp(source: string, flags: string): CRegExp {
  if (!/^[dgimsuy]*$/.test(flags) || new Set(flags).size !== flags.length) throw new CodeError("InvalidDataValue", `Invalid regular expression flags: ${flags}`)
  if (source.length > MAX_PATTERN) unsafe(`pattern exceeds ${MAX_PATTERN} characters`)
  let native: RegExp
  try { native = new RegExp(source, flags) } catch (error) { throw new CodeError("InvalidDataValue", `Invalid regular expression: ${error instanceof Error ? error.message : String(error)}`) }
  const exponent = analyze(source, flags)
  return new CRegExp(native, Math.max(16, Math.min(INPUT_CAP, Math.floor(STEP_BUDGET ** (1 / Math.max(1, exponent))))))
}

export function checkInput(regexp: CRegExp, text: string) {
  if (text.length > regexp.maxInput) throw new CodeError("ValueLimitExceeded", `Regular expression input too long (${text.length} > ${regexp.maxInput}); split the text into lines or smaller chunks`)
}
