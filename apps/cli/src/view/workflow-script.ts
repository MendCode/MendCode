/** Terminal-side helpers of script workflows: parsing run arguments and the starter file. No schema library here (startup graph). */

export const SCRIPT_NAME = /^[a-z0-9][a-z0-9._-]{0,39}$/
export const isScriptFile = (target: string) => target.endsWith(".js") || target.endsWith(".mjs")

/** `{"a":1}` or `key=value ...` (values are JSON when they parse as JSON, else text). */
export function parseRunArguments(raw: string): { ok: true; args: Record<string, unknown> | undefined } | { ok: false; error: string } {
  const text = raw.trim()
  if (!text) return { ok: true, args: undefined }
  if (text.startsWith("{")) {
    try {
      const value = JSON.parse(text) as unknown
      return typeof value === "object" && value !== null && !Array.isArray(value) ? { ok: true, args: value as Record<string, unknown> } : { ok: false, error: "arguments must be a JSON object" }
    } catch (error) {
      return { ok: false, error: `arguments are not valid JSON: ${(error as Error).message}` }
    }
  }
  const args: Record<string, unknown> = {}
  for (const word of text.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []) {
    const eq = word.indexOf("=")
    if (eq < 1) return { ok: false, error: `argument "${word.slice(0, 40)}" is not key=value` }
    const key = word.slice(0, eq)
    const value = word.slice(eq + 1).replace(/^(["'])(.*)\1$/, "$2")
    if (key === "__proto__" || key === "constructor") return { ok: false, error: `argument name "${key}" is not allowed` }
    try {
      args[key] = JSON.parse(value)
    } catch {
      args[key] = value
    }
  }
  return { ok: true, args }
}

export { workflowStarter } from "@mendcode/extension-api/workflow-starter"
