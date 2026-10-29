import type { CatalogPrompt } from "./catalog-automation"
import type { Line } from "./ui/theme"
import { createScreen } from "./ui/screen"
import { tokenizeKeys } from "./ui/keys"
import { createEditor, graphemes } from "./view/editor"
import { fit, panelGrid, spread } from "./view/deck"
import { textWidth } from "./view/wrap"

const clean = (text: string) => text.replace(/[\x00-\x1f\x7f-\x9f]/g, " ")

/** Small app factory shared by the live terminal wizard and its frame/interaction harness. */
export function createCatalogPrompt(ctx: { request: CatalogPrompt; size(): { width: number; height: number }; draw(rows: Line[], cursor?: { row: number; col: number }): void; finish(value: string | undefined): void }) {
  const editor = createEditor()
  editor.replaceAll(ctx.request.initial ?? "")
  let selected = Math.max(0, (ctx.request.options ?? []).findIndex((option) => option.value === ctx.request.initial))
  const checked = new Set(ctx.request.multiple ? ctx.request.initial?.split(",") ?? [] : [])
  let error = ""
  let finished = false
  const finish = (value: string | undefined) => { finished = true; ctx.finish(value) }
  const options = ctx.request.options ?? []
  const render = () => {
    const { width, height } = ctx.size()
    const inner = Math.max(1, width - (width < 70 ? 0 : 4))
    const room = Math.max(1, height - 9)
    const start = Math.max(0, selected - room + 1)
    const body: Line[] = options.length ? options.slice(start, start + room).map((option, index) => [
      { text: selected === start + index ? "› " : "  ", fg: "primary" },
      { text: `${ctx.request.multiple ? checked.has(option.value) ? "[x] " : "[ ] " : ""}${clean(option.label)}`, fg: selected === start + index ? "primary" : "text", bold: selected === start + index },
    ]) : []
    let cursor: { row: number; col: number } | undefined
    if (!options.length) {
      const chars = graphemes(ctx.request.secret ? "*".repeat(graphemes(editor.text).length) : clean(editor.text))
      const offset = editor.cursorOffset
      let from = Math.max(0, offset - inner + 2)
      while (textWidth(chars.slice(from, offset).join("")) > inner - 2) from++
      body.push([{ text: `› ${chars.slice(from).join("")}`, fg: "text" }])
      cursor = { row: 4, col: Math.min(width - 1, (width < 70 ? 2 : 4) + textWidth(chars.slice(from, offset).join(""))) }
    }
    const hint = options[selected]?.hint
    if (hint) body.push([], [{ text: clean(hint), fg: "muted" }])
    if (error) body.push([], [{ text: error, fg: "error" }])
    const hints = ctx.request.multiple ? width < 70 ? "space toggle · enter next · esc cancel" : "↑↓ select · space toggle · enter confirm · esc cancel" : width < 70 ? "enter next · esc cancel" : options.length ? "↑↓ select · enter confirm · esc cancel" : "enter next · esc cancel"
    const rows = [spread([{ text: ctx.request.title, fg: "primary", bold: true }], [{ text: hints, fg: "muted" }], width), [],
      ...panelGrid({ rows: [[{ title: ctx.request.label, body, active: true }]], width, heights: [Math.max(4, height - 3)], compact: width < 70 && !ctx.request.bordered, padding: true })]
    while (rows.length < height) rows.push([])
    ctx.draw(rows.slice(0, height).map((row) => fit(row, width)), cursor)
  }
  const key = (seq: string) => {
    if (finished) return
    if (seq === "\x1b" || seq === "\x03") return finish(undefined)
    if (options.length) {
      if (["\x1b[A", "\x1bOA", "k"].includes(seq)) selected = Math.max(0, selected - 1)
      else if (["\x1b[B", "\x1bOB", "j"].includes(seq)) selected = Math.min(options.length - 1, selected + 1)
      else if (seq === " " && ctx.request.multiple) {
        const value = options[selected]!.value
        if (checked.has(value)) checked.delete(value)
        else checked.add(value)
      } else if (seq === "\r" || seq === "\n") return finish(ctx.request.multiple ? options.filter((option) => checked.has(option.value)).map((option) => option.value).join(",") : options[selected]!.value)
    } else if (seq === "\r" || seq === "\n") {
      error = !editor.text && !ctx.request.optional ? "Required" : ctx.request.validate?.(editor.text) ?? ""
      if (!error) return finish(editor.text)
    } else { editor.key(seq); error = "" }
    render()
  }
  return { render, key, paste(text: string) { if (finished) return; if (!options.length) editor.insert(text.replace(/[\r\n]/g, " ")); render() } }
}

export async function terminalCatalogPrompt(request: CatalogPrompt, createPrompt: typeof createCatalogPrompt = createCatalogPrompt): Promise<string | undefined> {
  const screen = createScreen(process.stdout, process.env)
  const previousRaw = process.stdin.isRaw
  let resolve!: (value: string | undefined) => void
  const done = new Promise<string | undefined>((settle) => { resolve = settle })
  const app = createPrompt({ request, size: () => ({ width: process.stdout.columns ?? 80, height: process.stdout.rows ?? 24 }), draw: (rows, cursor) => screen.draw(rows, cursor), finish: resolve })
  const input = (chunk: Buffer) => { for (const token of tokenizeKeys(chunk.toString("utf8"))) token.type === "paste" ? app.paste(token.text) : app.key(token.seq) }
  const resize = () => { screen.resize(process.stdout.columns ?? 80, process.stdout.rows ?? 24); app.render() }
  const stop = () => resolve(undefined)
  try {
    screen.enter()
    process.stdin.setRawMode?.(true)
    process.stdin.on("data", input)
    process.stdout.on("resize", resize)
    process.once("SIGTERM", stop)
    app.render()
    process.stdin.resume()
    return await done
  } finally {
    process.stdin.off("data", input)
    process.stdout.off("resize", resize)
    process.off("SIGTERM", stop)
    process.stdin.setRawMode?.(previousRaw ?? false)
    process.stdin.pause()
    screen.leave()
  }
}
