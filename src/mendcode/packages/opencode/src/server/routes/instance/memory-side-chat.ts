import { Effect } from "effect"
import { streamText } from "ai"
import { Provider } from "@/provider/provider"
import { ModelID, ProviderID } from "@/provider/schema"
import { ProviderTransform } from "@/provider/transform"
import {
  buildMemorySideChatRequest,
  memoryAssistantFailureReason,
  parseMemorySideChatResponse,
  resolveMemoryAssistantRuntimeRoles,
  type MemorySideChatMessage,
} from "@/mend/memory/side-chat"

export type MemorySideChatServerPayload = {
  root?: string
  message: string
  history?: MemorySideChatMessage[]
  context?: {
    selectedWorkspaceID?: string | null
    selectedGroupID?: string | null
    selectedCategoryID?: string | null
    pageContext?: string | null
  }
}

async function collectStreamText(input: { language: any; model: Provider.Model; providerID: string; system: string; message: string }) {
  const usesProviderInstructions = input.providerID === "openai"
  const result = streamText({
    model: input.language,
    system: usesProviderInstructions ? undefined : input.system,
    providerOptions: ProviderTransform.providerOptions(input.model, usesProviderInstructions
      ? { instructions: input.system, store: false }
      : {}),
    messages: [{ role: "user", content: input.message }],
    onError() {},
  })
  const parts: string[] = []
  for await (const event of result.fullStream) {
    const item = event as Record<string, unknown>
    if (item.type === "error") throw item.error
    const text = typeof item.text === "string" ? item.text : typeof item.delta === "string" ? item.delta : ""
    if ((item.type === "text-delta" || item.type === "text") && text) parts.push(text)
  }
  return parts.join("") || (await result.text)
}

export function runMemorySideChat(payload: MemorySideChatServerPayload, fallbackRoot: string) {
  return Effect.gen(function* () {
    const root = payload.root || fallbackRoot
    const roles = yield* Effect.promise(() => resolveMemoryAssistantRuntimeRoles(root))
    if (!roles.ok) return { text: roles.reason, actions: [] }

    const request = yield* Effect.promise(() =>
      buildMemorySideChatRequest(root, {
        message: payload.message,
        history: payload.history ?? [],
        context: {
          selectedWorkspaceID: payload.context?.selectedWorkspaceID ?? null,
          selectedGroupID: payload.context?.selectedGroupID ?? null,
          selectedCategoryID: payload.context?.selectedCategoryID ?? null,
          pageContext: payload.context?.pageContext ?? null,
        },
      }),
    )

    const failures: string[] = []
    for (const role of roles.roles) {
      const provider = yield* Provider.Service
      const response = yield* Effect.gen(function* () {
        const model = yield* provider.getModel(ProviderID.make(role.providerID), ModelID.make(role.modelID))
        const language = yield* provider.getLanguage(model)
        const text = yield* Effect.tryPromise({
          try: () =>
            collectStreamText({
              language,
              model,
              providerID: role.providerID,
              system: request.instructions,
              message: request.message,
            }),
          catch: memoryAssistantFailureReason,
        })
        return parseMemorySideChatResponse(text || "")
      }).pipe(
        Effect.catch((error) => {
          failures.push(`${role.roleName}: ${memoryAssistantFailureReason(error)}`)
          return Effect.succeed(null)
        }),
      )
      if (response) return response
    }

    return {
      text: failures.length
        ? `memory side chat provider unavailable: ${failures.join(" | ")}`
        : "memory side chat provider unavailable",
      actions: [],
    }
  })
}
