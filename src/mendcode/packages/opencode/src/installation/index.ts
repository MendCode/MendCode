import { Effect, Layer, Schema, Context, Stream } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { CrossSpawnSpawner } from "@mendcode/core/cross-spawn-spawner"
import { withTransientReadRetry } from "@/util/effect-http-client"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import path from "path"
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "fs"
import { fileURLToPath } from "url"
import { tmpdir } from "os"
import z from "zod"
import { BusEvent } from "@/bus/bus-event"
import { Flag } from "@mendcode/core/flag/flag"
import * as Log from "@mendcode/core/util/log"
import { makeRuntime } from "@mendcode/core/effect/runtime"
import semver from "semver"
import { InstallationChannel, InstallationVersion } from "@mendcode/core/installation/version"
import { which } from "@/util/which"
import { readChannel, selectRelease, type Release } from "./release-channel"
import { updateProgress, type UpdateObserver } from "./progress"
import { verifyReleaseIndex, verifyInstallerBytes } from "./release-index"

const log = Log.create({ service: "installation" })
const GITHUB_REPO = process.env.MENDCODE_GITHUB_REPO ?? "MendCode/MendCode"
const GITHUB_RAW_INSTALL_URL =
  process.env.MENDCODE_INSTALL_URL ?? `https://raw.githubusercontent.com/${GITHUB_REPO}/main/src/mendcode/install`
const GITHUB_LATEST_RELEASE_URL = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`
const PackageVersion = (() => {
  try {
    const packagePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../package.json")
    const data = JSON.parse(readFileSync(packagePath, "utf8")) as { version?: unknown }
    return typeof data.version === "string" && data.version ? data.version : undefined
  } catch {
    return undefined
  }
})()

export type Method = "curl" | "npm" | "yarn" | "pnpm" | "bun" | "brew" | "scoop" | "choco" | "unknown"

export type ReleaseType = "patch" | "minor" | "major"

export const Event = {
  Updated: BusEvent.define(
    "installation.updated",
    Schema.Struct({
      version: Schema.String,
    }),
  ),
  UpdateAvailable: BusEvent.define(
    "installation.update-available",
    Schema.Struct({
      version: Schema.String,
    }),
  ),
}

export function getReleaseType(current: string, latest: string): ReleaseType {
  const currMajor = semver.major(current)
  const currMinor = semver.minor(current)
  const newMajor = semver.major(latest)
  const newMinor = semver.minor(latest)

  if (newMajor > currMajor) return "major"
  if (newMinor > currMinor) return "minor"
  return "patch"
}

export const Info = z
  .object({
    version: z.string(),
    latest: z.string(),
  })
  .meta({
    ref: "InstallationInfo",
  })
export type Info = z.infer<typeof Info>

export const USER_AGENT = `mendcode/${InstallationChannel}/${InstallationVersion}/${Flag.OPENCODE_CLIENT}`

export function isPreview() {
  return InstallationChannel !== "latest"
}

export function isLocal() {
  return InstallationChannel === "local"
}

export function displayVersion() {
  if (isLocal() && PackageVersion) return PackageVersion
  return InstallationVersion
}

export function labelVersion() {
  if (isLocal() && PackageVersion) return `v${PackageVersion}`
  return InstallationVersion === "local" ? "local" : `v${InstallationVersion}`
}

export function channel() {
  return InstallationChannel
}

export class UpgradeFailedError extends Schema.TaggedErrorClass<UpgradeFailedError>()("UpgradeFailedError", {
  stderr: Schema.String,
}) {}

function describeUpgradeFailure(error: unknown) {
  if (typeof error === "string" && error.trim()) return error.trim()
  if (error instanceof Error && error.message.trim()) return error.message.trim()
  if (typeof error === "object" && error !== null) {
    const message = (error as { message?: unknown }).message
    if (typeof message === "string" && message.trim()) return message.trim()
    const reason = (error as { reason?: unknown }).reason
    if (typeof reason === "string" && reason.trim()) return reason.trim()
  }
  return "The updater process failed before it could complete."
}

function installerShell() {
  const configured = process.env.MENDCODE_BASH_PATH?.trim()
  if (configured) return configured

  const candidates = ["/bin/bash", "/usr/bin/bash", "bash"]
  for (const candidate of candidates) {
    if (candidate.startsWith("/") && existsSync(candidate)) return candidate
    const resolved = which(candidate)
    if (resolved) return resolved
  }
  return undefined
}

function installerPowerShell() {
  const configured = process.env.MENDCODE_POWERSHELL_PATH?.trim()
  if (configured) return configured

  for (const candidate of ["pwsh.exe", "powershell.exe", "pwsh", "powershell"]) {
    const resolved = which(candidate)
    if (resolved) return resolved
  }
  return undefined
}

export function usesNativeWindowsUpdater(platform: NodeJS.Platform = process.platform) {
  return platform === "win32"
}

export function windowsUpdaterArgs(scriptPath: string, target: string) {
  return [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    scriptPath,
    "-Version",
    target,
    "-NoModifyPath",
    "-SkipSetup",
  ]
}

// Response schemas for external version APIs
const GitHubRelease = Schema.Struct({
  tag_name: Schema.String,
  draft: Schema.optional(Schema.Boolean),
  prerelease: Schema.optional(Schema.Boolean),
})

export interface Interface {
  readonly info: () => Effect.Effect<Info>
  readonly method: () => Effect.Effect<Method>
  readonly latest: (method?: Method) => Effect.Effect<string>
  readonly upgrade: (method: Method, target: string, observer?: UpdateObserver) => Effect.Effect<void, UpgradeFailedError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Installation") {}

export const layer: Layer.Layer<Service, never, HttpClient.HttpClient | ChildProcessSpawner.ChildProcessSpawner> =
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient
      const httpOk = HttpClient.filterStatusOk(withTransientReadRetry(http))
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

      const text = Effect.fnUntraced(
        function* (cmd: string[], opts?: { cwd?: string; env?: Record<string, string> }) {
          const proc = ChildProcess.make(cmd[0], cmd.slice(1), {
            cwd: opts?.cwd,
            env: opts?.env,
            extendEnv: true,
          })
          const handle = yield* spawner.spawn(proc)
          const out = yield* Stream.mkString(Stream.decodeText(handle.stdout))
          yield* handle.exitCode
          return out
        },
        Effect.scoped,
        Effect.catch(() => Effect.succeed("")),
      )

      const run = Effect.fnUntraced(
        function* (cmd: string[], opts?: { cwd?: string; env?: Record<string, string> }) {
          const proc = ChildProcess.make(cmd[0], cmd.slice(1), {
            cwd: opts?.cwd,
            env: opts?.env,
            extendEnv: true,
          })
          const handle = yield* spawner.spawn(proc)
          const [stdout, stderr] = yield* Effect.all(
            [Stream.mkString(Stream.decodeText(handle.stdout)), Stream.mkString(Stream.decodeText(handle.stderr))],
            { concurrency: 2 },
          )
          const code = yield* handle.exitCode
          return { code, stdout, stderr }
        },
        Effect.scoped,
        Effect.catch(() => Effect.succeed({ code: ChildProcessSpawner.ExitCode(1), stdout: "", stderr: "" })),
      )

      const upgradeCurl = Effect.fnUntraced(
        function* (target: string, observer?: UpdateObserver) {
          const progress = updateProgress(observer)
          progress("MENDCODE_UPDATE_PHASE=checking\n")
          if (!semver.valid(target)) {
            return yield* new UpgradeFailedError({ stderr: "The requested release must be a valid semantic version." })
          }
          const override = usesNativeWindowsUpdater() ? process.env.MENDCODE_INSTALL_PS1_URL : process.env.MENDCODE_INSTALL_URL
          let installerURL = override
          let installerSHA256: string | undefined
          let verifiedSums: string | undefined
          if (!installerURL) {
            const verified = yield* Effect.tryPromise({ try: () => verifyReleaseIndex({ version: target,
              directory: path.join(tmpdir(), "mendcode-release-verification"),
              run: async (command, args, options) => {
                const result = await Effect.runPromise(run([command, ...args]).pipe(Effect.timeout(options.timeoutMs)))
                return { exitCode: Number(result.code) }
              },
              fetch: ((url: string | URL | Request) => Effect.runPromise(Effect.gen(function* () {
                const response = yield* http.execute(HttpClientRequest.get(String(url)).pipe(HttpClientRequest.acceptJson))
                const bytes = yield* response.stream.pipe(Stream.runFold(() => Buffer.alloc(0), (result, chunk) => {
                  if (result.length + chunk.length > 512 * 1024) throw new Error("Release metadata exceeds the size limit")
                  return Buffer.concat([result, chunk])
                }))
                return new Response(bytes, { status: response.status, headers: response.headers })
              }).pipe(Effect.timeout(15_000)))) as typeof fetch,
            }), catch: (error) => new UpgradeFailedError({ stderr: describeUpgradeFailure(error) }) })
            const { Path } = yield* Effect.promise(() => import("@/storage/db"))
            const { assertCompatibility } = yield* Effect.promise(() => import("@/storage/compatibility"))
            yield* Effect.sync(() => assertCompatibility(Path, verified.index.schema.journal))
            installerURL = usesNativeWindowsUpdater() ? verified.windowsInstallerURL : verified.installerURL
            installerSHA256 = usesNativeWindowsUpdater() ? verified.windowsInstallerSHA256 : verified.installerSHA256
            verifiedSums = path.join(path.dirname(verified.file), "verified-sums.txt")
            yield* Effect.sync(() => writeFileSync(verifiedSums!, Object.entries(verified.checksums)
              .map(([name, digest]) => `${digest}  ${name}`).join("\n") + "\n", { mode: 0o600 }))
          }
          if (usesNativeWindowsUpdater()) {
            const response = yield* httpOk.execute(HttpClientRequest.get(installerURL)).pipe(Effect.timeout(15_000))
            const body = yield* response.text
            if (installerSHA256) yield* Effect.sync(() => verifyInstallerBytes(new TextEncoder().encode(body), installerSHA256))
            const powershell = installerPowerShell()
            if (!powershell) {
              return yield* new UpgradeFailedError({
                stderr:
                  "MendCode could not find PowerShell to run the Windows updater. Install PowerShell 7 or enable Windows PowerShell, then retry the upgrade.",
              })
            }

            const scriptPath = path.join(tmpdir(), `mendcode-upgrade-${process.pid}-${Date.now()}.ps1`)
            writeFileSync(scriptPath, body, "utf8")
            try {
              const result = yield* run([powershell, ...windowsUpdaterArgs(scriptPath, target)], {
                env: {
                  MENDCODE_UPDATE_PARENT_PID: String(process.pid),
                  MENDCODE_UPDATE_SCRIPT_PATH: scriptPath,
                  ...(verifiedSums ? { MENDCODE_VERIFIED_SUMS_FILE: verifiedSums } : {}),
                },
              })
              return { ...result, deferred: true as const }
            } finally {
              if (!usesNativeWindowsUpdater()) {
                try {
                  unlinkSync(scriptPath)
                } catch {
                  // Best effort cleanup; the updater has already completed.
                }
              }
            }
          }

          const response = yield* httpOk.execute(HttpClientRequest.get(installerURL)).pipe(Effect.timeout(15_000))
          const body = yield* response.text
          if (installerSHA256) yield* Effect.sync(() => verifyInstallerBytes(new TextEncoder().encode(body), installerSHA256))
          const bash = installerShell()
          if (!bash) {
            return yield* new UpgradeFailedError({
              stderr:
                "MendCode could not find Bash to run the updater. Install Bash (or Git Bash on Windows), then retry the upgrade.",
            })
          }
          const bodyBytes = new TextEncoder().encode(body)
          const proc = ChildProcess.make(bash, ["-s", "--", "--version", target, "--no-modify-path", "--skip-setup"], {
            stdin: Stream.make(bodyBytes),
            env: verifiedSums ? { MENDCODE_VERIFIED_SUMS_FILE: verifiedSums } : undefined,
            extendEnv: true,
          })
          const handle = yield* spawner.spawn(proc)
          const [stdout, stderr] = yield* Effect.all(
            [
              Stream.decodeText(handle.stdout).pipe(
                Stream.tap((chunk) => Effect.sync(() => progress(chunk))),
                Stream.runFold(() => "", (output, chunk) => (output + chunk).slice(-65_536)),
              ),
              Stream.decodeText(handle.stderr).pipe(
                Stream.runFold(() => "", (output, chunk) => (output + chunk).slice(-65_536)),
              ),
            ],
            { concurrency: 2 },
          )
          const code = yield* handle.exitCode
          return { code, stdout, stderr }
        },
        Effect.timeout(930_000),
        Effect.scoped,
        Effect.catchTag("TimeoutError", () => Effect.fail(new UpgradeFailedError({
          stderr: "The updater timed out. Check the download connection and retry; inspect the installed version before starting another update.",
        }))),
        Effect.catchDefect((defect) => Effect.fail(new UpgradeFailedError({ stderr: describeUpgradeFailure(defect) }))),
        Effect.mapError((error) =>
          error instanceof UpgradeFailedError
            ? error
            : new UpgradeFailedError({ stderr: describeUpgradeFailure(error) }),
        ),
      )

      const result: Interface = {
        info: Effect.fn("Installation.info")(function* () {
          return {
            version: InstallationVersion,
            latest: yield* result.latest(),
          }
        }),
        method: Effect.fn("Installation.method")(function* () {
          if (process.execPath.includes(path.join(".mendcode", "bin"))) return "curl" as Method
          if (process.execPath.includes(path.join(".local", "bin"))) return "curl" as Method
          const exec = process.execPath.toLowerCase()

          const checks: Array<{ name: Method; command: () => Effect.Effect<string> }> = [
            { name: "npm", command: () => text(["npm", "list", "-g", "--depth=0"]) },
            { name: "yarn", command: () => text(["yarn", "global", "list"]) },
            { name: "pnpm", command: () => text(["pnpm", "list", "-g", "--depth=0"]) },
            { name: "bun", command: () => text(["bun", "pm", "ls", "-g"]) },
            { name: "brew", command: () => text(["brew", "list", "--formula", "mendcode"]) },
            { name: "scoop", command: () => text(["scoop", "list", "mendcode"]) },
            { name: "choco", command: () => text(["choco", "list", "--limit-output", "mendcode"]) },
          ]

          checks.sort((a, b) => {
            const aMatches = exec.includes(a.name)
            const bMatches = exec.includes(b.name)
            if (aMatches && !bMatches) return -1
            if (!aMatches && bMatches) return 1
            return 0
          })

          for (const check of checks) {
            const output = yield* check.command()
            if (output.includes("mendcode")) {
              return check.name
            }
          }

          return "unknown" as Method
        }),
        latest: Effect.fn("Installation.latest")(function* (_installMethod?: Method) {
          const channel = yield* Effect.tryPromise(readChannel)
          if (channel === "stable") {
            const response = yield* httpOk.execute(
              HttpClientRequest.get(GITHUB_LATEST_RELEASE_URL).pipe(HttpClientRequest.acceptJson),
            ).pipe(Effect.timeout(15_000))
            const data = yield* HttpClientResponse.schemaBodyJson(GitHubRelease)(response)
            const version = selectRelease([data], channel)
            if (!version) throw new Error("GitHub did not return a valid stable release")
            return version
          }
          // GitHub orders publication dates, not semantic versions: inspect all bounded pages.
          const releases: Release[] = []
          for (let page = 1; page <= 10; page++) {
            const response = yield* httpOk.execute(HttpClientRequest.get(
              `https://api.github.com/repos/${GITHUB_REPO}/releases?per_page=100&page=${page}`,
            ).pipe(HttpClientRequest.acceptJson)).pipe(Effect.timeout(15_000))
            const data = yield* HttpClientResponse.schemaBodyJson(Schema.Array(GitHubRelease))(response)
            releases.push(...data)
            if (data.length < 100) {
              const version = selectRelease(releases, channel)
              if (version) return version
              break
            }
            if (page === 10) throw new Error("Release discovery exceeded its history limit; specify an exact version.")
          }
          throw new Error(`No published ${channel} release is available`)
        }, Effect.orDie),
        upgrade: Effect.fn("Installation.upgrade")(function* (m: Method, target: string, observer?: UpdateObserver) {
          let upgradeResult:
            | { code: ChildProcessSpawner.ExitCode; stdout: string; stderr: string; deferred?: boolean }
            | undefined
          switch (m) {
            case "curl":
              upgradeResult = yield* upgradeCurl(target, observer)
              break
            case "npm":
            case "pnpm":
            case "bun":
            case "brew":
            case "choco":
            case "scoop":
              return yield* new UpgradeFailedError({
                stderr: `MendCode ${m} upgrades are not published yet. Reinstall from GitHub with: curl -fsSL ${GITHUB_RAW_INSTALL_URL} | bash -s -- --version ${target}`,
              })
            default:
              return yield* new UpgradeFailedError({ stderr: `Unknown method: ${m}` })
          }
          if (!upgradeResult || upgradeResult.code !== 0) {
            const details = [upgradeResult?.stderr, upgradeResult?.stdout]
              .map((value) => value?.trim())
              .filter((value): value is string => Boolean(value))
              .join("\n")
            return yield* new UpgradeFailedError({
              stderr: details || "The updater exited before installing the requested version.",
            })
          }
          log.info("upgraded", {
            method: m,
            target,
            stdout: upgradeResult.stdout,
            stderr: upgradeResult.stderr,
          })
          if (upgradeResult.deferred) return
          const installedVersion = (yield* text([process.execPath, "--version"]).pipe(
            Effect.timeout(30_000),
            Effect.catchTag("TimeoutError", () => Effect.fail(new UpgradeFailedError({
              stderr: "The installed binary did not answer within 30 seconds. Restart MendCode or recover the previous version before retrying.",
            }))),
          )).trim()
          if (installedVersion !== target) {
            return yield* new UpgradeFailedError({
              stderr: `MendCode upgrade did not install the requested version. Expected ${target}, found ${installedVersion || "unknown"}. Restart the current process and retry.`,
            })
          }
        }),
      }

      return Service.of(result)
    }),
  )

export const defaultLayer = layer.pipe(
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(CrossSpawnSpawner.defaultLayer),
)

const { runPromise } = makeRuntime(Service, defaultLayer)

export const latest = (...args: Parameters<Interface["latest"]>) => runPromise((s) => s.latest(...args))
export const method = () => runPromise((s) => s.method())
export const upgrade = (...args: Parameters<Interface["upgrade"]>) => runPromise((s) => s.upgrade(...args))

export * as Installation from "."
