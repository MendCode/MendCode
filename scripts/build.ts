import path from "node:path"
import { mkdirSync } from "node:fs"
import { computeBuildId } from "../packages/build-id/src"

export const TARGETS = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "windows-x64"] as const

const root = path.join(import.meta.dir, "..")
const args = process.argv.slice(2)
const value = (name: string) => {
  const index = args.indexOf(`--${name}`)
  return index < 0 ? undefined : args[index + 1]
}
const target = value("target")?.replace(/^bun-/, "")
if (target && !(TARGETS as readonly string[]).includes(target)) throw new Error(`unsupported target: ${target}`)
for (let i = 0; i < args.length; i += 2) {
  if (!["--target", "--outfile", "--exec-argv"].includes(args[i]!) || !args[i + 1] || (args[i]! !== "--exec-argv" && args[i + 1]!.startsWith("--"))) throw new Error("usage: bun run build [--target darwin-arm64|darwin-x64|linux-x64|linux-arm64|windows-x64] [--outfile PATH] [--exec-argv RUNTIME_FLAGS]")
}
/** Runtime flags baked into the binary (`bun build --compile-exec-argv`), for memory experiments such as `--smol` (docs/performance.md). Nothing by default. */
const execArgv = value("exec-argv")
const windows = target ? target === "windows-x64" : process.platform === "win32"
const outfile = path.resolve(value("outfile") ?? path.join(root, "dist", `mendcode${windows ? ".exe" : ""}`))
mkdirSync(path.dirname(outfile), { recursive: true })
const child = Bun.spawn([
  // --splitting: the daemon, the pages and every other lazily imported module stay separate chunks inside the executable and are read and parsed
  // only when something imports them. One bundle made every process carry the whole program: a terminal that only attaches to a daemon was 22 MB
  // larger and the daemon 10 MB (docs/performance.md).
  process.execPath, "build", "--compile", "--splitting", "--minify", "--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig",
  "--define", `MENDCODE_COMPILED_BUILD_ID=${JSON.stringify(computeBuildId(process.env, "release"))}`,
  ...(execArgv ? [`--compile-exec-argv=${execArgv}`] : []),
  ...(target ? [`--target=bun-${target}`] : []),
  path.join(root, "apps/cli/src/entry.ts"), "--outfile", outfile,
], { cwd: path.dirname(outfile), stdout: "inherit", stderr: "inherit" })
const code = await child.exited
if (code !== 0) process.exit(code)
// Bun 1.3 can leave a stale ad-hoc Mach-O signature after appending the bundle.
if (process.platform === "darwin" && (!target || target.startsWith("darwin-"))) {
  const signing = Bun.spawn(["/usr/bin/codesign", "--force", "--sign", "-", outfile], { stdout: "inherit", stderr: "inherit" })
  process.exit(await signing.exited)
}
