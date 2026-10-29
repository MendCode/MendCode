/** Parser for Code Mode's confined JavaScript/TypeScript subset. Source is data; it is never evaluated by the host. TypeScript types are skipped, never executed. */
export type CodeNode = { kind: string; value?: string | number | boolean | null; children: CodeNode[] }
type Token = { text: string; value?: string | number; kind: "word" | "string" | "number" | "punct" | "template" | "regex"; at: number; nl: boolean; strings?: string[]; sources?: Array<{ code: string; at: number }>; flags?: string }
const node = (kind: string, children: CodeNode[] = [], value?: CodeNode["value"]): CodeNode => ({ kind, children, ...(value === undefined ? {} : { value }) })

export class CodeError extends Error {
  constructor(readonly kind: string, message: string) { super(message) }
}

const MAX_TEMPLATE_DEPTH = 8
const REGEX_AFTER = new Set(["return", "typeof", "await", "yield", "of", "in", "case", "throw", "delete", "void", "instanceof", "else", "do", "new"])
const ESCAPES: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", "0": "\0" }

/** Decodes one escape sequence starting after the backslash; returns the text and the next offset. */
function escape(code: string, at: number): [string, number] {
  const char = code[at]
  if (char === undefined) throw new CodeError("ParseError", "Unclosed string")
  if (char === "u" || char === "x") {
    if (char === "u" && code[at + 1] === "{") {
      const end = code.indexOf("}", at + 2), digits = code.slice(at + 2, end)
      if (end < 0 || !/^[0-9a-fA-F]{1,6}$/.test(digits) || parseInt(digits, 16) > 0x10ffff) throw new CodeError("ParseError", "Invalid string escape")
      return [String.fromCodePoint(parseInt(digits, 16)), end + 1]
    }
    const count = char === "u" ? 4 : 2, digits = code.slice(at + 1, at + 1 + count)
    if (!new RegExp(`^[0-9a-fA-F]{${count}}$`).test(digits)) throw new CodeError("ParseError", "Invalid string escape")
    return [String.fromCharCode(parseInt(digits, 16)), at + 1 + count]
  }
  if (char === "\r" && code[at + 1] === "\n") return ["", at + 2]
  return [ESCAPES[char] ?? (char === "\n" || char === "\r" ? "" : char), at + 1]
}

/** Finds the `}` closing a template substitution that starts at `at`, skipping nested strings, templates and braces. */
function substitutionEnd(code: string, at: number, depth: number): number {
  let braces = 0
  while (at < code.length) {
    const char = code[at]!
    if (char === "'" || char === '"') {
      at++
      while (at < code.length && code[at] !== char) at += code[at] === "\\" ? 2 : 1
      at++
    } else if (char === "`") at = templateEnd(code, at + 1, depth + 1)
    else if (code.startsWith("//", at)) { while (at < code.length && code[at] !== "\n") at++ }
    else if (code.startsWith("/*", at)) { const end = code.indexOf("*/", at + 2); if (end < 0) throw new CodeError("ParseError", "Unclosed comment"); at = end + 2 }
    else if (char === "{") { braces++; at++ }
    else if (char === "}") { if (!braces) return at; braces--; at++ }
    else at++
  }
  throw new CodeError("ParseError", "Unclosed template substitution")
}
function templateEnd(code: string, at: number, depth: number): number {
  if (depth > MAX_TEMPLATE_DEPTH) throw new CodeError("ParseError", `Template nesting exceeds ${MAX_TEMPLATE_DEPTH} levels`)
  while (at < code.length) {
    const char = code[at]!
    if (char === "`") return at + 1
    if (char === "\\") { at += 2; continue }
    if (char === "$" && code[at + 1] === "{") { at = substitutionEnd(code, at + 2, depth) + 1; continue }
    at++
  }
  throw new CodeError("ParseError", "Unclosed string")
}

function tokenize(code: string, base = 0): Token[] {
  const tokens: Token[] = []
  let at = 0, nl = false
  while (at < code.length) {
    const start = at, char = code[at]!
    if (/\s/.test(char)) { if (char === "\n" || char === "\r") nl = true; at++; continue }
    if (code.startsWith("//", at)) { while (at < code.length && code[at] !== "\n") at++; continue }
    if (code.startsWith("/*", at)) {
      const end = code.indexOf("*/", at + 2)
      if (end < 0) throw new CodeError("ParseError", "Unclosed comment")
      if (code.slice(at, end).includes("\n")) nl = true
      at = end + 2
      continue
    }
    const push = (token: Omit<Token, "nl" | "at">) => { tokens.push({ ...token, at: base + start, nl }); nl = false }
    if (char === '"' || char === "'") {
      let value = "", closed = false
      at++
      while (at < code.length) {
        const next = code[at++]!
        if (next === char) { closed = true; break }
        if (next === "\n") break
        if (next !== "\\") { value += next; continue }
        const [text, end] = escape(code, at)
        value += text; at = end
      }
      if (!closed) throw new CodeError("ParseError", "Unclosed string")
      push({ text: code.slice(start, at), value, kind: "string" })
      continue
    }
    if (char === "`") {
      const strings: string[] = [], sources: Array<{ code: string; at: number }> = []
      let value = ""
      at++
      while (true) {
        if (at >= code.length) throw new CodeError("ParseError", "Unclosed string")
        const next = code[at++]!
        if (next === "`") break
        if (next === "$" && code[at] === "{") {
          const end = substitutionEnd(code, at + 1, 1)
          strings.push(value); value = ""
          sources.push({ code: code.slice(at + 1, end), at: base + at + 1 })
          at = end + 1
          continue
        }
        if (next !== "\\") { value += next; continue }
        const [text, end] = escape(code, at)
        value += text; at = end
      }
      strings.push(value)
      push({ text: code.slice(start, at), kind: "template", strings, sources })
      continue
    }
    const word = /^#?[A-Za-z_$][\w$]*/.exec(code.slice(at))?.[0]
    if (word) { at += word.length; push({ text: word, kind: "word" }); continue }
    const number = /^(?:0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:\d[\d_]*(?:\.\d[\d_]*|\.(?![\w$.]))?|\.\d[\d_]*)(?:[eE][+-]?\d+)?)/.exec(code.slice(at))?.[0]
    if (number) {
      at += number.length
      if (/[\w$]/.test(code[at] ?? "")) throw new CodeError("UnsupportedSyntax", `Unsupported numeric suffix at ${base + at}`)
      push({ text: number, value: Number(number.replaceAll("_", "")), kind: "number" })
      continue
    }
    const previous = tokens.at(-1)
    if (char === "/" && (!previous || previous.kind === "punct" && ![")", "]", "}", "++", "--"].includes(previous.text) || previous.kind === "word" && REGEX_AFTER.has(previous.text))) {
      let inClass = false, end = at + 1
      while (end < code.length) {
        const next = code[end]!
        if (next === "\n") break
        if (next === "\\") { end += 2; continue }
        if (next === "[") inClass = true
        else if (next === "]") inClass = false
        else if (next === "/" && !inClass) break
        end++
      }
      if (code[end] !== "/") throw new CodeError("ParseError", "Unclosed regular expression")
      const flags = /^[a-z]*/.exec(code.slice(end + 1))![0]
      push({ text: code.slice(start, end + 1 + flags.length), value: code.slice(at + 1, end), kind: "regex", flags })
      at = end + 1 + flags.length
      continue
    }
    const operator = ["**=", "...", "===", "!==", "??=", "||=", "&&=", "<<=", "=>", "==", "!=", "<=", ">=", "&&", "||", "??", "?.", "++", "--", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "**", "<<"].find((text) => code.startsWith(text, at))
    if (operator === "?." && /\d/.test(code[at + 2] ?? "")) { at++; push({ text: "?", kind: "punct" }); continue }
    if (operator) { at += operator.length; push({ text: operator, kind: "punct" }); continue }
    if ("{}[]().,;:?+-*/%<>=!&|^~".includes(char)) { at++; push({ text: char, kind: "punct" }); continue }
    throw new CodeError("UnsupportedSyntax", `Unsupported token at ${base + at}: ${char}`)
  }
  tokens.push({ text: "<end>", kind: "punct", at: base + code.length, nl: true })
  return tokens
}

const PRECEDENCE: Record<string, number> = {
  "=": 1, "+=": 1, "-=": 1, "*=": 1, "/=": 1, "%=": 1, "**=": 1, "??=": 1, "||=": 1, "&&=": 1, "&=": 1, "|=": 1, "^=": 1, "<<=": 1,
  "??": 3, "||": 3, "&&": 4, "|": 5, "^": 6, "&": 7, "==": 8, "!=": 8, "===": 8, "!==": 8,
  "<": 9, ">": 9, "<=": 9, ">=": 9, instanceof: 9, in: 9, "<<": 10, ">>": 10, ">>>": 10, "+": 11, "-": 11, "*": 12, "/": 12, "%": 12, "**": 13,
}
const DECLARATIONS = ["const", "let", "var"]
const UNSUPPORTED = ["import", "export", "with"]
const CLASS_MODIFIERS = new Set(["public", "private", "protected", "readonly", "abstract", "declare", "override", "static", "async", "get", "set"])
const PARAMETER_MODIFIERS = new Set(["public", "private", "protected", "readonly", "override"])
const TYPE_PREFIXES = new Set(["keyof", "typeof", "readonly", "unique", "infer", "asserts", "new", "abstract"])

type Shared = { depth: number }

function parseTokens(tokens: Token[], shared: Shared, whole: boolean): CodeNode {
  let at = 0
  const failedArrows = new Set<number>(), failedArguments = new Set<number>()
  let noIn = false
  const peek = () => tokens[Math.min(at, tokens.length - 1)]!
  const ahead = (offset: number) => tokens[Math.min(at + offset, tokens.length - 1)]!
  const take = () => { const token = peek(); at++; return token }
  const match = (text: string) => peek().text === text && peek().kind !== "string" ? (at++, true) : false
  const error = (message: string): never => { throw new CodeError("ParseError", `${message} at ${peek().at}`) }
  const expect = (text: string) => { if (!match(text)) error(`Expected ${text}`) }
  const name = (privateName = false) => { const token = take(); if (token.kind !== "word" || token.text.startsWith("#") && !privateName) { at--; error("Expected identifier") } return token.text }
  const labels: string[] = []
  /** Labels never cross a function boundary. */
  const fresh = <T>(read: () => T): T => {
    const saved = labels.splice(0)
    try { return read() } finally { labels.splice(0, labels.length, ...saved) }
  }
  const memberNode = (object: CodeNode, property: string) => node(property.startsWith("#") ? "privateMember" : "member", [object, node("literal", [], property)])
  const bounded = <T>(read: () => T): T => {
    if (++shared.depth > 128) throw new CodeError("ParseError", "Syntax nesting exceeds 128 levels")
    try { return read() } finally { shared.depth-- }
  }
  const list = <T>(end: string, read: () => T) => {
    const children: T[] = []
    if (!match(end)) do { children.push(read()); if (match(end)) break; expect(","); if (match(end)) break } while (true)
    return children
  }
  const isWord = (token: Token, text?: string) => token.kind === "word" && (text === undefined || token.text === text)

  // TypeScript: types are parsed structurally and discarded.
  function skipAnyBalanced() {
    const open = peek().text, close = open === "(" ? ")" : open === "[" ? "]" : "}"
    const stack = [close]
    take()
    while (stack.length) {
      const token = take()
      if (token.text === "<end>") { at--; error("Unclosed type") }
      if (token.kind !== "punct") continue
      if (token.text === "(") stack.push(")")
      else if (token.text === "[") stack.push("]")
      else if (token.text === "{") stack.push("}")
      else if (token.text === stack.at(-1)) stack.pop()
    }
  }
  function skipTypeArguments() {
    expect("<")
    do skipType(); while (match(","))
    expect(">")
  }
  function skipTypeParameters() {
    expect("<")
    do {
      while (["const", "in", "out"].includes(peek().text) && isWord(ahead(1))) take()
      name()
      if (match("extends")) skipType()
      if (match("=")) skipType()
    } while (match(",") && peek().text !== ">")
    expect(">")
  }
  function typeAtom() {
    while (isWord(peek()) && TYPE_PREFIXES.has(peek().text) && (isWord(ahead(1)) || ["(", "{", "[", "<"].includes(ahead(1).text) || ahead(1).kind === "string")) take()
    const token = peek()
    if (token.text === "<" && token.kind === "punct") { skipTypeParameters(); typeAtom(); return }
    if (token.text === "(" && token.kind === "punct") {
      skipAnyBalanced()
      if (match("=>")) { skipType(); return }
    } else if (["{", "["].includes(token.text) && token.kind === "punct") skipAnyBalanced()
    else if (token.kind === "string" || token.kind === "number" || token.kind === "template") take()
    else if (token.text === "-" && ahead(1).kind === "number") { take(); take() }
    else if (token.kind === "word") {
      take()
      while (peek().text === "." && isWord(ahead(1))) { take(); take() }
      if (peek().text === "<" && !peek().nl) skipTypeArguments()
      if (isWord(peek(), "is") && !peek().nl) { take(); skipType(); return }
    } else error("Expected type")
    while (peek().text === "[" && peek().kind === "punct" && !peek().nl) skipAnyBalanced()
  }
  function skipType() {
    bounded(() => {
      if (!match("|")) match("&")
      while (true) {
        typeAtom()
        if (isWord(peek(), "extends") && !peek().nl) { take(); skipType(); expect("?"); skipType(); expect(":"); skipType(); return }
        if (peek().text === "|" || peek().text === "&") { take(); continue }
        return
      }
    })
  }

  // Bindings and patterns.
  function pattern(): CodeNode {
    if (match("[")) return node("arrayBinding", list("]", () => peek().text === "," ? node("hole") : element()))
    if (match("{")) return node("objectBinding", list("}", () => {
      if (match("...")) return node("rest", [pattern()])
      const key = take()
      if (!["word", "number", "string"].includes(key.kind)) error("Expected binding key")
      const keyName = String(key.value ?? key.text)
      const target = match(":") ? pattern() : key.kind === "word" ? node("id", [], key.text) : error("Expected binding name")
      return node("entry", [match("=") ? node("default", [target, expression()]) : target], keyName)
    }))
    return node("id", [], name())
  }
  function element(): CodeNode {
    if (match("...")) return node("rest", [pattern()])
    const target = pattern()
    return match("=") ? node("default", [target, expression()]) : target
  }
  function parameter(): CodeNode {
    if (match("...")) { const rest = node("rest", [pattern()]); if (match(":")) skipType(); return rest }
    if (isWord(peek(), "this") && ahead(1).text === ":") { take(); take(); skipType(); return node("hole") }
    const target = pattern()
    match("?")
    if (match(":")) skipType()
    return match("=") ? node("default", [target, expression()]) : target
  }
  const parameters = () => node("params", list(")", parameter).filter((entry) => entry.kind !== "hole"))
  function declaration(forInit = false): CodeNode {
    const kind = take().text, entries: CodeNode[] = []
    do {
      const target = pattern()
      match("!")
      if (match(":")) skipType()
      const outer = noIn
      noIn = forInit
      try { entries.push(node("declare", [target, match("=") ? expression() : node("literal")], kind)) } finally { noIn = outer }
    } while (match(","))
    return node("declarations", entries)
  }

  function block(): CodeNode {
    expect("{")
    const children: CodeNode[] = []
    while (!match("}")) { if (peek().text === "<end>") error("Unclosed block"); children.push(statement()) }
    return node("block", children)
  }
  /** After `function` (or `async function`): optional `*`, name, type parameters, parameters, return type and body. */
  function functionNode(async: boolean, declared: boolean): CodeNode {
    const generator = match("*")
    const title = peek().text === "(" || peek().text === "<" ? "" : name()
    if (declared && !title) error("Function declarations need a name")
    if (peek().text === "<") skipTypeParameters()
    expect("(")
    const params = parameters()
    if (match(":")) skipType()
    if (declared && peek().text !== "{") { match(";"); return node("empty") }
    const fn = node(async ? generator ? "asyncGenerator" : "asyncFunction" : generator ? "generator" : "function", [params, fresh(block)])
    return declared ? node("declare", [node("id", [], title), fn], "function") : fn
  }
  function arrowBody(async: boolean, params: CodeNode): CodeNode {
    return node(async ? "asyncFunction" : "function", [params, peek().text === "{" ? fresh(block) : node("return", [expression()])], "arrow")
  }
  const methodKind = (async: boolean, generator: boolean) => async ? generator ? "asyncGenerator" : "asyncFunction" : generator ? "generator" : "function"
  /** Constructor parameters may carry TypeScript modifiers (`private x`), which also declare a property; those names are collected. */
  function constructorParameters(properties: string[]): CodeNode {
    return node("params", list(")", () => {
      let property = false
      while (isWord(peek()) && PARAMETER_MODIFIERS.has(peek().text) && (isWord(ahead(1)) || ["{", "["].includes(ahead(1).text))) { take(); property = true }
      const entry = parameter()
      if (property) {
        const target = entry.kind === "default" ? entry.children[0]! : entry
        if (target.kind !== "id") error("Parameter properties must be plain names")
        properties.push(String(target.value))
      }
      return entry
    }).filter((entry) => entry.kind !== "hole"))
  }
  function methodNode(async: boolean, generator: boolean, properties?: string[]): CodeNode {
    if (peek().text === "<") skipTypeParameters()
    expect("(")
    const params = properties ? constructorParameters(properties) : parameters()
    if (match(":")) skipType()
    return node(methodKind(async, generator), [params, fresh(block)])
  }
  /** `class` already consumed. Members become `cm` nodes: [key expression, value, flags] with kind method/get/set/field/ctor/block. */
  function classNode(declared: boolean): CodeNode {
    const title = isWord(peek()) && !["extends", "implements"].includes(peek().text) ? name() : ""
    if (declared && !title) error("Class declarations need a name")
    if (peek().text === "<") skipTypeParameters()
    let heritage = node("empty")
    if (match("extends")) {
      heritage = expression(14)
      if (peek().text === "<" && peek().kind === "punct") skipTypeArguments()
    }
    if (match("implements")) { do skipType(); while (match(",")) }
    expect("{")
    const members: CodeNode[] = []
    while (!match("}")) {
      if (peek().text === "<end>") error("Unclosed class")
      if (match(";")) continue
      const member = classMember()
      if (member) members.push(member)
    }
    return node("class", [heritage, ...members], title)
  }
  function classMember(): CodeNode | undefined {
    let isStatic = false, ambient = false, bodyless = false, isAsync = false, kind: "method" | "get" | "set" = "method"
    const endsName = (token: Token) => token.kind === "punct" && ["(", "=", ";", "}", ":", "?", "!", "<"].includes(token.text)
    while (isWord(peek()) && CLASS_MODIFIERS.has(peek().text) && !endsName(ahead(1)) && !(ahead(1).nl && ["get", "set", "async"].includes(peek().text))) {
      const word = take().text
      if (word === "static") {
        if (peek().text === "{" && peek().kind === "punct") return node("cm", [node("empty"), fresh(block), node("flags", [], "s")], "block")
        isStatic = true
      } else if (word === "declare") ambient = true
      else if (word === "abstract") bodyless = true
      else if (word === "async") isAsync = true
      else if (word === "get" || word === "set") kind = word
    }
    if (peek().text === "[" && isWord(ahead(1)) && ahead(2).text === ":") { skipAnyBalanced(); if (match(":")) skipType(); match(";"); return undefined }
    const generator = match("*")
    let key: CodeNode, label = "", isPrivate = false
    if (match("[")) { key = expression(); expect("]") } else {
      const token = take()
      if (!["word", "number", "string"].includes(token.kind)) { at--; error("Expected class member name") }
      label = String(token.value ?? token.text)
      isPrivate = token.kind === "word" && token.text.startsWith("#")
      key = node("literal", [], label)
    }
    const flags = node("flags", [], `${isStatic ? "s" : ""}${isPrivate ? "p" : ""}`)
    const optional = match("?")
    if (peek().text === "(" || peek().text === "<") {
      const isConstructor = label === "constructor" && key.kind === "literal" && !isStatic && !isPrivate && kind === "method"
      const properties: string[] = []
      if (peek().text === "<") skipTypeParameters()
      expect("(")
      const params = isConstructor ? constructorParameters(properties) : parameters()
      if (match(":")) skipType()
      if (peek().text !== "{") { match(";"); return undefined }
      const fn = node(methodKind(isAsync, generator), [params, fresh(block)])
      if (isConstructor) return node("cm", [key, fn, flags, node("props", properties.map((entry) => node("literal", [], entry)))], "ctor")
      return node("cm", [key, fn, flags], kind)
    }
    const definite = !optional && match("!")
    const annotated = match(":")
    if (annotated) skipType()
    const initialized = match("=")
    const init = initialized ? expression() : node("literal")
    match(";")
    // A typed field without initializer is a TypeScript declaration only; plain `x` defines undefined like JavaScript.
    if (ambient || bodyless || !initialized && (optional || definite || annotated)) return undefined
    return node("cm", [key, init, flags], "field")
  }

  function statement(): CodeNode { return bounded(() => {
    const token = peek()
    if (match(";")) return node("empty")
    if (token.text === "{" && token.kind === "punct") return block()
    if (token.kind === "word") {
      if (DECLARATIONS.includes(token.text) && (isWord(ahead(1)) || ["[", "{"].includes(ahead(1).text))) { const result = declaration(); match(";"); return result }
      if (token.text === "return") {
        take()
        const none = peek().nl || [";", "}", "<end>"].includes(peek().text)
        const result = node("return", [none ? node("literal") : sequence()])
        match(";"); return result
      }
      if (token.text === "throw") { take(); const result = node("throw", [sequence()]); match(";"); return result }
      if (token.text === "break" || token.text === "continue") {
        take()
        let target: string | undefined
        if (isWord(peek()) && !peek().nl && !peek().text.startsWith("#")) {
          target = take().text
          if (!labels.includes(target)) { at--; error(`Undefined label ${target}`) }
        }
        match(";")
        return node(token.text, [], target)
      }
      if (ahead(1).text === ":" && ahead(1).kind === "punct" && !["default", "case"].includes(token.text) && !token.text.startsWith("#")) {
        if (labels.includes(token.text)) error(`Label ${token.text} is already declared`)
        take(); take()
        labels.push(token.text)
        try { return node("label", [statement()], token.text) } finally { labels.pop() }
      }
      if (token.text === "class") { take(); const cls = classNode(true); return node("declare", [node("id", [], cls.value), cls], "let") }
      if (token.text === "abstract" && isWord(ahead(1), "class") && !ahead(1).nl) { take(); take(); const cls = classNode(true); return node("declare", [node("id", [], cls.value), cls], "let") }
      if (token.text === "if") {
        take(); expect("("); const condition = sequence(); expect(")")
        const yes = statement(), no = match("else") ? statement() : node("empty")
        return node("if", [condition, yes, no])
      }
      if (token.text === "while") { take(); expect("("); const condition = sequence(); expect(")"); return node("while", [condition, statement()]) }
      if (token.text === "do") {
        take(); const body = statement()
        expect("while"); expect("("); const condition = sequence(); expect(")"); match(";")
        return node("doWhile", [body, condition])
      }
      if (token.text === "for") return forStatement()
      if (token.text === "switch") return switchStatement()
      if (token.text === "try") {
        take()
        const body = block()
        let target = node("empty"), caught = node("empty"), final = node("empty")
        if (match("catch")) { if (match("(")) { target = pattern(); if (match(":")) skipType(); expect(")") }; caught = block() }
        if (match("finally")) final = block()
        if (caught.kind === "empty" && final.kind === "empty") error("try needs catch or finally")
        return node("try", [body, target, caught, final])
      }
      if (token.text === "function") { take(); return functionNode(false, true) }
      if (token.text === "async" && isWord(ahead(1), "function") && !ahead(1).nl) { take(); take(); return functionNode(true, true) }
      if (token.text === "interface" && isWord(ahead(1)) && !ahead(1).nl) {
        take(); take()
        if (peek().text === "<") skipTypeParameters()
        if (match("extends")) { do skipType(); while (match(",")) }
        skipAnyBalanced()
        return node("empty")
      }
      if (token.text === "type" && isWord(ahead(1)) && !ahead(1).nl && [ "=", "<"].includes(ahead(2).text)) {
        take(); take()
        if (peek().text === "<") skipTypeParameters()
        expect("="); skipType(); match(";")
        return node("empty")
      }
      if (token.text === "declare" && isWord(ahead(1)) && !ahead(1).nl) { take(); statement(); return node("empty") }
      if (["enum", "namespace"].includes(token.text) && isWord(ahead(1)) && !ahead(1).nl) throw new CodeError("UnsupportedSyntax", `${token.text} is not supported`)
    }
    const result = node("expression", [sequence()]); match(";"); return result
  }) }
  function forStatement(): CodeNode {
    take()
    const awaiting = isWord(peek(), "await") && (take(), true)
    expect("(")
    let init: CodeNode
    if (match(";")) init = node("empty")
    else if (DECLARATIONS.includes(peek().text) && (isWord(ahead(1)) || ["[", "{"].includes(ahead(1).text))) init = declaration(true)
    else { const outer = noIn; noIn = true; try { init = sequence() } finally { noIn = outer } }
    if (peek().text === "of" || peek().text === "in") {
      const kind = take().text === "of" ? "forOf" : "forIn"
      const iterable = kind === "forOf" ? expression() : sequence(); expect(")")
      return node(kind, [init, iterable, statement()], awaiting ? "await" : undefined)
    }
    if (awaiting) error("for await needs of")
    if (init.kind !== "empty") expect(";")
    const noCondition = match(";")
    const condition = noCondition ? node("literal", [], true) : sequence()
    if (!noCondition) expect(";")
    const noUpdate = match(")")
    const update = noUpdate ? node("empty") : sequence()
    if (!noUpdate) expect(")")
    return node("for", [init, condition, update, statement()])
  }
  function switchStatement(): CodeNode {
    take(); expect("("); const subject = sequence(); expect(")"); expect("{")
    const cases: CodeNode[] = []
    while (!match("}")) {
      let test: CodeNode
      if (match("default")) test = node("default")
      else { expect("case"); test = sequence() }
      expect(":")
      const body: CodeNode[] = []
      while (!(isWord(peek(), "case") || isWord(peek(), "default") || peek().text === "}" && peek().kind === "punct")) {
        if (peek().text === "<end>") error("Unclosed switch")
        body.push(statement())
      }
      cases.push(node("case", [test, ...body]))
    }
    return node("switch", [subject, ...cases])
  }

  // Expressions.
  function sequence(): CodeNode {
    const first = expression()
    if (peek().text !== ",") return first
    const items = [first]
    while (match(",")) items.push(expression())
    return node("sequence", items)
  }
  const argumentList = () => list(")", () => match("...") ? node("spread", [expression()]) : expression())
  function pendingPattern(expr: CodeNode): CodeNode {
    if (expr.kind === "id") return expr
    if (expr.kind === "member") return expr
    if (expr.kind === "coverDefault") return node("default", [pendingPattern(expr.children[0]!), expr.children[1]!])
    if (expr.kind === "assign" && expr.value === "=") return node("default", [pendingPattern(expr.children[0]!), expr.children[1]!])
    if (expr.kind === "array") return node("arrayBinding", expr.children.map((child) => child.kind === "spread" ? node("rest", [pendingPattern(child.children[0]!)]) : child.kind === "hole" ? child : pendingPattern(child)))
    if (expr.kind === "object") return node("objectBinding", expr.children.map((child) => child.kind === "spread" ? node("rest", [pendingPattern(child.children[0]!)]) : child.kind === "computed" || child.kind === "accessor" ? error("Computed keys cannot be destructured") : node("entry", [pendingPattern(child.children[0]!)], child.value)))
    return error("Invalid assignment target")
  }
  function objectLiteral(): CodeNode {
    return node("object", list("}", () => {
      if (match("...")) return node("spread", [expression()])
      let modifier = ""
      if (["async", "get", "set"].includes(peek().text) && isWord(peek()) && ![":", ",", "}", "(", "=", "<"].includes(ahead(1).text)) modifier = take().text
      const generator = modifier === "get" || modifier === "set" ? false : match("*")
      let computed: CodeNode | undefined, key: Token | undefined
      if (match("[")) { computed = expression(); expect("]") } else {
        key = take()
        if (!["word", "number", "string"].includes(key.kind) || key.text.startsWith("#") && key.kind === "word") { at--; error("Expected object key") }
      }
      const entryName = key ? String(key.value ?? key.text) : ""
      if (modifier === "get" || modifier === "set") return node("accessor", [computed ?? node("literal", [], entryName), methodNode(false, false)], modifier)
      const entry = (value: CodeNode) => computed ? node("computed", [computed, value]) : node("entry", [value], entryName)
      if (peek().text === "(" || peek().text === "<") return entry(methodNode(modifier === "async", generator))
      if (match(":")) return entry(expression())
      if (computed || key?.kind !== "word") error("Expected :")
      const shorthand = node("id", [], key!.text)
      return entry(match("=") ? node("coverDefault", [shorthand, expression()]) : shorthand)
    }))
  }
  /** `<T>(x: T) => x`, `(a: number): string => a`, `x => x` and `async` forms. Returns undefined when the text is not an arrow function. */
  function tryArrow(async: boolean): CodeNode | undefined {
    const start = at
    if (failedArrows.has(start)) return undefined
    try {
      if (peek().text === "<") skipTypeParameters()
      expect("(")
      const params = parameters()
      if (match(":")) skipType()
      if (!match("=>")) throw new CodeError("ParseError", "Not an arrow function")
      return arrowBody(async, params)
    } catch (err) {
      if (!(err instanceof CodeError)) throw err
      failedArrows.add(start); at = start
      return undefined
    }
  }
  function newExpression(): CodeNode {
    let callee = prefixPrimary()
    while (true) {
      if (match(".")) { callee = memberNode(callee, name(true)); continue }
      if (peek().text === "[" && peek().kind === "punct") { take(); const key = expression(); expect("]"); callee = node("member", [callee, key]); continue }
      break
    }
    if (peek().text === "<" && !peek().nl) { const save = at; try { skipTypeArguments() } catch (err) { if (!(err instanceof CodeError)) throw err; at = save } }
    return node("new", [callee, ...(match("(") ? argumentList() : [])])
  }
  function prefixPrimary(): CodeNode {
    if (isWord(peek(), "new")) { take(); return newExpression() }
    return prefix()
  }
  function templateNode(token: Token): CodeNode {
    const children: CodeNode[] = [node("literal", [], token.strings![0]!)]
    token.sources!.forEach((source, index) => {
      const inner = parseTokens(tokenize(source.code, source.at), shared, false)
      children.push(inner, node("literal", [], token.strings![index + 1]!))
    })
    return node("template", children)
  }
  function prefix(): CodeNode {
    const token = take()
    if (token.kind === "number" || token.kind === "string") return node("literal", [], token.value)
    if (token.kind === "template") return templateNode(token)
    if (token.kind === "regex") return node("regex", [node("literal", [], token.flags ?? "")], String(token.value))
    if (token.kind === "punct") {
      if (["!", "+", "-", "~"].includes(token.text)) return node("unary", [expression(14)], token.text)
      if (token.text === "++" || token.text === "--") return node("preUpdate", [expression(14)], token.text)
      if (token.text === "(") {
        at--
        const arrow = tryArrow(false)
        if (arrow) return arrow
        take()
        const inner = sequence(); expect(")"); return inner
      }
      if (token.text === "<") {
        at--
        const arrow = tryArrow(false)
        if (arrow) return arrow
        at++
        return error("Type assertions are not supported; use `as`")
      }
      if (token.text === "[") return node("array", list("]", () => peek().text === "," ? node("hole") : match("...") ? node("spread", [expression()]) : expression()))
      if (token.text === "{") return objectLiteral()
      at--
      return error(`Unexpected ${token.text}`)
    }
    if (token.kind !== "word") return error(`Unexpected ${token.text}`)
    if (token.text.startsWith("#")) { at--; return error("Private names are only valid after a dot") }
    switch (token.text) {
      case "true": case "false": return node("literal", [], token.text === "true")
      case "null": return node("literal", [], null)
      case "await": case "typeof": case "void": case "delete": return node("unary", [expression(14)], token.text)
      case "new": return newExpression()
      case "this": return node("this")
      case "super": {
        if (peek().text !== "(" && peek().text !== "." && peek().text !== "[") error("'super' must be followed by a call or member access")
        return node("super")
      }
      case "class": return classNode(false)
      case "function": return functionNode(false, false)
      case "yield": {
        const delegate = match("*")
        const none = !delegate && (peek().nl || [")", "]", "}", ",", ";", ":", "<end>"].includes(peek().text))
        return node("yield", [none ? node("literal") : expression()], delegate ? "*" : undefined)
      }
      case "async": {
        const next = peek()
        if (!next.nl) {
          if (isWord(next, "function")) { take(); return functionNode(true, false) }
          if (isWord(next) && ahead(1).text === "=>") { const param = node("id", [], take().text); take(); return arrowBody(true, node("params", [param])) }
          if (next.text === "(" || next.text === "<") { const arrow = tryArrow(true); if (arrow) return arrow }
        }
        return node("id", [], "async")
      }
    }
    if (UNSUPPORTED.includes(token.text)) throw new CodeError("UnsupportedSyntax", `${token.text} is not supported`)
    if (peek().text === "=>" && !peek().nl) { take(); return arrowBody(false, node("params", [node("id", [], token.text)])) }
    return node("id", [], token.text)
  }
  function expression(min = 1): CodeNode { return bounded(() => {
    let left = prefix()
    let optional = false
    const close = () => { if (optional) { left = node("chain", [left]); optional = false } }
    while (true) {
      const next = peek()
      if (next.kind === "punct" || next.kind === "word") {
        if (match(".")) { left = memberNode(left, name(true)); continue }
        if (match("?.")) {
          optional = true
          if (match("(")) left = node("optionalCall", [left, ...argumentList()])
          else if (match("[")) { const key = expression(); expect("]"); left = node("optionalMember", [left, key]) }
          else left = node("optionalMember", [left, node("literal", [], name())])
          continue
        }
        if (next.text === "[" && next.kind === "punct") { take(); const key = sequence(); expect("]"); left = node("member", [left, key]); continue }
        if (next.text === "(" && next.kind === "punct") { take(); left = left.kind === "super" ? node("superCall", argumentList()) : node("call", [left, ...argumentList()]); continue }
        if (next.text === "!" && !next.nl && next.kind === "punct") { take(); continue }
        if ((next.text === "++" || next.text === "--") && !next.nl) { close(); take(); left = node("update", [left], next.text); continue }
        if (next.text === "<" && ["id", "member"].includes(left.kind) && !failedArguments.has(at)) {
          const save = at
          try { skipTypeArguments(); if (peek().text === "(") continue } catch (err) { if (!(err instanceof CodeError)) throw err }
          failedArguments.add(save); at = save
        }
        if (isWord(next) && (next.text === "as" || next.text === "satisfies") && !next.nl && min <= 9) { close(); take(); if (!match("const")) skipType(); continue }
      }
      if (min <= 2 && match("?")) { close(); const yes = expression(); expect(":"); left = node("conditional", [left, yes, expression()]); continue }
      let op = next.kind === "word" ? next.text : next.kind === "punct" ? next.text : ""
      let width = 1
      if (op === ">" && ahead(1).text === ">" && ahead(1).at === next.at + 1) { op = ">>"; width = 2; if (ahead(2).text === ">" && ahead(2).at === next.at + 2) { op = ">>>"; width = 3 } }
      if (op === "in" && noIn || next.kind === "word" && op !== "instanceof" && op !== "in") break
      const precedence = PRECEDENCE[op]
      if (!precedence || precedence < min) break
      close()
      at += width
      const right = expression(precedence === 1 || op === "**" ? precedence : precedence + 1)
      if (precedence === 1) left = node("assign", [["array", "object"].includes(left.kind) && op === "=" ? pendingPattern(left) : left, right], op)
      else left = node("binary", [left, right], op)
    }
    close()
    return left
  }) }

  const children: CodeNode[] = []
  while (peek().text !== "<end>") children.push(whole ? statement() : node("expression", [sequence()]))
  if (!whole) {
    if (children.length !== 1 || children[0]!.kind !== "expression") error("Invalid template substitution")
    return children[0]!.children[0]!
  }
  if (!children.length) throw new CodeError("ParseError", "Code cannot be empty")
  return node("program", children)
}

export function parseCode(source: string): CodeNode {
  return parseTokens(tokenize(source), { depth: 0 }, true)
}
