import type { ProviderModel } from "@mendcode/protocol"
import type { Fetch, ModelEvent, ModelRequest, ResolvedProvider } from "../src"

export const GITLAB_TOKEN = "gitlab-local-fixture-private-0123456789"
export const GITLAB_DIRECT_TOKEN = "gitlab-direct-fixture-private-0123456789"
export const GITLAB_URL = "http://127.0.0.1:1234"
export const GITLAB_NAMESPACE = "gid://gitlab/Group/123"
export const GITLAB_FIXTURE_MODELS: ProviderModel[] = [
  { id: "duo-chat-sonnet-4-6", name: "Duo Chat Sonnet", images: true, tool_call: true },
  { id: "duo-chat-gpt-5-2", name: "Duo Chat GPT", images: true, tool_call: true },
  { id: "duo-chat-gpt-5-2-codex", name: "Duo Chat Codex", images: true, tool_call: true },
]
export const gitlabResolved = (over: Partial<ResolvedProvider> = {}): ResolvedProvider => ({ id: "gitlab", type: "openai-compatible", baseUrl: GITLAB_URL, apiKey: () => GITLAB_TOKEN, keyRequired: true, models: GITLAB_FIXTURE_MODELS, ...over })
export const gitlabRequest = (over: Partial<ModelRequest> = {}): ModelRequest => ({ system: "Be brief", messages: [{ role: "user", content: "Read a.ts" }], tools: [{ name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } }], signal: new AbortController().signal, ...over })
export async function collectGitLab(stream: AsyncIterable<ModelEvent>) {
  const events: ModelEvent[] = []
  for await (const event of stream) events.push(event)
  return events
}
export const gitlabSse = (events: unknown[]) => new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } })
export const gitlabAnthropic = () => gitlabSse([
  { type: "message_start", message: { usage: { input_tokens: 100, cache_read_input_tokens: 60, cache_creation_input_tokens: 10 } } },
  { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Look" } },
  { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "signature-fixture" } },
  { type: "content_block_stop", index: 0 },
  { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Reading ñ" } },
  { type: "content_block_stop", index: 1 },
  { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "call-1", name: "read", input: {} } },
  { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"path":' } },
  { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '"a.ts"}' } },
  { type: "content_block_stop", index: 2 },
  { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 20 } },
  { type: "message_stop" },
])
export const gitlabChat = () => gitlabSse([
  { choices: [{ delta: { reasoning_content: "Look", content: "Reading ñ", tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "read", arguments: '{"path":' } }] } }] },
  { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a.ts"}' } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 60 }, completion_tokens_details: { reasoning_tokens: 5 } } },
])
export const gitlabResponses = () => gitlabSse([
  { type: "response.reasoning_summary_text.delta", delta: "Look" },
  { type: "response.output_text.delta", delta: "Reading ñ" },
  { type: "response.output_item.done", item: { type: "function_call", call_id: "call-1", name: "read", arguments: '{"path":"a.ts"}' } },
  { type: "response.completed", response: { usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 60 }, output_tokens_details: { reasoning_tokens: 5 } } } },
])
export const gitlabFake: Fetch = async (url) => {
  if (url.endsWith("/direct_access")) return Response.json({ token: GITLAB_DIRECT_TOKEN, headers: { "X-GitLab-Instance-Id": "local-fixture" } })
  if (url.endsWith("/api/graphql")) return Response.json({ data: { aiChatAvailableModels: { selectableModels: [{ name: "Sonnet", ref: "claude_sonnet_4_6" }], defaultModel: { name: "Sonnet", ref: "claude_sonnet_4_6" } } } })
  if (url.endsWith("/messages")) return gitlabAnthropic()
  if (url.endsWith("/chat/completions")) return gitlabChat()
  if (url.endsWith("/responses")) return gitlabResponses()
  throw new Error("Unexpected fake GitLab route")
}
