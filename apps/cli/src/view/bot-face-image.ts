import type { BotShape } from "../../../../packages/packages/src/agents"
import type { PetImage } from "../pets/decode"
import type { FaceState } from "./bot-face-anim"

/** Experimental bots: the generated picture of a face, drawn pixel by pixel from the same parameters as the text face. No network, no model. */
export type EyeStyle = "round" | "diamond" | "square"
export type MouthStyle = "smile" | "flat" | "small"
export type RasterInput = { shape: BotShape; body: string; eyes: EyeStyle; mouth: MouthStyle; state: FaceState; frame: number; width: number; height: number }

const channels = (hex: string) => [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16)) as [number, number, number]
const luminance = ([r, g, b]: readonly number[]) => (0.2126 * r! + 0.7152 * g! + 0.0722 * b!) / 255

/** Whether a point (x, y in units of the face radius from its center) is inside the body. */
const BODIES: Record<BotShape, (x: number, y: number) => boolean> = {
  circle: (x, y) => x * x + y * y <= 1,
  square: (x, y) => Math.abs(x) <= 0.9 && Math.abs(y) <= 0.9 && (Math.abs(x) <= 0.65 || Math.abs(y) <= 0.65 || (Math.abs(x) - 0.65) ** 2 + (Math.abs(y) - 0.65) ** 2 <= 0.0625),
  diamond: (x, y) => Math.abs(x) + Math.abs(y) <= 1.15,
  triangle: (x, y) => y >= -0.95 && y <= 0.8 && Math.abs(x) <= (y + 0.95) * 0.6,
  hexagon: (x, y) => Math.abs(y) <= 0.87 && Math.abs(x) * 0.866 + Math.abs(y) * 0.5 <= 0.866,
}

/** Where the face sits inside the body (a triangle is narrow at the top, so its face moves down). */
const FACE_SHIFT: Record<BotShape, number> = { circle: 0, square: 0, diamond: 0, triangle: 0.25, hexagon: 0, }
const FACE_SCALE: Record<BotShape, number> = { circle: 1, square: 1, diamond: 0.85, triangle: 0.8, hexagon: 1 }

const EYE_HIT: Record<EyeStyle, (dx: number, dy: number, size: number) => boolean> = {
  round: (dx, dy, size) => dx * dx + dy * dy <= size * size,
  diamond: (dx, dy, size) => Math.abs(dx) + Math.abs(dy) <= size * 1.25,
  square: (dx, dy, size) => Math.abs(dx) <= size * 0.9 && Math.abs(dy) <= size * 0.9,
}

/** Whether a point (in face units, face center at 0,0) is ink: the eyes, the mouth and the state's mark. */
function ink({ eyes, mouth, state, frame }: Pick<RasterInput, "eyes" | "mouth" | "state" | "frame">, x: number, y: number): boolean {
  for (const side of [-1, 1]) {
    const dx = x - side * 0.34
    const dy = y + 0.12
    if (state === "sleeping") {
      if (Math.abs(dx) <= 0.17 && Math.abs(dy) <= 0.035) return true
    } else if (state === "problem") {
      if (Math.abs(dx) <= 0.15 && Math.abs(dy) <= 0.15 && Math.abs(Math.abs(dx) - Math.abs(dy)) <= 0.045) return true
    } else if (EYE_HIT[eyes](dx, dy, state === "listening" ? 0.23 : 0.16)) {
      if (state !== "listening" || !EYE_HIT[eyes](dx + 0.05, dy + 0.05, 0.08)) return true
    }
  }
  const my = y - 0.38
  if (state === "talking") {
    const open = frame % 2 === 0 ? 0.13 : 0.06
    if ((x / 0.13) ** 2 + (my / open) ** 2 <= 1) return true
  } else if (state === "waiting") {
    for (const at of [-0.16, 0, 0.16]) if ((x - at) ** 2 + my * my <= 0.0036) return true
  } else if (state === "problem") {
    const r2 = x * x + (my - 0.12) ** 2
    if (r2 <= 0.0324 && r2 >= 0.0121 && my - 0.12 <= 0.02) return true
  } else if (mouth === "flat" || state === "sleeping") {
    if (Math.abs(x) <= 0.17 && Math.abs(my) <= 0.035) return true
  } else if (mouth === "small") {
    if (x * x + my * my <= 0.0064) return true
  } else {
    const r2 = x * x + (my - 0.1) ** 2
    if (r2 <= 0.0529 && r2 >= 0.0225 && my - 0.1 >= -0.02) return true
  }
  if (state === "thinking") {
    const size = frame % 2 === 0 ? 0.06 : 0.1
    if ((x - 0.5) ** 2 + (y + 0.55) ** 2 <= size * size) return true
  }
  return false
}

/**
 * A face as an RGBA picture: the shape in `body`, the eyes and mouth in black (white when the body is dark). Edges are smoothed by
 * four samples a pixel. The body is opaque, so the picture covers the text face under it.
 */
export function rasterFace(input: RasterInput): PetImage {
  const { width, height, shape, body } = input
  const fill = channels(body)
  const pen: [number, number, number] = luminance(fill) < 0.18 ? [255, 255, 255] : [0, 0, 0]
  const radius = Math.min(width, height) / 2 * 0.94
  const [cx, cy] = [width / 2, height / 2]
  const inBody = BODIES[shape]
  const scale = FACE_SCALE[shape]
  const shift = FACE_SHIFT[shape]
  const rgba = new Uint8Array(width * height * 4)
  const offsets = [0.25, 0.75]
  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      let bodyHits = 0
      let inkHits = 0
      for (const oy of offsets) for (const ox of offsets) {
        const x = (px + ox - cx) / radius
        const y = (py + oy - cy) / radius
        if (!inBody(x, y)) continue
        if (ink(input, x / scale, (y - shift) / scale)) inkHits++
        else bodyHits++
      }
      const hits = bodyHits + inkHits
      if (hits === 0) continue
      const at = (py * width + px) * 4
      for (let c = 0; c < 3; c++) rgba[at + c] = Math.round((fill[c]! * bodyHits + pen[c]! * inkHits) / hits)
      rgba[at + 3] = Math.round((hits / 4) * 255)
    }
  }
  return { width, height, rgba }
}
