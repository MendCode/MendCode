import type { PetImage } from "../pets/decode"
import { activeTheme, colorOverrides, type ColorName } from "../ui/theme"

/**
 * Charts the terminal draws as a picture where it can (a graphics protocol), over the cells their text version reserved. A chart
 * is described once, when its text is laid out, and painted when it is placed, at the pixels of its cells: nothing is fetched or
 * decoded, so a chart is on screen in the frame that shows it.
 */
export type PieSpec = { kind: "pie"; slices: ReadonlyArray<{ share: number; color: ColorName }> }
/**
 * The plot of a bar and line chart, in the cells of its text version: `cols` by `rows` cells, category `i` centred on cell
 * `i * stride + floor(stride / 2)`, the value `max` on the middle of the first row and `min` on the middle of the last.
 */
export type XySpec = { kind: "xy"; cols: number; rows: number; stride: number; min: number; max: number; series: ReadonlyArray<{ kind: "bar" | "line"; values: readonly number[]; color: ColorName }> }
/**
 * A radar chart's web and curves, in the cells of its text version: a `cols` by `rows` box whose centre cell is (`cx`, `cy`), the
 * outer ring `rx` cells wide and `ry` rows tall from it, the first axis at twelve o'clock. A curve's `ratios` are its values along
 * the axes, 0 at the centre and 1 on the outer ring.
 */
export type RadarSpec = { kind: "radar"; cols: number; rows: number; cx: number; cy: number; rx: number; ry: number; axes: number; curves: ReadonlyArray<{ ratios: readonly number[]; color: ColorName }> }
export type ChartSpec = PieSpec | XySpec | RadarSpec

/** The prefix of a chart's key, where a transcript picture otherwise has the hash of an attachment. */
export const CHART_KEY = "chart:"
/** Descriptions kept: the charts of the transcript on screen and some scrolled past. */
const KEEP = 64
/** Samples per pixel side: the edge of the disc and of each slice is smoothed over this many. */
const SAMPLES = 3

const specs = new Map<string, ChartSpec>()

/** Remembers `spec` and returns the key its rows carry. The same chart always has the same key. */
export function registerChart(spec: ChartSpec): string {
  const key = `${CHART_KEY}${Bun.hash(JSON.stringify(spec)).toString(36)}`
  specs.delete(key)
  specs.set(key, spec)
  if (specs.size > KEEP) specs.delete(specs.keys().next().value!)
  return key
}

function rgb(name: ColorName): [number, number, number] {
  const hex = colorOverrides()[name] ?? activeTheme().colors[name]
  const value = /^#[0-9a-f]{6}$/i.test(hex) ? hex : "#808080"
  return [1, 3, 5].map((at) => Number.parseInt(value.slice(at, at + 2), 16)) as [number, number, number]
}

/**
 * The chart `key` painted in a `width` by `height` pixel box, on a transparent ground; undefined when it is no longer remembered.
 * A pie is a disc as wide as the smaller side, at the left of the box, clockwise from twelve o'clock, with a thin line of the
 * ground between two slices.
 */
export function drawChart(key: string, width: number, height: number): PetImage | undefined {
  const spec = specs.get(key)
  if (!spec || width < 4 || height < 4) return undefined
  if (spec.kind === "xy") return drawXy(spec, width, height)
  if (spec.kind === "radar") return drawRadar(spec, width, height)
  const rgba = new Uint8Array(width * height * 4)
  const radius = Math.min(width, height) / 2 - 1
  const [cx, cy] = [radius + 1, height / 2]
  const colors = spec.slices.map((slice) => rgb(slice.color))
  const ends: number[] = []
  let sum = 0
  for (const slice of spec.slices) ends.push(sum += slice.share)
  const live = spec.slices.filter((slice) => slice.share > 0).length
  // A cut is the unit vector of a slice's edge; the line left along it is `gap` pixels wide.
  const cuts = live < 2 ? [] : [0, ...ends.slice(0, -1)].filter((turn, at, all) => all.indexOf(turn) === at).map((turn) => [Math.sin(turn * Math.PI * 2), -Math.cos(turn * Math.PI * 2)] as const)
  const gap = Math.max(1.5, radius / 40)
  const step = 1 / SAMPLES
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < Math.min(width, Math.ceil(cx + radius + 1)); x++) {
      let [r, g, b, hits] = [0, 0, 0, 0]
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const dx = x + (sx + 0.5) * step - cx
          const dy = y + (sy + 0.5) * step - cy
          if (dx * dx + dy * dy > radius * radius) continue
          if (cuts.some(([ux, uy]) => dx * ux + dy * uy > 0 && Math.abs(dx * uy - dy * ux) < gap / 2)) continue
          const turn = (Math.atan2(dx, -dy) + Math.PI * 2) % (Math.PI * 2) / (Math.PI * 2)
          const found = ends.findIndex((end) => turn <= end)
          const color = colors[found < 0 ? colors.length - 1 : found]!
          r += color[0]
          g += color[1]
          b += color[2]
          hits++
        }
      }
      if (!hits) continue
      const at = (y * width + x) * 4
      rgba[at] = Math.round(r / hits)
      rgba[at + 1] = Math.round(g / hits)
      rgba[at + 2] = Math.round(b / hits)
      rgba[at + 3] = Math.round((255 * hits) / (SAMPLES * SAMPLES))
    }
  }
  return { width, height, rgba }
}

/** A canvas that paints one colour over what is there, by coverage. */
function canvas(width: number, height: number) {
  const rgba = new Uint8Array(width * height * 4)
  const blend = (x: number, y: number, color: readonly [number, number, number], cover: number) => {
    if (x < 0 || y < 0 || x >= width || y >= height || cover <= 0) return
    const at = (y * width + x) * 4
    const [top, under] = [Math.min(1, cover), rgba[at + 3]! / 255]
    const alpha = top + under * (1 - top)
    for (let channel = 0; channel < 3; channel++) rgba[at + channel] = Math.round((color[channel]! * top + rgba[at + channel]! * under * (1 - top)) / alpha)
    rgba[at + 3] = Math.round(alpha * 255)
  }
  return {
    rgba,
    /** An upright rectangle with whole-pixel sides; `cover` is how solid it is. */
    rect(x0: number, y0: number, x1: number, y1: number, color: readonly [number, number, number], cover = 1) {
      for (let y = Math.round(Math.min(y0, y1)); y < Math.round(Math.max(y0, y1)); y++) for (let x = Math.round(x0); x < Math.round(x1); x++) blend(x, y, color, cover)
    },
    /** A filled polygon (even-odd), its edge not smoothed: an outline drawn over it does that. */
    fill(points: ReadonlyArray<readonly [number, number]>, color: readonly [number, number, number], cover: number) {
      const ys = points.map((point) => point[1])
      for (let y = Math.floor(Math.min(...ys)); y <= Math.ceil(Math.max(...ys)); y++) {
        const crossings: number[] = []
        points.forEach(([ax, ay], at) => {
          const [bx, by] = points[(at + 1) % points.length]!
          if ((ay <= y + 0.5 && by > y + 0.5) || (by <= y + 0.5 && ay > y + 0.5)) crossings.push(ax + ((y + 0.5 - ay) / (by - ay)) * (bx - ax))
        })
        crossings.sort((a, b) => a - b)
        for (let pair = 0; pair + 1 < crossings.length; pair += 2) for (let x = Math.round(crossings[pair]!); x < Math.round(crossings[pair + 1]!); x++) blend(x, y, color, cover)
      }
    },
    /** A line `thick` pixels wide with round ends, its edge smoothed over one pixel. */
    line(ax: number, ay: number, bx: number, by: number, thick: number, color: readonly [number, number, number]) {
      const reach = thick / 2 + 1
      const [dx, dy] = [bx - ax, by - ay]
      const length = dx * dx + dy * dy
      for (let y = Math.floor(Math.min(ay, by) - reach); y <= Math.ceil(Math.max(ay, by) + reach); y++) {
        for (let x = Math.floor(Math.min(ax, bx) - reach); x <= Math.ceil(Math.max(ax, bx) + reach); x++) {
          const along = length ? Math.max(0, Math.min(1, ((x + 0.5 - ax) * dx + (y + 0.5 - ay) * dy) / length)) : 0
          const away = Math.hypot(x + 0.5 - (ax + dx * along), y + 0.5 - (ay + dy * along))
          blend(x, y, color, thick / 2 + 0.5 - away)
        }
      }
    },
  }
}

/** Bars from the zero line in their series' colour, lines over them with a dot on every value, and faint rules at the quarters of the range. */
function drawXy(spec: XySpec, width: number, height: number): PetImage {
  const paint = canvas(width, height)
  const [cell, row] = [width / spec.cols, height / spec.rows]
  const span = Math.max(1e-9, spec.max - spec.min)
  const yOf = (value: number) => ((spec.max - Math.max(spec.min, Math.min(spec.max, value))) / span * (spec.rows - 1) + 0.5) * row
  const xOf = (index: number) => (index * spec.stride + Math.floor(spec.stride / 2) + 0.5) * cell
  const rule = rgb("border")
  for (let quarter = 0; quarter <= 4; quarter++) paint.rect(0, yOf(spec.min + (span * quarter) / 4), width, yOf(spec.min + (span * quarter) / 4) + 1, rule, 0.45)
  const zero = yOf(0)
  paint.rect(0, zero, width, zero + Math.max(1, Math.round(row / 12)), rgb("muted"), 0.9)
  const bars = spec.series.filter((series) => series.kind === "bar")
  // A category's bars share six tenths of its stride, with a pixel between two of them.
  const group = Math.max(bars.length * 2, spec.stride * cell * 0.6)
  const bar = group / Math.max(1, bars.length)
  bars.forEach((series, at) => {
    const color = rgb(series.color)
    series.values.forEach((value, index) => {
      const left = xOf(index) - group / 2 + at * bar
      paint.rect(left + (bars.length > 1 ? 0.5 : 0), yOf(value), left + bar - (bars.length > 1 ? 0.5 : 0), zero, color)
    })
  })
  const thick = Math.max(2, row / 9)
  for (const series of spec.series.filter((entry) => entry.kind === "line")) {
    const color = rgb(series.color)
    series.values.forEach((value, index) => {
      if (index) paint.line(xOf(index - 1), yOf(series.values[index - 1]!), xOf(index), yOf(value), thick, color)
    })
    series.values.forEach((value, index) => paint.line(xOf(index), yOf(value), xOf(index), yOf(value), thick * 2.6, color))
  }
  return { width, height, rgba: paint.rgba }
}

/** The web (four rings and a spoke per axis, faint), then each curve as a tinted area with its outline and a dot on every axis. */
function drawRadar(spec: RadarSpec, width: number, height: number): PetImage {
  const paint = canvas(width, height)
  const [cell, row] = [width / spec.cols, height / spec.rows]
  const [cx, cy] = [(spec.cx + 0.5) * cell, (spec.cy + 0.5) * row]
  // Round, whatever the shape of a cell: the smaller of the two reaches.
  const radius = Math.min(spec.rx * cell, spec.ry * row)
  const at = (axis: number, ratio: number): [number, number] => {
    const angle = -Math.PI / 2 + (axis * Math.PI * 2) / spec.axes
    return [cx + Math.cos(angle) * radius * ratio, cy + Math.sin(angle) * radius * ratio]
  }
  const ring = (ratio: number) => Array.from({ length: spec.axes }, (_, axis) => at(axis, ratio))
  const outline = (points: ReadonlyArray<readonly [number, number]>, thick: number, color: readonly [number, number, number]) => points.forEach(([x, y], index) => {
    const [nx, ny] = points[(index + 1) % points.length]!
    paint.line(x, y, nx, ny, thick, color)
  })
  const web = rgb("border")
  for (const ratio of [0.25, 0.5, 0.75, 1]) outline(ring(ratio), 1, web)
  for (let axis = 0; axis < spec.axes; axis++) paint.line(cx, cy, ...at(axis, 1), 1, web)
  const thick = Math.max(2, row / 9)
  for (const curve of spec.curves) {
    const color = rgb(curve.color)
    const points = Array.from({ length: spec.axes }, (_, axis) => at(axis, Math.max(0, Math.min(1, curve.ratios[axis] ?? 0))))
    paint.fill(points, color, 0.2)
    outline(points, thick, color)
    for (const [x, y] of points) paint.line(x, y, x, y, thick * 2.4, color)
  }
  return { width, height, rgba: paint.rgba }
}
