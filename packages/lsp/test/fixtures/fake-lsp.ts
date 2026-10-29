// Tiny language server over stdio for tests: publishes one error per line containing "ERROR".
// Env: FAKE_LOG=<file> (received methods), FAKE_DOUBLE=1 (empty publish first, real one 100 ms later),
// FAKE_CHUNKY=1 (writes split into 7-byte pieces and two messages per write), FAKE_DELAY=<ms>.
// Document text: "SLOW<ms>" delays that document's publish, "CRASH" exits, "SPAM" floods stderr.
import { appendFileSync } from "node:fs"

const log = (entry: unknown) => {
  if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, `${JSON.stringify(entry)}\n`)
}

function frame(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message))
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body])
}

let queue: Promise<void> = Promise.resolve()
let documentUri = ""
const range = { start: { line: 1, character: 2 }, end: { line: 1, character: 8 } }
const item = () => ({ name: "execute", kind: 12, uri: documentUri, range, selectionRange: range, data: { server: "fake", token: "keep-me" } })

/** Writes are serialized so chunked messages never interleave. */
function write(...messages: unknown[]): Promise<void> {
  const bytes = Buffer.concat(messages.map(frame))
  queue = queue.then(async () => {
    if (process.env.FAKE_CHUNKY !== "1") return void process.stdout.write(bytes)
    for (let i = 0; i < bytes.length; i += 7) {
      process.stdout.write(bytes.subarray(i, i + 7))
      await Bun.sleep(1)
    }
  })
  return queue
}

function diagnosticsOf(text: string) {
  return text.split("\n").flatMap((line, index) => (line.includes("ERROR") ? [{ range: { start: { line: index, character: line.indexOf("ERROR") }, end: { line: index, character: line.indexOf("ERROR") + 5 } }, severity: 1, code: "E001", source: "fake", message: `found ERROR on line ${index + 1}` }] : []))
}

async function publish(uri: string, version: number, text: string) {
  if (process.env.FAKE_DELAY) await Bun.sleep(Number(process.env.FAKE_DELAY))
  // "SLOW<ms>" in a document delays that document's publish only.
  const slow = /SLOW(\d+)/.exec(text)
  if (slow) await Bun.sleep(Number(slow[1]))
  if (text.includes("CRASH")) {
    process.stderr.write("fake server crashing\n")
    process.exit(1)
  }
  if (text.includes("SPAM")) for (let i = 0; i < 300; i++) process.stderr.write(`${"x".repeat(999)}\n`)
  if (process.env.FAKE_DOUBLE === "1") {
    await write({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri, version, diagnostics: [] } })
    await Bun.sleep(100)
  }
  await write({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri, version, diagnostics: diagnosticsOf(text) } })
}

async function handle(message: { id?: number; method?: string; params?: any; result?: unknown }) {
  const { id, method, params } = message
  if (method === undefined) return log({ response: id, result: message.result })
  log({ method, params, ...(params?.textDocument?.version !== undefined ? { version: params.textDocument.version } : {}), ...(method === "initialize" ? { pid: process.pid, rootUri: params.rootUri, publish: params.capabilities?.textDocument?.publishDiagnostics, env: process.env.FAKE_ENV } : {}) })
  if (id !== undefined && method !== "initialize" && method !== "shutdown" && process.env.FAKE_HANG === "1") return
  switch (method) {
    case "initialize":
      return write({ jsonrpc: "2.0", id, result: { capabilities: { textDocumentSync: 1 } } })
    case "initialized":
      // exercise server->client requests; the client must answer them
      return write({ jsonrpc: "2.0", id: 9001, method: "workspace/configuration", params: { items: process.env.FAKE_SECTIONS === "1" ? [{ section: "python.analysis" }, { section: "python.missing" }] : [{}, {}] } }, { jsonrpc: "2.0", id: 9002, method: "window/workDoneProgress/create", params: { token: 1 } })
    case "textDocument/didOpen":
      documentUri = params.textDocument.uri
      return publish(params.textDocument.uri, params.textDocument.version, params.textDocument.text)
    case "textDocument/didChange":
      return publish(params.textDocument.uri, params.textDocument.version, params.contentChanges[0].text)
    case "textDocument/hover":
      return write({ jsonrpc: "2.0", id, result: process.env.FAKE_NULL === "1" ? null : { contents: { kind: "markdown", value: "function execute(): Promise<void>" }, range } })
    case "textDocument/definition":
      return write({ jsonrpc: "2.0", id, result: { targetUri: documentUri, targetRange: range, targetSelectionRange: range, originSelectionRange: range } })
    case "textDocument/references":
    case "textDocument/implementation":
      return write({ jsonrpc: "2.0", id, result: [{ uri: documentUri, range }] })
    case "textDocument/documentSymbol":
      return write({ jsonrpc: "2.0", id, result: [{ name: "Service", kind: 5, range, selectionRange: range, children: [{ name: "execute", kind: 6, range, selectionRange: range }] }] })
    case "workspace/symbol":
      return write({ jsonrpc: "2.0", id, ...(params.query === "__error__" ? { error: { code: -32601, message: "Unsupported operation" } } : { result: params.query === "__empty__" ? [] : [{ name: "README", kind: 1, location: { uri: documentUri, range } }, ...Array.from({ length: 12 }, (_, i) => ({ name: `execute${i}`, kind: 12, location: { uri: documentUri, range } }))] }) })
    case "textDocument/prepareCallHierarchy":
      return write({ jsonrpc: "2.0", id, result: process.env.FAKE_NULL === "1" ? null : [item(), { ...item(), name: "second" }] })
    case "callHierarchy/incomingCalls":
    case "callHierarchy/outgoingCalls":
      if (params.item?.data?.token !== "keep-me" || params.item.name !== "execute") return write({ jsonrpc: "2.0", id, error: { code: -32602, message: "Lost hierarchy item data" } })
      return write({ jsonrpc: "2.0", id, result: [{ [method.endsWith("incomingCalls") ? "from" : "to"]: item(), fromRanges: [range] }] })
    case "shutdown":
      return write({ jsonrpc: "2.0", id, result: null })
    case "exit":
      process.exit(0)
  }
}

let buffer = Buffer.alloc(0)
process.stdin.on("data", (chunk: Buffer) => {
  buffer = Buffer.concat([buffer, chunk])
  for (;;) {
    const end = buffer.indexOf("\r\n\r\n")
    if (end === -1) return
    const length = Number(/content-length: (\d+)/i.exec(buffer.subarray(0, end).toString())![1])
    if (buffer.length < end + 4 + length) return
    const body = buffer.subarray(end + 4, end + 4 + length).toString()
    buffer = buffer.subarray(end + 4 + length)
    void handle(JSON.parse(body))
  }
})
process.stdin.on("end", () => process.exit(0))
