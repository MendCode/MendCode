import { describe, expect, test } from "bun:test"
import { scanSource } from "../src/scan"
import { harness, project, useTempDirs } from "./helpers"

const tmp = useTempDirs()

async function api({ files, path }: { files: Record<string, string>; path: string }): Promise<string[]> {
  const h = harness({ root: project({ root: tmp(), files }), cacheDir: tmp() })
  const result = await h.call("graph_file_api", { path })
  expect(result.isError).toBe(false)
  return result.output.split("\n")
}

const TRICKY_TS = [
  "// top comment with function fake() {}",
  'import type { T } from "./types"',
  "export const re = /[{}]/g",
  'const text = "function notReal() { "',
  'const tpl = `a ${"}"} function alsoNot() {`',
  "export async function withReturnType(a: { x: number }): Promise<{ ok: boolean }> {",
  '  const s = "}"',
  "  return { ok: true }",
  "}",
  "export interface Shape {",
  "  area(): number",
  "}",
  "export type Union =",
  '  | "a"',
  '  | "b"',
  "export enum Color { Red, Green }",
  "export default class Widget extends Base {",
  "  private count = 0",
  "  static create(): Widget {",
  "    return new Widget()",
  "  }",
  "  get size() { return 1 }",
  "  handler = (e: Event) => {",
  "    this.count++",
  "  }",
  "}",
  "export const multi = {",
  "  a: 1,",
  "}",
  "const arrow = async (x: number) =>",
  "  x + 1",
  "export { arrow as renamed }",
  "function over(a: string): void",
  "function over(a: number): void",
  "function over(a: any) {}",
  "",
].join("\n")

const TRICKY_PY = [
  '"""Module docstring with def fake(): pass"""',
  "import os, sys as system",
  "from .sibling import thing",
  "from pkg.mod import other",
  "",
  "@decorator(arg)",
  "def top(",
  "    a,",
  "    b=(1, 2),",
  "):",
  '    """doc',
  "    def inner_fake():",
  '    """',
  '    s = "def nope():"',
  "    return a  # def commented(): pass",
  "",
  "",
  "async def runner():",
  "    def nested():",
  "        pass",
  "    await top(1)",
  "",
  "",
  "class Base(Parent):",
  "    attr = 1",
  "",
  "    def __init__(self):",
  "        self.setup()",
  "",
  "    def setup(self):",
  "        return helper()",
  "",
  "    @staticmethod",
  "    def make():",
  "        return Base()",
  "",
  "",
  "def helper():",
  "    pass",
  "",
].join("\n")

const TRICKY_GO = [
  "package svc",
  "",
  "import (",
  '\t"fmt"',
  '\tstr "strings"',
  ")",
  "",
  "const Limit = 10",
  "",
  "var (",
  "\tgrouped = 1",
  ")",
  "",
  "type Handler interface {",
  "\tServe() error",
  "}",
  "",
  "type Server struct {",
  "\tname string",
  "\tcb   func() string",
  "}",
  "",
  "type Alias int",
  "",
  "func New(name string) *Server {",
  '\ts := &Server{name: name, cb: func() string { return "}" }}',
  "\treturn s",
  "}",
  "",
  "func (s *Server) Serve() error {",
  "\tfmt.Println(`raw { string`)",
  "\treturn s.stop()",
  "}",
  "",
  "func (s *Server) stop() error { return nil }",
  "",
  "func Generic[T any](v T) T {",
  "\treturn v",
  "}",
  "",
].join("\n")

const TRICKY_RS = [
  "use std::{fmt, io};",
  "use crate::util::helper;",
  "",
  "pub struct Engine {",
  "    speed: u32,",
  "}",
  "",
  "pub enum Mode { Fast, Slow }",
  "",
  "pub trait Runner {",
  "    fn run(&self);",
  "}",
  "",
  "impl fmt::Display for Engine {",
  "    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {",
  '        write!(f, "{}", "}")',
  "    }",
  "}",
  "",
  "impl Engine {",
  "    pub fn new() -> Self {",
  "        let c = 'x';",
  '        let l: &\'static str = "a";',
  "        Engine { speed: helper(1) }",
  "    }",
  "",
  "    pub async fn go<T>(&self, t: T) -> T",
  "    where",
  "        T: Clone,",
  "    {",
  "        t.clone()",
  "    }",
  "}",
  "",
  "pub const MAX: u32 = 5;",
  "",
  "pub(crate) fn top_level(x: u32) -> u32 {",
  "    Engine::new();",
  "    x",
  "}",
  "",
].join("\n")

describe("TypeScript and JavaScript scanner", () => {
  test("ignores strings, templates, regexes and comments and finds exact spans", async () => {
    const lines = await api({ files: { "tricky.ts": TRICKY_TS }, path: "tricky.ts" })
    expect(lines).toEqual([
      "tricky.ts (typescript, 16 symbols)",
      "L3-L3  variable re (export)",
      "L4-L4  variable text",
      "L5-L5  variable tpl",
      "L6-L9  function withReturnType (export)",
      "L10-L12  interface Shape (export)",
      "L13-L15  type Union (export)",
      "L16-L16  enum Color (export)",
      "L17-L26  class Widget (export)",
      "L19-L21    method create",
      "L22-L22    method size",
      "L23-L25    method handler",
      "L27-L29  variable multi (export)",
      "L30-L31  function arrow (export)",
      "L33-L33  function over",
      "L34-L34  function over",
      "L35-L35  function over",
    ])
  })

  test("reads imports from .tsx, .js, .mjs and .cjs files", async () => {
    const h = harness({
      root: project({
        root: tmp(),
        files: {
          "ui/view.tsx": 'import { tool } from "../lib/tool.js"\nexport function View() { return <div>{tool()}</div> }\n',
          "lib/tool.ts": "export function tool() {}\n",
          "lib/cjs.cjs": 'const { tool } = require("./tool.js")\nfunction viaCjs() { tool() }\nmodule.exports = { viaCjs }\n',
          "lib/esm.mjs": 'import { tool } from "./tool.js"\nexport function viaEsm() { tool() }\n',
          "lib/plain.js": 'import "./tool"\nexport const x = 1\n',
        },
      }),
      cacheDir: tmp(),
    })
    expect((await h.call("graph_file_api", { path: "ui/view.tsx" })).output).toContain("imports: lib/tool.ts")
    expect((await h.call("graph_file_api", { path: "lib/esm.mjs" })).output).toContain("imports: lib/tool.ts")
    expect((await h.call("graph_file_api", { path: "lib/cjs.cjs" })).output).toContain("imports: lib/tool.ts")
    expect((await h.call("graph_file_api", { path: "lib/plain.js" })).output).toContain("imports: lib/tool.ts")
    const callers = await h.call("graph_callers", { symbol: "tool", direction: "in" })
    expect(callers.output).toContain("View")
    expect(callers.output).toContain("viaEsm")
    expect(callers.output).toContain("viaCjs")
  })

  test("static calls resolve to methods; library calls like JSON.parse never become project edges", async () => {
    const h = harness({
      root: project({
        root: tmp(),
        files: {
          "a.ts": [
            "export class Box {",
            "  static make() { return new Box() }",
            "}",
            "export function parse() {}",
            "export function use() {",
            "  Box.make()",
            "  JSON.parse('{}')",
            "  const made = Box",
            "}",
            "",
          ].join("\n"),
        },
      }),
      cacheDir: tmp(),
    })
    expect((await h.call("graph_callers", { symbol: "Box.make", direction: "in" })).output).toContain("function use")
    expect((await h.call("graph_callers", { symbol: "parse", direction: "in" })).output).toContain("No callers found")
  })
})

describe("Python scanner", () => {
  test("finds defs, classes, methods and spans through docstrings and multi-line signatures", async () => {
    const lines = await api({ files: { "tricky.py": TRICKY_PY }, path: "tricky.py" })
    expect(lines).toEqual([
      "tricky.py (python, 7 symbols)",
      "L7-L15  function top (export)",
      "L18-L21  function runner (export)",
      "L24-L35  class Base (export)",
      "L27-L28    method __init__",
      "L30-L31    method setup (export)",
      "L34-L35    method make (export)",
      "L38-L39  function helper (export)",
    ])
  })

  test("resolves calls, self calls and relative imports", async () => {
    const h = harness({
      root: project({ root: tmp(), files: { "pkg/tricky.py": TRICKY_PY, "pkg/sibling.py": "def thing():\n    return 1\n", "pkg/mod.py": "def other():\n    return 2\n" } }),
      cacheDir: tmp(),
    })
    expect((await h.call("graph_callers", { symbol: "top", direction: "in" })).output).toContain("function runner")
    expect((await h.call("graph_callers", { symbol: "Base.__init__", direction: "out" })).output).toContain("Base.setup")
    expect((await h.call("graph_callers", { symbol: "Base.setup", direction: "out" })).output).toContain("function helper")
    expect((await h.call("graph_file_api", { path: "pkg/tricky.py" })).output).toContain("imports: pkg/mod.py, pkg/sibling.py")
  })
})

describe("Go scanner", () => {
  test("finds funcs, receiver methods, structs, interfaces and values", async () => {
    const lines = await api({ files: { "svc.go": TRICKY_GO }, path: "svc.go" })
    expect(lines).toEqual([
      "svc.go (go, 8 symbols)",
      "L8-L8  variable Limit (export)",
      "L14-L16  interface Handler (export)",
      "L18-L21  struct Server (export)",
      "L23-L23  type Alias (export)",
      "L25-L28  function New (export)",
      "L30-L33    method Serve (export)",
      "L35-L35    method stop",
      "L37-L39  function Generic (export)",
    ])
  })
})

describe("Rust scanner", () => {
  test("finds items, impl blocks, trait methods and where-clause signatures", async () => {
    const lines = await api({ files: { "lib.rs": TRICKY_RS }, path: "lib.rs" })
    expect(lines).toEqual([
      "lib.rs (rust, 11 symbols)",
      "L4-L6  struct Engine (export)",
      "L8-L8  enum Mode (export)",
      "L10-L12  trait Runner (export)",
      "L11-L11    method run",
      "L14-L18  impl Engine",
      "L15-L17    method fmt",
      "L20-L33  impl Engine",
      "L21-L25    method new (export)",
      "L27-L32    method go (export)",
      "L35-L35  variable MAX (export)",
      "L37-L40  function top_level (export)",
    ])
  })

  test("Type::assoc() calls resolve to the impl method", async () => {
    const h = harness({ root: project({ root: tmp(), files: { "lib.rs": TRICKY_RS } }), cacheDir: tmp() })
    expect((await h.call("graph_callers", { symbol: "Engine.new", direction: "in" })).output).toContain("function top_level")
  })
})

describe("swift", () => {
  const source = [
    "import Foundation",
    "@MainActor",
    "final class Monitor: ObservableObject {",
    "  private var timer: Timer?",
    "  init(store: Store) { self.store = store }",
    "  func start() {",
    "    let text = \"func fake() { }\"",
    "    self.poll()",
    "    Parser.parse(text)",
    "  }",
    "  private func poll() async { await refresh() }",
    "  enum Event { case started }",
    "}",
    "extension Monitor {",
    "  static func shared() -> Monitor { Monitor(store: Store()) }",
    "}",
    "protocol Source {",
    "  func read() -> String",
    "}",
    "func refresh() { }",
  ].join("\n")

  test("types at any nesting, their methods and top-level functions are declared; locals, properties and strings are not", () => {
    const result = scanSource({ path: "Sources/Monitor.swift", text: source })!
    expect(result.imports).toEqual(["Foundation"])
    expect(result.symbols.map((symbol) => `${symbol.kind} ${symbol.parent ? `${symbol.parent}.` : ""}${symbol.name}${symbol.exported ? "" : " private"} ${symbol.start}-${symbol.end}`)).toEqual([
      "class Monitor 3-13",
      "method Monitor.init 5-5",
      "method Monitor.start 6-10",
      "method Monitor.poll private 11-11",
      "enum Event 12-12",
      "impl Monitor 14-16",
      "method Monitor.shared 15-15",
      "interface Source 17-19",
      "method Source.read 18-18",
      "function refresh 20-20",
    ])
  })

  test("a call is attributed to its method, with self and type receivers kept", () => {
    const result = scanSource({ path: "Sources/Monitor.swift", text: source })!
    const start = result.symbols.findIndex((symbol) => symbol.name === "start")
    expect(result.calls.filter((call) => call.from === start)).toEqual([{ from: start, name: "poll", self: true }, { from: start, name: "parse", qualifier: "Parser", dot: true }])
  })
})
