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
const encodePowerShell = (source: string) => Buffer.from(source, "utf16le").toString("base64")
const spawnPowerShell = (source: string, env: Record<string, string | undefined> = {}) =>
  Bun.spawn(["powershell.exe", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShell(source)], {
    env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe",
  })
async function powershell(source: string, env: Record<string, string | undefined> = {}) {
  const child = spawnPowerShell(source, env)
  const timer = setTimeout(() => child.kill(), 90_000)
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    return { code, output: stdout + stderr }
  } finally { clearTimeout(timer) }
}
async function waitForFile(file: string, diagnostic?: string, timeout = 10_000) {
  const deadline = Date.now() + timeout
  while (!(await Bun.file(file).exists()) && Date.now() < deadline) await Bun.sleep(25)
  if (diagnostic && (await Bun.file(diagnostic).exists())) throw new Error(await fs.readFile(diagnostic, "utf8"))
  assert.equal(await Bun.file(file).exists(), true, `Timed out waiting for ${file}`)
}
async function waitForActivation(directory: string, release: string) {
  const deadline = Date.now() + 90_000
  while (!(await Bun.file(release).exists()) && Date.now() < deadline) {
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith(".update.")) continue
      const status = await fs.readFile(path.join(directory, entry.name, "status"), "utf8").catch(() => "")
      if (!status.includes("phase=activating")) continue
      await Bun.sleep(500)
      await fs.writeFile(release, "release")
      return
    }
    await Bun.sleep(25)
  }
  if (await Bun.file(release).exists()) return
  throw new Error(`Timed out waiting for installer activation in ${directory}`)
}
const archive = path.join(root, "candidate.zip")
const installer = path.resolve(import.meta.dir, "../install.ps1")
const parsed = await powershell(`$tokens=$null; $errors=$null; [void][System.Management.Automation.Language.Parser]::ParseFile(${quote(installer)}, [ref]$tokens, [ref]$errors); if ($errors.Count) { $errors | Out-String | Write-Error; exit 1 }`)
assert.equal(parsed.code, 0, parsed.output)
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
  for (scenario of ["success", "transient-lock", "checksum-failure", "http-failure", "truncated"]) {
    const expectSuccess = scenario === "success" || scenario === "transient-lock"
    const home = path.join(root, scenario)
    const installed = path.join(home, ".mendcode", "bin", "mendcode.exe")
    await fs.mkdir(path.dirname(installed), { recursive: true })
    // An unusable existing executable must not be run to perform recovery.
    await fs.writeFile(installed, "previous damaged executable")
    const previousDigest = digest(await Bun.file(installed).bytes())
    const lockReady = path.join(home, "lock-ready")
    const lockDiagnostic = path.join(home, "lock-diagnostic")
    const lockProcess =
      scenario === "transient-lock"
        ? spawnPowerShell(`
$installed = ${quote(installed)}
$ready = ${quote(lockReady)}
$release = ${quote(path.join(home, "lock-release"))}
$diagnostic = ${quote(lockDiagnostic)}
$stream = $null
try {
  $stream = [IO.File]::Open($installed, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  [IO.File]::WriteAllText($ready, "ready")
  $deadline = [DateTime]::UtcNow.AddSeconds(90)
  while (-not [IO.File]::Exists($release) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 25 }
  if (-not [IO.File]::Exists($release)) { throw "Did not receive the transient installer lock release." }
} catch {
  [IO.File]::WriteAllText($diagnostic, ($_ | Out-String))
  exit 1
} finally {
  if ($null -ne $stream) { $stream.Dispose() }
}
`)
        : undefined
    const result = await (async () => {
      try {
        if (lockProcess) {
          await waitForFile(lockReady, lockDiagnostic, 90_000)
          const activation = waitForActivation(path.dirname(installed), path.join(home, "lock-release"))
          try {
            return await powershell(`& ${quote(installer)} -Version ${quote(version)} -SkipSetup -NoModifyPath; exit $LASTEXITCODE`, {
              OPENCODE_TEST_HOME: home, MENDCODE_GITHUB_BASE_URL: server.url.toString().replace(/\/$/, ""),
              MENDCODE_UPDATE_PARENT_PID: undefined, MENDCODE_VERIFIED_SUMS_FILE: undefined,
              MENDCODE_DB: path.join(home, "data", "test.db"),
            })
          } finally {
            await fs.writeFile(path.join(home, "lock-release"), "release")
            await activation
          }
        }
        return await powershell(`& ${quote(installer)} -Version ${quote(version)} -SkipSetup -NoModifyPath; exit $LASTEXITCODE`, {
          OPENCODE_TEST_HOME: home, MENDCODE_GITHUB_BASE_URL: server.url.toString().replace(/\/$/, ""),
          MENDCODE_UPDATE_PARENT_PID: undefined, MENDCODE_VERIFIED_SUMS_FILE: undefined,
          MENDCODE_DB: path.join(home, "data", "test.db"),
        })
      } finally {
        if (lockProcess) {
          lockProcess.kill()
          await lockProcess.exited
        }
      }
    })()
    await fs.writeFile(path.join(home, "installer.log"), result.output)
    if (expectSuccess) assert.equal(result.code, 0, result.output)
    if (scenario === "transient-lock") assert.match(result.output, /temporarily locked; retrying/i)
    const operations = (await fs.readdir(path.dirname(installed))).filter((name) => name.startsWith(".update."))
    assert.equal(operations.length, 1, `${scenario}: ${result.output}`)
    const operation = path.join(path.dirname(installed), operations[0])
    const status = await fs.readFile(path.join(operation, "status"), "utf8")
    if (expectSuccess) {
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
