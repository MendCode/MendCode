import { describe, expect, test } from "bun:test"
import { Effect, Layer, PlatformError, Stream } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { Installation } from "../../src/installation"
import { writeChannel } from "../../src/installation/release-channel"
import { createHash } from "node:crypto"
import { supportedMigrationJournal } from "../../src/storage/migration-journal"

const encoder = new TextEncoder()

function mockHttpClient(handler: (request: HttpClientRequest.HttpClientRequest) => Response) {
  const client = HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, handler(request))))
  return Layer.succeed(HttpClient.HttpClient, client)
}

function installerResponse(request: HttpClientRequest.HttpClientRequest) {
  if (request.url.includes("/commits/")) return jsonResponse({ sha: "a".repeat(40) })
  if (request.url.endsWith("/release-index.json")) {
    const version = /\/download\/v([^/]+)\//.exec(request.url)![1]
    const journal = supportedMigrationJournal()
    const hash = (text: string) => createHash("sha256").update(text).digest("hex")
    return jsonResponse({ formatVersion: 1, version, channel: "stable", tag: `v${version}`,
      commit: "a".repeat(40), repository: "MendCode/MendCode", provenance: { workflow: ".github/workflows/release.yml", runID: "1" },
      installer: { path: "src/mendcode/install", commit: "a".repeat(40), sha256: hash("#!/usr/bin/env bash\n") },
      windowsInstaller: { path: "src/mendcode/install.ps1", commit: "a".repeat(40), sha256: hash("#!/usr/bin/env bash\n") },
      schema: { journal, fingerprint: hash(JSON.stringify(journal)) },
      assets: [{ name: "mendcode-darwin-arm64.zip", platform: "darwin-arm64", size: 1, sha256: "b".repeat(64) }],
    })
  }
  return new Response("#!/usr/bin/env bash\n")
}

function mockSpawner(handler: (cmd: string, args: readonly string[]) => string = () => "", spawnError?: Error) {
  const spawner = ChildProcessSpawner.make((command) => {
    const std = ChildProcess.isStandardCommand(command) ? command : undefined
    if (spawnError && std?.command !== "gh") {
      return Effect.fail(
        PlatformError.systemError({
          _tag: "NotFound",
          module: "ChildProcess",
          method: "spawn",
          description: spawnError.message,
          cause: spawnError,
        }),
      )
    }
    const output = handler(std?.command ?? "", std?.args ?? [])
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(0),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: { [Symbol.for("effect/Sink/TypeId")]: Symbol.for("effect/Sink/TypeId") } as any,
        stdout: output ? Stream.make(encoder.encode(output)) : Stream.empty,
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => ({ [Symbol.for("effect/Sink/TypeId")]: Symbol.for("effect/Sink/TypeId") }) as any,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      }),
    )
  })
  return Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}

function testLayer(
  httpHandler: (request: HttpClientRequest.HttpClientRequest) => Response,
  spawnHandler?: (cmd: string, args: readonly string[]) => string,
) {
  return Installation.layer.pipe(Layer.provide(mockHttpClient(httpHandler)), Layer.provide(mockSpawner(spawnHandler)))
}

describe("installation", () => {
  test("selects the native updater on Windows instead of the WSL bash launcher", () => {
    expect(Installation.usesNativeWindowsUpdater("win32")).toBe(true)
    expect(Installation.usesNativeWindowsUpdater("darwin")).toBe(false)
    expect(Installation.windowsUpdaterArgs("C:\\Temp\\mendcode-upgrade.ps1", "0.1.39")).toEqual([
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      "C:\\Temp\\mendcode-upgrade.ps1",
      "-Version",
      "0.1.39",
      "-NoModifyPath",
      "-SkipSetup",
    ])
  })

  test("uses package version for local display labels", () => {
    expect(Installation.displayVersion()).toMatch(/^\d+\.\d+\.\d+$/)
    expect(Installation.labelVersion()).toMatch(/^v\d+\.\d+\.\d+$/)
    expect(Installation.channel()).toBe("local")
  })

  describe("latest", () => {
    test("selects the highest channel version across publication-order pages", async () => {
      await writeChannel("beta")
      try {
        const layer = testLayer((request) => jsonResponse(request.url.endsWith("page=1")
          ? Array.from({ length: 100 }, (_, i) => ({ tag_name: i === 0 ? "v0.1.44-beta.1" : "v0.1.43", prerelease: i === 0 }))
          : [{ tag_name: "v0.1.44-beta.3", prerelease: true }]))
        const result = await Effect.runPromise(Installation.Service.use((svc) => svc.latest("curl")).pipe(Effect.provide(layer)))
        expect(result).toBe("0.1.44-beta.3")
      } finally { await writeChannel("stable") }
    })
    test("reads release version from GitHub releases", async () => {
      const layer = testLayer(() => jsonResponse({ tag_name: "v1.2.3" }))

      const result = await Effect.runPromise(
        Installation.Service.use((svc) => svc.latest("unknown")).pipe(Effect.provide(layer)),
      )
      expect(result).toBe("1.2.3")
    })

    test("strips v prefix from stable GitHub release tag", async () => {
      const layer = testLayer(() => jsonResponse({ tag_name: "v4.0.0" }))

      const result = await Effect.runPromise(
        Installation.Service.use((svc) => svc.latest("curl")).pipe(Effect.provide(layer)),
      )
      expect(result).toBe("4.0.0")
    })

    test.each(["npm", "bun", "pnpm", "scoop", "choco", "brew"] as const)(
      "reads %s latest version from GitHub releases while registries are unpublished",
      async (method) => {
        const calls: string[] = []
        const layer = testLayer((request) => {
          calls.push(request.url)
          return jsonResponse({ tag_name: "v1.5.0" })
        })

        const result = await Effect.runPromise(
          Installation.Service.use((svc) => svc.latest(method)).pipe(Effect.provide(layer)),
        )
        expect(result).toBe("1.5.0")
        expect(calls).toEqual(["https://api.github.com/repos/MendCode/MendCode/releases/latest"])
      },
    )
  })

  describe("upgrade", () => {
    test("delivers installer phases to the caller while consuming output", async () => {
      const phases: string[] = []
      const layer = testLayer(installerResponse, (cmd, args) =>
        cmd === process.execPath && args[0] === "--version"
          ? "0.1.25"
          : "MENDCODE_UPDATE_PHASE=downloading\nMENDCODE_UPDATE_PHASE=verifying\n",
      )
      await Effect.runPromise(Installation.Service.use((svc) => svc.upgrade("curl", "0.1.25", (phase) => phases.push(phase)))
        .pipe(Effect.provide(layer)))
      expect(phases).toEqual(["checking", "downloading", "verifying"])
    })

    test("resolves a release to an immutable installer revision before spawning", async () => {
      const urls: string[] = []
      const layer = testLayer((request) => {
        urls.push(request.url)
        return installerResponse(request)
      }, (cmd, args) => cmd === process.execPath && args[0] === "--version" ? "0.1.25" : "")
      await Effect.runPromise(Installation.Service.use((svc) => svc.upgrade("curl", "0.1.25")).pipe(Effect.provide(layer)))
      expect(urls).toEqual([
        "https://github.com/MendCode/MendCode/releases/download/v0.1.25/release-index.json",
        "https://api.github.com/repos/MendCode/MendCode/commits/v0.1.25",
        `https://raw.githubusercontent.com/MendCode/MendCode/${"a".repeat(40)}/src/mendcode/install`,
      ])
    })

    test("rejects an invalid release revision without running an installer", async () => {
      let spawned = false
      const layer = testLayer((request) => request.url.includes("/commits/") ? jsonResponse({ sha: "main" }) : installerResponse(request), (cmd) => { if (cmd !== "gh") spawned = true; return "" })
      await expect(Effect.runPromise(Installation.Service.use((svc) => svc.upgrade("curl", "0.1.25")).pipe(Effect.provide(layer))))
        .rejects.toMatchObject({ stderr: expect.any(String) })
      expect(spawned).toBe(false)
    })

    test("runs curl upgrades without opening setup inside the active TUI", async () => {
      const calls: Array<{ cmd: string; args: readonly string[] }> = []
      const layer = testLayer(
        installerResponse,
        (cmd, args) => {
          calls.push({ cmd, args })
          if (cmd === process.execPath && args.length === 1 && args[0] === "--version") return "0.1.25"
          return ""
        },
      )

      await Effect.runPromise(
        Installation.Service.use((svc) => svc.upgrade("curl", "0.1.25")).pipe(Effect.provide(layer)),
      )

      expect(calls.find((call) => /(?:^|[\\/])bash(?:\.exe)?$/.test(call.cmd))).toEqual({
        cmd: expect.stringMatching(/(?:^|[\\/])bash(?:\.exe)?$/),
        args: ["-s", "--", "--version", "0.1.25", "--no-modify-path", "--skip-setup"],
      })
    })

    test("turns a missing updater process into an actionable error", async () => {
      const layer = Installation.layer.pipe(
        Layer.provide(mockHttpClient(installerResponse)),
        Layer.provide(mockSpawner(() => "", new Error("spawn bash ENOENT"))),
      )

      let error: any
      try {
        await Effect.runPromise(
          Installation.Service.use((svc) => svc.upgrade("curl", "0.1.25")).pipe(Effect.provide(layer)),
        )
      } catch (err) {
        error = err
      }

      expect(error).toBeInstanceOf(Installation.UpgradeFailedError)
      expect(error?.stderr).toContain("spawn bash ENOENT")
    })

    test("rejects an upgrade when the installed binary reports another version", async () => {
      const layer = testLayer(
        installerResponse,
        (cmd, args) => (cmd === process.execPath && args.length === 1 && args[0] === "--version" ? "0.1.24" : ""),
      )

      let error: any
      try {
        await Effect.runPromise(
          Installation.Service.use((svc) => svc.upgrade("curl", "0.1.25")).pipe(Effect.provide(layer)),
        )
      } catch (err) {
        error = err
      }

      expect(error).toBeInstanceOf(Installation.UpgradeFailedError)
      expect(error?.stderr).toContain("Expected 0.1.25, found 0.1.24")
    })

    test("blocks registry upgrades until MendCode-owned registries exist", async () => {
      const calls: string[] = []
      const layer = testLayer((request) => {
        calls.push(request.url)
        return jsonResponse({ tag_name: "v1.5.0" })
      })

      let error: any
      try {
        await Effect.runPromise(
          Installation.Service.use((svc) => svc.upgrade("npm", "1.5.0")).pipe(Effect.provide(layer)),
        )
      } catch (err) {
        error = err
      }

      expect(error?.stderr).toContain("Reinstall from GitHub")
      expect(calls).toEqual([])
    })
  })
})
