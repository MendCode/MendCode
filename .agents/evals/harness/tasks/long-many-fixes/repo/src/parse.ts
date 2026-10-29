/** Case-insensitive, trimmed: true/yes/on/1 -> true; false/no/off/0/"" -> false; anything else throws SyntaxError. */
export function parseBool(text: string): boolean {
  return Boolean(text)
}

/** "?a=1&b=2&a=3" -> { a: ["1", "3"], b: "2" }: a repeated key becomes an array, values are URI-decoded, a leading "?" is ignored. */
export function parseQuery(query: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}
  for (const pair of query.replace(/^\?/, "").split("&")) {
    if (!pair) continue
    const [key = "", value = ""] = pair.split("=")
    out[decodeURIComponent(key)] = decodeURIComponent(value)
  }
  return out
}
