import { afterEach, expect, test } from "bun:test"
import { cleanTemps } from "./session-ui-harness"
import { drawImageScene, imageSceneResult, IMAGE_SCENES } from "./image-generation-fixture"
import { textWidth } from "../src/view/wrap"

afterEach(cleanTemps)
test("image results use shared bordered panels, show caption and paths without inline raster placements", async () => {
  for (const scene of IMAGE_SCENES) {
    const result = await imageSceneResult(scene)
    for (const [width, height] of [[60, 20], [100, 30], [160, 45], [180, 50], [220, 60]]) {
      const h = drawImageScene(width!, height!, scene, result)
      const frame = h.frames.at(-1)!, text = h.text().join("\n")
      expect(frame).toHaveLength(height!)
      expect(frame.every((line) => textWidth(line.map((span) => span.text).join("")) <= width!)).toBe(true)
      expect(text).not.toContain("local-fake")
      expect(h.placements.at(-1)).toEqual([])
      if (!result.isError) {
        expect(text).toContain(scene === "edited-caption" ? "Edited image" : "Generated image")
        expect(text).toContain("┌")
        expect(text).toContain("/data/mendcode/generated_images/")
        if (scene === "generated-caption" || scene === "edited-caption") expect(text).toContain("Caption: A green MendCode icon")
        if (scene === "caption-optional-failure") expect(text).toContain("Caption unavailable")
        if (scene === "generated-no-caption") expect(text).not.toContain("Caption:")
      } else expect(text).toContain(scene === "subscription-failure" ? "HTTP 403" : "required caption")
      await h.app.onKey("\x03")
      await h.app.onKey("\x03")
    }
  }
})
