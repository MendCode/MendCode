// Session stats in the footer's right side: `cache 99% · ctx 21%`.
// Copy it to <data dir>/extensions/cache-ctx.ts (docs/extensions-tui.md, "Session stats").
// api.stats() is a read-only snapshot, api.onStats() runs after a model call, a compaction or a change of model or effort moved a figure.
export default {
  name: "cache-ctx",
  tui(api) {
    const text = () => {
      const stats = api.stats()
      const parts = []
      if (stats.cachePercent !== undefined) parts.push("cache " + stats.cachePercent + "%")
      if (stats.contextPercent !== undefined) parts.push("ctx " + stats.contextPercent + "%")
      return parts.join(" · ")
    }
    api.slot("footer.right", () => {
      const line = text()
      return line ? [[{ text: line, fg: "muted" }]] : undefined
    })
    const stop = api.onStats(() => api.redraw())
    api.onDispose(stop)
  },
}
