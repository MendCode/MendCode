import type { Argv } from "yargs"
import { Effect } from "effect"
import { Config } from "@/config/config"
import { ConfigCache, type CacheMutation } from "@/config/cache"
import { Instance } from "@/project/instance"
import { cmd } from "./cmd"
import { effectCmd, fail } from "../effect-cmd"
import { UI } from "../ui"

type CacheArgs = {
  global?: boolean
  provider?: string
  model?: string
  session?: string
  projectPath?: string
}

function cacheOptions(yargs: Argv) {
  return yargs
    .option("global", {
      type: "boolean",
      default: false,
      describe: "write the global config instead of the current project config",
    })
    .option("provider", {
      type: "string",
      describe: "provider ID to target",
    })
    .option("model", {
      type: "string",
      describe: "exact model ID to target; requires --provider",
    })
    .option("session", {
      type: "string",
      describe: "session ID to include or exclude",
    })
    .option("project-path", {
      type: "string",
      describe: "absolute or relative project path to target in global config",
    })
}

function mutationFromArgs(args: CacheArgs, action: CacheMutation["action"]): CacheMutation {
  if (args.projectPath && !args.global) throw new Error("--project-path requires --global")
  return {
    action,
    providerID: args.provider,
    modelID: args.model,
    sessionID: args.session,
    projectPath: args.projectPath,
  }
}

export const CacheStatusCommand = effectCmd({
  command: "status",
  describe: "show prompt-cache policy and configured scopes",
  builder: (yargs) =>
    yargs
      .option("format", {
        type: "string",
        choices: ["text", "json"],
        default: "text",
        describe: "output format",
      })
      .option("json", {
        type: "boolean",
        default: false,
        describe: "output JSON",
      }),
  handler: Effect.fn("Cli.cache.status")(function* (args: { format?: string; json?: boolean }) {
    const config = yield* Config.Service
    const current = yield* config.get()
    const status = {
      project: Instance.directory,
      mode: ConfigCache.selectCacheConfig({
        config: current.cache,
        projectScope: Instance.directory,
      }).mode,
      configured: current.cache ?? null,
      activeKeeper: false,
      note: "MendCode only uses passive provider cache controls; no keepalive requests are scheduled.",
    }
    if (args.json || args.format === "json") {
      UI.println(JSON.stringify(status, null, 2))
      return
    }
    UI.println(`Prompt cache: ${status.mode}`)
    UI.println(`Project: ${status.project}`)
    UI.println("Active keeper: disabled")
    if (!current.cache) UI.println("Configuration: legacy provider behavior (no cache override)")
    else UI.println(`Configuration: ${JSON.stringify(current.cache)}`)
  }),
})

const CacheMutationCommand = (action: CacheMutation["action"]) =>
  effectCmd({
    command: action,
    aliases: action === "enable" ? ["on"] : ["off"],
    describe: `${action === "enable" ? "enable" : "disable"} passive prompt caching for a scope`,
    instance: (args: CacheArgs) => !args.global,
    builder: cacheOptions,
    handler: Effect.fn(`Cli.cache.${action}`)(function* (args: CacheArgs) {
      const config = yield* Config.Service
      const current = args.global ? yield* config.getGlobal() : yield* config.get()
      let next: ConfigCache.Info
      try {
        next = ConfigCache.updateCacheConfig(current.cache, mutationFromArgs(args, action))
      } catch (error) {
        return yield* fail(error instanceof Error ? error.message : String(error))
      }

      if (args.global) yield* config.updateGlobal({ cache: next })
      else yield* config.update({ cache: next })

      UI.println(`${action === "enable" ? "Enabled" : "Disabled"} prompt cache policy.`)
      UI.println(JSON.stringify(next, null, 2))
    }),
  })

export const CacheEnableCommand = CacheMutationCommand("enable")
export const CacheDisableCommand = CacheMutationCommand("disable")

export const CacheCommand = cmd({
  command: "cache",
  describe: "control passive provider prompt caching",
  builder: (yargs) =>
    yargs.command(CacheStatusCommand).command(CacheEnableCommand).command(CacheDisableCommand).demandCommand(),
  async handler() {},
})
