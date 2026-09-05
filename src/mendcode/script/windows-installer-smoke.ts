import { strict as assert } from "node:assert"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createHash } from "node:crypto"

if (process.platform !== "win32") throw new Error("This acceptance check requires native Windows")
const binary = process.env.MENDCODE_INSTALLER_TEST_BINARY
const version = process.env.MENDCODE_VERSION
if (!binary || !version) throw new Error("Provide MENDCODE_INSTALLER_TEST_BINARY and MENDCODE_VERSION")
const root = await fs.mkdtemp(path.join(os.tmpdir(), "mendcode-windows-installer-"))
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`
async function powershell(source: string, env: Record<string, string | undefined> = {}) {
  const child = Bun.spawn(["powershell.exe", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(source, "utf16le").toString("base64")], {
    env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe",
  })
  const timer = setTimeout(() => child.kill(), 90_000)
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    return { code, output: stdout + stderr }
  } finally { clearTimeout(timer) }
}
const archive = path.join(root, "candidate.zip")
const compressed = await powershell(`$ErrorActionPreference='Stop'; Compress-Archive -LiteralPath ${quote(path.resolve(binary))} -DestinationPath ${quote(archive)}`)
assert.equal(compressed.code, 0, compressed.output)
const bytes = await Bun.file(archive).bytes()
const binaryDigest = digest(await Bun.file(binary).bytes())
let scenario = "success"
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
  const url = new URL(request.url)
  if (scenario === "http-failure") return new Response("Fixture unavailable", { status: 503 })
  if (url.pathname.endsWith("/SHA256SUMS")) {
    const hash = scenario === "checksum-failure" ? "0".repeat(64) : digest(bytes)
    return new Response(["windows-x64", "windows-x64-baseline", "windows-arm64"].map((target) => `${hash}  mendcode-${target}.zip`).join("\n"))
  }
  if (url.pathname.endsWith(".zip")) return new Response(scenario === "truncated" ? bytes.slice(0, 100) : bytes)
  return new Response("Not found", { status: 404 })
} })
try {
  for (scenario of ["success", "checksum-failure", "http-failure", "truncated"]) {
    const home = path.join(root, scenario)
    const installed = path.join(home, ".mendcode", "bin", "mendcode.exe")
    await fs.mkdir(path.dirname(installed), { recursive: true })
    // An unusable existing executable must not be run to perform recovery.
    await fs.writeFile(installed, "previous damaged executable")
    const previousDigest = digest(await Bun.file(installed).bytes())
    const result = await powershell(`& ${quote(path.resolve(import.meta.dir, "../install.ps1"))} -Version ${quote(version)} -SkipSetup -NoModifyPath; exit $LASTEXITCODE`, {
      OPENCODE_TEST_HOME: home, MENDCODE_GITHUB_BASE_URL: server.url.toString().replace(/\/$/, ""),
      MENDCODE_UPDATE_PARENT_PID: undefined, MENDCODE_VERIFIED_SUMS_FILE: undefined,
      MENDCODE_DB: path.join(home, "data", "test.db"),
    })
    await fs.writeFile(path.join(home, "installer.log"), result.output)
    const operations = (await fs.readdir(path.dirname(installed))).filter((name) => name.startsWith(".update."))
    assert.equal(operations.length, 1)
    const operation = path.join(path.dirname(installed), operations[0])
    const status = await fs.readFile(path.join(operation, "status"), "utf8")
    if (scenario === "success") {
      assert.equal(result.code, 0, result.output)
      assert.equal(digest(await Bun.file(installed).bytes()), binaryDigest)
      assert.equal(digest(await Bun.file(path.join(operation, "previous")).bytes()), previousDigest)
      assert.match(status, /phase=activated\n/)
      assert.match(status, new RegExp(`binary_sha256=${binaryDigest}\\n`))
    } else {
      assert.notEqual(result.code, 0, result.output)
      assert.equal(digest(await Bun.file(installed).bytes()), previousDigest)
      assert.match(status, /phase=failed\n/)
    }
    assert.equal(await Bun.file(path.join(home, "data", "test.db")).exists(), false)
    console.log(`PASS Windows installer: ${scenario}`)
  }
} finally { server.stop(true) }
console.log(`Evidence retained at ${root}; backend/TUI and deferred-replacement checks remain separate gates.`)
