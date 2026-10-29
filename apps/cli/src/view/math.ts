import { textWidth } from "./wrap"

/**
 * LaTeX math as Unicode text for the terminal. `mathInline` flattens to one line (fractions as a/b, scripts as
 * super/subscript characters); `mathDisplay` additionally stacks fractions, big-operator limits, matrices, cases
 * and aligned rows into several lines. Malformed or unknown input never throws: the unknown command name or the
 * raw source is shown instead, so streamed, half-written math still renders.
 */

type Block = { rows: string[]; base: number }
type Kind = "start" | "atom" | "op" | "open"

const MAX_SOURCE = 4000
const MAX_DEPTH = 24

const GREEK: Record<string, string> = {
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ϵ", varepsilon: "ε", zeta: "ζ", eta: "η", theta: "θ", vartheta: "ϑ", iota: "ι", kappa: "κ", lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", omicron: "ο", pi: "π", varpi: "ϖ", rho: "ρ", varrho: "ϱ", sigma: "σ", varsigma: "ς", tau: "τ", upsilon: "υ", phi: "φ", varphi: "ϕ", chi: "χ", psi: "ψ", omega: "ω",
  Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Xi: "Ξ", Pi: "Π", Sigma: "Σ", Upsilon: "Υ", Phi: "Φ", Psi: "Ψ", Omega: "Ω",
}
const RELATIONS: Record<string, string> = {
  leq: "≤", le: "≤", geq: "≥", ge: "≥", neq: "≠", ne: "≠", approx: "≈", equiv: "≡", sim: "∼", simeq: "≃", cong: "≅", propto: "∝", ll: "≪", gg: "≫",
  to: "→", rightarrow: "→", leftarrow: "←", gets: "←", leftrightarrow: "↔", Rightarrow: "⇒", Leftarrow: "⇐", Leftrightarrow: "⇔", implies: "⟹", impliedby: "⟸", iff: "⟺", mapsto: "↦", longrightarrow: "⟶", longleftarrow: "⟵", uparrow: "↑", downarrow: "↓", hookrightarrow: "↪", rightleftharpoons: "⇌",
  in: "∈", notin: "∉", ni: "∋", subset: "⊂", subseteq: "⊆", supset: "⊃", supseteq: "⊇", nsubseteq: "⊈", mid: "∣", parallel: "∥", perp: "⊥", vdash: "⊢", models: "⊨", prec: "≺", succ: "≻", doteq: "≐", asymp: "≍", colon: ":",
}
const BINARY: Record<string, string> = {
  times: "×", cdot: "·", div: "÷", pm: "±", mp: "∓", cup: "∪", cap: "∩", setminus: "∖", wedge: "∧", land: "∧", vee: "∨", lor: "∨", oplus: "⊕", ominus: "⊖", otimes: "⊗", odot: "⊙", ast: "∗", star: "⋆", circ: "∘", bullet: "∙", uplus: "⊎", sqcup: "⊔", sqcap: "⊓",
}
const ORDINARY: Record<string, string> = {
  infty: "∞", partial: "∂", nabla: "∇", emptyset: "∅", varnothing: "∅", forall: "∀", exists: "∃", nexists: "∄", neg: "¬", lnot: "¬", ldots: "…", dots: "…", cdots: "⋯", vdots: "⋮", ddots: "⋱", hbar: "ℏ", ell: "ℓ", Re: "ℜ", Im: "ℑ", aleph: "ℵ", angle: "∠", triangle: "△", degree: "°", prime: "′", top: "⊤", bot: "⊥", surd: "√", square: "□", Box: "□", diamond: "◇", checkmark: "✓", dag: "†", ddag: "‡", S: "§", P: "¶", copyright: "©", pounds: "£", euro: "€", yen: "¥", imath: "ı", jmath: "ȷ", wp: "℘", backslash: "\\",
  "{": "{", "}": "}", "%": "%", $: "$", "&": "&", "#": "#", _: "_", "|": "‖",
}
const OPENERS: Record<string, string> = { langle: "⟨", lbrace: "{", lbrack: "[", lvert: "|", lVert: "‖", lceil: "⌈", lfloor: "⌊" }
const CLOSERS: Record<string, string> = { rangle: "⟩", rbrace: "}", rbrack: "]", rvert: "|", rVert: "‖", rceil: "⌉", rfloor: "⌋", vert: "|", Vert: "‖" }
const BIG: Record<string, string> = { sum: "∑", prod: "∏", coprod: "∐", int: "∫", iint: "∬", iiint: "∭", oint: "∮", bigcup: "⋃", bigcap: "⋂", bigoplus: "⨁", bigotimes: "⨂", bigvee: "⋁", bigwedge: "⋀" }
/** Operators whose limits stack above/below in display math (integrals keep inline scripts). */
const STACKED_LIMITS = new Set(["sum", "prod", "coprod", "bigcup", "bigcap", "bigoplus", "bigotimes", "bigvee", "bigwedge", "lim", "limsup", "liminf", "max", "min", "sup", "inf"])
const FUNCTIONS = new Set(["sin", "cos", "tan", "cot", "sec", "csc", "arcsin", "arccos", "arctan", "sinh", "cosh", "tanh", "log", "ln", "lg", "exp", "lim", "limsup", "liminf", "max", "min", "sup", "inf", "arg", "det", "dim", "ker", "gcd", "lcm", "Pr", "deg", "hom", "mod"])
const QUIET = new Set(["displaystyle", "textstyle", "scriptstyle", "limits", "nolimits", "big", "Big", "bigg", "Bigg", "bigl", "bigr", "Bigl", "Bigr", "biggl", "biggr", "Biggl", "Biggr", "nonumber", "notag", "hline", "centering"])
const MATH_PASSTHROUGH = new Set(["mathbf", "mathit", "boldsymbol", "bm", "mathsf", "mathtt", "mathop", "mathrel", "mathbin", "mathord", "underbrace", "overbrace", "boxed", "displaystyle"])
const TEXT_PASSTHROUGH = new Set(["text", "textbf", "textrm", "textit", "textsf", "texttt", "mathrm", "operatorname", "mbox", "hbox", "fbox"])
const ACCENTS: Record<string, string> = { hat: "̂", widehat: "̂", check: "̌", tilde: "̃", widetilde: "̃", bar: "̄", overline: "̅", dot: "̇", ddot: "̈", vec: "⃗", acute: "́", grave: "̀", breve: "̆", underline: "̲", mathring: "̊", cancel: "̶" }
const BLACKBOARD: Record<string, string> = { R: "ℝ", N: "ℕ", Z: "ℤ", Q: "ℚ", C: "ℂ", P: "ℙ", H: "ℍ", E: "𝔼", "1": "𝟙" }
const SCRIPT_EXCEPTIONS: Record<string, string> = { B: "ℬ", E: "ℰ", F: "ℱ", H: "ℋ", I: "ℐ", L: "ℒ", M: "ℳ", R: "ℛ" }
const VULGAR: Record<string, string> = { "1/2": "½", "1/3": "⅓", "2/3": "⅔", "1/4": "¼", "3/4": "¾", "1/5": "⅕", "1/6": "⅙", "1/8": "⅛" }

/** True when one bracket pair spans the whole text, so it needs no extra parentheses. */
function enclosed(text: string) {
  if (!/^[(\[].*[)\]]$/.test(text)) return false
  let depth = 0
  for (let at = 0; at < text.length; at++) {
    if ("([".includes(text[at]!)) depth++
    else if (")]".includes(text[at]!) && --depth === 0 && at < text.length - 1) return false
  }
  return depth === 0
}

const has = (table: object, name: string) => Object.hasOwn(table, name)
const pairs = (keys: string, values: string) => Object.fromEntries([...keys].map((key, i) => [key, [...values][i]!]))
const SUPERSCRIPT: Record<string, string> = {
  ...pairs("0123456789+=()", "⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁼⁽⁾"),
  ...pairs("abcdefghijklmnoprstuvwxyz", "ᵃᵇᶜᵈᵉᶠᵍʰⁱʲᵏˡᵐⁿᵒᵖʳˢᵗᵘᵛʷˣʸᶻ"),
  ...pairs("ABDEGHIJKLMNOPRTUVW", "ᴬᴮᴰᴱᴳᴴᴵᴶᴷᴸᴹᴺᴼᴾᴿᵀᵁⱽᵂ"),
  ...pairs("βγδθφχ", "ᵝᵞᵟᶿᵠᵡ"),
  "-": "⁻", "−": "⁻", "′": "′", "∘": "°", "*": "*",
}
const SUBSCRIPT: Record<string, string> = {
  ...pairs("0123456789+=()", "₀₁₂₃₄₅₆₇₈₉₊₌₍₎"),
  ...pairs("aehijklmnoprstuvx", "ₐₑₕᵢⱼₖₗₘₙₒₚᵣₛₜᵤᵥₓ"),
  ...pairs("βγρφχ", "ᵦᵧᵨᵩᵪ"),
  "-": "₋", "−": "₋",
}

function mapped(text: string, table: Record<string, string>): string | undefined {
  const compact = text.replace(/\s+/g, "")
  if (!compact) return ""
  const known = new Set(Object.values(table))
  let out = ""
  for (const char of compact) {
    const next = table[char] ?? (known.has(char) ? char : undefined)
    if (next === undefined) return undefined
    out += next
  }
  return out
}

/** `x²`-style superscript when every character has one, else `^(…)`. */
export function superscript(text: string) {
  return mapped(text, SUPERSCRIPT) ?? (text.length === 1 ? `^${text}` : `^(${text})`)
}

/** `xᵢ`-style subscript when every character has one, else `_(…)`. */
export function subscript(text: string) {
  return mapped(text, SUBSCRIPT) ?? (text.length === 1 ? `_${text}` : `_(${text})`)
}

// ---------------------------------------------------------------------------------------------
// Blocks: rows of text with a baseline row

const one = (text: string): Block => ({ rows: [text], base: 0 })
const widthOf = (block: Block) => Math.max(0, ...block.rows.map(textWidth))
const padTo = (text: string, width: number) => text + " ".repeat(Math.max(0, width - textWidth(text)))
const centered = (text: string, width: number) => {
  const gap = Math.max(0, width - textWidth(text))
  const left = Math.floor(gap / 2)
  return " ".repeat(left) + text + " ".repeat(gap - left)
}

function hcat(blocks: Block[]): Block {
  if (blocks.length === 1) return blocks[0]!
  if (blocks.every((block) => block.rows.length === 1)) return one(blocks.map((block) => block.rows[0]!).join(""))
  const above = Math.max(0, ...blocks.map((block) => block.base))
  const below = Math.max(0, ...blocks.map((block) => block.rows.length - block.base - 1))
  const rows = Array.from({ length: above + below + 1 }, () => "")
  for (const block of blocks) {
    const width = widthOf(block)
    for (let row = 0; row < rows.length; row++) rows[row] += padTo(block.rows[row - (above - block.base)] ?? "", width)
  }
  return { rows, base: above }
}

function vcat(blocks: Block[], align: (text: string, width: number) => string = padTo): Block {
  const width = Math.max(0, ...blocks.map(widthOf))
  const rows = blocks.flatMap((block) => block.rows.map((row) => align(row, width)))
  return { rows, base: Math.floor((rows.length - 1) / 2) }
}

const PIECES: Record<string, { left: string[]; right: string[] }> = {
  "(": { left: ["⎛", "⎜", "⎝"], right: ["⎞", "⎟", "⎠"] },
  "[": { left: ["⎡", "⎢", "⎣"], right: ["⎤", "⎥", "⎦"] },
  "{": { left: ["⎧", "⎪", "⎩", "⎨"], right: ["⎫", "⎪", "⎭", "⎬"] },
  "|": { left: ["│", "│", "│"], right: ["│", "│", "│"] },
  "‖": { left: ["║", "║", "║"], right: ["║", "║", "║"] },
}
const CLOSE_OF: Record<string, string> = { "(": ")", "[": "]", "{": "}", "|": "|", "‖": "‖" }

function tall(open: string, height: number, side: "left" | "right"): Block {
  const pieces = PIECES[open]?.[side]
  if (height < 2 || !pieces) return one(side === "left" ? open : CLOSE_OF[open] ?? open)
  const middle = pieces[3]
  const at = Math.floor(height / 2) - (height % 2 === 0 ? 1 : 0)
  const rows = Array.from({ length: height }, (_, row) => (row === 0 ? pieces[0]! : row === height - 1 ? pieces[2]! : middle && height >= 3 && row === at ? middle : pieces[1]!))
  return { rows, base: Math.floor((height - 1) / 2) }
}

function bracketed(inner: Block, open: string, closing: boolean): Block {
  const height = inner.rows.length
  return hcat([tall(open, height, "left"), inner, ...(closing ? [tall(open, height, "right")] : [])])
}

/** Splits on a top-level `\\` (row break) or `&` (column break), ignoring braces, escapes and nested environments. */
function splitTop(source: string, separator: "\\\\" | "&"): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let at = 0; at < source.length; at++) {
    const char = source[at]!
    if (char === "\\") {
      const name = /^[A-Za-z]+/.exec(source.slice(at + 1))?.[0]
      if (name === "begin") depth++
      else if (name === "end") depth--
      else if (!name && source[at + 1] === "\\" && separator === "\\\\" && depth === 0) {
        parts.push(source.slice(start, at))
        start = at + 2
      }
      at += name ? name.length : 1
    } else if (char === "{") depth++
    else if (char === "}") depth--
    else if (char === "&" && separator === "&" && depth === 0) {
      parts.push(source.slice(start, at))
      start = at + 1
    }
  }
  parts.push(source.slice(start))
  return parts
}

const ALIGNED = new Set(["align", "align*", "aligned", "alignat", "alignedat", "gather", "gather*", "gathered", "split", "eqnarray", "multline", "flalign"])
const MATRICES: Record<string, string> = { matrix: "", smallmatrix: "", array: "", pmatrix: "(", bmatrix: "[", Bmatrix: "{", vmatrix: "|", Vmatrix: "‖" }

class Parser {
  pos = 0

  constructor(
    readonly src: string,
    readonly stacked: boolean,
    readonly depth = 0,
  ) {}

  /** Flat (one-line) text of another source fragment. */
  private flat(source: string): string {
    return new Parser(source, false, this.depth + 1).parse().rows.join(" ").replace(/ {2,}/g, " ").trim()
  }

  private skipSpaces() {
    while (this.pos < this.src.length && /\s/.test(this.src[this.pos]!)) this.pos++
  }

  /** The raw source of the next argument: a balanced `{…}` group, one command or one character. */
  private group(): string {
    this.skipSpaces()
    const char = this.src[this.pos]
    if (char === undefined) return ""
    if (char === "{") {
      let depth = 0
      const start = this.pos + 1
      for (let at = this.pos; at < this.src.length; at++) {
        const current = this.src[at]!
        if (current === "\\") at++
        else if (current === "{") depth++
        else if (current === "}" && --depth === 0) {
          this.pos = at + 1
          return this.src.slice(start, at)
        }
      }
      this.pos = this.src.length
      return this.src.slice(start)
    }
    if (char === "\\") {
      const token = /^\\(?:[A-Za-z]+|.)/s.exec(this.src.slice(this.pos))![0]
      this.pos += token.length
      return token
    }
    this.pos++
    return char
  }

  private optional(): string | undefined {
    this.skipSpaces()
    if (this.src[this.pos] !== "[") return undefined
    const end = this.src.indexOf("]", this.pos)
    if (end < 0) return undefined
    const text = this.src.slice(this.pos + 1, end)
    this.pos = end + 1
    return text
  }

  private scripts(): { sup?: string; sub?: string } {
    const found: { sup?: string; sub?: string } = {}
    for (;;) {
      this.skipSpaces()
      const char = this.src[this.pos]
      if (char !== "^" && char !== "_") return found
      this.pos++
      found[char === "^" ? "sup" : "sub"] = this.group()
    }
  }

  private scriptText(found: { sup?: string; sub?: string }) {
    return (found.sub !== undefined ? subscript(this.flat(found.sub)) : "") + (found.sup !== undefined ? superscript(this.flat(found.sup)) : "")
  }

  private fraction(numerator: string, denominator: string): Block {
    if (this.stacked) {
      const top = new Parser(numerator, true, this.depth + 1).parse()
      const bottom = new Parser(denominator, true, this.depth + 1).parse()
      const width = Math.max(widthOf(top), widthOf(bottom)) + 2
      return { rows: [...top.rows.map((row) => centered(row, width)), "─".repeat(width), ...bottom.rows.map((row) => centered(row, width))], base: top.rows.length }
    }
    const n = this.flat(numerator)
    const d = this.flat(denominator)
    if (!n && !d) return one("")
    const simple = (text: string) => /^[\p{L}\p{N}.′̀-ͯ⃗]+$/u.test(text) || enclosed(text)
    return one(VULGAR[`${n}/${d}`] ?? `${simple(n) ? n : `(${n})`}/${simple(d) ? d : `(${d})`}`)
  }

  private root(index: string | undefined, body: string): Block {
    const text = this.flat(body)
    const radical = index === undefined ? "√" : index === "3" ? "∛" : index === "4" ? "∜" : `${superscript(this.flat(index)).replace(/^\^/, "")}√`
    return one(/^[\p{L}\p{N}.]+$/u.test(text) ? `${radical}${text}` : `${radical}(${text})`)
  }

  private limits(symbol: string, found: { sup?: string; sub?: string }): Block {
    if (!this.stacked || (found.sup === undefined && found.sub === undefined)) return one(symbol + this.scriptText(found))
    const up = found.sup !== undefined ? new Parser(found.sup, true, this.depth + 1).parse() : undefined
    const down = found.sub !== undefined ? new Parser(found.sub, true, this.depth + 1).parse() : undefined
    const width = Math.max(textWidth(symbol), up ? widthOf(up) : 0, down ? widthOf(down) : 0)
    const rows = [...(up ? up.rows : []), symbol, ...(down ? down.rows : [])].map((row) => centered(row, width))
    return { rows, base: up ? up.rows.length : 0 }
  }

  private environment(): Block {
    const name = this.group().trim()
    if (name === "array" || name === "alignedat" || name === "alignat") {
      this.skipSpaces()
      if (this.src[this.pos] === "{") this.group()
    }
    const opener = /\\(begin|end)\{([^}]*)\}/g
    opener.lastIndex = this.pos
    let level = 1
    let end = this.src.length
    let resume = this.src.length
    for (let match = opener.exec(this.src); match; match = opener.exec(this.src)) {
      if (match[2] !== name) continue
      level += match[1] === "begin" ? 1 : -1
      if (level === 0) {
        end = match.index
        resume = match.index + match[0].length
        break
      }
    }
    const body = this.src.slice(this.pos, end)
    this.pos = resume
    const rows = splitTop(body, "\\\\").map((row) => row.trim()).filter(Boolean)
    const cells = rows.map((row) => splitTop(row, "&").map((cell) => this.flat(cell)))
    if (name === "cases" || name === "dcases" || name === "rcases") {
      const lines = cells.map((row) => row.join("  "))
      const inner = vcat(lines.map(one))
      return this.stacked && lines.length > 1 ? bracketed(inner, "{", false) : one(`{ ${lines.join("; ")} }`)
    }
    if (has(MATRICES, name)) {
      const open = MATRICES[name]!
      const columns = Math.max(0, ...cells.map((row) => row.length))
      const widths = Array.from({ length: columns }, (_, column) => Math.max(...cells.map((row) => textWidth(row[column] ?? ""))))
      if (!this.stacked || cells.length < 2) {
        const text = cells.map((row) => row.join(" ")).join("; ")
        return one(open ? `${open}${text}${CLOSE_OF[open]}` : text)
      }
      const lines = cells.map((row) => widths.map((width, column) => centered(row[column] ?? "", width)).join("  "))
      const inner = vcat(lines.map(one))
      return open ? bracketed(inner, open, true) : inner
    }
    if (ALIGNED.has(name) || name.startsWith("align")) {
      const widths = Math.max(0, ...cells.map((row) => textWidth(row[0] ?? "")))
      const lines = cells.map((row) => (row.length > 1 ? `${" ".repeat(widths - textWidth(row[0]!))}${row[0]} ${row.slice(1).join(" ")}` : row[0] ?? ""))
      return this.stacked && lines.length > 1 ? vcat(lines.map(one)) : one(lines.join("; "))
    }
    return one(cells.map((row) => row.join(" ")).join(this.stacked ? " " : "; "))
  }

  private styled(name: string, argument: string): Block {
    if (name === "mathbb") return one([...argument].map((char) => BLACKBOARD[char] ?? char).join(""))
    if (name === "mathcal" || name === "mathscr") {
      return one([...argument].map((char) => SCRIPT_EXCEPTIONS[char] ?? (/[A-Z]/.test(char) ? String.fromCodePoint(0x1d49c + char.charCodeAt(0) - 65) : char)).join(""))
    }
    return one(argument)
  }

  parse(): Block {
    if (this.depth > MAX_DEPTH) return one(this.src)
    const parts: Block[] = []
    let kind: Kind = "start"
    const push = (text: string, next: Kind) => {
      parts.push(one(text))
      kind = next
    }
    const spaced = (text: string) => {
      push(`${kind === "atom" ? " " : ""}${text} `, "op")
    }
    const gap = (text: string) => {
      if (kind === "atom") push(text, "op")
    }
    while (this.pos < this.src.length) {
      const char = this.src[this.pos]!
      if (/\s/.test(char) || char === "}") {
        this.pos++
        continue
      }
      if (char === "{") {
        parts.push(new Parser(this.group(), this.stacked, this.depth + 1).parse())
        kind = "atom"
      } else if (char === "\\") {
        this.pos++
        const name = /^[A-Za-z]+/.exec(this.src.slice(this.pos))?.[0] ?? this.src[this.pos] ?? ""
        this.pos += name.length || 1
        if (name === "frac" || name === "dfrac" || name === "tfrac" || name === "cfrac") {
          const numerator = this.group()
          parts.push(this.fraction(numerator, this.group()))
          kind = "atom"
        } else if (name === "binom" || name === "choose") {
          const top = this.flat(this.group())
          const bottom = this.flat(this.group())
          parts.push(this.stacked ? bracketed(vcat([one(top), one(bottom)], centered), "(", true) : one(`C(${top}, ${bottom})`))
          kind = "atom"
        } else if (name === "sqrt") {
          const index = this.optional()
          parts.push(this.root(index, this.group()))
          kind = "atom"
        } else if (name === "begin") {
          parts.push(this.environment())
          kind = "atom"
        } else if (name === "left" || name === "right") {
          this.skipSpaces()
          if (this.src[this.pos] === ".") this.pos++
        } else if (has(GREEK, name)) push(GREEK[name]!, "atom")
        else if (has(RELATIONS, name)) spaced(RELATIONS[name]!)
        else if (has(BINARY, name)) spaced(BINARY[name]!)
        else if (has(BIG, name)) {
          const symbol = BIG[name]!
          if (kind === "atom") push(" ", "op")
          parts.push(STACKED_LIMITS.has(name) ? this.limits(symbol, this.scripts()) : one(symbol + this.scriptText(this.scripts())))
          push(" ", "op")
        } else if (FUNCTIONS.has(name)) {
          const found = this.scripts()
          const block = STACKED_LIMITS.has(name) && this.stacked ? this.limits(name, found) : one(name + this.scriptText(found))
          if (kind === "atom") push(" ", "op")
          parts.push(block)
          this.skipSpaces()
          push(this.src[this.pos] === "(" ? "" : " ", "op")
        } else if (has(ORDINARY, name)) push(ORDINARY[name]!, "atom")
        else if (has(OPENERS, name)) push(OPENERS[name]!, "open")
        else if (has(CLOSERS, name)) push(CLOSERS[name]!, "atom")
        else if (name === "quad" || name === "qquad") push(name === "quad" ? "  " : "    ", "op")
        else if (name === "," || name === ";" || name === ":" || name === " " || name === "enspace" || name === "thinspace") gap(" ")
        else if (name === "!" || name === "\\" || QUIET.has(name)) {
          if (name === "\\") gap(this.stacked ? " " : "; ")
        } else if (has(ACCENTS, name)) {
          const mark = ACCENTS[name]!
          push([...this.flat(this.group())].map((letter) => (/\s/.test(letter) ? letter : letter + mark)).join(""), "atom")
        } else if (TEXT_PASSTHROUGH.has(name)) push(this.group().replace(/\\([{}%$&#_])/g, "$1").replace(/\\[ ,;]/g, " "), "atom")
        else if (name === "mathbb" || name === "mathcal" || name === "mathscr") {
          parts.push(this.styled(name, this.flat(this.group())))
          kind = "atom"
        } else if (MATH_PASSTHROUGH.has(name)) {
          parts.push(new Parser(this.group(), this.stacked, this.depth + 1).parse())
          kind = "atom"
        } else if (name === "mathfrak") push(this.flat(this.group()), "atom")
        else push(name, "atom")
      } else if (char === "^" || char === "_") {
        const found = this.scripts()
        push(this.scriptText(found), "atom")
        continue
      } else if (char === "+" || char === "-") {
        this.pos++
        if (kind === "atom") spaced(char === "-" ? "−" : "+")
        else push(char === "-" ? "−" : "+", "start")
      } else if (char === "=" || char === "<" || char === ">") {
        this.pos++
        spaced(char)
      } else if (char === "*") {
        this.pos++
        spaced("∗")
      } else if (char === "," || char === ";") {
        this.pos++
        push(`${char} `, "op")
      } else if (char === "(" || char === "[") {
        this.pos++
        push(char, "open")
      } else if (char === "'") {
        const run = /^'+/.exec(this.src.slice(this.pos))![0]
        this.pos += run.length
        push(["′", "″", "‴"][Math.min(run.length, 3) - 1]!, "atom")
      } else if (char === "&" || char === "~") {
        this.pos++
        gap(" ")
      } else {
        this.pos++
        push(char, "atom")
      }
    }
    return hcat(parts.length ? parts : [one("")])
  }
}

/** One-line Unicode text for a LaTeX math fragment. */
export function mathInline(source: string): string {
  const text = source.trim()
  if (!text || text.length > MAX_SOURCE) return text
  try {
    return new Parser(text, false).parse().rows.join(" ").replace(/ {2,}/g, " ").trim()
  } catch {
    return text
  }
}

/** Display math as lines no wider than `width`; falls back to one flat line per row when the stacked layout is too wide. */
export function mathDisplay(source: string, width: number): string[] {
  const text = source.trim()
  if (!text) return []
  if (text.length > MAX_SOURCE) return [text]
  try {
    const rows = splitTop(text, "\\\\").map((row) => row.trim()).filter(Boolean)
    const blocks = rows.map((row) => new Parser(row, true).parse())
    const block = blocks.length === 1 ? blocks[0]! : vcat(blocks, (row) => row)
    const lines = block.rows.map((row) => row.trimEnd())
    if (lines.every((line) => textWidth(line) <= width)) return lines
    return rows.map(mathInline)
  } catch {
    return [text]
  }
}
