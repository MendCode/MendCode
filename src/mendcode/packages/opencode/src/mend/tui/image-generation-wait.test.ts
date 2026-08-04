import { describe, expect, test } from "bun:test"
import {
  defaultImageGenerationWait,
  imageGenerationCanvasSize,
  imageGenerationWaitFrame,
  imageGenerationWaitFrameCount,
  normalizeImageGenerationWait,
} from "./image-generation-wait"

describe("image generation waiting art", () => {
  test("moves the focal symbol instead of pinning it to the center", () => {
    const config = normalizeImageGenerationWait({ preset: "orbit" })
    const frames = [0, 4, 8].map((frame) => imageGenerationWaitFrame(config, frame, 40, 16))
    const locations = frames.map((lines) => {
      for (let y = 0; y < lines.length; y++) {
        const x = lines[y]!.search(/[@O]/)
        if (x >= 0) return `${x}:${y}`
      }
      return undefined
    })

    expect(new Set(locations).size).toBe(3)
  })

  test("uses the responsive canvas and cycles the built-in animation", () => {
    const config = defaultImageGenerationWait()
    expect(config.preset).toBe("drops")
    expect(imageGenerationCanvasSize(140, config)).toEqual({ width: 52, height: 24 })
    expect(imageGenerationWaitFrameCount(normalizeImageGenerationWait({ preset: "cycle" }))).toBe(80)
    expect(imageGenerationWaitFrame(config, 0, 40, 16)).not.toEqual(imageGenerationWaitFrame(config, 1, 40, 16))
  })

  test("supports custom ASCII frames and centered fitting", () => {
    const config = normalizeImageGenerationWait({
      mode: "animated-loop",
      ascii: {
        frames: [["A"], ["B"]],
        fit: "contain",
        align: "center",
      },
    })

    expect(imageGenerationWaitFrameCount(config)).toBe(2)
    expect(imageGenerationWaitFrame(config, 0, 9, 5)[2]).toBe("    A    ")
    expect(imageGenerationWaitFrame(config, 1, 9, 5)[2]).toBe("    B    ")
  })
})
