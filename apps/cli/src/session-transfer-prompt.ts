import type { CatalogPrompt } from "./catalog-automation"
import { createCatalogPrompt, terminalCatalogPrompt } from "./catalog-prompts"
import { spread } from "./view/deck"
import { createEditor } from "./view/editor"

/** Export's autocomplete keeps the existing bordered selector and header keys. */
export function createSessionExportPicker(ctx: Parameters<typeof createCatalogPrompt>[0]): ReturnType<typeof createCatalogPrompt> {
  const search = createEditor()
  const options = ctx.request.options ?? []
  let app: ReturnType<typeof createCatalogPrompt>
  const rebuild = () => {
    const query = search.text.toLowerCase()
    const matches = options.filter((option) => `${option.label} ${option.value}`.toLowerCase().includes(query))
    app = createCatalogPrompt({
      ...ctx,
      draw: (rows, cursor) => {
        const { width } = ctx.size()
        rows[0] = spread([{ text: "Export session", fg: "primary", bold: true }], [{ text: width < 70 ? "type · ↑↓ · enter · esc" : "type search · ↑↓ select · enter export · esc cancel", fg: "muted" }], width)
        ctx.draw(rows, cursor)
      },
      request: { ...ctx.request, bordered: true, label: `Sessions${query ? ` · ${search.text}` : ""}`, options: matches.length ? matches : [{ value: "", label: "No matching sessions" }] },
      finish: (value) => { if (value !== "") ctx.finish(value) },
    })
  }
  rebuild()
  return {
    render: () => app.render(),
    key(seq) {
      if (seq === "\x7f" || seq === "\b" || seq === "\x15" || !seq.startsWith("\x1b") && !/[\x00-\x1f]/.test(seq)) {
        if (seq === "\x15") search.replaceAll("")
        else search.key(seq)
        if (search.text.length > 100) search.replaceAll(search.text.slice(0, 100))
        rebuild()
        app.render()
      } else app.key(seq)
    },
    paste(text) { search.insert(text.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").slice(0, 100 - search.text.length)); rebuild(); app.render() },
  }
}
export const terminalSessionExportPrompt = (request: CatalogPrompt) => terminalCatalogPrompt(request, createSessionExportPicker)
