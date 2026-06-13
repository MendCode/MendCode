/**
 * Wrap generated-client throwOnError values in real Error instances so CLI/TUI
 * formatters get a useful message while structured callers can still inspect
 * the original body through cause.
 */
export function wrapClientError(
  error: unknown,
  response: Response | undefined,
  request: Request | undefined,
  opts: { throwOnError?: boolean } | undefined,
): unknown {
  if (!opts?.throwOnError) return error
  if (error instanceof Error) return error

  if (typeof error === "object" && error !== null && Object.keys(error).length > 0) {
    const obj = error as { data?: { message?: unknown }; message?: unknown; name?: unknown }
    const message =
      (typeof obj.data?.message === "string" && obj.data.message) ||
      (typeof obj.message === "string" && obj.message) ||
      (typeof obj.name === "string" && obj.name) ||
      describe(request, response)
    return new Error(message, { cause: { body: error, status: response?.status } })
  }

  if (typeof error === "string" && error.length > 0) {
    return new Error(error, { cause: { body: error, status: response?.status } })
  }

  const reason = response ? "(empty response body)" : "network error (no response)"
  return new Error(`MendCode server ${describe(request, response)}: ${reason}`, {
    cause: { body: error, status: response?.status },
  })
}

function describe(request: Request | undefined, response: Response | undefined) {
  const method = request?.method ?? "?"
  const url = request?.url ?? "?"
  const status = response?.status
  const statusText = response?.statusText
  return `${method} ${url}${status ? " -> " + status : ""}${statusText ? " " + statusText : ""}`
}
