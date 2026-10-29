import type { ModelChoice, ProviderInfo } from "@mendcode/protocol"
import { GITLAB_FIXTURE_MODELS, GITLAB_NAMESPACE, GITLAB_URL } from "../../../packages/engine-native/test/gitlab-fixtures"
import { providersHarness, REPORT } from "./providers-harness"

export function gitlabHarness(input: { dataDir: string; width?: number; height?: number }) {
  const provider: ProviderInfo = { id: "gitlab", type: "openai-compatible", baseUrl: GITLAB_URL, enabled: false, hasKey: true, source: "config", models: [...GITLAB_FIXTURE_MODELS, { id: "duo-workflow-sonnet-4-6", name: "Agent Platform (Sonnet)", options: { workflowRef: "claude_sonnet_4_6" } }], gitlab: { rootNamespaceId: GITLAB_NAMESPACE } }
  let failed: string | undefined
  let removed = false
  let choice: ModelChoice = REPORT.effective!
  const report = () => ({ ...REPORT, models: [...REPORT.models.filter((model) => !model.provider), ...(provider.enabled ? provider.models.map((model) => ({ id: `gitlab:${model.id}`, name: `${model.name} · GitLab`, provider: "gitlab", efforts: [] })) : [])], effective: choice })
  const h = providersHarness({ ...input, reply: (command) => {
    if (command.type === "providers.list") return { ok: true, result: { providers: removed ? [] : [provider] } }
    if (command.type === failed) return { ok: false, error: { code: "internal", message: "GitLab proxy rejected request (403)" } }
    if (command.type === "providers.set") { provider.enabled = command.enabled === true; removed = false; return { ok: true, result: { provider } } }
    if (command.type === "providers.refresh") return { ok: true, result: { provider } }
    if (command.type === "providers.test") return { ok: true, result: { ok: true, latencyMs: 12, model: "duo-chat-sonnet-4-6" } }
    if (command.type === "providers.remove") { removed = true; return { ok: true, result: { providers: [] } } }
    if (command.type === "models.list") return { ok: true, result: report() }
    if (command.type === "session.model.set") { choice = command.choice as ModelChoice; return { ok: true, result: report() } }
    return undefined
  } })
  return { ...h, provider, fail: (type?: string) => { failed = type } }
}
