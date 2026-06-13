import { Context, Effect, Layer } from "effect"

import { InstanceState } from "@/effect/instance-state"

import PROMPT_ANTHROPIC from "./prompt/anthropic.txt"
import PROMPT_DEFAULT from "./prompt/default.txt"
import PROMPT_BEAST from "./prompt/beast.txt"
import PROMPT_GEMINI from "./prompt/gemini.txt"
import PROMPT_GPT from "./prompt/gpt.txt"
import PROMPT_KIMI from "./prompt/kimi.txt"

import PROMPT_CODEX from "./prompt/codex.txt"
import PROMPT_TRINITY from "./prompt/trinity.txt"
import type { Provider } from "@/provider/provider"
import type { Agent } from "@/agent/agent"
import { Permission } from "@/permission"
import { Skill } from "@/skill"
import { resolvePromptFocus } from "@/mend/prompt/focus-resolver"
import { composePromptPolicy } from "@/mend/prompt/compose"
import { readPromptMode } from "@/mend/prompt/mode"
import { mendMemoryContext } from "@/mend/memory/retrieve"

export function provider(model: Provider.Model) {
  if (model.api.id.includes("gpt-4") || model.api.id.includes("o1") || model.api.id.includes("o3"))
    return [PROMPT_BEAST]
  if (model.api.id.includes("gpt")) {
    if (model.api.id.includes("codex")) {
      return [PROMPT_CODEX]
    }
    return [PROMPT_GPT]
  }
  if (model.api.id.includes("gemini-")) return [PROMPT_GEMINI]
  if (model.api.id.includes("claude")) return [PROMPT_ANTHROPIC]
  if (model.api.id.toLowerCase().includes("trinity")) return [PROMPT_TRINITY]
  if (model.api.id.toLowerCase().includes("kimi")) return [PROMPT_KIMI]
  return [PROMPT_DEFAULT]
}

export function mendFocus(model: Provider.Model) {
  const resolution = resolvePromptFocus({
    providerID: model.providerID,
    modelID: model.api.id || model.id,
  })
  return [
    "<mendcode_focus>",
    `Focus: ${resolution.focusID}`,
    `Source: ${resolution.source}`,
    `Reason: ${resolution.reason}`,
    "Policy: adapt MendCode behavior for this provider/model family without replacing the provider system prompt, exposing proprietary prompt dumps, or impersonating upstream products.",
    "</mendcode_focus>",
  ].join("\n")
}

export async function mendPromptPolicy(model: Provider.Model, root?: string) {
  const mode = await readPromptMode(root)
  const resolution = resolvePromptFocus({
    providerID: model.providerID,
    modelID: model.api.id || model.id,
  })
  const policy = await composePromptPolicy({
    mode: mode.mode,
    focusID: resolution.focusID,
    modelID: model.api.id || model.id,
    root,
  })
  return [
    "<mendcode_prompt_policy>",
    `Mode: ${policy.mode}`,
    `Focus: ${policy.focusID}`,
    `Base prompt source: ${policy.basePromptSource}`,
    `Resolution source: ${resolution.source}`,
    ...(policy.fallbackReason ? [`Fallback reason: ${policy.fallbackReason}`] : []),
    policy.policyInstructions,
    "",
    "Persistent memory operations:",
    "- When the user explicitly asks to remember, save, guardar, or add something to memory, use the MendCode memory command instead of creating arbitrary project files.",
    "- Use `mendcode memory add \"<memory text>\" --scope global` for global/cross-project memory.",
    "- Use `mendcode memory add \"<memory text>\" --scope project` for memory that belongs only to the current repo.",
    "- When the user asks to inspect or manage memory, use the exact MendCode commands: `mendcode memory status`, `mendcode memory list --scope global|project`, `mendcode memory search <query>`, `mendcode memory edit <entry-id> \"<new text>\" --scope global|project`, `mendcode memory delete <entry-id> --scope global|project`, `mendcode memory apply <proposal-id>`, and `mendcode memory reject <proposal-id>`.",
    "- Do not infer memory IDs from chat text. List or search first, then edit/delete/apply the exact ID.",
    "- Runtime memory is injected as transient system context. Do not copy loaded memories into normal assistant messages unless the user asks to see them.",
    "- Memory config is global by default. Use `mendcode memory config ...` for global config, and only use `mendcode memory config ... --project` when the user explicitly wants a repo-local override.",
    "- Generated memory proposals are approval-gated; direct `mendcode memory add` is appropriate only when the user explicitly asks to save that memory.",
    "</mendcode_prompt_policy>",
  ].join("\n")
}

export async function mendBaseProvider(model: Provider.Model, root?: string) {
  const mode = await readPromptMode(root)
  const resolution = resolvePromptFocus({
    providerID: model.providerID,
    modelID: model.api.id || model.id,
  })
  const policy = await composePromptPolicy({
    mode: mode.mode,
    focusID: resolution.focusID,
    modelID: model.api.id || model.id,
    root,
  })
  if (policy.basePromptSource === "mendcode-harness-source" && policy.basePrompt) return [policy.basePrompt]
  return provider(model)
}

export async function mendMemory(
  model: Provider.Model,
  root?: string,
  query?: string | null,
  mode: "request" | "after-compaction" = "request",
) {
  const result = await mendMemoryContext(model, root, query, mode)
  return result.text
}

export interface Interface {
  readonly environment: (model: Provider.Model) => Effect.Effect<string[]>
  readonly skills: (agent: Agent.Info) => Effect.Effect<string | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SystemPrompt") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const skill = yield* Skill.Service

    return Service.of({
      environment: Effect.fn("SystemPrompt.environment")(function* (model: Provider.Model) {
        const ctx = yield* InstanceState.context
        return [
          [
            `You are powered by the model named ${model.api.id}. The exact model ID is ${model.providerID}/${model.api.id}`,
            `Here is some useful information about the environment you are running in:`,
            `<env>`,
            `  Working directory: ${ctx.directory}`,
            `  Workspace root folder: ${ctx.worktree}`,
            `  Is directory a git repo: ${ctx.project.vcs === "git" ? "yes" : "no"}`,
            `  Platform: ${process.platform}`,
            `  Today's date: ${new Date().toDateString()}`,
            `</env>`,
          ].join("\n"),
        ]
      }),

      skills: Effect.fn("SystemPrompt.skills")(function* (agent: Agent.Info) {
        if (Permission.disabled(["skill"], agent.permission).has("skill")) return

        const list = yield* skill.available(agent)

        return [
          "Skills provide specialized instructions and workflows for specific tasks.",
          "Use the skill tool to load a skill when a task matches its description.",
          // the agents seem to ingest the information about skills a bit better if we present a more verbose
          // version of them here and a less verbose version in tool description, rather than vice versa.
          Skill.fmt(list, { verbose: true }),
        ].join("\n")
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Skill.defaultLayer))

export * as SystemPrompt from "./system"
