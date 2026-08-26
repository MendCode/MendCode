import { test, expect } from "bun:test"
import path from "path"
import { chmod, mkdir } from "fs/promises"
import { Effect } from "effect"
import { query, type Query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk"

import { Auth } from "@/auth"
import { ProviderAuth } from "@/provider/auth"
import { Provider } from "@/provider/provider"
import { ClaudeCode } from "@/provider/claude-code"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { AppRuntime } from "../../src/effect/app-runtime"
import { WithInstance } from "../../src/project/with-instance"
import { tmpdir } from "../fixture/fixture"

async function fakeClaude(dir: string, options: { loggedIn?: boolean; apiProvider?: string } = {}) {
  const bin = path.join(dir, "bin", "claude")
  await mkdir(path.dirname(bin), { recursive: true })
  const loggedIn = options.loggedIn ?? true
  const apiProvider = options.apiProvider ?? "firstParty"
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
        ? `  echo '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"${apiProvider}","email":"test@example.com","subscriptionType":"max"}'`
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

function fakeQuery(messages: SDKMessage[], onInput?: (input: Parameters<typeof query>[0]) => void): typeof query {
  return ((input: Parameters<typeof query>[0]) => {
    onInput?.(input)
    return Object.assign(
      (async function* () {
        for (const message of messages) yield message
      })(),
      {
        close() {},
      },
    ) as Query
  }) as typeof query
}

function sdkMessage(value: unknown): SDKMessage {
  return value as SDKMessage
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

test("Claude Code auth method rejects non-subscription CLI backends", async () => {
  await using binary = await tmpdir({
    init: async (dir) => fakeClaude(dir, { apiProvider: "bedrock" }),
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
      expect(validation.data.message).toContain("requires a Claude subscription login")
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

test("Claude Code language model streams through the Agent SDK", async () => {
  let input: Parameters<typeof query>[0] | undefined
  const sdk = ClaudeCode.createClaudeCode({
    binaryPath: "/tmp/fake-claude",
    homePath: "~/claude-subscription-home",
    launchArgs: "--permission-mode plan --fast-mode",
    workingDirectory: "/tmp/project",
    createQuery: fakeQuery(
      [
        sdkMessage({
          type: "stream_event",
          event: { type: "content_block_delta", delta: { type: "text_delta", text: "hello " } },
          parent_tool_use_id: null,
          uuid: "00000000-0000-4000-8000-000000000001",
          session_id: "00000000-0000-4000-8000-000000000002",
        }),
        sdkMessage({
          type: "stream_event",
          event: { type: "content_block_delta", delta: { type: "text_delta", text: "from sdk" } },
          parent_tool_use_id: null,
          uuid: "00000000-0000-4000-8000-000000000003",
          session_id: "00000000-0000-4000-8000-000000000002",
        }),
        sdkMessage({
          type: "result",
          subtype: "success",
          duration_ms: 1,
          duration_api_ms: 1,
          is_error: false,
          num_turns: 1,
          result: "hello from sdk",
          stop_reason: "end_turn",
          total_cost_usd: 0,
          usage: { input_tokens: 3, output_tokens: 4, cache_creation_input_tokens: 1, cache_read_input_tokens: 2 },
          modelUsage: {},
          permission_denials: [],
          uuid: "00000000-0000-4000-8000-000000000004",
          session_id: "00000000-0000-4000-8000-000000000002",
        }),
      ],
      (value) => {
        input = value
      },
    ),
  })
  const language = sdk.languageModel("claude-sonnet-4-6")
  const result = await language.doGenerate({
    prompt: [
      {
        role: "user",
        content: [{ type: "text", text: "say hi" }],
      },
    ],
  })

  expect(result.content).toEqual([{ type: "text", text: "hello from sdk" }])
  expect(result.usage.inputTokens.total).toBe(3)
  expect(result.usage.inputTokens.cacheWrite).toBe(1)
  expect(result.usage.inputTokens.cacheRead).toBe(2)
  expect(result.usage.outputTokens.total).toBe(4)
  expect(input?.options?.pathToClaudeCodeExecutable).toBe("/tmp/fake-claude")
  expect(input?.options?.model).toBe("claude-sonnet-4-6")
  expect(input?.options?.cwd).toBe("/tmp/project")
  expect(input?.options?.includePartialMessages).toBe(true)
  expect(input?.options?.extraArgs).toEqual({ "permission-mode": "plan", "fast-mode": null })
})

test("Claude Code SDK falls back to final assistant text without partial deltas", async () => {
  const sdk = ClaudeCode.createClaudeCode({
    createQuery: fakeQuery([
      sdkMessage({
        type: "assistant",
        message: { content: [{ type: "text", text: "final text" }] },
        parent_tool_use_id: null,
        uuid: "00000000-0000-4000-8000-000000000005",
        session_id: "00000000-0000-4000-8000-000000000006",
      }),
      sdkMessage({
        type: "result",
        subtype: "success",
        duration_ms: 1,
        duration_api_ms: 1,
        is_error: false,
        num_turns: 1,
        result: "final text",
        stop_reason: "end_turn",
        total_cost_usd: 0,
        usage: { input_tokens: 5, output_tokens: 6 },
        modelUsage: {},
        permission_denials: [],
        uuid: "00000000-0000-4000-8000-000000000007",
        session_id: "00000000-0000-4000-8000-000000000006",
      }),
    ]),
  })

  const result = await sdk.languageModel("claude-sonnet-4-6").doGenerate({
    prompt: [{ role: "user", content: [{ type: "text", text: "say hi" }] }],
  })

  expect(result.content).toEqual([{ type: "text", text: "final text" }])
  expect(result.usage.inputTokens.total).toBe(5)
  expect(result.usage.outputTokens.total).toBe(6)
})

test("Claude Code doGenerate preserves reasoning blocks and unsupported-tool warnings", async () => {
  const sdk = ClaudeCode.createClaudeCode({
    createQuery: fakeQuery([
      sdkMessage({
        type: "stream_event",
        event: { type: "content_block_delta", delta: { thinking: "analyzing" } },
        parent_tool_use_id: null,
        uuid: "00000000-0000-4000-8000-000000000008",
        session_id: "00000000-0000-4000-8000-000000000009",
      }),
      sdkMessage({
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "done" } },
        parent_tool_use_id: null,
        uuid: "00000000-0000-4000-8000-000000000010",
        session_id: "00000000-0000-4000-8000-000000000009",
      }),
      sdkMessage({
        type: "result",
        subtype: "success",
        duration_ms: 1,
        duration_api_ms: 1,
        is_error: false,
        num_turns: 1,
        result: "done",
        stop_reason: "end_turn",
        total_cost_usd: 0,
        usage: { input_tokens: 2, output_tokens: 3 },
        modelUsage: {},
        permission_denials: [],
        uuid: "00000000-0000-4000-8000-000000000011",
        session_id: "00000000-0000-4000-8000-000000000009",
      }),
    ]),
  })

  const result = await sdk.languageModel("claude-sonnet-4-6").doGenerate({
    prompt: [{ role: "user", content: [{ type: "text", text: "say hi" }] }],
    tools: [{ type: "function", name: "lookup", inputSchema: { type: "object" } }],
  })

  expect(result.content).toEqual([
    { type: "reasoning", text: "analyzing" },
    { type: "text", text: "done" },
  ])
  expect(result.warnings).toEqual([
    {
      type: "unsupported",
      feature: "tools",
      details: "Claude Code provider support for MendCode tool calls is not implemented yet.",
    },
  ])
})

test("Claude Code closes started text blocks when the Agent SDK throws", async () => {
  const sdk = ClaudeCode.createClaudeCode({
    createQuery: (() =>
      Object.assign(
        (async function* () {
          yield sdkMessage({
            type: "stream_event",
            event: { type: "content_block_delta", delta: { type: "text_delta", text: "partial" } },
            parent_tool_use_id: null,
            uuid: "00000000-0000-4000-8000-000000000014",
            session_id: "00000000-0000-4000-8000-000000000015",
          })
          throw new Error("stream exploded")
        })(),
        {
          close() {},
        },
      ) as Query) as typeof query,
  })

  const stream = await sdk.languageModel("claude-sonnet-4-6").doStream({
    prompt: [{ role: "user", content: [{ type: "text", text: "say hi" }] }],
  })
  const reader = stream.stream.getReader()
  const parts = []
  while (true) {
    const next = await reader.read()
    if (next.done) break
    parts.push(next.value)
  }

  expect(parts.map((part) => part.type)).toEqual([
    "stream-start",
    "text-start",
    "text-delta",
    "error",
    "text-end",
    "finish",
  ])
})

test("Claude Code forwards pre-aborted signals to the Agent SDK", async () => {
  let input: Parameters<typeof query>[0] | undefined
  const abortController = new AbortController()
  abortController.abort("already cancelled")
  const sdk = ClaudeCode.createClaudeCode({
    createQuery: fakeQuery(
      [
        sdkMessage({
          type: "result",
          subtype: "success",
          duration_ms: 1,
          duration_api_ms: 1,
          is_error: false,
          num_turns: 1,
          result: "done",
          stop_reason: "end_turn",
          total_cost_usd: 0,
          usage: { input_tokens: 1, output_tokens: 1 },
          modelUsage: {},
          permission_denials: [],
          uuid: "00000000-0000-4000-8000-000000000012",
          session_id: "00000000-0000-4000-8000-000000000013",
        }),
      ],
      (value) => {
        input = value
      },
    ),
  })

  await sdk.languageModel("claude-sonnet-4-6").doGenerate({
    prompt: [{ role: "user", content: [{ type: "text", text: "say hi" }] }],
    abortSignal: abortController.signal,
  })

  expect(input?.options?.abortController?.signal.aborted).toBe(true)
  expect(input?.options?.abortController?.signal.reason).toBe("already cancelled")
})

test("Claude Code forwards a live abort and closes the Agent SDK query", async () => {
  let input: Parameters<typeof query>[0] | undefined
  let releaseQuery: (() => void) | undefined
  let closeCalls = 0
  const abortController = new AbortController()
  const queryGate = new Promise<void>((resolve) => {
    releaseQuery = resolve
  })
  const sdk = ClaudeCode.createClaudeCode({
    createQuery: ((value: Parameters<typeof query>[0]) => {
      input = value
      return Object.assign(
        (async function* () {
          await queryGate
        })(),
        {
          close() {
            closeCalls += 1
            releaseQuery?.()
          },
        },
      ) as Query
    }) as typeof query,
  })

  const result = await sdk.languageModel("claude-sonnet-4-6").doStream({
    prompt: [{ role: "user", content: [{ type: "text", text: "say hi" }] }],
    abortSignal: abortController.signal,
  })
  const reader = result.stream.getReader()
  expect((await reader.read()).value?.type).toBe("stream-start")
  for (let attempt = 0; attempt < 50 && !input; attempt++) await Bun.sleep(5)

  abortController.abort("stop now")

  expect(input?.options?.abortController?.signal.aborted).toBe(true)
  expect(input?.options?.abortController?.signal.reason).toBe("stop now")
  releaseQuery?.()
  while (!(await reader.read()).done) {}
  expect(closeCalls).toBe(1)
})
