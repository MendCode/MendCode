import { DEFAULT_CELL_PIXELS, type CellPixels } from "../pets/frames"

const valid = (pixels: CellPixels | undefined): pixels is CellPixels => pixels !== undefined && [pixels.width, pixels.height].every((n) => Number.isInteger(n) && n > 0 && n <= 256)

/** Reported geometry wins; an explicit host value or environment override avoids querying altogether. */
export function hostCellPixels(env: Record<string, string | undefined>, pixels?: CellPixels): CellPixels | undefined {
  if (valid(pixels)) return pixels
  const match = /^(\d+)x(\d+)$/.exec(env.MENDCODE_CELL_PIXELS ?? "")
  const override = match ? { width: Number(match[1]), height: Number(match[2]) } : undefined
  return valid(override) ? override : undefined
}

/** Collect once before any graphical placement. Freeze the result so a late reply cannot resize the first pet. */
export function terminalPixels(input: { size(): { width: number; height: number }; write(data: string): unknown; tty: boolean; host?: CellPixels | undefined; timeoutMs?: number }) {
  let pixels = input.host ?? DEFAULT_CELL_PIXELS
  let settled = false
  let pending = ""
  let windowPixels: CellPixels | undefined
  let cells: CellPixels | undefined
  let ready: Promise<CellPixels> | undefined
  let finish: (() => void) | undefined
  let timer: ReturnType<typeof setTimeout> | undefined

  function windowCell() {
    const grid = cells ?? input.size()
    const derived = windowPixels ? { width: windowPixels.width / grid.width, height: windowPixels.height / grid.height } : undefined
    if (valid(derived)) pixels = derived
  }

  return {
    get value() { return pixels },
    resolve(host?: CellPixels): Promise<CellPixels> {
      if (valid(host)) {
        pixels = host
        settled = true
        finish?.()
        return Promise.resolve(pixels)
      }
      if (ready) return ready
      if (input.host || !input.tty) {
        settled = true
        return ready = Promise.resolve(pixels)
      }
      ready = new Promise((resolve) => {
        finish = () => {
          clearTimeout(timer)
          settled = true
          resolve(pixels)
        }
        // Prefer a direct 16t reply; otherwise derive from 14t/18t, or use the default at timeout.
        timer = setTimeout(() => { windowCell(); finish?.() }, input.timeoutMs ?? 150)
        input.write("\x1b[16t\x1b[14t\x1b[18t")
      })
      return ready
    },
    consume(data: string) {
      const joined = pending + data
      pending = ""
      let rest = joined.replace(/\x1b\[([468]);(\d+);(\d+)t/g, (_, kind: string, h: string, w: string) => {
        const value = { width: Number(w), height: Number(h) }
        if (!settled && ready) {
          if (kind === "6" && valid(value)) { pixels = value; finish?.() }
          else if (kind === "4") windowPixels = value
          else if (kind === "8") cells = value
        }
        return "" // Late reports are still terminal replies, never editor text.
      })
      const partial = /\x1b\[[468];[\d;]*$/.exec(rest)
      if (partial) {
        pending = partial[0]
        rest = rest.slice(0, partial.index)
      }
      return rest
    },
    stop() { finish?.() },
  }
}
