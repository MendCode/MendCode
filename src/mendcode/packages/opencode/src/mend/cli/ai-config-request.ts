export function aiConfigRequest(action: "plan" | "validate" | "apply", input: unknown, options: {
  scope?: string
  target?: string
  expectedHash?: string
  causalSessionID?: string
}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("AI configuration input must be a JSON object")
  if (action === "plan") return input
  const preview = "patch" in input ? input : { patch: input }
  const selected = "target" in preview ? preview.target : undefined
  const target = options.target ?? (typeof selected === "string" ? selected :
    selected && typeof selected === "object" && "path" in selected && typeof selected.path === "string" ? selected.path : undefined)
  const scope = options.scope ?? ("scope" in preview ? preview.scope :
    selected && typeof selected === "object" && "scope" in selected ? selected.scope : undefined)
  if (scope !== undefined && scope !== "project" && scope !== "global") throw new Error("Configuration scope must be project or global")
  const expectedHash = options.expectedHash ?? ("expectedHash" in preview ? preview.expectedHash : undefined)
  return {
    patch: preview.patch,
    ...(scope ? { scope } : {}),
    ...(target ? { target } : {}),
    ...(expectedHash ? { expectedHash } : {}),
    ...(action === "apply" ? { causalSessionID: options.causalSessionID } : {}),
  }
}

type Approval = { id: string; sessionID: string; permission: string; metadata: Record<string, unknown> }

export async function runAIConfigRequest(input: {
  action: "inspect" | "plan" | "validate" | "apply"
  request?: unknown
  connection: { url: string; headers: Headers }
  confirm: (approval: Approval, signal: AbortSignal) => Promise<boolean>
  fetch?: typeof fetch
}) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(new Error("AI configuration request timed out")), 120_000)
  const request = async (route: string, body?: unknown) => {
    const headers = new Headers(input.connection.headers)
    if (body !== undefined) headers.set("content-type", "application/json")
    const response = await (input.fetch ?? fetch)(new URL(route, input.connection.url), {
      method: body === undefined ? "GET" : "POST", headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: controller.signal,
    })
    const text = await response.text()
    let payload: unknown
    try { payload = JSON.parse(text) } catch { payload = { message: text } }
    if (!response.ok) {
      const message = payload && typeof payload === "object" && "message" in payload ? String(payload.message) : response.statusText
      throw new Error(`AI configuration ${input.action} failed (HTTP ${response.status}): ${message}`)
    }
    return payload
  }
  try {
    if (input.action !== "apply") return await request(`/config/ai${input.action === "inspect" ? "" : `/${input.action}`}`, input.request)
    const session = await request("/session", { title: "AI configuration change" })
    if (!session || typeof session !== "object" || !("id" in session) || typeof session.id !== "string") throw new Error("Backend did not create a causal configuration session")
    if (!input.request || typeof input.request !== "object" || Array.isArray(input.request)) throw new Error("Apply requires a configuration request")
    let settled = false
    // Keep a handled result while the same authenticated client services this
    // new session's exact approval. Never borrow another session's grants.
    const applying = request("/config/ai/apply", { ...input.request, causalSessionID: session.id }).then(
      (value) => { settled = true; return { ok: true as const, value } },
      (error: unknown) => { settled = true; return { ok: false as const, error } },
    )
    const answered = new Set<string>()
    while (!settled) {
      controller.signal.throwIfAborted()
      const pending = await request("/permission")
      if (!Array.isArray(pending)) throw new Error("Backend returned an invalid permission list")
      for (const item of pending as Approval[]) {
        if (settled || item.sessionID !== session.id || item.metadata?.action !== "ai_config.apply" || answered.has(item.id)) continue
        answered.add(item.id)
        let allowed = false
        try { allowed = await input.confirm(item, controller.signal) }
        catch (error) {
          await request(`/permission/${encodeURIComponent(item.id)}/reply`, { reply: "reject" })
          throw error
        }
        await request(`/permission/${encodeURIComponent(item.id)}/reply`, { reply: allowed ? "once" : "reject" })
      }
      if (!settled) await new Promise((resolve) => setTimeout(resolve, 100))
    }
    const result = await applying
    if (!result.ok) throw result.error
    return result.value
  } finally {
    clearTimeout(timeout)
    controller.abort()
  }
}
