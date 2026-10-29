/** Who owns a tool's schema in the context report: an MCP server (`mcp__server__tool`) or the app itself; the daemon names extension tools. */
export function toolOwner(name: string): string {
  const mcp = /^mcp__(.+?)__/.exec(name)
  return mcp ? `mcp:${mcp[1]}` : "built-in"
}
