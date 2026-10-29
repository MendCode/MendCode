/** What the model may ask a headless browser to do; the daemon owns the browser process and the DevTools connection. */
export type BrowserInput =
  | { action: "navigate"; url: string }
  | { action: "snapshot" }
  | { action: "click"; ref: number }
  | { action: "type"; ref: number; text: string; submit?: boolean; append?: boolean }
  | { action: "press"; key: string }
  | { action: "scroll"; direction: "up" | "down" }
  | { action: "back" }
  | { action: "wait"; ms?: number; text?: string }
  | { action: "screenshot" }
  | { action: "console" }
  | { action: "close" }
  | { action: "tabs" }
  | { action: "open_tab"; url: string }
  | { action: "select_tab" | "close_tab"; tabId: string }

export type BrowserPage = { url: string; title: string }

export type BrowserOutcome =
  | { ok: true; text: string; truncated?: boolean; page?: BrowserPage; image?: { mime: "image/png" | "image/jpeg"; bytes: Uint8Array } }
  | { ok: false; error: string }

/** A chat session's private browser: isolated tab contexts, never another session's pages or cookies. */
export type BrowserPort = {
  run(input: BrowserInput, signal: AbortSignal): Promise<BrowserOutcome>
}

export const BROWSER_KEYS = ["Enter", "Tab", "Escape", "Backspace", "Delete", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown", "Space"] as const

export const BROWSER_LIMITS = {
  /** Chat sessions that may hold a browser at once; the next one is refused until one closes or idles out. */
  maxSessions: 4,
  maxTabs: 8,
  viewport: { width: 1280, height: 800 },
  navigateTimeoutMs: 30_000,
  commandTimeoutMs: 30_000,
  maxWaitMs: 30_000,
  /** No browser call for this long: the session's browser is closed. */
  idleMs: 10 * 60 * 1_000,
  maxLifetimeMs: 60 * 60 * 1_000,
  maxElements: 300,
  maxTextChars: 8_000,
  maxLabelChars: 80,
  maxConsoleEntries: 200,
  maxScreenshotBytes: 5 * 1024 * 1024,
} as const

/** Only http(s) pages: `file:`, `javascript:`, `chrome:` and the like would read local data or run code outside the page. */
export function checkBrowserUrl(raw: string): { ok: true; url: string } | { ok: false; error: string } {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return { ok: false, error: `not a valid absolute URL: ${raw.slice(0, 120)}` }
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return { ok: false, error: `only http and https pages can be opened, not ${parsed.protocol}` }
  if (parsed.username || parsed.password) return { ok: false, error: "URLs with embedded credentials are refused" }
  return { ok: true, url: parsed.toString() }
}
