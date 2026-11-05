/** What the model may ask of the user's own Chromium browser through the MendCode extension; the daemon owns the bridge. */
export type UserBrowserInput =
  | { action: "status" }
  | { action: "install" }
  | { action: "allow_site"; origin: string }
  | { action: "open"; url: string }
  | { action: "tabs" }
  | { action: "read"; tabId: number }
  | { action: "click"; tabId: number; selector: string }
  | { action: "type"; tabId: number; selector: string; text: string; submit?: boolean }
  | { action: "close"; tabId: number }

export type UserBrowserOutcome = { ok: true; text: string } | { ok: false; error: string }

export type UserBrowserPort = {
  run(input: UserBrowserInput, signal: AbortSignal): Promise<UserBrowserOutcome>
}

/** The title of the tab group the extension keeps for MendCode in the user's browser. */
export const USER_BROWSER_GROUP_TITLE = "MendCode"

/** `https://example.com/a?b` -> `https://example.com`; only http(s) origins are sites the user can allow. */
export function siteOrigin(raw: string): { ok: true; origin: string } | { ok: false; error: string } {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return { ok: false, error: `not a valid absolute URL: ${raw.slice(0, 120)}` }
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return { ok: false, error: `only http and https sites can be used, not ${parsed.protocol}` }
  if (parsed.username || parsed.password) return { ok: false, error: "URLs with embedded credentials are refused" }
  return { ok: true, origin: parsed.origin }
}
