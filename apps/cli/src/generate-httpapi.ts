import { compatEnvelope } from "./compat"

/** Offline `generate --httpapi`: the B34 OpenAPI document, built in-process with no daemon, listener, token or network. */
export async function loadHttpApi(): Promise<Record<string, unknown>> {
  const { generateHttpApi } = await import("@mendcode/daemon/http-launch")
  return await generateHttpApi() as Record<string, unknown>
}

/** Plain output is the bare document so it can be redirected into a file; `--json` wraps it like every other command result. */
export function renderHttpApi(input: { spec: Record<string, unknown>; json: boolean; compat?: string | undefined; schema: string; now: number }) {
  if (!input.json) return `${JSON.stringify(input.spec, null, 2)}\n`
  const output = { kind: "result" as const, command: "generate", data: input.spec }
  return `${JSON.stringify(input.compat ? compatEnvelope(output, input.now) : { schema: input.schema, ...output })}\n`
}
