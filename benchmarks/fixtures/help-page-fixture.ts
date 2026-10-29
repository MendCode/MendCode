import { colorDepth, sgr } from "../../apps/cli/src/ui/theme"
import { renderHelpPage } from "../../apps/cli/src/view/help-page"

const width = Number(process.argv[2] ?? 120)
const height = Number(process.argv[3] ?? 35)
const depth = colorDepth({ COLORTERM: "truecolor" })

const lines = renderHelpPage({ width, height })
for (const line of lines) {
  let out = ""
  for (const span of line) {
    const style = sgr(span, depth)
    out += style ? `${style}${span.text}\x1b[0m` : span.text
  }
  process.stdout.write(`${out}\n`)
}
