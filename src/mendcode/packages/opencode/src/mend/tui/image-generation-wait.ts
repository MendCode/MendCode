export type MendImageGenerationWaitMode = "static" | "animated-loop"
export type MendImageGenerationWaitPreset = "cycle" | "drops" | "constellation" | "orbit" | "pulse" | "scanner"
export type MendImageGenerationWaitTextColor = "mixed" | "accent" | "muted"
export type MendImageGenerationWaitFit = "contain" | "crop"
export type MendImageGenerationWaitAlign = "left" | "center" | "right"

export type MendImageGenerationWaitCanvas = {
  minWidth: number
  maxWidth: number
  minHeight: number
  maxHeight: number
  heightRatio: number
  paddingX: number
  paddingY: number
}

export type MendImageGenerationWaitAscii = {
  static?: string[]
  frames?: string[][]
  fit: MendImageGenerationWaitFit
  align: MendImageGenerationWaitAlign
}

export type MendImageGenerationWaitConfig = {
  mode: MendImageGenerationWaitMode
  preset: MendImageGenerationWaitPreset
  intervalMs: number
  textColor: MendImageGenerationWaitTextColor
  showMetadata: boolean
  canvas: MendImageGenerationWaitCanvas
  ascii: MendImageGenerationWaitAscii
}

const BUILTIN_FRAME_COUNT = 16
const CYCLE_PRESETS: Exclude<MendImageGenerationWaitPreset, "cycle">[] = [
  "drops",
  "constellation",
  "orbit",
  "pulse",
  "scanner",
]

const DEFAULT_WAIT: MendImageGenerationWaitConfig = {
  mode: "animated-loop",
  preset: "drops",
  intervalMs: 280,
  textColor: "mixed",
  showMetadata: true,
  canvas: {
    minWidth: 28,
    maxWidth: 52,
    minHeight: 18,
    maxHeight: 24,
    heightRatio: 1 / 2.2,
    paddingX: 2,
    paddingY: 1,
  },
  ascii: {
    fit: "contain",
    align: "center",
  },
}

const STARS = [
  { x: 0.03, y: 0.08, dx: 1, dy: 1, phase: 0 },
  { x: 0.24, y: 0.02, dx: 2, dy: 1, phase: 2 },
  { x: 0.48, y: 0.16, dx: 1, dy: 2, phase: 4 },
  { x: 0.76, y: 0.08, dx: 2, dy: 1, phase: 1 },
  { x: 0.94, y: 0.25, dx: 1, dy: 2, phase: 3 },
  { x: 0.12, y: 0.48, dx: 2, dy: 1, phase: 4 },
  { x: 0.35, y: 0.7, dx: 1, dy: 2, phase: 1 },
  { x: 0.68, y: 0.58, dx: 2, dy: 1, phase: 0 },
  { x: 0.88, y: 0.78, dx: 1, dy: 2, phase: 2 },
  { x: 0.06, y: 0.96, dx: 1, dy: 1, phase: 3 },
  { x: 0.53, y: 0.86, dx: 2, dy: 1, phase: 1 },
  { x: 0.82, y: 0.96, dx: 1, dy: 2, phase: 4 },
] as const

const MOTION_X = [0, 1, 2, 3, 2, 1, 0, -1, -2, -3, -2, -1, 0, 1, 2, 1] as const
const MOTION_Y = [-2, -2, -1, 0, 1, 2, 2, 1, 0, -1, -2, -2, -1, 0, 1, 0] as const
const DROP_SEEDS = [
  { x: 0.04, y: 0.86, speed: 1, phase: 0 },
  { x: 0.11, y: 0.18, speed: 2, phase: 3 },
  { x: 0.19, y: 0.63, speed: 1, phase: 5 },
  { x: 0.27, y: 0.04, speed: 2, phase: 1 },
  { x: 0.34, y: 0.44, speed: 1, phase: 4 },
  { x: 0.41, y: 0.76, speed: 2, phase: 2 },
  { x: 0.49, y: 0.27, speed: 1, phase: 6 },
  { x: 0.56, y: 0.92, speed: 2, phase: 0 },
  { x: 0.64, y: 0.12, speed: 1, phase: 4 },
  { x: 0.71, y: 0.57, speed: 2, phase: 5 },
  { x: 0.78, y: 0.32, speed: 1, phase: 2 },
  { x: 0.86, y: 0.72, speed: 2, phase: 1 },
  { x: 0.93, y: 0.08, speed: 1, phase: 3 },
] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function integer(value: unknown, fallback: number, min: number, max: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback
  return clamp(Math.round(value), min, max)
}

function decimal(value: unknown, fallback: number, min: number, max: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback
  return clamp(value, min, max)
}

function normalizeLineList(value: unknown) {
  if (typeof value === "string")
    return value
      .split("\n")
      .slice(0, 96)
      .map((line) => line.slice(0, 512))
  if (!Array.isArray(value)) return undefined
  return value
    .filter((line): line is string => typeof line === "string")
    .slice(0, 96)
    .flatMap((line) => line.split("\n"))
    .map((line) => line.slice(0, 512))
}

function normalizeFrameList(value: unknown) {
  if (!Array.isArray(value)) return undefined
  return value
    .slice(0, 64)
    .map((frame) => normalizeLineList(frame))
    .filter((frame): frame is string[] => Array.isArray(frame))
}

export function defaultImageGenerationWait(): MendImageGenerationWaitConfig {
  return {
    ...DEFAULT_WAIT,
    canvas: { ...DEFAULT_WAIT.canvas },
    ascii: {
      ...DEFAULT_WAIT.ascii,
      ...(DEFAULT_WAIT.ascii.static ? { static: [...DEFAULT_WAIT.ascii.static] } : {}),
      ...(DEFAULT_WAIT.ascii.frames ? { frames: DEFAULT_WAIT.ascii.frames.map((frame) => [...frame]) } : {}),
    },
  }
}

export function normalizeImageGenerationWait(
  input: unknown,
  fallback: MendImageGenerationWaitConfig = defaultImageGenerationWait(),
): MendImageGenerationWaitConfig {
  const source = isRecord(input) ? input : {}
  const canvasSource = isRecord(source.canvas) ? source.canvas : {}
  const asciiSource = isRecord(source.ascii) ? source.ascii : {}
  const staticAscii = normalizeLineList(asciiSource.static)
  const animatedAscii = normalizeFrameList(asciiSource.frames)
  const minWidth = integer(canvasSource.minWidth, fallback.canvas.minWidth, 12, 240)
  const maxWidth = integer(canvasSource.maxWidth, fallback.canvas.maxWidth, minWidth, 240)
  const minHeight = integer(canvasSource.minHeight, fallback.canvas.minHeight, 6, 120)
  const maxHeight = integer(canvasSource.maxHeight, fallback.canvas.maxHeight, minHeight, 120)

  return {
    mode: source.mode === "static" || source.mode === "animated-loop" ? source.mode : fallback.mode,
    preset:
      source.preset === "cycle" ||
      source.preset === "drops" ||
      source.preset === "constellation" ||
      source.preset === "orbit" ||
      source.preset === "pulse" ||
      source.preset === "scanner"
        ? source.preset
        : fallback.preset,
    intervalMs: integer(source.intervalMs, fallback.intervalMs, 80, 5000),
    textColor:
      source.textColor === "mixed" || source.textColor === "accent" || source.textColor === "muted"
        ? source.textColor
        : fallback.textColor,
    showMetadata: typeof source.showMetadata === "boolean" ? source.showMetadata : fallback.showMetadata,
    canvas: {
      minWidth,
      maxWidth,
      minHeight,
      maxHeight,
      heightRatio: decimal(canvasSource.heightRatio, fallback.canvas.heightRatio, 0.1, 2),
      paddingX: integer(canvasSource.paddingX, fallback.canvas.paddingX, 0, 12),
      paddingY: integer(canvasSource.paddingY, fallback.canvas.paddingY, 0, 8),
    },
    ascii: {
      fit: asciiSource.fit === "crop" || asciiSource.fit === "contain" ? asciiSource.fit : fallback.ascii.fit,
      align:
        asciiSource.align === "left" || asciiSource.align === "center" || asciiSource.align === "right"
          ? asciiSource.align
          : fallback.ascii.align,
      ...(staticAscii ? { static: staticAscii } : fallback.ascii.static ? { static: fallback.ascii.static } : {}),
      ...(animatedAscii ? { frames: animatedAscii } : fallback.ascii.frames ? { frames: fallback.ascii.frames } : {}),
    },
  }
}

export function validateImageGenerationWait(config: MendImageGenerationWaitConfig) {
  const failures: string[] = []
  if (config.mode !== "static" && config.mode !== "animated-loop") failures.push("imageGeneration.wait.mode is invalid")
  if (!Number.isInteger(config.intervalMs) || config.intervalMs < 80) {
    failures.push("imageGeneration.wait.intervalMs must be at least 80")
  }
  if (config.canvas.minWidth > config.canvas.maxWidth)
    failures.push("imageGeneration.wait.canvas width range is invalid")
  if (config.canvas.minHeight > config.canvas.maxHeight)
    failures.push("imageGeneration.wait.canvas height range is invalid")
  if (config.canvas.heightRatio <= 0) failures.push("imageGeneration.wait.canvas.heightRatio must be positive")
  return failures
}

export function imageGenerationCanvasSize(availableWidth: number, config: MendImageGenerationWaitConfig) {
  const available = Math.max(12, Math.floor(availableWidth) - 10)
  const width = clamp(available, config.canvas.minWidth, config.canvas.maxWidth)
  const height = clamp(Math.round(width * config.canvas.heightRatio), config.canvas.minHeight, config.canvas.maxHeight)
  return { width, height }
}

export function imageGenerationWaitFrameCount(config: MendImageGenerationWaitConfig) {
  if (config.mode === "static") return 1
  if (config.ascii.frames?.length) return config.ascii.frames.length
  if (config.ascii.static?.length) return 1
  return config.preset === "cycle" ? BUILTIN_FRAME_COUNT * CYCLE_PRESETS.length : BUILTIN_FRAME_COUNT
}

function modulo(value: number, size: number) {
  return ((value % size) + size) % size
}

function put(rows: string[][], x: number, y: number, value: string) {
  if (y < 0 || y >= rows.length || x < 0 || x >= (rows[0]?.length ?? 0)) return
  rows[y]![x] = value
}

function movingAnchor(frame: number, width: number, height: number) {
  const scaleX = Math.max(1, Math.round(width / 24))
  const scaleY = Math.max(1, Math.round(height / 12))
  return {
    x: clamp(Math.floor(width / 2) + MOTION_X[frame % MOTION_X.length] * scaleX, 1, width - 2),
    y: clamp(Math.floor(height / 2) + MOTION_Y[frame % MOTION_Y.length] * scaleY, 1, height - 2),
  }
}

function starfield(frame: number, width: number, height: number) {
  const rows = Array.from({ length: height }, () => Array(width).fill(" "))
  for (const star of STARS) {
    const x = modulo(Math.floor(star.x * width) + frame * star.dx, width)
    const y = modulo(Math.floor(star.y * height) + frame * star.dy, height)
    put(rows, x, y, (frame + star.phase) % 5 === 0 ? "*" : ".")
  }
  return rows
}

function dropsFrame(frame: number, width: number, height: number) {
  const rows = Array.from({ length: height }, () => Array(width).fill(" "))
  for (const drop of DROP_SEEDS) {
    const x = Math.floor(drop.x * width)
    const y = modulo(Math.floor(drop.y * height) + frame * drop.speed, height)
    const glyph = (frame + drop.phase) % 7 === 0 ? "*" : "."
    put(rows, x, y, glyph)
    if ((frame + drop.phase) % 3 !== 0) put(rows, x, y - 1, ".")
  }
  return rows.map((row) => row.join(""))
}

function builtInFrame(
  preset: Exclude<MendImageGenerationWaitPreset, "cycle">,
  frame: number,
  width: number,
  height: number,
) {
  if (preset === "drops") return dropsFrame(frame, width, height)

  const rows = starfield(frame, width, height)
  const anchor = movingAnchor(frame, width, height)
  const pulse = frame % 6

  if (preset === "constellation") {
    put(rows, anchor.x, anchor.y, frame % 2 === 0 ? "*" : "o")
    put(rows, anchor.x - 2, anchor.y - 1, ".")
    put(rows, anchor.x + 2, anchor.y + 1, ".")
    put(rows, anchor.x + MOTION_X[frame % MOTION_X.length], anchor.y + MOTION_Y[frame % MOTION_Y.length], "+")
  }

  if (preset === "orbit") {
    put(rows, anchor.x, anchor.y, frame % 3 === 0 ? "@" : "O")
    const orbit = [
      [0, -3],
      [2, -2],
      [3, 0],
      [2, 2],
      [0, 3],
      [-2, 2],
      [-3, 0],
      [-2, -2],
    ][frame % 8]!
    put(rows, anchor.x + orbit[0]!, anchor.y + orbit[1]!, "o")
  }

  if (preset === "pulse") {
    put(rows, anchor.x, anchor.y, pulse % 2 === 0 ? "+" : "*")
    const radius = 1 + pulse
    for (const [x, y] of [
      [anchor.x - radius, anchor.y],
      [anchor.x + radius, anchor.y],
      [anchor.x, anchor.y - Math.floor(radius / 2)],
      [anchor.x, anchor.y + Math.floor(radius / 2)],
    ]) {
      put(rows, x, y, pulse % 2 === 0 ? "." : "o")
    }
  }

  if (preset === "scanner") {
    const scanX = modulo(frame * Math.max(1, Math.floor(width / 12)), width)
    for (let y = 0; y < height; y += 2) put(rows, scanX, y, y === anchor.y ? "#" : "|")
    put(rows, anchor.x - 1, anchor.y, "<")
    put(rows, anchor.x + 1, anchor.y, ">")
  }

  return rows.map((row) => row.join(""))
}

function fitAsciiFrame(
  lines: string[],
  width: number,
  height: number,
  fit: MendImageGenerationWaitFit,
  align: MendImageGenerationWaitAlign,
) {
  const rows = Array.from({ length: height }, () => Array(width).fill(" "))
  const sourceStart = fit === "crop" && lines.length > height ? Math.floor((lines.length - height) / 2) : 0
  const visible = lines.slice(sourceStart, sourceStart + height)
  const top = Math.floor((height - visible.length) / 2)
  for (let index = 0; index < visible.length; index++) {
    const source = visible[index]!
    const line =
      source.length <= width
        ? source
        : source.slice(Math.floor((source.length - width) / 2), Math.floor((source.length - width) / 2) + width)
    const left = align === "left" ? 0 : align === "right" ? width - line.length : Math.floor((width - line.length) / 2)
    const y = top + index
    if (y < 0 || y >= height) continue
    for (let column = 0; column < line.length; column++) put(rows, left + column, y, line[column] ?? "")
  }
  return rows.map((row) => row.join(""))
}

export function imageGenerationWaitFrame(
  config: MendImageGenerationWaitConfig,
  frame: number,
  width: number,
  height: number,
) {
  const custom =
    config.mode === "static"
      ? config.ascii.static || config.ascii.frames?.[0]
      : config.ascii.frames?.length
        ? config.ascii.frames[frame % config.ascii.frames.length]
        : undefined
  if (custom?.length) return fitAsciiFrame(custom, width, height, config.ascii.fit, config.ascii.align)

  const preset =
    config.preset === "cycle"
      ? CYCLE_PRESETS[Math.floor(frame / BUILTIN_FRAME_COUNT) % CYCLE_PRESETS.length]!
      : config.preset
  return builtInFrame(preset, frame % BUILTIN_FRAME_COUNT, width, height)
}
