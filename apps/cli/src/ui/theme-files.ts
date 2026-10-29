import type { ThemeFile } from "@mendcode/protocol"
import { themeDocument } from "@mendcode/protocol/wire"
import { withReadableContrast } from "../themes/contrast"
import { defineTheme, type Theme } from "../themes/define"

export type ThemeProblem = { name: string; file: string; message: string }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * Theme files from the extension layers (`themes/<name>.json`): `{ label?, dark?, background, colors }` with the same
 * roles as a built-in theme (primary, text, body, muted, border, heading, code, link, success, warning, error
 * required; the rest derived). The file name is the theme name. Invalid files become problems, never throw.
 */
export function themesFromFiles(files: readonly ThemeFile[]): { themes: Theme[]; problems: ThemeProblem[] } {
  const themes: Theme[] = []
  const problems: ThemeProblem[] = []
  for (const file of files) {
    const fail = (message: string) => problems.push({ name: file.name, file: file.file, message })
    if (file.problem) {
      fail(file.problem)
      continue
    }
    let json = file.json
    if (isRecord(json) && isRecord(json.theme)) {
      const parsed = themeDocument(json)
      if (!parsed.document) {
        fail(parsed.errors.join("; "))
        continue
      }
      json = parsed.document
    }
    if (!isRecord(json) || !isRecord(json.colors) || typeof json.background !== "string") {
      fail('expected { "background": "#rrggbb", "colors": { … } }')
      continue
    }
    try {
      const theme = defineTheme({
        name: file.name,
        label: typeof json.label === "string" && json.label.trim() ? json.label.trim().slice(0, 40) : file.name,
        dark: typeof json.dark === "boolean" ? json.dark : true,
        background: json.background,
        colors: json.colors as Parameters<typeof defineTheme>[0]["colors"],
      })
      themes.push(withReadableContrast(theme))
    } catch (error) {
      fail((error as Error).message.replace(/^\[THEME\]: /, ""))
    }
  }
  return { themes, problems }
}
