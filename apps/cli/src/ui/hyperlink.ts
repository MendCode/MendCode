/** OSC 8 hyperlinks (docs/layout.md "Links"): only text a span marks with `link` is wrapped; terminal text never carries escapes. */

export const MAX_LINK_LENGTH = 2048
const SCHEMES = /^(?:https?|file|vscode|vscode-insiders|cursor|windsurf|zed|idea):\/\//i

/** The URI when it is printable ASCII, short and one of the schemes the transcript links to; undefined otherwise. */
export function safeLink(uri: string | undefined): string | undefined {
  if (!uri || uri.length > MAX_LINK_LENGTH || !SCHEMES.test(uri) || /[^\x21-\x7e]/.test(uri)) return undefined
  return uri
}

/** The sequence that starts a link; ST ends it, since BEL would be taken as part of some URIs. */
export const hyperlinkOpen = (uri: string) => `\x1b]8;;${uri}\x1b\\`
export const HYPERLINK_CLOSE = "\x1b]8;;\x1b\\"

/** Whether the terminal may be sent links: `MENDCODE_HYPERLINKS=0` and dumb or console terminals never are. */
export function hyperlinksAllowed(env: Record<string, string | undefined>): boolean {
  return env.MENDCODE_HYPERLINKS !== "0" && env.TERM !== "dumb" && env.TERM !== "linux"
}
