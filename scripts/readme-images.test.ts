import { describe, expect, test } from "bun:test"
import { COLUMNS, IMAGES_DIR, ROWS, SCENES, renderImages, renderSvg } from "./readme-images"

describe("README images", () => {
  test("every committed screenshot is what the real views draw now (run `bun scripts/readme-images.ts` after a view change)", async () => {
    const images = await renderImages()
    expect(Object.keys(images).sort()).toEqual(SCENES.map((scene) => scene.file).sort())
    for (const [file, svg] of Object.entries(images)) {
      const committed = await Bun.file(`${IMAGES_DIR}${file}`).text()
      expect(committed === svg ? "same" : `${file} drifted`).toBe("same")
    }
  }, 60_000)

  test("each image is a full-screen terminal window, not a small one", async () => {
    const images = await renderImages()
    for (const svg of Object.values(images)) {
      const [, width, height] = /<svg [^>]*width="(\d+)" height="(\d+)"/.exec(svg)!.map(Number) as [number, number, number]
      expect(width).toBe(Math.round(COLUMNS * 8.4 + 32))
      expect(height).toBe(34 + 32 + ROWS * 18)
    }
    expect(COLUMNS).toBeGreaterThanOrEqual(200)
    expect(ROWS).toBeGreaterThanOrEqual(55)
    expect(ROWS).toBeLessThanOrEqual(60)
  }, 60_000)

  test("the window has the title bar with three dots, the title and the product's dark background", () => {
    const svg = renderSvg({ frame: [[{ text: "hi", fg: "primary", bold: true }]], title: "mendcode — /memory", columns: 10, rows: 2 })
    expect(svg.match(/<circle /g)).toHaveLength(3)
    expect(svg).toContain(">mendcode — /memory</text>")
    expect(svg).toContain('aria-label="mendcode — /memory"')
    expect(svg).toContain('fill="#0a0a0a"')
    expect(svg).toContain('font-weight="700"')
  })

  test("text is escaped, backgrounds become rects, wide characters take two cells", () => {
    const svg = renderSvg({ frame: [[{ text: "a<b & \"c\"", fg: "text" }, { text: "xy", bg: "diffAddedBg" }, { text: "漢", fg: "text" }]], title: "t", columns: 20, rows: 1 })
    expect(svg).toContain("a&lt;b &amp; &quot;c&quot;")
    expect(svg).toContain('fill="#12261a"')
    expect(svg).toMatch(/textLength="16\.8"[^>]*>漢</)
  })

  test("the memory image shows the new graph: bordered Graph and Memory panels with braille edges", async () => {
    const svg = (await renderImages(["memory-graph"]))["memory-graph.svg"]!
    expect(svg).toContain("Graph · ego")
    expect(svg).toMatch(/[⠁-⣿]/)
    expect(svg).toContain(">Memory<")
  }, 60_000)

  test("the logos are artwork and the generator leaves them alone", async () => {
    expect(SCENES.some((scene) => scene.file.startsWith("logo"))).toBe(false)
    for (const logo of ["logo-dark.svg", "logo-light.svg"]) expect(await Bun.file(`${IMAGES_DIR}${logo}`).exists()).toBe(true)
  })
})
