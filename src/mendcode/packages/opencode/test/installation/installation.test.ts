import { describe, expect, test } from "bun:test"
import { Effect, Layer, Stream } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { Installation } from "../../src/installation"

const encoder = new TextEncoder()

function mockHttpClient(handler: (request: HttpClientRequest.HttpClientRequest) => Response) {
  const client = HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, handler(request))))
  return Layer.succeed(HttpClient.HttpClient, client)
}

function mockSpawner(handler: (cmd: string, args: readonly string[]) => string = () => "") {
  const spawner = ChildProcessSpawner.make((command) => {
    const std = ChildProcess.isStandardCommand(command) ? command : undefined
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
  test("uses package version for local display labels", () => {
    expect(Installation.displayVersion()).toMatch(/^\d+\.\d+\.\d+$/)
    expect(Installation.labelVersion()).toMatch(/^v\d+\.\d+\.\d+$/)
    expect(Installation.channel()).toBe("local")
  })

  describe("latest", () => {
    test("reads release version from GitHub releases", async () => {
      const layer = testLayer(() => jsonResponse({ tag_name: "v1.2.3" }))

      const result = await Effect.runPromise(
        Installation.Service.use((svc) => svc.latest("unknown")).pipe(Effect.provide(layer)),
      )
      expect(result).toBe("1.2.3")
    })

    test("strips v prefix from GitHub release tag", async () => {
      const layer = testLayer(() => jsonResponse({ tag_name: "v4.0.0-beta.1" }))

      const result = await Effect.runPromise(
        Installation.Service.use((svc) => svc.latest("curl")).pipe(Effect.provide(layer)),
      )
      expect(result).toBe("4.0.0-beta.1")
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
