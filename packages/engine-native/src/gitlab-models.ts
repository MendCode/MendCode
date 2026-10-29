import type { ProviderModel } from "@mendcode/protocol"

export const GITLAB_CHAT_MODELS: Record<string, { format: "anthropic" | "chat" | "responses"; model: string }> = {
  "duo-chat-opus-4-7": { format: "anthropic", model: "claude-opus-4-7" },
  "duo-chat-opus-4-6": { format: "anthropic", model: "claude-opus-4-6" },
  "duo-chat-sonnet-4-6": { format: "anthropic", model: "claude-sonnet-4-6" },
  "duo-chat-opus-4-5": { format: "anthropic", model: "claude-opus-4-5-20251101" },
  "duo-chat-sonnet-4-5": { format: "anthropic", model: "claude-sonnet-4-5-20250929" },
  "duo-chat-haiku-4-5": { format: "anthropic", model: "claude-haiku-4-5-20251001" },
  "duo-chat-gpt-5-1": { format: "chat", model: "gpt-5.1-2025-11-13" },
  "duo-chat-gpt-5-2": { format: "chat", model: "gpt-5.2-2025-12-11" },
  "duo-chat-gpt-5-4": { format: "chat", model: "gpt-5.4-2026-03-05" },
  "duo-chat-gpt-5-mini": { format: "chat", model: "gpt-5-mini-2025-08-07" },
  "duo-chat-gpt-5-4-mini": { format: "chat", model: "gpt-5.4-mini" },
  "duo-chat-gpt-5-4-nano": { format: "chat", model: "gpt-5.4-nano" },
  "duo-chat-gpt-5-codex": { format: "responses", model: "gpt-5-codex" },
  "duo-chat-gpt-5-2-codex": { format: "responses", model: "gpt-5.2-codex" },
  "duo-chat-gpt-5-3-codex": { format: "responses", model: "gpt-5.3-codex" },
}

export const GITLAB_WORKFLOW_REFS: Record<string, string> = {
  "anthropic/claude-sonnet-4-5-20250929": "duo-workflow-sonnet-4-5",
  claude_sonnet_4_6: "duo-workflow-sonnet-4-6",
  "anthropic/claude-opus-4-5-20251101": "duo-workflow-opus-4-5",
  claude_haiku_4_5_20251001: "duo-workflow-haiku-4-5",
  claude_opus_4_6_20260205: "duo-workflow-opus-4-6",
}

export const GITLAB_MODELS: ProviderModel[] = [
  ...Object.keys(GITLAB_CHAT_MODELS).map((id) => ({ id, name: id.replace("duo-chat-", "Duo Chat · "), images: true, reasoning: true, effort: true, tool_call: true })),
  ...Object.entries(GITLAB_WORKFLOW_REFS).map(([ref, id]) => ({ id, name: id.replace("duo-workflow-", "Agent Platform · "), reasoning: true, temperature: false, tool_call: true, options: { workflowRef: ref } })),
]
