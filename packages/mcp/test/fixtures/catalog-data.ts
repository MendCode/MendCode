export function catalogAnswer(method: string, params: Record<string, any> = {}) {
  if (method === "resources/list") return params.cursor ? { resources: [{ name: "Release notes", uri: "docs://release", mimeType: "text/plain" }] } : { resources: [{ name: "Project guide", description: "Architecture and conventions", uri: "docs://guide", mimeType: "text/plain" }], nextCursor: "resources-2" }
  if (method === "resources/templates/list") return { resourceTemplates: [{ name: "Issue", uriTemplate: "issues://{id}", description: "Issue by identifier" }] }
  if (method === "resources/read") {
    if (params.uri === "docs://missing") throw new Error("resource not found")
    return { contents: [{ uri: params.uri, mimeType: "text/plain", text: "Daemon owns I/O. Clients send typed commands." }, { uri: "docs://image", mimeType: "image/png", blob: "AAAA" }] }
  }
  if (method === "prompts/list") return params.cursor ? { prompts: [{ name: "Standup", description: "Summarize project progress" }] } : { prompts: [{ name: "Review code", description: "Review a target with a chosen focus", arguments: [{ name: "target", required: true }, { name: "focus", description: "Review focus" }] }], nextCursor: "prompts-2" }
  if (method === "prompts/get") return { description: "Code review", messages: [{ role: "user", content: { type: "text", text: `Review ${params.arguments?.target ?? "the project"}` } }, { role: "assistant", content: { type: "text", text: `Focus: ${params.arguments?.focus ?? "correctness"}` } }, { role: "user", content: { type: "image", data: "AAAA", mimeType: "image/png" } }] }
  return undefined
}
