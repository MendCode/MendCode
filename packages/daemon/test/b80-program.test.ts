import { expect, test } from "bun:test"
import { runComputerProgram } from "../src/computer-program"

const signal = () => new AbortController().signal
const observation = { revision: 1, nodes: [{ id: "0.1", name: "Save", role: "AXButton" }, { id: "0.2", name: "Search", role: "AXTextField" }] }

test("confined programs evaluate plain data, conditions, loops, logs and data array methods", async () => {
  const result = await runComputerProgram("const o = await tools.observe({}); const names = []; for (const node of o.nodes) { if (node.role === 'AXButton') names.push(node.name) } console.log(names.join(', ')); return {revision:o.revision,names,hasSave:o.nodes.some(n => n.name === 'Save')}", signal(), async () => observation)
  expect(result).toEqual({ ok: true, value: { revision: 1, names: ["Save"], hasSave: true }, logs: ["Save"], toolCalls: [{ name: "observe" }] })
})

test("process, network, imports, functions and prototype escape attempts never execute a host effect", async () => {
  for (const code of ["return process.env", "await fetch('https://invalid')", "import x from 'node:fs'", "return tools.observe.constructor('return process')()", "return ({}).__proto__", "return JSON.parse('{\"constructor\":1}').constructor", "return new Function('return process')()", "return (() => 1)"]) {
    let effects = 0
    const result = await runComputerProgram(code, signal(), async () => { effects++; return observation })
    expect(result.ok).toBe(false)
    expect(effects).toBe(0)
  }
})

test("sixteen-call, step, output and cancellation budgets produce diagnostics without extra effects", async () => {
  let effects = 0
  const invoke = async () => { effects++; return observation }
  const result = await runComputerProgram("let i = 0; while (i < 17) { await tools.observe({}); i = i + 1 }", signal(), invoke)
  expect(result).toMatchObject({ ok: false, error: { kind: "ToolCallLimitExceeded" } })
  expect(effects).toBe(16)
  expect((await runComputerProgram("while (true) {}", signal(), invoke)).ok).toBe(false)
  expect((await runComputerProgram("let text = 'abcdefgh'; let i = 0; while (i < 20) { text = text + text; i = i + 1 } return text", signal(), invoke)).ok).toBe(false)
  expect((await runComputerProgram("let data = {x:1}; let i = 0; while (i < 20) { data = {a:data,b:data}; i = i + 1 } return data", signal(), invoke)).ok).toBe(false)
  const abort = new AbortController(); abort.abort()
  expect((await runComputerProgram("await tools.observe({})", abort.signal, invoke)).ok).toBe(false)
  expect(effects).toBe(16)
})

test("each execution has a fresh heap and parse failures precede all effects", async () => {
  expect((await runComputerProgram("const x = 1; return x", signal(), async () => null)).ok).toBe(true)
  expect((await runComputerProgram("return x", signal(), async () => null)).ok).toBe(false)
  let effects = 0
  expect((await runComputerProgram("await tools.observe({}); enum Later { A }", signal(), async () => { effects++; return null })).ok).toBe(false)
  expect(effects).toBe(0)
})

test("TypeScript, destructuring, templates, async functions and Promise concurrency run under the same sixteen-call budget", async () => {
  const code = `
    type Node = { id: string; name: string; role: string }
    const { nodes, revision }: { nodes: Node[]; revision: number } = await tools.observe({})
    const labels = nodes.map(({ name, role }): string => \`\${role}:\${name}\`)
    const press = async (node: Node) => tools.press({ revision, nodeID: node.id })
    const settled = await Promise.allSettled(nodes.map(press))
    const tagged = new Map<string, string>(nodes.map((node) => [node.id, node.name]))
    return { labels, statuses: settled.map((entry) => entry.status), save: tagged.get("0.1")!, size: tagged.size }`
  const calls: string[] = []
  const result = await runComputerProgram(code, signal(), async (name) => { calls.push(name); return observation })
  expect(result).toMatchObject({ ok: true, value: { labels: ["AXButton:Save", "AXTextField:Search"], statuses: ["fulfilled", "fulfilled"], save: "Save", size: 2 } })
  expect(calls).toEqual(["observe", "press", "press"])
  const tooMany = await runComputerProgram("await Promise.all(Array.from({ length: 17 }, () => tools.observe({})))", signal(), async () => observation)
  expect(tooMany).toMatchObject({ ok: false, error: { kind: "ToolCallLimitExceeded" } })
  expect((await runComputerProgram("return tools.observe.constructor", signal(), async () => observation)).ok).toBe(false)
  expect((await runComputerProgram("return tools.other({})", signal(), async () => observation)).ok).toBe(false)
})

test("aliased object graphs cannot bypass output budgets through implicit native conversion", async () => {
  const graph = "let data = ['x']; let i = 0; while (i < 40) { data = [data,data]; i = i + 1 } "
  for (const tail of ["return data.join(',')", "return 'value:' + data", "return data - 1", "return 'x'.includes(data)"]) {
    const result = await runComputerProgram(graph + tail, signal(), async () => null)
    expect(result.ok).toBe(false)
    expect(result.error?.message).toMatch(/levels|limit|budget|primitive/)
  }
})
