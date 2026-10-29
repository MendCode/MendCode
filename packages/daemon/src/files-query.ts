import { stat } from "node:fs/promises"
import path from "node:path"
import { redactSecrets } from "@mendcode/protocol"
import { fileIgnore } from "./file-ignore"

type Input = { directory: string; operation: "files" | "tree" | "search"; query?: string | undefined; glob?: string[] | undefined; limit?: number | undefined; ignore?: string[] | undefined }
const MAX_BYTES = 128000
const MAX_FILE_BYTES = 2000000

async function rgLines(args: string[], cwd: string, accept: (line: string) => boolean, limit: number) {
  const child = Bun.spawn(["rg", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  const lines: string[] = []
  let bytes = 0, pending = "", truncated = false
  const decoder = new TextDecoder()
  const timeout = setTimeout(() => { truncated = true; child.kill() }, 5000)
  const stderr = new Response(child.stderr).text()
  const push = (line: string) => {
    if (!line || truncated || !accept(line)) return
    const safe = redactSecrets(line.slice(0, 1000)).text
    if (lines.length >= limit || bytes + Buffer.byteLength(safe) > MAX_BYTES) { truncated = true; child.kill(); return }
    lines.push(safe)
    bytes += Buffer.byteLength(safe)
  }
  try {
    for await (const chunk of child.stdout) {
      pending += decoder.decode(chunk, { stream: true })
      const parts = pending.split("\n")
      pending = parts.pop() ?? ""
      for (const line of parts) push(line)
      if (pending.length > MAX_BYTES) { truncated = true; child.kill() }
    }
    push(pending + decoder.decode())
    const code = await child.exited
    if (!truncated && code !== 0 && code !== 1) throw new Error(redactSecrets((await stderr).trim().slice(0, 1000) || `rg exited ${code}`).text)
    await stderr
    return { lines, truncated }
  } finally { clearTimeout(timeout) }
}

export async function queryFiles(input: Input) {
  if (!(await stat(input.directory)).isDirectory()) throw new Error("project path is not a directory")
  const limit = input.limit ?? (input.operation === "search" ? 500 : 10000)
  if (input.operation === "search" && !input.query) throw new Error("search needs a pattern")
  let found: { lines: string[]; truncated: boolean }
  if (Bun.which("rg")) {
    const args = input.operation === "search" ? ["--line-number", "--with-filename", "--no-heading", "--color", "never", "--max-filesize", String(MAX_FILE_BYTES)] : ["--files"]
    for (const glob of input.glob ?? []) args.push("--glob", glob)
    for (const ignore of input.ignore ?? []) args.push("--glob", `!${ignore}`)
    args.push("--glob", "!node_modules", "--glob", "!.git")
    if (input.operation === "search") args.push("-e", input.query!)
    args.push("--", ".")
    found = await rgLines(args, input.directory, (line) => input.operation === "search" || !input.query || line.toLowerCase().includes(input.query.toLowerCase()), limit)
  } else {
    // A bounded fallback keeps offline installs useful when ripgrep is not installed.
    const regex = input.operation === "search" ? new RegExp(input.query!) : undefined
    const ignored = fileIgnore(input.ignore)
    const globs = input.glob?.map((glob) => new Bun.Glob(glob))
    const lines: string[] = []
    let bytes = 0, scanned = 0, truncated = false
    const deadline = Date.now() + 5000
    const add = (line: string) => {
      const safe = redactSecrets(line.slice(0, 1000)).text
      if (lines.length >= limit || bytes + Buffer.byteLength(safe) > MAX_BYTES) { truncated = true; return }
      lines.push(safe)
      bytes += Buffer.byteLength(safe)
    }
    for await (const file of new Bun.Glob("**/*").scan({ cwd: input.directory, onlyFiles: true, followSymlinks: false })) {
      if (++scanned > 50000 || Date.now() > deadline) { truncated = true; break }
      if (ignored(file)) continue
      if (file.split("/").some((part) => part.startsWith(".") || ["node_modules", "dist", "build"].includes(part)) || globs && !globs.some((glob) => glob.match(file) || glob.match(path.basename(file)))) continue
      if (!regex) {
        if (!input.query || file.toLowerCase().includes(input.query.toLowerCase())) add(file)
      } else {
        const source = Bun.file(path.join(input.directory, file))
        if (source.size > MAX_FILE_BYTES) continue
        const text = await source.text().catch(() => "")
        if (text.includes("\0")) continue
        for (const [index, line] of text.split("\n").entries()) {
          if (regex.test(line)) add(`${file}:${index + 1}:${line}`)
          if (truncated) break
        }
      }
      if (truncated) break
    }
    found = { lines, truncated }
  }
  const lines = found.lines.map((line) => line.replace(/^\.\//, ""))
  if (input.operation === "tree") {
    const tree = new Map<string, string>()
    for (const file of lines.sort()) {
      const parts = file.split("/")
      for (let i = 0; i < parts.length; i++) tree.set(parts.slice(0, i + 1).join("/"), `${"  ".repeat(i)}${parts[i]}${i < parts.length - 1 ? "/" : ""}`)
    }
    const rows: string[] = []
    let bytes = 0
    for (const row of tree.values()) {
      if (bytes + Buffer.byteLength(row) > MAX_BYTES) break
      rows.push(row)
      bytes += Buffer.byteLength(row)
    }
    return { operation: input.operation, lines: rows, truncated: found.truncated || rows.length < tree.size }
  }
  return { operation: input.operation, lines, truncated: found.truncated }
}
