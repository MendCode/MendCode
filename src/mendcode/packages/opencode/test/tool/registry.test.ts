import { afterEach, describe, expect } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { Effect, Layer } from "effect"
import { CrossSpawnSpawner } from "@mendcode/core/cross-spawn-spawner"
import { ToolRegistry } from "@/tool/registry"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestConfig } from "../fixture/config"
import { AppFileSystem } from "@mendcode/core/filesystem"
import { Plugin } from "@/plugin"
import { Question } from "@/question"
import { PlanReview } from "@/plan-review"
import { Todo } from "@/session/todo"
import { Skill } from "@/skill"
import { Agent } from "@/agent/agent"
import { Session } from "@/session/session"
import { AgentCommand } from "@/session/agent-command"
import { SessionStatus } from "@/session/status"
import { BackgroundTask } from "@/session/background-task"
import { Provider } from "@/provider/provider"
import { LSP } from "@/lsp/lsp"
import { Instruction } from "@/session/instruction"
import { Bus } from "@/bus"
import { FetchHttpClient } from "effect/unstable/http"
import { Format } from "@/format"
import { Ripgrep } from "@/file/ripgrep"
import * as Truncate from "@/tool/truncate"
import { InstanceState } from "@/effect/instance-state"
import { ModelID, ProviderID } from "@/provider/schema"
import { Permission } from "@/permission"
import { LoopWorkflow } from "@/session/loop"
import { LoopRunner } from "@/session/loop-runner"
import { WorkflowService } from "@/session/workflow-service"
import type { Agent as AgentTypes } from "@/agent/agent"
import { Auth } from "@/auth"

const buildAgent: AgentTypes.Info = {
  name: "build",
  mode: "primary",
  permission: Permission.fromConfig({ "*": "allow" }),
  options: {},
}

const node = CrossSpawnSpawner.defaultLayer
const configLayer = (config: Record<string, unknown> = {}) =>
  TestConfig.layer({
    get: () => Effect.succeed(config),
    directories: () => InstanceState.directory.pipe(Effect.map((dir) => [path.join(dir, ".mendcode")])),
  })

const authLayer = (info?: Auth.Info) =>
  Layer.succeed(
    Auth.Service,
    Auth.Service.of({
      get: (providerID) => Effect.succeed(providerID === "openai" ? info : undefined),
      all: () => Effect.succeed<Record<string, Auth.Info>>(info ? { openai: info } : {}),
      set: () => Effect.void,
      remove: () => Effect.void,
    }),
  )

const imageProviderLayer = Layer.succeed(
  Provider.Service,
  Provider.Service.of({
    list: () => Effect.succeed({}),
    getProvider: () => Effect.die("provider info is not used by registry image tests"),
    getModel: (providerID, modelID) =>
      modelID === "gpt-image-2"
        ? Effect.die("gpt-image-2 is intentionally absent from the conversational provider catalog")
        : Effect.succeed({
            id: modelID,
            providerID,
            capabilities: {
              output: { image: modelID === "test-image-model" },
            },
          } as any),
    getLanguage: () => Effect.die("language models are not used by registry tests"),
    closest: () => Effect.succeed(undefined),
    getSmallModel: () => Effect.succeed(undefined),
    defaultModel: () => Effect.die("default model is not used by registry tests"),
  }),
)

const registryLayer = (
  info?: Auth.Info,
  config: Record<string, unknown> = {},
  providerLayer: Layer.Layer<Provider.Service, never, never> = Provider.defaultLayer as Layer.Layer<
    Provider.Service,
    never,
    never
  >,
) => {
  const base = ToolRegistry.layer.pipe(
    Layer.provide(configLayer(config)),
    Layer.provide(authLayer(info)),
    Layer.provide(Plugin.defaultLayer),
    Layer.provide(Question.defaultLayer),
    Layer.provide(PlanReview.defaultLayer),
    Layer.provide(LoopWorkflow.defaultLayer),
    Layer.provide([LoopRunner.defaultLayer, Todo.defaultLayer, WorkflowService.defaultLayer]),
    Layer.provide(Skill.defaultLayer),
    Layer.provide(Agent.defaultLayer),
    Layer.provide([Session.defaultLayer, AgentCommand.defaultLayer]),
    Layer.provide([SessionStatus.defaultLayer, BackgroundTask.defaultLayer]),
    Layer.provide(providerLayer),
    Layer.provide(LSP.defaultLayer),
    Layer.provide(Instruction.defaultLayer),
    Layer.provide(AppFileSystem.defaultLayer),
    Layer.provide(Bus.layer),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(Format.defaultLayer),
    Layer.provide(node),
    Layer.provide(Ripgrep.defaultLayer),
  )
  return base.pipe(Layer.provide(Truncate.defaultLayer))
}

const it = testEffect(Layer.mergeAll(registryLayer(), node))
const imageConfig = {
  image_generation: { enabled: true, model: "openai/test-image-model" },
  provider: {
    openai: {
      name: "OpenAI test provider",
      npm: "@ai-sdk/openai",
      models: {
        "test-image-model": {
          name: "Test image model",
          modalities: { input: ["text"], output: ["image"] },
        },
      },
    },
  },
}
const oauthInfo = new Auth.Oauth({
  type: "oauth",
  access: "access",
  refresh: "refresh",
  expires: Date.now() + 60_000,
  accountId: "account",
})
const oauthIt = testEffect(Layer.mergeAll(registryLayer(oauthInfo, imageConfig, imageProviderLayer), node))
const oauthDefaultIt = testEffect(Layer.mergeAll(registryLayer(oauthInfo, {}, imageProviderLayer), node))
const oauthDefaultDisabledIt = testEffect(
  Layer.mergeAll(registryLayer(oauthInfo, { image_generation: { enabled: false } }, imageProviderLayer), node),
)
const apiKeyInfo = new Auth.Api({ type: "api", key: "test-api-key" })
const apiKeyIt = testEffect(Layer.mergeAll(registryLayer(apiKeyInfo, imageConfig, imageProviderLayer), node))
const apiKeyDefaultIt = testEffect(Layer.mergeAll(registryLayer(apiKeyInfo, {}, imageProviderLayer), node))
const disabledImageIt = testEffect(
  Layer.mergeAll(
    registryLayer(
      undefined,
      {
        ...imageConfig,
        image_generation: { enabled: false, model: "openai/test-image-model" },
      },
      imageProviderLayer,
    ),
    node,
  ),
)
const nonImageModelIt = testEffect(
  Layer.mergeAll(
    registryLayer(
      undefined,
      { image_generation: { enabled: true, model: "openai/text-only-model" } },
      imageProviderLayer,
    ),
    node,
  ),
)

afterEach(async () => {
  await disposeAllInstances()
})

describe("tool.registry", () => {
  it.instance("keeps edit and write available for gpt models alongside apply_patch", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const tools = yield* registry.tools({
        providerID: ProviderID.make("openai"),
        modelID: ModelID.make("gpt-5.4"),
        agent: buildAgent,
      })
      const ids = tools.map((tool) => tool.id)

      expect(ids).toContain("apply_patch")
      expect(ids).toContain("edit")
      expect(ids).toContain("memory")
      expect(ids).toContain("memory_graph")
      expect(ids).toContain("review")
      expect(ids).toContain("tell")
      expect(ids).toContain("peers")
      expect(ids).toContain("task_status")
      expect(ids).toContain("write")
      expect(ids).not.toContain("image_gen")
    }),
  )

  oauthDefaultIt.instance("exposes image_gen with the default gpt-image-2 model for OpenAI subscription OAuth", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const tools = yield* registry.tools({
        providerID: ProviderID.make("openai"),
        modelID: ModelID.make("gpt-5.6-sol"),
        agent: buildAgent,
      })

      expect(tools.map((tool) => tool.id)).toContain("image_gen")
    }),
  )

  oauthDefaultDisabledIt.instance("does not apply the subscription default when image generation is disabled", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const tools = yield* registry.tools({
        providerID: ProviderID.make("openai"),
        modelID: ModelID.make("gpt-5.6-sol"),
        agent: buildAgent,
      })

      expect(tools.map((tool) => tool.id)).not.toContain("image_gen")
    }),
  )

  apiKeyDefaultIt.instance("does not infer a default image model from an OpenAI API key", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const tools = yield* registry.tools({
        providerID: ProviderID.make("openai"),
        modelID: ModelID.make("gpt-5.6-sol"),
        agent: buildAgent,
      })

      expect(tools.map((tool) => tool.id)).not.toContain("image_gen")
    }),
  )

  oauthIt.instance("exposes image_gen for a configured output-image model", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const tools = yield* registry.tools({
        providerID: ProviderID.make("openai"),
        modelID: ModelID.make("gpt-5.6-sol"),
        agent: buildAgent,
      })

      expect(tools.map((tool) => tool.id)).toContain("image_gen")
    }),
  )

  apiKeyIt.instance("keeps image_gen independent from the active chat auth mode", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const tools = yield* registry.tools({
        providerID: ProviderID.make("openai"),
        modelID: ModelID.make("gpt-5.6-sol"),
        agent: buildAgent,
      })

      expect(tools.map((tool) => tool.id)).toContain("image_gen")
    }),
  )

  disabledImageIt.instance("does not expose image_gen when image generation is disabled", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const tools = yield* registry.tools({
        providerID: ProviderID.make("openai"),
        modelID: ModelID.make("gpt-5.6-sol"),
        agent: buildAgent,
      })

      expect(tools.map((tool) => tool.id)).not.toContain("image_gen")
    }),
  )

  oauthIt.instance("does not expose image_gen when the agent permission denies it", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const tools = yield* registry.tools({
        providerID: ProviderID.make("openai"),
        modelID: ModelID.make("gpt-5.6-sol"),
        agent: { ...buildAgent, permission: Permission.fromConfig({ "*": "allow", image_gen: "deny" }) },
      })

      expect(tools.map((tool) => tool.id)).not.toContain("image_gen")
    }),
  )

  nonImageModelIt.instance("does not expose image_gen for a model without image output capability", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const tools = yield* registry.tools({
        providerID: ProviderID.make("openai"),
        modelID: ModelID.make("gpt-5.6-sol"),
        agent: buildAgent,
      })

      expect(tools.map((tool) => tool.id)).not.toContain("image_gen")
    }),
  )

  it.instance("does not expose apply_patch to non-gpt models", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const tools = yield* registry.tools({
        providerID: ProviderID.make("anthropic"),
        modelID: ModelID.make("claude-sonnet-4-5"),
        agent: buildAgent,
      })
      const ids = tools.map((tool) => tool.id)

      expect(ids).not.toContain("apply_patch")
      expect(ids).toContain("edit")
      expect(ids).toContain("write")
    }),
  )

  it.instance("loads tools from .mendcode/tool (singular)", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const opencode = path.join(test.directory, ".mendcode")
      const tool = path.join(opencode, "tool")
      yield* Effect.promise(() => fs.mkdir(tool, { recursive: true }))
      yield* Effect.promise(() =>
        Bun.write(
          path.join(tool, "hello.ts"),
          [
            "export default {",
            "  description: 'hello tool',",
            "  args: {},",
            "  execute: async () => {",
            "    return 'hello world'",
            "  },",
            "}",
            "",
          ].join("\n"),
        ),
      )
      const registry = yield* ToolRegistry.Service
      const ids = yield* registry.ids()
      expect(ids).toContain("hello")
    }),
  )

  it.instance("loads tools from .mendcode/tools (plural)", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const opencode = path.join(test.directory, ".mendcode")
      const tools = path.join(opencode, "tools")
      yield* Effect.promise(() => fs.mkdir(tools, { recursive: true }))
      yield* Effect.promise(() =>
        Bun.write(
          path.join(tools, "hello.ts"),
          [
            "export default {",
            "  description: 'hello tool',",
            "  args: {},",
            "  execute: async () => {",
            "    return 'hello world'",
            "  },",
            "}",
            "",
          ].join("\n"),
        ),
      )
      const registry = yield* ToolRegistry.Service
      const ids = yield* registry.ids()
      expect(ids).toContain("hello")
    }),
  )

  it.instance("loads tools with external dependencies without crashing", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const opencode = path.join(test.directory, ".mendcode")
      const tools = path.join(opencode, "tools")
      yield* Effect.promise(() => fs.mkdir(tools, { recursive: true }))
      yield* Effect.promise(() =>
        Bun.write(
          path.join(opencode, "package.json"),
          JSON.stringify({
            name: "custom-tools",
            dependencies: {
              "@mendcode/plugin": "^0.0.0",
              cowsay: "^1.6.0",
            },
          }),
        ),
      )
      yield* Effect.promise(() =>
        Bun.write(
          path.join(opencode, "package-lock.json"),
          JSON.stringify({
            name: "custom-tools",
            lockfileVersion: 3,
            packages: {
              "": {
                dependencies: {
                  "@mendcode/plugin": "^0.0.0",
                  cowsay: "^1.6.0",
                },
              },
            },
          }),
        ),
      )

      const cowsay = path.join(opencode, "node_modules", "cowsay")
      yield* Effect.promise(() => fs.mkdir(cowsay, { recursive: true }))
      yield* Effect.promise(() =>
        Bun.write(
          path.join(cowsay, "package.json"),
          JSON.stringify({
            name: "cowsay",
            type: "module",
            exports: "./index.js",
          }),
        ),
      )
      yield* Effect.promise(() =>
        Bun.write(
          path.join(cowsay, "index.js"),
          ["export function say({ text }) {", "  return `moo ${text}`", "}", ""].join("\n"),
        ),
      )
      yield* Effect.promise(() =>
        Bun.write(
          path.join(tools, "cowsay.ts"),
          [
            "import { say } from 'cowsay'",
            "export default {",
            "  description: 'tool that imports cowsay at top level',",
            "  args: { text: { type: 'string' } },",
            "  execute: async ({ text }: { text: string }) => {",
            "    return say({ text })",
            "  },",
            "}",
            "",
          ].join("\n"),
        ),
      )
      const registry = yield* ToolRegistry.Service
      const ids = yield* registry.ids()
      expect(ids).toContain("cowsay")
    }),
  )
})
