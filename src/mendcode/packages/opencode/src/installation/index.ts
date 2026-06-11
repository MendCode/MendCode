import { Effect, Layer, Schema, Context, Stream } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { CrossSpawnSpawner } from "@mendcode/core/cross-spawn-spawner"
import { withTransientReadRetry } from "@/util/effect-http-client"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import path from "path"
import z from "zod"
import { BusEvent } from "@/bus/bus-event"
import { Flag } from "@mendcode/core/flag/flag"
import * as Log from "@mendcode/core/util/log"
import { makeRuntime } from "@mendcode/core/effect/runtime"
import semver from "semver"
import { InstallationChannel, InstallationVersion } from "@mendcode/core/installation/version"

const log = Log.create({ service: "installation" })
const GITHUB_REPO = process.env.MENDCODE_GITHUB_REPO ?? "MendCode/MendCode"
const GITHUB_RAW_INSTALL_URL =
  process.env.MENDCODE_INSTALL_URL ?? `https://raw.githubusercontent.com/${GITHUB_REPO}/main/src/mendcode/install`
const GITHUB_LATEST_RELEASE_URL = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`

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

export class UpgradeFailedError extends Schema.TaggedErrorClass<UpgradeFailedError>()("UpgradeFailedError", {
  stderr: Schema.String,
}) {}

// Response schemas for external version APIs
const GitHubRelease = Schema.Struct({ tag_name: Schema.String })

export interface Interface {
  readonly info: () => Effect.Effect<Info>
  readonly method: () => Effect.Effect<Method>
  readonly latest: (method?: Method) => Effect.Effect<string>
  readonly upgrade: (method: Method, target: string) => Effect.Effect<void, UpgradeFailedError>
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
        function* (target: string) {
          const response = yield* httpOk.execute(HttpClientRequest.get(GITHUB_RAW_INSTALL_URL))
          const body = yield* response.text
          const bodyBytes = new TextEncoder().encode(body)
          const proc = ChildProcess.make("bash", [], {
            stdin: Stream.make(bodyBytes),
            env: { VERSION: target },
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
        Effect.orDie,
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
          const response = yield* httpOk.execute(
            HttpClientRequest.get(GITHUB_LATEST_RELEASE_URL).pipe(HttpClientRequest.acceptJson),
          )
          const data = yield* HttpClientResponse.schemaBodyJson(GitHubRelease)(response)
          return data.tag_name.replace(/^v/, "")
        }, Effect.orDie),
        upgrade: Effect.fn("Installation.upgrade")(function* (m: Method, target: string) {
          let upgradeResult: { code: ChildProcessSpawner.ExitCode; stdout: string; stderr: string } | undefined
          switch (m) {
            case "curl":
              upgradeResult = yield* upgradeCurl(target)
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
            return yield* new UpgradeFailedError({ stderr: upgradeResult?.stderr || "" })
          }
          log.info("upgraded", {
            method: m,
            target,
            stdout: upgradeResult.stdout,
            stderr: upgradeResult.stderr,
          })
          yield* text([process.execPath, "--version"])
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
