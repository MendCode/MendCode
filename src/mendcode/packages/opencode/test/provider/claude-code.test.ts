import { test, expect } from "bun:test"
import path from "path"
import { chmod, mkdir } from "fs/promises"
import { Effect } from "effect"

import { Auth } from "@/auth"
import { ProviderAuth } from "@/provider/auth"
import { Provider } from "@/provider/provider"
import { ClaudeCode } from "@/provider/claude-code"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { AppRuntime } from "../../src/effect/app-runtime"
import { WithInstance } from "../../src/project/with-instance"
import { tmpdir } from "../fixture/fixture"

async function fakeClaude(dir: string, options: { loggedIn?: boolean } = {}) {
  const bin = path.join(dir, "bin", "claude")
  await mkdir(path.dirname(bin), { recursive: true })
  const loggedIn = options.loggedIn ?? true
  await Bun.write(
    bin,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'if [[ "${1:-}" == "--version" ]]; then',
      '  echo "2.1.167 (Claude Code)"',
      "  exit 0",
      "fi",
      'if [[ "${1:-}" == "auth" && "${2:-}" == "status" ]]; then',
      loggedIn
        ? '  echo \'{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","email":"test@example.com","subscriptionType":"max"}\''
        : '  echo \'{"loggedIn":false}\'',
      "  exit 0",
      "fi",
      "cat >/dev/null",
      'echo \'{"type":"assistant","message":{"content":[{"type":"text","text":"hello from fake claude"}]}}\'',
      'echo \'{"type":"result","subtype":"success","usage":{"input_tokens":3,"output_tokens":4}}\'',
      "",
    ].join("\n"),
  )
  await chmod(bin, 0o755)
  return bin
}

function run<A, E>(fn: () => Effect.Effect<A, E, any>) {
  return AppRuntime.runPromise(fn())
}

test("Claude Code does not autoconnect without stored auth", async () => {
  await using tmp = await tmpdir({ config: {} })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const providers = await run(() =>
        Provider.Service.use((provider) => provider.list()),
      )
      expect(providers[ClaudeCode.ID]).toBeUndefined()
    },
  })
})

test("Claude Code auth method auto-probes without prompting for binary path", async () => {
  await using binary = await tmpdir({
    init: async (dir) => fakeClaude(dir),
  })
  await using tmp = await tmpdir({
    config: {
      provider: {
        "claude-code": {
          options: {
            binaryPath: binary.extra,
          },
        },
      },
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const result = await run(() =>
        Effect.gen(function* () {
          const auth = yield* ProviderAuth.Service
          const methods = yield* auth.methods()
          const claude = methods[ClaudeCode.ID]
          expect(claude).toBeDefined()
          expect(claude[0].prompts).toBeUndefined()

          const authorization = yield* auth.authorize({
            providerID: ClaudeCode.ID,
            method: 0,
          })
          expect(authorization?.method).toBe("auto")
          yield* auth.callback({
            providerID: ClaudeCode.ID,
            method: 0,
          })

          const provider = yield* Provider.Service
          return yield* provider.list()
        }),
      )

      expect(result[ClaudeCode.ID]).toBeDefined()
    },
  })
})

test("Claude Code auth method does not connect when CLI is not authenticated", async () => {
  await using binary = await tmpdir({
    init: async (dir) => fakeClaude(dir, { loggedIn: false }),
  })
  await using tmp = await tmpdir({
    config: {
      provider: {
        "claude-code": {
          options: {
            binaryPath: binary.extra,
          },
        },
      },
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const result = await run(() =>
        Effect.gen(function* () {
          const auth = yield* ProviderAuth.Service
          yield* auth.authorize({
            providerID: ClaudeCode.ID,
            method: 0,
          })
          const callback = yield* auth
            .callback({
              providerID: ClaudeCode.ID,
              method: 0,
            })
            .pipe(Effect.flip)

          const provider = yield* Provider.Service
          const providers = yield* provider.list()
          return { callback, providers }
        }),
      )

      const validation = result.callback as { data: { message: string } }
      expect(validation.data.message).toContain("not authenticated")
      expect(result.providers[ClaudeCode.ID]).toBeUndefined()
    },
  })
})

test("Claude Code auth method reports missing CLI without throwing", async () => {
  await using tmp = await tmpdir({
    config: {
      provider: {
        "claude-code": {
          options: {
            binaryPath: path.join("/tmp", `missing-claude-${Date.now()}`),
          },
        },
      },
    },
  })
  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const result = await run(() =>
        Effect.gen(function* () {
          const auth = yield* ProviderAuth.Service
          const callback = yield* auth
            .callback({
              providerID: ClaudeCode.ID,
              method: 0,
            })
            .pipe(Effect.flip)

          const provider = yield* Provider.Service
          const providers = yield* provider.list()
          return { callback, providers }
        }),
      )

      const validation = result.callback as { data: { message: string } }
      expect(validation.data.message).toContain("missing-claude")
      expect(result.providers[ClaudeCode.ID]).toBeUndefined()
    },
  })
})

test("Claude Code connects from validated local auth metadata", async () => {
  await using tmp = await tmpdir({
    config: {},
    init: async (dir) => fakeClaude(dir),
  })

  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const bin = tmp.extra
      const providers = await run(() =>
        Effect.gen(function* () {
          const auth = yield* Auth.Service
          yield* auth.set(ClaudeCode.ID, {
            type: "api",
            key: ClaudeCode.AUTH_KEY,
            metadata: ClaudeCode.metadata({
              binaryPath: bin,
              homePath: "",
              launchArgs: "",
            }),
          })
          const provider = yield* Provider.Service
          return yield* provider.list()
        }),
      )

      const claude = providers[ClaudeCode.ID]
      expect(claude).toBeDefined()
      expect(claude.name).toBe("Claude Code")
      expect(claude.models[ModelID.make("claude-opus-4-8")]).toBeDefined()
      expect(claude.models[ModelID.make("claude-opus-4-7")]).toBeDefined()
      expect(claude.models[ModelID.make("claude-opus-4-6")]).toBeDefined()
      expect(claude.models[ModelID.make("claude-sonnet-4-6")]).toBeDefined()
      expect(claude.models[ModelID.make("claude-haiku-4-5")]).toBeDefined()
      expect(claude.models[ModelID.make("claude-fable-5")]).toBeUndefined()
      expect(claude.models[ModelID.make("claude-opus-4-1")]).toBeUndefined()
      expect(claude.models[ModelID.make("claude-sonnet-4-5")]).toBeUndefined()
    },
  })
})

test("Claude Code language model streams through the provider adapter", async () => {
  await using tmp = await tmpdir({
    config: {},
    init: async (dir) => fakeClaude(dir),
  })

  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => {
      const bin = tmp.extra
      const result = await run(() =>
        Effect.gen(function* () {
          const auth = yield* Auth.Service
          yield* auth.set(ClaudeCode.ID, {
            type: "api",
            key: ClaudeCode.AUTH_KEY,
            metadata: ClaudeCode.metadata({
              binaryPath: bin,
              homePath: "",
              launchArgs: "",
            }),
          })
          const provider = yield* Provider.Service
          const model = yield* provider.getModel(ProviderID.make("claude-code"), ModelID.make("claude-sonnet-4-6"))
          const language = yield* provider.getLanguage(model)
          return yield* Effect.promise(() =>
            language.doGenerate({
              prompt: [
                {
                  role: "user",
                  content: [{ type: "text", text: "say hi" }],
                },
              ],
            }),
          )
        }),
      )

      expect(result.content).toEqual([{ type: "text", text: "hello from fake claude" }])
      expect(result.usage.inputTokens.total).toBe(3)
      expect(result.usage.outputTokens.total).toBe(4)
    },
  })
})
