import { appendFileSync } from "node:fs"
import { spawn } from "node:child_process"

const mode = process.env.FAKE_FORMATTER_MODE
if (process.env.FAKE_FORMATTER_LOG) appendFileSync(process.env.FAKE_FORMATTER_LOG, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), bun: process.env.BUN_BE_BUN, scoped: process.env.FAKE_FORMATTER_SCOPED, inherited: !!process.env.PATH, pid: process.pid }) + "\n")
if (mode === "hang") {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"])
  if (process.env.FAKE_FORMATTER_CHILD) appendFileSync(process.env.FAKE_FORMATTER_CHILD, String(child.pid))
  setInterval(() => {}, 1000)
} else if (mode === "fail" || (mode === "format-fail" && !process.argv.includes("--help"))) {
  console.error("source and secret: should never be exposed")
  process.exit(7)
} else if (process.argv.includes("--help")) {
  console.log(process.env.FAKE_FORMATTER_HELP ?? "Air: An R language server and formatter")
} else {
  const file = process.argv.at(-1)!
  const text = await Bun.file(file).text()
  await Bun.write(file, text.replace(/^\uFEFF/, "").replaceAll("BAD", "GOOD") + (process.env.FAKE_FORMATTER_SUFFIX ?? ""))
}
