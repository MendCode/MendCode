import type { Client } from "@mendcode/client"
import type { CatalogPrompt } from "./catalog-automation"

/** Secret inputs remain on the local daemon connection and never become command-line flags or output. */
export async function pluginLogin(client: Pick<Client, "send">, directory: string, provider: string | undefined, index: number, prompt?: (input: CatalogPrompt) => Promise<string | undefined>, write: (text: string) => void = () => {}) {
  const listed = await client.send({ type: "plugins.auth-methods", directory })
  if (!listed.ok) throw new Error("plugin auth methods unavailable")
  if (!provider) return listed.result ?? {}
  const providers = listed.result?.providers as Array<{ provider: string; methods: Array<{ type: string; label: string; prompts: Array<{ type: string; key: string; message: string; options?: CatalogPrompt["options"]; when?: { key: string; op: string; value: string } }> }> }> | undefined
  const method = providers?.find((entry) => entry.provider === provider)?.methods[index]
  if (!method || !prompt) throw new Error("plugin login requires an available method and an interactive terminal")
  const inputs: Record<string, string> = {}
  for (const field of method.prompts) {
    if (field.when && (inputs[field.when.key] === field.when.value) !== (field.when.op === "eq")) continue
    const answer = await prompt({ title: method.label, label: field.message, ...(field.type === "select" && field.options ? { options: field.options } : { secret: true }) })
    if (answer === undefined) throw new Error("plugin login cancelled")
    inputs[field.key] = answer
  }
  if (method.type === "api" && !method.prompts.length) {
    const key = await prompt({ title: method.label, label: "API key", secret: true })
    if (!key) throw new Error("plugin login cancelled")
    inputs.key = key
  }
  const started = await client.send({ type: "plugins.auth-start", directory, provider, method: index, inputs })
  if (!started.ok) throw new Error("plugin login failed; see /extensions")
  const flow = started.result ?? {}
  if (flow.authenticated === true) return { provider, authenticated: true }
  if (typeof flow.flowId !== "string") throw new Error("plugin login failed")
  write(`${String(flow.url)}\n${String(flow.instructions)}\n`)
  const answer = await prompt({ title: method.label, label: flow.method === "code" ? "Authorization code" : "Complete sign-in, then press Enter", secret: flow.method === "code", optional: flow.method !== "code" })
  if (answer === undefined) throw new Error("plugin login cancelled")
  const completed = await client.send({ type: "plugins.auth-complete", directory, flowId: flow.flowId, ...(flow.method === "code" ? { code: answer } : {}) })
  if (!completed.ok || completed.result?.authenticated !== true) throw new Error("plugin login failed; see /extensions")
  return { provider, authenticated: true }
}
