export const HEADER_DIRECTORY = "x-mendcode-directory"
export const HEADER_DIRECTORY_LEGACY = "x-opencode-directory"

export const HEADER_WORKSPACE = "x-mendcode-workspace"
export const HEADER_WORKSPACE_LEGACY = "x-opencode-workspace"

export const HEADER_PROXY_URL = "x-mendcode-proxy-url"
export const HEADER_PROXY_URL_LEGACY = "x-opencode-proxy-url"

export const HEADER_SYNC = "x-mendcode-sync"
export const HEADER_SYNC_LEGACY = "x-opencode-sync"

export const HEADER_TICKET = "x-mendcode-ticket"
export const HEADER_TICKET_LEGACY = "x-opencode-ticket"

export const HEADER_SESSION = "x-mendcode-session"
export const HEADER_SESSION_LEGACY = "x-opencode-session"

export const HEADER_REQUEST = "x-mendcode-request"
export const HEADER_REQUEST_LEGACY = "x-opencode-request"

export const HEADER_PROJECT = "x-mendcode-project"
export const HEADER_PROJECT_LEGACY = "x-opencode-project"

export const HEADER_CLIENT = "x-MendCodeent"
export const HEADER_CLIENT_LEGACY = "x-opencode-client"

export function getHeader(headers: Headers, primary: string, legacy?: string) {
  return headers.get(primary) ?? (legacy ? headers.get(legacy) : null)
}

export function getHeaderRecord(headers: Record<string, string | undefined>, primary: string, legacy?: string) {
  return headers[primary] ?? (legacy ? headers[legacy] : undefined)
}
